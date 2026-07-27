'use strict';
// Zero-dependency parser regression test: node tools/test-parse.js
// Exercises the RFC 3164 / 5424 message extraction against a corpus of real
// device shapes, including the edge cases that have bitten before (nil
// structured data, nil host, an empty message body, no PRI).

const { parse } = require('../server/syslog.js');

// [label, raw line, expected .msg, optional expected .host, optional expected .app]
const CASES = [
    ['5424 nil SD',          '<34>1 2003-10-11T22:14:15.003Z host.example.com su - ID47 - message here', 'message here', 'host.example.com'],
    ['5424 nil SD short',    '<13>1 2026-07-18T12:00:00Z fw app 1234 msgid - the message', 'the message', 'fw'],
    ['5424 with SD',         '<165>1 2026-07-18T12:00:00Z host app 42 ID [exampleSDID@0 x="y"] real msg', 'real msg', 'host'],
    ['5424 nil host',        '<13>1 2026-07-18T12:00:00Z - app - - - just msg', 'just msg', null],
    ['5424 empty message',   '<13>1 2026-07-18T12:00:00Z host app - - -', '', 'host'],
    ['3164 basic',           '<34>Oct 11 22:14:15 mymachine su: msg body', 'msg body'],
    ['3164 no PRI',          'Oct 11 22:14:15 host kernel: something', 'something'],
    ['3164 tag with pid',    '<38>Jul 18 09:00:00 gw sshd[1234]: accepted', 'accepted'],

    // --- Cisco. None of these are RFC 3164 and none agree with each other.
    // Before the %FACILITY-SEVERITY-MNEMONIC anchor existed they did not merely
    // parse incompletely, they parsed WRONG: CatOS put its message body in the
    // HOST column and IOS put its sequence number in APP, which quietly poisons
    // host:/app: filtering for very common gear. Nothing was ever lost - raw
    // always held the datagram - but the columns lied.
    ['IOS seq + host + *clock',
     '<190>1234: cube-01: *Jul 25 14:30:00.456: %SYS-5-CONFIG_I: Configured from console by admin',
     '%SYS-5-CONFIG_I: Configured from console by admin', 'cube-01', 'SYS'],
    ['IOS seq, no hostname',
     '<187>000123: *Jul 25 14:30:00.456 UTC: %LINK-3-UPDOWN: Interface Gi0/1, changed state to down',
     '%LINK-3-UPDOWN: Interface Gi0/1, changed state to down', null, 'LINK'],
    ['CatOS, no hostname at all',
     '<189>Jul 25 14:30:00 %SYS-5-MOD_OK:Module 3 is online',
     '%SYS-5-MOD_OK:Module 3 is online', null, 'SYS'],
    ['ASA, year inside the timestamp',
     '<166>Jul 25 2026 14:30:00 asa-fw : %ASA-6-302013: Built outbound TCP connection 12345',
     '%ASA-6-302013: Built outbound TCP connection 12345', 'asa-fw', 'ASA'],
    // The zone must not eat a hostname: a lax [A-Za-z]{2,5} matches the "asa"
    // of "asa-fw". A real zone abuts its colon; a hostname does not.
    ['ASA with an uppercase timezone',
     '<166>Jul 25 2026 14:30:00 CDT: %ASA-4-106023: Deny tcp src outside:10.1.1.1/443',
     '%ASA-4-106023: Deny tcp src outside:10.1.1.1/443', null, 'ASA'],
    // A % pattern deep in prose is NOT a Cisco header - the anchor only counts
    // near the start of the line, or ordinary text would be shredded.
    ['prose mentioning a mnemonic late',
     '<13>Jul 25 14:30:00 host app: operator note about %SYS-5-CONFIG_I: seen earlier today',
     'operator note about %SYS-5-CONFIG_I: seen earlier today', 'host', 'app'],
];

let pass = 0, fail = 0;
for (const [label, raw, expMsg, expHost, expApp] of CASES) {
    const row = parse(raw, '203.0.113.9');
    const msgOk = row && row.msg === expMsg;
    const hostOk = expHost === undefined || (row && row.host === expHost);
    const appOk = expApp === undefined || (row && row.app === expApp);
    const leaked = row && typeof row.msg === 'string' && /^- /.test(row.msg);
    if (msgOk && hostOk && appOk && !leaked) {
        pass++;
    } else {
        fail++;
        console.log('FAIL |', label);
        console.log('     msg      got', JSON.stringify(row && row.msg), 'expected', JSON.stringify(expMsg));
        if (expHost !== undefined) console.log('     host     got', JSON.stringify(row && row.host), 'expected', JSON.stringify(expHost));
        if (expApp !== undefined) console.log('     app      got', JSON.stringify(row && row.app), 'expected', JSON.stringify(expApp));
        if (leaked) console.log('     leaked a "- " prefix');
    }
}

// --- RFC 3164 year inference around New Year -------------------------------
// The stamp has no year, so parse() infers one from the receive clock. Both
// directions of clock skew matter: a Dec 31 stamp read on Jan 1 (slow device)
// belongs to LAST year, and a Jan 1 stamp read on Dec 31 (fast device) belongs
// to NEXT year - that second case used to land a full year in the past.
// [label, raw line, receive time, expected message time] (all local time)
const YEAR_CASES = [
    ['slow device: Dec 31 stamp read on Jan 1',
     '<13>Dec 31 23:59:00 host app: late', new Date(2027, 0, 1, 0, 1, 0), new Date(2026, 11, 31, 23, 59, 0)],
    ['fast device: Jan 1 stamp read on Dec 31',
     '<13>Jan  1 00:03:00 host app: early', new Date(2026, 11, 31, 23, 59, 0), new Date(2027, 0, 1, 0, 3, 0)],
    ['same year, hours old: untouched',
     '<13>Jul 25 08:00:00 host app: backlog', new Date(2026, 6, 27, 12, 0, 0), new Date(2026, 6, 25, 8, 0, 0)],
];
for (const [label, raw, now, expected] of YEAR_CASES) {
    const row = parse(raw, '203.0.113.9', now.getTime());
    const want = Math.floor(expected.getTime() / 1000);
    if (row && row.msg_ts === want) {
        pass++;
    } else {
        fail++;
        console.log('FAIL |', label);
        console.log('     msg_ts   got', row && row.msg_ts, `(${row && row.msg_ts && new Date(row.msg_ts * 1000).toISOString()})`,
            'expected', want, `(${expected.toISOString()})`);
    }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
