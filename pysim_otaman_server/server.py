import json
import sys
import os
import time
import threading
import traceback
import re
import codecs
from datetime import datetime, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from io import StringIO
from pySim.transport import ApduTracer, ProactiveHandler
from pySim.cards import UiccCardBase

import gsm0338  # registers 'gsm03.38' codec
from construct import GreedyBytes
from osmocom.construct import GsmOrUcs2Adapter


VERSION = '1.7.0'


# Static file serving (the PWA lives in <repo>/frontend, served by this server
# so the UI and the API share an origin and no CORS/PNA is involved).
_STATIC_MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
    '.map': 'application/json',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
}


class StderrApduTracer(ApduTracer):
    def __init__(self):
        super().__init__()
        self._cmd_start = 0

    def trace_command(self, cmd):
        self._cmd_start = time.time()

    def trace_response(self, cmd, sw, resp):
        elapsed = int((time.time() - self._cmd_start) * 1000)
        msg = 'APDU-TRACE(%dms): %s → SW: %s' % (elapsed, cmd, sw)
        if resp:
            msg += ' RESP: %s' % resp
        os.write(2, (msg + '\n').encode())


ERROR_MSGS = {
    'en': {
        'app_not_init': 'Server not initialized',
        'no_card_state': 'No card state available',
        'reader_not_init': 'Reader not initialized',
        'not_found': 'Not found',
    },
    'ru': {
        'app_not_init': 'Сервер не инициализирован',
        'no_card_state': 'Состояние карты недоступно',
        'reader_not_init': 'Считыватель не инициализирован',
        'not_found': 'Не найдено',
    },
}


def _get_lang(headers):
    lang = headers.get('Accept-Language', 'en')
    if lang not in ('en', 'ru'):
        lang = 'en'
    return lang


def _err(key, lang):
    return ERROR_MSGS.get(lang, ERROR_MSGS['en']).get(key, key)


def _strip_ansi(text):
    return re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', text)


def _parse_help_text(text):
    result = {'usage': '', 'description': '', 'args': []}
    lines = text.split('\n')
    in_usage = False
    in_pos = False
    in_opt = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('usage:'):
            result['usage'] = stripped[6:].strip()
            in_usage = True
            in_pos = in_opt = False
        elif stripped.startswith('positional arguments:'):
            in_pos = True
            in_opt = in_usage = False
        elif stripped.startswith('options:') or stripped.startswith('optional arguments:'):
            in_opt = True
            in_pos = in_usage = False
        elif in_pos and stripped and not stripped.startswith('usage:'):
            m = re.match(r'^(\S+)\s+(.+)$', stripped)
            if m:
                result['args'].append({'name': m.group(1), 'type': 'positional', 'help': m.group(2)})
        elif in_opt and stripped and not stripped.startswith('usage:'):
            m = re.match(r'^(\S+(?:,\s*\S+)?)\s+(\S+\s+)?(.+)?$', stripped)
            if m:
                names = m.group(1)
                first_name = names.split(',')[0].strip()
                result['args'].append({'name': first_name, 'type': 'optional', 'help': (m.group(3) or '').strip()})
        elif not in_pos and not in_opt and not in_usage:
            if stripped:
                result['description'] = (result['description'] + ' ' + stripped).strip()
    return result


def _get_file_type(lchan, cur_file):
    if cur_file and cur_file.name:
        if cur_file.name.startswith('EF.'):
            if lchan and lchan.selected_file_fcp:
                ft = lchan.selected_file_type()
                if ft != 'df':
                    return lchan.selected_file_structure()
            return 'transparent'
        if cur_file.name.startswith('DF.') or cur_file.name.startswith('ADF.') or cur_file.name == 'MF':
            return 'df'
    if lchan and lchan.selected_file_fcp:
        return lchan.selected_file_structure()
    return None


def _select_with_parent(lchan, name, parent_sel, app):
    if parent_sel:
        lchan.select(parent_sel, app)
    fcp = lchan.select(name, app)
    return fcp


def _parse_tree_output(output):
    lines = (output or '').split('\n')
    children = []
    for line in lines:
        if line.startswith(' '):
            continue
        m = re.match(r'^(\S+)\s+([0-9a-fA-F]{4})?(?:\s|$)', line)
        if m:
            cname = m.group(1)
            cfid = m.group(2).lower() if m.group(2) else None
            children.append({
                'name': cname,
                'fid': cfid,
                'isDir': cname.startswith('ADF.') or cname.startswith('DF.') or cname == 'MF',
            })
    return children


def _encode_sms_oa(number):
    digits = [int(c) for c in number if c.isdigit()]
    oa = bytes([len(digits), 0x81])
    for i in range(0, len(digits), 2):
        first = digits[i]
        second = digits[i + 1] if i + 1 < len(digits) else 0xF
        oa += bytes([(second << 4) | first])
    return oa


