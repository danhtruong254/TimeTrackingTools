# Jira Time Tracking Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web dashboard showing my own Jira Cloud worklogs per month: gaps against a per-weekday target, a per-ticket/project breakdown, and a copyable summary.

**Architecture:** `server.js` is a zero-dependency Node HTTP server that proxies Jira Cloud REST v3. It finds my issues with JQL, fetches their worklogs within a widened date window, filters them exactly in the Jira profile timezone (`toEntries`), and returns a flat list. `index.html` does all aggregation and rendering in the browser. The spec is `docs/superpowers/specs/2026-09-30-jira-time-dashboard-design.md`.

**Tech Stack:** Node.js ≥ 20.6 (built-in `http`, `fetch`, `node:test`, `--env-file`), plain HTML/CSS/JS. No npm dependencies.

---

## Verified Jira API facts (Jira Cloud REST v3)

- `GET /rest/api/3/myself` → `{ accountId, timeZone, ... }`. `timeZone` may be null.
- `POST /rest/api/3/search/jql`, body `{ jql, fields, maxResults, nextPageToken }` → `{ issues: [{ key, fields: { summary, project: { key } } }], nextPageToken? }`. `nextPageToken` is **absent on the last page**.
- `GET /rest/api/3/issue/{key}/worklog?startedAfter=<ms>&startedBefore=<ms>&startAt=<n>&maxResults=<n>` → `{ startAt, maxResults, total, worklogs: [{ author: { accountId }, started, timeSpentSeconds }] }`. `started` looks like `2026-09-30T23:30:00.000+0000` (no colon in the offset).

## File structure

```
TimeTrackingTools/
  server.js       pure helpers, toEntries, Jira client, fetchMonth, HTTP server, startup
  server.test.js  node:test tests for everything in server.js
  index.html      UI (inline CSS + JS)
  .env.example    env var template
  .gitignore      already exists: .env, .superpowers/, node_modules/
```

`server.js` is written as a module. It exports its functions for tests and only starts listening when run directly (`require.main === module`). Sections are laid out in this order: requires/constants, date helpers, `toEntries`, Jira client, `fetchMonth`, HTTP server, startup, `module.exports`. Each task says where its code goes.

---

### Task 1: Date helpers

**Files:**
- Create: `server.js`
- Create: `server.test.js`

- [ ] **Step 1: Check Node version**

Run: `node --version`
Expected: `v20.6.0` or higher (needed for `--env-file`). If lower, upgrade Node before continuing.

- [ ] **Step 2: Write the failing tests**

Create `server.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeStarted, localDate, monthRange, isPastMonth } = require('./server');

test('normalizeStarted inserts the colon into Jira offsets', () => {
  assert.equal(normalizeStarted('2026-09-30T23:30:00.000+0000'), '2026-09-30T23:30:00.000+00:00');
  assert.equal(normalizeStarted('2026-09-30T08:00:00.000-0530'), '2026-09-30T08:00:00.000-05:30');
  assert.equal(normalizeStarted('2026-09-30T08:00:00.000+07:00'), '2026-09-30T08:00:00.000+07:00');
});

test('localDate uses the given timezone, not the machine one', () => {
  const d = new Date('2026-09-30T23:30:00.000+00:00');
  assert.equal(localDate(d, 'Asia/Ho_Chi_Minh'), '2026-10-01');
  assert.equal(localDate(d, 'UTC'), '2026-09-30');
});

test('monthRange widens by one day on each side', () => {
  assert.deepEqual(monthRange('2026-09'), {
    jqlFrom: '2026-08-31',
    jqlTo: '2026-10-01',
    startedAfter: Date.UTC(2026, 7, 31),
    startedBefore: Date.UTC(2026, 9, 2),
  });
  assert.deepEqual(monthRange('2026-12'), {
    jqlFrom: '2026-11-30',
    jqlTo: '2027-01-01',
    startedAfter: Date.UTC(2026, 10, 30),
    startedBefore: Date.UTC(2027, 0, 2),
  });
});

test('isPastMonth compares against the current month in tz', () => {
  const now = new Date('2026-09-30T18:00:00Z'); // 2026-10-01 01:00 in Ho Chi Minh
  assert.equal(isPastMonth('2026-09', 'Asia/Ho_Chi_Minh', now), true);
  assert.equal(isPastMonth('2026-09', 'UTC', now), false);
  assert.equal(isPastMonth('2026-08', 'UTC', now), true);
  assert.equal(isPastMonth('2026-10', 'UTC', now), false);
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `node --test server.test.js`
Expected: FAIL with `Cannot find module './server'`.

- [ ] **Step 4: Write the implementation**

Create `server.js`:

```js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 3000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIMEOUT_MS = 15000;
const CONCURRENCY = 5;
const DAY_MS = 86400000;

