'use strict';
// Ingest write path: listeners enqueue parsed rows here; a short timer (or a
// full batch) flushes them in one transaction. Keeps write amplification low
// under bursts without making the UDP callbacks wait on SQLite.

const { db, getSetting } = require('./db');

const FLUSH_MS = 300;          // max latency from datagram to database
const FLUSH_ROWS = 200;        // flush early when a burst fills the queue
const QUEUE_MAX = 50000;       // backpressure: beyond this, drop oldest queued
const CAP_CHECK_MS = 60 * 1000;

const insStmt = db.prepare(`
    INSERT INTO messages (ts, msg_ts, source_ip, proto, facility, severity, host, app, msg, raw)
    VALUES (@ts, @msg_ts, @source_ip, @proto, @facility, @severity, @host, @app, @msg, @raw)`);
const insertMany = db.transaction((rows) => {
    for (const r of rows) insStmt.run(r);
});

let queue = [];
let flushTimer = null;
let capTimer = null;
let dropped = 0;        // rows discarded by backpressure since boot
let received = 0;       // rows accepted since boot
let lastDropLog = 0;

function log(...args) { console.log(new Date().toISOString(), '[store]', ...args); }

function enqueue(row) {
    if (queue.length >= QUEUE_MAX) {
        queue.shift();
        dropped++;
        const now = Date.now();
        if (now - lastDropLog > 60000) {
            lastDropLog = now;
            log(`ingest queue full (${QUEUE_MAX}) - dropping oldest; ${dropped} dropped total`);
        }
    }
    queue.push(row);
    received++;
    if (queue.length >= FLUSH_ROWS) {
        flush();
    } else if (!flushTimer) {
        flushTimer = setTimeout(flush, FLUSH_MS);
        flushTimer.unref();
    }
}

function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (queue.length === 0) return;
    const rows = queue;
    queue = [];
    try {
        insertMany(rows);
    } catch (err) {
        // A failed batch is data loss either way; count it and keep serving.
        dropped += rows.length;
        log(`flush of ${rows.length} rows failed: ${err.message}`);
    }
}

// --- row-count cap (the safety valve under the age-based prune) ---
// A misbehaving device can flood far more than retention_days anticipates;
// when the table exceeds max_rows, trim the oldest back to 99% of the cap so
// the trim doesn't run again on every check.
function enforceCap() {
    try {
        const maxRows = parseInt(getSetting('max_rows'), 10) || 500000;
        const count = db.prepare('SELECT count(*) AS n FROM messages').get().n;
        if (count <= maxRows) return;
        const keep = Math.max(1000, Math.floor(maxRows * 0.99));
        const edge = db.prepare('SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET ?').get(keep - 1);
        if (!edge) return;
        const gone = db.prepare('DELETE FROM messages WHERE id < ?').run(edge.id).changes;
        log(`row cap: ${count} > ${maxRows}, removed ${gone} oldest rows`);
    } catch (err) {
        log('row cap check failed:', err.message);
    }
}

function start() {
    capTimer = setInterval(enforceCap, CAP_CHECK_MS);
    capTimer.unref();
    enforceCap(); // a lowered cap should bite on boot, not a minute later
}

function stop() {
    if (capTimer) { clearInterval(capTimer); capTimer = null; }
    flush(); // final synchronous flush before db.close()
}

function stats() { return { received, dropped, queued: queue.length }; }

module.exports = { enqueue, flush, enforceCap, start, stop, stats };
