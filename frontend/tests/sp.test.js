const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const des = require('des.js');
global.des = des;
const aesjs = require('aes-js');
global.aesjs = aesjs;

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunc(src, name) {
	const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
	const m = re.exec(src);
	if (!m) throw new Error('function ' + name + ' not found');
	let i = m.index + m[0].length - 1;
	let depth = 0;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) break;
		}
	}
	return src.slice(m.index, i + 1);
}

const FNS = ['hexToBytes', 'bytesToHex', 'des3Keys', 'des3EncryptBlock', 'des3CbcEncrypt',
	'xorBytes', 'zeroPad', 'cbcMac', 'aesCbcEncrypt', 'aesShiftLeft1', 'aesCmacSubkeys',
	'aesCmac', 'genSp'];
let code = '';
for (const f of FNS) code += extractFunc(html, f) + '\n';

// All test vectors are computed with the synthetic dummy key material below
// (no live/sample card keys, no ICCIDs). They are cross-checked byte-for-byte
// against pySim's OtaDialectSms.encode_cmd reference implementation.
const K = '00112233445566778899AABBCCDDEEFF';

const DEFAULTS = {
	'sp-apdu': '00A40000023F00',
	'sp-spi1': '06',
	'sp-spi2-hex': '09',
	'sp-kic-hex': '15',
	'sp-kid-hex': '15',
	'sp-tar': 'B00000',
	'sp-cntr': '0000000001',
	'sp-kic-key': K,
	'sp-kid-key': K,
	'sp-padding': '00',
};

const values = {};
const elements = {};
global.document = {
	getElementById(id) {
		if (!elements[id]) elements[id] = { value: values[id] || '' };
		return elements[id];
	},
};

eval(code);

function run() {
	genSp();
	return (elements['sp-result'] || { value: '' }).value;
}

function makeRun(overrides) {
	for (const [id, v] of Object.entries(DEFAULTS)) {
		values[id] = v;
		if (elements[id]) elements[id].value = v;
	}
	for (const [id, v] of Object.entries(overrides || {})) {
		values[id] = v;
		if (elements[id]) elements[id].value = v;
	}
	return run();
}

test('ciphered + CC SPI 06/09', () => {
	assert.strictEqual(
		makeRun({}),
		'00201506091515B00000C08F58C38860ACB3A362FFFE670AD13759A2A6B4C1A91116');
});

test('ciphered + CC SPI 16/01 (counter_must_be_higher, plaintext PoR)', () => {
	assert.strictEqual(
		makeRun({ 'sp-spi1': '16', 'sp-spi2-hex': '01' }),
		'00201516011515B00000E42573469E68A8462A57A505B0E2B1C09C1928C7A182311F');
});

test('unciphered + CC SPI 02/09', () => {
	assert.strictEqual(
		makeRun({ 'sp-spi1': '02', 'sp-spi2-hex': '09' }),
		'001D1502091515B0000000000000010085A8CA1A9828B0BB00A40000023F00');
});

test('unciphered packet uses CPL = octets from CHL to end (0x001d)', () => {
	const out = makeRun({ 'sp-spi1': '02', 'sp-spi2-hex': '09' });
	assert.strictEqual(out.slice(0, 4), '001D');
	assert.strictEqual(out.length, 62);
});

test('sysmocom public reference vector (spi1 04 / spi2 19, cntr=0)', () => {
	assert.strictEqual(
		makeRun({
			'sp-spi1': '04',
			'sp-spi2-hex': '19',
			'sp-kic-hex': '35',
			'sp-kid-hex': '35',
			'sp-cntr': '0000000000',
			'sp-kic-key': 'C21DD66ACAC13CB3BC8B331B24AFB57B',
			'sp-kid-key': '12110C78E678C25408233076AA033615',
		}),
		'00180D04193535B00000E3EC80A849B554421276AF3883927C20');
});

test('missing APDU reports an error', () => {
	assert.strictEqual(makeRun({ 'sp-apdu': '' }), 'Error: specify APDU');
});