// Jira sends offsets like "+0000"; strict ISO 8601 needs "+00:00".
function normalizeStarted(s) {
  return s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

const formatters = new Map();
function dateFormatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

// YYYY-MM-DD of `date` in `tz`, built from formatToParts (never locale string output).
function localDate(date, tz) {
  const p = {};
  for (const { type, value } of dateFormatter(tz).formatToParts(date)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

// Query window for a month, widened by one day on each side. The UTC-midnight
// bounds cover the whole month in any timezone within ±24h of UTC.
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const nextStart = Date.UTC(y, m, 1); // monthEnd + 1 day
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  return {
    jqlFrom: ymd(start - DAY_MS),
    jqlTo: ymd(nextStart),
    startedAfter: start - DAY_MS,
    startedBefore: nextStart + DAY_MS, // 00:00 UTC on monthEnd + 2 days
  };
}

function isPastMonth(month, tz, now) {
  return month < localDate(now, tz).slice(0, 7);
}

module.exports = { normalizeStarted, localDate, monthRange, isPastMonth };
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test server.test.js`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add server.js server.test.js
git commit -m "feat: add date helpers for Jira time dashboard" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `toEntries`

**Files:**
- Modify: `server.js` (insert above `module.exports`, replace the exports line)
- Modify: `server.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `server.test.js`. Later tasks reuse `ME`, `issues` and `wl`.

```js
const { toEntries } = require('./server');

const ME = 'me-123';
const issues = [
  { key: 'EF-1', fields: { summary: 'Login bug', project: { key: 'EF' } } },
  { key: 'OPS-2', fields: { summary: 'Deploy', project: { key: 'OPS' } } },
];
const wl = (accountId, started, timeSpentSeconds) => ({ author: { accountId }, started, timeSpentSeconds });

test('toEntries drops worklogs by other authors', () => {
  const out = toEntries(issues, {
    'EF-1': [wl(ME, '2026-09-10T09:00:00.000+0700', 3600), wl('other', '2026-09-10T09:00:00.000+0700', 7200)],
  }, ME, '2026-09', 'Asia/Ho_Chi_Minh');
  assert.deepEqual(out, [{ date: '2026-09-10', issueKey: 'EF-1', summary: 'Login bug', project: 'EF', seconds: 3600 }]);
});

test('toEntries drops dates outside the month, including the widened days', () => {
  const out = toEntries(issues, {
    'EF-1': [
      wl(ME, '2026-08-31T10:00:00.000+0700', 60),
      wl(ME, '2026-09-15T10:00:00.000+0700', 120),
      wl(ME, '2026-10-01T10:00:00.000+0700', 180),
    ],
  }, ME, '2026-09', 'Asia/Ho_Chi_Minh');
  assert.deepEqual(out.map((e) => [e.date, e.seconds]), [['2026-09-15', 120]]);
});

test('toEntries parses Jira started format (+0000) and applies tz, not the offset', () => {
  const byIssue = { 'EF-1': [wl(ME, '2026-09-30T23:30:00.000+0000', 1800)] };
  assert.deepEqual(toEntries(issues, byIssue, ME, '2026-09', 'Asia/Ho_Chi_Minh'), []);
  assert.deepEqual(toEntries(issues, byIssue, ME, '2026-10', 'Asia/Ho_Chi_Minh').map((e) => e.date), ['2026-10-01']);
  assert.deepEqual(toEntries(issues, byIssue, ME, '2026-09', 'UTC').map((e) => e.date), ['2026-09-30']);
});

test('toEntries keeps every worklog on the same day and sorts by date', () => {
  const out = toEntries(issues, {
    'EF-1': [wl(ME, '2026-09-12T09:00:00.000+0000', 3600), wl(ME, '2026-09-12T14:00:00.000+0000', 7200)],
    'OPS-2': [wl(ME, '2026-09-11T09:00:00.000+0000', 1800)],
  }, ME, '2026-09', 'UTC');
  assert.deepEqual(out.map((e) => [e.date, e.issueKey, e.seconds]), [
    ['2026-09-11', 'OPS-2', 1800],
    ['2026-09-12', 'EF-1', 3600],
    ['2026-09-12', 'EF-1', 7200],
  ]);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test server.test.js`
Expected: FAIL with `toEntries is not a function`.

- [ ] **Step 3: Write the implementation**

In `server.js`, insert above `module.exports`:

```js
// Source of truth for filtering: my worklogs whose local date (in tz) is inside month.
function toEntries(issues, worklogsByIssue, accountId, month, tz) {
  const entries = [];
  for (const issue of issues) {
    for (const w of worklogsByIssue[issue.key] || []) {
      if (w.author?.accountId !== accountId) continue;
      const date = localDate(new Date(normalizeStarted(w.started)), tz);
      if (!date.startsWith(`${month}-`)) continue;
      entries.push({
        date,
        issueKey: issue.key,
        summary: issue.fields.summary,
        project: issue.fields.project.key,
        seconds: w.timeSpentSeconds,
      });
    }
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}
```

Replace the exports line with:

```js
module.exports = { normalizeStarted, localDate, monthRange, isPastMonth, toEntries };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test server.test.js`
Expected: `# pass 8`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server.js server.test.js
git commit -m "feat: add toEntries worklog filter" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Jira client (auth, timeout, 429 retry)

**Files:**
- Modify: `server.js` (insert above `module.exports`, replace the exports line)
- Modify: `server.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `server.test.js`:

```js
const { createJira, retryDelayMs, JiraError } = require('./server');

const jsonRes = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const jiraOpts = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', token: 't' };

test('retryDelayMs uses Retry-After seconds, defaults to 2s, caps at 30s', () => {
  assert.equal(retryDelayMs('5'), 5000);
  assert.equal(retryDelayMs(null), 2000);
  assert.equal(retryDelayMs('Wed, 21 Oct 2026 07:28:00 GMT'), 2000);
  assert.equal(retryDelayMs('120'), 30000);
});

test('createJira sends basic auth to baseUrl + path and parses JSON', async () => {
  let seen;
  const jira = createJira({ ...jiraOpts, fetchImpl: async (url, init) => { seen = { url, init }; return jsonRes(200, { ok: 1 }); } });
  assert.deepEqual(await jira('/rest/api/3/myself'), { ok: 1 });
  assert.equal(seen.url, 'https://x.atlassian.net/rest/api/3/myself');
  assert.equal(seen.init.headers.Authorization, `Basic ${Buffer.from('a@b.c:t').toString('base64')}`);
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test('createJira retries a 429 once after Retry-After', async () => {
  const waits = [];
  let calls = 0;
  const jira = createJira({
    ...jiraOpts,
    sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async () => (++calls === 1 ? jsonRes(429, {}, { 'Retry-After': '3' }) : jsonRes(200, { ok: 1 })),
  });
  assert.deepEqual(await jira('/x'), { ok: 1 });
  assert.deepEqual(waits, [3000]);
  assert.equal(calls, 2);
});

test('createJira throws JiraError with the Jira status on failure', async () => {
  const always429 = createJira({ ...jiraOpts, sleep: async () => {}, fetchImpl: async () => jsonRes(429, {}) });
  await assert.rejects(always429('/x'), (e) => e instanceof JiraError && e.status === 429);
  const unauthorized = createJira({ ...jiraOpts, fetchImpl: async () => jsonRes(401, {}) });
  await assert.rejects(unauthorized('/x'), (e) => e instanceof JiraError && e.status === 401);
});

test('createJira maps a timeout to a 504 JiraError', async () => {
  const jira = createJira({ ...jiraOpts, fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); } });
  await assert.rejects(jira('/x'), (e) => e instanceof JiraError && e.status === 504);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test server.test.js`
Expected: FAIL with `retryDelayMs is not a function` (and similar for `createJira`).

- [ ] **Step 3: Write the implementation**

In `server.js`, insert above `module.exports`:

```js
class JiraError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status; // Jira HTTP status, or 504 timeout / 502 network failure
  }
}

// Retry-After in seconds; 2s when missing or not a number; never more than 30s.
function retryDelayMs(header) {
  const s = header ? Number(header) : NaN;
  return Math.min(Number.isFinite(s) && s >= 0 ? s * 1000 : 2000, 30000);
}

function createJira({ baseUrl, email, token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  async function once(pathname, init) {
    try {
      return await fetchImpl(baseUrl + pathname, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new JiraError(`Jira request timed out: ${pathname}`, 504);
      throw new JiraError(`Jira request failed: ${err.message}`, 502);
    }
  }
  return async function jira(pathname, init = {}) {
    let res = await once(pathname, init);
    if (res.status === 429) {
      await sleep(retryDelayMs(res.headers.get('retry-after')));
      res = await once(pathname, init);
    }
    if (!res.ok) throw new JiraError(`Jira ${res.status} on ${pathname}`, res.status);
    return res.json();
  };
}
```

Replace the exports line with:

```js
module.exports = { normalizeStarted, localDate, monthRange, isPastMonth, toEntries, JiraError, retryDelayMs, createJira };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test server.test.js`
Expected: `# pass 13`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server.js server.test.js
git commit -m "feat: add Jira client with timeout and 429 retry" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `fetchMonth` (search + worklog paging, concurrency cap)

**Files:**
- Modify: `server.js` (insert above `module.exports`, replace the exports line)
- Modify: `server.test.js` (append; uses `ME`, `issues`, `wl` from Task 2)

- [ ] **Step 1: Write the failing tests**

Append to `server.test.js`:

```js
const { fetchMonth, mapLimit } = require('./server');

test('mapLimit keeps order and caps concurrency', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});

test('mapLimit rejects when any item fails', async () => {
  await assert.rejects(mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; }), /boom/);
});

test('fetchMonth pages search and worklogs, narrows by started, then filters', async () => {
  const calls = [];
  const jira = async (p, init) => {
    calls.push({ p, body: init?.body && JSON.parse(init.body) });
    if (p === '/rest/api/3/search/jql') {
      return JSON.parse(init.body).nextPageToken ? { issues: [issues[1]] } : { issues: [issues[0]], nextPageToken: 'p2' };
    }
    const q = new URL(p, 'http://x').searchParams;
    if (p.startsWith('/rest/api/3/issue/EF-1/worklog')) {
      return q.get('startAt') === '0'
        ? { startAt: 0, total: 2, worklogs: [wl(ME, '2026-09-01T09:00:00.000+0000', 3600)] }
        : { startAt: 1, total: 2, worklogs: [wl('other', '2026-09-01T09:00:00.000+0000', 60)] };
    }
    if (p.startsWith('/rest/api/3/issue/OPS-2/worklog')) {
      return { startAt: 0, total: 1, worklogs: [wl(ME, '2026-09-02T09:00:00.000+0000', 1800)] };
    }
    throw new Error(`unexpected ${p}`);
  };

  const entries = await fetchMonth(jira, '2026-09', { accountId: ME, timeZone: 'UTC' });

  assert.deepEqual(entries.map((e) => [e.date, e.issueKey, e.seconds]), [
    ['2026-09-01', 'EF-1', 3600],
    ['2026-09-02', 'OPS-2', 1800],
  ]);
  assert.equal(calls[0].body.jql, 'worklogAuthor = currentUser() AND worklogDate >= "2026-08-31" AND worklogDate <= "2026-10-01"');
  assert.deepEqual(calls[0].body.fields, ['summary', 'project']);
  const q = new URL(calls.find((c) => c.p.startsWith('/rest/api/3/issue/EF-1/worklog')).p, 'http://x').searchParams;
  assert.equal(q.get('startedAfter'), String(Date.UTC(2026, 7, 31)));
  assert.equal(q.get('startedBefore'), String(Date.UTC(2026, 9, 2)));
  assert.equal(calls.filter((c) => c.p.startsWith('/rest/api/3/issue/EF-1/worklog')).length, 2);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test server.test.js`
Expected: FAIL with `mapLimit is not a function`.

- [ ] **Step 3: Write the implementation**

In `server.js`, insert above `module.exports`:

```js
// Like Promise.all over items, with at most `limit` in flight. Rejects on the first failure.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchMonth(jira, month, me) {
  const r = monthRange(month);
  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${r.jqlFrom}" AND worklogDate <= "${r.jqlTo}"`;

  const issues = [];
  let nextPageToken;
  do {
    const page = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, fields: ['summary', 'project'], maxResults: 100, nextPageToken }),
    });
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);

  // Any failed issue rejects the whole month: partial data would show fake gaps.
  const lists = await mapLimit(issues, CONCURRENCY, async (issue) => {
    const all = [];
    let startAt = 0;
    for (;;) {
      const page = await jira(
        `/rest/api/3/issue/${issue.key}/worklog?startedAfter=${r.startedAfter}&startedBefore=${r.startedBefore}&startAt=${startAt}&maxResults=5000`,
      );
      all.push(...page.worklogs);
      startAt += page.worklogs.length;
      if (page.worklogs.length === 0 || startAt >= page.total) return all;
    }
  });

  const worklogsByIssue = Object.fromEntries(issues.map((issue, i) => [issue.key, lists[i]]));
  return toEntries(issues, worklogsByIssue, me.accountId, month, me.timeZone);
}
```

Replace the exports line with:

```js
module.exports = { normalizeStarted, localDate, monthRange, isPastMonth, toEntries, JiraError, retryDelayMs, createJira, mapLimit, fetchMonth };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test server.test.js`
Expected: `# pass 16`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server.js server.test.js
git commit -m "feat: add fetchMonth with paging and concurrency cap" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: HTTP server, cache and startup

