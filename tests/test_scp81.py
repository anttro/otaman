#!/usr/bin/env python3
"""Phase B tests: PSK TLS server, GP HTTP administration session, and the
terminal's Data available notification (TS 102 223 7.5.10).

Synthetic PSK only; no live card data.
"""

import socket
import ssl
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

from pysim_otaman_server import scp81
import pysim_otaman_server.server as server

PSK = bytes.fromhex('00112233445566778899aabbccddeeff')
IDENT = '89012345678901234567'


class HttpParseTest(unittest.TestCase):
    def test_parse_request(self):
        raw = (b'POST /server/adminagent?cmd=1 HTTP/1.1\r\n'
               b'Host: 172.96.0.1\r\n'
               b'X-Admin-Protocol: globalplatform-remote-admin/1.0\r\n'
               b'X-Admin-From: 0123456789\r\n\r\n')
        method, target, headers = scp81.parse_http_request(raw)
        self.assertEqual(method, 'POST')
        self.assertEqual(target, '/server/adminagent?cmd=1')
        self.assertEqual(headers['host'], '172.96.0.1')
        self.assertEqual(headers['x-admin-from'], '0123456789')

    def test_parse_request_malformed(self):
        with self.assertRaises(ValueError):
            scp81.parse_http_request(b'GARBAGE\r\n\r\n')

    def test_decode_chunked(self):
        body = b'4\r\nABCD\r\n5\r\nEFGHI\r\n0\r\n\r\n'
        self.assertEqual(scp81.decode_chunked(body), b'ABCDEFGHI')

    def test_build_response_sets_content_length(self):
        out = scp81.build_http_response(200, 'OK',
                                        {'Content-Type': scp81.GP_CT_COMMAND}, b'\x80\x01\x00')
        self.assertTrue(out.startswith(b'HTTP/1.1 200 OK\r\n'))
        self.assertIn(b'Content-Length: 3\r\n\r\n\x80\x01\x00', out)

    def test_build_response_connection_header(self):
        out = scp81.build_http_response(200, 'OK', {}, b'\x01',
                                        connection='close')
        self.assertIn(b'Connection: close\r\n', out)
        out = scp81.build_http_response(200, 'OK', {}, b'\x01',
                                        compact=True, connection='keep-alive')
        self.assertIn(b'Connection:keep-alive\r\n', out)

    def test_build_response_chunked(self):
        out = scp81.build_http_response(200, 'OK', {},
                                        b'\x80' * 150, chunked=True)
        self.assertIn(b'Transfer-Encoding: chunked', out)
        self.assertNotIn(b'Content-Length', out)
        head, _, body = out.partition(b'\r\n\r\n')
        self.assertEqual(scp81.decode_chunked(body), b'\x80' * 150)
        # 100-byte chunks like the reference admin server
        self.assertTrue(body.startswith(b'64\r\n'))


