'use strict';
// Seed a synthetic-but-believable homelab into the database - demo data for
// screenshots, theme work, and UI iteration without pointing real devices at
// a dev checkout. Entirely fictional: RFC 5737 documentation IPs upstream,
// generic hostnames, and a scripted UPS power-event storyline about an hour
// ago (filter `sev:<=4` to read it).
//
//   node tools/seed-demo.js                # ~120k rows over ~90 days
//   node tools/seed-demo.js --rows 5000    # lighter
//
// Writes directly into the configured data directory (SYSLOGCANVAS_DATA, or
// ./data) - run it before first start, or alongside a running server (WAL
// handles it; rows appear on the next refresh). Seeding is additive; delete
// the data directory first for a clean slate.

const { db } = require('../server/db');

const argv = process.argv.slice(2);
const rowsIdx = argv.indexOf('--rows');
const NOISE_ROWS = rowsIdx !== -1 ? Math.max(0, parseInt(argv[rowsIdx + 1], 10) || 0) : 120000;

const now = Math.floor(Date.now() / 1000);
const ins = db.prepare(`INSERT INTO messages (ts, msg_ts, source_ip, proto, facility, severity, host, app, msg, raw)
    VALUES (@ts, @msg_ts, @source_ip, @proto, @facility, @severity, @host, @app, @msg, @raw)`);

function syslogRow(tsOff, ip, host, app, fac, sev, msg) {
    return { ts: now - tsOff, msg_ts: null, source_ip: ip, proto: 'syslog', facility: fac, severity: sev, host, app, msg, raw: `<${fac * 8 + sev}>${msg}` };
}
function fmtUptime(cs) {
    const s = Math.floor(cs / 100);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d > 0 ? `${d}d${h}h${m}m` : h > 0 ? `${h}h${m}m` : `${m}m${s % 60}s`;
}
function trapRow(tsOff, ip, trapOid, uptimeCs, varbinds) {
    const parts = ['community=public', `uptime=${fmtUptime(uptimeCs)}`];
    for (const vb of varbinds) parts.push(`${vb.oid} = ${vb.value}`);
    return {
        ts: now - tsOff, msg_ts: null, source_ip: ip, proto: 'trap', facility: null, severity: null,
        host: null, app: trapOid, msg: parts.join(' | '),
        raw: JSON.stringify({ version: '2c', community: 'public', trapOid, uptimeCs, agentAddr: null, varbinds })
    };
}

const IF = (idx, name) => [
    { oid: `1.3.6.1.2.1.2.2.1.1.${idx}`, type: 'Integer', value: String(idx) },
    { oid: `1.3.6.1.2.1.2.2.1.2.${idx}`, type: 'OctetString', value: name },
    { oid: `1.3.6.1.2.1.2.2.1.8.${idx}`, type: 'Integer', value: '2' }
];

// --- the fictional fleet ---
const FW = ['192.168.1.1', 'edge-fw'];
const SW = ['192.168.1.2', 'core-sw1'];
const AP = ['192.168.1.5', 'ap-attic'];
const NAS = ['192.168.1.10', 'nas'];
const PVE = ['192.168.1.20', 'pve1'];
const PRN = ['192.168.1.31', null]; // printer only ever sends traps

