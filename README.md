# SyslogCanvas - Basic Syslog & SNMP Trap Collection

> A lightweight, self-hostable syslog and SNMP trap receiver for home labs
> and small networks: catch what your devices say over UDP, keep a
> configurable window of it in SQLite, and review or export it from a
> dependency-light web UI.

SyslogCanvas listens for syslog messages (UDP/514) and SNMP traps (v1/v2c,
UDP/162), stores every datagram indexed by source IP, and gives you one
filterable table to answer "what was that device saying at 3am".

It is one of six members of the Canvas family:
[**CrossCanvas**](https://github.com/RootSwitch/CrossCanvas) draws your
network, [**PingCanvas**](https://github.com/RootSwitch/PingCanvas) turns
those diagrams into a live reachability wall,
[**SNMPCanvas**](https://github.com/RootSwitch/SNMPCanvas) graphs the
performance history,
[**AlertCanvas**](https://github.com/RootSwitch/AlertCanvas) turns that
history into raise/clear notifications,
[**LaunchCanvas**](https://github.com/RootSwitch/LaunchCanvas) is the
suite's front door - one login for every app - and SyslogCanvas remembers
what your devices said.

**Install the whole suite in one command:** the [canvas-suite](https://github.com/RootSwitch/canvas-suite) repo is the family's landing page, with one-shot install scripts for the full six-app stack or a Pi-class PingCanvas + AlertCanvas pair.

Where its sisters interlock - boards flow from CrossCanvas to PingCanvas,
SNMPCanvas feeds live values back onto those boards and into AlertCanvas -
SyslogCanvas is the family's **independent member**: nothing feeds it,
nothing reads from it, and it needs none of the others installed.
(Two opt-ins soften that without breaking it: AlertCanvas can *send* its
alerts here as RFC 5424 syslog, which lands first-class like any other
source, and setting `SUITE_SECRET` lets the LaunchCanvas portal's single
sign-on log you in here - a sender's choice and an operator's choice, not
dependencies.) It shares the visual language, the deployment shape, and the
design philosophy, and otherwise just sits quietly next to them collecting
history until the day you need to look backwards. The small-footprint
ethos carries over intact: one container, one SQLite file, two runtime
dependencies, and a frontend that is plain HTML/CSS/JS with no build step.

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
- **30 themes** - Classic plus 29 shared with CrossCanvas's palette family, grouped the
  same way (Paper / Warm / Cool / Night / Screen).

## Small on purpose

SyslogCanvas is intentionally a store of messages with a clear window onto
it: receive, keep, filter, export. The goal is a solid baseline with
defaults sensible enough that setup-and-forget actually works - not a
platform that grows features faster than one person's weekends can maintain
them. So alerting, forwarding, parsing rules, dashboards, and correlation
aren't on the roadmap: those are jobs for bigger tools, and the tools built
around them are worth running if you need them. This exists for the middle
ground where Graylog is more than you need but a switch that forgets its
own logs after a reboot is a recurring problem.

Two honest limits worth knowing up front: syslog and traps over UDP are
fire-and-forget - a datagram lost on the wire is lost, which is fine for
troubleshooting history and wrong for compliance logging. The receiver has
edges of its own, sized for the same audience: datagrams are read up to
8 KB (longer ones truncate), and a burst beyond the 50,000-row ingest
queue drops oldest-first - the `/api/stats` endpoint reports a `dropped`
counter so you can see if either ever happens. Trap OIDs are shown
numerically as sent - there is no MIB resolution. And SNMPv3 traps
are not supported; v1/v2c covers nearly all home-lab gear.

Keeping the moving parts few is a design choice, not an oversight - and if
you want it to become something bigger, the license makes forking genuinely
easy.

## Quick start (Docker)

> **Installed via the [canvas-suite](https://github.com/RootSwitch/canvas-suite)
> script?** Skip this section - your data already lives under
> `/srv/noc-data/syslogcanvas`, the override file (incl. SUITE_SECRET) is
> already written, and the app is running. Sign in through LaunchCanvas
> (the setup script prints its admin password once, and stores it in
> `/projects/launchcanvas/docker-compose.override.yml`); this app has no
> login of its own until you set an optional fallback password in Settings.
> **On Windows?** Skip the `chown` steps (Docker Desktop handles ownership);
> set env vars PowerShell-style (`$env:NAME = 'value'; npm start`); and
> `tools/gen-cert.sh` needs Git Bash or WSL - or drop your own PEM pair at
> the cert paths.

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
mkdir -p data && sudo chown 1000:1000 data && sudo chmod 750 data
docker compose up -d                         # container runs as uid 1000
```

Open `http://host:9514`, set the admin password on the first-run page, and
point your devices' syslog / trap targets at the host. That's the whole
install. (The default web port is a nod to syslog's UDP/514, picked to
coexist quietly with common home-lab neighbors like Uptime Kuma on 3001
and the rest of the suite:
PingCanvas (which also serves the CrossCanvas editor) on 8080/8443, SNMPCanvas on 9161, AlertCanvas on 9162, and LaunchCanvas on 9160.)

Inside the container the listeners bind unprivileged ports (5514/5162) so
the process never needs root; the compose mapping above puts them on the
standard 514/162 at the host edge. If you run with `network_mode: host`
instead, keep the high ports and reconfigure your devices - or lower the
host's unprivileged-port floor (`sysctl net.ipv4.ip_unprivileged_port_start=514`,
a host-wide setting) and set `SYSLOG_PORT=514` / `TRAP_PORT=162`. (A
`cap_add: [NET_BIND_SERVICE]` grant does NOT work here: the container runs
as a non-root user, and added capabilities do not survive the uid switch.)

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
blinks. During a reboot there's a window where the host is up but this
container isn't yet, so a syslog packet hits port 514 with no listener and
the kernel fires back an ICMP port-unreachable; pfSense's syslog-ng takes
that as `ECONNREFUSED` and stops sending until its syslog service is bounced.
If one device goes quiet after an update, restart its syslog service first.

To *prevent* it, stop the host from emitting that ICMP to the sender:

```bash
iptables -I OUTPUT -p icmp --icmp-type port-unreachable -d <SENDER_IP> -j DROP
```

`port-unreachable` is only ICMP type 3 code 3, so path-MTU discovery is
untouched; drop the `-d` to cover every connected-UDP sender. But a raw rule
does not survive a reboot - the exact trigger - so make it persistent. The
most reliable way across distros (and it coexists with Docker, since it only
touches the OUTPUT chain) is a tiny systemd unit that re-adds it once
networking is up:

```ini
# /etc/systemd/system/syslog-icmp-guard.service
[Unit]
Description=Suppress ICMP port-unreachable to syslog senders (survives reboots)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C OUTPUT -p icmp --icmp-type port-unreachable -d <SENDER_IP> -j DROP 2>/dev/null || iptables -A OUTPUT -p icmp --icmp-type port-unreachable -d <SENDER_IP> -j DROP'
ExecStop=/sbin/iptables -D OUTPUT -p icmp --icmp-type port-unreachable -d <SENDER_IP> -j DROP

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now syslog-icmp-guard.service`. (Debian/Ubuntu
can instead `apt install iptables-persistent` + `netfilter-persistent save`;
the RHEL/Rocky `firewall-cmd --permanent --direct` equivalent works ONLY if
firewalld is actually running - the systemd unit above does not care either
way.)

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
| `sev:err` or `sev:3` | that syslog severity; also `sev:<=3` (err and worse), `sev:>=4`, and strict `sev:<3` / `sev:>4`. `severity:` works too |
| `fac:daemon` or `fac:16` | that syslog facility (names: kern...local7); `facility:` works too |
| `proto:syslog` / `proto:trap` | one protocol only |
| `after:2026-07-01` / `before:2026-07-18T14:30` | receive-time bounds (local time); `since:` / `until:` are aliases |
| `-token` | negate anything above: `-app:cron`, `-"noise phrase"` |

Severity names: `emerg alert crit err warning notice debug` plus the
synonyms `panic critical error warn informational`. Traps
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
| `TLS_CERT` / `TLS_KEY` | `$DATA/certs/server.crt` / `.key` | PEM cert/key pair; HTTPS turns on when both exist |
| `TRUST_PROXY` | - | `1` = honor `X-Forwarded-For` for the login limiter. Only set this when the app's own port is unreachable except through your proxy: the header is trusted on **every** connection, so a client that can reach the port directly can forge it and evade the limiter |
| `ADMIN_PASSWORD` | - | Pre-set the UI password (otherwise first-run setup page) |
| `SUITE_SECRET` | - | Opt-in suite single sign-on: accept signed login tokens from the [LaunchCanvas](https://github.com/RootSwitch/LaunchCanvas) portal (same value across the suite; see its README for the security model) |
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
  logs they are. On a multi-user host the database is only as protected as
  the directory holding it, which is why the quick start ends in
  `chmod 750 data`.
- The web UI has one shared password and is designed for a trusted network
  segment; a reverse proxy adds TLS termination and extra auth cleanly if
  you want to go further. The first-run setup page belongs to whoever
  reaches it first - claim it promptly or pre-set `ADMIN_PASSWORD`. (In an
  SSO suite this is closed automatically: with `SUITE_SECRET` set, the
  setup page can only be completed by someone already signed in through
  LaunchCanvas, so a stray direct visitor can't claim the account.)
- With `SUITE_SECRET` set, a signed token minted by the
  [LaunchCanvas](https://github.com/RootSwitch/LaunchCanvas) portal also
  signs you in (verified per request, no local session minted). Anyone
  holding that secret can mint valid tokens, so treat it like the other
  suite secrets; the LaunchCanvas README documents the full model,
  including revocation and the host-wide cookie caveat. Unset, the token
  path is inert.
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
node tools/seed-demo.js  # or a whole fictional homelab: ~120k rows over 90
                         # days, incl. a UPS power-event story (sev:<=4)
```

No build step: edit, refresh. The frontend is static files served as-is;
the server restarts in under a second.

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
| `tools/seed-demo.js` | Synthetic demo fleet for screenshots and UI work (`--rows N` to scale) |

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
SNMPCanvas, AlertCanvas, and LaunchCanvas. Use it, fork it, ship it at work, no attribution required.
(Dependencies keep their own MIT licenses in `node_modules/` when you
install or ship an image.)