class PskTlsServerTest(unittest.TestCase):
    def _client_ctx(self, identity=IDENT, psk=PSK):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.maximum_version = ssl.TLSVersion.TLSv1_2
        ctx.set_ciphers('PSK-AES128-CBC-SHA256:PSK-AES128-CBC-SHA')
        ctx.set_psk_client_callback(lambda hint: (identity.encode(), psk))
        return ctx

    def _connect(self, srv, ctx=None):
        sock = socket.create_connection(('127.0.0.1', srv.port), timeout=5)
        try:
            return (ctx or self._client_ctx()).wrap_socket(sock)
        except Exception:
            sock.close()
            raise

    def test_handshake_and_204_session(self):
        logs = []
        srv = scp81.PskTlsServer('127.0.0.1', 0, PSK, identity=IDENT,
                                 on_log=lambda k, **f: logs.append((k, f)))
        try:
            tls = self._connect(srv)
            self.assertEqual(tls.version(), 'TLSv1.2')
            self.assertEqual(tls.cipher()[0], 'PSK-AES128-CBC-SHA256')
            tls.sendall(b'POST /server/adminagent?cmd=1 HTTP/1.1\r\n'
                        b'Host: 172.96.0.1\r\n'
                        b'X-Admin-Protocol: globalplatform-remote-admin/1.0\r\n'
                        b'X-Admin-From: 0123456789\r\n\r\n')
            reply = tls.recv(4096)
            self.assertTrue(reply.startswith(b'HTTP/1.1 204 No Content\r\n'))
            self.assertIn(b'X-Admin-Protocol: globalplatform-remote-admin/1.0', reply)
            tls.close()
            deadline = time.time() + 3
            while time.time() < deadline and srv.identity_seen is None:
                time.sleep(0.05)
            self.assertEqual(srv.identity_seen, IDENT)
            kinds = [k for k, _ in logs]
            self.assertIn('tls-handshake', kinds)
            self.assertIn('tls-request', kinds)
            self.assertIn('tls-response', kinds)
            req = [f for k, f in logs if k == 'tls-request'][0]
            self.assertEqual(req['uri'], '/server/adminagent?cmd=1')
            self.assertEqual(req['agent'], '0123456789')
        finally:
            srv.stop()

    def _recv(self, tls):
        try:
            return tls.recv(4096)
        except (ssl.SSLError, OSError):
            return b''

    def _read_http(self, tls):
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = self._recv(tls)
            if not chunk:
                return buf
            buf += chunk
        head, _, rest = buf.partition(b'\r\n\r\n')
        if b'transfer-encoding: chunked' in head.lower():
            while b'0\r\n\r\n' not in rest:
                chunk = self._recv(tls)
                if not chunk:
                    break
                rest += chunk
            return head + b'\r\n\r\n' + rest
        length = 0
        for line in head.split(b'\r\n'):
            if line.lower().startswith(b'content-length:'):
                length = int(line.split(b':')[1])
        while len(rest) < length:
            chunk = self._recv(tls)
            if not chunk:
                break
            rest += chunk
        return head + b'\r\n\r\n' + rest

    def test_scripted_session_over_tls(self):
        old_bip = server._BIP
        server._BIP = mock.Mock()
        server._BIP.log = lambda *a, **k: None
        server._SCP81_SCRIPT = ['80CAFF2100']
        server._SCP81_SCRIPT_SENT = 0
        server._SCP81_SCRIPT_RESULTS = []
        srv = scp81.PskTlsServer('127.0.0.1', 0, PSK,
                                 responder=server._scp81_script_responder,
                                 keep_alive=True)
        try:
            tls = self._connect(srv)
            tls.sendall(b'POST /api/scp81 HTTP/1.1\r\nHost: 127.0.0.1\r\n'
                        b'X-Admin-Protocol: globalplatform-remote-admin/1.0\r\n'
                        b'X-Admin-From: otaman\r\n\r\n')
            reply = self._read_http(tls)
            self.assertIn(b'HTTP/1.1 200 OK', reply)
            self.assertIn(b'X-Admin-Next-URI: /api/scp81?req=1', reply)
            self.assertIn(bytes.fromhex('ae80220580caff21000000'), reply)
            # Respond with the R-APDU (Response Scripting template)
            body = bytes.fromhex('af80' '800101' '2304' '93059000' '0000')
            tls.sendall(b'POST /api/scp81?step=1 HTTP/1.1\r\n'
                        b'X-Admin-Script-Status: ok\r\n'
                        b'Content-Length: %d\r\n\r\n' % len(body) + body)
            reply = self._read_http(tls)
            self.assertIn(b'HTTP/1.1 204 No Content', reply)
            self.assertEqual(server._SCP81_SCRIPT_RESULTS[0]['sw'], '9000')
            tls.close()
        finally:
            server._BIP = old_bip
            server._SCP81_SCRIPT = list(server._SCP81_SCRIPTS['explore'])
            server._SCP81_SCRIPT_SENT = 0
            server._SCP81_SCRIPT_RESULTS = []
            srv.stop()

    def test_response_closes_connection_without_keep_alive(self):
        # Default (keep_alive=False): the card's HTTP client seems to delimit
        # the response at connection close, so the server closes after each
        # response and the card starts a fresh session for its next POST.
        def responder(method, target, headers, body):
            return 200, {'X-Admin-Protocol': scp81.GP_PROTOCOL}, b'\x80\x01\x00'

        srv = scp81.PskTlsServer('127.0.0.1', 0, PSK, responder=responder)
        try:
            tls = self._connect(srv)
            tls.sendall(b'POST /api/scp81 HTTP/1.1\r\n\r\n')
            reply = self._read_http(tls)
            self.assertTrue(reply.startswith(b'HTTP/1.1 200 OK'))
            self.assertEqual(self._recv(tls), b'')   # server closed
            tls.close()
        finally:
            srv.stop()

    def test_close_waits_for_drain_callback(self):
        # With keep_alive=False and a body, the listener calls on_before_close
        # (the server waits for the card to drain the BIP buffer) before
        # closing the connection.
        seen = []

        def responder(method, target, headers, body):
            return 200, {'X-Admin-Protocol': scp81.GP_PROTOCOL}, b'\x80\x01\x00'

        srv = scp81.PskTlsServer('127.0.0.1', 0, PSK, responder=responder,
                                 on_before_close=lambda peer: seen.append(peer))
        try:
            tls = self._connect(srv)
            client_port = tls.getsockname()[1]
            tls.sendall(b'POST /api/scp81 HTTP/1.1\r\n\r\n')
            reply = self._read_http(tls)
            self.assertTrue(reply.startswith(b'HTTP/1.1 200 OK'))
            self.assertIn(b'Connection: close', reply)
            # The server must send close_notify (clean TLS shutdown) before
            # closing: unwrap() succeeds only when the peer's close_notify
            # has been received.
            tls.settimeout(3.0)
            plain = tls.unwrap()
            # The close comes after the drain callback: EOF proves it ran.
            self.assertEqual(plain.recv(1), b'')
            self.assertEqual(len(seen), 1)
            self.assertEqual(seen[0][1], client_port)
            plain.close()
        finally:
            srv.stop()

    def test_wrong_identity_rejected(self):
        srv = scp81.PskTlsServer('127.0.0.1', 0, PSK, identity=IDENT)
        try:
            with self.assertRaises(ssl.SSLError):
                self._connect(srv, self._client_ctx(identity='unknown-id'))
        finally:
            srv.stop()

    def test_server_hello_omits_encrypt_then_mac(self):
        # The live card offers encrypt_then_mac but aborts with
        # SSLV3_ALERT_UNEXPECTED_MESSAGE when the server echoes it.
        srv = scp81.PskTlsServer('127.0.0.1', 0, PSK)
        try:
            sock = socket.create_connection(('127.0.0.1', srv.port), timeout=5)
            hello = bytes.fromhex(
                '1603010038' '01000034' '0303' + '11' * 32 + '00'
                '0002' '00ae' '0100'
                '0009' '0001000101' '00160000')
            sock.sendall(hello)
            data = sock.recv(4096)
            sock.close()
            idx = data.find(b'\x00\xae')
            self.assertGreater(idx, 0, data.hex())
            ext_total = int.from_bytes(data[idx + 3:idx + 5], 'big')
            ext = data[idx + 5:idx + 5 + ext_total]
            seen = set()
            off = 0
            while off + 4 <= len(ext):
                etype = int.from_bytes(ext[off:off + 2], 'big')
                elen = int.from_bytes(ext[off + 2:off + 4], 'big')
                seen.add(etype)
                off += 4 + elen
            self.assertNotIn(0x0016, seen)   # encrypt_then_mac
            self.assertNotIn(0x0023, seen)   # session_ticket (no resumption)
        finally:
            srv.stop()

    def test_command_then_close(self):
        def responder(method, target, headers, body):
            if b'cmd=1' in target.encode():
                return (200, {'X-Admin-Protocol': scp81.GP_PROTOCOL,
                              'X-Admin-Next-URI': '/server/adminagent?cmd=2',
                              'Content-Type': scp81.GP_CT_COMMAND}, b'\x80\x01\x00')
            return 204, {'X-Admin-Protocol': scp81.GP_PROTOCOL}, b''

        srv = scp81.PskTlsServer('127.0.0.1', 0, PSK, responder=responder,
                                 keep_alive=True)
        try:
            tls = self._connect(srv)
            tls.sendall(b'POST /server/adminagent?cmd=1 HTTP/1.1\r\n\r\n')
            reply = self._read_http(tls)
            self.assertIn(b'X-Admin-Next-URI: /server/adminagent?cmd=2', reply)
            head, _, body = reply.partition(b'\r\n\r\n')
            self.assertIn(b'Content-Length: 3', head)
            self.assertEqual(body[:3], b'\x80\x01\x00')
            tls.sendall(b'POST /server/adminagent?cmd=2 HTTP/1.1\r\n'
                        b'X-Admin-Script-Status: ok\r\n'
                        b'Content-Length: 3\r\n\r\n\x80\x02\x00')
            reply = self._read_http(tls)
            self.assertTrue(reply.startswith(b'HTTP/1.1 204 No Content'))
            tls.close()
        finally:
            srv.stop()


