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
