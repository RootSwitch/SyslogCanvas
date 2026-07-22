'use strict';
// All /api/* handlers. Routes are (method, regex) pairs dispatched by
// server.js; bodies are JSON in and JSON out. Mutating routes require
// Content-Type: application/json (cross-site forms can't send it - CSRF belt
// on top of the SameSite=Lax cookie).

const fs = require('node:fs');
const path = require('node:path');
const { db, getSetting, setSetting, DATA_DIR } = require('./db');
const auth = require('./auth');
const filter = require('./filter');
const store = require('./store');
const syslog = require('./syslog');
const traps = require('./traps');

// --- tiny helpers ---
function json(res, status, body) {
    const buf = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
    // Truthy so handle()'s early exits (auth 401, 415, body errors) read as
    // "handled" - the server's 404 fallback must never double-write a reply.
    return true;
}
const ok = (res, body = { ok: true }) => json(res, 200, body);
const bad = (res, msg) => json(res, 400, { error: msg });
const notFound = (res) => json(res, 404, { error: 'not found' });

function clientIp(req) {
    // Behind the reverse proxy the README recommends for TLS, every request
    // arrives from the proxy's address - so keying the login limiter on
    // socket.remoteAddress alone would let one attacker's failures lock out
    // everyone. Honor X-Forwarded-For ONLY when the operator asserts a trusted
    // proxy via TRUST_PROXY=1; otherwise a client could spoof the header to
    // evade the limiter or lock out an arbitrary IP. Take the first hop (the
    // original client) that a trusted proxy prepends.
    if (process.env.TRUST_PROXY === '1') {
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
            const first = String(xff).split(',')[0].trim();
            if (first) { return first; }
        }
    }
    return req.socket.remoteAddress || 'unknown';
}

function messageSummary(r) {
    return {
        id: r.id, ts: r.ts, msgTs: r.msg_ts, sourceIp: r.source_ip, proto: r.proto,
        facility: r.facility, severity: r.severity, host: r.host, app: r.app, msg: r.msg
    };
}

// One CSV cell: always quoted, embedded quotes doubled, and a leading
// apostrophe on anything a spreadsheet would execute as a formula.
function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    // A leading TAB or CR is stripped by some spreadsheet parsers before the
    // formula check, so guard those too - the msg/host/app fields here come
    // straight off the wire and are fully attacker-controlled.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""').replace(/\r/g, '') + '"';
}

const EXPORT_MAX_ROWS = 100000;

