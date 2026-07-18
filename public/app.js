'use strict';
// SyslogCanvas frontend: hash-routed views over the JSON API. Vanilla DOM, no
// framework, no build step - the file you read is the file that runs.

(function () {
    const $main = document.getElementById('main');
    const $modal = document.getElementById('modal');
    const $nav = document.getElementById('nav');
    const $logout = document.getElementById('logout-btn');

    let refreshTimer = null;

    // ===== helpers =====
    function esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function api(method, path, body) {
        const opts = { method, headers: {} };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(path, opts);
        if (res.status === 401 && !path.startsWith('/api/session') && !path.startsWith('/api/login')) {
            renderLogin(false);
            throw new Error('authentication required');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || `${res.status}`);
            err.status = res.status;
            throw err;
        }
        return data;
    }
    const GET = (p) => api('GET', p);

    const SEV = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug'];
    const FAC = ['kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
        'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock',
        'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'];

    const pad = (n) => String(n).padStart(2, '0');
    function fmtTime(ts) {
        if (!ts) return '-';
        const d = new Date(ts * 1000);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
               `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    function fmtAgo(ts) {
        if (!ts) return 'never';
        const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
        return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 48 * 3600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
    }
    function fmtBytes(n) {
        if (n == null) return '-';
        if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GiB';
        if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MiB';
        if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
        return n + ' B';
    }

    function sevBadge(m) {
        if (m.proto === 'trap') return '<span class="badge proto-trap">trap</span>';
        if (m.severity == null) return '<span class="badge">-</span>';
        return `<span class="badge sev-${m.severity}">${SEV[m.severity] || m.severity}</span>`;
    }

    function setAutoRefresh(fn, ms) {
        clearInterval(refreshTimer);
        refreshTimer = fn ? setInterval(fn, ms) : null;
    }

    function setNav(active, visible) {
        $nav.style.display = visible ? '' : 'none';
        $logout.style.display = visible ? '' : 'none';
        for (const a of $nav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.nav === active);
    }

    // ===== theme picker (grouped like CrossCanvas's - ungrouped Classic
    // first, then an <optgroup> per vibe, in themes.js authoring order) =====
    const $theme = document.getElementById('theme-select');
    let optgroup = null;
    for (const [key, t] of Object.entries(Themes.THEMES)) {
        const o = document.createElement('option');
        o.value = key; o.textContent = t.label;
        if (!t.group) {
            $theme.appendChild(o);
        } else {
            if (!optgroup || optgroup.label !== t.group) {
                optgroup = document.createElement('optgroup');
                optgroup.label = t.group;
                $theme.appendChild(optgroup);
            }
            optgroup.appendChild(o);
        }
    }
    $theme.value = Themes.currentTheme();
    $theme.addEventListener('change', () => Themes.applyTheme($theme.value));

    $logout.addEventListener('click', async () => {
        await api('POST', '/api/logout', {});
        location.hash = '#/messages';
        route();
    });

    // ===== router =====
    window.addEventListener('hashchange', route);

    async function route() {
        setAutoRefresh(null);
        const session = await GET('/api/session');
        if (!session.authenticated) { renderLogin(session.needsSetup); return; }

        const hash = location.hash || '#/messages';
        if (hash.startsWith('#/settings')) return renderSettings();
        return renderMessages();
    }

    // ===== login / first-run =====
    function renderLogin(needsSetup) {
        setNav(null, false);
        setAutoRefresh(null);
        $main.innerHTML = `
        <div class="login-wrap"><div class="login-card">
            <h1><svg width="20" height="20" viewBox="0 0 64 64" fill="none" stroke="var(--se-accent)">
                <path d="M32 5 L32 12" stroke-width="5" stroke-linecap="round"/>
                <path d="M18 45 L12 59 M46 45 L52 59 M32 45 L32 59" stroke-width="5" stroke-linecap="round"/>
                <rect x="9" y="12" width="46" height="34" rx="3" fill="#f4f1ea" stroke-width="4"/>
                <path d="M14 20 H44" stroke="var(--se-logo-a)" stroke-width="4" stroke-linecap="round"/>
                <path d="M14 27 H36" stroke="var(--se-logo-a)" stroke-width="4" stroke-linecap="round"/>
                <path d="M14 34 H48" stroke="var(--se-logo-b)" stroke-width="4" stroke-linecap="round"/>
                <path d="M14 41 H30" stroke="var(--se-logo-a)" stroke-width="4" stroke-linecap="round"/>
            </svg> SyslogCanvas</h1>
            <div class="sub">${needsSetup ? 'First run - choose an admin password (8+ characters).' : 'Enter the password to continue.'}</div>
            <form id="login-form">
                <input type="password" id="pw" placeholder="Password" autofocus autocomplete="${needsSetup ? 'new-password' : 'current-password'}">
                ${needsSetup ? '<input type="password" id="pw2" placeholder="Confirm password" autocomplete="new-password">' : ''}
                <button class="btn-primary" type="submit">${needsSetup ? 'Set password' : 'Log in'}</button>
                <div class="error-text" id="login-err" style="margin-top:8px"></div>
            </form>
        </div></div>`;
        document.getElementById('login-form').addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const pw = document.getElementById('pw').value;
            const err = document.getElementById('login-err');
            try {
                if (needsSetup) {
                    if (pw !== document.getElementById('pw2').value) { err.textContent = 'Passwords do not match.'; return; }
                    await api('POST', '/api/setup', { password: pw });
                } else {
                    await api('POST', '/api/login', { password: pw });
                }
                location.hash = '#/messages';
                route();
            } catch (e) { err.textContent = e.message; }
        });
    }

    // ===== messages =====
    // The filter survives navigation and auto-refresh: it IS the tool.
    let msgFilter = '';
    let msgRows = [];
    let msgHasMore = false;
    let fetchSeq = 0;      // discards out-of-order responses from fast typing
    let msgPage = 1;       // 1-based; any page but 1 pauses the live tail
    let msgCursors = [null]; // msgCursors[i] is the (ts,id) cursor that fetches page i+1

    // Rows-per-page and refresh cadence are personal taste - persisted like
    // the theme. Paused (0) freezes the view for reading through an incident.
    const PAGE_SIZES = [25, 50, 100, 200];
    const REFRESH_CHOICES = [[0, 'Paused'], [2000, '2s'], [5000, '5s'], [15000, '15s'], [60000, '60s']];

    function lsGet(key, dflt, valid) {
        try {
            const v = parseInt(localStorage.getItem(key), 10);
            return valid.includes(v) ? v : dflt;
        } catch (_) { return dflt; }
    }
    function lsSet(key, v) {
        try { localStorage.setItem(key, String(v)); } catch (_) { /* private mode */ }
    }
    const pageSize = () => lsGet('syslogcanvas-pagesize', 50, PAGE_SIZES);
    const refreshMs = () => lsGet('syslogcanvas-refresh', 5000, REFRESH_CHOICES.map((c) => c[0]));

    function messagesUrl(cursor) {
        let url = `/api/messages?limit=${pageSize()}&q=${encodeURIComponent(msgFilter)}`;
        if (cursor) url += `&before_ts=${cursor.ts}&before_id=${cursor.id}`;
        return url;
    }

    function rowHtml(m) {
        return `<tr class="rowlink" data-id="${m.id}">
            <td class="nowrap muted" title="${esc(fmtAgo(m.ts))}${m.msgTs && Math.abs(m.msgTs - m.ts) > 60 ? ' · device time ' + esc(fmtTime(m.msgTs)) : ''}">${fmtTime(m.ts)}</td>
            <td class="nowrap">${esc(m.sourceIp)}</td>
            <td>${sevBadge(m)}</td>
            <td class="cell-ellipsis hide-sm" title="${esc(m.host ?? '')}">${esc(m.host ?? '')}</td>
            <td class="cell-ellipsis hide-sm muted" title="${esc(m.app ?? '')}">${esc(m.app ?? '')}</td>
            <td class="msg-cell">${esc(m.msg.length > 500 ? m.msg.slice(0, 500) + '…' : m.msg)}</td>
        </tr>`;
    }

    function renderMessageRows() {
        const body = document.getElementById('msg-body');
        const count = document.getElementById('msg-count');
        if (!body) return;
        body.innerHTML = msgRows.length === 0
            ? `<tr><td colspan="6" class="muted" style="padding:18px 8px">${msgFilter ? 'Nothing matches this filter.' : "No messages yet - point your devices' syslog and SNMP trap targets at this host."}</td></tr>`
            : msgRows.map(rowHtml).join('');
        const from = (msgPage - 1) * pageSize() + 1;
        count.textContent = msgRows.length === 0
            ? (msgPage > 1 ? `page ${msgPage} is empty` : '0 messages')
            : `${from}-${from + msgRows.length - 1}${msgHasMore ? ' of more' : ''}` +
              (msgPage > 1 || refreshMs() === 0 ? ' · tail paused' : '');
        for (const tr of body.querySelectorAll('tr.rowlink')) {
            tr.addEventListener('click', () => showMessageDetail(tr.dataset.id));
        }
        const pageInfo = document.getElementById('msg-pageinfo');
        if (pageInfo) pageInfo.textContent = `page ${msgPage}`;
        const newest = document.getElementById('msg-newest');
        const newer = document.getElementById('msg-newer');
        const older = document.getElementById('msg-older');
        if (newest) newest.disabled = msgPage === 1;
        if (newer) newer.disabled = msgPage === 1;
        if (older) older.disabled = !msgHasMore;
    }

    async function loadMessages() {
        const seq = ++fetchSeq;
        let data;
        try {
            data = await GET(messagesUrl(msgCursors[msgPage - 1]));
        } catch (e) {
            const err = document.getElementById('msg-err');
            if (err) err.textContent = e.message;
            return;
        }
        if (seq !== fetchSeq) return; // a newer request already landed
        const err = document.getElementById('msg-err');
        if (err) err.textContent = '';
        msgRows = data.messages;
        msgHasMore = data.hasMore;
        // Remember where the next-older page starts. Cursors are (ts,id) of
        // the last row seen, so they stay valid while new rows pour in above.
        if (msgRows.length) {
            const last = msgRows[msgRows.length - 1];
            msgCursors[msgPage] = { ts: last.ts, id: last.id };
        }
        renderMessageRows();
    }

    function gotoPage(page) {
        msgPage = Math.max(1, page);
        if (msgPage === 1) msgCursors = [null]; // back to the live edge, fresh cursors
        loadMessages();
    }

    async function showMessageDetail(id) {
        let m;
        try {
            m = (await GET(`/api/messages/${id}`)).message;
        } catch (e) { return; }
        const facSev = m.proto === 'syslog' && m.severity != null
            ? `${FAC[m.facility] ?? m.facility ?? '?'}.${SEV[m.severity] ?? m.severity}`
            : null;
        let rawBlock = m.raw || '';
        if (m.proto === 'trap' && rawBlock) {
            try { rawBlock = JSON.stringify(JSON.parse(rawBlock), null, 2); } catch (_) { /* leave as-is */ }
        }
        $modal.innerHTML = `
        <h2>${m.proto === 'trap' ? 'SNMP trap' : 'Syslog message'} <span class="muted small">#${esc(m.id)}</span></h2>
        <dl class="detail-grid">
            <dt>Received</dt><dd>${fmtTime(m.ts)} <span class="muted">(${esc(fmtAgo(m.ts))})</span></dd>
            ${m.msgTs ? `<dt>Device time</dt><dd>${fmtTime(m.msgTs)}</dd>` : ''}
            <dt>Source IP</dt><dd>${esc(m.sourceIp)}</dd>
            ${m.host ? `<dt>Host</dt><dd>${esc(m.host)}</dd>` : ''}
            ${m.app ? `<dt>${m.proto === 'trap' ? 'Trap OID' : 'App'}</dt><dd>${esc(m.app)}</dd>` : ''}
            ${facSev ? `<dt>Facility.severity</dt><dd>${sevBadge(m)} ${esc(facSev)}</dd>` : ''}
        </dl>
        <pre class="raw-block">${esc(m.msg)}</pre>
        ${rawBlock && rawBlock !== m.msg ? `
        <div class="muted small" style="margin:10px 0 4px">${m.proto === 'trap' ? 'Varbinds (as received)' : 'Raw datagram'}</div>
        <pre class="raw-block">${esc(rawBlock)}</pre>` : ''}
        <div class="form-actions">
            <button id="d-filter-ip">Filter this source</button>
            <button id="d-close">Close</button>
        </div>`;
        $modal.showModal();
        document.getElementById('d-close').addEventListener('click', () => $modal.close());
        document.getElementById('d-filter-ip').addEventListener('click', () => {
            $modal.close();
            const input = document.getElementById('msg-filter');
            msgFilter = `ip:${m.sourceIp}`;
            if (input) input.value = msgFilter;
            gotoPage(1);
        });
    }

    // A tab that was hidden (polling paused) catches up the moment it's back
    // - unless the user paused the tail or paged into history on purpose.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || msgPage !== 1 || refreshMs() === 0 || $modal.open) return;
        if (document.getElementById('msg-body')) loadMessages();
    });

    function armAutoRefresh() {
        const ms = refreshMs();
        if (ms === 0) { setAutoRefresh(null); return; }
        // Live tail: page 1 refreshes quietly unless the user has paged into
        // history, is mid-detail, or the tab is hidden.
        setAutoRefresh(() => {
            if (document.visibilityState !== 'visible') return;
            if (msgPage !== 1 || $modal.open) return;
            if (!location.hash || location.hash.startsWith('#/messages')) loadMessages();
        }, ms);
    }

    function renderMessages() {
        setNav('messages', true);
        $main.innerHTML = `
        <div class="page-head">
            <h1>Messages</h1>
            <span class="sub" id="msg-count"></span>
            <span class="spacer"></span>
            <span class="error-text" id="msg-err"></span>
            <button id="msg-export">Export CSV</button>
        </div>
        <div class="filter-bar">
            <input type="search" id="msg-filter" spellcheck="false"
                placeholder='Filter: text, "quoted phrase", ip: host: app: sev: fac: proto: after: before:, -negate'
                value="${esc(msgFilter)}">
            <select id="msg-pagesize" title="Rows per page">
                ${PAGE_SIZES.map((n) => `<option value="${n}" ${n === pageSize() ? 'selected' : ''}>${n} / page</option>`).join('')}
            </select>
            <select id="msg-refresh" title="How often the newest page refreshes - Paused freezes it for reading">
                ${REFRESH_CHOICES.map(([ms, label]) => `<option value="${ms}" ${ms === refreshMs() ? 'selected' : ''}>${ms === 0 ? label : 'Refresh ' + label}</option>`).join('')}
            </select>
        </div>
        <div class="panel">
            <table class="list"><thead><tr>
                <th style="width:150px">Time</th>
                <th style="width:120px">Source</th>
                <th style="width:70px">Sev</th>
                <th class="hide-sm" style="width:130px">Host</th>
                <th class="hide-sm" style="width:110px">App</th>
                <th>Message</th>
            </tr></thead><tbody id="msg-body"></tbody></table>
            <div class="form-actions">
                <button id="msg-newest" disabled>⇤ Newest</button>
                <button id="msg-newer" disabled>← Newer</button>
                <span class="muted small" id="msg-pageinfo"></span>
                <button id="msg-older" disabled>Older →</button>
            </div>
        </div>`;

        const input = document.getElementById('msg-filter');
        let debounce = null;
        input.addEventListener('input', () => {
            msgFilter = input.value;
            clearTimeout(debounce);
            debounce = setTimeout(() => gotoPage(1), 300);
        });
        document.getElementById('msg-export').addEventListener('click', () => {
            location.href = `/api/export.csv?q=${encodeURIComponent(msgFilter)}`;
        });
        document.getElementById('msg-pagesize').addEventListener('change', (ev) => {
            lsSet('syslogcanvas-pagesize', ev.target.value);
            gotoPage(1); // page boundaries moved - restart from the newest edge
        });
        document.getElementById('msg-refresh').addEventListener('change', (ev) => {
            lsSet('syslogcanvas-refresh', ev.target.value);
            armAutoRefresh();
            renderMessageRows(); // update the "tail paused" caption
        });
        document.getElementById('msg-newest').addEventListener('click', () => gotoPage(1));
        document.getElementById('msg-newer').addEventListener('click', () => gotoPage(msgPage - 1));
        document.getElementById('msg-older').addEventListener('click', () => { if (msgHasMore) gotoPage(msgPage + 1); });

        gotoPage(msgPage); // re-entering the view keeps the page you were on
        armAutoRefresh();
    }

    // ===== settings =====
    async function renderSettings() {
        setNav('settings', true);
        let s, st;
        try {
            [s, st] = await Promise.all([GET('/api/settings'), GET('/api/stats')]);
        } catch (e) {
            $main.innerHTML = `<div class="panel error-text">${esc(e.message)}</div>`;
            return;
        }
        $main.innerHTML = `
        <div class="page-head"><h1>Settings</h1></div>
        <div class="panel">
            <h2>Retention</h2>
            <div class="muted small" style="margin-bottom:8px">
                Messages older than the retention window are pruned nightly at 03:30.
                The row cap is the safety valve for log floods: when the table grows past it,
                the oldest rows are trimmed within a minute.</div>
            <div class="form-grid">
                <label>Keep history for</label>
                <span><input type="number" id="s-retention" value="${s.retentionDays}" min="1" style="width:110px"> days</span>
                <label>Row cap</label>
                <span><input type="number" id="s-maxrows" value="${s.maxRows}" min="1000" step="1000" style="width:130px"> messages</span>
            </div>
            <div class="form-actions">
                <button class="btn-primary" id="s-save">Save settings</button>
                <span id="s-msg"></span>
            </div>
        </div>
        <div class="panel">
            <h2>Database</h2>
            <table class="list" style="max-width:560px"><tbody>
                <tr><td class="muted">Stored messages</td><td class="num">${st.rowCount.toLocaleString()}</td></tr>
                <tr><td class="muted">Database size</td><td class="num">${fmtBytes(st.dbBytes)}</td></tr>
                <tr><td class="muted">Oldest message</td><td class="num">${st.oldestTs ? fmtTime(st.oldestTs) : '-'}</td></tr>
                <tr><td class="muted">Newest message</td><td class="num">${st.newestTs ? fmtTime(st.newestTs) : '-'}</td></tr>
                <tr><td class="muted">Received since start</td><td class="num">${st.ingest.received.toLocaleString()}${st.ingest.dropped ? ` <span class="error-text">(${st.ingest.dropped.toLocaleString()} dropped)</span>` : ''}</td></tr>
            </tbody></table>
            ${st.topSources.length ? `
            <h2 style="margin-top:14px">Top sources</h2>
            <table class="list" style="max-width:560px"><thead><tr><th>Source IP</th><th class="num">Messages</th></tr></thead><tbody>
                ${st.topSources.map((t) => `<tr><td>${esc(t.sourceIp)}</td><td class="num">${t.n.toLocaleString()}</td></tr>`).join('')}
            </tbody></table>` : ''}
        </div>
        <div class="panel">
            <h2>Change password</h2>
            <div class="form-grid">
                <label>Current password</label><input type="password" id="p-cur" autocomplete="current-password">
                <label>New password</label><input type="password" id="p-new" autocomplete="new-password">
                <label>Confirm new</label><input type="password" id="p-new2" autocomplete="new-password">
            </div>
            <div class="form-actions">
                <button id="p-save">Change password</button>
                <span id="p-msg"></span>
            </div>
        </div>
        <div class="panel">
            <h2>Backup</h2>
            <div class="muted small" style="margin-bottom:8px">
                Downloads a consistent snapshot of the whole database - settings and all messages.
                Restore by stopping SyslogCanvas and replacing <code>syslogcanvas.db</code> in the data directory with the snapshot.</div>
            <a class="btn" href="/api/backup" download>Download database backup</a>
        </div>
        <div class="panel muted small">
            Data directory: <code>${esc(s.dataDir)}</code><br>
            Listening: syslog udp/${s.syslogPort} · SNMP traps udp/${s.trapPort} (map host 514/162 to these in docker-compose)
        </div>`;

        document.getElementById('s-save').addEventListener('click', async () => {
            const msg = document.getElementById('s-msg');
            try {
                await api('PATCH', '/api/settings', {
                    retentionDays: parseInt(document.getElementById('s-retention').value, 10),
                    maxRows: parseInt(document.getElementById('s-maxrows').value, 10)
                });
                msg.className = 'ok-text'; msg.textContent = 'Saved.';
            } catch (e) { msg.className = 'error-text'; msg.textContent = e.message; }
        });
        document.getElementById('p-save').addEventListener('click', async () => {
            const msg = document.getElementById('p-msg');
            const next = document.getElementById('p-new').value;
            if (next !== document.getElementById('p-new2').value) {
                msg.className = 'error-text'; msg.textContent = 'New passwords do not match.'; return;
            }
            try {
                await api('POST', '/api/settings/password', { current: document.getElementById('p-cur').value, next });
                msg.className = 'ok-text'; msg.textContent = 'Password changed.';
                for (const id of ['p-cur', 'p-new', 'p-new2']) document.getElementById(id).value = '';
            } catch (e) { msg.className = 'error-text'; msg.textContent = e.message; }
        });
    }

    route();
})();
