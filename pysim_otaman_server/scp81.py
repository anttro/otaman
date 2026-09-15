"""Phase B: PSK TLS server and HTTP administration session for SCP81.

Implements the Remote Administration Server side of GP RAM over HTTP
(GPC v2.2 Amendment B):

  - TLS 1.2 with the PSK cipher suites of clause 4.3.2. The handshake and
    record layer are handled by the stdlib ``ssl`` module through OpenSSL's
    PSK callbacks (identity -> PSK), so no TLS code lives here.
  - The HTTP dialog of clause 4.4: parse the Security Domain's POST
    (``X-Admin-*`` headers, optional body with the previous response string)
    and answer with 200 + a command string, or 204 No Content to close the
    administration session.

The card talks TLS *through* the BIP channel: this server listens on the
local redirect target and the BIP terminal proxies the card's SEND/RECEIVE
DATA records to it.
"""

import socket
import ssl
import threading
import time

MAX_HEAD = 32 * 1024
MAX_BODY = 1 * 1024 * 1024

# TLS_PSK_* suites from GPC v2.2 Amendment B Table 4-2 / RFC 4279/4785/5487.
PSK_CIPHERS = ':'.join([
    'PSK-AES128-CBC-SHA256',   # TLS_PSK_WITH_AES_128_CBC_SHA256 (0x00AE)
    'PSK-AES128-CBC-SHA',      # TLS_PSK_WITH_AES_128_CBC_SHA    (0x008C)
    'PSK-AES256-CBC-SHA',      # TLS_PSK_WITH_AES_256_CBC_SHA    (0x008D)
    'PSK-3DES-EDE-CBC-SHA',    # TLS_PSK_WITH_3DES_EDE_CBC_SHA   (0x008B)
    'PSK-NULL-SHA256',         # TLS_PSK_WITH_NULL_SHA256        (0x00B0)
    'PSK-NULL-SHA',            # TLS_PSK_WITH_NULL_SHA           (0x002C)
])

GP_PROTOCOL = 'globalplatform-remote-admin/1.0'
GP_CT_COMMAND = 'application/vnd.globalplatform.card-content-mgt;version=1.0'
GP_CT_RESPONSE = 'application/vnd.globalplatform.card-content-mgt-response;version=1.0'

# OpenSSL SSL_OP_NO_ENCRYPT_THEN_MAC (not exposed by the ssl module). The live
# card offers the encrypt_then_mac extension but aborts the session with
# SSLV3_ALERT_UNEXPECTED_MESSAGE as soon as the server echoes it, so keep the
# extension out of the ServerHello (verified live 2026-09-15).
OP_NO_ENCRYPT_THEN_MAC = 0x00080000

TLS_VERSIONS = {
    '1.0': ssl.TLSVersion.TLSv1,
    '1.1': ssl.TLSVersion.TLSv1_1,
    '1.2': ssl.TLSVersion.TLSv1_2,
}


def parse_http_request(data):
    """Parse an HTTP/1.1 request head (bytes up to CRLFCRLF) into
    (method, target, headers dict with lower-case names)."""
    head = data.split(b'\r\n\r\n', 1)[0]
    lines = head.split(b'\r\n')
    parts = lines[0].split(b' ')
    if len(parts) < 3:
        raise ValueError('malformed request line')
    method, target = parts[0].decode('latin-1'), parts[1].decode('latin-1')
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(b':')
        headers[name.strip().decode('latin-1').lower()] = value.strip().decode('latin-1')
    return method, target, headers


def decode_chunked(body):
    """Decode a chunked transfer body (RFC 2616 3.6.1)."""
    out = bytearray()
    while body:
        line, _, rest = body.partition(b'\r\n')
        try:
            size = int(line.split(b';')[0], 16)
        except ValueError:
            raise ValueError('bad chunk size %r' % line[:16])
        if size == 0:
            break
        out.extend(rest[:size])
        body = rest[size + 2:]
    return bytes(out)