def _bcd_pair(value):
    return ((value % 10) << 4) | ((value // 10) % 10)


def _encode_scts(dt=None):
    dt = dt or datetime.now().astimezone()
    offset = dt.utcoffset() or timedelta()
    quarters = int(offset.total_seconds() // 900)
    tz = _bcd_pair(abs(quarters)) | (0x08 if quarters < 0 else 0x00)
    return bytes([
        _bcd_pair(dt.year % 100),
        _bcd_pair(dt.month),
        _bcd_pair(dt.day),
        _bcd_pair(dt.hour),
        _bcd_pair(dt.minute),
        _bcd_pair(dt.second),
        tz,
    ])


def _build_sms_tpdu(chunk_hex, chunk_total=1, chunk_num=1, oa_number='12345', include_cpi=True):
    chunk = bytes.fromhex(chunk_hex)
    # TS 23.040 UDH: first octet is UDHL, then the information elements.
    # TS 31.115 4.2/4.3: the OTA CPI is UDH IEIa='70' with IEIDLa='00'.
    udh = b''
    if chunk_total > 1:
        udh = bytes([0x00, 0x03, 0x01, chunk_total, chunk_num])
        if chunk_num == 1 and include_cpi:
            udh += bytes([0x70, 0x00])
    elif include_cpi:
        udh = bytes([0x70, 0x00])
    tp_ud = (bytes([len(udh)]) + udh + chunk) if udh else chunk
    first_byte = 0x44 if udh and chunk_total > 1 else (0x40 if udh else 0x04)
    tpdu = bytes([first_byte]) + _encode_sms_oa(oa_number) + bytes([0x7F, 0xF6]) + _encode_scts() + bytes([len(tp_ud)]) + tp_ud
    return tpdu.hex()


def _send_envelope(tpdu_hex, scc, sm_sc='12345678912', submit_handler=None):
    from pySim.ts_31_102 import SMSPPDownload
    from pySim.cat import DeviceIdentities, Address
    from osmocom.tlv import COMPR_TLV_IE
    from pySim.utils import b2h

    class RawTpdu(COMPR_TLV_IE, tag=0x8B):
        comprehension = False
        def __init__(self, data_hex):
            super().__init__()
            self._raw = bytes.fromhex(data_hex)
        def to_bytes(self, context={}):
            return self._raw

    address = Address()
    oa_raw = _encode_sms_oa(sm_sc)
    address.from_bytes(oa_raw[1:])

    dev_ids = DeviceIdentities(decoded={'source_dev_id': 'network', 'dest_dev_id': 'uicc'})
    raw_tpdu = RawTpdu(tpdu_hex)
    sms_dl = SMSPPDownload(children=[dev_ids, address, raw_tpdu])
    env_hex = '%sc20000%02x%s' % (scc.cat_cla, len(sms_dl.to_tlv()), b2h(sms_dl.to_tlv()))
    data, sw = scc._tp.send_apdu(env_hex)
    if sw.startswith('61'):
        get_len = int(sw[2:], 16) if len(sw) == 4 else 0x100
        data, sw = scc._tp.send_apdu('00c00000%02x' % get_len)
    elif sw.startswith('91'):
        def _capture_sms_tpdu(raw, cmd_num, cmd_type, dev_src, dev_dst):
            if submit_handler:
                submit_handler.submit_tpdu_hex = _find_sms_tpdu(raw)
        _handle_proactive_chain(scc, sw, _capture_sms_tpdu)
        data, sw = '', '9000'
    if sw == '9000' and submit_handler and not submit_handler.submit_tpdu_hex:
        sys.stderr.write('STATUS poll (PoR not captured)\n')
        st_data, st_sw = _send_status(scc)
        sys.stderr.write('STATUS -> %s\n' % st_sw)
        if st_sw.startswith('91'):
            _handle_proactive_chain(scc, st_sw, _capture_sms_tpdu)
    return data, sw


# TS 03.48 / TS 102 225 SPI coding
_RC_CC_DS = {0: 'no_rc_cc_ds', 1: 'rc', 2: 'cc', 3: 'ds'}
_CNTR_REQ = {0: 'no_counter', 1: 'counter_no_replay_or_seq', 2: 'counter_must_be_higher', 3: 'counter_must_be_lower'}
_POR_REQ = {0: 'no_por', 1: 'por_required', 2: 'por_only_when_error'}
_CRYPT_ALGO = {1: 'single_des', 5: 'triple_des_cbc2', 9: 'triple_des_cbc3', 2: 'aes_cbc'}
_AUTH_ALGO = {1: 'single_des', 5: 'triple_des_cbc2', 9: 'triple_des_cbc3', 2: 'aes_cmac'}


def _spi_from_bytes(spi1, spi2):
    return {
        'counter': _CNTR_REQ[(spi1 >> 3) & 0x03],
        'ciphering': bool(spi1 & 0x04),
        'rc_cc_ds': _RC_CC_DS[spi1 & 0x03],
        'por_in_submit': bool(spi2 & 0x20),
        'por_shall_be_ciphered': bool(spi2 & 0x10),
        'por_rc_cc_ds': _RC_CC_DS[(spi2 >> 2) & 0x03],
        'por': _POR_REQ[spi2 & 0x03],
    }


def _ota_keyset(spi1, spi2, kic, kid, cntr_hex, kic_key_hex, kid_key_hex):
    from pySim.ota import OtaKeyset
    from osmocom.utils import h2b
    kic_b = int(kic, 16)
    kid_b = int(kid, 16)
    algo_crypt = _CRYPT_ALGO.get(kic_b & 0x0F)
    algo_auth = _AUTH_ALGO.get(kid_b & 0x0F)
    if algo_crypt is None:
        raise ValueError('Unsupported KIc algorithm nibble %02X' % (kic_b & 0x0F))
    if algo_auth is None:
        raise ValueError('Unsupported KID algorithm nibble %02X' % (kid_b & 0x0F))
    return OtaKeyset(algo_crypt=algo_crypt, kic_idx=kic_b >> 4, kic=h2b(kic_key_hex),
                     algo_auth=algo_auth, kid_idx=kid_b >> 4, kid=h2b(kid_key_hex),
                     cntr=int(cntr_hex, 16) if cntr_hex else 0)


def _ota_reference(spi1, spi2, kic, kid, tar_hex, cntr_hex, apdu_hex, kic_key_hex, kid_key_hex):
    from pySim.ota import OtaDialectSms
    from osmocom.utils import h2b, b2h
    otak = _ota_keyset(spi1, spi2, kic, kid, cntr_hex, kic_key_hex, kid_key_hex)
    spi = _spi_from_bytes(int(spi1, 16), int(spi2, 16))
    out = OtaDialectSms().encode_cmd(otak, h2b(tar_hex), spi, h2b(apdu_hex))
    if not spi['ciphering'] and spi['rc_cc_ds'] != 'no_rc_cc_ds':
        # pySim drops the CPL octets from its unciphered output; re-add them
        # (they are included in the RC/CC/DS calculation) per TS 31.115 4.2.
        # CPL counts octets from the CHL octet to the last octet of the
        # Secured Data (incl. padding); pySim's unciphered output is exactly
        # that range, so the CPL value equals its length.
        cpl = len(out)
        out = cpl.to_bytes(2, 'big') + out
    return b2h(out), spi


def _decode_por(spi1, spi2, kic, kid, cntr_hex, kic_key_hex, kid_key_hex, response_hex):
    from pySim.ota import OtaDialectSms
    from osmocom.utils import h2b, b2h
    if not response_hex:
        return None
    otak = _ota_keyset(spi1, spi2, kic, kid, cntr_hex, kic_key_hex, kid_key_hex)
    spi = _spi_from_bytes(int(spi1, 16), int(spi2, 16))
    try:
        data = h2b(response_hex)
        if not data or data[0] != 0x02:
            return None
        res, dec = OtaDialectSms().decode_resp(otak, spi, data)
    except Exception:
        # any malformed/garbage PoR (non-hex, bad UDL, truncated fields,
        # bad CC) is not a POR; never let decoding crash the request handler.
        return None
    out = {
        'response_status': str(res['response_status']),
        'tar': res['tar'].hex().upper(),
        'pcntr': res['pcntr'],
    }
    if dec is not None:
        out['decoded'] = {
            'number_of_commands': dec['number_of_commands'],
            'last_status_word': str(dec['last_status_word']),
            'last_response_data': str(dec['last_response_data']),
        }
    return out


class PoRSubmitHandler(ProactiveHandler):
    """Captures the SMS-SUBMIT TPDU from a SendShortMessage proactive command
    issued by the SIM in response to PoR-in-submit (SPI2 bit 0x20).
    The 91XX path in _send_envelope scans the FETCH response directly for
    the SMS_TPDU child (tag 0x8B) and populates submit_tpdu_hex."""
    def __init__(self):
        super().__init__()
        self.submit_tpdu_hex = None


class _DefaultProactiveHandler(ProactiveHandler):
    """Catch-all for any proactive command not explicitly handled. Responds
    with 'performed_successfully' so pySim's auto-fetch never crashes."""
    def receive_fetch_raw(self, pcmd, parsed):
        return self.prepare_response(pcmd, 'performed_successfully')


_STK_DECODE = GsmOrUcs2Adapter(GreedyBytes)

_PROACTIVE_LOG = []
_PROACTIVE_SESSION_START = None

PROACTIVE_TYPE_NAMES = {
    0x03: 'POLL INTERVAL', 0x05: 'SET UP EVENT LIST',
    0x13: 'SEND SHORT MESSAGE', 0x20: 'PLAY TONE',
    0x21: 'DISPLAY TEXT', 0x22: 'GET INKEY', 0x23: 'GET INPUT',
    0x24: 'SELECT ITEM', 0x25: 'SET UP MENU',
    0x26: 'PROVIDE LOCAL INFORMATION',
    0x15: 'LAUNCH BROWSER', 0x70: 'ACTIVATE',
}

PLI_QUALIFIER_NAMES = {
    0x00: 'Location Information (MCC, MNC, LAC/TAC, Cell ID)',
    0x01: 'IMEI',
    0x02: 'Network Measurement results',
    0x03: 'Date, time and time zone',
    0x04: 'Language setting',
    0x05: 'Timing Advance',
    0x06: 'Access Technology (single)',
    0x08: 'IMEISV',
    0x09: 'Search Mode',
    0x0A: 'Battery charge state',
    0x0C: 'Current WSID',
    0x0D: 'Broadcast Network information',
    0x0E: 'Multiple Access Technologies',
    0x0F: 'Location Info (multi-RAT)',
    0x10: 'NMR (multi-RAT)',
    0x11: 'CSG ID list + HNB name',
    0x12: 'H(e)NB IP address',
    0x13: 'H(e)NB surrounding macrocells',
    0x14: 'Current WLAN identifier',
    0x15: 'Slices information',
    0x16: 'CAG information list',
    0x17: 'Rejected slices information',
}

_PLI_DATA = {q: '' for q in PLI_QUALIFIER_NAMES}

_POLL_ENABLED = False
_POLL_INTERVAL = 30
_POLL_TIMER = None
_POLL_LOCK = threading.Lock()
_CARD_CONNECTED = False

def _set_poll_interval(seconds):
    global _POLL_INTERVAL
    _POLL_INTERVAL = max(1, min(255, int(seconds)))

def _reset_poll_timer():
    global _POLL_TIMER
    if _POLL_TIMER is not None:
        _POLL_TIMER.cancel()
        _POLL_TIMER = None
    if _POLL_ENABLED:
        _POLL_TIMER = threading.Timer(_POLL_INTERVAL, _do_status_poll)
        _POLL_TIMER.daemon = True
        _POLL_TIMER.start()

def _do_status_poll():
    global _POLL_TIMER
    _POLL_TIMER = None
    if not _POLL_ENABLED:
        return
    with _POLL_LOCK:
        try:
            scc = getattr(_server_ref, 'scc', None) if _server_ref else None
            if not scc:
                return
            st_data, st_sw = _send_status(scc)
            sys.stderr.write('AUTO-STATUS -> %s\n' % st_sw)
            if st_sw.startswith('91'):
                _handle_proactive_chain(scc, st_sw)
        except Exception as e:
            sys.stderr.write('AUTO-STATUS error: %s\n' % e)
            _handle_card_disconnect()
    _reset_poll_timer()

def _poll_enable():
    global _POLL_ENABLED
    _POLL_ENABLED = True
    _reset_poll_timer()

def _poll_disable():
    global _POLL_ENABLED, _POLL_TIMER
    _POLL_ENABLED = False
    if _POLL_TIMER is not None:
        _POLL_TIMER.cancel()
        _POLL_TIMER = None

_server_ref = None


def _tr_data_only(tr_tlv):
    """Strip boilerplate CTLVs (Command Details, Device IDs, Result) from TR,
    returning only command-specific data TLVs or empty bytes."""
    skip_tags = {0x81, 0x82, 0x03, 0x83}
    data = bytearray()
    off = 0
    while off < len(tr_tlv) - 1:
        tag, tlen = tr_tlv[off], tr_tlv[off + 1]
        val = tr_tlv[off + 2: off + 2 + tlen]
        off += 2 + tlen
        if tag not in skip_tags:
            data.extend(tr_tlv[off - 2 - tlen: off])
    return bytes(data)


def _handle_card_disconnect():
    global _CARD_CONNECTED
    _poll_disable()
    _CARD_CONNECTED = False
    if _server_ref:
        _server_ref.card = None
        _server_ref.scc = None
        _server_ref.stk_pending = None
        _server_ref.menu_active = False
        _server_ref.event_list = None
        _server_ref.sim_menu = None
    _reset_proactive_log()


def _init_proactive_session():
    global _PROACTIVE_SESSION_START
    _PROACTIVE_SESSION_START = time.time()


def _log_proactive(cmd_type, raw, qualifier=None):
    if _PROACTIVE_SESSION_START is None:
        return
    entry = {
        'type_hex': '%02x' % cmd_type,
        'type_name': PROACTIVE_TYPE_NAMES.get(cmd_type, 'UNKNOWN'),
        'elapsed': round(time.time() - _PROACTIVE_SESSION_START, 1),
        'bytes': len(raw) if raw else 0,
        'raw': raw.hex() if raw else None,
    }
    if qualifier is not None:
        entry['qualifier'] = '%02x' % qualifier
    _PROACTIVE_LOG.append(entry)
    return entry


def _reset_proactive_log():
    global _PROACTIVE_LOG, _PROACTIVE_SESSION_START
    _PROACTIVE_LOG.clear()
    _PROACTIVE_SESSION_START = time.time()


def _send_status(scc):
    """STATUS (F2) with correct P3 per card type: SIM=0x23, UICC=0x00."""
    p3 = '23' if scc.cat_cla == 'a0' else '00'
    return scc._tp.send_apdu('%sf20000%s' % (scc.cat_cla, p3))


def _send_event_download(scc, event_type, event_data=None):
    """Send ENVELOPE(Event Download) for the given event type.
    Builds: CLA C2 0000 Lc  D6 [len] (99 01 [type] 82 02 82 81 [extra])"""
    inner = bytearray()
    inner.extend([0x99, 0x01, event_type])
    inner.extend([0x82, 0x02, 0x82, 0x81])
    if event_data:
        inner.extend(event_data)
    d6_tlv = bytes([0xD6, len(inner)]) + bytes(inner)
    env_hex = '%sc20000%02x%s' % (scc.cat_cla, len(d6_tlv), d6_tlv.hex())
    sys.stderr.write('ENVELOPE(Event Download): type=0x%02x data=%s\n' % (event_type, event_data.hex() if event_data else '(none)'))
    data, sw = scc._tp.send_apdu(env_hex)
    sys.stderr.write('ENVELOPE SW: %s\n' % sw)
    if sw.startswith('91'):
        _handle_proactive_chain(scc, sw)
        sw = '9000'
    return data, sw


def _skip_ber_len(raw, off):
    if off >= len(raw):
        return off
    if raw[off] < 0x80:
        return off + 1
    if raw[off] == 0x81:
        return off + 2
    return off + 3


def _decode_stk_text(raw):
    try:
        return _STK_DECODE._decode(raw, {}, 'stk')
    except Exception:
        return raw.hex()


def _decode_dcs_text(raw):
    if not raw or len(raw) < 2:
        return raw.hex() if raw else ''
    try:
        dcs = raw[0]
        data = raw[1:]
        if (dcs & 0x0C) == 0x08:
            return codecs.decode(data, 'utf_16_be')
        if (dcs & 0x0C) == 0x04:
            return data.decode('latin-1', errors='replace')
        return codecs.decode(data, 'gsm03.38')
    except Exception:
        return raw.hex()


def _parse_proactive_header(raw):
    cmd_num, cmd_type = 1, 0
    cmd_qual = None
    dev_src, dev_dst = 0x83, 0x81
    if raw[0] == 0xD0:
        off = _skip_ber_len(raw, 1)
        while off < len(raw) - 1:
            tag, tlen = raw[off], raw[off + 1]
            val = raw[off + 2: off + 2 + tlen]; off += 2 + tlen
            if tag == 0x81 and tlen >= 3:
                cmd_num, cmd_type, cmd_qual = val[0], val[1], val[2]
            elif tag == 0x82 and tlen >= 2:
                dev_src, dev_dst = val[0], val[1]
    return cmd_num, cmd_type, dev_src, dev_dst, cmd_qual


def _find_sms_tpdu(raw):
    if raw[0] == 0xD0:
        off = _skip_ber_len(raw, 1)
        while off < len(raw) - 1:
            tag, tlen = raw[off], raw[off + 1]
            val = raw[off + 2: off + 2 + tlen]; off += 2 + tlen
            if tag == 0x8B and tlen >= 1:
                return val.hex()
    return None


def _parse_display_text(raw):
    if raw[0] == 0xD0:
        off = _skip_ber_len(raw, 1)
        while off < len(raw) - 1:
            tag, tlen = raw[off], raw[off + 1]
            val = raw[off + 2: off + 2 + tlen]; off += 2 + tlen
            if tag == 0x8D and tlen >= 1:
                return _decode_dcs_text(val)
    return None


def _parse_select_item(raw):
    items = []
    if raw[0] == 0xD0:
        off = _skip_ber_len(raw, 1)
        while off < len(raw) - 1:
            tag, tlen = raw[off], raw[off + 1]
            val = raw[off + 2: off + 2 + tlen]; off += 2 + tlen
            if tag == 0x05 and tlen >= 1:
                try:
                    _title = _decode_stk_text(val)
                except Exception:
                    pass
            elif tag in (0x8F, 0x0F) and tlen >= 2:
                items.append({'id': val[0], 'text': _decode_stk_text(val[1:])})
    return items


def _parse_setup_menu_items(raw):
    items = []
    if not raw or raw[0] != 0xD0:
        return items
    off = _skip_ber_len(raw, 1)
    while off < len(raw) - 1:
        tag, tlen = raw[off], raw[off + 1]
        val = raw[off + 2: off + 2 + tlen]; off += 2 + tlen
        if tag == 0x8F and tlen >= 2:
            items.append({'id': val[0], 'text': _decode_stk_text(val[1:])})
    return items


def _handle_proactive_chain(scc, sw91, on_fetch=None):
    sys.stderr.write('91XX chain: sw=%s\n' % sw91)
    sw = sw91
    while sw.startswith('91'):
        fetch_len = int(sw[2:], 16) if len(sw) == 4 else 0x100
        rv = scc._tp.send_apdu('%s120000%02x' % (scc.cat_cla, fetch_len))
        sys.stderr.write('FETCH(%s): %s -> %s\n' % (fetch_len, rv[0][:80] if rv[0] else '(none)', rv[1]))
        fdata, sw = rv[0], rv[1]
        raw = bytes.fromhex(fdata) if fdata else None
        action = None
        if raw:
            cmd_num, cmd_type, dev_src, dev_dst, cmd_qual = _parse_proactive_header(raw)
            entry = _log_proactive(cmd_type, raw, cmd_qual)
        else:
            cmd_num, cmd_type, dev_src, dev_dst, cmd_qual = 1, 0, 0x83, 0x81, None
            entry = None
        if on_fetch:
            action = on_fetch(raw, cmd_num, cmd_type, dev_src, dev_dst)
        if action != 'pause':
            if cmd_type == 0x03:
                tr_tlv = bytes([0x81, 0x03, cmd_num, cmd_type, 0x00,
                                0x82, 0x02, dev_dst, dev_src,
                                0x84, 0x02, 0x01, _POLL_INTERVAL,
                                0x03, 0x01, 0x00])
            else:
                base = bytes([0x81, 0x03, cmd_num, cmd_type, 0x00,
                              0x82, 0x02, dev_dst, dev_src])
                if cmd_type == 0x26 and cmd_qual is not None:
                    pli_hex = _PLI_DATA.get(cmd_qual, '')
                    if pli_hex:
                        base += bytes.fromhex(pli_hex)
                tr_tlv = base + bytes([0x03, 0x01, 0x00])
            tr_rv = scc._tp.send_apdu('%s140000%02x%s' % (scc.cat_cla, len(tr_tlv), tr_tlv.hex()))
            sys.stderr.write('TR: cmd=%02x type=%02x -> %s %s\n' % (cmd_num, cmd_type, tr_rv[1], ('(%d bytes)' % len(tr_tlv))))
            if entry:
                entry['tr_hex'] = _tr_data_only(tr_tlv).hex()
                entry['tr_sw'] = tr_rv[1]
            sw = tr_rv[1]
            if sw == '9000':
                sys.stderr.write('STATUS poll (chain ended)\n')
                st_data, st_sw = _send_status(scc)
                sys.stderr.write('STATUS -> %s\n' % st_sw)
                if st_sw.startswith('91'):
                    sw = st_sw
            if action == 'exit':
                return sw


def _send_terminal_profile(scc, tp_hex):
    tp_data, tp_sw = scc._tp.send_apdu('%s100000%02x%s' % (scc.cat_cla, len(tp_hex) // 2, tp_hex))
    sim_menu = None
    sim_menu = None
    event_list = None
    if tp_sw.startswith('91'):
        sw = tp_sw
        while sw.startswith('91'):
            fetch_len = int(sw[2:], 16) if len(sw) == 4 else 0xff
            fdata, sw = scc._tp.send_apdu('%s120000%02x' % (scc.cat_cla, fetch_len))
            cmd_num, cmd_type = 1, 0
            cmd_qual = None
            dev_src, dev_dst = 0x83, 0x81
            if fdata:
                raw = bytes.fromhex(fdata)
                if raw[0] == 0xD0:
                    off = _skip_ber_len(raw, 1)
                    menu = None
                    items = []
                    while off < len(raw) - 1:
                        tag, tlen = raw[off], raw[off + 1]
                        val = raw[off + 2: off + 2 + tlen]
                        off += 2 + tlen
                        if tag == 0x81 and tlen >= 3:
                            cmd_num, cmd_type, cmd_qual = val[0], val[1], val[2]
                            if cmd_type == 0x25:
                                menu = {'command_number': cmd_num, 'items': items}
                        elif tag == 0x82 and tlen >= 2:
                            dev_src, dev_dst = val[0], val[1]
                        elif tag == 0x05 and tlen >= 1 and menu is not None:
                            try:
                                menu['title'] = _STK_DECODE._decode(val, {}, 'stk_title')
                            except Exception:
                                menu['title'] = val.hex()
                        elif tag == 0x8F and tlen >= 2:
                            try:
                                txt = _STK_DECODE._decode(val[1:], {}, 'stk_item')
                            except Exception:
                                txt = val[1:].hex()
                            items.append({'id': val[0], 'text': txt})
                        elif tag in (0x99, 0x19) and tlen >= 1:
                            event_list = [b for b in val]
                    if menu:
                        sim_menu = menu
            if fdata and cmd_type:
                entry = _log_proactive(cmd_type, raw, cmd_qual)
            else:
                entry = None
            if cmd_type == 0x03:
                tr_tlv = bytes([0x81, 0x03, cmd_num, cmd_type, 0x00,
                                0x82, 0x02, dev_dst, dev_src,
                                0x84, 0x02, 0x01, _POLL_INTERVAL,
                                0x03, 0x01, 0x00])
            else:
                base = bytes([0x81, 0x03, cmd_num, cmd_type, 0x00,
                              0x82, 0x02, dev_dst, dev_src])
                if cmd_type == 0x26 and cmd_qual is not None:
                    pli_hex = _PLI_DATA.get(cmd_qual, '')
                    if pli_hex:
                        base += bytes.fromhex(pli_hex)
                tr_tlv = base + bytes([0x03, 0x01, 0x00])
            tr_rv = scc._tp.send_apdu('%s140000%02x%s' % (scc.cat_cla, len(tr_tlv), tr_tlv.hex()))
            sys.stderr.write('TR(tp): cmd=%02x type=%02x -> %s\n' % (cmd_num, cmd_type, tr_rv[1]))
            if entry:
                entry['tr_hex'] = _tr_data_only(tr_tlv).hex()
                entry['tr_sw'] = tr_rv[1]
            sw = tr_rv[1]
            if sw == '9000':
                sys.stderr.write('STATUS poll (tp chain ended)\n')
                st_data, st_sw = _send_status(scc)
                sys.stderr.write('STATUS -> %s\n' % st_sw)
                if st_sw.startswith('91'):
                    sw = st_sw
    return sim_menu, event_list


class PysimHandler(BaseHTTPRequestHandler):
    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length))

    def _log_req(self, body=None):
        if self.server.log_requests:
            if body is not None:
                sys.stderr.write("REQUEST %s %s: %s\n" % (self.command, self.path, json.dumps(body)))
            else:
                sys.stderr.write("REQUEST %s %s\n" % (self.command, self.path))

    def _log_resp(self, data):
        if self.server.log_requests:
            sys.stderr.write("RESPONSE %s: %s\n" % (self.path, json.dumps(data, ensure_ascii=False)))

    def do_OPTIONS(self):
        self._log_req()
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        # Chrome/Edge Private Network Access: a page served from a public (or
        # otherwise less-local) origin needs explicit permission to reach this
        # loopback server. Without this, the preflight fails and the browser
        # blocks the follow-up GET/POST ("Permission was denied ... loopback").
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()

    def _serve_static(self):
        web_dir = getattr(self.server, 'web_dir', None)
        if not web_dir:
            self.send_error(404)
            return
        rel = self.path.split('?', 1)[0].lstrip('/')
        if rel in ('', '/'):
            rel = 'index.html'
        if '..' in rel.split('/') or rel.startswith('/'):
            self.send_error(404)
            return
        fs_path = os.path.join(web_dir, rel)
        if not os.path.isfile(fs_path):
            self.send_error(404)
            return
        with open(fs_path, 'rb') as f:
            data = f.read()
        content_type = _STATIC_MIME.get(os.path.splitext(rel)[1].lower(), 'application/octet-stream')
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        if rel in ('index.html', 'sw.js'):
            self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        lang = _get_lang(self.headers)
        if self.path == '/api/version':
            self._log_req()
            self._send_json({'version': VERSION})
            self._log_resp({'version': VERSION})
        elif self.path == '/api/status':
            self._log_req()
            app = self.server.app
            rs = app.rs if app else None
            lchan = rs.lchan[0] if rs else None
            cur_file = lchan.selected_file if lchan else None
            scc = app.card._scc if app and app.card else None
            data = {
                'reader': str(self.server.sl) if self.server.sl else None,
                'card': app.card.name if app and app.card else None,
                'profile': str(rs.profile) if rs and rs.profile else None,
                'app_ready': app is not None,
                'adm_verified': rs.adm_verified if rs else False,
                'atr': rs.identity.get('ATR') if rs and rs.identity else None,
                'cla_byte': scc.cla_byte if scc else None,
                'sel_ctrl': scc.sel_ctrl if scc else None,
                'current_selection': {
                    'fid': cur_file.fid.upper() if cur_file and cur_file.fid else None,
                    'name': cur_file.name if cur_file else None,
                    'desc': cur_file.desc if cur_file else None,
                    'type': cur_file.__class__.__name__ if cur_file else None,
                    'path': str(lchan.get_cwd()) if lchan else None,
                    'file_type': _get_file_type(lchan, cur_file),
                    'file_size': lchan.selected_file_size() if lchan else None,
                    'record_len': lchan.selected_file_record_len() if lchan else None,
                    'num_of_rec': lchan.selected_file_num_of_rec() if lchan else None,
                } if cur_file else None,
                'channels': [str(i) for i, ch in rs.lchan.items() if ch] if rs else [],
            }
            self._send_json(data)
            self._log_resp(data)
        elif self.path == '/api/commands':
            self._log_req()
            app = self.server.app
            if not app:
                self._send_json({'error': _err('app_not_init', lang)}, 503)
                self._log_resp({'error': _err('app_not_init', lang)})
                return
            cmds = sorted(
                attr[3:] for attr in dir(app)
                if attr.startswith('do_') and not attr.startswith('do__')
            )
            self._send_json(cmds)
            self._log_resp(cmds)
        elif self.path == '/api/cardinfo':
            self._log_req()
            app = self.server.app
            if not app:
                self._send_json({'error': _err('app_not_init', lang)}, 503)
                self._log_resp({'error': _err('app_not_init', lang)})
                return
            out = StringIO()
            old_stdout = app.stdout
            old_stderr = sys.stderr
            app.stdout = out
            sys.stderr = out
            try:
                app.onecmd_plus_hooks('cardinfo')
                output = _strip_ansi(out.getvalue())
            except Exception as e:
                output = str(e) + '\n' + traceback.format_exc()
            finally:
                app.stdout = old_stdout
                sys.stderr = old_stderr
            resp = {'output': output}
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/menu':
            menu = self.server.sim_menu or {'items': []}
            resp = {**menu, 'active': self.server.menu_active}
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/events':
            resp = self.server.event_list or []
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/pli-qualifiers':
            qualifiers = [{'code': '%02x' % q, 'name': PLI_QUALIFIER_NAMES[q]} for q in PLI_QUALIFIER_NAMES]
            self._send_json(qualifiers)
            self._log_resp(qualifiers)
        elif self.path == '/api/pli-dict':
            resp = {('%02x' % q): v for q, v in _PLI_DATA.items()}
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/poll-status':
            resp = {'enabled': _POLL_ENABLED, 'interval': _POLL_INTERVAL}
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/proactive-log':
            log = list(reversed(_PROACTIVE_LOG[-50:]))
            self._send_json(log)
            self._log_resp(log)
        elif self.path == '/api/stk-status':
            resp = {'active': self.server.menu_active,
                    'pending': self.server.stk_pending is not None,
                    'pending_type': self.server.stk_pending['type'] if self.server.stk_pending else None}
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path.startswith('/api/'):
            self._send_json({'error': _err('not_found', lang)}, 404)
            self._log_resp({'error': _err('not_found', lang)})
        else:
            self._log_req()
            self._serve_static()

    def do_POST(self):
        lang = _get_lang(self.headers)
        _reset_poll_timer()
        if self.path == '/api/command':
            app = self.server.app
            if not app:
                self._send_json({'error': _err('app_not_init', lang)}, 503)
                self._log_resp({'error': _err('app_not_init', lang)})
                return
            body = self._read_body()
            self._log_req(body)
            cmd = body.get('cmd', '')
            t0 = time.time()
            out = StringIO()
            old_stdout = app.stdout
            old_stderr = sys.stderr
            app.stdout = out
            sys.stderr = out
            try:
                stop = app.onecmd_plus_hooks(cmd)
                output = _strip_ansi(out.getvalue())
            except Exception as e:
                output = str(e) + '\n' + traceback.format_exc()
            finally:
                app.stdout = old_stdout
                sys.stderr = old_stderr
            elapsed = int((time.time() - t0) * 1000)
            status = 'OK' if not output or 'not a recognized command' not in output else 'ERROR'
            if str(cmd).strip().startswith('equip') and self.server.app and self.server.app.card and self.server.terminal_profile:
                global _CARD_CONNECTED
                self.server.stk_pending = None
                self.server.menu_active = False
                self.server.event_list = None
                _reset_proactive_log()
                self.server.card = self.server.app.card
                self.server.scc = self.server.app.card._scc
                self.server.scc.cat_cla = '80' if isinstance(self.server.card, UiccCardBase) else 'a0'
                _CARD_CONNECTED = True
                _poll_enable()
                sm, el = _send_terminal_profile(self.server.scc, self.server.terminal_profile)
                self.server.sim_menu = sm
                self.server.event_list = el
            sys.stderr.write("CMD: %s → %s (%dms)\n" % (cmd, status, elapsed))
            resp = {'output': output, 'stop': bool(stop)}
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/apdu':
            scc = self.server.scc
            if not scc:
                self._send_json({'error': _err('reader_not_init', lang)}, 503)
                self._log_resp({'error': _err('reader_not_init', lang)})
                return
            body = self._read_body()
            self._log_req(body)
            apdu_hex = body.get('apdu', '')
            t0 = time.time()
            try:
                data, sw = scc.send_apdu_checksw(apdu_hex)
                elapsed = int((time.time() - t0) * 1000)
                resp = {'response': data, 'sw': sw}
                sys.stderr.write("APDU: %s → SW: %s (%dms)\n" % (apdu_hex, sw, elapsed))
                self._send_json(resp)
                self._log_resp(resp)
            except Exception as e:
                elapsed = int((time.time() - t0) * 1000)
                err = {'error': str(e)}
                sys.stderr.write("APDU: %s → ERROR: %s (%dms)\n" % (apdu_hex, str(e), elapsed))
                self._send_json(err, 500)
                self._log_resp(err)
        elif self.path == '/api/status-poll':
            scc = self.server.scc
            if not scc:
                self._send_json({'error': _err('reader_not_init', lang)}, 503)
                self._log_resp({'error': _err('reader_not_init', lang)})
                return
            sys.stderr.write('STATUS poll (manual)\n')
            try:
                st_data, st_sw = _send_status(scc)
                sys.stderr.write('STATUS -> %s\n' % st_sw)
                resp = {'sw': st_sw}
                if st_sw.startswith('91'):
                    _handle_proactive_chain(scc, st_sw)
                    resp['proactive'] = True
                self._send_json(resp)
                self._log_resp(resp)
            except Exception as e:
                sys.stderr.write('STATUS poll error: %s\n' % e)
                _handle_card_disconnect()
                self._send_json({'sw': None, 'error': 'card disconnected'})
                self._log_resp({'sw': None, 'error': 'card disconnected'})
        elif self.path == '/api/rescue':
            scc = self.server.scc
            if not scc:
                self._send_json({'error': _err('reader_not_init', lang)}, 503)
                self._log_resp({'error': _err('reader_not_init', lang)})
                return
            if not self.server.terminal_profile:
                self._send_json({'error': 'no terminal profile configured'}, 400)
                self._log_resp({'error': 'no terminal profile configured'})
                return
            sys.stderr.write('RESCUE: re-sending TERMINAL PROFILE\n')
            self.server.stk_pending = None
            self.server.menu_active = False
            self.server.event_list = None
            _reset_proactive_log()
            sm, el = _send_terminal_profile(scc, self.server.terminal_profile)
            self.server.sim_menu = sm
            self.server.event_list = el
            resp = {'menu': sm is not None, 'events': el}
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/help':
            app = self.server.app
            if not app:
                self._send_json({'error': _err('app_not_init', lang)}, 503)
                self._log_resp({'error': _err('app_not_init', lang)})
                return
            body = self._read_body()
            self._log_req(body)
            cmd = body.get('cmd', '')
            out = StringIO()
            old_stdout = app.stdout
            old_stderr = sys.stderr
            app.stdout = out
            sys.stderr = out
            try:
                app.onecmd_plus_hooks('help ' + cmd)
                raw = out.getvalue()
            finally:
                app.stdout = old_stdout
                sys.stderr = old_stderr
            clean = _strip_ansi(raw)
            parsed = _parse_help_text(clean)
            self._send_json(parsed)
            self._log_resp(parsed)
        elif self.path == '/api/select':
            app = self.server.app
            if not app:
                self._send_json({'error': _err('app_not_init', lang)}, 503)
                self._log_resp({'error': _err('app_not_init', lang)})
                return
            body = self._read_body()
            self._log_req(body)
            fid = body.get('fid')
            name = fid if fid else body.get('name', '')
            parent_sel = body.get('parent_sel')
            rs = app.rs
            if not rs:
                self._send_json({'error': _err('no_card_state', lang)}, 503)
                self._log_resp({'error': _err('no_card_state', lang)})
                return
            lchan = rs.lchan[0]
            try:
                _select_with_parent(lchan, name, parent_sel, app)
                cur = lchan.selected_file
                data = {
                    'name': cur.name if cur else None,
                    'fid': cur.fid.upper() if cur and cur.fid else None,
                    'file_type': _get_file_type(lchan, cur),
                    'exists': True,
                }
                self._send_json(data)
                self._log_resp(data)
            except Exception as e:
                err = {'error': str(e), 'exists': False}
                self._send_json(err, 404)
                self._log_resp(err)
        elif self.path == '/api/read':
            app = self.server.app
            if not app:
                self._send_json({'error': _err('app_not_init', lang)}, 503)
                self._log_resp({'error': _err('app_not_init', lang)})
                return
            body = self._read_body()
            self._log_req(body)
            fid = body.get('fid')
            name = fid if fid else body.get('name', '')
            fid = body.get('fid')
            parent_sel = body.get('parent_sel')
            mode = body.get('mode', 'raw')
            rs = app.rs
            if not rs:
                self._send_json({'error': _err('no_card_state', lang)}, 503)
                self._log_resp({'error': _err('no_card_state', lang)})
                return
            lchan = rs.lchan[0]
            try:
                sel = fid if fid else name
                _select_with_parent(lchan, sel, parent_sel, app)
                ft = _get_file_type(lchan, lchan.selected_file)
                is_record = ft in ('linear_fixed', 'cyclic')
                if mode == 'decoded':
                    cmd = 'read_records_decoded' if is_record else 'read_binary_decoded'
                else:
                    cmd = 'read_records' if is_record else 'read_binary'
                out = StringIO()
                old_stdout = app.stdout
                old_stderr = sys.stderr
                app.stdout = out
                sys.stderr = out
                try:
                    app.onecmd_plus_hooks(cmd)
                    output = _strip_ansi(out.getvalue())
                finally:
                    app.stdout = old_stdout
                    sys.stderr = old_stderr
                sw_match = re.search(r'SW:\s*(\w+)', output)
                err_match = re.search(r'got (\w+)', output)
                if err_match:
                    sw = err_match.group(1)
                    descs = {'6982': 'Security status not satisfied', '6983': 'PIN blocked',
                             '6985': 'Conditions of use not satisfied', '6A88': 'Referenced data not found',
                             '6A82': 'File not found'}
                    resp = {'success': False, 'sw': sw, 'error': descs.get(sw, 'Error')}
                    self._send_json(resp)
                    self._log_resp(resp)
                    return
                sw = sw_match.group(1) if sw_match else '9000'
                clean = re.sub(r'^SW:\s*\w+\s*', '', output, flags=re.MULTILINE).strip()
                if mode == 'decoded':
                    try:
                        parsed = json.loads(clean)
                        resp = {'success': True, 'sw': sw, 'file_type': ft, 'decoded': parsed}
                    except json.JSONDecodeError:
                        resp = {'success': True, 'sw': sw, 'file_type': ft, 'data': clean}
                elif is_record:
                    records = []
                    for line in clean.split('\n'):
                        m = re.match(r'^(\d+)\s(.+)', line)
                        if m:
                            records.append({'num': int(m.group(1)), 'data': m.group(2)})
                    resp = {'success': True, 'sw': sw, 'file_type': ft, 'records': records}
                else:
                    resp = {'success': True, 'sw': sw, 'file_type': ft, 'data': clean}
                self._send_json(resp)
                self._log_resp(resp)
            except Exception as e:
                err = {'success': False, 'error': str(e)}
                self._send_json(err, 500)
                self._log_resp(err)
        elif self.path == '/api/write':
            app = self.server.app
            if not app:
                self._send_json({'error': _err('app_not_init', lang)}, 503)
                self._log_resp({'error': _err('app_not_init', lang)})
                return
            body = self._read_body()
            self._log_req(body)
            name = body.get('name', '')
            data = body.get('data', '')
            fid = body.get('fid')
            record_nr = body.get('record_nr')
            parent_sel = body.get('parent_sel')
            rs = app.rs
            if not rs:
                self._send_json({'error': _err('no_card_state', lang)}, 503)
                self._log_resp({'error': _err('no_card_state', lang)})
                return
            lchan = rs.lchan[0]
            try:
                sel = fid if fid else name
                _select_with_parent(lchan, sel, parent_sel, app)
                ft = _get_file_type(lchan, lchan.selected_file)
                is_record = ft in ('linear_fixed', 'cyclic')
                if record_nr:
                    cmd = 'update_record %d %s' % (record_nr, data)
                elif is_record:
                    cmd = 'update_record 1 %s' % data
                else:
                    cmd = 'update_binary %s' % data
                out = StringIO()
                old_stdout = app.stdout
                old_stderr = sys.stderr
                app.stdout = out
                sys.stderr = out
                try:
                    app.onecmd_plus_hooks(cmd)
                    output = out.getvalue()
                finally:
                    app.stdout = old_stdout
                    sys.stderr = old_stderr
                sw_match = re.search(r'SW:\s*(\w+)', output)
                err_match = re.search(r'got (\w+)', output)
                if err_match:
                    sw = err_match.group(1)
                    descs = {'6982': 'Security status not satisfied', '6983': 'PIN blocked',
                             '6985': 'Conditions of use not satisfied', '6A88': 'Referenced data not found',
                             '6A82': 'File not found'}
                    resp = {'success': False, 'sw': sw, 'error': descs.get(sw, 'Error')}
                else:
                    sw = sw_match.group(1) if sw_match else '9000'
                    resp = {'success': True, 'sw': sw}
                self._send_json(resp)
                self._log_resp(resp)
            except Exception as e:
                err = {'success': False, 'error': str(e)}
                self._send_json(err, 500)
                self._log_resp(err)
        elif self.path == '/api/tree':
            app = self.server.app
            if not app:
                self._send_json({'error': _err('app_not_init', lang)}, 503)
                self._log_resp({'error': _err('app_not_init', lang)})
                return
            body = self._read_body()
            self._log_req(body)
            fid = body.get('fid')
            name = fid if fid else body.get('name', '')
            fid = body.get('fid')
            parent_sel = body.get('parent_sel')
            rs = app.rs
            if not rs:
                self._send_json({'error': _err('no_card_state', lang)}, 503)
                self._log_resp({'error': _err('no_card_state', lang)})
                return
            lchan = rs.lchan[0]
            try:
                sel = fid if fid else name
                _select_with_parent(lchan, sel, parent_sel, app)
                cur = lchan.selected_file
                out = StringIO()
                old_stdout = app.stdout
                old_stderr = sys.stderr
                app.stdout = out
                sys.stderr = out
                try:
                    app.onecmd_plus_hooks('tree')
                    output = _strip_ansi(out.getvalue())
                finally:
                    app.stdout = old_stdout
                    sys.stderr = old_stderr
                children = _parse_tree_output(output)
                sels = lchan.selected_file.get_selectables() if lchan and lchan.selected_file else {}
                for child in children:
                    if child['isDir'] and child['name'] in sels:
                        f = sels[child['name']]
                        if hasattr(f, 'aid') and f.aid:
                            child['aid'] = f.aid.upper()
                resp = {
                    'exists': True,
                    'name': cur.name if cur else None,
                    'fid': cur.fid.upper() if cur and cur.fid else None,
                    'file_type': _get_file_type(lchan, cur),
                    'children': children,
                }
                self._send_json(resp)
                self._log_resp(resp)
            except Exception as e:
                sys.stderr.write('Handler error: %s\n' % e)
                if 'Card' in str(e) or 'Transaction' in str(e) or 'Transmit' in str(e):
                    _handle_card_disconnect()
                err = {'success': False, 'error': str(e)}
                self._send_json(err, 500)
                self._log_resp(err)
        elif self.path == '/api/menu-select':
            scc = self.server.scc
            if not scc:
                self._send_json({'error': 'card reader not available'}, 503)
                return
            body = self._read_body()
            self._log_req(body)
            item_id = body.get('item_id', 0)
            if not isinstance(item_id, int):
                item_id = int(item_id)
            self.server.menu_active = True
            # Build ENVELOPE(Menu Selection): D3 [len] DeviceIdentities + ItemIdentifier
            menu_tlv = bytes([0xD3, 0x07, 0x02, 0x02, 0x01, 0x81, 0x90, 0x01, item_id])
            env_hex = '%sc20000%02x%s' % (scc.cat_cla, len(menu_tlv), menu_tlv.hex())
            data, sw = scc._tp.send_apdu(env_hex)
            resp = {'type': 'done', 'sw': sw}
            if sw.startswith('91'):
                def _on_menu_fetch(raw, cmd_num, cmd_type, dev_src, dev_dst):
                    if cmd_type == 0x21:
                        text = _parse_display_text(raw) if raw else None
                        if text:
                            self.server.stk_pending = {'type': 'display_text',
                                'cmd_num': cmd_num, 'cmd_type': cmd_type,
                                'dev_src': dev_src, 'dev_dst': dev_dst, 'text': text}
                            resp.update(type='display_text', text=text)
                            return 'pause'
                    elif cmd_type == 0x24:
                        items = _parse_select_item(raw) if raw else []
                        self.server.stk_pending = {'type': 'select_item',
                            'cmd_num': cmd_num, 'cmd_type': cmd_type,
                            'dev_src': dev_src, 'dev_dst': dev_dst, 'items': items}
                        resp.update(type='select_item', items=items)
                        return 'pause'
                    elif cmd_type == 0x25:
                        items = _parse_setup_menu_items(raw) if raw else []
                        self.server.stk_pending = {'type': 'select_item',
                            'cmd_num': cmd_num, 'cmd_type': cmd_type,
                            'dev_src': dev_src, 'dev_dst': dev_dst, 'items': items}
                        resp.update(type='select_item', items=items)
                        return 'pause'
                _handle_proactive_chain(scc, sw, _on_menu_fetch)
            else:
                self.server.menu_active = False
                self.server.stk_pending = None
                if sw == '9000':
                    sys.stderr.write('STATUS poll (menu-select 9000)\n')
                    st_data, st_sw = _send_status(scc)
                    sys.stderr.write('STATUS -> %s\n' % st_sw)
                    if st_sw.startswith('91'):
                        _handle_proactive_chain(scc, st_sw, _on_menu_fetch)
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/menu-respond':
            scc = self.server.scc
            if not self.server.stk_pending:
                self._send_json({'error': 'no pending command'}, 400)
                return
            body = self._read_body()
            self._log_req(body)
            result = body.get('result', 'ok')
            item_id = body.get('item_id')
            RESULT_MAP = {'ok': 0x00, 'cancel': 0x10, 'back': 0x11, 'timeout': 0x12}
            gr = RESULT_MAP.get(result, 0x00)
            pd = self.server.stk_pending
            # Build TERMINAL RESPONSE
            cd = bytes([0x81, 0x03, pd['cmd_num'], pd['cmd_type'], 0x00])
            di = bytes([0x82, 0x02, pd['dev_dst'], pd['dev_src']])
            tr_data = cd + di
            if isinstance(item_id, int) and result == 'ok' and pd['type'] == 'select_item':
                tr_data += bytes([0x90, 0x01, item_id])
            tr_data += bytes([0x83, 0x02, gr, 0x00])
            tr_hex = '%s140000%02x%s' % (scc.cat_cla, len(tr_data), tr_data.hex())
            tr_rv = scc._tp.send_apdu(tr_hex)
            sys.stderr.write('TR(menu): cmd=%02x type=%02x result=%02x -> %s\n' % (pd['cmd_num'], pd['cmd_type'], gr, tr_rv[1]))
            sw = tr_rv[1]
            resp = {'sw': sw}
            if result == 'cancel':
                self.server.stk_pending = None
                self.server.menu_active = False
            else:
                self.server.stk_pending = None
                if sw.startswith('91'):
                    def _on_menu_fetch(raw, cmd_num, cmd_type, dev_src, dev_dst):
                        if cmd_type == 0x21:
                            text = _parse_display_text(raw) if raw else None
                            if text:
                                self.server.stk_pending = {'type': 'display_text',
                                    'cmd_num': cmd_num, 'cmd_type': cmd_type,
                                    'dev_src': dev_src, 'dev_dst': dev_dst, 'text': text}
                                resp.update(type='display_text', text=text)
                                return 'pause'
                        elif cmd_type == 0x24:
                            items = _parse_select_item(raw) if raw else []
                            self.server.stk_pending = {'type': 'select_item',
                                'cmd_num': cmd_num, 'cmd_type': cmd_type,
                                'dev_src': dev_src, 'dev_dst': dev_dst, 'items': items}
                            resp.update(type='select_item', items=items)
                            return 'pause'
                        elif cmd_type == 0x25:
                            items = _parse_setup_menu_items(raw) if raw else []
                            self.server.stk_pending = {'type': 'select_item',
                                'cmd_num': cmd_num, 'cmd_type': cmd_type,
                                'dev_src': dev_src, 'dev_dst': dev_dst, 'items': items}
                            resp.update(type='select_item', items=items)
                            return 'pause'
                    _handle_proactive_chain(scc, sw, _on_menu_fetch)
                else:
                    self.server.menu_active = False
                    resp['type'] = 'done'
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/event-send':
            scc = self.server.scc
            if not scc:
                self._send_json({'error': _err('reader_not_init', lang)}, 503)
                self._log_resp({'error': _err('reader_not_init', lang)})
                return
            body = self._read_body()
            self._log_req(body)
            event_type = body.get('event_type')
            event_data_hex = body.get('event_data')
            if event_type is None:
                self._send_json({'error': 'event_type is required'}, 400)
                return
            event_data = bytes.fromhex(event_data_hex) if event_data_hex else None
            try:
                data, sw = _send_event_download(scc, event_type, event_data)
                resp = {'sw': sw}
                if data:
                    resp['data'] = data
                self._send_json(resp)
                self._log_resp(resp)
            except Exception as e:
                sys.stderr.write('Event send error: %s\n' % e)
                _handle_card_disconnect()
                self._send_json({'sw': None, 'error': 'card disconnected'})
                self._log_resp({'sw': None, 'error': 'card disconnected'})
        elif self.path == '/api/pli-dict':
            body = self._read_body()
            self._log_req(body)
            if isinstance(body, dict):
                for k, v in body.items():
                    if isinstance(v, str):
                        try:
                            code = int(k, 16)
                            if code in _PLI_DATA:
                                bytes.fromhex('') if not v else bytes.fromhex(v)
                                _PLI_DATA[code] = v
                        except (ValueError, KeyError):
                            pass
            resp = {('%02x' % q): v for q, v in _PLI_DATA.items()}
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/poll-toggle':
            body = self._read_body()
            self._log_req(body)
            if isinstance(body, dict) and body.get('enabled'):
                _poll_enable()
            else:
                _poll_disable()
            resp = {'enabled': _POLL_ENABLED, 'interval': _POLL_INTERVAL}
            self._send_json(resp)
            self._log_resp(resp)
        elif self.path == '/api/send-ota':
            app = self.server.app
            if not app:
                self._send_json({'error': _err('app_not_init', lang)}, 503)
                self._log_resp({'error': _err('app_not_init', lang)})
                return
            body = self._read_body()
            self._log_req(body)
            sp = body.get('sp', '')
            scc = self.server.scc
            if not scc:
                self._send_json({'error': _err('reader_not_init', lang)}, 503)
                self._log_resp({'error': _err('reader_not_init', lang)})
                return
            include_cpi = body.get('includeCpi', True)
            try:
                sp_bytes = bytes.fromhex(sp)
                spi2_val = int(body.get('spi2', '00'), 16)
                por_in_submit = bool(spi2_val & 0x20)
                submit_handler = None
                old_proactive = None
                if por_in_submit and hasattr(scc, '_tp'):
                    submit_handler = PoRSubmitHandler()
                    old_proactive = scc._tp.proactive_handler
                    scc._tp.proactive_handler = submit_handler
                try:
                    max_chunk = 130
                    chunks = [sp_bytes[i:i+max_chunk] for i in range(0, len(sp_bytes), max_chunk)]
                    total = len(chunks)
                    last_data = None
                    last_sw = None
                    for i, chunk in enumerate(chunks):
                        tpdu = _build_sms_tpdu(chunk.hex(), total, i + 1, oa_number=self.server.sms_oa,
                                               include_cpi=include_cpi) if total > 1 else _build_sms_tpdu(sp, oa_number=self.server.sms_oa,
                                                                                                            include_cpi=include_cpi)
                        data, sw = _send_envelope(tpdu, scc, sm_sc=self.server.sms_sc, submit_handler=submit_handler)
                        last_data = data
                        last_sw = sw
                        if sw != '9000' and not sw.startswith('91'):
                            resp = {'success': False, 'sw': sw, 'error': 'ENVELOPE failed at chunk %d' % (i + 1)}
                            break
                    else:
                        resp = {'success': True, 'sw': last_sw, 'response_data': last_data if last_data else None}
                        por_hex = resp['response_data']
                        if submit_handler and submit_handler.submit_tpdu_hex:
                            tpdu_b = bytes.fromhex(submit_handler.submit_tpdu_hex)
                            idx = tpdu_b.find(b'\x02\x71\x00')
                            if idx >= 0:
                                por_hex = tpdu_b[idx:].hex()
                        por = _decode_por(body.get('spi1', ''), body.get('spi2', ''), body.get('kic', ''),
                                          body.get('kid', ''), body.get('cntr', ''), body.get('kicKey', ''),
                                          body.get('kidKey', ''), por_hex)
                        if por:
                            resp['por'] = por
                finally:
                    if submit_handler and hasattr(scc, '_tp'):
                        scc._tp.proactive_handler = old_proactive
                self._send_json(resp)
                self._log_resp(resp)
            except Exception as e:
                sys.stderr.write('OTA send error: %s\n' % e)
                if 'Card' in str(e) or 'Transaction' in str(e) or 'Transmit' in str(e):
                    _handle_card_disconnect()
                err = {'success': False, 'error': str(e)}
                self._send_json(err, 500)
                self._log_resp(err)
        elif self.path == '/api/sp-verify':
            body = self._read_body()
            self._log_req(body)
            try:
                ref, spi = _ota_reference(body.get('spi1', ''), body.get('spi2', ''), body.get('kic', ''),
                                          body.get('kid', ''), body.get('tar', ''), body.get('cntr', ''),
                                          body.get('apdu', ''), body.get('kicKey', ''), body.get('kidKey', ''))
                js_sp = (body.get('sp', '') or '').replace(' ', '').lower()
                ref_l = ref.lower()
                diffs = []
                if js_sp != ref_l:
                    n = min(len(js_sp), len(ref_l))
                    for i in range(0, n, 2):
                        if js_sp[i:i+2] != ref_l[i:i+2]:
                            diffs.append({'offset': i // 2, 'js': js_sp[i:i+2], 'ref': ref_l[i:i+2]})
                    if len(js_sp) != len(ref_l):
                        diffs.append({'offset': n // 2, 'js': js_sp[n:], 'ref': ref_l[n:]})
                resp = {'js_sp': js_sp, 'py_sp': ref_l, 'match': js_sp == ref_l, 'diffs': diffs[:50], 'spi': spi}
                self._send_json(resp)
                self._log_resp(resp)
            except Exception as e:
                err = {'success': False, 'error': str(e)}
                self._send_json(err, 500)
                self._log_resp(err)
        else:
            self._send_json({'error': _err('not_found', lang)}, 404)
            self._log_resp({'error': _err('not_found', lang)})

    def log_message(self, format, *args):
        sys.stderr.write('%s - - [%s] %s\n' % (self.client_address[0], self.log_date_time_string(), format % args))