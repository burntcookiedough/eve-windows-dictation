"""Checks for safe hosted console diagnostics and smoke retry selection."""

import unittest

from scripts.sim_acceptance.hosted import (
    FixtureUnavailable,
    fixture_reason,
    poll,
    smoke_delivery_issue,
)


class FixtureDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_startup_poll_reports_the_named_fixture(self):
        with self.assertRaises(FixtureUnavailable) as caught:
            await poll(None, bool, 0, failure="cdp-http-unreachable")
        self.assertEqual(fixture_reason(caught.exception), "cdp-http-unreachable")

    def test_arbitrary_exception_text_is_not_exposed(self):
        self.assertEqual(fixture_reason(FixtureUnavailable("untrusted text")), "unspecified-fixture")
        self.assertEqual(fixture_reason(OSError("untrusted text")), "OSError")

    def test_smoke_distinguishes_pre_dispatch_skip_and_native_editor_failure(self):
        skipped = {
            "failed": True, "insert_matches_final": False, "delivery": "paste_skipped",
            "paste_helper_request_observed": False,
        }
        self.assertEqual(smoke_delivery_issue(skipped, True), "warmup-paste-skipped-before-helper")
        self.assertEqual(smoke_delivery_issue(skipped, False), "warmup-native-editor-control-unobserved")
        skipped["paste_helper_request_observed"] = True
        self.assertEqual(smoke_delivery_issue(skipped, True), "warmup-editor-insertion-unobserved")
