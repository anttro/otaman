const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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

const FNS = ['_hotaHex', '_hotaAsciiHex', '_hotaBerLen', '_hotaPad', '_hotaTlv',
	'hotaTlv', 'hotaBuildConn', 'hotaBuildSec', 'hotaBuildRetry',
	'hotaBuildHttpPost', 'hotaBuildTrigger', 'hotaBuildStore', 'hotaBuild'];
let code = '';
for (const f of FNS) code += extractFunc(html, f) + '\n';

eval(code);

test('_hotaHex strips non-hex and uppercases', () => {
	assert.strictEqual(_hotaHex(' 81 82 '), '8182');
	assert.strictEqual(_hotaHex('b0-00'), 'B000');
	assert.strictEqual(_hotaHex(''), '');
	assert.strictEqual(_hotaHex(undefined), '');
});

test('_hotaAsciiHex encodes text as ASCII bytes', () => {
	assert.strictEqual(_hotaAsciiHex('megafon.ru'), '6D656761666F6E2E7275');
	assert.strictEqual(_hotaAsciiHex('v1.0'), '76312E30');
	assert.strictEqual(_hotaAsciiHex('/sd'), '2F7364');
	assert.strictEqual(_hotaAsciiHex(''), '');
});

test('_hotaBerLen encodes definite lengths', () => {
	assert.strictEqual(_hotaBerLen(0), '00');
	assert.strictEqual(_hotaBerLen(11), '0B');
	assert.strictEqual(_hotaBerLen(127), '7F');
	assert.strictEqual(_hotaBerLen(128), '8180');
	assert.strictEqual(_hotaBerLen(255), '81FF');
	assert.strictEqual(_hotaBerLen(256), '820100');
});

test('hotaTlv wraps tag + definite length + value', () => {
	assert.strictEqual(hotaTlv('02', '8182'), '02028182');
	assert.strictEqual(hotaTlv('05', ''), '0500');
	assert.strictEqual(hotaTlv('8A', '6D656761666F6E2E7275'), '8A0A6D656761666F6E2E7275');
});

test('hotaBuildConn produces a full 84 TLV', () => {
	assert.strictEqual(hotaBuildConn([{ tag: '02', value: '8182' }]), '840402028182');
	assert.strictEqual(
		hotaBuildConn([
			{ tag: '01', value: '014001' },
			{ tag: '02', value: '81 82' },
			{ tag: '05', value: '' },
		]),
		'840B0103014001020281820500');
	assert.strictEqual(hotaBuildConn([{ tag: '02', value: '8182' }, { tag: '', value: 'FF' }]), '840402028182');
	// a half byte is padded, never turned into a fractional BER length
	assert.strictEqual(hotaBuildConn([{ tag: '35', value: '3' }]), '8403350103');
	// '84' is 1-n per Table 4-5: an empty container is left out entirely
	assert.strictEqual(hotaBuildConn([]), '');
});

test('hotaBuildSec produces a full 85 TLV per Table 4-6', () => {
	assert.strictEqual(
		hotaBuildSec({ pskIdentity: 'Test123', kvn: '01', kid: '01' }),
		'850B0754657374313233020101');
	assert.strictEqual(
		hotaBuildSec({ pskIdentity: '', kvn: '01', kid: '01' }),
		'850400020101');
});

test('hotaBuildRetry uses TS 102 223 timer TLV (25 03) and wraps in 86', () => {
	// the delay fields use the TP-SCTS semi-octet order (TS 23.040 9.1.2.3):
	// within an octet the low nibble holds the most significant digit, so
	// 1 min = '10', 20 s = '02', 10 min = '01', 1 h 2 min 3 s = '10 20 30'
	assert.strictEqual(
		hotaBuildRetry({ counter: 'B000', delayH: 1, delayM: 2, delayS: 3, reportFailure: '' }),
		'8607B0002503102030');
	assert.strictEqual(
		hotaBuildRetry({ counter: 'b0 00', delayH: '1', delayM: '2', delayS: '3', reportFailure: '0A080102030405060708' }),
		'8611B00025031020300A080102030405060708');
	// counter is 2 bytes mandatory: short input is left-padded, odd report dropped
	assert.strictEqual(
		hotaBuildRetry({ counter: '0000', delayH: 0, delayM: 0, delayS: 0, reportFailure: '0A0' }),
		'860700002503000000');
	// round-trip of the card's own 1-minute timer value 25 03 00 10 00
	assert.strictEqual(
		hotaBuildRetry({ counter: '0001', delayH: 0, delayM: 1, delayS: 0, reportFailure: '' }),
		'860700012503001000');
	assert.strictEqual(
		hotaBuildRetry({ counter: 'B0', delayH: 0, delayM: 0, delayS: 20, reportFailure: '' }),
		'860700B02503000002');
	assert.strictEqual(
		hotaBuildRetry({ counter: '0', delayH: 0, delayM: 10, delayS: 0, reportFailure: '' }),
		'860700002503000100');
});

