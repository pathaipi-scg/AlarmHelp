# AlarmHelp

Standalone, read-only operator alarm troubleshooting dashboard. AlarmHelp listens on port `1866` and proxies alarm/knowledge reads to OpcTagManager on port `1863`. Paginated history and Pareto use direct SELECT-only SQL Server access. It contains no Kepware, SQL, alarm-configuration, or Tag Knowledge write logic.

## Setup

From `D:\AI\AlarmHelp`:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `.env` if OpcTagManager is hosted elsewhere. `OPC_TAG_MANAGER_BASE_URL` is used by the AlarmHelp server, not by the browser, so tablet and TV clients never need localhost access to OpcTagManager.

Run with:

```powershell
.\AlarmHelp.bat
```

Open `http://<server>:1866`. Ensure TCP port 1866 is allowed through the host firewall. OpcTagManager provides runtime activity and Tag Knowledge. With SQL read access configured, history, Pareto, and SQL alarm details remain usable when it is unavailable.

## Configuration

```dotenv
ALARM_HELP_HOST=0.0.0.0
ALARM_HELP_PORT=1866
OPC_TAG_MANAGER_BASE_URL=http://127.0.0.1:1863
ALARM_HELP_UPSTREAM_TIMEOUT_SECONDS=8
```

The server intentionally provides GET routes only. Knowledge attachment reads are proxied so troubleshooting images load without browser CORS or localhost assumptions.

## Node-RED Dashboard integration

Add a button to **QC PAGES** with:

- Label: `ALARM HELP`
- URL: `http://10.28.255.19:1866`
- Action: open/navigate to URL using the same navigation or open-page action as the existing KM button
- Preferred target: a new browser tab or direct top-level navigation

Node-RED does not need to query OpcTagManager or reproduce this UI. The button only opens AlarmHelp. If the existing KM button uses a `ui-template`, use the same pattern and replace its label/URL with the values above.

Embedding is permitted by AlarmHelp's `frame-ancestors *` response policy, but an upstream reverse proxy or browser security policy may still restrict framing. Direct navigation is the supported primary integration.

