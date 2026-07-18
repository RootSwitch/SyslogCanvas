# Changelog

## 0.1.0

Initial release.

- Syslog receiver (UDP), RFC 3164 + RFC 5424 parsing, unparseable lines
  stored whole - nothing is dropped for being malformed.
- SNMP trap receiver (v1 + v2c + informs), any community, varbinds rendered
  into a searchable message line and kept as JSON.
- SQLite storage indexed by receive time and source IP, batched writes.
- Retention by age (default 90 days, nightly prune) and by row cap
  (default 500,000, checked every minute).
- Web UI in the Canvas family style: live-tailing message table,
  server-side filter grammar, per-row detail modal, CSV export of the
  current filter, settings with database stats, 29 themes.
- Single shared password (scrypt), cookie sessions, login rate limiting,
  automatic HTTPS when a certificate is present, database backup download.
- Docker: non-root container, unprivileged in-container ports with host
  mappings for 514/162, healthcheck, single /data volume.
