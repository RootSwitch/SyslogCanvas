# Changelog

## Unreleased

- **Settings now says which retention limit actually governs.** Two limits
  have always been configured - the day window and the row cap - but which
  one bites first depends on your arrival rate, a number the settings alone
  cannot tell you. A line under the retention controls now states it
  outright: how many messages are held, how many days they span, the
  measured rate per day, how many days the row cap holds at that rate, which
  of the two limits governs, and the size the database levels off at. Under
  an hour of data it declines to project rather than dress noise up as a
  forecast.

- **Bring your own theme, without a rebuild.** A `theme.json` in the data
  directory adds a thirtieth entry to the picker, above the twenty-nine shipped
  ones. Same fifteen `--se-*` variables, hex only, and partial files are fine -
  anything left out inherits Classic, so changing two colours takes a two-line
  file. Because the data directory is a bind mount, editing it is a browser
  refresh rather than a rebuild; delete the file and the entry goes away. Point
  several apps at one shared data directory and a single file themes all of them.

  The shipped themes were deliberately left alone: they are duplicated across
  six repos, the style guide and the demo, so every addition is drift - which is
  exactly why a user's palette should not join that set. `tools/export-theme.js`
  prints any shipped theme as a starting file so nobody has to learn the format
  from documentation.

  `tools/check-theme.js` validates a file before you restart anything, and calls
  the same loader the server calls, so it cannot accept what the app would
  reject. It also audits readability: text contrast against WCAG AA, plus hue
  separation and saturation on `--se-up`/`--se-down`/`--se-warn`, because a
  palette where healthy and failed do not separate at a glance is a different
  problem from one that is merely ugly. It reports and never refuses.

  The endpoint serving it is deliberately public. The login page is themed too,
  and gating this would leave the first page every user sees stuck on Classic
  while their palette waited behind a session. The loader rebuilds the theme
  from validated values rather than passing the file through, so unknown keys
  and non-hex values never reach a browser.

- **The container healthcheck no longer leaks zombies onto the host.** The
  image runs `node` as PID 1, and Node does not reap processes it did not
  spawn - so the HEALTHCHECK's `wget` left an `ssl_client` behind on every
  HTTPS probe and nothing collected it. One a minute, indefinitely. A zombie
  still holds a process slot against the `nproc` limit of the HOST uid the
  container runs as (1000), so after roughly a day that user could no longer
  fork: its SSH logins failed with "Server refused to start a shell/command"
  while root connected fine, and only a reboot cleared it. The symptom points
  nowhere near a log collector, which is why it went unexplained for a while.
  `docker-compose.yml` now sets `init: true`, putting tini at PID 1 to reap
  orphans. No image rebuild needed - `docker compose up -d` recreates the
  container with the init in place, and that also clears the existing zombies.

- **A fast device clock no longer dates New Year messages a year into the
  past.** RFC 3164 stamps carry no year, and the parser corrected only one
  direction of the inference: "Dec 31" read on Jan 1 moved back a year, but
  "Jan 1 00:03" read at Dec 31 23:59 - a device clock minutes fast - became
  Jan 1 of the current year, about 365 days in the past, and every message
  from that device stayed a year wrong until the server crossed midnight. A
  stamp landing more than ~363 days in the past now belongs to next year;
  genuinely old backlog (hours or days) is untouched either way. Covered in
  `tools/test-parse.js`.

- **Passwords hash and verify off the event loop.** `crypto.scryptSync` in
  `server/auth.js` serialised concurrent logins into one unbroken stall (8 at
  once measured ~218ms in which nothing was answered and no datagram drained),
  while each single call sat under per-call blocking thresholds - the burst is
  the cost, so a blocking sweep cannot see it. Now the async `crypto.scrypt`,
  awaited in the setup, login and password-change handlers; the server waits
  for the `ADMIN_PASSWORD` seed before listening. The stored hash format is
  unchanged - `tools/test-auth.js` (new, in `npm test`) proves a hash minted
  by the old synchronous code still verifies.

