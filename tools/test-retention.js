'use strict';
// Verifies the retention outlook: which of the two configured limits (day
// window vs row cap) actually governs at the measured arrival rate, and the
// honest-null cases where no rate can be measured yet.
//
//   node tools/test-retention.js

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// api.js pulls in db.js, which creates its data directory on require.
process.env.SYSLOGCANVAS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'syslogcanvas-retention-'));

const { retentionOutlook } = require('../server/api');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

const DAY = 86400;
const now = 1_800_000_000;

const empty = retentionOutlook(0, 4096, null, 90, 500000, now);
check('empty store: nulls, not zeros pretending to be data',
    empty.heldDays === null && empty.governs === null && empty.capDays === null);

const young = retentionOutlook(1200, 96e3, now - 1800, 90, 500000, now);
check('under an hour held: count reported, rate and verdict withheld',
    young.rowCount === 1200 && young.rowsPerDay === null && young.governs === null,
    JSON.stringify(young));

const skewed = retentionOutlook(1200, 96e3, now + 3600, 90, 500000, now);
check('clock skew (oldest in the future) degrades to honest nulls', skewed.governs === null);

// A loud site: 214,310 rows in 12.4 days is ~17,283/day, so the 500k cap is
// ~28.9 days - it bites long before the 90-day window.
const loud = retentionOutlook(214310, 58e6, now - 12.4 * DAY, 90, 500000, now);
check('rate is rows over days held', Math.round(loud.rowsPerDay) === Math.round(214310 / 12.4),
    String(loud.rowsPerDay));
check('the cap priced in days at that rate', Math.round(loud.capDays) === 29, String(loud.capDays));
check('loud site: the cap governs, not the window',
    loud.governs === 'cap' && loud.effectiveDays === loud.capDays);

// A quiet site: 100/day means the cap alone would hold 5,000 days - the
// 90-day window is the limit that matters.
const quiet = retentionOutlook(1000, 2e6, now - 10 * DAY, 90, 500000, now);
check('quiet site: the window governs', quiet.governs === 'days' && quiet.effectiveDays === 90);
check('steady size prices the EFFECTIVE days, not the configured window',
    loud.steadyBytes === Math.round((58e6 / 12.4) * loud.capDays)
    && quiet.steadyBytes === Math.round((2e6 / 10) * 90),
    `${loud.steadyBytes} / ${quiet.steadyBytes}`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall retention checks passed');
process.exit(failures ? 1 : 0);
