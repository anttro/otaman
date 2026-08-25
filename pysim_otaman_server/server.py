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
from osmocom.tlv import BER_TLV_IE


VERSION = '1.9.11'


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


class _LoggingApduTracer(StderrApduTracer):
    """StderrApduTracer that additionally records the SW of TERMINAL RESPONSE
    APDUs sent by pySim's auto-handler (which happen outside our own chain code)
    onto the most recent log entry that is still missing its tr_sw."""

    def trace_response(self, cmd, sw, resp):
        super().trace_response(cmd, sw, resp)
        if len(cmd) >= 4 and cmd[2:4] == '14':
            for entry in reversed(_PROACTIVE_LOG):
                if 'tr_hex' in entry and 'tr_sw' not in entry:
                    entry['tr_sw'] = sw
                    break


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
    from pySim.ota import OtaDialectSms, CompactRemoteResp
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
        'cntr': res['cntr'].hex().upper(),
        'pcntr': res['pcntr'],
        'rpl': res['rpl'],
        'rhl': res['rhl'],
        'cc_rc': res['cc_rc'].hex(),
        'raw': response_hex,
    }
    
    # Try ExpandedRemoteResponse first (TS 102 226 §5.2.2)
    if res.response_status == 'por_ok' and len(res['secured_data']):
        try:
            from construct import Struct, Int8ub, Bytes, GreedyBytes, Optional, Array, this
            ExpandedRemoteResponse = Struct(
                'response_count'/Int8ub,
                'responses'/Array(this.response_count, Struct(
                    'command_number'/Int8ub,
                    'status_word'/Bytes(2),
                    'response_data'/GreedyBytes,
                    'error_details'/Optional(Struct(
                        'error_code'/Int8ub,
                        'error_info'/GreedyBytes
                    )),
                    'chaining_context'/Optional(Struct(
                        'script_id'/Bytes(4),
                        'is_first'/Int8ub,
                        'is_last'/Int8ub,
                    ))
                ))
            )
            expanded = ExpandedRemoteResponse.parse(res['secured_data'])
            out['response_type'] = 'expanded'
            out['response_count'] = expanded.response_count
            out['responses'] = []
            for resp in expanded.responses:
                response_data = {
                    'command_number': resp.command_number,
                    'status_word': resp.status_word.hex().upper(),
                    'response_data': b2h(resp.response_data).upper() if resp.response_data else '',
                }
                if resp.error_details:
                    response_data['error_code'] = resp.error_details.error_code
                    response_data['error_info'] = b2h(resp.error_details.error_info).upper()
                if resp.chaining_context:
                    response_data['script_id'] = resp.chaining_context.script_id.hex().upper()
                    response_data['is_first'] = resp.chaining_context.is_first == 0x01
                    response_data['is_last'] = resp.chaining_context.is_last == 0x01
                out['responses'].append(response_data)
        except Exception:
            # Fallback to CompactRemoteResp
            if dec is not None:
                out['response_type'] = 'compact'
                out['decoded'] = {
                    'number_of_commands': dec.number_of_commands,
                    'last_status_word': str(dec.last_status_word),
                    'last_response_data': str(dec.last_response_data),
                }
            else:
                out['response_type'] = 'none'
    elif dec is not None:
        out['response_type'] = 'compact'
        out['decoded'] = {
            'number_of_commands': dec.number_of_commands,
            'last_status_word': str(dec.last_status_word),
            'last_response_data': str(dec.last_response_data),
        }
    else:
        out['response_type'] = 'none'
    
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
    """Catch-all for any proactive command not explicitly handled. Logs the
    fetch and its TERMINAL RESPONSE into _PROACTIVE_LOG and answers
    PROVIDE LOCAL INFORMATION (0x26) with data from the PLI dictionary,
    so the card does not re-request."""

    def receive_fetch_raw(self, pcmd, parsed):
        cmd_num, cmd_type, dev_src, dev_dst, cmd_qual = 1, 0, 0x83, 0x81, None
        entry = None
        try:
            raw = bytes.fromhex(parsed) if parsed else None
            if raw:
                cmd_num, cmd_type, dev_src, dev_dst, cmd_qual = _parse_proactive_header(raw)
            entry = _log_proactive(cmd_type, raw, cmd_qual, cmd_num)
        except Exception:
            pass
        ti_list = self.prepare_response(pcmd, 'performed_successfully')
        if cmd_type == 0x26 and cmd_qual is not None:
            pli_hex = _PLI_DATA.get(cmd_qual, '')
            if pli_hex:
                try:
                    ti_list.insert(2, _RawBerTlv(pli_hex))
                except Exception:
                    pass
        if entry:
            _record_tr(entry, b''.join(x.to_tlv() for x in ti_list))
        return ti_list


