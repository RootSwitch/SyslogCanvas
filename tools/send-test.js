'use strict';
// Fire test traffic at a running SyslogCanvas so you can watch rows land
// without waiting for a real device to hiccup.
//
//   node tools/send-test.js                     # a few syslog lines + traps to localhost
//   node tools/send-test.js --host 192.168.1.50 # aim elsewhere
//   node tools/send-test.js --flood 20000       # burst-load the syslog path
//
// Ports default to the unprivileged in-container pair (5514/5162) because
// that's what a dev checkout listens on; against a docker host use
// --syslog-port 514 --trap-port 162.

const dgram = require('node:dgram');
const snmp = require('net-snmp');

const args = process.argv.slice(2);
function opt(name, dflt) {
    const i = args.indexOf('--' + name);
    return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}
const HOST = opt('host', '127.0.0.1');
const SYSLOG_PORT = parseInt(opt('syslog-port', '5514'), 10);
const TRAP_PORT = parseInt(opt('trap-port', '5162'), 10);
const FLOOD = parseInt(opt('flood', '0'), 10);

const sock = dgram.createSocket('udp4');
function sendSyslog(line) {
    return new Promise((resolve, reject) => {
        const buf = Buffer.from(line, 'utf8');
        sock.send(buf, 0, buf.length, SYSLOG_PORT, HOST, (err) => err ? reject(err) : resolve());
    });
}

function stamp3164() {
    const d = new Date();
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    const day = String(d.getDate()).padStart(2, ' ');
    const t = d.toTimeString().slice(0, 8);
    return `${mon} ${day} ${t}`;
}

async function main() {
    if (FLOOD > 0) {
        console.log(`flooding ${FLOOD} syslog datagrams at ${HOST}:${SYSLOG_PORT}...`);
        for (let i = 0; i < FLOOD; i++) {
            await sendSyslog(`<134>${stamp3164()} floodhost stress[${process.pid}]: flood message ${i} of ${FLOOD}`);
        }
        console.log('flood sent');
        sock.close();
        return;
    }

    // --- syslog: RFC 3164, RFC 5424, severities, and a garbage line ---
    const lines = [
        `<134>${stamp3164()} edge-router ifmgr[201]: GigabitEthernet0/1 changed state to up`,          // local0.info
        `<131>${stamp3164()} edge-router ifmgr[201]: GigabitEthernet0/1 changed state to down`,        // local0.err
        `<34>${stamp3164()} nas smartd[911]: device /dev/sda 4 currently unreadable sectors`,          // auth.crit
        `<12>${stamp3164()} firewall kernel: dropped packet from 203.0.113.9`,                          // user.warning
        `<165>1 ${new Date().toISOString()} nas.lan backupd 4471 ID47 [origin ip="10.0.0.7"] nightly backup finished in 214s`, // RFC 5424, local4.notice
        `<13>1 ${new Date().toISOString()} sw1.lan - - - - eth7 link flap detected`,                    // RFC 5424 with nil fields
        'plain text with no pri or timestamp at all'                                                    // garbage - must still be stored
    ];
    for (const l of lines) await sendSyslog(l);
    console.log(`sent ${lines.length} syslog datagrams to ${HOST}:${SYSLOG_PORT}`);
    sock.close();

    // --- SNMP traps: one v2c, one v1 ---
    const v2 = snmp.createSession(HOST, 'public', { port: 161, trapPort: TRAP_PORT, version: snmp.Version2c });
    await new Promise((resolve) => {
        v2.trap('1.3.6.1.6.3.1.1.5.3', [ // linkDown
            { oid: '1.3.6.1.2.1.2.2.1.1.7', type: snmp.ObjectType.Integer, value: 7 },
            { oid: '1.3.6.1.2.1.2.2.1.2.7', type: snmp.ObjectType.OctetString, value: 'eth7' }
        ], (err) => { if (err) console.error('v2c trap failed:', err.message); else console.log('sent v2c linkDown trap'); resolve(); });
    });
    v2.close();

    const v1 = snmp.createSession(HOST, 'public', { port: 161, trapPort: TRAP_PORT, version: snmp.Version1 });
    await new Promise((resolve) => {
        v1.trap(snmp.TrapType.LinkUp, (err) => {
            if (err) console.error('v1 trap failed:', err.message); else console.log('sent v1 linkUp trap');
            resolve();
        });
    });
    v1.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
