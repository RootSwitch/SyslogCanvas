'use strict';
// Zero-dependency parser regression test: node tools/test-parse.js
// Exercises the RFC 3164 / 5424 message extraction against a corpus of real
// device shapes, including the edge cases that have bitten before (nil
// structured data, nil host, an empty message body, no PRI).

const { parse } = require('../server/syslog.js');

// [label, raw line, expected .msg, optional expected .host]
const CASES = [
    ['5424 nil SD',          '<34>1 2003-10-11T22:14:15.003Z host.example.com su - ID47 - message here', 'message here', 'host.example.com'],
    ['5424 nil SD short',    '<13>1 2026-07-18T12:00:00Z fw app 1234 msgid - the message', 'the message', 'fw'],
    ['5424 with SD',         '<165>1 2026-07-18T12:00:00Z host app 42 ID [exampleSDID@0 x="y"] real msg', 'real msg', 'host'],
    ['5424 nil host',        '<13>1 2026-07-18T12:00:00Z - app - - - just msg', 'just msg', null],
    ['5424 empty message',   '<13>1 2026-07-18T12:00:00Z host app - - -', '', 'host'],
    ['3164 basic',           '<34>Oct 11 22:14:15 mymachine su: msg body', 'msg body'],
    ['3164 no PRI',          'Oct 11 22:14:15 host kernel: something', 'something'],
    ['3164 tag with pid',    '<38>Jul 18 09:00:00 gw sshd[1234]: accepted', 'accepted'],
];

let pass = 0, fail = 0;
for (const [label, raw, expMsg, expHost] of CASES) {
    const row = parse(raw, '203.0.113.9');
    const msgOk = row && row.msg === expMsg;
    const hostOk = expHost === undefined || (row && row.host === expHost);
    const leaked = row && typeof row.msg === 'string' && /^- /.test(row.msg);
    if (msgOk && hostOk && !leaked) {
        pass++;
    } else {
        fail++;
        console.log('FAIL |', label);
        console.log('     msg      got', JSON.stringify(row && row.msg), 'expected', JSON.stringify(expMsg));
        if (expHost !== undefined) console.log('     host     got', JSON.stringify(row && row.host), 'expected', JSON.stringify(expHost));
        if (leaked) console.log('     leaked a "- " prefix');
    }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