// --- route table ---
// handler(req, res, params, body, query). `authRequired: false` routes are public.
const routes = [
    { method: 'GET', path: /^\/api\/health$/, authRequired: false, handler: (req, res) => ok(res, { ok: true, version: require('../package.json').version }) },

    { method: 'GET', path: /^\/api\/session$/, authRequired: false, handler: (req, res) => {
        const authed = auth.authenticate(req, res);
        ok(res, { authenticated: authed, needsSetup: !auth.passwordIsSet() });
    } },

    { method: 'POST', path: /^\/api\/setup$/, authRequired: false, handler: (req, res, p, body) => {
        if (auth.passwordIsSet()) return json(res, 409, { error: 'already configured' });
        if (!body.password || String(body.password).length < 8) return bad(res, 'Password must be at least 8 characters.');
        auth.setPassword(String(body.password));
        const token = auth.createSession();
        res.setHeader('Set-Cookie', auth.sessionCookie(token));
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/login$/, authRequired: false, handler: (req, res, p, body) => {
        const ip = clientIp(req);
        if (!auth.loginAllowed(ip)) return json(res, 429, { error: 'Too many attempts - wait a minute.' });
        if (!auth.checkPassword(String(body.password || ''))) {
            auth.recordLoginFailure(ip);
            return json(res, 401, { error: 'Wrong password.' });
        }
        auth.recordLoginSuccess(ip);
        const token = auth.createSession();
        res.setHeader('Set-Cookie', auth.sessionCookie(token));
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/logout$/, authRequired: false, handler: (req, res) => {
        auth.destroySession(auth.tokenFromRequest(req));
        res.setHeader('Set-Cookie', auth.clearCookie());
        ok(res);
    } },

    // The message list: newest first, server-side filtered (the table is a
    // window onto up to max_rows rows - client-side filtering can't work),
    // cursor-paged on (ts, id) so "Load more" is stable while new rows land.
    { method: 'GET', path: /^\/api\/messages$/, handler: (req, res, p, body, query) => {
        const limit = Math.min(1000, Math.max(1, parseInt(query.get('limit'), 10) || 200));
        const where = filter.buildWhere(query.get('q'));
        const conds = where.sql ? [where.sql] : [];
        const params = [...where.params];
        const beforeTs = parseInt(query.get('before_ts'), 10);
        const beforeId = parseInt(query.get('before_id'), 10);
        if (!Number.isNaN(beforeTs) && !Number.isNaN(beforeId)) {
            conds.push('(ts < ? OR (ts = ? AND id < ?))');
            params.push(beforeTs, beforeTs, beforeId);
        }
        const sql = `SELECT id, ts, msg_ts, source_ip, proto, facility, severity, host, app, msg
                     FROM messages ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
                     ORDER BY ts DESC, id DESC LIMIT ?`;
        const rows = db.prepare(sql).all(...params, limit + 1);
        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        ok(res, { messages: rows.map(messageSummary), hasMore });
    } },

    { method: 'GET', path: /^\/api\/messages\/(\d+)$/, handler: (req, res, p) => {
        const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(p[0]);
        if (!r) return notFound(res);
        ok(res, { message: { ...messageSummary(r), raw: r.raw } });
    } },

    // CSV of the current filter, streamed. Same WHERE builder as the list so
    // what you see is what you export (capped at EXPORT_MAX_ROWS).
    { method: 'GET', path: /^\/api\/export\.csv$/, handler: async (req, res, p, body, query) => {
        const where = filter.buildWhere(query.get('q'));
        const sql = `SELECT ts, source_ip, proto, facility, severity, host, app, msg
                     FROM messages ${where.sql ? 'WHERE ' + where.sql : ''}
                     ORDER BY ts DESC, id DESC LIMIT ?`;
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="syslogcanvas-${stamp}.csv"`,
            'Cache-Control': 'no-store'
        });
        res.write('time,source_ip,proto,facility,severity,host,app,message\r\n');
        const drain = () => new Promise((resolve) => res.once('drain', resolve));
        let chunk = '';
        for (const r of db.prepare(sql).iterate(...where.params, EXPORT_MAX_ROWS)) {
            chunk += [
                csvCell(new Date(r.ts * 1000).toISOString()),
                csvCell(r.source_ip), csvCell(r.proto), csvCell(r.facility), csvCell(r.severity),
                csvCell(r.host), csvCell(r.app), csvCell(r.msg)
            ].join(',') + '\r\n';
            if (chunk.length >= 64 * 1024) {
                const keepGoing = res.write(chunk);
                chunk = '';
                if (!keepGoing) await drain(); // respect backpressure on big exports
                if (res.destroyed) return;      // client went away - stop reading
            }
        }
        res.end(chunk);
    } },

    { method: 'GET', path: /^\/api\/stats$/, handler: (req, res) => {
        const agg = db.prepare('SELECT count(*) AS n, min(ts) AS oldest, max(ts) AS newest FROM messages').get();
        const topSources = db.prepare(
            'SELECT source_ip AS sourceIp, count(*) AS n FROM messages GROUP BY source_ip ORDER BY n DESC LIMIT 10').all();
        let dbBytes = 0;
        for (const suffix of ['', '-wal', '-shm']) {
            try { dbBytes += fs.statSync(path.join(DATA_DIR, 'syslogcanvas.db' + suffix)).size; } catch (_) { /* absent */ }
        }
        ok(res, {
            rowCount: agg.n, oldestTs: agg.oldest, newestTs: agg.newest,
            dbBytes, topSources, ingest: store.stats()
        });
    } },

    { method: 'GET', path: /^\/api\/settings$/, handler: (req, res) => {
        ok(res, {
            retentionDays: parseInt(getSetting('retention_days'), 10),
            maxRows: parseInt(getSetting('max_rows'), 10),
            dataDir: DATA_DIR,
            syslogPort: syslog.PORT,
            trapPort: traps.PORT
        });
    } },

    { method: 'PATCH', path: /^\/api\/settings$/, handler: (req, res, p, body) => {
        if (body.retentionDays !== undefined) {
            const v = parseInt(body.retentionDays, 10);
            if (!v || v < 1) return bad(res, 'Retention must be at least 1 day.');
            setSetting('retention_days', v);
        }
        if (body.maxRows !== undefined) {
            const v = parseInt(body.maxRows, 10);
            if (!v || v < 1000) return bad(res, 'Max rows must be at least 1000.');
            setSetting('max_rows', v);
            setImmediate(store.enforceCap); // a lowered cap bites now, not in a minute
        }
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/settings\/password$/, handler: (req, res, p, body) => {
        if (!auth.checkPassword(String(body.current || ''))) return json(res, 401, { error: 'Current password is wrong.' });
        if (!body.next || String(body.next).length < 8) return bad(res, 'New password must be at least 8 characters.');
        auth.setPassword(String(body.next));
        auth.destroyOtherSessions(auth.tokenFromRequest(req));   // evict any stolen cookie
        ok(res);
    } },

    // Consistent snapshot of the database, streamed as a download.
    { method: 'GET', path: /^\/api\/backup$/, handler: (req, res) => {
        const tmp = path.join(DATA_DIR, `.backup-${Date.now()}.db`);
        db.prepare('VACUUM INTO ?').run(tmp);
        const stamp = new Date().toISOString().slice(0, 10);
        const stat = fs.statSync(tmp);
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': stat.size,
            'Content-Disposition': `attachment; filename="syslogcanvas-${stamp}.db"`,
            'Cache-Control': 'no-store'
        });
        const stream = fs.createReadStream(tmp);
        const cleanup = () => fs.unlink(tmp, () => {});
        stream.on('close', cleanup);
        stream.on('error', cleanup);
        stream.pipe(res);
    } }
];

// Dispatch. Returns false when no /api route matches (server.js then tries static).
async function handle(req, res, pathname, query) {
    for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.path.exec(pathname);
        if (!m) continue;

        if (route.authRequired !== false && !auth.authenticate(req, res)) {
            return json(res, 401, { error: 'authentication required' });
        }

        let body = {};
        if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
            const ct = String(req.headers['content-type'] || '');
            const hasBody = req.headers['content-length'] && req.headers['content-length'] !== '0';
            if (hasBody && !ct.includes('application/json')) return json(res, 415, { error: 'expected application/json' });
            if (hasBody) {
                try {
                    body = await readJson(req);
                } catch (err) {
                    return bad(res, err.message);
                }
            } else if (req.method !== 'DELETE') {
                if (!ct.includes('application/json')) return json(res, 415, { error: 'expected application/json' });
            }
        }
        try {
            await route.handler(req, res, m.slice(1), body, query);
        } catch (err) {
            console.error(new Date().toISOString(), '[api]', req.method, pathname, err);
            if (!res.headersSent) json(res, 500, { error: 'internal error' });
        }
        return true;
    }
    return false;
}

function readJson(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
            catch (_) { reject(new Error('invalid JSON')); }
        });
        req.on('error', reject);
    });
}

module.exports = { handle };
