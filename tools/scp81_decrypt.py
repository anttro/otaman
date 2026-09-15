#!/usr/bin/env python3
"""Decrypt the SCP81 PSK-TLS dialog from a server log + keylog.

The server's /api/scp81/log has every TLS record of the dialog (send = card,
receive = card fetch, i.e. the server stream), and the listener can write the
TLS secrets (SSLKEYLOGFILE) when started with a "keylog" path. With the
PSK-AES128-CBC-SHA256 dialog we can derive the record keys (TLS 1.2
PRF/master secret) and decrypt the card's alerts, which are otherwise opaque.

Usage: scp81_decrypt.py <log.json> <keys.log>
"""
import hashlib
import hmac
import json
import subprocess
import sys


def p_sha256(secret, seed, length):
    out = b''
    a = seed
    while len(out) < length:
        a = hmac.new(secret, a, hashlib.sha256).digest()
        out += hmac.new(secret, a + seed, hashlib.sha256).digest()
    return out[:length]


def aes_cbc_decrypt(key, iv, data):
    p = subprocess.run(['openssl', 'enc', '-d', '-aes-128-cbc', '-nopad',
                        '-K', key.hex(), '-iv', iv.hex()],
                       input=data, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode())
    return p.stdout


def record_payloads(stream):
    """Walk TLS records in a byte stream, yield (type, version, payload)."""
    i = 0
    while i + 5 <= len(stream):
        rtype, ver, ln = stream[i], stream[i + 1:i + 3], int.from_bytes(stream[i + 3:i + 5], 'big')
        body = stream[i + 5:i + 5 + ln]
        if len(body) < ln:
            break
        yield rtype, ver, body
        i += 5 + ln


def find_random(stream, hs_type):
    """Return the 32-byte random of a ClientHello/ServerHello in the stream."""
    for rtype, ver, body in record_payloads(stream):
        if rtype != 0x16 or not body or body[0] != hs_type:
            continue
        hslen = int.from_bytes(body[1:4], 'big')
        hs = body[:4 + hslen]
        return hs[6:38]
    return None


def main():
    log_path, keys_path = sys.argv[1], sys.argv[2]
    entries = sorted(json.load(open(log_path))['entries'], key=lambda x: x['seq'])
    # Only the last TLS session: start at the final OPEN CHANNEL.
    start = 0
    for i, e in enumerate(entries):
        if e.get('kind') == 'open':
            start = i
    entries = entries[start:]
    client = b''
    server = b''
    for e in entries:
        if e.get('kind') == 'send' and e.get('hex'):
            client += bytes.fromhex(e['hex'])
        elif e.get('kind') == 'receive' and e.get('hex'):
            server += bytes.fromhex(e['hex'])

    crandom = find_random(client, 0x01)
    srandom = find_random(server, 0x02)
    print('client_random:', crandom.hex() if crandom else None)
    print('server_random:', srandom.hex() if srandom else None)
    if not crandom or not srandom:
        sys.exit('handshake randoms not found in log')

    master = None
    for line in open(keys_path):
        parts = line.split()
        if parts and parts[0] == 'CLIENT_RANDOM' and parts[1] == crandom.hex():
            master = bytes.fromhex(parts[2])
    if not master:
        sys.exit('master secret not found in keylog')
    print('master_secret:', master.hex())

    kb = p_sha256(master, b'key expansion' + srandom + crandom, 96)
    client_mac, server_mac = kb[0:32], kb[32:64]
    client_key, server_key = kb[64:80], kb[80:96]
    print('client_key: %s  server_key: %s' % (client_key.hex(), server_key.hex()))

    names = {0x15: 'alert', 0x16: 'handshake', 0x17: 'appdata', 0x14: 'ccs'}
    for who, stream, key in (('card', client, client_key),
                             ('server', server, server_key)):
        app_seq = 0
        for rtype, ver, body in record_payloads(stream):
            if rtype not in (0x15, 0x17) or len(body) < 16 + 32:
                continue
            iv, ct, mac = body[:16], body[16:-32], body[-32:]
            try:
                pt = aes_cbc_decrypt(key, iv, ct)
            except RuntimeError as e:
                print('%s seq%d %s: decrypt failed: %s' % (who, app_seq, names.get(rtype), e))
                app_seq += 1
                continue
            # verify the record MAC (seq, type, version, len, plaintext)
            h = hmac.new(client_mac if who == 'card' else server_mac,
                         app_seq.to_bytes(8, 'big') + bytes([rtype]) + ver +
                         len(pt).to_bytes(2, 'big') + pt, hashlib.sha256).digest()
            mac_ok = hmac.compare_digest(h, mac)
            desc = ''
            if rtype == 0x15 and len(pt) >= 2:
                level = {1: 'warning', 2: 'fatal'}.get(pt[0], str(pt[0]))
                alerts = {0: 'close_notify', 10: 'unexpected_message',
                          20: 'bad_record_mac', 40: 'handshake_failure',
                          46: 'protocol_version', 47: 'illegal_parameter',
                          48: 'unknown_ca', 49: 'access_denied',
                          50: 'decode_error', 51: 'decrypt_error',
                          80: 'internal_error', 90: 'user_canceled',
                          100: 'no_renegotiation', 110: 'unsupported_extension',
                          112: 'unrecognized_name'}
                desc = 'ALERT %s %s' % (level, alerts.get(pt[1], pt[1]))
            print('%s seq%d %-9s mac_ok=%s pt=%s %s'
                  % (who, app_seq, names.get(rtype), mac_ok, pt[:48].hex(), desc))
            app_seq += 1


if __name__ == '__main__':
    main()