- **Backup download no longer freezes the collector.** `/api/backup` copied the
  database with a synchronous `VACUUM INTO`, which better-sqlite3 runs on the
  event loop - so for the duration nothing was answered and nothing was drained
  from the syslog socket. Measured on a 400MB database that was **3.0 seconds**,
  scaling at roughly 7.6s per GB. It now uses SQLite's incremental backup, which
  yields between batches of pages: worst single stall **0.4s**, and faster
  overall. Only one backup runs at a time, so two clicks cannot put two full
  copies of the database on the data volume at once.

- **Cisco syslog dialects now populate host and app correctly.** IOS, IOS-XE,
  NX-OS, CatOS and ASA are all "syslog", none are RFC 3164, and none agree with
  each other. Nothing was ever dropped - `raw` always held the datagram - but
  the parsed columns actively lied: CatOS's `%SYS-5-MOD_OK:Module` landed in
  the HOST field and IOS's sequence number landed in APP, so `host:` and `app:`
  filtering was unusable for very common gear. All five are recognised by their
  one shared anchor, the `%FACILITY-SEVERITY-MNEMONIC:` tag, with `app` set to
  the facility (`SYS`, `LINK`, `ASA`) which is what operators actually filter
  on. ASA's year-bearing timestamp now parses too. Guarded so a normal message
  that merely quotes a mnemonic is left to the RFC 3164 path: the Cisco header
  must be entirely accounted for, or it is not treated as one.

## 1.0.0 - 2026-07-18

Initial public release.

- **Syslog receiver** (UDP): RFC 3164 and RFC 5424 parsing - PRI,
  timestamp, hostname, and app tag extracted when present, the raw
  datagram always preserved. Nothing is dropped for being malformed; an
  unparseable line is stored whole with whatever fields did parse.
- **SNMP trap receiver** (v1 + v2c + informs, via net-snmp): any community
  accepted and recorded, varbinds rendered into a searchable one-line
  message and kept as structured JSON in the detail view. v1 generic traps
  map to their standard RFC 3418 OIDs.
- **One message table** for both protocols: newest-first live tail,
  severity badges, click-through detail modal with the raw datagram or
  decoded varbinds, and a one-click "filter this source" shortcut.
- **Server-side filter grammar** over the whole retained history: plain
  text and quoted phrases across msg/host/app/IP, plus `ip:` `host:`
  `app:` `sev:` (names, numbers, `<=`/`>=`) `fac:` `proto:` `after:`
  `before:` and `-negation`. Negating a field keeps rows that lack the
  field entirely. Everything parameterized end to end.
- **Readable paging** - selectable page size (25/50/100/200) with
  Newest/Newer/Older navigation, and a refresh-interval dropdown (2s-60s
  or Paused). Paging into history pauses the live tail automatically so
  rows never shift mid-read; both preferences persist per browser like
  the theme.
- **CSV export** of the current filter (up to 100,000 rows, streamed),
  spreadsheet-safe quoting with formula-injection guarding.
- **Retention both ways**: age-based nightly prune (default 90 days,
  03:30) plus a hard row cap (default 500,000, enforced within a minute)
  as the safety valve against log floods. Both editable in Settings,
  alongside database stats and a top-sources table.
- **Canvas-family UI**: the shared `--se-*` theme system with all 29
  CrossCanvas palettes (Paper / Warm / Cool / Night / Screen), the easel
  mark with a log-lines motif, no framework, no build step.
- **Single shared password** (scrypt) with cookie sessions and login rate
  limiting; automatic HTTPS when a cert pair exists in `<data>/certs/`;
  one-click consistent database backup from Settings.
- **Docker**: non-root container (`USER node`), unprivileged in-container
  listener ports (5514/5162) with compose mappings from host 514/162,
  healthcheck, single `/data` bind mount.
