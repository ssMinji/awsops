"""Tests for aws_istio_mcp (Steampipe CRD-table variant) — the namespace argument is the only
caller-controlled string interpolated into SQL, so pin the RFC 1123 allowlist guard: valid labels
pass through verbatim, anything else 400s before run_sql is reached. pg8000 is stubbed via
sys.modules (no live Steampipe), mirroring the other lambda test loaders."""
import json
import os
import sys
import types
import unittest
from unittest import mock

sys.modules.setdefault("pg8000", types.SimpleNamespace(connect=lambda **kw: None))
sys.path.insert(0, os.path.dirname(__file__))
import aws_istio_mcp as im  # noqa: E402


class TestNamespaceGuard(unittest.TestCase):
    def _call(self, tool, **args):
        with mock.patch.object(im, "run_sql", side_effect=lambda sql: {"sql": sql, "rows": [], "count": 0}) as rs:
            out = im.lambda_handler({"tool_name": tool, "arguments": args}, None)
        return out, rs

    def test_valid_namespace_reaches_sql_verbatim(self):
        out, rs = self._call("list_virtual_services", namespace="bookinfo-prod")
        self.assertEqual(out["statusCode"], 200)
        self.assertIn("WHERE namespace = 'bookinfo-prod'", rs.call_args[0][0])

    def test_injection_string_is_rejected_before_sql(self):
        out, rs = self._call("list_virtual_services", namespace="x' UNION SELECT usename, passwd, '' FROM pg_shadow --")
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("invalid namespace", json.loads(out["body"])["error"])
        rs.assert_not_called()

    def test_non_label_chars_rejected(self):
        for bad in ("Bookinfo", "book_info", "-lead", "trail-", "a" * 64):
            out, rs = self._call("list_destination_rules", namespace=bad)
            self.assertEqual(out["statusCode"], 400, bad)
            rs.assert_not_called()

    def test_empty_namespace_means_no_filter(self):
        out, rs = self._call("list_service_entries")
        self.assertEqual(out["statusCode"], 200)
        self.assertNotIn("WHERE namespace", rs.call_args[0][0])


if __name__ == "__main__":
    unittest.main()