class ScriptResponderTest(unittest.TestCase):
    """RAM over HTTP command scripting (TS 102 226 5.2, GP 4.4.2)."""

    def setUp(self):
        server._SCP81_SCRIPT = list(server._SCP81_SCRIPTS['explore'])
        server._SCP81_SCRIPT_SENT = 0
        server._SCP81_SCRIPT_RESULTS = []

    def tearDown(self):
        server._SCP81_SCRIPT = list(server._SCP81_SCRIPTS['explore'])
        server._SCP81_SCRIPT_SENT = 0
        server._SCP81_SCRIPT_RESULTS = []

    def test_command_body_is_indefinite_scripting_template(self):
        # Reference admin server: AE 80 22 <len> <apdu> 00 00
        body = server._scp81_command_body('80CAFF2100')
        self.assertEqual(body.hex(), 'ae80220580caff210000' + '00')
        self.assertEqual(body[0:2], b'\xae\x80')
        self.assertEqual(body[2], 0x22)
        self.assertEqual(body[3], 5)

    def test_command_body_definite_scripting_template(self):
        # AA <len> 22 <len> <apdu>
        body = server._scp81_command_body('80CAFF2100', definite=True)
        self.assertEqual(body.hex(), 'aa072205' + '80caff2100')

    def test_command_body_cr_set_c_apdu_tag(self):
        # Some cards use the comprehension-required tag variant (A2)
        self.assertEqual(server._scp81_command_body('80CA004500', definite=True, cr_tag=True).hex(),
                         'aa07a20580ca004500')
        self.assertEqual(server._scp81_command_body('80CA004500', cr_tag=True).hex(),
                         'ae80a20580ca004500' + '0000')

    def test_parse_response_indefinite(self):
        # AF 80 (80 01 01) (23 04 93 05 90 00) 00 00
        body = bytes.fromhex('af80' '800101' '2304' '9305' '9000' '0000')
        count, rapdus = server._scp81_parse_response(body)
        self.assertEqual(count, 1)
        self.assertEqual(rapdus, [(bytes.fromhex('9305'), '9000')])

    def test_parse_response_definite(self):
        body = bytes.fromhex('ab08' '800101' '2303' '019000')
        count, rapdus = server._scp81_parse_response(body)
        self.assertEqual(count, 1)
        self.assertEqual(rapdus, [(bytes.fromhex('01'), '9000')])

    def test_decode_memory(self):
        rapdu = bytes.fromhex('ff210c' '810102' '8203' '00f0a0' '8302' '0800')
        self.assertEqual(server._scp81_decode_memory(rapdu),
                         {'applets': 2, 'free_nv': 0xf0a0, 'free_volatile': 0x0800})
        self.assertIsNone(server._scp81_decode_memory(bytes.fromhex('9000')))

    def test_responder_sends_script_then_204(self):
        # Use an explicit two-command script, independent of the presets.
        server._SCP81_SCRIPT = ['80CAFF2100', '80F22002024F0000']
        logs = []
        old_bip = server._BIP
        server._BIP = mock.Mock()
        server._BIP.log = lambda kind, **f: logs.append((kind, f))
        try:
            # First POST: no script status -> first APDU + Next-URI
            status, headers, body = server._scp81_script_responder(
                'POST', '/api/scp81', {}, b'')
            self.assertEqual(status, 200)
            self.assertEqual(headers['X-Admin-Next-URI'], '/api/scp81?req=1')
            self.assertEqual(headers['Content-Type'],
                             'application/vnd.globalplatform.card-content-mgt;version=1.0')
            self.assertEqual(body.hex(), 'ae80220580caff21000000')
            # Response to it -> second APDU
            status, headers, body = server._scp81_script_responder(
                'POST', '/api/scp81?step=1', {'x-admin-script-status': 'ok'},
                bytes.fromhex('af80' '800101' '2304' '93059000' '0000'))
            self.assertEqual(status, 200)
            self.assertEqual(body.hex(), 'ae802208' + '80f22002024f0000' + '0000')
            # Last response -> session closed with 204
            status, headers, body = server._scp81_script_responder(
                'POST', '/api/scp81?step=2', {'x-admin-script-status': 'ok'},
                bytes.fromhex('af80' '800101' '2303' '5f9000' '0000'))
            self.assertEqual(status, 204)
            kinds = [k for k, _ in logs]
            self.assertIn('script-send', kinds)
            self.assertIn('script-rapdu', kinds)
            self.assertIn('script-done', kinds)
            self.assertEqual(len(server._SCP81_SCRIPT_RESULTS), 2)
        finally:
            server._BIP = old_bip

    def test_responder_reports_script_failure(self):
        old_bip = server._BIP
        server._BIP = mock.Mock()
        logs = []
        server._BIP.log = lambda kind, **f: logs.append((kind, f))
        try:
            server._scp81_script_responder('POST', '/x', {}, b'')
            status, headers, body = server._scp81_script_responder(
                'POST', '/x', {'x-admin-script-status': 'security-error'}, b'')
            self.assertEqual(status, 200)   # script continues with the next APDU
            self.assertIn(('script-status', {'index': 1, 'status': 'security-error'}), logs)
        finally:
            server._BIP = old_bip