**Files:**
- Modify: `server.js` (insert above `module.exports`, replace the exports line, append startup block)
- Modify: `server.test.js` (append; uses `ME` from Task 2 and `JiraError` from Task 3)
- Create: `.env.example`

- [ ] **Step 1: Write the failing tests**

Append to `server.test.js`:

```js
const http = require('node:http');
const { createServer } = require('./server');

const TEST_PORT = 3999;
const NOW = () => new Date('2026-09-15T12:00:00Z');

function startServer(jira) {
  const server = createServer({ jira, baseUrl: 'https://x.atlassian.net', port: TEST_PORT, now: NOW });
  return new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', () => resolve(server)));
}

function get(pathname, host = `127.0.0.1:${TEST_PORT}`) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: TEST_PORT, path: pathname, headers: { Host: host }, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

function fakeJira(myself = { accountId: ME, timeZone: 'UTC' }) {
  const jira = async (p) => {
    if (p === '/rest/api/3/myself') return myself;
    if (p === '/rest/api/3/search/jql') { jira.searches++; return { issues: [] }; }
    throw new Error(`unexpected ${p}`);
  };
  jira.searches = 0;
  return jira;
}

test('server rejects a foreign Host header', async () => {
  const server = await startServer(fakeJira());
  try {
    assert.equal((await get('/api/worklogs?month=2026-09', `evil.example:${TEST_PORT}`)).status, 403);
  } finally { server.close(); }
});

test('server validates month', async () => {
  const server = await startServer(fakeJira());
  try {
    assert.equal((await get('/api/worklogs?month=2026-13')).status, 400);
    assert.equal((await get('/api/worklogs?month=2026-9')).status, 400);
    assert.equal((await get('/api/worklogs')).status, 400);
  } finally { server.close(); }
});

test('server caches past months only; refresh=1 bypasses', async () => {
  const jira = fakeJira();
  const server = await startServer(jira);
  try {
    const first = await get('/api/worklogs?month=2026-08');
    assert.deepEqual(first.body, { baseUrl: 'https://x.atlassian.net', timeZone: 'UTC', entries: [] });
    await get('/api/worklogs?month=2026-08');
    assert.equal(jira.searches, 1);
    await get('/api/worklogs?month=2026-08&refresh=1');
    assert.equal(jira.searches, 2);
    await get('/api/worklogs?month=2026-09');
    await get('/api/worklogs?month=2026-09');
    assert.equal(jira.searches, 4);
  } finally { server.close(); }
});

test('server falls back to UTC when Jira has no timeZone', async () => {
  const server = await startServer(fakeJira({ accountId: ME, timeZone: null }));
  try {
    assert.equal((await get('/api/worklogs?month=2026-08')).body.timeZone, 'UTC');
  } finally { server.close(); }
});

test('server maps Jira errors to 502/504 with the Jira status', async () => {
  const unauthorized = await startServer(async () => { throw new JiraError('Jira 401 on /rest/api/3/myself', 401); });
  try {
    const r = await get('/api/worklogs?month=2026-08');
    assert.equal(r.status, 502);
    assert.equal(r.body.status, 401);
  } finally { unauthorized.close(); }
  const timedOut = await startServer(async () => { throw new JiraError('Jira request timed out', 504); });
  try {
    assert.equal((await get('/api/worklogs?month=2026-08')).status, 504);
  } finally { timedOut.close(); }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test server.test.js`