// --- background noise: weighted per-source mix across ~90 days ---
const NOISE = [
    // weight, ip, host, app, fac, sev, messages[]
    [30, ...FW, 'filterlog', 16, 6, [
        'block,in,igb0,tcp,203.0.113.24:52140,192.168.1.1:443',
        'block,in,igb0,udp,198.51.100.9:5060,192.168.1.1:5060',
        'pass,out,igb1,tcp,192.168.1.20:44312,151.101.1.140:443',
        'block,in,igb0,tcp,192.0.2.77:41002,192.168.1.1:22'
    ]],
    [8, ...FW, 'dhcpd', 3, 6, [
        'DHCPACK on 192.168.1.117 to 9c:b6:d0:e2:44:5a (laptop-guest) via igb1',
        'DHCPREQUEST for 192.168.1.83 from b0:be:76:11:0a:2c via igb1',
        'DHCPACK on 192.168.1.83 to b0:be:76:11:0a:2c (iot-plug-3) via igb1'
    ]],
    [4, ...FW, 'unbound', 3, 6, [
        'info: generate keytag query _ta-4f66. NULL IN',
        'info: service stopped (unbound 1.19.3)',
        'info: start of service (unbound 1.19.3)'
    ]],
    [3, ...FW, 'sshd[2081]', 4, 6, [
        'Accepted publickey for admin from 192.168.1.50 port 51022 ssh2',
        'Connection closed by 192.168.1.50 port 51022'
    ]],
    // a believable background of warnings/errors so sev:<=4 has history
    [3, ...FW, 'sshd[2081]', 4, 4, [
        'Failed password for invalid user admin from 203.0.113.88 port 40122 ssh2',
        'Failed password for invalid user test from 198.51.100.71 port 55010 ssh2'
    ]],
    [3, ...FW, 'openvpn[884]', 3, 4, [
        'TLS: soft reset, re-negotiating with peer 198.51.100.40:1194',
        'AEAD Decrypt error: bad packet ID (may be a replay): [ #43112 ]'
    ]],
    [1, ...SW, 'link', 16, 3, [
        'ge-0/0/7: excessive link flaps detected, port throttled',
        'ge-0/0/4: link state changed to down'
    ]],
    [6, ...SW, 'link', 16, 5, [
        'ge-0/0/7: link state changed to up',
        'ge-0/0/7: link state changed to down',
        'ge-0/0/4: link state changed to up'
    ]],
    [2, ...SW, 'stp', 16, 6, [
        'VLAN 10: topology change detected on port ge-0/0/2',
        'root bridge unchanged after topology change'
    ]],
    [10, ...AP, 'hostapd', 1, 6, [
        'wlan0: STA 3a:7f:12:9d:20:1b IEEE 802.11: associated (aid 4)',
        'wlan0: STA 3a:7f:12:9d:20:1b IEEE 802.11: disassociated',
        'wlan1: STA 62:a8:0f:31:7c:d9 WPA: pairwise key handshake completed (RSN)'
    ]],
    [7, ...NAS, 'smbd[3312]', 1, 6, [
        'connect to service media initially as user svc-media (uid=1002)',
        'closed connection to service media'
    ]],
    [3, ...NAS, 'smartd[911]', 4, 6, [
        'Device: /dev/sda [SAT], SMART Usage Attribute: 194 Temperature_Celsius changed from 112 to 111',
        'Device: /dev/sdb [SAT], SMART Usage Attribute: 194 Temperature_Celsius changed from 109 to 110'
    ]],
    [5, ...PVE, 'pvedaemon[1808]', 3, 6, [
        '<root@pam> successful auth for user root@pam',
        'worker exit',
        'starting task UPID:pve1:vzdump:100'
    ]],
    [4, ...PVE, 'kernel', 0, 6, [
        'vmbr0: port 3(tap104i0) entered forwarding state',
        'perf: interrupt took too long (2508 > 2500), lowering kernel.perf_event_max_sample_rate'
    ]],
    [2, ...PVE, 'qm[28841]', 3, 5, [
        'VM 104 started with PID 28901'
    ]],
    [2, ...PVE, 'qm[28841]', 3, 4, [
        'VM 104 qmp command "guest-ping" failed - got timeout'
    ]]
];
const weightTotal = NOISE.reduce((a, n) => a + n[0], 0);
function pickNoise() {
    let r = Math.random() * weightTotal;
    for (const n of NOISE) { r -= n[0]; if (r <= 0) return n; }
    return NOISE[0];
}