## Validation

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node --check static\app.js
```

## History and Pareto

`GET /api/alarm-help/history?limit=50&before=<HistoryId>` returns `alarms`
and `next_cursor`. The default page is 50 rows, maximum 100. SQL reads one
extra row to determine the end. The exclusive `HistoryId < cursor` predicate
uses the existing clustered key and keeps descending order stable during inserts.
History IDs are JSON strings so SQL bigint values remain exact in JavaScript.
The browser merges by ID, preserves the visible scroll anchor, and retains its
older cursor across refreshes. If more than 50 new rows arrived, bounded requests
fill the gap down to the previous refresh watermark. Existing loaded rows are
retained; initial load never downloads the whole table.

`GET /api/alarm-help/pareto?window=24h` accepts `24h`, `48h`, `7d`, `30d`,
plus the existing UI aliases `1w` and `1m`.
One month means a rolling 30 days. SQL applies a sargable `CreatedTime` range
against `GETDATE()` (the same local clock used by the writer), then performs
`COUNT_BIG(*) GROUP BY AlarmId`, ordered by count descending and AlarmId for ties.
Only grouped results reach Python/browser. Percentages and cumulative percentages
use all groups; the chart displays the first 30 and the table displays every group.
The configured `AlarmId` distinguishes alarms even when their tag names match.
A representative stored TagPath labels each group; display text is not the key.
The inspected alarm_sound writer inserts once per activation transition, not per
poll or audio repeat. Historical data is never modified or deduplicated by writes.

Each successful newest-history poll compares its maximum ID with the previously
observed occurrence ID. Only a larger ID exits Pareto, pins the new occurrence,
scrolls history to the top, and requests its Tag Knowledge. Polling, priority
selection changes, values, clear transitions, and older pages do not trigger it.
A request generation counter prevents stale detail responses replacing a new alarm.
Detection follows the existing auto-refresh interval (10 seconds by default);
turning auto-refresh Off also stops automatic detection. No production runtime
subscriptions or alarm behavior were changed. Cleared alarms remain displayed.
Back to Alarm restores the detail from before Pareto; old row clicks while Pareto
is open leave that stored selection alone.

Existing activity, recent, latest and attachment routes remain. Latest/history
single-detail routes gain SQL fallback only when their upstream read fails.
Fallback reports unknown runtime state and unavailable knowledge instead of
inventing ACTIVE/CLEARED state. There are no write endpoints.

## SQL configuration and deployment prerequisite

Install the updated requirements in AlarmHelp's virtual environment. Microsoft
ODBC Driver 17 or later must be installed. Set the following in the untracked `.env`:

```dotenv
ALARM_HELP_SQL_ENV_FILE=D:/AI/OpcTagManager/config/.env
```

This reads only connection settings from the existing file with python-dotenv;
it does not import OpcTagManager or start its runtime. Credentials are not copied
into tracked files. Driver AUTO and TLS options follow its connection conventions.
Alternatively set `ALARM_HELP_SQL_CONNECTION_STRING`, which takes precedence.
The direct SQL history/Pareto reader only requires SELECT on `dbo.Alarm_History`.
It no longer joins `Alarm_Lists` for priority. The JSON priority default is 0 and
runtime state is UNKNOWN; neither is read from a nonexistent history column.
Connections and statements have 5-second and 8-second timeouts respectively.

The configuration reuse was verified against `OpcTagMgr` as
`opc_tag_manager_runtime`. Read-only history and Pareto queries succeed. An
isolated HTTP instance using the real SQL connection returned 200 for two
50-row history pages and all six window values. SQL permissions, schema, and
production services were not changed.

The reported 503 was reproduced at `10.28.255.19:1866`, but not in an isolated
HTTP instance of this checkout using the real SQL connection. No local process
listened on port 1866. The deployed service also returned an OpcTagManager
unavailable error from its legacy recent-history proxy. Its application files
were not accessible at the corresponding Windows-share path, so its exact
exception/configuration could not be inspected. None of the old queries
referenced nonexistent Alarm_History columns. The earlier history query
had an unnecessary `Alarm_Lists.Priority` dependency; that was removed, but it
was not a reproduced failure. The Pareto query already used verified columns.
The previous blanket exception handlers hid the useful diagnostic information.
They now log the original exception and traceback using the application logger,
with limit/cursor/window context, while returning a generic safe 503 JSON error.
SQL fallback failures are logged too. Connection strings are not logged.

If a deployed instance still returns 503, capture its server-side traceback and
confirm its checkout, Python environment, and SQL configuration source. Do not
infer a permission or schema problem from the generic HTTP status alone. No
production restart is performed by the tests or this implementation.

## Verified production schema and final queries

The production Alarm_History columns are `HistoryId`, `AlarmId`, `TagId`,
`TagPath`, `AlarmMode`, `ThresholdHigh`, `ThresholdLow`, `CurrentValue`, `Mp3File`,
and `CreatedTime`. The reader uses only this table. The response's `activated_at`
is derived from CreatedTime; `kepware_path` normalizes TagPath separators and
`tag_name` is its final segment. Those response keys are not SQL column names.

History reads `limit + 1` rows to determine whether another page exists:

```sql
SELECT TOP (?) h.HistoryId, h.AlarmId, h.TagPath,
       h.CurrentValue, h.CreatedTime
FROM dbo.Alarm_History h
WHERE h.HistoryId < ?
ORDER BY h.HistoryId DESC
```

The initial page omits WHERE; a selected occurrence uses `WHERE h.HistoryId = ?`.
The default limit of 50 returns up to 50 rows from a bounded 51-row SQL read.
HistoryId determines stable paging/order, while CreatedTime supplies the actual
occurrence timestamp shown by the UI.

```sql
DECLARE @end datetime = GETDATE();
SELECT AlarmId, MAX(TagPath) AS TagPath, COUNT_BIG(*) AS Occurrences
FROM dbo.Alarm_History
WHERE CreatedTime >= DATEADD(hour, ?, @end) AND CreatedTime <= @end
GROUP BY AlarmId
ORDER BY Occurrences DESC, AlarmId ASC
```

The parameter is -24, -48, -168, or -720 hours. AlarmId is the stable grouping
identity; TagPath is a representative source/display path. Percentages and
cumulative percentages use the total of every returned group, before chart
truncation. No table/schema/index change is required for correctness or applied
by this work. The earlier recommendation to review a CreatedTime covering index
for large tables remains optional and requires checking existing indexes/plans.

## Regression checks

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node --check static/app.js
node tests/test_ui.mjs
git diff --check
```

The UI suite uses Node 22+, a separate headless Chrome profile, an ephemeral
loopback server, and synthetic API responses. It never contacts production.
Set `CHROME_PATH` if Chrome is not installed at the standard Windows path.
Screenshots and results are written to ignored `.test-artifacts/`.
Backend tests cover mocked failures and execute queries against a local fixture
with the exact production column names (only SQL dialect syntax is translated).
The separate read-only HTTP smoke test also verified the real SQL Server results.
