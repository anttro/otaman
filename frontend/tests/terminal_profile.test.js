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
for (const f of ['tpNorm', 'tpValid', 'tpGetBit', 'tpSetBit', 'tpBitLabel', 'tpLayoutGroups']) {
	code += extractFunc(html, f) + '\n';
}
code += html.match(/const TP_BITS = \[[\s\S]*?\n\];/)[0].replace('const ', 'var ') + '\n';
code += html.match(/const TP_LAYOUT = \[[\s\S]*?\n\];/)[0].replace('const ', 'var ') + '\n';
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

test('TERMINAL PROFILE bit table matches the spec spot checks', () => {
	assert.ok(TP_BITS.length >= 312, 'expected the full byte 1..39 table');
	assert.strictEqual(TP_BITS.length % 8, 0);
	assert.strictEqual(TP_BITS[0], 'Profile download');                       // byte 1 b8
	assert.strictEqual(TP_BITS[16], 'Proactive UICC: DISPLAY TEXT');          // byte 3 b8
	assert.strictEqual(TP_BITS[32], 'Proactive UICC: SET UP EVENT LIST');     // byte 5 b8
	assert.strictEqual(TP_BITS[42], 'Event: Data available');                 // byte 6 b3
	assert.strictEqual(TP_BITS[50], 'Proactive UICC: PERFORM CARD APDU');     // byte 7 b6 (pySim said RESET)
	assert.strictEqual(TP_BITS[88], 'Proactive UICC: OPEN CHANNEL');          // byte 12 b8
	assert.strictEqual(TP_BITS[140], 'Proactive UICC: PROVIDE LOCAL INFORMATION (ESN)');   // byte 18 b4
	assert.strictEqual(TP_BITS[181], 'Proactive UICC: PROVIDE LOCAL INFORMATION (MEID)');  // byte 23 b3
	assert.strictEqual(TP_BITS[260], 'Proactive UICC: PROVIDE LOCAL INFORMATION (Supported Radio Access Technologies)');
	assert.strictEqual(TP_BITS[280], 'Data Connection Status Change Event support – PDU Connection'); // byte 36 b8
	assert.strictEqual(tpBitLabel(0), 'Profile download');
	assert.match(tpBitLabel(400), /^RFU \(byte 51 b/);                        // beyond the table
});

test('3GPP-defined bits use the TS 31.111 names, not placeholders', () => {
	assert.ok(!TP_BITS.some(l => /reserved by 3gpp/i.test(l)), 'no "reserved by 3GPP" labels');
	assert.ok(!TP_BITS.some(l => /reserved by etsi/i.test(l)));
	// a few audited 3GPP bits (TS 31.111 5.2)
	const byteLabels = b => TP_BITS.slice((b - 1) * 8, b * 8);
	assert.strictEqual(byteLabels(17)[6], 'E-UTRAN');                  // byte 17 b2
	assert.strictEqual(byteLabels(17)[7], 'HSDPA');                    // byte 17 b1
	assert.strictEqual(byteLabels(18)[5], 'CALL CONTROL on GPRS');     // byte 18 b3
	assert.strictEqual(byteLabels(25)[4], 'Event: Network Rejection for GERAN/UTRAN');
	assert.strictEqual(byteLabels(32)[0], 'IMS support');              // byte 32 b8
	assert.strictEqual(byteLabels(34)[0], 'URI support for SEND SHORT MESSAGE');
	assert.match(byteLabels(39)[0], /NG-RAN\/Satellite NG-RAN Timing Advance/);
});

test('TERMINAL PROFILE presets are valid even-length hex', () => {
	assert.ok(TP_PRESETS.length >= 9);
	// the project default stays first (it matches the CLI default profile)
	assert.match(TP_PRESETS[0].name, /Xiaomi Mi A1/);
	const names = TP_PRESETS.map(p => p.name);
	for (const model of ['Quectel GSM module', 'Samsung S21+ 5G', 'Samsung A55 5G',
		'Xiaomi Redmi Note 10 LTE', 'Sony Xperia Z5c LTE', 'Huawei E5573c / M150 (LTE)',
		'Huawei E173 3G modem', 'Nokia 7210 2G']) {
		assert.ok(names.some(n => n.includes(model)), model);
	}
	const seen = new Set();
	for (const p of TP_PRESETS) {
		assert.ok(p.name && p.profile, p.name);
		assert.ok(/^[0-9A-F]+$/.test(p.profile) && p.profile.length % 2 === 0, p.name);
		assert.ok(p.profile.length >= 8 && p.profile.length <= 510, p.name);
		assert.ok(!seen.has(p.profile), 'duplicate profile: ' + p.name);
		seen.add(p.profile);
	}
});

test('Phone tab exposes the TERMINAL PROFILE block and Configure dialog', () => {
	// the compact block has no room for the hex value: Send + Configure only
	assert.ok(!html.includes('id="tp-current"'));
	assert.match(html, /id="tp-send-btn"[^>]*data-needs="card"/);
	assert.match(html, /id="tp-configure-btn"[^>]*data-needs="server"/);
	assert.ok(html.includes('id="tp-modal"'));
	assert.ok(html.includes('id="tp-preset"'));
	assert.ok(html.includes('id="tp-hex"'));
	assert.ok(html.includes('id="tp-form"'));
	assert.ok(html.includes('id="tp-apply-btn"'));
	// the preset select sits above the hex field, not next to it
	assert.ok(html.indexOf('id="tp-preset"') < html.indexOf('id="tp-hex"'));
	// Apply/Cancel sit at the top (right of the preset/hex fields), above the
	// long bits grid, so they are reachable without scrolling
	assert.ok(html.indexOf('id="tp-apply-btn"') < html.indexOf('id="tp-form"'));
});

test('tpLayoutGroups lays the byte blocks out in the configured columns', () => {
	assert.deepStrictEqual(tpLayoutGroups(33), [
		{ from: 1, to: 12, cols: 2 },
		{ from: 13, to: 16, cols: 4 },
		{ from: 17, to: 18, cols: 2 },
		{ from: 19, to: 21, cols: 3 },
		{ from: 22, to: 25, cols: 2 },
		{ from: 26, to: 28, cols: 3 },
		{ from: 29, to: 30, cols: 2 },
		{ from: 31, to: 33, cols: 1 },
	]);
	// short profiles clamp: only existing bytes get a group
	assert.deepStrictEqual(tpLayoutGroups(8), [{ from: 1, to: 8, cols: 2 }]);
	assert.deepStrictEqual(tpLayoutGroups(18), [
		{ from: 1, to: 12, cols: 2 },
		{ from: 13, to: 16, cols: 4 },
		{ from: 17, to: 18, cols: 2 },
	]);
	// long profiles: everything past byte 30 is one per row
	assert.deepStrictEqual(tpLayoutGroups(40).slice(-1), [{ from: 31, to: 40, cols: 1 }]);
});