class _RawBerTlv(BER_TLV_IE):
    """Emits pre-encoded TLV bytes verbatim (used to inject PLI data TLVs
    into the TERMINAL RESPONSE built by pySim's auto-handler)."""

    def __init__(self, data_hex):
        super().__init__()
        self._raw = bytes.fromhex(data_hex)

    def to_bytes(self, context={}):
        return self._raw


_STK_DECODE = GsmOrUcs2Adapter(GreedyBytes)

_PROACTIVE_LOG = []
_PROACTIVE_SESSION_START = None
_PROACTIVE_ENTRY_ID = 0

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


EVENT_NAMES = {
    0x00: 'MT call', 0x01: 'Call connected', 0x02: 'Call disconnected',
    0x03: 'Location status', 0x04: 'User activity', 0x05: 'Idle screen available',
    0x06: 'Card reader status', 0x07: 'Language selection',
    0x08: 'Browser termination', 0x09: 'Data available',
    0x0A: 'Channel status', 0x0B: 'Access Technology Change',
    0x0C: 'Display parameters changed', 0x0D: 'Local connection',
    0x0E: 'Network Search Mode Change', 0x0F: 'Browsing status',
    0x10: 'Frames Information Change', 0x11: 'I-WLAN Access Status',
    0x12: 'Network Rejection', 0x13: 'HCI Connectivity',
    0x14: 'Change of UICC Access', 0x15: 'CSG Cell Change',
    0x16: 'Contactless state request', 0x17: 'Profile Container',
    0x18: 'LTE D2D Discovery Monitoring', 0x19: 'LTE D2D Communication Monitoring',
    0x1A: 'LTE D2D Announcement Response', 0x1B: 'LTE D2D Revocation',
    0x1C: 'LTE D2D Application Port', 0x1D: 'LTE D2D Security Recovery',
    0x1E: 'Off-net Emergency Call', 0x1F: 'ECall Over IMS',
    0x20: 'EARFCN Update', 0x21: 'SCEF Channel Status',
}

ACCESSTECH_NAMES = {
    0: 'GSM', 1: 'GSM Compact', 2: 'TIA/EIA-533', 3: 'UTRAN',
    4: 'TETRA', 5: 'TIA/EIA-95-B', 6: 'CDMA2000 1x', 7: 'CDMA2000 HRPD',
    8: 'E-UTRAN', 9: 'eHRPD', 10: 'NG-RAN', 11: 'Satellite NG-RAN',
    12: 'Satellite E-UTRAN',
}

PLI_QUALIFIER_SHORT = {
    0x00: 'Loc', 0x01: 'IMEI', 0x02: 'NMR', 0x03: 'Time', 0x04: 'Lang',
    0x05: 'TA', 0x06: 'AccTech', 0x08: 'IMEISV', 0x09: 'Search', 0x0A: 'Batt',
    0x0C: 'WSID', 0x0D: 'BCInfo', 0x0E: 'MultiAT', 0x0F: 'MultiLoc',
    0x10: 'MultiNMR', 0x11: 'CSG', 0x12: 'HNB-IP', 0x13: 'HNB-Macro',
    0x14: 'WLAN', 0x15: 'Slices', 0x16: 'CAG', 0x17: 'RejSlice',
}


