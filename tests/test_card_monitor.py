#!/usr/bin/env python3
"""Tests for the passive PC/SC card-presence observer."""

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


class FakeCard:
    def __init__(self, reader):
        self.reader = reader


class TestCardPresenceObserver(unittest.TestCase):
    def setUp(self):
        self.observer = S._CardPresenceObserver('Test Reader 00 00')
        self.server = types.SimpleNamespace(card_present=True)
        self.saved_ref = S._server_ref
        S._server_ref = self.server
        self.disconnects = []
        self.patcher = mock.patch.object(
            S, '_handle_card_disconnect',
            side_effect=lambda: self.disconnects.append(True))
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        S._server_ref = self.saved_ref

    def test_removal_of_our_reader_disconnects(self):
        self.observer.update(None, ([], [FakeCard('Test Reader 00 00')]))
        self.assertFalse(self.server.card_present)
        self.assertEqual(len(self.disconnects), 1)

    def test_removal_of_other_reader_ignored(self):
        self.observer.update(None, ([], [FakeCard('Other Reader 00 00')]))
        self.assertTrue(self.server.card_present)
        self.assertEqual(self.disconnects, [])

    def test_insertion_sets_card_present(self):
        self.server.card_present = False
        self.observer.update(None, ([FakeCard('Test Reader 00 00')], []))
        self.assertTrue(self.server.card_present)
        self.assertEqual(self.disconnects, [])

    def test_missing_reader_attribute_is_ignored(self):
        self.observer.update(None, ([], [types.SimpleNamespace()]))
        self.assertTrue(self.server.card_present)
        self.assertEqual(self.disconnects, [])


if __name__ == '__main__':
    unittest.main()