class BipControlTest(unittest.TestCase):
    def tearDown(self):
        server._scp81_bip_control({'action': 'stop'})
        server._SCP81_PSK = {}

    def test_tls_mode_requires_psk(self):
        server._SCP81_PSK = {}
        resp = server._scp81_bip_control({'action': 'start', 'mode': 'tls'})
        self.assertFalse(resp['ok'])
        self.assertIn('psk_hex', resp['error'])

    def test_tls_mode_starts_and_reports_status(self):
        resp = server._scp81_bip_control({'action': 'start', 'mode': 'tls',
                                          'host': '127.0.0.1', 'port': 0,
                                          'psk_hex': '0011 2233', 'psk_identity': 'id-1'})
        self.assertTrue(resp['ok'], resp)
        listener = resp['listener']
        self.assertEqual(listener['mode'], 'tls')
        self.assertEqual(listener['psk_identity'], 'id-1')
        self.assertIsNone(listener['identity_seen'])
        self.assertTrue(resp['bip']['enabled'])
        # the key never leaves the server
        self.assertNotIn('psk_hex', listener)

    def test_unknown_mode_rejected(self):
        resp = server._scp81_bip_control({'action': 'start', 'mode': 'nope'})
        self.assertFalse(resp['ok'])
        self.assertIn('unsupported mode', resp['error'])