const SPAN = 89 * 86400; // background lives 90d..2h ago; the last 2h are curated
db.transaction(() => {
    for (let i = 0; i < NOISE_ROWS; i++) {
        const n = pickNoise();
        const msgs = n[6];
        // Oldest first so ids ascend with time like a real ingest.
        const tsOff = Math.floor(SPAN - (i / NOISE_ROWS) * (SPAN - 7200) + Math.random() * 60);
        ins.run(syslogRow(tsOff, n[1], n[2], n[3], n[4], n[5], msgs[Math.floor(Math.random() * msgs.length)]));
    }
    // A scattering of routine traps in the background.
    for (let d = 88; d > 0; d -= Math.ceil(Math.random() * 7)) {
        ins.run(trapRow(d * 86400 + 3600, SW[0], '1.3.6.1.6.3.1.1.5.3', d * 8640000 + 991000, IF(7, 'ge-0/0/7')));
        ins.run(trapRow(d * 86400 + 3540, SW[0], '1.3.6.1.6.3.1.1.5.4', d * 8640000 + 997000, IF(7, 'ge-0/0/7')));
    }
})();

// --- the power event, ~70 to ~55 minutes ago (filter `sev:<=4` to read it) ---
const EVENT = [
    syslogRow(70 * 60, ...NAS, 'upsmon[1121]', 3, 4, 'UPS ups@localhost on battery'),
    syslogRow(70 * 60 - 2, ...NAS, 'upssched', 3, 5, 'timer start: onbatt-shutdown in 300 seconds'),
    syslogRow(69 * 60, ...PVE, 'upsmon[1802]', 3, 4, 'UPS ups@192.168.1.10 on battery'),
    syslogRow(68 * 60, ...SW, 'link', 16, 3, 'ge-0/0/1: link state changed to down'),
    trapRow(68 * 60 - 5, SW[0], '1.3.6.1.6.3.1.1.5.3', 761204100, IF(1, 'ge-0/0/1')),
    syslogRow(67 * 60, ...NAS, 'upsmon[1121]', 3, 2, 'UPS ups@localhost battery is low'),
    syslogRow(66 * 60, ...PVE, 'upsmon[1802]', 3, 1, 'Executing automatic power-fail shutdown'),
    syslogRow(66 * 60 - 10, ...PVE, 'pvedaemon[1808]', 3, 5, 'shutting down VM 104 (clean shutdown requested)'),
    syslogRow(62 * 60, ...NAS, 'upsmon[1121]', 3, 4, 'UPS ups@localhost on line power'),
    syslogRow(62 * 60 - 3, ...NAS, 'upssched', 3, 5, 'timer cancel: onbatt-shutdown'),
    syslogRow(61 * 60, ...PVE, 'upsmon[1802]', 3, 4, 'UPS ups@192.168.1.10 on line power'),
    syslogRow(58 * 60, ...SW, 'link', 16, 5, 'ge-0/0/1: link state changed to up'),
    trapRow(58 * 60 - 5, SW[0], '1.3.6.1.6.3.1.1.5.4', 761264100, IF(1, 'ge-0/0/1')),
    trapRow(57 * 60, PRN[0], '1.3.6.1.6.3.1.1.5.1', 1200, [
        { oid: '1.3.6.1.2.1.1.1.0', type: 'OctetString', value: 'Brother HL-L2370DW series' }
    ]),
    syslogRow(55 * 60, ...PVE, 'qm[30112]', 3, 6, 'VM 104 started with PID 30188')
];

