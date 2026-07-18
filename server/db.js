'use strict';
// SQLite via better-sqlite3: one connection shared by the web handlers and the
// ingest pipeline (same process, synchronous library - no cross-connection
// contention). WAL keeps web reads unblocked during ingest writes.

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.SYSLOGCANVAS_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'syslogcanvas.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per received datagram, syslog and traps alike. \`ts\` is receive
-- time (authoritative for ordering/retention); \`msg_ts\` is the timestamp the
-- device claimed, when one parsed. \`msg\` is always a human-readable rendering
-- so text filtering covers both protocols the same way; \`raw\` preserves the
-- original (full syslog datagram, or JSON varbinds for traps).
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL,
  msg_ts    INTEGER,
  source_ip TEXT NOT NULL,
  proto     TEXT NOT NULL CHECK (proto IN ('syslog','trap')),
  facility  INTEGER,
  severity  INTEGER,
  host      TEXT,
  app       TEXT,
  msg       TEXT NOT NULL,
  raw       TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_src_ts ON messages(source_ip, ts);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_ts INTEGER NOT NULL,
  expires_ts INTEGER NOT NULL
);
`);

// --- lightweight migrations for databases created by earlier versions ---
// (none yet - the PRAGMA table_info / ALTER TABLE idiom goes here when the
// schema grows a column)

// --- settings ---
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

const DEFAULTS = {
    retention_days: '90',
    max_rows: '500000'
};

function getSetting(key) {
    const row = getSettingStmt.get(key);
    return row ? row.value : (DEFAULTS[key] !== undefined ? String(DEFAULTS[key]) : null);
}
function setSetting(key, value) { setSettingStmt.run(key, String(value)); }

module.exports = { db, DATA_DIR, getSetting, setSetting };