class DataAvailableTest(unittest.TestCase):
    def _channel(self, cid=1, rx=b'\x16\x03\x03'):
        ch = types.SimpleNamespace(id=cid, rx=bytearray(rx), peer_closed=False)
        return ch

    def _state(self, event_list=(0x09,)):
        sent = []

        class Tp:
            def send_apdu(self, apdu):
                sent.append(apdu)
                return '', '9000'

        scc = types.SimpleNamespace(cat_cla='80', _tp=Tp())
        ref = types.SimpleNamespace(scc=scc, event_list=list(event_list),
                                    stk_pending=None)
        return ref, sent

    def test_data_available_event(self):
        ref, sent = self._state()
        with mock.patch.object(server, '_server_ref', ref):
            with mock.patch.object(server, '_CARD_CONNECTED', True):
                ok = server._bip_data_available(self._channel())
        self.assertTrue(ok)
        # ENVELOPE(Event Download - Data available): channel 1 established,
        # 3 bytes waiting (B8 status + B7 length)
        self.assertEqual(sent, ['80c2000010d60e99010982028281b8028100b70103'])

    def test_skipped_without_subscription(self):
        ref, sent = self._state(event_list=[0x03, 0x0A])
        with mock.patch.object(server, '_server_ref', ref):
            with mock.patch.object(server, '_CARD_CONNECTED', True):
                ok = server._bip_data_available(self._channel())
        self.assertFalse(ok)
        self.assertEqual(sent, [])

    def test_skipped_while_menu_pending(self):
        ref, sent = self._state()
        ref.stk_pending = {'type': 'select_item'}
        with mock.patch.object(server, '_server_ref', ref):
            with mock.patch.object(server, '_CARD_CONNECTED', True):
                ok = server._bip_data_available(self._channel())
        self.assertFalse(ok)
        self.assertEqual(sent, [])

    def test_monitor_notifies_once_per_arrival(self):
        peer = socket.socket()
        peer.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        peer.bind(('127.0.0.1', 0))
        peer.listen(1)
        bip = server.httpota.BipTerminal()
        seen = []
        bip.on_data = lambda ch: (seen.append((ch.id, len(ch.rx)))) or True
        try:
            bip.enable('127.0.0.1', peer.getsockname()[1])
            cid, err = bip.open('10.0.0.1', 1, 512)
            self.assertIsNone(err)
            conn, _ = peer.accept()
            conn.sendall(b'HELLO')
            deadline = time.time() + 3
            while time.time() < deadline and not seen:
                time.sleep(0.05)
            time.sleep(0.6)  # several monitor ticks
            self.assertEqual(seen, [(cid, 5)])
        finally:
            bip.disable()
            peer.close()

    def test_remaining_bytes_are_re_announced(self):
        # The live card waits for a fresh Data available event for the bytes
        # left after a partial RECEIVE DATA (announced in the TR length TLV).
        peer = socket.socket()
        peer.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        peer.bind(('127.0.0.1', 0))
        peer.listen(1)
        bip = server.httpota.BipTerminal()
        seen = []
        bip.on_data = lambda ch: (seen.append(len(ch.rx))) or True
        try:
            bip.enable('127.0.0.1', peer.getsockname()[1])
            cid, err = bip.open('10.0.0.1', 1, 512)
            self.assertIsNone(err)
            conn, _ = peer.accept()
            conn.sendall(b'0123456789')
            deadline = time.time() + 3
            while time.time() < deadline and not seen:
                time.sleep(0.05)
            self.assertEqual(seen, [10])
            self.assertEqual(bip.receive(cid, 4), b'0123')
            deadline = time.time() + 3
            while time.time() < deadline and len(seen) < 2:
                time.sleep(0.05)
            self.assertEqual(seen[1], 6)
        finally:
            bip.disable()
            peer.close()