// --- curated latest window: a varied, badge-rich first page ---
const RECENT = [
    syslogRow(54 * 60, ...NAS, 'zed', 3, 5, 'ZFS event: sysevent.fs.zfs.scrub_start pool=tank'),
    syslogRow(51 * 60, ...FW, 'filterlog', 16, 6, 'block,in,igb0,tcp,203.0.113.24:52644,192.168.1.1:443'),
    syslogRow(47 * 60, ...AP, 'hostapd', 1, 6, 'wlan0: STA 3a:7f:12:9d:20:1b IEEE 802.11: associated (aid 4)'),
    syslogRow(44 * 60, ...NAS, 'smartd[911]', 4, 2, 'Device: /dev/sdc [SAT], 8 Currently unreadable (pending) sectors'),
    syslogRow(41 * 60, ...FW, 'dhcpd', 3, 6, 'DHCPACK on 192.168.1.117 to 9c:b6:d0:e2:44:5a (laptop-guest) via igb1'),
    syslogRow(38 * 60, ...PVE, 'pvedaemon[1808]', 3, 6, '<root@pam> successful auth for user root@pam'),
    syslogRow(33 * 60, ...SW, 'stp', 16, 6, 'VLAN 10: topology change detected on port ge-0/0/2'),
    syslogRow(29 * 60, ...FW, 'sshd[2081]', 4, 6, 'Accepted publickey for admin from 192.168.1.50 port 51022 ssh2'),
    syslogRow(26 * 60, ...NAS, 'smbd[3312]', 1, 6, 'connect to service media initially as user svc-media (uid=1002)'),
    syslogRow(22 * 60, ...FW, 'openvpn[884]', 3, 4, 'TLS: soft reset, re-negotiating with peer 198.51.100.40:1194'),
    syslogRow(19 * 60, ...AP, 'hostapd', 1, 5, 'wlan1: STA 62:a8:0f:31:7c:d9 WPA: pairwise key handshake completed (RSN)'),
    syslogRow(11 * 60, ...PVE, 'kernel', 0, 6, 'vmbr0: port 3(tap104i0) entered forwarding state'),
    syslogRow(9 * 60, ...FW, 'filterlog', 16, 6, 'block,in,igb0,udp,198.51.100.9:5060,192.168.1.1:5060'),
    syslogRow(7 * 60, ...NAS, 'zed', 3, 5, 'ZFS event: sysevent.fs.zfs.scrub_finish pool=tank errors=0'),
    syslogRow(5 * 60, ...FW, 'unbound', 3, 6, 'info: generate keytag query _ta-4f66. NULL IN'),
    trapRow(250, SW[0], '1.3.6.1.6.3.1.1.5.3', 761516400, IF(9, 'ge-0/0/9')),
    syslogRow(245, ...SW, 'link', 16, 3, 'ge-0/0/9: link state changed to down'),
    trapRow(180, SW[0], '1.3.6.1.6.3.1.1.5.4', 761528400, IF(9, 'ge-0/0/9')),
    syslogRow(175, ...SW, 'link', 16, 5, 'ge-0/0/9: link state changed to up'),
    syslogRow(3 * 60, ...AP, 'hostapd', 1, 6, 'wlan0: STA 3a:7f:12:9d:20:1b IEEE 802.11: disassociated'),
    syslogRow(2 * 60, ...FW, 'dhcpd', 3, 6, 'DHCPREQUEST for 192.168.1.83 from b0:be:76:11:0a:2c via igb1'),
    syslogRow(95, ...PVE, 'pvedaemon[1808]', 3, 6, 'starting task UPID:pve1:vzdump:100'),
    syslogRow(40, ...FW, 'filterlog', 16, 6, 'pass,out,igb1,tcp,192.168.1.20:44312,151.101.1.140:443'),
    syslogRow(12, ...NAS, 'smbd[3312]', 1, 6, 'closed connection to service media')
];

db.transaction(() => {
    for (const r of EVENT) ins.run(r);
    for (const r of RECENT) ins.run(r);
})();

const agg = db.prepare('SELECT count(*) n, min(ts) o, max(ts) x FROM messages').get();
console.log(`seeded: table now holds ${agg.n} rows spanning ${((agg.x - agg.o) / 86400).toFixed(1)} days`);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
