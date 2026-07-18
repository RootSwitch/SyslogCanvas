'use strict';
// Filter grammar -> parameterized SQL. One builder shared by /api/messages
// and /api/export.csv so the table and the CSV can never disagree about what
// "the current filter" means.
//
// Grammar (documented in the README and the filter box placeholder):
//   plain text            msg/host/app/source_ip contains it (AND across terms)
//   "quoted phrase"       spaces inside one term
//   ip:192.168.1.         source IP starts with it
//   host:sw1  app:sshd    field contains it
//   sev:err  sev:<=3      syslog severity by name/number, optional <= >= < >
//   fac:daemon            syslog facility by name/number
//   proto:syslog|trap     one protocol only
//   after:2026-07-01  before:2026-07-18T14:30   receive-time bounds (local)
//   -token                negate any of the above

const SEVERITIES = {
    emerg: 0, panic: 0, alert: 1, crit: 2, critical: 2, err: 3, error: 3,
    warning: 4, warn: 4, notice: 5, info: 6, informational: 6, debug: 7
};
const FACILITIES = {
    kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, syslog: 5, lpr: 6, news: 7,
    uucp: 8, cron: 9, authpriv: 10, ftp: 11, ntp: 12, audit: 13, alert: 14,
    clock: 15, local0: 16, local1: 17, local2: 18, local3: 19, local4: 20,
    local5: 21, local6: 22, local7: 23
};

// Escape LIKE wildcards in user input; queries use ESCAPE '\'.
function likeEscape(s) {
    return String(s).replace(/([\\%_])/g, '\\$1');
}

// Split on whitespace, honoring double quotes ("link down" is one token) and
// a leading - on either form (-err, -"link down").
function tokenize(q) {
    const tokens = [];
    const re = /(-?)"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(q)) !== null) {
        if (m[2] !== undefined) tokens.push((m[1] || '') + m[2]);
        else tokens.push(m[3]);
    }
    return tokens.filter((t) => t !== '' && t !== '-');
}

// "2026-07-01", "2026-07-01T14:30", "2026-07-01 14:30:00" -> local-time epoch
// seconds, or null when unparseable.
function parseWhen(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s));
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

// sev:<=3 / sev:err / fac:local0 -> { op, value } or null.
function parseLeveled(value, names) {
    const m = /^(<=|>=|<|>)?(.+)$/.exec(value);
    if (!m) return null;
    const op = m[1] || '=';
    const word = m[2].toLowerCase();
    const n = names[word] !== undefined ? names[word] : (/^\d+$/.test(word) ? parseInt(word, 10) : null);
    return n === null ? null : { op, value: n };
}

// One token -> { sql, params } (sql is a single parenthesized condition), or
// null when the token contributes nothing (e.g. malformed date).
function tokenToSql(token) {
    let negate = false;
    if (token.startsWith('-')) { negate = true; token = token.slice(1); }

    let cond = null;
    const colon = token.indexOf(':');
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : null;
    const value = colon > 0 ? token.slice(colon + 1) : null;

    if (key && value !== '') {
        if (key === 'ip') {
            cond = { sql: "source_ip LIKE ? ESCAPE '\\'", params: [likeEscape(value) + '%'] };
        } else if (key === 'host') {
            cond = { sql: "host LIKE ? ESCAPE '\\'", params: ['%' + likeEscape(value) + '%'] };
        } else if (key === 'app') {
            cond = { sql: "app LIKE ? ESCAPE '\\'", params: ['%' + likeEscape(value) + '%'] };
        } else if (key === 'sev' || key === 'severity') {
            const lv = parseLeveled(value, SEVERITIES);
            if (lv) cond = { sql: `severity ${lv.op} ?`, params: [lv.value] };
        } else if (key === 'fac' || key === 'facility') {
            const lv = parseLeveled(value, FACILITIES);
            if (lv) cond = { sql: `facility ${lv.op} ?`, params: [lv.value] };
        } else if (key === 'proto') {
            const v = value.toLowerCase();
            if (v === 'syslog' || v === 'trap') cond = { sql: 'proto = ?', params: [v] };
        } else if (key === 'after' || key === 'since') {
            const t = parseWhen(value);
            if (t !== null) cond = { sql: 'ts >= ?', params: [t] };
        } else if (key === 'before' || key === 'until') {
            const t = parseWhen(value);
            if (t !== null) cond = { sql: 'ts < ?', params: [t] };
        }
        // Unknown key: fall through to plain-term matching (forgiving - a
        // token like "12:30:05" is search text, not a filter key).
    }

    if (!cond) {
        const like = '%' + likeEscape(token) + '%';
        cond = {
            sql: "(msg LIKE ? ESCAPE '\\' OR host LIKE ? ESCAPE '\\' OR app LIKE ? ESCAPE '\\' OR source_ip LIKE ? ESCAPE '\\')",
            params: [like, like, like, like]
        };
    }

    // NULL-safe negation: "-app:cron" must keep rows with no app at all
    // (traps, unparsed lines). Bare NOT would drop them - NULL is not TRUE,
    // but NOT NULL is not TRUE either.
    return negate ? { sql: `NOT COALESCE(${cond.sql}, 0)`, params: cond.params } : cond;
}

// Whole filter string -> { sql, params }. sql is '' (no filtering) or a
// conjunction ready to drop after WHERE/AND. Params never get interpolated.
function buildWhere(q) {
    const parts = [];
    const params = [];
    for (const token of tokenize(String(q || ''))) {
        const c = tokenToSql(token);
        if (!c) continue;
        parts.push(c.sql);
        params.push(...c.params);
    }
    return { sql: parts.join(' AND '), params };
}

module.exports = { buildWhere, SEVERITIES, FACILITIES };
