const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 3000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// Sprint to highlight: the active sprint from this JQL whose name contains SPRINT_NAME.
// (Jira rejects `sprint ~ "Core"` in JQL, so the name match happens here.)
const SPRINT_JQL = 'project = UP AND sprint in openSprints()';
const SPRINT_NAME = 'core';
const SPRINT_TTL_MS = 10 * 60 * 1000;
const ACCOUNT_RE = /^[A-Za-z0-9:_-]{1,128}$/; // Jira accountIds; also keeps them safe inside JQL quotes
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

function isValidTimeZone(tz) {
  try {
    dateFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

function isPastMonth(month, tz, now) {
  return month < localDate(now, tz).slice(0, 7);
}

// Worklog comments come as Atlassian Document Format; flatten to plain text (blocks on separate lines).
function adfText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (!node.content) return node.attrs?.text || ''; // mention, emoji, etc.
  const parts = node.content.map(adfText);
  return (node.type === 'paragraph' || node.type === 'heading' ? parts.join('') : parts.filter(Boolean).join('\n')).trim();
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
        comment: adfText(w.comment),
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

async function fetchMonth(jira, month, person) {
  const r = monthRange(month);
  const jql = `worklogAuthor = "${person.accountId}" AND worklogDate >= "${r.jqlFrom}" AND worklogDate <= "${r.jqlTo}"`;

  const issues = [];
  let nextPageToken;
  do {
    const page = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, fields: ['summary', 'project', 'worklog'], maxResults: 100, nextPageToken }),
    });
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);

  // Search results embed each issue's worklogs (Jira caps them, ~20). Only issues with more are fetched one by one.
  // Any failed issue rejects the whole month: partial data would show fake gaps.
  const lists = await mapLimit(issues, CONCURRENCY, async (issue) => {
    const embedded = issue.fields.worklog;
    if (embedded && embedded.total <= embedded.worklogs.length) return embedded.worklogs;
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
  return toEntries(issues, worklogsByIssue, person.accountId, month, person.timeZone);
}

async function fetchSprint(jira) {
  const fields = await jira('/rest/api/3/field');
  const field = fields.find((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint');
  if (!field) return null;
  let nextPageToken;
  do {
    const page = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql: SPRINT_JQL, fields: [field.id], maxResults: 100, nextPageToken }),
    });
    for (const issue of page.issues) {
      for (const s of issue.fields[field.id] || []) {
        if (s.state === 'active' && s.startDate && s.endDate && s.name.toLowerCase().includes(SPRINT_NAME)) {
          return { name: s.name, startDate: s.startDate, endDate: s.endDate };
        }
      }
    }
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return null;
}

function createServer({ jira, baseUrl, port, now = () => new Date() }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]); // blocks DNS rebinding
  const cache = new Map(); // `${accountId}|${month}|${tz}` -> response; past months only
  const people = new Map(); // accountId -> { accountId, displayName, timeZone }
  let me;
  let sprintCache = { at: -Infinity, value: null };

  // Highlighting is a nice-to-have: a failed lookup gives no highlight instead of failing the month.
  async function getSprint(force) {
    if (!force && now() - sprintCache.at < SPRINT_TTL_MS) return sprintCache.value;
    try {
      sprintCache = { at: +now(), value: await fetchSprint(jira) };
    } catch (err) {
      console.warn(`Sprint lookup failed: ${err.message}`);
      return null;
    }
    return sprintCache.value;
  }

  const sprintIn = (s, tz) => s && { name: s.name, start: localDate(new Date(s.startDate), tz), end: localDate(new Date(s.endDate), tz) };

  async function getMe() {
    if (!me) {
      const user = await jira('/rest/api/3/myself');
      if (!user.accountId) throw new JiraError('Jira /myself returned no accountId', 502);
      if (!user.timeZone) console.warn('Jira profile has no timeZone; falling back to UTC');
      me = { accountId: user.accountId, displayName: user.displayName, timeZone: user.timeZone || 'UTC' };
    }
    return me;
  }

  async function getPerson(accountId) {
    const self = await getMe();
    if (!accountId || accountId === self.accountId) return self;
    if (!people.has(accountId)) {
      const user = await jira(`/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`);
      people.set(accountId, { accountId: user.accountId, displayName: user.displayName, timeZone: user.timeZone || 'UTC' });
    }
    return people.get(accountId);
  }

  return http.createServer(async (req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!allowedHosts.has(req.headers.host)) return json(403, { error: 'Forbidden host' });

    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        const html = fs.readFileSync(path.join(__dirname, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/api/users') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q || q.length > 100) return json(400, { error: 'q must be 1-100 characters' });
        const users = await jira(`/rest/api/3/user/search?query=${encodeURIComponent(q)}&maxResults=20`);
        return json(200, users
          .filter((u) => u.accountType === 'atlassian' && u.active)
          .map((u) => ({ accountId: u.accountId, displayName: u.displayName, avatarUrl: u.avatarUrls?.['24x24'] || '' })));
      }
      if (req.method !== 'GET' || url.pathname !== '/api/worklogs') return json(404, { error: 'Not found' });

      const month = url.searchParams.get('month') || '';
      if (!MONTH_RE.test(month)) return json(400, { error: 'month must be YYYY-MM' });

      const tzParam = url.searchParams.get('tz');
      if (tzParam && !isValidTimeZone(tzParam)) return json(400, { error: 'tz must be an IANA timezone' });

      const account = url.searchParams.get('account');
      if (account && !ACCOUNT_RE.test(account)) return json(400, { error: 'account must be a Jira accountId' });

      const { accountId, displayName, timeZone: profileTimeZone } = await getPerson(account);
      const timeZone = tzParam || profileTimeZone;
      const key = `${accountId}|${month}|${timeZone}`;
      const refresh = url.searchParams.get('refresh') === '1';
      const past = isPastMonth(month, timeZone, now());
      if (past && !refresh && cache.has(key)) return json(200, { ...cache.get(key), sprint: sprintIn(await getSprint(false), timeZone) });
      const person = { accountId, displayName };
      const [entries, sprint] = await Promise.all([fetchMonth(jira, month, { accountId, timeZone }), getSprint(refresh)]);
      const body = { baseUrl, timeZone, profileTimeZone, person, entries };
      if (past) cache.set(key, body); // sprint is added per response, so cached months never hold a stale one
      json(200, { ...body, sprint: sprintIn(sprint, timeZone) });
    } catch (err) {
      console.error(err.message);
      if (res.headersSent) return res.end();
      if (err instanceof JiraError) return json(err.status === 504 ? 504 : 502, { error: err.message, status: err.status });
      json(500, { error: err.message, status: 500 });
    }
  });
}

module.exports = {
  normalizeStarted, localDate, monthRange, isPastMonth, adfText, toEntries,
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
