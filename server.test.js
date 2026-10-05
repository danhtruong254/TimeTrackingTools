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
  assert.deepEqual(out, [{ date: '2026-09-10', issueKey: 'EF-1', summary: 'Login bug', project: 'EF', seconds: 3600, comment: '', id: undefined }]);
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
  assert.equal(calls[0].body.jql, 'worklogAuthor = "me-123" AND worklogDate >= "2026-08-31" AND worklogDate <= "2026-10-01"');
  assert.deepEqual(calls[0].body.fields, ['summary', 'project', 'worklog']);
  const q = new URL(calls.find((c) => c.p.startsWith('/rest/api/3/issue/EF-1/worklog')).p, 'http://x').searchParams;
  assert.equal(q.get('startedAfter'), String(Date.UTC(2026, 7, 31)));
  assert.equal(q.get('startedBefore'), String(Date.UTC(2026, 9, 2)));
  assert.equal(calls.filter((c) => c.p.startsWith('/rest/api/3/issue/EF-1/worklog')).length, 2);
});

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

function fakeJira(myself = { accountId: ME, displayName: 'Me Myself', timeZone: 'UTC' }) {
  const jira = async (p, init) => {
    if (p === '/rest/api/3/myself') return myself;
    if (p === '/rest/api/3/field') return [{ id: 'summary', schema: {} }, { id: 'customfield_10010', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }];
    if (p === '/rest/api/3/search/jql' && JSON.parse(init.body).jql.includes('openSprints()')) {
      jira.sprintSearches++;
      return { issues: [{ key: 'UP-1', fields: { customfield_10010: [
        { name: 'Challenger 1', state: 'active', startDate: '2026-09-28T02:53:13.006Z', endDate: '2026-10-07T07:00:00.000Z' },
        { name: 'Core 17-26', state: 'closed', startDate: '2026-09-09T06:00:00.000Z', endDate: '2026-09-23T06:00:00.000Z' },
        { name: 'Core 18-26', state: 'active', startDate: '2026-09-23T06:27:45.183Z', endDate: '2026-10-07T06:27:41.000Z' },
      ] } }] };
    }
    if (p === '/rest/api/3/search/jql') { jira.searches++; jira.lastJql = JSON.parse(init.body).jql; return { issues: [] }; }
    if (p === '/rest/api/3/user?accountId=acc-2') return { accountId: 'acc-2', displayName: 'Thuy Ha', timeZone: 'Asia/Ho_Chi_Minh' };
    if (p.startsWith('/rest/api/3/user/search?')) {
      jira.lastUserSearch = p;
      return [
        { accountId: 'acc-2', displayName: 'Thuy Ha', accountType: 'atlassian', active: true, avatarUrls: { '24x24': 'https://a/24.png' } },
        { accountId: 'acc-3', displayName: 'Thuy Old', accountType: 'atlassian', active: false, avatarUrls: {} },
        { accountId: 'bot-1', displayName: 'Thuy Bot', accountType: 'app', active: true, avatarUrls: {} },
      ];
    }
    throw new Error(`unexpected ${p}`);
  };
  jira.searches = 0;
  jira.sprintSearches = 0;
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
    assert.deepEqual(first.body, { baseUrl: 'https://x.atlassian.net', timeZone: 'UTC', profileTimeZone: 'UTC', person: { accountId: ME, displayName: 'Me Myself' }, self: { accountId: ME, displayName: 'Me Myself' }, entries: [], sprint: { name: 'Core 18-26', start: '2026-09-23', end: '2026-10-07' } });
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

test('server fails when Jira returns no accountId', async () => {
  const server = await startServer(fakeJira({ timeZone: 'UTC' }));
  try {
    assert.equal((await get('/api/worklogs?month=2026-08')).status, 502);
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

const net = require('node:net');
test('server survives a malformed request target', async () => {
  const server = await startServer(fakeJira());
  try {
    const raw = await new Promise((resolve, reject) => {
      const s = net.connect(TEST_PORT, '127.0.0.1', () => s.end(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${TEST_PORT}\r\nConnection: close\r\n\r\n`));
      let buf = '';
      s.on('data', (c) => { buf += c; }).on('end', () => resolve(buf)).on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 500/);
    assert.equal((await get('/api/worklogs?month=2026-13')).status, 400);
  } finally { server.close(); }
});

test('server uses the tz query param instead of the profile timezone', async () => {
  const jira = fakeJira();
  const server = await startServer(jira);
  try {
    const r = await get('/api/worklogs?month=2026-08&tz=Asia/Ho_Chi_Minh');
    assert.equal(r.status, 200);
    assert.equal(r.body.timeZone, 'Asia/Ho_Chi_Minh');
    assert.equal(r.body.profileTimeZone, 'UTC');
    assert.equal((await get('/api/worklogs?month=2026-08')).body.timeZone, 'UTC');
    assert.equal(jira.searches, 2); // cached per month and timezone
    await get('/api/worklogs?month=2026-08&tz=Asia/Ho_Chi_Minh');
    assert.equal(jira.searches, 2);
    assert.equal((await get('/api/worklogs?month=2026-08&tz=Not/AZone')).status, 400);
  } finally { server.close(); }
});

const { adfText } = require('./server');

test('adfText flattens Jira ADF comments to plain text', () => {
  assert.equal(adfText(undefined), '');
  assert.equal(adfText({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Fixed ' }, { type: 'text', text: 'login', marks: [{ type: 'strong' }] }, { type: 'hardBreak' }, { type: 'text', text: 'with ' }, { type: 'mention', attrs: { text: '@Thuy' } }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
      { type: 'paragraph', content: [] },
    ],
  }), 'Fixed login\nwith @Thuy\nitem');
});

test('toEntries includes the worklog comment as plain text', () => {
  const w = { ...wl(ME, '2026-09-10T09:00:00.000+0000', 60), comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reviewed PR' }] }] } };
  assert.equal(toEntries(issues, { 'EF-1': [w] }, ME, '2026-09', 'UTC')[0].comment, 'Reviewed PR');
});

test('server shows another person with the account param', async () => {
  const jira = fakeJira();
  const server = await startServer(jira);
  try {
    const r = await get('/api/worklogs?month=2026-08&account=acc-2');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.person, { accountId: 'acc-2', displayName: 'Thuy Ha' });
    assert.deepEqual(r.body.self, { accountId: ME, displayName: 'Me Myself' }); // who "you" is, whoever is viewed
    assert.equal(r.body.profileTimeZone, 'Asia/Ho_Chi_Minh');
    assert.match(jira.lastJql, /^worklogAuthor = "acc-2" AND/);
    const mine = await get('/api/worklogs?month=2026-08');
    assert.deepEqual(mine.body.person, { accountId: ME, displayName: 'Me Myself' });
    assert.match(jira.lastJql, /^worklogAuthor = "me-123" AND/);
    assert.equal(jira.searches, 2); // cached per person
    assert.equal((await get('/api/worklogs?month=2026-08&account=bad%22id')).status, 400);
  } finally { server.close(); }
});

test('server searches active human users', async () => {
  const jira = fakeJira();
  const server = await startServer(jira);
  try {
    const r = await get('/api/users?q=th%20u');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ accountId: 'acc-2', displayName: 'Thuy Ha', avatarUrl: 'https://a/24.png' }]);
    assert.equal(jira.lastUserSearch, '/rest/api/3/user/search?query=th%20u&maxResults=20');
    assert.equal((await get('/api/users?q=')).status, 400);
    assert.equal((await get('/api/users')).status, 400);
  } finally { server.close(); }
});

test('fetchMonth uses worklogs embedded in search results and only fetches issues with more', async () => {
  const embedded = (worklogs, total = worklogs.length) => ({ startAt: 0, maxResults: 20, total, worklogs });
  const calls = [];
  const jira = async (p) => {
    calls.push(p);
    if (p === '/rest/api/3/search/jql') {
      return { issues: [
        { key: 'EF-1', fields: { ...issues[0].fields, worklog: embedded([wl(ME, '2026-09-01T09:00:00.000+0000', 3600)]) } },
        { key: 'OPS-2', fields: { ...issues[1].fields, worklog: embedded([wl(ME, '2026-09-02T09:00:00.000+0000', 60)], 21) } },
      ] };
    }
    if (p.startsWith('/rest/api/3/issue/OPS-2/worklog')) return { startAt: 0, total: 1, worklogs: [wl(ME, '2026-09-02T09:00:00.000+0000', 1800)] };
    throw new Error(`unexpected ${p}`);
  };
  const entries = await fetchMonth(jira, '2026-09', { accountId: ME, timeZone: 'UTC' });
  assert.deepEqual(entries.map((e) => [e.date, e.issueKey, e.seconds]), [['2026-09-01', 'EF-1', 3600], ['2026-09-02', 'OPS-2', 1800]]);
  assert.equal(calls.filter((c) => c.includes('/worklog')).length, 1); // EF-1 complete in search; OPS-2 had 21 > 1 shown
});

test('server adds the active Core sprint in the viewing timezone, cached, failure tolerated', async () => {
  const jira = fakeJira();
  const server = await startServer(jira);
  try {
    // 2026-09-23T06:27Z is 13:27 in Ho Chi Minh; 2026-10-07T06:27Z is 13:27 too.
    assert.deepEqual((await get('/api/worklogs?month=2026-08&tz=Asia/Ho_Chi_Minh')).body.sprint, { name: 'Core 18-26', start: '2026-09-23', end: '2026-10-07' });
    // Same instants seen from Los Angeles fall on the previous evening.
    assert.deepEqual((await get('/api/worklogs?month=2026-08&tz=America/Los_Angeles')).body.sprint, { name: 'Core 18-26', start: '2026-09-22', end: '2026-10-06' });
    assert.equal(jira.sprintSearches, 1); // cached
    await get('/api/worklogs?month=2026-08&refresh=1');
    assert.equal(jira.sprintSearches, 2); // refresh reloads it
  } finally { server.close(); }

  const noSprint = fakeJira();
  const broken = async (p, init) => (p === '/rest/api/3/field' ? Promise.reject(new JiraError('Jira 500 on /rest/api/3/field', 500)) : noSprint(p, init));
  const server2 = await startServer(broken);
  try {
    const r = await get('/api/worklogs?month=2026-08');
    assert.equal(r.status, 200);
    assert.equal(r.body.sprint, null);
  } finally { server2.close(); }
});

const { textToAdf } = require('./server');

test('textToAdf turns lines into ADF paragraphs and round-trips through adfText', () => {
  const doc = textToAdf('Dev – Fix login – PR opened\n\nSecond line');
  assert.deepEqual(doc, { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Dev – Fix login – PR opened' }] },
    { type: 'paragraph', content: [] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
  ] });
  assert.equal(adfText(doc), 'Dev – Fix login – PR opened\nSecond line');
});

function put(pathname, body, { origin = `http://localhost:${TEST_PORT}`, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { Host: `127.0.0.1:${TEST_PORT}`, 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) };
    if (origin) headers.Origin = origin;
    const req = http.request({ host: '127.0.0.1', port: TEST_PORT, path: pathname, method: 'PUT', headers, agent: false }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function editJira() {
  const base = fakeJira();
  const jira = async (p, init) => {
    if (p === '/rest/api/3/issue/UP-1/worklog/101') {
      if (!init?.method) return { id: '101', author: { accountId: ME }, timeSpentSeconds: 3600 };
      jira.puts.push({ p, body: JSON.parse(init.body) });
      return { id: '101', timeSpentSeconds: 5400, comment: JSON.parse(init.body).comment };
    }
    if (p === '/rest/api/3/issue/UP-1/worklog/202') return { id: '202', author: { accountId: 'someone-else' } };
    if (p.startsWith('/rest/api/3/issue/UP-1/worklog/101?')) {
      jira.puts.push({ p, method: init.method, body: JSON.parse(init.body) });
      return { id: '101', timeSpentSeconds: JSON.parse(init.body).timeSpentSeconds ?? 3600, comment: JSON.parse(init.body).comment };
    }
    return base(p, init);
  };
  jira.puts = [];
  jira.base = base;
  return jira;
}

test('server edits own worklog time and comment, leaving estimates and watchers alone', async () => {
  const jira = editJira();
  const server = await startServer(jira);
  try {
    await get('/api/worklogs?month=2026-08'); // past month gets cached
    assert.equal(jira.base.searches, 1);
    const r = await put('/api/worklogs/UP-1/101', { seconds: 5400, comment: 'Dev – Fix – Done' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: '101', seconds: 5400, comment: 'Dev – Fix – Done' });
    assert.equal(jira.puts.length, 1);
    assert.equal(jira.puts[0].method, 'PUT');
    assert.equal(jira.puts[0].p, '/rest/api/3/issue/UP-1/worklog/101?adjustEstimate=leave&notifyUsers=false');
    assert.deepEqual(jira.puts[0].body, { timeSpentSeconds: 5400, comment: textToAdf('Dev – Fix – Done') });
    await get('/api/worklogs?month=2026-08');
    assert.equal(jira.base.searches, 2); // cache dropped after the edit

    const timeOnly = await put('/api/worklogs/UP-1/101', { seconds: 1800 });
    assert.equal(timeOnly.status, 200);
    assert.deepEqual(jira.puts[1].body, { timeSpentSeconds: 1800 }); // comment untouched keeps its rich formatting
  } finally { server.close(); }
});

test('server refuses unsafe or invalid worklog edits', async () => {
  const jira = editJira();
  const server = await startServer(jira);
  try {
    assert.equal((await put('/api/worklogs/UP-1/202', { seconds: 60 })).status, 403); // someone else's worklog
    assert.equal((await put('/api/worklogs/UP-1/101', { seconds: 60 }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await put('/api/worklogs/UP-1/101', { seconds: 60 }, { origin: null })).status, 403);
    assert.equal((await put('/api/worklogs/UP-1/101', '{"seconds":60}', { type: 'text/plain' })).status, 415);
    assert.equal((await put('/api/worklogs/UP-1/101', '{bad json')).status, 400);
    assert.equal((await put('/api/worklogs/UP-1/101', {})).status, 400);
    assert.equal((await put('/api/worklogs/UP-1/101', { seconds: 30 })).status, 400);
    assert.equal((await put('/api/worklogs/UP-1/101', { seconds: 90000 })).status, 400);
    assert.equal((await put('/api/worklogs/UP-1/101', { comment: 'x'.repeat(5001) })).status, 400);
    assert.equal((await put('/api/worklogs/bad%20key/101', { seconds: 60 })).status, 404);
    assert.equal(jira.puts.length, 0);
  } finally { server.close(); }
});