test('cbcMac known answer (synthetic key)', () => {
	const input = hexToBytes('001d1502091515b0000000000000010000a40000023f00');
	assert.strictEqual(bytesToHex(cbcMac(input, hexToBytes(K))), '85A8CA1A9828B0BB');
});

// Public synthetic AES keys from pySim tests/unittests/test_ota.py (no live keys).
const KIC_AES = '200102030405060708090a0b0c0d0e0f';
const KID_AES = '201102030405060708090a0b0c0d0e0f';

test('aesCmac known answer (NIST SP 800-38B, truncated to 8)', () => {
	const key = hexToBytes('2b7e151628aed2a6abf7158809cf4f3c');
	assert.strictEqual(bytesToHex(aesCmac(new Uint8Array(0), key)), 'BB1D6929E9593728');
	assert.strictEqual(
		bytesToHex(aesCmac(hexToBytes('6bc1bee22e409f96e93d7e117393172a'), key)),
		'070A16B46B4D4144');
	assert.strictEqual(
		bytesToHex(aesCmac(hexToBytes('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411'), key)),
		'DFA66747DE9AE630');
});

test('AES ciphered + CC SPI 16/19 (counter higher)', () => {
	assert.strictEqual(
		makeRun({
			'sp-apdu': '00A40004023F00',
			'sp-spi1': '16',
			'sp-spi2-hex': '19',
			'sp-kic-hex': '22',
			'sp-kid-hex': '22',
			'sp-tar': 'B00011',
			'sp-cntr': '0000000011',
			'sp-kic-key': KIC_AES,
			'sp-kid-key': KID_AES,
		}),
		'00281516192222B000115A47655527E96E832F1A5C698655715D4331454A0D83952C0ED35245706976B1');
});

test('AES unciphered + CC SPI 12/09 (counter higher)', () => {
	assert.strictEqual(
		makeRun({
			'sp-apdu': '00A40004023F00',
			'sp-spi1': '12',
			'sp-spi2-hex': '09',
			'sp-kic-hex': '22',
			'sp-kid-hex': '22',
			'sp-tar': 'B00011',
			'sp-cntr': '0000000011',
			'sp-kic-key': KIC_AES,
			'sp-kid-key': KID_AES,
		}),
		'001D1512092222B0001100000000110029826122C7A0B79500A40004023F00');
});

test('AES ciphered + CC SPI 1E/19 (counter +1)', () => {
	assert.strictEqual(
		makeRun({
			'sp-apdu': '00A40004023F00',
			'sp-spi1': '1E',
			'sp-spi2-hex': '19',
			'sp-kic-hex': '22',
			'sp-kid-hex': '22',
			'sp-tar': 'B00011',
			'sp-cntr': '0000000011',
			'sp-kic-key': KIC_AES,
			'sp-kid-key': KID_AES,
		}),
		'0028151E192222B0001118B202EE47A3203E7370861C383B4142E704157B36E5C0EB4BB33EB6036CBAF8');
});

test('AES rejects no_counter (SPI1 b5b4 = 00)', () => {
	const err = makeRun({
		'sp-apdu': '00A40004023F00',
		'sp-spi1': '06',
		'sp-spi2-hex': '19',
		'sp-kic-hex': '22',
		'sp-kid-hex': '22',
		'sp-tar': 'B00011',
		'sp-cntr': '0000000011',
		'sp-kic-key': KIC_AES,
		'sp-kid-key': KID_AES,
	});
	assert.ok(err.startsWith('Error: AES requires a replay-protected counter'));
});

test('AES rejects 8-byte key', () => {
	const err = makeRun({
		'sp-apdu': '00A40004023F00',
		'sp-spi1': '16',
		'sp-spi2-hex': '19',
		'sp-kic-hex': '22',
		'sp-kid-hex': '22',
		'sp-tar': 'B00011',
		'sp-cntr': '0000000011',
		'sp-kic-key': '0011223344556677',
		'sp-kid-key': KID_AES,
	});
	assert.strictEqual(err, 'Error: AES KIc key must be 16, 24, or 32 bytes');
});
