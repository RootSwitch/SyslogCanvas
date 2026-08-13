'use strict';
// Verifies the filter grammar's SQL builder - the one builder shared by the
// message list, the CSV export, and now the fielded filter panel (which
// composes these tokens instead of asking the user to type them).
//
//   node tools/test-filter.js

const { buildWhere } = require('../server/filter');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

const empty = buildWhere('');
check('empty filter builds no WHERE', empty.sql === '' && empty.params.length === 0);

const plain = buildWhere('fail');
check('plain term searches all four text columns', /msg LIKE .* OR host LIKE .* OR app LIKE .* OR source_ip LIKE/.test(plain.sql),
    plain.sql);

const msg = buildWhere('msg:fail');
check('msg: pins the match to the message column alone',
    msg.sql === "msg LIKE ? ESCAPE '\\'" && msg.params[0] === '%fail%', msg.sql);

const host = buildWhere('host:sw1');
check('host: matches host only', host.sql === "host LIKE ? ESCAPE '\\'" && host.params[0] === '%sw1%');

const ip = buildWhere('ip:192.168.1.');
check('ip: is a prefix match, not contains', ip.params[0] === '192.168.1.%');

const sev = buildWhere('sev:<=4');
check('sev:<=4 is a numeric bound', sev.sql === 'severity <= ?' && sev.params[0] === 4);
check('sev:warning resolves the name', buildWhere('sev:warning').params[0] === 4);

const neg = buildWhere('-app:cron');
check('negation is NULL-safe (keeps rows with no app at all)',
    neg.sql.startsWith('NOT COALESCE(') , neg.sql);

const wild = buildWhere('msg:100%');
check('LIKE wildcards in user input are escaped', wild.params[0] === '%100\\%%', JSON.stringify(wild.params));

const multi = buildWhere('host:sw1 msg:down sev:<=3');
check('tokens AND together', multi.sql.split(' AND ').length === 3);

const unknown = buildWhere('12:30:05');
check('unknown key falls through to plain-term search', /OR host LIKE/.test(unknown.sql));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall filter checks passed');
process.exit(failures ? 1 : 0);