if __name__ == '__main__':
    unittest.main()

class WaitDrainedTest(unittest.TestCase):
    def test_wait_drained_matches_channel_by_port(self):
        ch = types.SimpleNamespace(rx=bytearray(), sock=types.SimpleNamespace(
            getsockname=lambda: ('127.0.0.1', 40001)))
        old = server._BIP
        server._BIP = types.SimpleNamespace(channels={1: ch})
        try:
            # unknown port / gone channel -> immediate
            self.assertIsNone(server._scp81_wait_drained(('127.0.0.1', 40002)))
        finally:
            server._BIP = old

class WaitDrainedSlowTest(unittest.TestCase):
    def test_wait_drained_waits_for_card_fetch(self):
        import threading, time as _time
        ch = types.SimpleNamespace(rx=bytearray(), sock=types.SimpleNamespace(
            getsockname=lambda: ('127.0.0.1', 40003)))

        def feed():
            _time.sleep(0.15)
            ch.rx.extend(b'response-bytes')      # pump picks up the response
            _time.sleep(0.25)
            ch.rx.clear()                        # card fetches everything

        old = server._BIP
        server._BIP = types.SimpleNamespace(channels={1: ch})
        th = threading.Thread(target=feed)
        th.start()
        t0 = _time.time()
        try:
            server._scp81_wait_drained(('127.0.0.1', 40003))
        finally:
            server._BIP = old
            th.join()
        self.assertGreater(_time.time() - t0, 0.3)

class KeylogTest(unittest.TestCase):
    def test_keylog_filename_set(self):
        import tempfile, os
        fd, path = tempfile.mkstemp(prefix='scp81keys')
        os.close(fd)
        srv = scp81.PskTlsServer('127.0.0.1', 0, PSK, keylog=path)
        try:
            self.assertEqual(srv.ctx.keylog_filename, path)
        finally:
            srv.stop()
            os.unlink(path)

