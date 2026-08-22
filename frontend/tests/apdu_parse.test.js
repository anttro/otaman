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

function findNode(tree, label) {
	if (tree.label === label) return tree;
	if (tree.children) {
		for (const c of tree.children) {
			const r = findNode(c, label);
			if (r) return r;
		}
	}
	return null;
}

function findNodes(tree, label) {
	const out = [];
	if (tree.label === label) out.push(tree);
	if (tree.children) {
		for (const c of tree.children) out.push(...findNodes(c, label));
	}
	return out;
}

const consts = ['BER_QUAL', 'BER_DEVICES', 'BER_TONES', 'GSM7_ALPHABET', 'GSM7_EXT_MAP'];
let prefix = '';
for (const c of consts) {
	const m = html.match(new RegExp('const\\s+' + c + '\\s*=\\s*(?:\\[|\\{)[\\s\\S]*?(?:\\n[\\]\\}];|[\\]\\}];\\n)'));
	if (!m) throw new Error(c + ' not found');
	prefix += m[0].replace(/^const /, 'var ') + '\n';
}
const start = html.indexOf('// ===== C-APDU Parser =====');
const end = html.indexOf('// ===== Response Parser =====');
eval(prefix + html.slice(start, end).replace(/^const PARSE_INS = /m, 'var PARSE_INS = '));

test('Compact RAM INSTALL [for install] UICC', () => {
	const tree = parseHexTree('80E60C00214F08A000000151000000C70100EA128010000000020101020200011603B0000100');
	assert.strictEqual(tree.label, 'Compact C-APDU chain');
	assert.strictEqual(tree.children.length, 1);
	const apdu = tree.children[0];
	assert.strictEqual(apdu.label, 'APDU');
	assert.ok(findNode(apdu, 'INS').desc.includes('INSTALL'));
});

test('Compact RAM INSTALL [for install] SIM (CA) access domain 5A', () => {
	const tree = parseHexTree('80E60C00204F08A000000151000000C70100CA11015A000000020101020200011603B00001');
	const apdu = tree.children[0];
	assert.ok(findNode(apdu, 'INS').desc.includes('INSTALL'));
});

test('Expanded AA DISPLAY TEXT UCS2 "HI" + 5s', () => {
	const tree = parseHexTree('AA1681130103012101020281820D040048004904020105');
	assert.strictEqual(tree.label, 'Expanded Script (AA)');
	assert.strictEqual(tree.children.length, 1);
	assert.strictEqual(tree.children[0].label, 'Immediate Action');
});

test('Expanded AA DISPLAY TEXT GSM7 "HI"', () => {
	const tree = parseHexTree('AA0F810D0103012101020281820D02C824');
	assert.strictEqual(tree.children.length, 1);
	assert.strictEqual(tree.children[0].label, 'Immediate Action');
});

test('Expanded AA REFRESH + file list', () => {
	const tree = parseHexTree('AA10810E01030101000202818212036F3B2F');
	assert.strictEqual(tree.children.length, 1);
	assert.strictEqual(tree.children[0].label, 'Immediate Action');
});

test('Expanded AE80 PLAY TONE + Error Action no action', () => {
	const tree = parseHexTree('AE80810C0103200101020281820E010182000000');
	assert.strictEqual(tree.label, 'Expanded Script (AE80)');
	assert.strictEqual(tree.children.length, 2);
	assert.strictEqual(tree.children[0].label, 'Immediate Action');
	assert.strictEqual(tree.children[1].label, 'Error Action');
});

test('Immediate Action CR-set tags (real-world encoding)', () => {
	const tree = parseHexTree('AA0E8101818109810301010482028182');
	assert.strictEqual(tree.children.length, 2);
	assert.strictEqual(tree.children[0].label, 'Immediate Action');
	assert.strictEqual(tree.children[1].label, 'Immediate Action');
});

test('CR-set DISPLAY TEXT UCS2 "HI" + 5s', () => {
	const tree = parseHexTree('AA1581138103012101820281828D040048004984020105');
	assert.strictEqual(tree.children.length, 1);
});

test('CR-set PLAY TONE (tag 8E)', () => {
	const tree = parseHexTree('AA0E810C8103012001820281828E0101');
	assert.strictEqual(tree.children.length, 1);
});