Expected: FAIL with `createServer is not a function`.

- [ ] **Step 3: Write the implementation**

In `server.js`, insert above `module.exports`:

```js
function createServer({ jira, baseUrl, port, now = () => new Date() }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]); // blocks DNS rebinding
  const cache = new Map(); // month -> response; past months only
  let me;

  async function getMe() {
    if (!me) {
      const user = await jira('/rest/api/3/myself');
      if (!user.timeZone) console.warn('Jira profile has no timeZone; falling back to UTC');
      me = { accountId: user.accountId, timeZone: user.timeZone || 'UTC' };
    }
    return me;
  }

  return http.createServer(async (req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!allowedHosts.has(req.headers.host)) return json(403, { error: 'Forbidden host' });

    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (req.method !== 'GET' || url.pathname !== '/api/worklogs') return json(404, { error: 'Not found' });

    const month = url.searchParams.get('month') || '';
    if (!MONTH_RE.test(month)) return json(400, { error: 'month must be YYYY-MM' });

    try {
      const { accountId, timeZone } = await getMe();
      const past = isPastMonth(month, timeZone, now());
      if (past && url.searchParams.get('refresh') !== '1' && cache.has(month)) return json(200, cache.get(month));
      const body = { baseUrl, timeZone, entries: await fetchMonth(jira, month, { accountId, timeZone }) };
      if (past) cache.set(month, body);
      json(200, body);
    } catch (err) {
      const status = err instanceof JiraError ? err.status : 500;
      console.error(err.message);
      json(status === 504 ? 504 : 502, { error: err.message, status });
    }
  });
}
```