def _dec_plmn(hex6):
    """Decode 3-byte MCC/MNC nibble-swapped PLMN, e.g. '25001' from 'F50010'."""
    h = re.sub(r'\s', '', hex6)[:6]
    if len(h) < 6:
        return '250', '01'
    b1, b2, b3 = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    mcc = '%d%d%d' % (b1 & 0xF, (b1 >> 4) & 0xF, b2 & 0xF)
    mnc = '%d' % (b3 & 0xF)
    if (b2 >> 4) != 0xF:
        mnc += '%d' % ((b2 >> 4) & 0xF)
    return mcc, mnc


def _dec_imei(hex8):
    """Decode 8-byte IMEI (nibble-swapped, 15 digits)."""
    h = re.sub(r'\s', '', hex8)[:16]
    if len(h) < 16:
        return ''
    s = ''
    for i in range(0, 15, 2):
        b = int(h[i:i + 2], 16)
        s += '%d%d' % (b & 0xF, (b >> 4) & 0xF)
    return s[:15]


def _decode_cmd(cmd_type, raw, qualifier):
    """Decode a fetched proactive command into [{label, value}] pairs."""
    if not raw:
        return []
    if cmd_type == 0x03:
        idx = raw.find(b'\x84\x02\x01')
        if idx >= 0 and idx + 3 < len(raw):
            return [{'label': 'Interval', 'value': '%d s' % raw[idx + 3]}]
        return []
    if cmd_type == 0x05:
        for tag in (0x99, 0x19):
            idx = raw.find(bytes([tag]))
            if idx >= 0 and idx + 1 < len(raw):
                tlen = raw[idx + 1]
                names = [EVENT_NAMES.get(b, 'Event 0x%02X' % b) for b in raw[idx + 2: idx + 2 + tlen]]
                return [{'label': 'Events', 'value': ', '.join(names)}]
        return []
    if cmd_type == 0x13:
        idx = raw.find(b'\x8b')
        if idx >= 0 and idx + 1 < len(raw):
            tlen = raw[idx + 1]
            return [{'label': 'SMS TPDU', 'value': raw[idx + 2: idx + 2 + tlen].hex()}]
        return []
    if cmd_type == 0x21:
        text = _parse_display_text(raw)
        return [{'label': 'Text', 'value': text}] if text else []
    if cmd_type == 0x24:
        items = _parse_select_item(raw)
        if items:
            return [{'label': 'Items', 'value': ', '.join('%s. %s' % (it['id'], it['text']) for it in items)}]
        return []
    if cmd_type == 0x25:
        items = _parse_setup_menu_items(raw)
        if items:
            return [{'label': 'Items', 'value': ', '.join('%s. %s' % (it['id'], it['text']) for it in items)}]
        return []
    if cmd_type == 0x26 and qualifier is not None:
        name = PLI_QUALIFIER_NAMES.get(qualifier, 'Unknown')
        return [{'label': 'Qualifier', 'value': '%s (0x%02X)' % (name, qualifier)}]
    return [{'label': 'Data', 'value': raw.hex()}]


