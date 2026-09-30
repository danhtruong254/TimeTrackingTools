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

function createServer({ jira, baseUrl, port, now = () => new Date() }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]); // blocks DNS rebinding
  const cache = new Map(); // month -> response; past months only
  let me;

  async function getMe() {
    if (!me) {
      const user = await jira('/rest/api/3/myself');
      if (!user.accountId) throw new JiraError('Jira /myself returned no accountId', 502);
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

module.exports = {
  normalizeStarted, localDate, monthRange, isPastMonth, toEntries,
  JiraError, retryDelayMs, createJira, mapLimit, fetchMonth, createServer,
};

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
