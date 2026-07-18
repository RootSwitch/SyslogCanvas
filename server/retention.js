'use strict';
// Age-based retention, in the family's poller idiom: a light 5s tick fires
// the prune once a day at 03:30 local (guarded by settings.last_prune_day).
// The row-count cap in store.js is the fast safety valve; this is the
// "history older than N days goes away" promise.

const { db, getSetting } = require('./db');
const auth = require('./auth');

const CHUNK = 5000; // rows per DELETE, yielding the event loop between chunks

let timer = null;

function log(...args) { console.log(new Date().toISOString(), '[retention]', ...args); }

function maybePrune() {
    const now = new Date();
    if (now.getHours() !== 3 || now.getMinutes() < 30) return;
    const today = now.toISOString().slice(0, 10);
    if (getSetting('last_prune_day') === today) return;
    db.prepare("INSERT INTO settings (key, value) VALUES ('last_prune_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
    setImmediate(prune);
}

function prune() {
    try {
        const retentionDays = parseInt(getSetting('retention_days'), 10) || 90;
        const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
        const del = db.prepare(`DELETE FROM messages WHERE id IN
            (SELECT id FROM messages WHERE ts < ? ORDER BY ts LIMIT ?)`);
        let total = 0;
        const step = () => {
            const changes = del.run(cutoff, CHUNK).changes;
            total += changes;
            if (changes === CHUNK) {
                setImmediate(step); // yield between chunks so ingest/UI stay live
                return;
            }
            db.pragma('wal_checkpoint(TRUNCATE)');
            auth.pruneSessions();
            log(`prune finished: ${total} messages older than ${retentionDays}d removed`);
        };
        step();
    } catch (err) {
        log('prune failed:', err.message);
    }
}

function start() {
    timer = setInterval(maybePrune, 5000);
    timer.unref();
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, prune };
