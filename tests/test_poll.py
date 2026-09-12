#!/usr/bin/env python3
"""Tests for the background STATUS polling interval semantics."""

import sys
import unittest
from pathlib import Path
from unittest import mock

PROJECTS = Path(__file__).resolve().parents[2]
PY_SIM = PROJECTS / 'pysim'
if str(PY_SIM) not in sys.path:
    sys.path.insert(0, str(PY_SIM))

import pysim_otaman_server.server as S


class TestPollInterval(unittest.TestCase):
    def setUp(self):
        self.saved = (S._POLL_ENABLED, S._POLL_INTERVAL, S._POLL_TIMER)

    def tearDown(self):
        S._poll_disable()
        S._POLL_ENABLED, S._POLL_INTERVAL, S._POLL_TIMER = self.saved

    def test_zero_interval_disables_polling(self):
        S._set_poll_interval(0)
        self.assertEqual(S._POLL_INTERVAL, 0)
        with mock.patch.object(S.threading, 'Timer') as timer:
            S._poll_enable()
            timer.assert_not_called()
        self.assertFalse(S._POLL_ENABLED)
        self.assertIsNone(S._POLL_TIMER)

    def test_negative_interval_clamped_to_zero(self):
        S._set_poll_interval(-5)
        self.assertEqual(S._POLL_INTERVAL, 0)

    def test_positive_interval_starts_timer(self):
        S._set_poll_interval(30)
        with mock.patch.object(S.threading, 'Timer') as timer:
            S._poll_enable()
            self.assertTrue(S._POLL_ENABLED)
            timer.assert_called_once_with(30, S._do_status_poll)

    def test_reset_timer_skipped_when_disabled(self):
        S._set_poll_interval(0)
        S._POLL_ENABLED = True
        with mock.patch.object(S.threading, 'Timer') as timer:
            S._reset_poll_timer()
            timer.assert_not_called()
        self.assertIsNone(S._POLL_TIMER)


if __name__ == '__main__':
    unittest.main()