def build_http_response(status, reason, headers, body=b'', chunked=False,
                        compact=False, connection=None):
    """Build an HTTP response. With chunked=True the body is framed as 100-byte
    chunks (like the reference admin server); with compact=True header names
    and values are separated by ':' without whitespace, which keeps the whole
    response inside one card-sized TLS record (<= 256 bytes ciphertext).
    connection ('close'/'keep-alive') declares the connection fate: without
    it an HTTP/1.1 client assumes the connection persists and tries to reuse
    it for the next POST instead of dialing a new one (live card 2026-09-15)."""
    lines = ['HTTP/1.1 %d %s' % (status, reason)]
    sep = ':' if compact else ': '
    for name, value in headers.items():
        lines.append('%s%s%s' % (name, sep, value))
    if connection:
        lines.append('Connection%s%s' % (sep, connection))
    has_te = 'transfer-encoding' in [k.lower() for k in headers]
    if body and (chunked or has_te):
        if not has_te:
            lines.append('Transfer-Encoding: chunked')
    elif body and 'content-length' not in [k.lower() for k in headers]:
        lines.append('Content-Length%s%d' % (sep, len(body)))
    head = ('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1')
    if not body:
        return head
    if not chunked:
        return head + body
    out = bytearray(head)
    for i in range(0, len(body), 100):
        piece = body[i:i + 100]
        out += ('%X\r\n' % len(piece)).encode('latin-1') + piece + b'\r\n'
    out += b'0\r\n\r\n'
    return bytes(out)


