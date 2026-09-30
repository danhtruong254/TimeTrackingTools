# Jira Time Tracking Dashboard — Design

Date: 2026-09-30

## Goal

A local dashboard showing my own Jira Cloud worklogs, per month. Priorities, in order:

1. **Gaps** — see each day's logged hours against a daily target and spot under-logged days.
2. **Breakdown** — see where time went, per ticket and per project.
3. **Report** — copy a plain-text month summary to share.

Scope: only my own worklogs (the API token owner). Target is a per-weekday map, defaulting to 8h on every day of the week (Mon–Sun). Plain Jira worklogs, no Tempo.

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
- `GET /api/worklogs?month=YYYY-MM[&refresh=1]` returns
  `{ baseUrl, timeZone, entries: [{ date: "YYYY-MM-DD", issueKey, summary, project, seconds }] }`
  where `entries` is date-sorted, `baseUrl` is `JIRA_BASE_URL` (used for ticket links), and `timeZone` is the Jira profile timezone (used by the UI for "today").
- Jira credentials stay server-side; the browser never sees the token. Requests to Jira use Basic auth (`email:token`).
- The server is a thin proxy. All grouping (daily totals, per-ticket and per-project sums) happens in the browser.
- Startup: strip any trailing `/` from `JIRA_BASE_URL`.
- Host header check: every request whose `Host` header is not `127.0.0.1:3000` or `localhost:3000` gets 403. This mitigates DNS rebinding.

## Data flow (server)

For each `/api/worklogs?month=YYYY-MM` request:

0. If `month` is in the in-memory cache and `refresh=1` is not set, return the cached response.
1. `GET /rest/api/3/myself` gives my `accountId` and `timeZone` (Jira profile timezone). Both are cached in memory for the process lifetime.
2. `POST /rest/api/3/search/jql` with JQL
   `worklogAuthor = currentUser() AND worklogDate >= "<monthStart - 1 day>" AND worklogDate <= "<monthEnd + 1 day>"`,
   `fields: ["summary", "project"]`. Follow `nextPageToken` until exhausted.
   The range is widened by one day on each side as a safety margin; exact filtering happens in step 4.
3. For each issue, call `GET /rest/api/3/issue/{key}/worklog?startedAfter=<ms>&startedBefore=<ms>`, following `startAt`/`total` paging, with at most 5 requests in flight.
   - `startedAfter` is 00:00 UTC on `monthStart − 1 day`, in epoch ms.
   - `startedBefore` is 00:00 UTC on `monthEnd + 2 days`, in epoch ms. That instant is the end of `monthEnd + 1 day`.
   - This range covers the whole month in any timezone within ±24h of UTC. It also stops long-lived tickets from returning their entire worklog history for every user.
4. Pure function `toEntries(issues, worklogsByIssue, accountId, month, tz)` is the source of truth for filtering:
   - keep entries where `author.accountId === accountId`;
   - derive the local date of `started` with `Intl.DateTimeFormat` using `timeZone: tz` (the Jira profile timezone, never the machine's), and keep only dates inside `month`;
   - map to `{ date, issueKey, summary, project: project.key, seconds: timeSpentSeconds }`;
   - sort by date.
5. Build `{ baseUrl, timeZone, entries }`, store it in the cache under `month`, and respond with it as JSON.

In-memory cache: `Map<month, response>` in the server process. It is lost on restart and is not persistent. A `refresh=1` request bypasses the cache and overwrites the stored entry. Failed requests are never cached.

Endpoint shapes are verified against current Jira Cloud REST v3 docs during planning.

## UI (index.html)

Layout: calendar on the left, breakdown on the right, on one screen.

- **Config:** a per-weekday target map in hours, defined at the top of the `index.html` script:
  `const TARGETS = { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 8, Sun: 8 };`
  A day's target is `TARGETS[weekday]`.
- **Today:** the current date in the API's `timeZone`, derived with `Intl.DateTimeFormat`. The browser's timezone is not used.
- **Counted days:** days of the month up to and including yesterday that have a target > 0. For past months this is every such day in the month. Future months have none.
- **Header:** month label with ◀ ▶ buttons, Refresh button (sends `refresh=1`), "Copy summary" button, and a summary strip:
  - Logged: sum of all entries in the month, today included.
  - Target: sum of the targets of the counted days.
  - Gap days: counted days where logged < target.
  - Missing: sum over counted days of `max(0, target − logged)`.
- **Calendar grid:** Monday-first, 7 columns. Each cell shows the day number and hours logged. Colors:
  - green: counted day, logged ≥ target
  - amber: counted day, 0 < logged < target
  - red: counted day, logged = 0
  - neutral: day with target 0 (hours still shown; never red; excluded from gap days and missing)
  - in progress: today (distinct style; excluded from gap days and missing; its hours count toward Logged)
  - grey: future day
- **Breakdown panel:** horizontal bars sorted by hours, descending. Toggle between **Ticket** and **Project** grouping. Ticket keys link to `<baseUrl>/browse/<key>`.
- **Day selection:** clicking a day filters the breakdown to that day. A day-detail list (ticket, summary, hours) appears below the calendar. Clicking the selected day again clears the filter.
- **Copy summary:** writes plain text to the clipboard. The text contains:
  - the month totals;
  - one line per day up to and including today, with its total (today marked "in progress");
  - the per-ticket totals.
- **Durations:** all sums are done in seconds. Seconds are converted to text only at display time, by one shared function `fmt(seconds)` that returns strings such as `7h 45m`. The calendar, breakdown, summary strip and Copy summary all use `fmt`. Jira stores `timeSpentSeconds` in whole minutes, so a formatted total always equals the sum of its formatted lines.
- Changing month triggers a new fetch. Loading state shown while fetching.

## Error handling

- Missing env var at startup: exit with a message naming the missing variable.
- Invalid `month` query param: 400. Valid means it matches `^\d{4}-(0[1-9]|1[0-2])$`.
- Wrong `Host` header: 403.
- Jira 401/403: API responds with `{ error, status }`; UI shows banner "Check JIRA_EMAIL / JIRA_API_TOKEN".
- Jira 429: retry once. Wait `Retry-After` seconds, or 2s if the header is missing, and never more than 30s. If the retry fails too, return the error.
- Timeouts: every Jira request uses `AbortSignal.timeout(15000)`. A timeout returns an error response.
- Partial failure: if the worklog fetch fails for any issue (after the 429 retry), the whole request fails. The server never returns partial data, because partial data creates fake gaps.
- Any failure: UI shows an error banner and keeps the last good data. The UI never renders an empty calendar on error, since "0h everywhere" would look like real gaps.

## Testing

`node --test` runs `server.test.js`, which covers `toEntries`. Every test passes `tz` explicitly (for example `"Asia/Ho_Chi_Minh"` and `"UTC"`), so results never depend on the test machine's `TZ`.

- drops worklogs by other authors;
- drops worklogs whose local date falls outside the month (including the widened ±1 day);
- timezone edge where the `started` offset differs from `tz`: `2026-09-30T23:30:00.000+0000` gives `2026-10-01` with `tz = "Asia/Ho_Chi_Minh"`, so it is excluded from month `2026-09` and included in `2026-10`. The same value gives `2026-09-30` with `tz = "UTC"`.
- multiple worklogs on the same issue and day are all returned (summing is the UI's job).

UI aggregation is small and checked manually in the browser. No UI test framework.

## Out of scope

- Other users or team views.
- Tempo integration.
- Holidays or leave handling.
- CSV export, persistent cache, database.
- Creating or editing worklogs.
