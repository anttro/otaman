#!/usr/bin/env python3
"""Unit tests for the HTTP OTA (SCP81) BIP terminal emulation (Phase A).

TR byte vectors come from the captured real-terminal traces in
samples/HTTP_OTA/traces (OPEN CHANNEL success/failure, SEND/RECEIVE/CLOSE).
No live card or live card data is used here.
"""

import socket
import sys
import threading
import time
import unittest
from pathlib import Path

PROJECTS = Path(__file__).resolve().parents[2]
PY_SIM = PROJECTS / 'pysim'
if str(PY_SIM) not in sys.path:
    sys.path.insert(0, str(PY_SIM))

from pysim_otaman_server import httpota
import pysim_otaman_server.server as server


OPEN_LOCALHOST = bytes.fromhex(
    'd02b010301400102028182050035010339020200470b076d656761666f6e2e7275'
    '3c03021f903e05217f000001')

TR_OPEN_OK = '0103014001020282810301003802810035010339020200'
TR_OPEN_FAIL = '01030140010202828103023a0035010339020200'


class PeerServer(threading.Thread):
    """Tiny TCP peer: accepts one connection, greets, records what it receives."""

    def __init__(self, greeting=b''):
        super().__init__(daemon=True)
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(('127.0.0.1', 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.greeting = greeting
        self.received = b''
        self.conn = None
        self.ready = threading.Event()
        self.done = threading.Event()

    def run(self):
        self.sock.settimeout(3)
        try:
            self.conn, _ = self.sock.accept()
        except OSError:
            return
        self.ready.set()
        if self.greeting:
            self.conn.sendall(self.greeting)
        self.conn.settimeout(2)
        deadline = time.time() + 3
        try:
            while time.time() < deadline:
                try:
                    data = self.conn.recv(4096)
                except socket.timeout:
                    break
                if not data:
                    break
                self.received += data
        except OSError:
            pass
        self.done.set()

    def stop(self):
        self.sock.close()


def open_cmd(host, port, buffer_size=512):
    ip = bytes(int(x) for x in host.split('.'))
    tlvs = (b'\x81\x03\x01\x40\x01'
            b'\x82\x02\x81\x82'
            b'\x35\x01\x03'
            b'\x39\x02' + buffer_size.to_bytes(2, 'big') +
            b'\x3c\x03\x02' + port.to_bytes(2, 'big') +
            b'\x3e\x05\x21' + ip)
    return b'\xd0' + bytes([len(tlvs)]) + tlvs


def channel_cmd(cmd_type, qualifier, data_tlvs=b''):
    tlvs = (bytes([0x81, 0x03, 0x01, cmd_type, qualifier]) +
            b'\x82\x02\x81\x21' + data_tlvs)
    return b'\xd0' + bytes([len(tlvs)]) + tlvs


class TlvTest(unittest.TestCase):
    def test_proactive_tlvs_open_channel(self):
        tlvs = httpota.proactive_tlvs(OPEN_LOCALHOST)
        self.assertEqual(tlvs[httpota.TAG_BEARER], b'\x03')
        self.assertEqual(tlvs[httpota.TAG_BUFFER_SIZE], b'\x02\x00')
        self.assertEqual(tlvs[httpota.TAG_NAA], b'\x07megafon.ru')
        self.assertEqual(httpota.parse_transport_level(tlvs[httpota.TAG_TRANSPORT_LEVEL]), (0x02, 8080))
        self.assertEqual(httpota.parse_other_address(tlvs[httpota.TAG_OTHER_ADDRESS]), '127.0.0.1')


class TrVectorTest(unittest.TestCase):
    def test_open_channel_success_vector(self):
        extra = bytes([0x38, 0x02, 0x81, 0x00]) + bytes([0x35, 0x01, 0x03]) + bytes([0x39, 0x02, 0x02, 0x00])
        tr = server._bip_tr(1, 0x40, 0x01, 0x81, 0x82, 0x00, None, extra)
        self.assertEqual(tr.hex(), TR_OPEN_OK)

    def test_open_channel_failure_vector(self):
        extra = bytes([0x35, 0x01, 0x03]) + bytes([0x39, 0x02, 0x02, 0x00])
        tr = server._bip_tr(1, 0x40, 0x01, 0x81, 0x82, 0x3A, 0x00, extra)
        self.assertEqual(tr.hex(), TR_OPEN_FAIL)

    def test_disabled_bip_fails_open_channel(self):
        old = server._BIP
        try:
            server._BIP = httpota.BipTerminal()
            tr = server._handle_bip_command(None, 1, 0x40, 0x01, OPEN_LOCALHOST, 0x81, 0x82)
            self.assertEqual(tr.hex(), TR_OPEN_FAIL)
        finally:
            server._BIP = old


class BipTerminalTest(unittest.TestCase):
    def test_redirect_and_roundtrip(self):
        peer = PeerServer(greeting=b'SERVERHELLO')
        peer.start()
        bip = httpota.BipTerminal()
        bip.enable('127.0.0.1', peer.port)
        cid, err = bip.open('10.9.9.9', 1234, 512)
        self.assertIsNone(err)
        self.assertEqual(bip.channels[cid].requested, '10.9.9.9:1234')
        self.assertEqual(bip.channels[cid].target, ('127.0.0.1', peer.port))
        self.assertTrue(bip.send(cid, b'CLIENTHELLO'))
        data = b''
        for _ in range(20):
            data = bip.receive(cid, 100)
            if data:
                break
            time.sleep(0.05)
        self.assertEqual(data, b'SERVERHELLO')
        self.assertTrue(bip.close(cid))
        peer.done.wait(3)
        self.assertEqual(peer.received, b'CLIENTHELLO')
        kinds = [e['kind'] for e in bip.entries_after(0)]
        self.assertIn('open', kinds)
        self.assertIn('send', kinds)
        self.assertIn('receive', kinds)
        self.assertIn('close', kinds)
        peer.stop()

    def test_disabled_terminal_refuses_open(self):
        bip = httpota.BipTerminal()
        cid, err = bip.open('127.0.0.1', 1, 512)
        self.assertIsNone(cid)
        self.assertIn('disabled', err)

    def test_dump_server_logs_received_bytes(self):
        received = []
        dump = httpota.TcpDumpServer('127.0.0.1', 0, on_rx=lambda peer, data: received.append(data))
        c = socket.create_connection(('127.0.0.1', dump.port), timeout=2)
        c.sendall(b'HELLOCARD')
        deadline = time.time() + 2
        while time.time() < deadline and not received:
            time.sleep(0.02)
        c.close()
        dump.stop()
        self.assertEqual(b''.join(received), b'HELLOCARD')


def parse_tr(tr):
    """Parse a BIP TERMINAL RESPONSE payload into {tag: value}."""
    out = {}
    off = 0
    while off + 1 < len(tr):
        tag, ln = tr[off], tr[off + 1]
        out[tag] = tr[off + 2:off + 2 + ln]
        off += 2 + ln
    return out


class BipCommandFlowTest(unittest.TestCase):
    def setUp(self):
        self.peer = PeerServer(greeting=b'SERVERHELLO')
        self.peer.start()
        self.old = server._BIP
        self.bip = httpota.BipTerminal()
        self.bip.enable('127.0.0.1', self.peer.port)
        server._BIP = self.bip

    def tearDown(self):
        server._BIP = self.old
        self.peer.stop()

    def test_open_send_receive_close_flow(self):
        tr = server._handle_bip_command(None, 1, 0x40, 0x01, open_cmd('127.0.0.1', self.peer.port), 0x81, 0x82)
        self.assertEqual(tr.hex(), TR_OPEN_OK)

        tr = server._handle_bip_command(None, 1, 0x43, 0x01,
                                        channel_cmd(0x43, 0x01, bytes([0x36, 0x08]) + b'CLIENTHE'),
                                        0x81, 0x21)
        tlvs = parse_tr(tr)
        self.assertEqual(tlvs[0x01].hex(), '014301')
        self.assertEqual(tlvs[0x02].hex(), '8281')
        self.assertEqual(tlvs[0x03], b'\x00')
        self.assertEqual(tlvs[0x37], b'\xff')

        data = b''
        for _ in range(20):
            tr = server._handle_bip_command(None, 1, 0x42, 0x00, channel_cmd(0x42, 0x00, bytes([0x37, 0x01, 0x64])), 0x81, 0x21)
            tlvs = parse_tr(tr)
            if 0x36 in tlvs and tlvs[0x36]:
                data += tlvs[0x36]
                break
            time.sleep(0.05)
        self.assertEqual(data, b'SERVERHELLO')
        self.assertEqual(tlvs[0x37], b'\x00')

        tr = server._handle_bip_command(None, 1, 0x41, 0x00, channel_cmd(0x41, 0x00), 0x81, 0x21)
        self.assertEqual(tr.hex(), '010301410002028281030100')
        self.peer.done.wait(3)
        self.assertEqual(self.peer.received, b'CLIENTHE')

    def test_send_without_channel_fails(self):
        tr = server._handle_bip_command(None, 1, 0x43, 0x01,
                                        channel_cmd(0x43, 0x01, bytes([0x36, 0x01]) + b'X'),
                                        0x81, 0x21)
        tlvs = parse_tr(tr)
        self.assertEqual(tlvs[0x03].hex(), '3a00')


if __name__ == '__main__':
    unittest.main()
