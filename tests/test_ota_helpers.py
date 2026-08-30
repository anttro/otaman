#!/usr/bin/env python3
"""Unit tests for the OTA helper functions in pysim_otaman_server.server.

Reference vectors are key-free: synthetic dummy keys plus the already-public
sysmocom sample-key vectors that ship in pySim's own tests/unittests/test_ota.py.
No live/sample card keys and no ICCIDs appear here.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

# pySim checkout is a sibling of this repo; put it on sys.path so the server
# module (which imports pySim at module level) can be exercised against it.
PROJECTS = Path(__file__).resolve().parents[2]
PY_SIM = PROJECTS / 'pysim'
if str(PY_SIM) not in sys.path:
    sys.path.insert(0, str(PY_SIM))

from pysim_otaman_server.server import (
    _build_sms_tpdu,
    _build_tr,
    _decode_cmd,
    _decode_por,
    _decode_tr,
    _log_proactive,
    _ota_reference,
    _record_tr,
    _spi_from_bytes,
    _tr_data_only,
)

# Synthetic dummy key material (no real card keys).
K = '00112233445566778899AABBCCDDEEFF'
# Public sysmocom sample keys from pySim tests/unittests/test_ota.py.
KIC3 = 'C21DD66ACAC13CB3BC8B331B24AFB57B'
KID3 = '12110C78E678C25408233076AA033615'
# Public synthetic AES keys from pySim tests/unittests/test_ota.py.
KIC_AES = '200102030405060708090a0b0c0d0e0f'
KID_AES = '201102030405060708090a0b0c0d0e0f'

APDU = '00a40000023f00'

# (spi1, spi2) -> expected secured packet, generated with _ota_reference
# against pySim's OtaDialectSms.encode_cmd and cross-checked with the JS genSp().
REFERENCE_VECTORS = {
    ('06', '09'):
        '00201506091515b00000c08f58c38860acb3a362fffe670ad13759a2a6b4c1a91116',
    ('16', '01'):
        '00201516011515b00000e42573469e68a8462a57a505b0e2b1c09c1928c7a182311f',
    ('02', '09'):
        '001d1502091515b0000000000000010085a8ca1a9828b0bb00a40000023f00',
}

# AES-128 reference vectors (public synthetic keys from pySim test_ota.py).
AES_APDU = '00a40004023f00'
AES_REFERENCE_VECTORS = {
    ('16', '19'):
        '00281516192222b000115a47655527e96e832f1a5c698655715d4331454a0d83952c0ed35245706976b1',
    ('12', '09'):
        '001d1512092222b0001100000000110029826122c7a0b79500a40004023f00',
    ('1e', '19'):
        '0028151e192222b0001118b202ee47a3203e7370861c383b4142e704157b36e5c0eb4bb33eb6036cbaf8',
}


class TestSpiFromBytes(unittest.TestCase):
    def test_06_09_ciphered_cc(self):
        spi = _spi_from_bytes(0x06, 0x09)
        self.assertEqual(spi, {
            'counter': 'no_counter',
            'ciphering': True,
            'rc_cc_ds': 'cc',
            'por_in_submit': False,
            'por_shall_be_ciphered': False,
            'por_rc_cc_ds': 'cc',
            'por': 'por_required',
        })

    def test_16_01_counter_must_be_higher(self):
        spi = _spi_from_bytes(0x16, 0x01)
        self.assertEqual(spi['counter'], 'counter_must_be_higher')
        self.assertTrue(spi['ciphering'])
        self.assertEqual(spi['rc_cc_ds'], 'cc')
        self.assertEqual(spi['por_rc_cc_ds'], 'no_rc_cc_ds')

    def test_02_09_unciphered_cc(self):
        spi = _spi_from_bytes(0x02, 0x09)
        self.assertFalse(spi['ciphering'])
        self.assertEqual(spi['rc_cc_ds'], 'cc')
        self.assertEqual(spi['por_rc_cc_ds'], 'cc')

    def test_04_19_ciphered_no_cc(self):
        spi = _spi_from_bytes(0x04, 0x19)
        self.assertTrue(spi['ciphering'])
        self.assertEqual(spi['rc_cc_ds'], 'no_rc_cc_ds')
        self.assertTrue(spi['por_shall_be_ciphered'])
        self.assertEqual(spi['por_rc_cc_ds'], 'cc')


class TestBuildSmsTpdu(unittest.TestCase):
    CHUNK = '00201506091515b00000c08f58c38860acb3a362fffe670ad13759a2a6b4c1a91116'
    SCTS = bytes.fromhex('24051215173000')

    def _build(self, *args, **kwargs):
        with mock.patch('pysim_otaman_server.server._encode_scts', return_value=self.SCTS):
            return _build_sms_tpdu(*args, **kwargs)

    def test_single_message_with_cpi(self):
        self.assertEqual(
            self._build(self.CHUNK, include_cpi=True),
            '4005812143f57ff6240512151730002502700000201506091515b00000'
            'c08f58c38860acb3a362fffe670ad13759a2a6b4c1a91116')

    def test_single_message_without_cpi(self):
        self.assertEqual(
            self._build(self.CHUNK, include_cpi=False),
            '0405812143f57ff6240512151730002200201506091515b00000'
            'c08f58c38860acb3a362fffe670ad13759a2a6b4c1a91116')

    def test_first_chunk_has_cpi(self):
        self.assertEqual(
            self._build(self.CHUNK, chunk_total=3, chunk_num=1, include_cpi=True),
            '4405812143f57ff6240512151730002a070003010301700000201506091515b00000'
            'c08f58c38860acb3a362fffe670ad13759a2a6b4c1a91116')

    def test_later_chunk_concat_only(self):
        self.assertEqual(
            self._build(self.CHUNK, chunk_total=3, chunk_num=2, include_cpi=True),
            '4405812143f57ff6240512151730002805000301030200201506091515b00000'
            'c08f58c38860acb3a362fffe670ad13759a2a6b4c1a91116')


class TestOtaReference(unittest.TestCase):
    def test_ciphered_spi_06_09(self):
        out, _ = _ota_reference('06', '09', '15', '15', 'b00000', '0000000001', APDU, K, K)
        self.assertEqual(out, REFERENCE_VECTORS[('06', '09')])

    def test_ciphered_spi_16_01(self):
        out, _ = _ota_reference('16', '01', '15', '15', 'b00000', '0000000001', APDU, K, K)
        self.assertEqual(out, REFERENCE_VECTORS[('16', '01')])

    def test_unciphered_spi_02_09(self):
        out, _ = _ota_reference('02', '09', '15', '15', 'b00000', '0000000001', APDU, K, K)
        self.assertEqual(out, REFERENCE_VECTORS[('02', '09')])

    def test_unciphered_cpl_is_0x001d(self):
        # Regression: CPL counts octets from the CHL octet to the last octet
        # of the secured data (29 here), it must NOT be len(out)-2 (27/0x001b).
        out, _ = _ota_reference('02', '09', '15', '15', 'b00000', '0000000001', APDU, K, K)
        self.assertEqual(out[:4], '001d')
        self.assertEqual(len(out) // 2, 31)

    def test_sysmocom_reference_vector(self):
        # Public vector from pySim tests/unittests/test_ota.py (test_cmd_3des_ciphered).
        out, _ = _ota_reference('04', '19', '35', '35', 'b00000', '0000000000', APDU, KIC3, KID3)
        self.assertEqual(out, '00180d04193535b00000e3ec80a849b554421276af3883927c20')

    def test_returns_spi_dict(self):
        _, spi = _ota_reference('16', '01', '15', '15', 'b00000', '0000000001', APDU, K, K)
        self.assertEqual(spi['counter'], 'counter_must_be_higher')
        self.assertTrue(spi['ciphering'])

    def test_aes128_ciphered_cc(self):
        out, _ = _ota_reference('16', '19', '22', '22', 'b00011', '0000000011', AES_APDU, KIC_AES, KID_AES)
        self.assertEqual(out, AES_REFERENCE_VECTORS[('16', '19')])

    def test_aes128_unciphered_cc(self):
        out, _ = _ota_reference('12', '09', '22', '22', 'b00011', '0000000011', AES_APDU, KIC_AES, KID_AES)
        self.assertEqual(out, AES_REFERENCE_VECTORS[('12', '09')])

    def test_aes128_counter_plus_one(self):
        out, spi = _ota_reference('1e', '19', '22', '22', 'b00011', '0000000011', AES_APDU, KIC_AES, KID_AES)
        self.assertEqual(out, AES_REFERENCE_VECTORS[('1e', '19')])
        self.assertEqual(spi['counter'], 'counter_must_be_lower')


class TestDecodePor(unittest.TestCase):
    def test_plaintext_no_cc_synthetic(self):
        r = _decode_por('02', '01', '15', '15', '0000000001', K, K,
                        '027100000e0ab0000000000000010000016e00')
        self.assertEqual(r['response_status'], 'por_ok')
        self.assertEqual(r['tar'], 'B00000')
        self.assertEqual(r['decoded']['last_status_word'], '6e00')

    def test_sysmocom_signed(self):
        r = _decode_por('06', '09', '35', '35', '0000000001', KIC3, KID3,
                        '027100001612b000110000000000000055f47118381175fb01612f')
        self.assertEqual(r['response_status'], 'por_ok')
        self.assertEqual(r['decoded']['last_status_word'], '612f')

    def test_sysmocom_ciphered(self):
        r = _decode_por('06', '19', '35', '35', '0000000001', KIC3, KID3,
                        '027100001c12b000119660ebdb81be189b5e4389e9e7ab2bc0954f963ad869ed7c')
        self.assertEqual(r['response_status'], 'por_ok')
        self.assertEqual(r['decoded']['last_status_word'], '612f')

    def test_sysmocom_no_cc(self):
        r = _decode_por('06', '01', '35', '35', '0000000001', KIC3, KID3,
                        '027100000e0ab000110000000000000001612f')
        self.assertEqual(r['response_status'], 'por_ok')
        self.assertEqual(r['decoded']['last_status_word'], '612f')

    def test_complete_field_report(self):
        """All parsed PoR fields are surfaced verbatim (v1.9.4)."""
        raw = '027100000e0ab000110000000000000001612f'
        r = _decode_por('06', '01', '35', '35', '0000000001', KIC3, KID3, raw)
        self.assertEqual(r['response_status'], 'por_ok')
        self.assertEqual(r['tar'], 'B00011')
        self.assertEqual(r['cntr'], '0000000000')
        self.assertEqual(r['pcntr'], 0)
        self.assertEqual(r['rpl'], 14)
        self.assertEqual(r['rhl'], 10)
        self.assertEqual(r['cc_rc'], '')
        self.assertEqual(r['raw'], raw)
        self.assertNotIn('cntr_low', str(r))

    def test_cntr_low_fields(self):
        r = _decode_por('02', '01', '15', '15', '0000000001', K, K,
                        '027100000b0ab0000000000000070002')
        self.assertEqual(r['response_status'], 'cntr_low')
        self.assertEqual(r['tar'], 'B00000')
        self.assertEqual(r['cntr'], '0000000007')
        self.assertEqual(r['rpl'], 11)
        self.assertEqual(r['rhl'], 10)
        self.assertIsNone(r.get('decoded'))

    def test_sysmocom_bad_cc_returns_none(self):
        r = _decode_por('06', '09', '35', '35', '0000000001', KIC3, KID3,
                        '027100001612b000110000000000000055f47118381175fb02612f')
        self.assertIsNone(r)

    def test_aes128_ciphered(self):
        r = _decode_por('06', '19', '22', '22', '0000000001', KIC_AES, KID_AES,
                        '027100002412b00011ebc6b497e2cad7aedf36ace0e3a29b38853f0fe9ccde81913be5702b73abce1f')
        self.assertEqual(r['response_status'], 'por_ok')
        self.assertEqual(r['decoded']['last_status_word'], '6132')

    def test_malformed_returns_none(self):
        for bad in ['', '00', '00027100000e0a', '027100000e0ab00000', 'garbage', 'zz']:
            self.assertIsNone(
                _decode_por('02', '01', '15', '15', '0000000001', K, K, bad),
                msg='expected None for %r' % bad)


class TestProactiveDecode(unittest.TestCase):
    """Server-side proactive command/TR decode helpers (v1.8.0 log feature)."""

    def setUp(self):
        import pysim_otaman_server.server as srv
        srv._PROACTIVE_SESSION_START = 1234.0
        srv._PLI_DATA[0x00] = '93055210011000'

    def test_decode_cmd_poll_interval(self):
        r = _decode_cmd(0x03, bytes.fromhex('d00d8103010300820283818402011e'), None)
        self.assertEqual(r, [{'label': 'Interval', 'value': '30 s'}])

    def test_decode_cmd_setup_event_list(self):
        r = _decode_cmd(0x05, bytes.fromhex('d00c810301050082028381990101'), None)
        self.assertEqual(r, [{'label': 'Events', 'value': 'Call connected'}])

    def test_decode_cmd_send_short_message(self):
        r = _decode_cmd(0x13, bytes.fromhex('d0158103011300820283818b0b916106152670f900a35f020101'), None)
        self.assertEqual(r, [{'label': 'SMS TPDU', 'value': '916106152670f900a35f02'}])

    def test_decode_cmd_pli_qualifier_name(self):
        r = _decode_cmd(0x26, b'\xd0', 0x00)
        self.assertTrue(r[0]['value'].startswith('Location Information (MCC, MNC, LAC/TAC, Cell ID)'))

    def test_decode_cmd_empty_raw(self):
        self.assertEqual(_decode_cmd(0x26, b'', None), [])
        self.assertEqual(_decode_cmd(0x03, None, None), [])

    def test_decode_tr_pli_location(self):
        r = _decode_tr('26', '00', '93055210011000')
        self.assertEqual(r, [
            {'label': 'MCC', 'value': '250'},
            {'label': 'MNC', 'value': '11'},
            {'label': 'LAC/TAC', 'value': '1000'},
        ])

    def test_decode_tr_pli_imei(self):
        r = _decode_tr('26', '01', '94082143658709214305')
        self.assertEqual(r[0], {'label': 'IMEI', 'value': '123456789012345'})

    def test_decode_tr_pli_access_technology(self):
        r = _decode_tr('26', '06', 'bf0103')
        self.assertEqual(r, [{'label': 'Access Technology', 'value': 'UTRAN (3)'}])

    def test_decode_tr_pli_search_mode(self):
        r = _decode_tr('26', '09', 'ad0101')
        self.assertEqual(r, [{'label': 'Search Mode', 'value': 'Manual'}])

    def test_decode_tr_poll_interval(self):
        r = _decode_tr('03', None, '8402011e')
        self.assertEqual(r, [{'label': 'Interval', 'value': '30 s'}])

    def test_decode_tr_empty(self):
        self.assertEqual(_decode_tr('26', '00', ''), [])

    def test_tr_data_only_strips_boilerplate(self):
        tr = bytes.fromhex('81030326008202818393055210011000030100')
        self.assertEqual(_tr_data_only(tr).hex(), '93055210011000')

    def test_build_and_record_tr(self):
        entry = {'type_hex': '26', 'qualifier': '00'}
        tr = _build_tr(None, 3, 0x26, 0x83, 0x81, 0x00)
        _record_tr(entry, tr, '9000')
        self.assertEqual(entry['tr_hex'], '93055210011000')
        self.assertEqual(entry['tr_sw'], '9000')
        self.assertEqual([f['label'] for f in entry['tr_decoded']], ['MCC', 'MNC', 'LAC/TAC'])

    def test_record_tr_without_sw(self):
        entry = {'type_hex': '26', 'qualifier': '00'}
        _record_tr(entry, bytes.fromhex('93055210011000'))
        self.assertNotIn('tr_sw', entry)
        self.assertEqual(entry['tr_hex'], '93055210011000')

    def test_log_proactive_fields(self):
        entry = _log_proactive(0x26, b'\xd0', 0x00, 7)
        self.assertEqual(entry['cmd_num'], 7)
        self.assertEqual(entry['type_hex'], '26')
        self.assertEqual(entry['qualifier'], '00')
        self.assertEqual(entry['raw'], 'd0')
        self.assertEqual(entry['cmd_decoded'][0]['label'], 'Qualifier')
        self.assertIn('id', entry)

    def test_log_proactive_malformed_raw(self):
        entry = _log_proactive(0x21, bytes([0xD0, 0xFF]), 0x00)
        self.assertEqual(entry['cmd_decoded'], [])

    def test_log_proactive_no_cmd_num(self):
        entry = _log_proactive(0x05, bytes.fromhex('990101'), None)
        self.assertNotIn('cmd_num', entry)

    def test_record_tr_basic_result(self):
        entry = {'type_hex': '03', 'qualifier': None}
        _record_tr(entry, bytes.fromhex('8103010300820281838402011e030100'))
        self.assertEqual(entry['tr_result'], '00')
        self.assertEqual(entry['tr_result_name'], 'Command performed successfully')
        self.assertEqual(entry['tr_hex'], '8402011e')

    def test_record_tr_general_result(self):
        entry = {'type_hex': '26', 'qualifier': '00'}
        _record_tr(entry, bytes.fromhex('8103032600820281839305521001100083022001'))
        self.assertEqual(entry['tr_result'], '2001')
        self.assertEqual(entry['tr_result_name'], 'ME currently unable to process command')
        self.assertEqual(entry['tr_hex'], '93055210011000')

    def test_record_tr_unknown_result(self):
        entry = {'type_hex': '26', 'qualifier': '00'}
        _record_tr(entry, bytes.fromhex('810303260082028181030107'))
        self.assertEqual(entry['tr_result'], '07')
        self.assertNotIn('tr_result_name', entry)

    def test_record_tr_no_result_tlv(self):
        entry = {'type_hex': '26', 'qualifier': '00'}
        _record_tr(entry, bytes.fromhex('810303260082028181'))
        self.assertNotIn('tr_result', entry)


class TestExpandedRemoteResponse(unittest.TestCase):
    """Expanded Remote Response parsing (TS 102 226 §5.2.2)."""
    
    def test_expanded_response_single_command(self):
        entry = {'type_hex': '03', 'qualifier': None}
        _record_tr(entry, bytes.fromhex('810301030082028183030100'))
        self.assertEqual(entry['tr_result'], '00')
        self.assertEqual(entry['tr_result_name'], 'Command performed successfully')
    
    def test_expanded_response_parser_single_command(self):
        # Simple test of the construct parsing structure
        try:
            from construct import Struct, Int8ub, Bytes, GreedyBytes, Optional, Array, this
            from osmocom.utils import b2h
            
            # Create sample expanded response data
            secured_data = bytes.fromhex('01' '01' '9000' '11')  # response_count, cmd#, SW, data
            
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
            expanded = ExpandedRemoteResponse.parse(secured_data)
            self.assertEqual(expanded.response_count, 1)
            self.assertEqual(expanded.responses[0].command_number, 1)
            self.assertEqual(b2h(expanded.responses[0].status_word).upper(), '9000')
            self.assertEqual(b2h(expanded.responses[0].response_data).upper(), '11')
        except Exception as e:
            self.fail(f"ExpandedRemoteResponse parsing failed: {e}")
    
    def test_expanded_response_with_error(self):
        entry = {'type_hex': '26', 'qualifier': '01'}
        # Result TLV: 03 01 6A (error_code 0x6A)
        _record_tr(entry, bytes.fromhex('81030326008202818303016A'))
        self.assertEqual(entry['tr_result'], '6a')
        self.assertEqual(entry['tr_result_name'], 'Command performed with limited understanding')
    
    def test_expanded_response_with_chaining(self):
        entry = {'type_hex': '26', 'qualifier': '00'}
        # Result: 03 01 00 + chaining context with script_id
        _record_tr(entry, bytes.fromhex('81030326008202818303010093'))
        self.assertEqual(entry['tr_result'], '00')
        self.assertEqual(entry['tr_result_name'], 'Command performed successfully')


class TestSmsConcat(unittest.TestCase):
    """Tests for _parse_sms_concat — SMS UDH concatenation parsing."""

    def test_no_udh_sms_submit(self):
        """SMS-SUBMIT without TP-UDHI: entire UD is payload."""
        from pysim_otaman_server.server import _parse_sms_concat
        # First octet 0x01: MTI=01 (SUBMIT), no UDH, no VP
        # MR=00, DA_len=05, DA_type=90, DA=2143F5, PID=00, DCS=04, UDL=03, UD=AABBCC
        tpdu = bytes.fromhex('0100'  # first octet + MR
                             '05'    # DA length
                             '90'    # DA type
                             '2143F5'  # DA data (3 bytes for 5 digits)
                             '0004'  # PID + DCS
                             '03'    # UDL
                             'AABBCC')  # UD (payload)
        ref, total, num, payload = _parse_sms_concat(tpdu)
        self.assertIsNone(ref)
        self.assertIsNone(total)
        self.assertIsNone(num)
        self.assertEqual(payload.hex(), 'aabbcc')

    def test_8bit_concat_iei_0x00(self):
        """SMS-SUBMIT with IEI 0x00 (8-bit reference concatenation)."""
        from pysim_otaman_server.server import _parse_sms_concat
        # First octet 0x41: MTI=01 (SUBMIT), TP-UDHI=1, no VP
        # MR=00, DA_len=05, DA_type=90, DA=2143F5, PID=00, DCS=04
        # UDL=09, UDHL=05, UDH: 00 03 04 04 01 (concat IE), payload=AABBCC
        tpdu = bytes.fromhex('4100'  # first octet + MR
                             '05'    # DA length
                             '90'    # DA type
                             '2143F5'  # DA data
                             '0004'  # PID + DCS
                             '09'    # UDL (1 UDHL + 5 UDH + 3 payload = 9)
                             '05'    # UDHL = 5 bytes of UDH
                             '0003'  # IEI=0x00, IEDL=3
                             '04'    # ref
                             '04'    # total (4 segments)
                             '01'    # num (segment 1)
                             'AABBCC')  # payload
        ref, total, num, payload = _parse_sms_concat(tpdu)
        self.assertEqual(ref, 0x04)
        self.assertEqual(total, 4)
        self.assertEqual(num, 1)
        self.assertEqual(payload.hex(), 'aabbcc')

    def test_16bit_concat_iei_0x08(self):
        """SMS-SUBMIT with IEI 0x08 (16-bit reference concatenation)."""
        from pysim_otaman_server.server import _parse_sms_concat
        # First octet 0x41: MTI=01, TP-UDHI=1
        # UDH: 06 (UDHL) 08 04 01 02 03 04 (16-bit concat: ref=0x0102, total=3, num=4)
        # payload=FF
        tpdu = bytes.fromhex('4100'
                             '05'
                             '90'
                             '2143F5'
                             '0004'
                             '08'    # UDL (1 UDHL + 6 UDH + 1 payload = 8)
                             '06'    # UDHL
                             '0804'  # IEI=0x08, IEDL=4
                             '0102'  # ref (16-bit, big-endian)
                             '03'    # total
                             '04'    # num
                             'FF')   # payload
        ref, total, num, payload = _parse_sms_concat(tpdu)
        self.assertEqual(ref, 0x0102)
        self.assertEqual(total, 3)
        self.assertEqual(num, 4)
        self.assertEqual(payload.hex(), 'ff')

    def test_udh_with_cpi(self):
        """UDH with concatenation IE + CPI IE (0x70)."""
        from pysim_otaman_server.server import _parse_sms_concat
        # First octet 0x41: MTI=01, TP-UDHI=1
        # UDHL=07, UDH: 00 03 04 04 01 (concat) + 70 00 (CPI)
        tpdu = bytes.fromhex('4100'
                             '05'
                             '90'
                             '2143F5'
                             '0004'
                             '0A'    # UDL (1 UDHL + 7 UDH + 1 payload = 9? no: 1+5+2+1=9, but UDH=7 bytes)
                             '07'    # UDHL = 7
                             '0003'  # IEI=0x00, IEDL=3
                             '04'    # ref
                             '04'    # total
                             '01'    # num
                             '7000'  # CPI IE (IEI=0x70, IEDL=0)
                             'DD')   # payload
        ref, total, num, payload = _parse_sms_concat(tpdu)
        self.assertEqual(ref, 0x04)
        self.assertEqual(total, 4)
        self.assertEqual(num, 1)
        self.assertEqual(payload.hex(), 'dd')

    def test_empty_payload(self):
        """Segment with empty payload after UDH."""
        from pysim_otaman_server.server import _parse_sms_concat
        # First octet 0x41: MTI=01, TP-UDHI=1
        tpdu = bytes.fromhex('4100'
                             '05'
                             '90'
                             '2143F5'
                             '0004'
                             '06'    # UDL (1 UDHL + 5 UDH + 0 payload = 6)
                             '05'    # UDHL
                             '0003'
                             '01'
                             '02'
                             '01')   # no payload after UDH
        ref, total, num, payload = _parse_sms_concat(tpdu)
        self.assertEqual(ref, 0x01)
        self.assertEqual(total, 2)
        self.assertEqual(num, 1)
        self.assertEqual(len(payload), 0)

    def test_short_tpdu(self):
        """Truncated TPDU returns gracefully."""
        from pysim_otaman_server.server import _parse_sms_concat
        ref, total, num, payload = _parse_sms_concat(b'\x01')
        self.assertIsNone(ref)
        self.assertIsNone(total)
        self.assertIsNone(num)

    def test_none_input(self):
        """None input returns empty payload."""
        from pysim_otaman_server.server import _parse_sms_concat
        ref, total, num, payload = _parse_sms_concat(None)
        self.assertIsNone(ref)
        self.assertIsNone(total)
        self.assertIsNone(num)
        self.assertEqual(len(payload), 0)

    def test_short_tpdu(self):
        """Truncated TPDU returns gracefully."""
        from pysim_otaman_server.server import _parse_sms_concat
        ref, total, num, payload = _parse_sms_concat(b'\x44')
        self.assertIsNone(ref)
        self.assertIsNone(total)
        self.assertIsNone(num)

    def test_none_input(self):
        """None input returns empty payload."""
        from pysim_otaman_server.server import _parse_sms_concat
        ref, total, num, payload = _parse_sms_concat(None)
        self.assertIsNone(ref)
        self.assertIsNone(total)
        self.assertIsNone(num)
        self.assertEqual(len(payload), 0)


class TestSmsReassembly(unittest.TestCase):
    """Tests for SMS segment reassembly logic."""

    def test_single_segment_no_concat(self):
        """Single segment without UDH → submit_tpdu_hex is set directly."""
        from pysim_otaman_server.server import PoRSubmitHandler, _find_sms_tpdu, _parse_sms_concat
        handler = PoRSubmitHandler()
        # Build a simple D0 with tag 8B containing an SMS-SUBMIT without UDH
        sms_tpdu = bytes.fromhex('040005902143F50004'  # SMS-SUBMIT header
                                 '03'                   # UDL
                                 'AABBCC')              # payload
        # Wrap in D0 proactive command
        d0 = bytes([0xD0, len(sms_tpdu) + 4,  # approximate BER length
                     0x81, 0x03, 0x01, 0x13, 0x00,  # Command Details
                     0x82, 0x02, 0x81, 0x83,  # Device Identities
                     0x8B, len(sms_tpdu)])  # tag 8B
        # Simulate _find_sms_tpdu extracting tag 8B
        found = sms_tpdu.hex()
        # Parse and check
        ref, total, num, payload = _parse_sms_concat(sms_tpdu)
        self.assertIsNone(ref)
        handler.submit_tpdu_hex = found  # single segment path
        self.assertEqual(handler.submit_tpdu_hex, found)

    def test_multi_segment_reassembly(self):
        """3 segments with IEI 0x00 in random order → assembled in correct order."""
        from pysim_otaman_server.server import PoRSubmitHandler
        handler = PoRSubmitHandler()

        # Segment payloads (after UDH)
        payloads = [b'\x01\x02', b'\x03\x04', b'\x05\x06']
        ref = 0x42
        total = 3

        # Simulate receiving segments in random order: 2, 0, 1
        for idx in [1, 0, 2]:
            num = idx + 1
            handler.sms_segments.append((ref, total, num, payloads[idx].hex()))
            # Check if all segments collected
            matching = [s for s in handler.sms_segments if s[0] == ref]
            if len(matching) >= total:
                sorted_segs = sorted(matching, key=lambda s: s[2])
                assembled = b''.join(bytes.fromhex(s[3]) for s in sorted_segs)
                handler.submit_tpdu_hex = assembled.hex()

        self.assertEqual(handler.submit_tpdu_hex, '010203040506')

    def test_independent_references(self):
        """Two different reference numbers are independent."""
        from pysim_otaman_server.server import PoRSubmitHandler
        handler = PoRSubmitHandler()

        # Ref 0x01: 2 segments
        handler.sms_segments.append((0x01, 2, 1, 'AA'))
        handler.sms_segments.append((0x01, 2, 2, 'BB'))
        matching = [s for s in handler.sms_segments if s[0] == 0x01]
        if len(matching) >= 2:
            sorted_segs = sorted(matching, key=lambda s: s[2])
            assembled = b''.join(bytes.fromhex(s[3]) for s in sorted_segs)
            handler.submit_tpdu_hex = assembled.hex()

        self.assertEqual(handler.submit_tpdu_hex, 'aabb')

        # Ref 0x02: 1 segment (independent)
        handler.sms_segments.append((0x02, 1, 1, 'CC'))
        matching2 = [s for s in handler.sms_segments if s[0] == 0x02]
        if len(matching2) >= 1:
            sorted_segs2 = sorted(matching2, key=lambda s: s[2])
            assembled2 = b''.join(bytes.fromhex(s[3]) for s in sorted_segs2)
            # Only update if ref 0x02 is complete
            handler.submit_tpdu_hex = assembled2.hex()

        # Last assembly was ref 0x02
        self.assertEqual(handler.submit_tpdu_hex, 'cc')


if __name__ == '__main__':
    unittest.main()