def _decode_tr(type_hex, qual_hex, tr_hex):
    """Decode the command-specific payload of a TERMINAL RESPONSE into
    [{label, value}] pairs (empty list when the TR carried no data)."""
    if not tr_hex:
        return []
    h = re.sub(r'\s', '', tr_hex)
    try:
        cmd_type = int(type_hex, 16) if type_hex else None
    except ValueError:
        return [{'label': 'Data', 'value': h}]
    if cmd_type == 0x03 and len(h) >= 8 and h[0:2] == '84':
        return [{'label': 'Interval', 'value': '%d s' % int(h[6:8], 16)}]
    if cmd_type == 0x26 and qual_hex:
        try:
            qual = int(qual_hex, 16)
        except ValueError:
            qual = None
        if qual in (0x00, 0x01, 0x03, 0x04, 0x05, 0x06, 0x08, 0x09, 0x0A, 0x0E):
            v = h[4:] if len(h) >= 4 else ''
            if qual == 0x00 and len(v) >= 10:
                mcc, mnc = _dec_plmn(v[:6])
                return [{'label': 'MCC', 'value': mcc}, {'label': 'MNC', 'value': mnc},
                        {'label': 'LAC/TAC', 'value': v[6:10].upper()}]
            if qual == 0x01 and len(v) >= 16:
                return [{'label': 'IMEI', 'value': _dec_imei(v[:16])}]
            if qual == 0x03 and len(v) >= 14:
                yr = 2000 + int(v[0:2]) if int(v[0:2]) < 70 else 1900 + int(v[0:2])
                mo, dy = int(v[2:4]), int(v[4:6])
                hh, mm, ss = int(v[6:8]), int(v[8:10]), int(v[10:12])
                tz = int(v[12:14], 16)
                tz_sign = '-' if tz & 0x80 else '+'
                tz_q = (tz & 0x3F) or 0
                return [{'label': 'Date', 'value': '%04d-%02d-%02d' % (yr, mo, dy)},
                        {'label': 'Time', 'value': '%02d:%02d:%02d' % (hh, mm, ss)},
                        {'label': 'TZ offset', 'value': '%s%02d:%02d' % (tz_sign, tz_q // 4, (tz_q % 4) * 15)}]
            if qual == 0x04 and len(v) >= 4:
                try:
                    lang = bytes.fromhex(v[:4]).decode('ascii')
                except Exception:
                    lang = v[:4]
                return [{'label': 'Language', 'value': lang}]
            if qual == 0x05 and len(v) >= 4:
                return [{'label': 'ME Status', 'value': str(int(v[0:2], 16))},
                        {'label': 'Timing Advance', 'value': str(int(v[2:4], 16))}]
            if qual == 0x06 and len(v) >= 2:
                tech = int(v[0:2], 16)
                return [{'label': 'Access Technology',
                         'value': '%s (%d)' % (ACCESSTECH_NAMES.get(tech, 'Unknown'), tech)}]
            if qual == 0x08 and len(v) >= 16:
                return [{'label': 'IMEISV', 'value': _dec_imei(v[:16]) + v[14:16].upper()}]
            if qual == 0x09 and len(v) >= 2:
                mode = int(v[0:2], 16)
                return [{'label': 'Search Mode', 'value': 'Manual' if mode == 1 else ('Automatic' if mode == 0 else str(mode))}]
            if qual == 0x0A and len(v) >= 2:
                return [{'label': 'Charge state (%)', 'value': str(int(v[0:2], 16))}]
            if qual == 0x0E:
                techs = [int(v[i:i + 2], 16) for i in range(0, len(v), 2)]
                return [{'label': 'Access Technologies',
                         'value': ', '.join(ACCESSTECH_NAMES.get(t, 'Unknown') for t in techs)}]
            return [{'label': 'Data', 'value': h}]
    return [{'label': 'Data', 'value': h}]


def _build_tr(scc, cmd_num, cmd_type, dev_src, dev_dst, cmd_qual):
    """Build the TERMINAL RESPONSE TLV payload for a fetched command
    (includes PLI dictionary data for PROVIDE LOCAL INFORMATION)."""
    if cmd_type == 0x03:
        return bytes([0x81, 0x03, cmd_num, cmd_type, 0x00,
                      0x82, 0x02, dev_dst, dev_src,
                      0x84, 0x02, 0x01, _POLL_INTERVAL,
                      0x03, 0x01, 0x00])
    base = bytes([0x81, 0x03, cmd_num, cmd_type, 0x00,
                  0x82, 0x02, dev_dst, dev_src])
    if cmd_type == 0x26 and cmd_qual is not None:
        pli_hex = _PLI_DATA.get(cmd_qual, '')
        if pli_hex:
            base += bytes.fromhex(pli_hex)
    return base + bytes([0x03, 0x01, 0x00])


_RESULT_NAMES_BASIC = {
    0x00: 'Command performed successfully',
    0x01: 'Command performed with partial comprehension',
    0x02: 'Command performed, with missing information',
    0x03: 'REFUSED BY THE ME',
    0x04: 'Command not understood by the ME',
    0x05: 'Command not permitted by the user',
    0x06: 'Command performed with modification',
    0x20: 'Proactive SIM session terminated by the user',
    0x21: 'Backward move in the proactive SIM session requested by the user',
    0x22: 'No response from user',
    0x23: 'Help information required by the user',
    0x24: 'USSD or SS transaction terminated by the user',
    0x25: 'Proactive SIM session terminated by the user',
    0x26: 'Backward move in the proactive SIM session requested by the user',
}

_RESULT_NAMES_GENERAL = {
    0x10: 'Command performed with additional information',
    0x20: 'ME currently unable to process command',
    0x21: 'Network currently unable to process command',
    0x22: 'User did not accept the proactive command',
    0x23: 'User cleared down call before connection or network release',
    0x24: 'Action in contradiction with the current enforcement state',
    0x25: 'Action in contradiction with the current timer state',
    0x26: 'ME currently unable to process command',
    0x27: 'User did not accept the proactive command',
    0x28: 'User cleared down call before connection or network release',
    0x29: 'Action in contradiction with the current enforcement state',
    0x2A: 'Action in contradiction with the current timer state',
    0x30: 'Command performed but partial understanding',
    0x31: 'Command performed, with missing information',
    0x32: 'REFUSED BY THE ME',
    0x33: 'Command not understood by the ME',
    0x34: 'Command not permitted by the user',
    0x35: 'Command performed with modification',
}

def _tr_result_name(b, is_general):
    table = _RESULT_NAMES_GENERAL if is_general else _RESULT_NAMES_BASIC
    if b in table:
        return table[b]
    if 0x40 <= b <= 0x4F or 0x70 <= b <= 0x7F:
        return 'Command performed with modification'
    if 0x60 <= b <= 0x6F:
        return 'Command performed with limited understanding'
    return None


def _extract_tr_result(tr_tlv):
    """Return (tag, value) of the Result CTLV (tag 0x03 basic or 0x83 general)
    from a TERMINAL RESPONSE payload, or None if absent."""
    if not tr_tlv:
        return None
    off = 0
    while off < len(tr_tlv) - 1:
        tag, tlen = tr_tlv[off], tr_tlv[off + 1]
        if tag in (0x03, 0x83) and off + 2 + tlen <= len(tr_tlv):
            return (tag, tr_tlv[off + 2: off + 2 + tlen])
        off += 2 + tlen
    return None


def _record_tr(entry, tr_tlv, tr_sw=None):
    """Attach a sent TERMINAL RESPONSE to a log entry: payload hex, SW and
    server-side decode. tr_sw may be omitted (pySim auto-handler) and filled
    later by _LoggingApduTracer."""
    if entry is None:
        return
    entry['tr_hex'] = _tr_data_only(tr_tlv).hex()
    if tr_sw is not None:
        entry['tr_sw'] = tr_sw
    try:
        result = _extract_tr_result(tr_tlv)
        if result is not None:
            tag, val = result
            entry['tr_result'] = val.hex()
            name = _tr_result_name(val[0], tag == 0x83)
            if name:
                entry['tr_result_name'] = name
        entry['tr_decoded'] = _decode_tr(entry.get('type_hex'), entry.get('qualifier'), entry['tr_hex'])
    except Exception:
        entry['tr_decoded'] = []


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


def _log_proactive(cmd_type, raw, qualifier=None, cmd_num=None):
    global _PROACTIVE_ENTRY_ID
    if _PROACTIVE_SESSION_START is None:
        return
    _PROACTIVE_ENTRY_ID += 1
    entry = {
        'id': _PROACTIVE_ENTRY_ID,
        'type_hex': '%02x' % cmd_type,
        'type_name': PROACTIVE_TYPE_NAMES.get(cmd_type, 'UNKNOWN'),
        'elapsed': round(time.time() - _PROACTIVE_SESSION_START, 1),
        'bytes': len(raw) if raw else 0,
        'raw': raw.hex() if raw else None,
    }
    if cmd_num is not None:
        entry['cmd_num'] = cmd_num
    if qualifier is not None:
        entry['qualifier'] = '%02x' % qualifier
    try:
        entry['cmd_decoded'] = _decode_cmd(cmd_type, raw, qualifier)
    except Exception:
        entry['cmd_decoded'] = []
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
            entry = _log_proactive(cmd_type, raw, cmd_qual, cmd_num)
        else:
            cmd_num, cmd_type, dev_src, dev_dst, cmd_qual = 1, 0, 0x83, 0x81, None
            entry = None
        if on_fetch:
            action = on_fetch(raw, cmd_num, cmd_type, dev_src, dev_dst)
        if action != 'pause':
            tr_tlv = _build_tr(scc, cmd_num, cmd_type, dev_src, dev_dst, cmd_qual)
            tr_rv = scc._tp.send_apdu('%s140000%02x%s' % (scc.cat_cla, len(tr_tlv), tr_tlv.hex()))
            sys.stderr.write('TR: cmd=%02x type=%02x -> %s %s\n' % (cmd_num, cmd_type, tr_rv[1], ('(%d bytes)' % len(tr_tlv))))
            _record_tr(entry, tr_tlv, tr_rv[1])
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
                entry = _log_proactive(cmd_type, raw, cmd_qual, cmd_num)
            else:
                entry = None
            tr_tlv = _build_tr(scc, cmd_num, cmd_type, dev_src, dev_dst, cmd_qual)
            tr_rv = scc._tp.send_apdu('%s140000%02x%s' % (scc.cat_cla, len(tr_tlv), tr_tlv.hex()))
            sys.stderr.write('TR(tp): cmd=%02x type=%02x -> %s\n' % (cmd_num, cmd_type, tr_rv[1]))
            _record_tr(entry, tr_tlv, tr_rv[1])
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
            for entry in reversed(_PROACTIVE_LOG):
                if (entry.get('cmd_num') == pd['cmd_num']
                        and entry.get('type_hex') == '%02x' % pd['cmd_type']
                        and 'tr_hex' not in entry):
                    _record_tr(entry, tr_data, tr_rv[1])
                    break
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
                    sys.stderr.write('OTA SEND: SPI %s %s KIc %s KID %s TAR %s CNTR %s LEN %dB CHUNKS %d\n' % (
                        body.get('spi1', ''), body.get('spi2', ''), body.get('kic', ''),
                        body.get('kid', ''), body.get('tar', ''), body.get('cntr', ''),
                        len(sp_bytes), total))
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
                            sys.stderr.write('OTA SEND FAILED: chunk %d SW %s\n' % (i + 1, sw))
                            break
                    else:
                        resp = {'success': True, 'sw': last_sw, 'response_data': last_data if last_data else None}
                        por_src = 'envelope'
                        por_hex = resp['response_data']
                        if submit_handler and submit_handler.submit_tpdu_hex:
                            tpdu_b = bytes.fromhex(submit_handler.submit_tpdu_hex)
                            idx = tpdu_b.find(b'\x02\x71\x00')
                            if idx >= 0:
                                por_hex = tpdu_b[idx:].hex()
                                por_src = 'sms-submit'
                        por = _decode_por(body.get('spi1', ''), body.get('spi2', ''), body.get('kic', ''),
                                          body.get('kid', ''), body.get('cntr', ''), body.get('kicKey', ''),
                                          body.get('kidKey', ''), por_hex)
                        if por:
                            resp['por'] = por
                            extra = ''
                            if por.get('decoded'):
                                extra = ' (compact: %s cmd, last SW %s)' % (por['decoded'].get('number_of_commands', '?'),
                                                                            por['decoded'].get('last_status_word', '?'))
                            sys.stderr.write('OTA PoR[%s]: status=%s TAR=%s CNTR=%s PCNTR=%s RPL=%s RHL=%s%s\n' % (
                                por_src, por.get('response_status'), por.get('tar'), por.get('cntr'),
                                por.get('pcntr'), por.get('rpl'), por.get('rhl'), extra))
                        elif por_hex:
                            sys.stderr.write('OTA PoR[%s]: undecodable raw=%s\n' % (por_src, str(por_hex)[:64]))
                        else:
                            sys.stderr.write('OTA PoR[%s]: none\n' % por_src)
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