class ConnHeaderTest(unittest.TestCase):
    def test_conn_header_none_omits_connection(self):
        import types
        seen = {}
        def responder(method, target, headers, body):
            return 204, {}, b''
        srv = scp81.PskTlsServer('127.0.0.1', 0, PSK, responder=responder,
                                 keep_alive=True, conn_header='none')
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.set_ciphers('PSK')
            ctx.set_psk_client_callback(lambda hint: (b'id', PSK))
            raw = socket.create_connection(('127.0.0.1', srv.port), timeout=5)
            tls = ctx.wrap_socket(raw, server_hostname='x')
            tls.sendall(b'POST /api/scp81 HTTP/1.1\r\n\r\n')
            data = tls.recv(4096)
            self.assertNotIn(b'Connection:', data)
            tls.close()
        finally:
            srv.stop()


class TargetedAppTest(unittest.TestCase):
    def test_targeted_app_header(self):
        server._SCP81_SCRIPT = ['80CAFF2100']
        server._SCP81_SCRIPT_SENT = 0
        server._SCP81_TARGETED_APP = '//aid/A000000151000000'
        try:
            status, headers, body = server._scp81_script_responder(
                'POST', '/api/scp81', {}, b'')
            self.assertEqual(status, 200)
            self.assertEqual(headers['X-Admin-Targeted-Application'],
                             '//aid/A000000151000000')
        finally:
            server._SCP81_TARGETED_APP = None
            server._SCP81_SCRIPT = list(server._SCP81_SCRIPTS['explore'])
            server._SCP81_SCRIPT_SENT = 0

    def test_apache_headers(self):
        server._SCP81_SCRIPT = ['80CAFF2100']
        server._SCP81_SCRIPT_SENT = 0
        server._SCP81_APACHE_HEADERS = True
        server._SCP81_CHUNKED = False
        try:
            status, headers, body = server._scp81_script_responder(
                'POST', '/api/scp81', {}, b'')
            self.assertEqual(list(headers)[:4],
                             ['Date', 'Server', 'X-Powered-By', 'X-Admin-Protocol'])
            self.assertEqual(headers['Content-Length'], str(len(body)))
            out = scp81.build_http_response(status, 'OK', headers, body)
            self.assertLess(out.index(b'Content-Length'),
                            out.index(b'Content-Type'))
        finally:
            server._SCP81_APACHE_HEADERS = False
            server._SCP81_CHUNKED = False
            server._SCP81_SCRIPT = list(server._SCP81_SCRIPTS['explore'])
            server._SCP81_SCRIPT_SENT = 0

    def test_chunked_apache_has_no_content_length(self):
        # The reference (RAM/HTTPOTA_test5.pcap, decryptable) sends chunked
        # without Content-Length, Transfer-Encoding before Content-Type.
        server._SCP81_SCRIPT = ['80CAFF2100']
        server._SCP81_SCRIPT_SENT = 0
        server._SCP81_APACHE_HEADERS = True
        server._SCP81_CHUNKED = True
        try:
            status, headers, body = server._scp81_script_responder(
                'POST', '/api/scp81', {}, b'')
            self.assertNotIn('Content-Length', headers)
            self.assertEqual(headers['Transfer-Encoding'], 'chunked')
            self.assertLess(list(headers).index('Transfer-Encoding'),
                            list(headers).index('Content-Type'))
            out = scp81.build_http_response(status, 'OK', headers, body,
                                            chunked=True, connection=None)
            self.assertNotIn(b'Content-Length', out)
            self.assertEqual(out.count(b'Transfer-Encoding'), 1)
        finally:
            server._SCP81_APACHE_HEADERS = False
            server._SCP81_CHUNKED = False
            server._SCP81_SCRIPT = list(server._SCP81_SCRIPTS['explore'])
            server._SCP81_SCRIPT_SENT = 0

    def test_last_aid_parses_complete_entries_only(self):
        page = bytes.fromhex(
            'FC'                                                    # live prefix
            'E3114F08A0000000030000009F70010FC50100'                # entry 1
            'E3104F07A00000015153509F700107C50104'                 # entry 2
            'E3204F08D27600')                                       # truncated
        self.assertEqual(server._scp81_last_aid(page),
                         bytes.fromhex('A0000001515350'))

    def test_continuation_builds_next_occurrence_apdu(self):
        page = bytes.fromhex('E3114F08A0000000030000009F70010FC50100')
        self.assertEqual(server._scp81_continuation('80F24002024F0000', page),
                         '80F240020A4F08A00000000300000000')
        self.assertIsNone(server._scp81_continuation('80CAFF2100', page))

    def test_cafe_page_auto_continuation(self):
        server._SCP81_SCRIPT = ['80F24002024F0000']
        server._SCP81_SCRIPT_SENT = 1
        server._SCP81_SCRIPT_RESULTS = []
        server._SCP81_SCRIPT_INSERTED = []
        server._SCP81_PAGES = 0
        try:
            page = (bytes.fromhex('E3114F08A0000000030000009F70010FC50100')
                    + bytes.fromhex('E3104F07A00000015153509F700107C50104')
                    + bytes.fromhex('E3204F08D27600'))
            tlv = bytes([0x23, len(page) + 2]) + page + b'\xCA\xFE'
            body = b'\xAF\x80' + tlv + b'\x00\x00'
            status, headers, out = server._scp81_script_responder(
                'POST', '/api/scp81?req=1', {'x-admin-script-status': 'ok'}, body)
            # The continuation was appended and sent as the next command.
            self.assertEqual(server._SCP81_SCRIPT[1],
                             '80F24002094F07A000000151535000')
            self.assertEqual(status, 200)
            self.assertIn(bytes.fromhex('80F24002094F07A000000151535000'), out)
        finally:
            server._SCP81_SCRIPT = list(server._SCP81_SCRIPTS['explore'])
            server._SCP81_SCRIPT_SENT = 0
            server._SCP81_SCRIPT_RESULTS = []
            server._SCP81_SCRIPT_INSERTED = []
            server._SCP81_PAGES = 0

    def test_repeated_page_stalls(self):
        server._SCP81_SCRIPT = ['80F24002024F0000']
        server._SCP81_SCRIPT_SENT = 1
        server._SCP81_SCRIPT_RESULTS = []
        server._SCP81_SCRIPT_INSERTED = ['80F240020A4F08A00000000300000000']
        server._SCP81_PAGES = 1
        try:
            page = bytes.fromhex('E3114F08A0000000030000009F70010FC50100')
            tlv = bytes([0x23, len(page) + 2]) + page + b'\xCA\xFE'
            body = b'\xAF\x80' + tlv + b'\x00\x00'
            server._scp81_script_responder(
                'POST', '/api/scp81?req=2', {'x-admin-script-status': 'ok'}, body)
            # Same page again: no new continuation inserted.
            self.assertEqual(_count := len(server._SCP81_SCRIPT_INSERTED), 1)
            self.assertEqual(server._SCP81_PAGES, 1)
        finally:
            server._SCP81_SCRIPT = list(server._SCP81_SCRIPTS['explore'])
            server._SCP81_SCRIPT_SENT = 0
            server._SCP81_SCRIPT_RESULTS = []
            server._SCP81_SCRIPT_INSERTED = []
            server._SCP81_PAGES = 0

    def test_new_session_drops_inserted_pages(self):
        server._SCP81_SCRIPT = ['80F24002024F0000', '80F24002094F07A000000151535000']
        server._SCP81_SCRIPT_INSERTED = ['80F24002094F07A000000151535000']
        server._SCP81_SCRIPT_SENT = 2
        try:
            server._scp81_script_responder('POST', '/api/scp81', {}, b'')
            self.assertEqual(server._SCP81_SCRIPT, ['80F24002024F0000'])
            self.assertEqual(server._SCP81_SCRIPT_SENT, 1)
        finally:
            server._SCP81_SCRIPT = list(server._SCP81_SCRIPTS['explore'])
            server._SCP81_SCRIPT_SENT = 0
            server._SCP81_SCRIPT_INSERTED = []

    def test_exact_wire_bodies_from_reference_log(self):
        # De-chunked bodies captured in adminserver.log (2019-09-05).
        count, rapdus = server._scp81_parse_response(bytes.fromhex(
            'af802319e3154f08a0000001510000009f70010fc5039afe80ea0090000000'))
        self.assertEqual(len(rapdus), 1)
        self.assertEqual(rapdus[0][1], '9000')
        self.assertTrue(rapdus[0][0].startswith(b'\xe3\x15'))
        count, rapdus = server._scp81_parse_response(
            bytes.fromhex('af8023026a880000'))
        self.assertEqual(rapdus[0][1], '6A88')
        # A status-only POST (no body, e.g. unknown-application) parses empty.
        self.assertEqual(server._scp81_parse_response(b''), (0, []))
