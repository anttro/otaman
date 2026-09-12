#!/usr/bin/env python3
"""Tests for the paused-command (STK menu) timeout watchdog."""

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

PROJECTS = Path(__file__).resolve().parents[2]
PY_SIM = PROJECTS / 'pysim'
if str(PY_SIM) not in sys.path:
    sys.path.insert(0, str(PY_SIM))

import pysim_otaman_server.server as S


class TestMenuTimeout(unittest.TestCase):
    def setUp(self):
        self.saved = (S._MENU_TIMEOUT, S._MENU_TIMER)

    def tearDown(self):
        S._cancel_menu_timeout()
        S._MENU_TIMEOUT, S._MENU_TIMER = self.saved

    def test_clamped(self):
        S._set_menu_timeout(30)
        self.assertEqual(S._MENU_TIMEOUT, 30)
        S._set_menu_timeout(0)
        self.assertEqual(S._MENU_TIMEOUT, 0)
        S._set_menu_timeout(-1)
        self.assertEqual(S._MENU_TIMEOUT, 0)
        S._set_menu_timeout(99999)
        self.assertEqual(S._MENU_TIMEOUT, 3600)

    def test_arm_starts_timer(self):
        S._set_menu_timeout(30)
        with mock.patch.object(S.threading, 'Timer') as timer:
            S._arm_menu_timeout()
            timer.assert_called_once_with(30, S._menu_timeout_fire)

    def test_zero_disables_arming(self):
        S._set_menu_timeout(0)
        with mock.patch.object(S.threading, 'Timer') as timer:
            S._arm_menu_timeout()
            timer.assert_not_called()

    def test_cancel(self):
        timer = mock.Mock()
        S._MENU_TIMER = timer
        S._cancel_menu_timeout()
        timer.cancel.assert_called_once()
        self.assertIsNone(S._MENU_TIMER)


class TestMenuSendResponse(unittest.TestCase):
    def test_timeout_tr_is_flat_with_general_result(self):
        sent = []

        def send_apdu(hexstr):
            sent.append(hexstr)
            return ('', '9000')

        server = types.SimpleNamespace(
            stk_pending={'type': 'display_text', 'cmd_num': 1, 'cmd_type': 0x21,
                         'dev_src': 0x81, 'dev_dst': 0x83},
            menu_active=True,
            scc=types.SimpleNamespace(cat_cla='80', _tp=types.SimpleNamespace(send_apdu=send_apdu)),
        )
        resp, code = S._menu_send_response(server, 'timeout', None)
        self.assertEqual(code, 200)
        self.assertEqual(resp['sw'], '9000')
        self.assertEqual(resp['type'], 'done')
        self.assertIsNone(server.stk_pending)
        self.assertFalse(server.menu_active)
        tr = sent[0]
        self.assertTrue(tr.startswith('801400000d'), tr)
        self.assertIn('8103012100', tr)
        self.assertIn('82028381', tr)
        self.assertIn('83021200', tr)

    def test_no_pending_returns_400(self):
        resp, code = S._menu_send_response(types.SimpleNamespace(stk_pending=None), 'ok')
        self.assertEqual(code, 400)
        self.assertIn('error', resp)


if __name__ == '__main__':
    unittest.main()