test('hotaBuildHttpPost wraps non-empty 8A/8B/8C in a full 89 TLV', () => {
	// '8A'..'8C' are 1-n per Tables 4-8/9/10: empty parameters are omitted
	assert.strictEqual(hotaBuildHttpPost({ host: '', agent: '', uri: '' }), '');
	assert.strictEqual(hotaBuildHttpPost({ host: 'megafon.ru' }), '890C8A0A6D656761666F6E2E7275');
	assert.strictEqual(hotaBuildHttpPost({ agent: 'v1.0' }), '89068B0476312E30');
	assert.strictEqual(
		hotaBuildHttpPost({ host: 'megafon.ru', agent: 'v1.0', uri: '/sd' }),
		'89178A0A6D656761666F6E2E72758B0476312E308C032F7364');
});

test('hotaBuildTrigger wraps 81 > 83 > (84/85/86/89)', () => {
	const conn = '840402028182';
	const sec = '850400020101';
	const retry = '8607B0002503102030';
	const httpPost = '890C8A0A6D656761666F6E2E7275';
	assert.strictEqual(
		hotaBuildTrigger(conn, sec, retry, httpPost, false),
		'812583238404020281828504000201018607B0002503102030890C8A0A6D656761666F6E2E7275');
	// '81' is mandatory but 0-n; without parameters it stays an empty container
	assert.strictEqual(hotaBuildTrigger('', '', '', '', false), '8100');
});

test('hotaBuildTrigger expanded wraps the 81 command in Command Scripting template AA', () => {
	const conn = '840402028182';
	const plain = hotaBuildTrigger(conn, '', '', '', false);
	const expanded = hotaBuildTrigger(conn, '', '', '', true);
	const byteLen = plain.length / 2;
	assert.strictEqual(expanded, 'AA' + _hotaBerLen(byteLen) + plain);
	assert.ok(expanded.startsWith('AA'));
});

test('hotaBuildStore emits STORE DATA TLV-mode APDU (80 E2 90 00)', () => {
	assert.strictEqual(
		hotaBuildStore('840402028182', '', '', '', '85'),
		'80E29000088506840402028182');
	assert.strictEqual(
		hotaBuildStore('840402028182', '', '', '', 'A5'),
		'80E2900008A506840402028182');
	// nothing to store -> no APDU
	assert.strictEqual(hotaBuildStore('', '', '', '', '85'), '');
	// parameters longer than a short APDU are chained: P1.b8=0 for all but
	// the last block, P2 = block number, BER-TLV coding throughout
	const big = '84' + _hotaBerLen(140) + 'AA'.repeat(140);
	const inner = '85' + _hotaBerLen(big.length / 2) + big;
	const blocks = [];
	for (let i = 0; i < inner.length; i += 127 * 2) blocks.push(inner.slice(i, i + 127 * 2));
	assert.strictEqual(blocks.length, 2);
	assert.strictEqual(
		hotaBuildStore(big, '', '', '', '85'),
		'80E210007F' + blocks[0] +
		'80E29001' + (blocks[1].length / 2).toString(16).padStart(2, '0').toUpperCase() + blocks[1]);
});

test('hotaBuild dispatches on mode', () => {
	assert.strictEqual(
		hotaBuild('trigger', '840402028182', '', '', '', '85', false),
		hotaBuildTrigger('840402028182', '', '', '', false));
	assert.strictEqual(
		hotaBuild('store', '840402028182', '', '', '', '85', false),
		hotaBuildStore('840402028182', '', '', '', '85'));
	assert.strictEqual(
		hotaBuild('store', '840402028182', '', '8607B0002503010203', '', '85', false),
		hotaBuildStore('840402028182', '', '8607B0002503010203', '', '85'));
});