class PskTlsServer:
    """PSK TLS listener speaking the GP remote administration HTTP dialog."""

    def __init__(self, host, port, psk, identity=None, on_log=None,
                 responder=None, timeout=10.0, chunked=False, chunk_size=0,
                 keep_alive=False, compact_headers=False, tls_version='1.2',
                 cipher=None, on_before_close=None, keylog=None,
                 conn_header=None, half_close=False, answer_delay=0.0):
        self.psk = psk
        self.identity = identity
        self.on_log = on_log
        self.responder = responder or self._default_responder
        self.timeout = timeout
        self.chunked = chunked
        # chunk_size 0 = one record for the whole response
        self.chunk_size = int(chunk_size)
        self.keep_alive = keep_alive
        self.compact_headers = compact_headers
        # The reference traces negotiated TLS 1.0 with PSK-AES128-CBC-SHA;
        # some cards only speak the older record layer correctly.
        self.tls_version = tls_version if tls_version in TLS_VERSIONS else '1.2'
        # Pin one cipher suite (e.g. PSK-AES128-CBC-SHA) if the card's SD only
        # maps a specific suite to a usable SCP81 security level.
        self.cipher = cipher or None
        # Called with the peer address just before closing a non-keep-alive
        # connection: the server waits until the card has drained the BIP
        # buffer, otherwise the EOF truncates the response fetch.
        self.on_before_close = on_before_close
        # Debug aid: write the TLS traffic secrets to this file
        # (SSLKEYLOGFILE format), so captures of the PSK dialog can be
        # decrypted (tshark etc). Contains key material - use a temp path.
        self.keylog = keylog or None
        # Connection header value: None = auto ('keep-alive'/'close' per the
        # keep_alive flag), 'none' = omit the header (Apache-style implicit
        # HTTP/1.1 keep-alive, as in the working reference trace).
        self.conn_header = conn_header or None
        # TLS half-close after a script body. NOTE (live 2026-09-16):
        # CPython's SSLSocket.unwrap() poisons the session when the peer does
        # not answer with its own close_notify in time, so this cannot be
        # implemented with the stdlib ssl module; the flag is kept for the
        # option surface and for cards that answer promptly (the exception
        # path leaves the session unusable, so it is off by default).
        self.half_close = half_close
        # Wait before answering a request (the reference Apache/PHP servers
        # answer ~1 s after the card's POST; the card may need its BIP
        # SEND-DATA conversation to settle before it accepts the response).
        self.answer_delay = float(answer_delay or 0)
        self.identity_seen = None
        self.stopped = False
        self.conns = []
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # A quick Stop -> Start can race the previous listener's close (the
        # port stays busy for a moment); retry before giving up.
        last_error = None
        for _ in range(10):
            try:
                self.sock.bind((host, int(port)))
                last_error = None
                break
            except OSError as e:
                last_error = e
                time.sleep(0.3)
        if last_error is not None:
            self.sock.close()
            raise last_error
        self.sock.listen(4)
        self.host, self.port = self.sock.getsockname()[:2]
        self.ctx = self._make_context()
        if self.keylog:
            try:
                self.ctx.keylog_filename = self.keylog
            except (AttributeError, OSError):
                self.keylog = None
        self.thread = threading.Thread(target=self._accept_loop, daemon=True)
        self.thread.start()
        self.log('tls-listener-start', host=self.host, port=self.port)

    def log(self, kind, **fields):
        if self.on_log:
            try:
                self.on_log(kind, **fields)
            except Exception:
                pass

    def _make_context(self):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ver = TLS_VERSIONS[self.tls_version]
        ctx.minimum_version = ver
        ctx.maximum_version = ver
        ciphers = self.cipher or PSK_CIPHERS
        if self.tls_version in ('1.0', '1.1'):
            # OpenSSL 3.x disables the legacy protocol versions by default.
            ciphers += ':@SECLEVEL=0'
        ctx.set_ciphers(ciphers)
        # Prefer our (AES-first) order over the card's NULL-suite-first list.
        ctx.options |= ssl.OP_CIPHER_SERVER_PREFERENCE
        ctx.options |= OP_NO_ENCRYPT_THEN_MAC
        # No TLS session resumption: the live card aborts with
        # SSLV3_ALERT_UNEXPECTED_MESSAGE on the post-handshake
        # NewSessionTicket record (verified live 2026-09-15).
        ctx.options |= ssl.OP_NO_TICKET
        ctx.set_psk_server_callback(self._psk_cb)
        return ctx

    def _psk_cb(self, identity):
        """OpenSSL asks for the key of the identity the client sent."""
        self.identity_seen = identity
        if self.identity is not None and identity != self.identity:
            self.log('tls-psk-unknown', identity=identity)
            # A dummy key keeps the callback type-safe; the handshake then
            # fails on the Finished MAC check.
            return b'\x00' * 16
        return self.psk

    @staticmethod
    def _default_responder(method, target, headers, body):
        """No script configured: close the administration session (4.4.2)."""
        return 204, {'X-Admin-Protocol': GP_PROTOCOL}, b''

    def _accept_loop(self):
        while not self.stopped:
            try:
                self.sock.settimeout(0.2)
                conn, addr = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            self.conns.append(conn)
            peer = '%s:%d' % addr[:2]
            threading.Thread(target=self._conn_loop, args=(conn, peer),
                             daemon=True).start()

    def _read_request(self, tls):
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = tls.recv(4096)
            if not chunk:
                return None
            buf += chunk
            if len(buf) > MAX_HEAD:
                raise ValueError('request head too large')
        head, _, rest = buf.partition(b'\r\n\r\n')
        method, target, headers = parse_http_request(head + b'\r\n\r\n')
        body = rest
        if 'content-length' in headers:
            want = int(headers['content-length'])
            while len(body) < want:
                chunk = tls.recv(4096)
                if not chunk:
                    break
                body += chunk
            body = body[:want]
        elif headers.get('transfer-encoding', '').lower() == 'chunked':
            while not body.endswith(b'0\r\n\r\n'):
                chunk = tls.recv(4096)
                if not chunk:
                    break
                body += chunk
            body = decode_chunked(body)
        return method, target, headers, body

    def _conn_loop(self, conn, peer):
        tls = None
        try:
            tls = self.ctx.wrap_socket(conn, server_side=True)
            self.log('tls-handshake', peer=peer, cipher=tls.cipher()[0],
                     version=tls.version(), identity=self.identity_seen)
            while not self.stopped:
                req = self._read_request(tls)
                if req is None:
                    break
                method, target, headers, body = req
                if self.answer_delay > 0:
                    time.sleep(self.answer_delay)
                self.log('tls-request', peer=peer, method=method, uri=target,
                         headers=headers,
                         agent=headers.get('x-admin-from'),
                         protocol=headers.get('x-admin-protocol'),
                         script_status=headers.get('x-admin-script-status'),
                         resume=headers.get('x-admin-resume'),
                         content_type=headers.get('content-type'),
                         bytes=len(body), body_hex=body.hex().upper()[:2000] or None)
                status, resp_headers, resp_body = self.responder(
                    method, target, headers, body)
                reason = {200: 'OK', 204: 'No Content'}.get(status, 'Status')
                conn = self.conn_header
                if conn == 'none':
                    conn = None
                elif conn is None:
                    conn = 'keep-alive' if self.keep_alive else 'close'
                response = build_http_response(
                    status, reason, resp_headers, resp_body,
                    chunked=self.chunked, compact=self.compact_headers,
                    connection=conn)
                # The card's HTTP client reads its response record-by-record:
                # the whole response must arrive in ONE TLS record (chunk_size
                # 0), otherwise a split head stalls it and a head-only record
                # followed by the body draws an unexpected_message alert. When
                # a chunk_size is given, the head goes in one record and the
                # body in pieces of that size.
                if self.chunk_size <= 0:
                    tls.sendall(response)
                else:
                    head, sep, rest = response.partition(b'\r\n\r\n')
                    tls.sendall(head + sep if sep else head)
                    for off in range(0, len(rest), self.chunk_size):
                        tls.sendall(rest[off:off + self.chunk_size])
                self.log('tls-response', peer=peer, status=status,
                         bytes=len(resp_body), chunked=self.chunked,
                         response_hex=response.hex().upper()[:600],
                         body_hex=resp_body.hex().upper()[:2000] or None)
                # 204 always ends the dialog. Without keep-alive every response
                # ends it: the card's HTTP client appears to delimit the
                # response at connection close (live 2026-09-15) and then
                # starts a fresh session for its next POST.
                if status == 204 or not resp_body or not self.keep_alive:
                    peer_name = None
                    if resp_body and self.on_before_close:
                        try:
                            peer_name = tls.getpeername()
                        except Exception:
                            peer_name = None
                    plain = None
                    if not self.keep_alive:
                        # Clean TLS shutdown BEFORE the card drains the
                        # buffer: a bare TCP close leaves the card's TLS stack
                        # with a truncated session (it then neither processes
                        # the script nor posts the response), and a
                        # close_notify sent only after the drain is never
                        # fetched. Send it while the response still waits, so
                        # the card reads both, then wait for the buffer to
                        # drain and only then send the FIN.
                        try:
                            tls.settimeout(2.0)
                            plain = tls.unwrap()
                            tls = None
                        except Exception:
                            plain = None
                    if peer_name and self.on_before_close:
                        try:
                            self.on_before_close(peer_name)
                        except Exception:
                            pass
                    if plain is not None:
                        try:
                            plain.close()
                        except OSError:
                            pass
                    break
        except ssl.SSLError as e:
            self.log('tls-error', peer=peer, error=str(e))
        except (OSError, ValueError) as e:
            self.log('tls-error', peer=peer, error=str(e))
        finally:
            if tls is not None:
                try:
                    tls.close()
                except OSError:
                    pass
            else:
                try:
                    conn.close()
                except OSError:
                    pass
            self.log('tls-close', peer=peer)
            if conn in self.conns:
                self.conns.remove(conn)

    def stop(self):
        self.stopped = True
        self.log('tls-listener-stop', host=self.host, port=self.port)
        try:
            self.sock.close()
        except OSError:
            pass
        for conn in list(self.conns):
            try:
                conn.close()
            except OSError:
                pass
        self.conns = []
