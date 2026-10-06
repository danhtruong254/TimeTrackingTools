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
const EDIT_PATH_RE = /^\/api\/worklogs\/([A-Z][A-Z0-9_]*-\d+)\/(\d+)$/;
const MAX_BODY_BYTES = 16 * 1024;
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

// Plain text back to ADF: one paragraph per line (formatting and mentions are not preserved).
function textToAdf(text) {
  return { type: 'doc', version: 1, content: text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) };
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
        id: w.id,
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

// Story points live in "Story Points" on this site; team-managed projects use "Story point estimate".
const POINT_FIELD_NAMES = ['story points', 'story point estimate'];
const pointFieldIds = (fields) => POINT_FIELD_NAMES.map((n) => fields.find((f) => f.name?.toLowerCase() === n)?.id).filter(Boolean);

// Tickets assigned to the person and resolved in the month, placed on their local resolution day.
async function fetchDone(jira, month, person, fields) {
  const r = monthRange(month);
  const ids = pointFieldIds(fields);
  const jql = `assignee = "${person.accountId}" AND resolved >= "${r.jqlFrom}" AND resolved <= "${r.jqlTo}"`;
  const done = [];
  let nextPageToken;
  do {
    const page = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, fields: ['summary', 'resolutiondate', ...ids], maxResults: 100, nextPageToken }),
    });
    for (const issue of page.issues) {
      const date = localDate(new Date(normalizeStarted(issue.fields.resolutiondate)), person.timeZone);
      if (!date.startsWith(`${month}-`)) continue;
      const points = ids.map((id) => issue.fields[id]).find((v) => typeof v === 'number') || 0;
      done.push({ date, issueKey: issue.key, summary: issue.fields.summary, points });
    }
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return done.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchSprint(jira, fields) {
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function createServer({ jira, baseUrl, port, now = () => new Date() }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]); // blocks DNS rebinding
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]); // writes only from this page (CSRF)
  const cache = new Map(); // `${accountId}|${month}|${tz}` -> response; past months only
  const people = new Map(); // accountId -> { accountId, displayName, timeZone }
  let me;
  let sprintCache = { at: -Infinity, value: null };
  let fieldsPromise; // Jira's field list, fetched once (retried after a failure)
  const getFields = () => (fieldsPromise ??= jira('/rest/api/3/field').catch((err) => { fieldsPromise = undefined; throw err; }));

  // Highlighting is a nice-to-have: a failed lookup gives no highlight instead of failing the month.
  async function getSprint(force) {
    if (!force && now() - sprintCache.at < SPRINT_TTL_MS) return sprintCache.value;
    try {
      sprintCache = { at: +now(), value: await fetchSprint(jira, await getFields()) };
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
      const edit = url.pathname.match(EDIT_PATH_RE);
      if (req.method === 'PUT' && edit) {
        if (!allowedOrigins.has(req.headers.origin)) return json(403, { error: 'Edits must come from the dashboard page' });
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return json(415, { error: 'Content-Type must be application/json' });
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch (err) {
          return json(400, { error: err.message === 'too large' ? 'Body too large' : 'Body must be JSON' });
        }
        const { seconds, comment } = input || {};
        if (seconds === undefined && comment === undefined) return json(400, { error: 'Nothing to change' });
        if (seconds !== undefined && !(Number.isInteger(seconds) && seconds >= 60 && seconds <= 86400)) return json(400, { error: 'seconds must be a whole number from 60 to 86400' });
        if (comment !== undefined && !(typeof comment === 'string' && comment.length <= 5000)) return json(400, { error: 'comment must be text up to 5000 characters' });

        const [, issueKey, worklogId] = edit;
        const self = await getMe();
        const current = await jira(`/rest/api/3/issue/${issueKey}/worklog/${worklogId}`);
        if (current.author?.accountId !== self.accountId) return json(403, { error: 'You can only edit your own worklogs' });
        const update = {};
        if (seconds !== undefined) update.timeSpentSeconds = seconds;
        if (comment !== undefined) update.comment = textToAdf(comment);
        const saved = await jira(`/rest/api/3/issue/${issueKey}/worklog/${worklogId}?adjustEstimate=leave&notifyUsers=false`, { method: 'PUT', body: JSON.stringify(update) });
        for (const key of cache.keys()) if (key.startsWith(`${self.accountId}|`)) cache.delete(key);
        return json(200, { id: saved.id, seconds: saved.timeSpentSeconds, comment: adfText(saved.comment) });
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
      const me = await getMe(); // already cached by getPerson
      const self = { accountId: me.accountId, displayName: me.displayName }; // who "you" is, whoever is being viewed
      // Done tickets are extra information: a failed lookup gives done: null instead of failing the month.
      const done = getFields().then((fields) => fetchDone(jira, month, { accountId, timeZone }, fields)).catch((err) => {
        console.warn(`Done-tickets lookup failed: ${err.message}`);
        return null;
      });
      const [entries, sprint, doneList] = await Promise.all([fetchMonth(jira, month, { accountId, timeZone }), getSprint(refresh), done]);
      const body = { baseUrl, timeZone, profileTimeZone, person, self, entries, done: doneList };
      if (past && doneList) cache.set(key, body); // sprint is added per response; a failed done lookup is retried next time
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
  normalizeStarted, localDate, monthRange, isPastMonth, adfText, textToAdf, toEntries,
  JiraError, retryDelayMs, createJira, mapLimit, fetchMonth, fetchDone, createServer,
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