test('CR-set REFRESH file list (tag 92)', () => {
	const tree = parseHexTree('AA0F810D81030101048202818292023F00');
	assert.strictEqual(tree.children.length, 1);
});

test('Expanded AA Error Action = proactive DISPLAY TEXT', () => {
	const tree = parseHexTree('AA0F820D0103012101020281820D022852');
	assert.strictEqual(tree.children.length, 1);
	assert.strictEqual(tree.children[0].label, 'Error Action');
});

test('Expanded AA 22 C-APDU row (GET STATUS)', () => {
	const tree = parseHexTree('AA09220780F22000024F00');
	assert.strictEqual(tree.children.length, 1);
	assert.strictEqual(tree.children[0].label, 'C-APDU');
});

test('Chained SIM SELECT + UPDATE RECORD', () => {
	const tree = parseHexTree('A0A40000026F3BDC0102032B2F2D');
	assert.strictEqual(tree.label, 'Compact C-APDU chain');
	assert.strictEqual(tree.children.length, 2);
	assert.strictEqual(tree.children[0].label, 'APDU');
});

test('INTERNAL AUTHENTICATE', () => {
	const tree = parseHexTree('8088000008800F3495BA2355CD');
	assert.strictEqual(tree.children.length, 1);
	const apdu = tree.children[0];
	assert.strictEqual(apdu.label, 'APDU');
	assert.ok(findNode(apdu, 'INS').desc.includes('INTERNAL AUTHENTICATE'));
	assert.ok(findNode(apdu, 'Data'));
});

test('baseCompTag clears CR bit for 0x80-0x9F', () => {
	assert.strictEqual(baseCompTag('81'), '01');
	assert.strictEqual(baseCompTag('82'), '02');
	assert.strictEqual(baseCompTag('8D'), '0D');
	assert.strictEqual(baseCompTag('8E'), '0E');
	assert.strictEqual(baseCompTag('92'), '12');
	assert.strictEqual(baseCompTag('84'), '04');
	assert.strictEqual(baseCompTag('85'), '05');
	assert.strictEqual(baseCompTag('01'), '01');
	assert.strictEqual(baseCompTag('22'), '22');
});

test('parseTlvList handles BER-TLVs', () => {
	const tlvs = parseTlvList('810301210182028182');
	assert.strictEqual(tlvs.length, 2);
	assert.strictEqual(tlvs[0].tag, '81');
	assert.strictEqual(tlvs[0].length, 3);
	assert.strictEqual(tlvs[0].value, '012101');
	assert.strictEqual(tlvs[1].tag, '82');
});

test('gsm7Decode unpacks "HI" from C824', () => {
	const bytes = new Uint8Array([0xC8, 0x24]);
	assert.strictEqual(gsm7Decode(bytes), 'HI');
});

test('decodeTextData legacy UCS2 without DCS (regression: lead 00 is not a DCS)', () => {
	assert.strictEqual(decodeTextData('00480049'), 'HI');
});

test('decodeTextData legacy Cyrillic UCS2 (uniform 04 high bytes)', () => {
	assert.strictEqual(decodeTextData('041f04400438043204350442'), 'Привет');
});

test('decodeTextData DCS-prefixed UCS2 (08)', () => {
	assert.strictEqual(decodeTextData('0800480049'), 'HI');
});

test('decodeTextData DCS-prefixed GSM7 packed (00)', () => {
	assert.strictEqual(decodeTextData('00C824'), 'HI');
});

test('decodeTextData DCS-prefixed unpacked 8-bit (04)', () => {
	assert.strictEqual(decodeTextData('04414243'), 'ABC');
});

test('decodeTextData explicit DCS 08 with malformed payload returns ?', () => {
	assert.strictEqual(decodeTextData('0841'), '?');
});

test('decodePrivileges byte 2 b6 is Token Verification per GPC v2.3 Table 11-8', () => {
	assert.ok(decodePrivileges('0020').includes('Token Verification'));
});

test('decodePrivileges', () => {
	assert.ok(decodePrivileges('00').includes('None'));
	assert.ok(decodePrivileges('80').includes('Security Domain'));
});