Replace the exports line with:

```js
module.exports = {
  normalizeStarted, localDate, monthRange, isPastMonth, toEntries,
  JiraError, retryDelayMs, createJira, mapLimit, fetchMonth, createServer,
};
```

Append at the very end of `server.js`, after `module.exports`:

```js
if (require.main === module) {
  const missing = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env var(s): ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  const baseUrl = process.env.JIRA_BASE_URL.replace(/\/+$/, '');
  const jira = createJira({ baseUrl, email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN });
  createServer({ jira, baseUrl, port: PORT }).listen(PORT, '127.0.0.1', () => {
    console.log(`Jira time dashboard: http://localhost:${PORT}`);
  });
}
```

Create `.env.example`:

```
# Copy to .env and fill in. Token: https://id.atlassian.com/manage-profile/security/api-tokens
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test server.test.js`
Expected: `# pass 21`, `# fail 0`. The UTC-fallback test prints a `console.warn` line; that is expected.

- [ ] **Step 5: Check the missing-env startup error**

Run: `env -u JIRA_BASE_URL -u JIRA_EMAIL -u JIRA_API_TOKEN node server.js; echo "exit=$?"`
Expected: `Missing env var(s): JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN. Copy .env.example to .env and fill it in.` then `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add server.js server.test.js .env.example
git commit -m "feat: add HTTP server with host check, month cache and startup" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: UI (`index.html`)

**Files:**
- Create: `index.html`

The UI is checked by hand (spec: no UI test framework). Rules this code follows, from the spec:
- All `YYYY-MM-DD` math uses `Date.UTC` with `getUTCDay()` / `getUTCDate()`.
- "Today" comes from the API's `timeZone`.
- Sums are kept in seconds, and only `fmt` turns seconds into text.
- On error the page keeps the last good data and shows a banner. It never shows an empty calendar.

- [ ] **Step 1: Create `index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jira Time</title>
<style>
  :root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --ok: #2e7d32; --low: #f9a825; --zero: #c62828; --accent: #1976d2; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --fg: #f2f2f7; --muted: #98989d; --line: #3a3a3c; } }
  body { margin: 0; padding: 16px; font: 14px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
  header h1 { font-size: 18px; margin: 0 4px; min-width: 80px; text-align: center; }
  button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
  button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  .muted { color: var(--muted); }
  .kpis { display: flex; gap: 16px; margin-left: auto; }
  .kpis div { color: var(--muted); font-size: 12px; }
  .kpis b { display: block; color: var(--fg); font-size: 16px; }
  #banner { display: none; padding: 8px 12px; margin-bottom: 12px; border: 1px solid var(--zero); border-radius: 6px; color: var(--zero); }
  main { display: grid; grid-template-columns: 3fr 2fr; gap: 24px; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } }
  .cal { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
  .dow { font-size: 12px; color: var(--muted); text-align: center; }
  .day { min-height: 52px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
  .day .n { font-size: 12px; color: var(--muted); }
  .day .h { font-weight: 600; }
  .day.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); border-color: var(--ok); }
  .day.low { background: color-mix(in srgb, var(--low) 22%, transparent); border-color: var(--low); }
  .day.zero { background: color-mix(in srgb, var(--zero) 18%, transparent); border-color: var(--zero); }
  .day.today { border: 2px dashed var(--accent); }
  .day.future { opacity: .4; cursor: default; }
  .day.sel { outline: 2px solid var(--fg); outline-offset: 1px; }
  .bd-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .bd-head h2 { font-size: 16px; margin: 0; }
  .bars { margin-top: 12px; }
  .bars .row { margin-bottom: 10px; }
  .bars .label { display: flex; justify-content: space-between; gap: 8px; }
  .bars .bar { height: 8px; margin-top: 3px; background: var(--accent); border-radius: 4px; }
  a { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px; border-top: 1px solid var(--line); vertical-align: top; }
  td.num { text-align: right; white-space: nowrap; }
