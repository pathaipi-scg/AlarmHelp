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

`GET /api/alarm-help/pareto?window=24h` accepts `24h`, `48h`, `1w`, `1m`.
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
Use an account with SELECT on `dbo.Alarm_History` and `dbo.Alarm_Lists`.
Connections and statements have 5-second and 8-second timeouts respectively.

The authorized configuration reuse was set locally. A live read-only smoke test
connected successfully, but SQL Server denied SELECT on `dbo.Alarm_History`
(error 229). A database administrator must grant that permission to the configured
SQL database user before the new features can read production history:

```sql
-- Review the database principal name before execution. Not applied automatically.
USE [OpcTagMgr];
GRANT SELECT ON OBJECT::dbo.Alarm_History TO [configured_database_user];
-- Also required if the account does not already have this permission:
GRANT SELECT ON OBJECT::dbo.Alarm_Lists TO [configured_database_user];
```

No table/schema changes are required. No index or permission changes were applied.
The checked-in upstream schema has a clustered primary key on HistoryId but no
CreatedTime index. Live index inspection was inconclusive because the login lacks
table visibility. After inspecting existing production indexes, a DBA should
consider a covering nonclustered index on `(CreatedTime)` including `(AlarmId,
TagPath)` to support large time-range aggregations. Review storage/write overhead
and the query plan first; this is a recommendation, not an applied migration.

Production was not restarted, simulated, committed, or pushed. After permissions
are granted, verify bounded history and time-window aggregation on the real database
and schedule the normal AlarmHelp restart separately.

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
Backend unit tests mock SQL connections; they do not claim live database validation.
