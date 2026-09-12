#!/usr/bin/env python3
"""Tests for per-command APDU timing collection (card snapshot measurements)."""

import sys
import time
import types
import unittest
from pathlib import Path
from unittest import mock

PROJECTS = Path(__file__).resolve().parents[2]
PY_SIM = PROJECTS / 'pysim'
if str(PY_SIM) not in sys.path:
    sys.path.insert(0, str(PY_SIM))

import pysim_otaman_server.server as S


class TestClassifyApdu(unittest.TestCase):
    def test_select(self):
        self.assertEqual(S._classify_apdu('00a40004023f0000'), 'select')

    def test_read_binary(self):
        self.assertEqual(S._classify_apdu('00b000000a'), 'read_binary')

    def test_read_record(self):
        self.assertEqual(S._classify_apdu('00b2010428'), 'read_record')

    def test_other_not_classified(self):
        self.assertIsNone(S._classify_apdu('80f2000c00'))

    def test_short_input(self):
        self.assertIsNone(S._classify_apdu(''))
        self.assertIsNone(S._classify_apdu('00'))


class TestApduTimeCollection(unittest.TestCase):
    def setUp(self):
        self.saved = (S._APDU_TIME_COLLECT, list(S._APDU_TIMES), S._server_ref)
        S._APDU_TIME_COLLECT = False
        S._APDU_TIMES.clear()
        S._server_ref = None

    def tearDown(self):
        S._APDU_TIME_COLLECT, times, S._server_ref = self.saved
        S._APDU_TIMES[:] = times

    def test_disabled_does_not_collect(self):
        tracer = S.StderrApduTracer()
        with mock.patch.object(S.os, 'write'):
            tracer.trace_command('00a40004023f0000')
            tracer.trace_response('00a40004023f0000', '9000', '')
        self.assertEqual(S._APDU_TIMES, [])

    def test_collects_only_classified_commands_with_ms(self):
        S._collect_apdu_times()
        tracer = S.StderrApduTracer()
        with mock.patch.object(S.os, 'write'):
            tracer._cmd_start = time.time() - 0.025
            tracer.trace_response('00a40004023f0000', '9000', '')
            tracer._cmd_start = time.time() - 0.010
            tracer.trace_response('00b000000a', '9000', '')
            tracer._cmd_start = time.time() - 0.005
            tracer.trace_response('80f2000c00', '9000', '')
        times = S._end_apdu_time_collection()
        self.assertEqual([t['type'] for t in times], ['select', 'read_binary'])
        self.assertGreaterEqual(times[0]['ms'], 20)
        self.assertFalse(S._APDU_TIME_COLLECT)
        self.assertEqual(S._APDU_TIMES, [])

    def test_collect_reattaches_tracer_when_missing(self):
        tp = types.SimpleNamespace(apdu_tracer=None)
        scc = types.SimpleNamespace(_tp=tp)
        S._server_ref = types.SimpleNamespace(scc=scc)
        S._collect_apdu_times()
        try:
            self.assertIsInstance(tp.apdu_tracer, S._LoggingApduTracer)
        finally:
            S._end_apdu_time_collection()

    def test_collect_keeps_existing_tracer(self):
        tracer = S.StderrApduTracer()
        tp = types.SimpleNamespace(apdu_tracer=tracer)
        scc = types.SimpleNamespace(_tp=tp)
        S._server_ref = types.SimpleNamespace(scc=scc)
        S._collect_apdu_times()
        try:
            self.assertIs(tp.apdu_tracer, tracer)
        finally:
            S._end_apdu_time_collection()


if __name__ == '__main__':
    unittest.main()