</style>
</head>
<body>
<header>
  <button id="prev" aria-label="Previous month">◀</button>
  <h1 id="month"></h1>
  <button id="next" aria-label="Next month">▶</button>
  <button id="refresh">Refresh</button>
  <button id="copy">Copy summary</button>
  <span id="status" class="muted"></span>
  <div id="kpis" class="kpis"></div>
</header>
<div id="banner" role="alert"></div>
<main>
  <section>
    <div id="cal" class="cal"></div>
    <div id="detail"></div>
  </section>
  <section>
    <div class="bd-head">
      <h2 id="breakdown-title"></h2>
      <span><button id="by-ticket">Ticket</button> <button id="by-project">Project</button></span>
    </div>
    <div id="bars" class="bars"></div>
  </section>
</main>
<script>
// Hours per weekday. 0 = day off (shown neutral, never counted as a gap).
const TARGETS = { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 8, Sun: 8 };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const $ = (sel) => document.querySelector(sel);

// Date math on YYYY-MM-DD strings, always via UTC so the browser timezone never matters.
const toMs = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const weekday = (s) => WEEKDAYS[new Date(toMs(s)).getUTCDay()];
const daysInMonth = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const shiftMonth = (month, n) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
function todayIn(tz) {
  const p = {};
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  for (const { type, value } of f.formatToParts(new Date())) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

// The only seconds-to-text function. Rounds to the nearest minute.
function fmt(sec) {
  const mins = Math.round(sec / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h && m ? `${h}h ${m}m` : m ? `${m}m` : `${h}h`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const link = (key) => `<a href="${esc(state.data.baseUrl)}/browse/${esc(key)}" target="_blank" rel="noopener">${esc(key)}</a>`;

// ponytail: the first month is guessed from the browser timezone before Jira's timeZone is known; ◀ ▶ corrects it.
const initialMonth = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone).slice(0, 7);
const state = { month: null, data: null, selected: null, groupBy: 'ticket', loading: false, error: null };

function compute(data, month) {
  const today = todayIn(data.timeZone);
  const byDay = {};
  for (const e of data.entries) byDay[e.date] = (byDay[e.date] || 0) + e.seconds;
  const days = [];
  for (let d = 1; d <= daysInMonth(month); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const logged = byDay[date] || 0;
    const target = TARGETS[weekday(date)] * 3600;
    let status;
    if (date > today) status = 'future';
    else if (date === today) status = 'today';
    else if (target === 0) status = 'off';
    else status = logged >= target ? 'ok' : logged > 0 ? 'low' : 'zero';
    days.push({ date, logged, target, status });
  }
  const counted = days.filter((d) => d.status === 'ok' || d.status === 'low' || d.status === 'zero');
  return {
    days,
    logged: sum(data.entries, (e) => e.seconds),
    target: sum(counted, (d) => d.target),
    gapDays: counted.filter((d) => d.logged < d.target).length,
    missing: sum(counted, (d) => Math.max(0, d.target - d.logged)),
  };
}

function groupTotals(entries, by) {
  const groups = new Map();
  for (const e of entries) {
    const key = by === 'ticket' ? e.issueKey : e.project;
    const g = groups.get(key) || { key, summary: by === 'ticket' ? e.summary : '', seconds: 0 };
    g.seconds += e.seconds;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.seconds - a.seconds);
}

async function load(month, refresh = false) {
  state.loading = true;
  render();
  try {
    const res = await fetch(`/api/worklogs?month=${month}${refresh ? '&refresh=1' : ''}`);
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.status === 401 || body.status === 403 ? 'Check JIRA_EMAIL / JIRA_API_TOKEN' : body.error || `HTTP ${res.status}`);
    }
    Object.assign(state, { month, data: body, selected: null, error: null });
  } catch (err) {
    state.error = err.message; // keep the last good data: an empty calendar would look like real gaps
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  $('#month').textContent = state.month || initialMonth;
  $('#status').textContent = state.loading ? 'Loading…' : '';
  $('#banner').textContent = state.error || '';
  $('#banner').style.display = state.error ? 'block' : 'none';
  $('#by-ticket').setAttribute('aria-pressed', state.groupBy === 'ticket');
  $('#by-project').setAttribute('aria-pressed', state.groupBy === 'project');
  if (!state.data) {
    $('main').style.display = 'none';
    $('#kpis').innerHTML = '';
    return;
  }
  $('main').style.display = '';
  const v = compute(state.data, state.month);

  $('#kpis').innerHTML = [['Logged', fmt(v.logged)], ['Target', fmt(v.target)], ['Gap days', v.gapDays], ['Missing', fmt(v.missing)]]
    .map(([k, x]) => `<div>${k}<b>${x}</b></div>`).join('');

  const lead = (new Date(toMs(`${state.month}-01`)).getUTCDay() + 6) % 7; // Monday-first
  $('#cal').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('')
    + '<div></div>'.repeat(lead)
    + v.days.map((d) => `<div class="day ${d.status}${d.date === state.selected ? ' sel' : ''}" data-date="${d.date}"${d.status === 'today' ? ' title="In progress"' : ''}>
        <div class="n">${Number(d.date.slice(8))}</div>${d.status === 'future' ? '' : `<div class="h">${fmt(d.logged)}</div>`}</div>`).join('');

  const entries = state.data.entries.filter((e) => !state.selected || e.date === state.selected);
  const rows = groupTotals(entries, state.groupBy);
  const max = rows[0]?.seconds || 1;
  $('#breakdown-title').textContent = `Breakdown · ${state.selected || state.month}`;
  $('#bars').innerHTML = rows.length
    ? rows.map((r) => `<div class="row"><div class="label"><span>${state.groupBy === 'ticket' ? `${link(r.key)} ${esc(r.summary)}` : esc(r.key)}</span><span>${fmt(r.seconds)}</span></div>
        <div class="bar" style="width:${(r.seconds / max) * 100}%"></div></div>`).join('')
    : '<p class="muted">No worklogs.</p>';

  if (!state.selected) {
    $('#detail').innerHTML = '';
  } else {
    const dayRows = state.data.entries.filter((e) => e.date === state.selected);
    $('#detail').innerHTML = `<h3>${state.selected} ${weekday(state.selected)}</h3>` + (dayRows.length
      ? `<table>${dayRows.map((e) => `<tr><td>${link(e.issueKey)}</td><td>${esc(e.summary)}</td><td class="num">${fmt(e.seconds)}</td></tr>`).join('')}</table>`
      : '<p class="muted">Nothing logged.</p>');
  }
}

async function copySummary() {
  if (!state.data) return;
  const v = compute(state.data, state.month);
  const lines = [
    `Jira time — ${state.month}`,
    `Logged ${fmt(v.logged)} · Target ${fmt(v.target)} · Gap days ${v.gapDays} · Missing ${fmt(v.missing)}`,
    '',
    ...v.days.filter((d) => d.status !== 'future')
      .map((d) => `${d.date} ${weekday(d.date)}  ${fmt(d.logged)}${d.status === 'today' ? ' (in progress)' : ''}`),
    '',
    'By ticket',
    ...groupTotals(state.data.entries, 'ticket').map((g) => `${g.key}  ${fmt(g.seconds)}  ${g.summary}`),
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    $('#status').textContent = 'Copied';
  } catch (err) {
    state.error = `Copy failed: ${err.message}`;
    render();
  }
}

$('#prev').onclick = () => load(shiftMonth(state.month || initialMonth, -1));
$('#next').onclick = () => load(shiftMonth(state.month || initialMonth, 1));
$('#refresh').onclick = () => load(state.month || initialMonth, true);
$('#copy').onclick = copySummary;
$('#by-ticket').onclick = () => { state.groupBy = 'ticket'; render(); };
$('#by-project').onclick = () => { state.groupBy = 'project'; render(); };
$('#cal').onclick = (e) => {
  const el = e.target.closest('.day');
  if (!el || el.classList.contains('future')) return;
  state.selected = state.selected === el.dataset.date ? null : el.dataset.date;
  render();
};

load(initialMonth);
</script>
</body>
</html>
```

- [ ] **Step 2: Make sure the server tests still pass**

Run: `node --test server.test.js`
Expected: `# pass 21`, `# fail 0`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add dashboard UI with calendar, breakdown and copy summary" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: End-to-end check against real Jira

**Files:** none (manual verification). `.env` is created locally and is gitignored.

- [ ] **Step 1: Create `.env`**

Run: `cp .env.example .env`, then fill in `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`. Create the token at https://id.atlassian.com/manage-profile/security/api-tokens.

Run: `git status --short`
Expected: `.env` is not listed (it is ignored).

- [ ] **Step 2: Start the server**

Run: `node --env-file=.env server.js`
Expected: `Jira time dashboard: http://localhost:3000`.

- [ ] **Step 3: Check the API directly**

In a second terminal, run: `curl -s 'http://localhost:3000/api/worklogs?month=2026-09' | head -c 400`
Expected: JSON starting with `{"baseUrl":"https://…atlassian.net","timeZone":"<your profile tz>","entries":[`.

Run: `curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example:3000' 'http://127.0.0.1:3000/api/worklogs?month=2026-09'`
Expected: `403`.

Run: `curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3000/api/worklogs?month=2026-13'`
Expected: `400`.

- [ ] **Step 4: Check the UI in the browser**

Open http://localhost:3000 and confirm each item:
- The calendar starts on Monday, and the days line up with the real weekdays of the month.
- Past days are green (≥ 8h), amber (some time logged) or red (0h). Today has a dashed "in progress" border. Future days are faded.
- Pick one past day and compare its hours with Jira's own worklog view for that day. They must match.
- Clicking a day filters the breakdown and shows the day-detail table. Clicking it again clears both.
- The Ticket/Project toggle regroups the bars. Ticket links open the issue in Jira.
- ◀ loads the previous month. Pressing ◀ ▶ again for an already-visited past month is instant (cached). Refresh refetches.
- Copy summary, then paste into a text editor. It shows the totals, one line per day up to today (today marked "(in progress)"), and the per-ticket totals.

- [ ] **Step 5: Check the error path**

Stop the server. Edit `.env` so that `JIRA_API_TOKEN=wrong`, then restart with `node --env-file=.env server.js`. Reload the page.
Expected: the banner says `Check JIRA_EMAIL / JIRA_API_TOKEN`, and no calendar is shown.

Restore the real token and restart. Load a month. Then stop the server and click Refresh.
Expected: an error banner appears, and the previous month's calendar stays visible.

- [ ] **Step 6: Try a day-off target**

In `index.html`, temporarily set `Sat: 0, Sun: 0` and reload. Weekend days in the past now look neutral (not red), and Gap days and Missing drop to match. Revert the change afterwards.
