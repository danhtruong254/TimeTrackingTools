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

module.exports = { normalizeStarted, localDate, monthRange, isPastMonth, toEntries };
