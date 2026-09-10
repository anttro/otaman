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

const FNS = ['_hotaHex', '_hotaAsciiHex', '_hotaBerLen', '_hotaTlv',
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
	assert.strictEqual(hotaBuildConn([]), '8400');
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
	assert.strictEqual(
		hotaBuildRetry({ counter: 'B000', delayH: 1, delayM: 2, delayS: 3, reportFailure: '' }),
		'8607B0002503010203');
	assert.strictEqual(
		hotaBuildRetry({ counter: 'b0 00', delayH: '1', delayM: '2', delayS: '3', reportFailure: '0A080102030405060708' }),
		'8611B00025030102030A080102030405060708');
	assert.strictEqual(
		hotaBuildRetry({ counter: '0000', delayH: 0, delayM: 0, delayS: 0, reportFailure: '0A0' }),
		'860700002503000000');
});

test('hotaBuildHttpPost wraps 8A/8B/8C in a full 89 TLV', () => {
	assert.strictEqual(
		hotaBuildHttpPost({ host: '', agent: '', uri: '' }),
		'89068A008B008C00');
	assert.strictEqual(
		hotaBuildHttpPost({ host: 'megafon.ru', agent: 'v1.0', uri: '/sd' }),
		'89178A0A6D656761666F6E2E72758B0476312E308C032F7364');
});

test('hotaBuildTrigger wraps 81 > 83 > (84/85/86/89)', () => {
	const conn = '840402028182';
	const sec = '850400020101';
	const retry = '8607B0002503010203';
	const httpPost = '89068A008B008C00';
	assert.strictEqual(
		hotaBuildTrigger(conn, sec, retry, httpPost, false),
		'811F831D8404020281828504000201018607B000250301020389068A008B008C00');
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