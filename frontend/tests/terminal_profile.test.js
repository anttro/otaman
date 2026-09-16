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

let code = '';
for (const f of ['tpNorm', 'tpValid', 'tpGetBit', 'tpSetBit', 'tpBitLabel']) {
	code += extractFunc(html, f) + '\n';
}
code += html.match(/const TP_BITS = \[[\s\S]*?\n\];/)[0].replace('const ', 'var ') + '\n';
code += html.match(/const TP_PRESETS = \[[\s\S]*?\n\];/)[0].replace('const ', 'var ') + '\n';
eval(code);

test('tpNorm / tpValid normalize and validate profile hex', () => {
	assert.strictEqual(tpNorm(' ff ee 00 '), 'FFEE00');
	assert.strictEqual(tpNorm('zz'), '');
	assert.ok(tpValid('FF'));
	assert.ok(tpValid('00FF'));
	assert.ok(!tpValid(''));
	assert.ok(!tpValid('F'));
});

test('tpGetBit / tpSetBit address bits MSB-first per byte', () => {
	const hex = '80' + '01';       // byte 1 b8 set, byte 2 b1 set
	assert.strictEqual(tpGetBit(hex, 0), true);    // byte 1 b8
	assert.strictEqual(tpGetBit(hex, 7), false);   // byte 1 b1
	assert.strictEqual(tpGetBit(hex, 8), false);   // byte 2 b8
	assert.strictEqual(tpGetBit(hex, 15), true);   // byte 2 b1
	assert.strictEqual(tpGetBit(hex, 16), null);   // beyond the profile
	// toggling keeps the other bits untouched
	assert.strictEqual(tpSetBit('00', 0, true), '80');
	assert.strictEqual(tpSetBit('80', 0, false), '00');
	assert.strictEqual(tpSetBit('FF', 7, false), 'FE');
	// a bit beyond the current length grows the profile with zero bytes
	assert.strictEqual(tpSetBit('FF', 24, true), 'FF000080');
});

test('TERMINAL PROFILE bit table matches TS 102 223 5.2 spot checks', () => {
	assert.ok(TP_BITS.length >= 264, 'expected the full byte 1..33 table');
	assert.strictEqual(TP_BITS[0], 'Profile download');                       // byte 1 b8
	assert.strictEqual(TP_BITS[16], 'Proactive UICC: DISPLAY TEXT');          // byte 3 b8
	assert.strictEqual(TP_BITS[32], 'Proactive UICC: SET UP EVENT LIST');     // byte 5 b8
	assert.strictEqual(TP_BITS[42], 'Event: Data available');                 // byte 6 b3
	assert.strictEqual(TP_BITS[88], 'Proactive UICC: OPEN CHANNEL');          // byte 12 b8
	assert.strictEqual(TP_BITS[260], 'Proactive UICC: PROVIDE LOCAL INFORMATION (Supported Radio Access Technologies)');
	assert.strictEqual(tpBitLabel(0), 'Profile download');
	assert.match(tpBitLabel(400), /^RFU \(byte 51 b/);                        // beyond the table
});

test('TERMINAL PROFILE presets are valid even-length hex', () => {
	assert.ok(TP_PRESETS.length >= 2);
	assert.match(TP_PRESETS[0].name, /Xiaomi/i);
	for (const p of TP_PRESETS) {
		assert.ok(p.name && p.profile, p.name);
		assert.ok(/^[0-9A-F]+$/.test(p.profile) && p.profile.length % 2 === 0, p.name);
		assert.ok(p.profile.length <= 510, p.name);
	}
});

test('Phone tab exposes the TERMINAL PROFILE block and Configure dialog', () => {
	assert.ok(html.includes('id="tp-current"'));
	assert.match(html, /id="tp-send-btn"[^>]*data-needs="card"/);
	assert.match(html, /id="tp-configure-btn"[^>]*data-needs="server"/);
	assert.ok(html.includes('id="tp-modal"'));
	assert.ok(html.includes('id="tp-preset"'));
	assert.ok(html.includes('id="tp-hex"'));
	assert.ok(html.includes('id="tp-form"'));
	assert.ok(html.includes('id="tp-apply-btn"'));
});
