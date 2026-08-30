import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from fastapi import FastAPI, Query, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent


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
    return upstream_get("/api/alarm-help/latest")


@app.get("/api/alarm-help/recent")
def recent(limit: int = Query(default=5, ge=1, le=100)):
    return upstream_get("/api/alarm-help/recent", {"limit": limit})


@app.get("/api/alarm-help/history/{history_id}")
def history(history_id: int):
    return upstream_get(f"/api/alarm-help/history/{history_id}")


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
