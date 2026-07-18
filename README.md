# SyslogCanvas - Basic Syslog & SNMP Trap Collection

> A lightweight, self-hostable syslog and SNMP trap receiver for home labs
> and small networks: catch what your devices say over UDP, keep a
> configurable window of it in SQLite, and review or export it from a
> dependency-light web UI.

SyslogCanvas listens for syslog messages (UDP/514) and SNMP traps (v1/v2c,
UDP/162), stores every datagram indexed by source IP, and gives you one
filterable table to answer "what was that device saying at 3am". It is the
fourth member of the Canvas family:
[**CrossCanvas**](https://github.com/RootSwitch/CrossCanvas) draws your
network, [**PingCanvas**](https://github.com/RootSwitch/PingCanvas) turns
those diagrams into a live reachability wall,
[**SNMPCanvas**](https://github.com/RootSwitch/SNMPCanvas) graphs the
performance history, and SyslogCanvas remembers what your devices said.

Where its sisters interlock - boards flow from CrossCanvas to PingCanvas,
SNMPCanvas feeds live values back onto those boards - SyslogCanvas is the
family's **independent member**: nothing feeds it, nothing reads from it,
and it needs none of the others installed. It shares the visual language,
the deployment shape, and the design philosophy, and otherwise just sits
quietly next to them collecting history until the day you need to look
backwards. The small-footprint ethos carries over intact: one container,
one SQLite file, two runtime dependencies, and a frontend that is plain
HTML/CSS/JS with no build step.

![Four SyslogCanvas themes, four views: the live message tail on Classic, warnings-and-worse filtered with sev:<=4 telling a UPS power-event story on Blueprint, an SNMP trap's decoded varbinds in the detail modal on Ember, and retention settings with database stats on Canvas](docs/hero-quadrants.png)

## How it works

```
your devices ──syslog (UDP/514)──────► SyslogCanvas ──► SQLite ──► web UI
              ──SNMP traps (UDP/162)──►      │                      │
                 (v1/v2c)                    └── retention prune    └── CSV export
```

One Node process does everything: two UDP listeners parse what arrives
(RFC 3164 and RFC 5424 syslog, v1/v2c traps and informs), batched writes
land the rows in SQLite, and the same process serves the UI. Nothing is
ever dropped for being malformed - a line that doesn't parse is stored
whole with whatever fields did.

## Features

- **One message table** - syslog and traps side by side, newest first,
  live-tailing while you watch. Time, source IP, severity badge, host, app
  (or trap OID), and the message; click a row for the full detail including
  the raw datagram or decoded varbinds.
- **Server-side filtering** - a single filter box that searches text or
  narrows by field, over the whole retained history rather than just the
  rows on screen (syntax below). One click in any message's detail view
  filters to its source.
- **A tail you can pause** - a refresh dropdown (2s to 60s, or **Paused**)
  freezes the view while you read through an incident, and paging into
  history pauses it automatically - rows never shift under you mid-read.
  Page size is selectable (25-200 rows); both preferences stick per
  browser, like the theme.
- **CSV export** - one click exports whatever the current filter matches
  (up to 100,000 rows), quoted properly and safe to open in a spreadsheet.
- **Retention you control** - keep N days (default 90, pruned nightly at
  03:30) *and* a hard row cap (default 500,000) as a safety valve, so one
  misbehaving device can't balloon the database inside the window. Both
  live in Settings, next to database stats and a top-sources table that
  names the chatty device when it happens.
- **Best-effort parsing, zero configuration** - PRI, timestamp, hostname,
  and tag are extracted when present; traps get their varbinds rendered
  into a readable line so plain-text search covers them too. There is no
  parsing-rules engine to maintain - see *Small on purpose*.
- **Single shared password** for the UI (scrypt-hashed), sessions, login
  rate limiting, automatic HTTPS when a certificate exists, and one-click
  database backups from the Settings page.
- **29 themes** carried over from CrossCanvas's palette family, grouped the
  same way (Paper / Warm / Cool / Night / Screen).

## Small on purpose

SyslogCanvas is intentionally a store of messages with a clear window onto
it: receive, keep, filter, export. The goal is a solid baseline with
defaults sensible enough that setup-and-forget actually works - not a
platform that grows features faster than one person's weekends can maintain
them. So alerting, forwarding, parsing rules, dashboards, and correlation
aren't on the roadmap: those are jobs for bigger tools, and the tools built
around them are worth running if you need them. This exists for the middle
ground where Graylog is overkill but "the switch doesn't remember its own
logs after a reboot" keeps stinging.

Two honest limits worth knowing up front: syslog and traps over UDP are
fire-and-forget - a datagram lost on the wire is lost, which is fine for
troubleshooting history and wrong for compliance logging. And SNMPv3 traps
are not supported; v1/v2c covers nearly all home-lab gear.

Keeping the moving parts few is a design choice, not an oversight - and if
you want it to become something bigger, the license makes forking genuinely
easy.

## Quick start (Docker)

```yaml
# docker-compose.yml
services:
  syslogcanvas:
    build: .        # or a published image once available
    ports:
      - "9514:9514"       # web UI
      - "514:5514/udp"    # syslog
      - "162:5162/udp"    # SNMP traps
    volumes: ["./data:/data:z"]   # :z = SELinux label; harmless elsewhere
    environment:
      - TZ=Etc/UTC                # your timezone: prune schedule + log stamps
    restart: unless-stopped
```

```
mkdir -p data && sudo chown 1000:1000 data   # container runs as uid 1000
docker compose up -d
```

Open `http://host:9514`, set the admin password on the first-run page, and
point your devices' syslog / trap targets at the host. That's the whole
install. (The default web port is a nod to syslog's UDP/514, picked to
coexist quietly with common home-lab neighbors like Uptime Kuma on 3001,
CrossCanvas/PingCanvas on 8080/8443, and SNMPCanvas on 9161.)

Inside the container the listeners bind unprivileged ports (5514/5162) so
the process never needs root; the compose mapping above puts them on the
standard 514/162 at the host edge. If you run with `network_mode: host`
instead, either keep the high ports and reconfigure your devices, or grant
`cap_add: [NET_BIND_SERVICE]` and set `SYSLOG_PORT=514` / `TRAP_PORT=162`.

One first-run note: the setup page belongs to whoever reaches the port
first, so on anything but a trusted segment either set `ADMIN_PASSWORD` in
the compose file or claim the page immediately after `up -d`.

### HTTPS

Run the included script once on the docker host, then restart:

```
./tools/gen-cert.sh 192.168.1.50 nas.lan    # your host's IPs / names
docker compose restart
```

It writes a self-signed cert to `data/certs/server.crt` + `server.key`; the
server detects the pair at startup and switches to HTTPS on the same port
(session cookies become `Secure` automatically). Prefer a real certificate?
Place your own PEM pair at those two paths (or point `TLS_CERT`/`TLS_KEY`
elsewhere) - nothing else changes. Delete the files to fall back to HTTP.

If you mount a different host directory at `/data` (say
`/srv/noc-data/syslogcanvas`), the certs belong in *that* directory's
`certs/` subfolder - tell the script with
`CERT_DIR=/srv/noc-data/syslogcanvas/certs ./tools/gen-cert.sh ...`. And if
HTTPS doesn't come up after a restart, the server stayed on HTTP because it
couldn't use the cert - `docker compose logs syslogcanvas | grep -i tls`
names the cause, which is almost always one of two things: the pair isn't
at `<data>/certs/server.crt` + `server.key`, or it isn't readable by uid
1000 (`sudo chown -R 1000:1000 <data>/certs` fixes that one).

### Customizing the deployment

Put host-specific settings (volume paths, environment variables, ports) in
a `docker-compose.override.yml` next to the compose file - Docker Compose
merges it automatically, and it's gitignored so updates never conflict with
your edits:

```yaml
# docker-compose.override.yml (example)
services:
  syslogcanvas:
    volumes:
      - /srv/noc-data/syslogcanvas:/data:z   # replaces ./data (same container path)
    environment:
      - TZ=America/Chicago
```

Keeping the data directory outside the checkout means the clone itself is
disposable - delete it, re-clone it, nothing of value was inside. If other
Canvas-family projects share the parent directory, give each its own
subfolder so their databases and `certs/` never collide.

### Updating an existing install

```
git pull
sudo docker compose up -d --build
```

`up -d --build` rebuilds the image and recreates the container only when
something changed; the data directory is a bind mount, so messages and
settings ride through every update (schema migrations run automatically on
first boot). Old image layers accumulate over time - an occasional
`sudo docker image prune -f` tidies them up.

One field note on restarts: a few syslog senders (pfSense among them) use a
*connected* UDP socket and can silently stop sending after the receiver
blinks - the ICMP port-unreachable from the restart window wedges their
socket until their syslog service is bounced. If one device goes quiet
after an update, restart its syslog service before suspecting SyslogCanvas.

### Running without Docker

Node 20+: `npm install && npm start` (listens on `:9514`, syslog on
udp/5514, traps on udp/5162, data in `./data`).

## Filter syntax

Everything in the filter box is ANDed together; plain text searches the
message, host, app, and source IP at once.

| Token | Matches |
|---|---|
| `link down` | rows containing both words (anywhere in msg/host/app/IP) |
| `"link down"` | rows containing the exact phrase |
| `ip:192.168.1.` | source IP starting with that prefix |
| `host:sw1` / `app:sshd` | hostname / app-tag contains it |
| `sev:err` or `sev:3` | that syslog severity; also `sev:<=3` (err and worse), `sev:>=4` |
| `fac:daemon` or `fac:16` | that syslog facility (names: kern...local7) |
| `proto:syslog` / `proto:trap` | one protocol only |
| `after:2026-07-01` / `before:2026-07-18T14:30` | receive-time bounds (local time) |
| `-token` | negate anything above: `-app:cron`, `-"noise phrase"` |

Severity names: `emerg alert crit err warning notice info debug`. Traps
have no syslog severity - filter them with `proto:trap` and text. Negating
a field keeps rows that don't have the field at all (`-app:cron` still
shows traps and unparsed lines - they aren't cron either).

## Sending test traffic

With the server running:

```
node tools/send-test.js                  # a few realistic syslog lines + v1/v2c traps
node tools/send-test.js --flood 20000    # burst-load the ingest path
```

Against a docker deployment add `--host <docker-host> --syslog-port 514
--trap-port 162`. Or from any Linux box:

```
logger -n <host> -P 514 -d "hello from logger"
snmptrap -v 2c -c public <host>:162 '' 1.3.6.1.6.3.1.1.5.3 ifIndex i 2
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9514` | HTTP/HTTPS listen port |
| `SYSLOG_PORT` | `5514` | UDP port the syslog listener binds in-container |
| `TRAP_PORT` | `5162` | UDP port the trap receiver binds in-container |
| `SYSLOGCANVAS_DATA` | `/data` | Directory for the SQLite db and certs |
| `TLS_CERT` / `TLS_KEY` | `$DATA/certs/server.crt|key` | PEM cert/key pair; HTTPS turns on when both exist |
| `ADMIN_PASSWORD` | - | Pre-set the UI password (otherwise first-run setup page) |
| `COOKIE_SECURE` | auto | `Secure` cookies: on with HTTPS, off with HTTP; set to override |
| `TZ` | UTC | Timezone for the nightly prune and log timestamps |

Retention (days and the row cap) is set in the UI (Settings) and stored in
the database.

## Security posture

SyslogCanvas is a networked app with a small, deliberate threat model:

- **The listeners are open by design.** Syslog and SNMPv1/v2c traps have no
  authentication and no encryption: anything that can reach the UDP ports
  can insert messages, and source IPs are whatever the packet claims (UDP
  is trivially spoofable on an untrusted segment). The trap receiver
  accepts any community string - it *records* which one was used, but does
  not verify it. Keep the listener ports on a trusted VLAN and never expose
  them to the internet.
- **Treat stored messages as sensitive.** Logs routinely carry hostnames,
  usernames, and the occasional secret some device helpfully printed. The
  database, the CSV exports, and the **backups downloaded from Settings**
  all contain the full message history in the clear - handle them like the
  logs they are.
- The web UI has one shared password and is designed for a trusted network
  segment; a reverse proxy adds TLS termination and extra auth cleanly if
  you want to go further. The first-run setup page belongs to whoever
  reaches it first - claim it promptly or pre-set `ADMIN_PASSWORD`.
- The ingest path is deliberately dumb: datagrams are parsed with plain
  string handling, never executed or interpreted, all queries are
  parameterized, and everything is HTML-escaped on display. A hostile
  sender can fill your row cap with garbage (see Settings → top sources to
  name the offender), but the cap means that's a bounded annoyance, not a
  disk-filler.

## Development

```
npm install
npm start                # UI on http://localhost:9514
node tools/send-test.js  # rows to look at, ten seconds later
```

No build step: edit, refresh. The frontend is three static files; the
server restarts in under a second.

### Project layout

| Path | Purpose |
|---|---|
| `server/server.js` | HTTP entry point: static files + API dispatch (plain `node:http`) |
| `server/api.js` | All `/api/*` handlers |
| `server/syslog.js` | UDP listener + RFC 3164/5424 parser |
| `server/traps.js` | SNMP trap receiver (net-snmp) + varbind rendering |
| `server/store.js` | Ingest queue, batched writes, row-cap enforcement |
| `server/filter.js` | Filter grammar → parameterized SQL |
| `server/retention.js` | Nightly age-based prune |
| `server/db.js` / `auth.js` | SQLite schema and migrations; scrypt password + sessions |
| `public/` | The whole frontend: vanilla HTML/CSS/JS, no build step |
| `tools/send-test.js` | Test syslog + trap traffic for development |

Runtime dependencies:
[`net-snmp`](https://www.npmjs.com/package/net-snmp) and
[`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3) - the
complete list, by design.

## Contributing

Bug reports are welcome via Issues, and **parser samples are especially
useful**: real devices bend the syslog RFCs in creative ways, and if one of
yours parses badly (wrong host, mangled app tag, timestamp misread), an
issue with a sanitized raw line - it's preserved verbatim in the message
detail view, so it's one copy-paste away - is what makes the parser better.
Small, self-contained fixes are welcome as pull requests too.

For larger features - alerting, forwarding, parsing rules, TCP or TLS
syslog, and the like - I'd rather you fork than open a big PR. SyslogCanvas
is deliberately small, the whole backend is nine readable files, and The
Unlicense means you owe nobody anything. Build the collector you want.

## Credits

SyslogCanvas stands on two excellent MIT-licensed libraries:

- [**net-snmp**](https://github.com/markabrahams/node-net-snmp) by Mark
  Abrahams, Stephen Vickers, and contributors - the pure-JavaScript SNMP
  engine behind the trap receiver (and the test trap sender in
  `tools/send-test.js`).
- [**better-sqlite3**](https://github.com/WiseLibs/better-sqlite3) by Joshua
  Wise and contributors - the synchronous SQLite bindings that keep the
  storage layer a single dependency, wrapping the public-domain
  [SQLite](https://sqlite.org) library itself.

The visual language is borrowed from
[CrossCanvas](https://github.com/RootSwitch/CrossCanvas), SyslogCanvas's
sister project.

## License

[The Unlicense](LICENSE) - public domain, same as CrossCanvas, PingCanvas,
and SNMPCanvas. Use it, fork it, ship it at work, no attribution required.
(Dependencies keep their own MIT licenses in `node_modules/` when you
install or ship an image.)
