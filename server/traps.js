'use strict';
// SNMP trap receiver (v1 + v2c, plus informs which net-snmp acks
// automatically). net-snmp's Receiver hands us { pdu, rinfo }; we render the
// varbinds into a readable one-line msg (so plain-text filtering works) and
// keep the structured form as JSON in `raw`.

const snmp = require('net-snmp');
const store = require('./store');

// Default 5162: the container runs unprivileged (USER node), so the host maps
// 162/udp here (see docker-compose.yml). Change with TRAP_PORT.
const PORT = parseInt(process.env.TRAP_PORT || '5162', 10);

const SNMP_TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0'; // snmpTrapOID.0
const SYS_UPTIME_OID = '1.3.6.1.2.1.1.3.0';    // sysUpTime.0
// RFC 3418 standard traps, indexed by the v1 generic-trap number.
const GENERIC_TRAPS = [
    '1.3.6.1.6.3.1.1.5.1',  // coldStart
    '1.3.6.1.6.3.1.1.5.2',  // warmStart
    '1.3.6.1.6.3.1.1.5.3',  // linkDown
    '1.3.6.1.6.3.1.1.5.4',  // linkUp
    '1.3.6.1.6.3.1.1.5.5',  // authenticationFailure
    '1.3.6.1.6.3.1.1.5.6'   // egpNeighborLoss
];

function log(...args) { console.log(new Date().toISOString(), '[traps]', ...args); }

function bufferIsPrintable(buf) {
    for (const b of buf) {
        if ((b < 0x20 && b !== 0x09) || b === 0x7f) return false;
    }
    return true;
}

// A varbind value -> display string. OctetStrings arrive as Buffers (utf8
// when printable, hex otherwise); Counter64 is an 8-byte Buffer.
function renderValue(vb) {
    const v = vb.value;
    if (v === null || v === undefined) return '';
    if (Buffer.isBuffer(v)) {
        if (vb.type === snmp.ObjectType.Counter64) return BigInt('0x' + (v.toString('hex') || '0')).toString();
        return bufferIsPrintable(v) ? v.toString('utf8') : '0x' + v.toString('hex');
    }
    return String(v);
}

function fmtUptime(centis) {
    if (centis === null || centis === undefined) return null;
    const s = Math.floor(Number(centis) / 100);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d > 0 ? `${d}d${h}h${m}m` : h > 0 ? `${h}h${m}m` : `${m}m${s % 60}s`;
}

function handleNotification(notification) {
    const pdu = notification.pdu || {};
    const sourceIp = (notification.rinfo && notification.rinfo.address) || 'unknown';
    const community = pdu.community !== undefined ? String(pdu.community) : null;

    let version, trapOid = null, uptimeCs = null, agentAddr = null;
    let varbinds = Array.isArray(pdu.varbinds) ? pdu.varbinds : [];

    if (pdu.type === snmp.PduType.Trap) {
        // v1: the trap identity lives in the PDU header, not a varbind.
        version = '1';
        agentAddr = pdu.agentAddr || null;
        uptimeCs = pdu.upTime ?? null;
        const enterprise = String(pdu.enterprise || '');
        trapOid = pdu.generic >= 0 && pdu.generic <= 5
            ? GENERIC_TRAPS[pdu.generic]
            : `${enterprise}.0.${pdu.specific}`;
    } else {
        // v2c trap or inform: first two varbinds are sysUpTime.0 and
        // snmpTrapOID.0 by convention - read them wherever they actually are.
        version = pdu.type === snmp.PduType.InformRequest ? '2c-inform' : '2c';
        const rest = [];
        for (const vb of varbinds) {
            if (vb.oid === SNMP_TRAP_OID) trapOid = String(vb.value);
            else if (vb.oid === SYS_UPTIME_OID) uptimeCs = vb.value;
            else rest.push(vb);
        }
        varbinds = rest;
    }

    const parts = [];
    if (community !== null) parts.push(`community=${community}`);
    const up = fmtUptime(uptimeCs);
    if (up !== null) parts.push(`uptime=${up}`);
    for (const vb of varbinds) parts.push(`${vb.oid} = ${renderValue(vb)}`);

    store.enqueue({
        ts: Math.floor(Date.now() / 1000),
        msg_ts: null,
        source_ip: sourceIp,
        proto: 'trap',
        facility: null,
        severity: null,
        host: agentAddr,           // v1 carries the originating agent address
        app: trapOid,              // the trap OID is the closest thing to an app name
        msg: parts.join(' | ') || `(v${version} trap, no varbinds)`,
        raw: JSON.stringify({
            version, community, trapOid,
            uptimeCs: uptimeCs === null || uptimeCs === undefined ? null : Number(uptimeCs),
            agentAddr,
            generic: pdu.generic, specific: pdu.specific, enterprise: pdu.enterprise ? String(pdu.enterprise) : undefined,
            varbinds: varbinds.map((vb) => ({
                oid: String(vb.oid),
                type: snmp.ObjectType[vb.type] || String(vb.type),
                value: renderValue(vb)
            }))
        })
    });
}

let receiver = null;
let lastErrLog = 0;

function start() {
    receiver = snmp.createReceiver({
        port: PORT,
        transport: 'udp4',
        disableAuthorization: true,   // accept any community - homelab receiver
        includeAuthentication: true   // ...but record which one was used
    }, (error, notification) => {
        if (error) {
            // Malformed packets and unsupported PDUs land here; never crash,
            // and don't let a chatty sender flood the log.
            const now = Date.now();
            if (now - lastErrLog > 10000) { lastErrLog = now; log('receive error:', error.message); }
            return;
        }
        try {
            handleNotification(notification);
        } catch (err) {
            log('failed to handle trap:', err.message);
        }
    });
    log(`listening on udp/${PORT} (v1 + v2c, any community)`);
}

function stop() {
    if (receiver) { try { receiver.close(); } catch (_) { /* already closed */ } receiver = null; }
}

module.exports = { start, stop, PORT };
