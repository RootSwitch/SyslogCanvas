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
performance history, and SyslogCanvas remembers what your devices said -
the piece you reach for after an outage, not during one.

The family's small-footprint ethos carries over: one container, one SQLite
file, two runtime dependencies, and a frontend that is plain HTML/CSS/JS
with no build step.

## How it works

```
your devices ──syslog (UDP/514)──────► SyslogCanvas ──► SQLite ──► web UI
              ──SNMP traps (UDP/162)──►      │                      │
                 (v1/v2c)                    └── retention prune    └── CSV export
```

One Node process does everything: two UDP listeners parse what arrives
(RFC 3164 and RFC 5424 syslog, v1/v2c traps and informs), batched writes
land the rows in SQLite, and the same process serves the UI. Nothing is ever
dropped for being malformed - a line that doesn't parse is stored whole with
whatever fields did.

## Features

- **One message table** - syslog and traps side by side, newest first,
  live-tailing while you watch. Time, source IP, severity badge, host, app
  (or trap OID), and the message; click a row for the full detail including
  the raw datagram or decoded varbinds.
- **Server-side filtering** - a single filter box that searches text or
  narrows by field, over the whole retained history rather than just the
  rows on screen (syntax below).
- **CSV export** - one click exports whatever the current filter matches
  (up to 100,000 rows), quoted properly and safe to open in a spreadsheet.
- **Retention you control** - keep N days (default 90, pruned nightly at
  03:30) *and* a hard row cap (default 500,000) as a safety valve, so a
  misbehaving device can't balloon the database inside the window. Both are
  in Settings.
- **Best-effort parsing, zero configuration** - PRI, timestamp, hostname,
  and tag are extracted when present; traps get their varbinds rendered into
  a readable line so plain-text search covers them too.
- **Single shared password** for the UI (scrypt-hashed), sessions, login
  rate limiting, automatic HTTPS when a certificate exists, and one-click
  database backups from the Settings page.
- **29 themes** carried over from CrossCanvas's palette family, grouped the
  same way (Paper / Warm / Cool / Night / Screen).

## Small on purpose

SyslogCanvas is intentionally a store of messages with a clear window onto
it: receive, keep, filter, export. Alerting, forwarding, parsing rules,
dashboards, and correlation aren't on the roadmap - those are jobs for
bigger tools (and if you need them, you probably want one). This exists for
the homelab middle ground where Graylog is overkill but "the switch doesn't
remember its own logs after a reboot" keeps stinging. Set it up, forget it,
and it's there with the history when something breaks. If you want it to
become something bigger, the license makes forking genuinely easy.

Two honest limits worth knowing: syslog and traps over UDP are fire-and-
forget - a datagram lost on the wire is lost, which is fine for
troubleshooting history and wrong for compliance logging. And SNMPv3 traps
are not supported; v1/v2c covers nearly all homelab gear.

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
the container `cap_add: [NET_BIND_SERVICE]` and set `SYSLOG_PORT=514` /
`TRAP_PORT=162`.

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
server detects the pair at startup and switches to HTTPS on the same port.
To use a real certificate, drop your own PEM pair at those paths instead.

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

Severity names: `emerg alert crit err warning notice info debug`. Traps have
no syslog severity - filter them with `proto:trap` and text.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `9514` | Web UI port (HTTP, or HTTPS when a cert exists) |
| `SYSLOG_PORT` | `5514` | UDP port the syslog listener binds in-container |
| `TRAP_PORT` | `5162` | UDP port the trap receiver binds in-container |
| `SYSLOGCANVAS_DATA` | `/data` (image) | Data directory: SQLite DB + `certs/` |
| `TZ` | - | Timezone for the 03:30 nightly prune and log timestamps |
| `ADMIN_PASSWORD` | - | Pre-seed the admin password on first boot |
| `TLS_CERT` / `TLS_KEY` | `<data>/certs/server.crt|key` | Explicit certificate paths |
| `COOKIE_SECURE` | auto | `1` forces the Secure cookie flag (auto-on under HTTPS) |

Retention (days and row cap) lives in the UI under Settings, not env vars.

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

## Development

```
npm install
npm start          # http://localhost:9514, data in ./data
```

No build step: edit, refresh. The frontend is three static files; the server
restarts in under a second.

## License

Public domain under the [Unlicense](LICENSE) - use it, fork it, sell it,
rename it. Attribution appreciated, never required.
