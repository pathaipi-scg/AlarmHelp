import json
import logging
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from fastapi import FastAPI, Query, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import history_store


ROOT = Path(__file__).resolve().parent
logger = logging.getLogger(__name__)


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(ROOT / ".env")
UPSTREAM_BASE_URL = os.getenv("OPC_TAG_MANAGER_BASE_URL", "http://127.0.0.1:1863").rstrip("/")
UPSTREAM_TIMEOUT_SECONDS = float(os.getenv("ALARM_HELP_UPSTREAM_TIMEOUT_SECONDS", "8"))

if urlparse(UPSTREAM_BASE_URL).scheme not in {"http", "https"}:
    raise RuntimeError("OPC_TAG_MANAGER_BASE_URL must use http or https")

app = FastAPI(title="AlarmHelp", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.middleware("http")
async def operator_display_headers(request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = "frame-ancestors *"
    response.headers["Cache-Control"] = "no-store"
    return response


def upstream_get(path: str, query: dict | None = None) -> Response:
    suffix = path + (("?" + urlencode(query, doseq=True)) if query else "")
    request = Request(urljoin(UPSTREAM_BASE_URL + "/", suffix.lstrip("/")), method="GET")
    try:
        with urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as upstream:
            content = upstream.read()
            content_type = upstream.headers.get("Content-Type", "application/octet-stream")
            return Response(content=content, status_code=upstream.status, media_type=content_type.split(";", 1)[0])
    except HTTPError as exc:
        content = exc.read()
        content_type = exc.headers.get("Content-Type", "application/json")
        return Response(content=content, status_code=exc.code, media_type=content_type.split(";", 1)[0])
    except (URLError, TimeoutError, OSError):
        return JSONResponse({"error": "OpcTagManager is unavailable."}, status_code=503)


@app.get("/", response_class=HTMLResponse)
def index():
    return (ROOT / "templates" / "index.html").read_text(encoding="utf-8")


@app.get("/api/alarm-help/activity")
def activity():
    return upstream_get("/api/alarm-help/activity")


@app.get("/api/alarm-help/latest")
def latest():
    response = upstream_get("/api/alarm-help/latest")
    return sql_detail_fallback(response)


@app.get("/api/alarm-help/recent")
def recent(limit: int = Query(default=5, ge=1, le=100)):
    return upstream_get("/api/alarm-help/recent", {"limit": limit})


def sql_detail_fallback(response, history_id=None):
    if response.status_code >= 400 and history_store.configured():
        try:
            rows = history_store.history_page(limit=1, history_id=history_id)["alarms"]
            return {"has_alarm": bool(rows), "alarm": rows[0] if rows else None,
                    "knowledge": None, "knowledge_unavailable": True}
        except Exception:
            logger.exception("SQL alarm detail fallback failed (history_id=%s)", history_id)
    return response


@app.get("/api/alarm-help/history")
def history_list(limit: int = Query(default=50, ge=1, le=100),
                 before: int | None = Query(default=None, ge=1, le=9223372036854775807)):
    try:
        return history_store.history_page(limit, before)
    except Exception:
        logger.exception("SQL alarm history read failed (limit=%s, before=%s)", limit, before)
        return JSONResponse({"error": "SQL alarm history is unavailable."}, status_code=503)


@app.get("/api/alarm-help/pareto")
def pareto(window: str = Query(default="24h", pattern="^(24h|48h|1w|7d|1m|30d)$")):
    try:
        return history_store.pareto(window)
    except Exception:
        logger.exception("SQL alarm Pareto read failed (window=%s)", window)
        return JSONResponse({"error": "SQL alarm Pareto is unavailable."}, status_code=503)


@app.get("/api/alarm-help/history/{history_id}")
def history(history_id: int):
    response = upstream_get(f"/api/alarm-help/history/{history_id}")
    return sql_detail_fallback(response, history_id)


@app.get("/api/tag-knowledge/attachment")
def knowledge_attachment(
    channel: str, device: str, tag_name: str, relative_path: str,
    group_path: list[str] = Query(default=[]),
):
    return upstream_get("/api/tag-knowledge/attachment", {
        "channel": channel, "device": device, "group_path": group_path,
        "tag_name": tag_name, "relative_path": relative_path,
    })


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.getenv("ALARM_HELP_HOST", "0.0.0.0"),
        port=int(os.getenv("ALARM_HELP_PORT", "1866")),
        reload=False,
    )
