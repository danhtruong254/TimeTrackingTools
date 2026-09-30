# Jira Time Tracking Dashboard — Design

Date: 2026-09-30

## Goal

A local dashboard showing my own Jira Cloud worklogs, per month. Priorities, in order:

1. **Gaps** — see each day's logged hours against an 8h target and spot under-logged days.
2. **Breakdown** — see where time went, per ticket and per project.
3. **Report** — copy a plain-text month summary to share.

Scope: only my own worklogs (the API token owner). Target is 8h on every day of the week (Mon–Sun). Plain Jira worklogs, no Tempo.

## Architecture

```
TimeTrackingTools/
  server.js       Node 18+, built-in http + fetch, no npm dependencies
  index.html      UI: inline CSS + JS, no framework, no build step
  .env.example    JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
  server.test.js  node:test tests for worklog filtering
  .gitignore      .env, .superpowers/
```

- Run: `node --env-file=.env server.js`, listens on `127.0.0.1:3000` only.
- `GET /` serves `index.html`.
- `GET /api/worklogs?month=YYYY-MM` returns
  `{ baseUrl, entries: [{ date: "YYYY-MM-DD", issueKey, summary, project, seconds }] }`
  where `entries` is date-sorted and `baseUrl` is `JIRA_BASE_URL` (used for ticket links).
- Jira credentials stay server-side; the browser never sees the token. Requests to Jira use Basic auth (`email:token`).
- The server is a thin proxy. All grouping (daily totals, per-ticket and per-project sums) happens in the browser.

## Data flow (server)

For each `/api/worklogs?month=YYYY-MM` request:

1. `GET /rest/api/3/myself` gives my `accountId`. Cached in memory for the process lifetime.
2. `POST /rest/api/3/search/jql` with JQL
   `worklogAuthor = currentUser() AND worklogDate >= "<monthStart - 1 day>" AND worklogDate <= "<monthEnd + 1 day>"`,
   `fields: ["summary", "project"]`. Follow `nextPageToken` until exhausted.
   The range is widened by one day on each side because JQL evaluates dates in the Jira profile timezone; exact filtering happens in step 4.
3. For each issue, `GET /rest/api/3/issue/{key}/worklog`, following `startAt`/`total` paging. Max 5 requests in flight.
4. Pure function `toEntries(issues, worklogsByIssue, accountId, month)`:
   - keep entries where `author.accountId === accountId`;
   - convert `started` to a local date (the machine's timezone) and keep only dates inside `month`;
   - map to `{ date, issueKey, summary, project: project.key, seconds: timeSpentSeconds }`;
   - sort by date.
5. Respond with `{ baseUrl, entries }` as JSON.

Endpoint shapes are verified against current Jira Cloud REST v3 docs during planning.

## UI (index.html)

Layout: calendar on the left, breakdown on the right, on one screen.

- **Header:** month label with ◀ ▶ buttons, Refresh button, "Copy summary" button, and a summary strip:
  - Logged vs target: target = counted days × 8h, where counted days = days of the month up to and including today (all days for past months, none for future months).
  - Gap days: counted days with < 8h.
  - Missing hours: sum over counted days of `max(0, 8h − logged)`.
- **Calendar grid:** Monday-first, 7 columns. Each cell shows day number and hours logged. Colors:
  - green: ≥ 8h
  - amber: > 0h and < 8h
  - red: 0h
  - grey: future day (not counted)
- **Breakdown panel:** horizontal bars sorted by hours, descending. Toggle between **Ticket** and **Project** grouping. Ticket keys link to `<baseUrl>/browse/<key>`.
- **Day selection:** clicking a day filters the breakdown to that day and shows a day-detail list (ticket, summary, hours) below the calendar. Clicking the selected day again clears the filter.
- **Copy summary:** writes plain text to the clipboard — month totals, one line per counted day with its total, then per-ticket totals.
- Changing month triggers a new fetch. Loading state shown while fetching.

## Error handling

- Missing env var at startup: exit with a message naming the missing variable.
- Invalid `month` query param: 400.
- Jira 401/403: API responds with `{ error, status }`; UI shows banner "Check JIRA_EMAIL / JIRA_API_TOKEN".
- Jira 429: retry once after `Retry-After` seconds; on second failure, return the error.
- Any other failure: UI shows an error banner and keeps the last good data. The UI never renders an empty calendar on error, since "0h everywhere" would look like real gaps.

## Testing

`node --test` running `server.test.js`, covering `toEntries`:

- drops worklogs by other authors;
- drops worklogs whose local date falls outside the month (including the widened ±1 day);
- timezone edge: a worklog started near midnight lands on the correct local date;
- multiple worklogs on the same issue and day are all returned (summing is the UI's job).

UI aggregation is small and checked manually in the browser. No UI test framework.

## Out of scope

- Other users or team views.
- Tempo integration.
- Holidays or leave handling.
- CSV export, persistent cache, database.
- Creating or editing worklogs.
