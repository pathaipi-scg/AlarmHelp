# AlarmHelp

Standalone, read-only operator alarm troubleshooting dashboard. AlarmHelp listens on port `1866` and proxies only the required read operations to OpcTagManager on port `1863`. It contains no Kepware, SQL, alarm-configuration, or Tag Knowledge write logic.

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

Open `http://<server>:1866`. Ensure TCP port 1866 is allowed through the host firewall. OpcTagManager must remain available to the AlarmHelp host at the configured base URL.

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
