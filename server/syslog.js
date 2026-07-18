'use strict';
// Syslog over UDP: a dgram socket plus a best-effort parser for the two
// formats in the wild - RFC 5424 ("<PRI>1 ...") and RFC 3164 ("<PRI>Mmm dd
// hh:mm:ss host tag: msg"). The rule that matters: NEVER drop a datagram.
// Anything unparseable is stored whole with whatever fields did parse.

const dgram = require('node:dgram');
const store = require('./store');

// Default 5514: the container runs unprivileged (USER node), so the host maps
// 514/udp here (see docker-compose.yml). Change with SYSLOG_PORT.
const PORT = parseInt(process.env.SYSLOG_PORT || '5514', 10);
const MAX_BYTES = 8192; // cap stored datagram size; RFC 5424 minimum is 480

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function log(...args) { console.log(new Date().toISOString(), '[syslog]', ...args); }

// "Jul 18 12:00:05" (RFC 3164, no year) -> epoch seconds. The year is
// inferred as current-year unless that lands more than 2 days in the future
// (a Dec 31 message read on Jan 1), in which case it's last year.
function parse3164Time(mon, day, h, m, s, now) {
    const d = new Date(now.getFullYear(), mon, day, h, m, s);
    if (d.getTime() - now.getTime() > 2 * 86400 * 1000) d.setFullYear(d.getFullYear() - 1);
    return Math.floor(d.getTime() / 1000);
}

// RFC 5424 STRUCTURED-DATA: "-" or one-or-more [id k="v" ...] blocks where
// `\]` is an escaped bracket. Returns the index just past the SD element.
function skipStructuredData(s, i) {
    if (s[i] === '-') return i + 1;
    while (s[i] === '[') {
        i++;
        let inQuotes = false;
        while (i < s.length) {
            const c = s[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '"') inQuotes = !inQuotes;
            else if (c === ']' && !inQuotes) { i++; break; }
            i++;
        }
    }
    return i;
}

// One datagram -> a messages-table row. Exported for tests and reuse.
function parse(line, sourceIp, nowMs) {
    const now = nowMs ? new Date(nowMs) : new Date();
    const row = {
        ts: Math.floor(now.getTime() / 1000),
        msg_ts: null,
        source_ip: sourceIp,
        proto: 'syslog',
        facility: null,
        severity: null,
        host: null,
        app: null,
        msg: line,
        raw: line
    };

    let rest = line;

    // <PRI>
    const pri = /^<(\d{1,3})>/.exec(rest);
    if (pri && parseInt(pri[1], 10) <= 191) {
        const n = parseInt(pri[1], 10);
        row.facility = n >> 3;
        row.severity = n & 7;
        rest = rest.slice(pri[0].length);
    }

    // RFC 5424: VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD [SP MSG]
    if (rest.startsWith('1 ')) {
        const fields = rest.slice(2).split(' ');
        if (fields.length >= 5) {
            const [tsStr, host, app, procid, msgid] = fields;
            const t = Date.parse(tsStr);
            if (!Number.isNaN(t)) row.msg_ts = Math.floor(t / 1000);
            if (host !== '-') row.host = host;
            if (app !== '-') row.app = app + (procid !== '-' ? `[${procid}]` : '');
            // Everything after the 5 header fields: SD, then the free-form MSG.
            const headerLen = tsStr.length + host.length + app.length + procid.length + msgid.length + 5;
            const tail = rest.slice(2 + headerLen);
            const sdEnd = skipStructuredData(tail, 0);
            let msg = tail.slice(sdEnd);
            if (msg.startsWith(' ')) msg = msg.slice(1);
            if (msg.charCodeAt(0) === 0xFEFF) msg = msg.slice(1); // UTF-8 BOM
            // A well-formed header with no MSG is a legitimately EMPTY message -
            // the old `msg || tail || rest` resurrected the nil-SD marker ('-')
            // as the body. Only fall back to the raw line when the header itself
            // didn't parse (tail empty because headerLen overran the string).
            row.msg = tail ? msg : rest;
            return row;
        }
        // Malformed 5424 header - fall through and store as-is.
        row.msg = rest;
        return row;
    }

    // RFC 3164: TIMESTAMP HOSTNAME TAG[pid]: MSG (each part optional in the wild)
    const t3164 = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) /.exec(rest);
    if (t3164 && MONTHS[t3164[1]] !== undefined) {
        row.msg_ts = parse3164Time(MONTHS[t3164[1]], +t3164[2], +t3164[3], +t3164[4], +t3164[5], now);
        rest = rest.slice(t3164[0].length);

        // Next token: a hostname, unless it reads as a tag ("sshd[42]:" /
        // "kernel:") - some devices skip the hostname entirely.
        const sp = rest.indexOf(' ');
        const token = sp === -1 ? rest : rest.slice(0, sp);
        const looksLikeTag = /^[\w.\/-]+(\[\d+\])?:$/.test(token);
        if (!looksLikeTag && token && sp !== -1) {
            row.host = token;
            rest = rest.slice(sp + 1);
        }
    }

    const tag = /^([\w.\/-]+)(\[\d+\])?:\s*/.exec(rest);
    if (tag) {
        row.app = tag[1] + (tag[2] || '');
        rest = rest.slice(tag[0].length);
    }

    row.msg = rest;
    return row;
}

let socket = null;
let truncWarned = false;

function start() {
    socket = dgram.createSocket('udp4');
    socket.on('error', (err) => {
        log(`socket error: ${err.message}`);
        if (err.code === 'EACCES' || err.code === 'EADDRINUSE') process.exit(1);
    });
    socket.on('message', (buf, rinfo) => {
        try {
            if (buf.length > MAX_BYTES) {
                buf = buf.subarray(0, MAX_BYTES);
                if (!truncWarned) { truncWarned = true; log(`datagram over ${MAX_BYTES} bytes truncated (logged once)`); }
            }
            // Trim the trailing newline some senders append; keep inner ones.
            const line = buf.toString('utf8').replace(/[\r\n]+$/, '');
            if (!line) return;
            store.enqueue(parse(line, rinfo.address));
        } catch (err) {
            log('failed to handle datagram:', err.message);
        }
    });
    socket.bind(PORT, '0.0.0.0', () => log(`listening on udp/${PORT}`));
}

function stop() {
    if (socket) { try { socket.close(); } catch (_) { /* already closed */ } socket = null; }
}

module.exports = { start, stop, parse, PORT };
