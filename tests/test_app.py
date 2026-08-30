import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app


class AlarmHelpTests(unittest.TestCase):
    def test_operator_page_is_read_only_and_collapsed_by_default(self):
        html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="workspace" class="workspace history-collapsed"', html)
        self.assertIn('id="open-history" class="open-history"', html)
        self.assertIn('<th>Time</th><th>Tag Name</th>', html)
        for forbidden in ("Open Tag", "Save", "Delete", "Alarm Configuration", "Knowledge editing"):
            self.assertNotIn(forbidden, html)

    def test_javascript_preserves_history_and_latest_workflows(self):
        javascript = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn('fetchJson("/api/alarm-help/latest")', javascript)
        self.assertIn('fetchJson("/api/alarm-help/recent?limit=5")', javascript)
        self.assertIn('loadHistoryDetail(alarm.history_id)', javascript)
        self.assertIn('classList.toggle("selected"', javascript)
        self.assertIn('setHistoryOpen(true)', javascript)
        self.assertIn('setHistoryOpen(false)', javascript)
        self.assertIn('Back to Latest Alarm', (ROOT / "templates" / "index.html").read_text(encoding="utf-8"))

    def test_only_expected_get_routes_are_exposed(self):
        routes = {(method, route.path) for route in app.app.routes for method in getattr(route, "methods", set())}
        self.assertIn(("GET", "/api/alarm-help/latest"), routes)
        self.assertIn(("GET", "/api/alarm-help/history/{history_id}"), routes)
        self.assertFalse(any(method in {"POST", "PUT", "PATCH", "DELETE"} for method, _path in routes))

    @patch("app.urlopen")
    def test_proxy_uses_configured_upstream_and_get_only(self, open_url):
        upstream = MagicMock()
        upstream.__enter__.return_value = upstream
        upstream.status = 200
        upstream.read.return_value = b'{"has_alarm":false}'
        upstream.headers.get.return_value = "application/json"
        open_url.return_value = upstream
        response = app.upstream_get("/api/alarm-help/recent", {"limit": 5})
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertTrue(request.full_url.startswith(app.UPSTREAM_BASE_URL))
        self.assertIn("/api/alarm-help/recent?limit=5", request.full_url)
        self.assertEqual(response.status_code, 200)

    def test_documented_node_red_target(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("ALARM HELP", readme)
        self.assertIn("http://10.28.255.19:1866", readme)


if __name__ == "__main__":
    unittest.main()
