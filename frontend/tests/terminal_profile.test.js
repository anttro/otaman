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
for (const f of ['tpNorm', 'tpValid', 'tpGetBit', 'tpSetBit', 'tpBitLabel', 'tpLayoutGroups',
	'tpValueFieldFor', 'tpValueWidth', 'tpGetValue', 'tpSetValue']) {
	code += extractFunc(html, f) + '\n';
}
code += html.match(/const TP_BITS = \[[\s\S]*?\n\];/)[0].replace('const ', 'var ') + '\n';
code += html.match(/const TP_LAYOUT = \[[\s\S]*?\n\];/)[0].replace('const ', 'var ') + '\n';
code += html.match(/const TP_PRESETS = \[[\s\S]*?\n\];/)[0].replace('const ', 'var ') + '\n';
code += html.match(/const TP_VALUE_FIELDS = \[[\s\S]*?\n\];/)[0].replace('const ', 'var ') + '\n';
eval(code);

test('tpNorm / tpValid normalize and validate profile hex', () => {
	assert.strictEqual(tpNorm(' ff ee 00 '), 'FFEE00');
	assert.strictEqual(tpNorm('zz'), '');
	assert.ok(tpValid('FF'));
	assert.ok(tpValid('00FF'));
	assert.ok(!tpValid(''));
	assert.ok(!tpValid('F'));
});

test('tpGetBit / tpSetBit address bits LSB-first (spec b1..b8 order)', () => {
	// TS 102 223 5.2 tables list b1 (LSB) first: index 0 = byte 1 b1 = 0x01
	const hex = '01' + '80';       // byte 1 b1 set, byte 2 b8 set
	assert.strictEqual(tpGetBit(hex, 0), true);    // byte 1 b1
	assert.strictEqual(tpGetBit(hex, 7), false);   // byte 1 b8
	assert.strictEqual(tpGetBit(hex, 8), false);   // byte 2 b1
	assert.strictEqual(tpGetBit(hex, 15), true);   // byte 2 b8
	assert.strictEqual(tpGetBit(hex, 16), null);   // beyond the profile
	// toggling keeps the other bits untouched
	assert.strictEqual(tpSetBit('00', 0, true), '01');
	assert.strictEqual(tpSetBit('01', 0, false), '00');
	assert.strictEqual(tpSetBit('FF', 7, false), '7F');
	// a bit beyond the current length grows the profile with zero bytes
	assert.strictEqual(tpSetBit('FF', 24, true), 'FF000001');
	// the project default really is BIP-capable under this mapping
	const mi = 'FFFFFFFF7F9F00DFFF03021FE2000000C3FB000704117800710100000038428003';
	assert.strictEqual(tpGetBit(mi, 88), true);    // byte 12 b1 = OPEN CHANNEL
	assert.strictEqual(tpGetBit(mi, 91), true);    // byte 12 b4 = SEND DATA
	assert.strictEqual(tpGetBit(mi, 134), true);   // byte 17 b7 = E-UTRAN
	assert.strictEqual(tpGetBit(mi, 135), true);   // byte 17 b8 = HSDPA
});

test('TERMINAL PROFILE bit table matches the spec spot checks', () => {
	assert.ok(TP_BITS.length >= 312, 'expected the full byte 1..39 table');
	assert.strictEqual(TP_BITS.length % 8, 0);
	assert.strictEqual(TP_BITS[0], 'Profile download');                       // byte 1 b1
	assert.strictEqual(TP_BITS[16], 'Proactive UICC: DISPLAY TEXT');          // byte 3 b1
	assert.strictEqual(TP_BITS[32], 'Proactive UICC: SET UP EVENT LIST');     // byte 5 b1
	assert.strictEqual(TP_BITS[42], 'Event: Data available');                 // byte 6 b3
	assert.strictEqual(TP_BITS[50], 'Proactive UICC: PERFORM CARD APDU');     // byte 7 b3 (pySim said RESET)
	assert.strictEqual(TP_BITS[88], 'Proactive UICC: OPEN CHANNEL');          // byte 12 b1
	assert.strictEqual(TP_BITS[140], 'Proactive UICC: PROVIDE LOCAL INFORMATION (ESN)');   // byte 18 b5
	assert.strictEqual(TP_BITS[181], 'Proactive UICC: PROVIDE LOCAL INFORMATION (MEID)');  // byte 23 b6
	assert.strictEqual(TP_BITS[260], 'Proactive UICC: PROVIDE LOCAL INFORMATION (Supported Radio Access Technologies)');  // byte 33 b5
	assert.strictEqual(TP_BITS[280], 'Data Connection Status Change Event support – PDU Connection'); // byte 36 b1
	assert.strictEqual(tpBitLabel(0), 'Profile download');
	assert.match(tpBitLabel(400), /^RFU \(byte 51 b1\)/);                     // beyond the table
});

test('value-field rows carry the spec labels (soft keys, channels, screen, ND/NK, frames)', () => {
	const byteLabels = b => TP_BITS.slice((b - 1) * 8, b * 8);
	// byte 11: soft keys value (0xFF reserved)
	assert.match(byteLabels(11)[0], /Maximum number of soft keys/);
	assert.match(byteLabels(11)[0], /FF reserved/);
	assert.strictEqual(byteLabels(11)[7], byteLabels(11)[0]);
	// byte 13 b6..b8: BIP channel count
	assert.strictEqual(byteLabels(13)[5], 'Number of BIP channels supported (value b6..b8)');
	assert.strictEqual(byteLabels(13)[7], byteLabels(13)[5]);
	// byte 14: height b1..b5, ND b6, NK b7, sizing b8
	assert.match(byteLabels(14)[0], /Screen height/);
	assert.strictEqual(byteLabels(14)[5], 'No display capability (class ND)');
	assert.strictEqual(byteLabels(14)[6], 'No keypad available (class NK)');
	assert.strictEqual(byteLabels(14)[7], 'Screen Sizing Parameters supported');
	// byte 15: width b1..b7, variable fonts b8
	assert.match(byteLabels(15)[0], /Screen width/);
	assert.strictEqual(byteLabels(15)[7], 'Variable size fonts');
	// byte 16: four effect flags, RFU b5, width reduction b6..b8
	assert.strictEqual(byteLabels(16)[0], 'Display can be resized');
	assert.strictEqual(byteLabels(16)[1], 'Text Wrapping supported');
	assert.strictEqual(byteLabels(16)[2], 'Text Scrolling supported');
	assert.strictEqual(byteLabels(16)[3], 'Text Attributes supported');
	assert.strictEqual(byteLabels(16)[4], 'RFU');
	assert.match(byteLabels(16)[5], /Width reduction when in a menu/);
	// byte 19 b1..b4: TIA/EIA-136-270 protocol version
	assert.match(byteLabels(19)[0], /TIA\/EIA-136-270 protocol version/);
	assert.strictEqual(byteLabels(19)[3], byteLabels(19)[0]);
	// byte 24 b1..b4: max frames
	assert.match(byteLabels(24)[0], /Maximum number of frames supported/);
	assert.strictEqual(byteLabels(24)[3], byteLabels(24)[0]);
	// every value field matches the TP_VALUE_FIELDS table (no overlap with flags)
	for (const f of TP_VALUE_FIELDS) {
		for (let b = f.from; b <= f.to; b++) {
			assert.match(byteLabels(f.byte)[b - 1], /value|soft keys|Screen|Width|TIA|frames/i,
				'byte ' + f.byte + ' b' + b);
		}
	}
});

test('TP_VALUE_FIELDS decode little-endian bit ranges and round-trip', () => {
	const f = (byte, from, to) => ({ byte: byte, from: from, to: to });
	// byte 13 b6..b8: 0xE0 = 7 channels (project default)
	const mi = 'FFFFFFFF7F9F00DFFF03021FE2000000C3FB000704117800710100000038428003';
	const ch = tpValueFieldFor(13);
	assert.deepStrictEqual({ byte: ch.byte, from: ch.from, to: ch.to }, f(13, 6, 8));
	assert.strictEqual(tpValueWidth(ch), 3);
	assert.strictEqual(tpGetValue(mi, ch), 7);            // byte 13 = 0xE2
	assert.strictEqual(tpGetValue(mi, tpValueFieldFor(11)), 0x02);  // soft keys = 2
	assert.strictEqual(tpGetValue(mi, tpValueFieldFor(14)), 0x00);  // height
	assert.strictEqual(tpGetValue(mi, tpValueFieldFor(15)), 0x00);  // width
	assert.strictEqual(tpGetValue(mi, tpValueFieldFor(16)), 0x00);  // width reduction
	assert.strictEqual(tpGetValue(mi, tpValueFieldFor(19)), 0x00);
	assert.strictEqual(tpGetValue(mi, tpValueFieldFor(24)), 0x00);
	// soft keys 0xFE is the largest documented value (byte 11; 'FF' reserved)
	const sk = tpValueFieldFor(11);
	const blank11 = '00'.repeat(11);
	assert.strictEqual(tpGetValue(blank11, sk), 0x00);
	assert.strictEqual(tpGetValue(tpSetValue(blank11, sk, 0xFE), sk), 0xFE);
	assert.strictEqual(tpGetValue(tpSetValue(blank11, sk, 0xFF), sk), 0xFF);
	assert.strictEqual(tpGetValue('FE', sk), null);   // byte 11 missing from a short profile
	// set: byte 13 b6..b8 = 5 keeps the bearer bits, clamps to 3 bits
	const base13 = '00'.repeat(12) + 'E2';
	assert.strictEqual(tpSetValue(base13, ch, 5), '00'.repeat(12) + 'A2');  // 0xE2 & 0x1F | (5<<5)
	assert.strictEqual(tpSetValue(base13, ch, 8), base13);                  // clamped to 7
	assert.strictEqual(tpSetValue('00'.repeat(13), ch, 3), '00'.repeat(12) + '60');
	// a profile shorter than the field's byte grows with zero bytes (like tpSetBit)
	assert.strictEqual(tpSetValue('', ch, 3), '00'.repeat(12) + '60');
	// round-trip every field through get/set
	for (const vf of TP_VALUE_FIELDS) {
		const max = (1 << tpValueWidth(vf)) - 1;
		const lo = tpSetValue('0000000000000000000000000000000000000000000000000000000000000000', vf, 1);
		assert.strictEqual(tpGetValue(lo, vf), 1, 'field byte ' + vf.byte);
		const hi = tpSetValue(lo, vf, max);
		assert.strictEqual(tpGetValue(hi, vf), max, 'field byte ' + vf.byte);
		assert.strictEqual(tpSetValue(hi, vf, 0), '0000000000000000000000000000000000000000000000000000000000000000',
			'field byte ' + vf.byte + ' clears');
	}
	// out-of-range values clamp, garbage reads as 0
	assert.strictEqual(tpGetValue('', tpValueFieldFor(11)), null);   // byte missing
	assert.strictEqual(tpGetValue('FF', tpValueFieldFor(13)), null);
});

test('the Configure dialog renders number inputs for value fields', () => {
	const fn = extractFunc(html, 'tpRenderForm');
	assert.match(fn, /tpValueFieldFor\(bi \+ 1\)/);
	assert.match(fn, /type="number"/);
	assert.match(fn, /tpValueInput\(/);
	// the soft-keys hint stays visible in the UI
	assert.match(html, /FF' is reserved for future use/);
	const handler = extractFunc(html, 'tpValueInput');
	assert.match(handler, /tpSetValue/);
	assert.match(handler, /tpSyncPreset/);
});

test('3GPP-defined bits use the TS 31.111 names, not placeholders', () => {
	assert.ok(!TP_BITS.some(l => /reserved by 3gpp/i.test(l)), 'no "reserved by 3GPP" labels');
	assert.ok(!TP_BITS.some(l => /reserved by etsi/i.test(l)));
	// a few audited 3GPP bits (TS 31.111 5.2); byteLabels[0] is b1
	const byteLabels = b => TP_BITS.slice((b - 1) * 8, b * 8);
	assert.strictEqual(byteLabels(17)[6], 'E-UTRAN');                  // byte 17 b7
	assert.strictEqual(byteLabels(17)[7], 'HSDPA');                    // byte 17 b8
	assert.strictEqual(byteLabels(18)[5], 'CALL CONTROL on GPRS');     // byte 18 b6
	assert.strictEqual(byteLabels(25)[4], 'Event: Network Rejection for GERAN/UTRAN');   // byte 25 b5
	assert.strictEqual(byteLabels(32)[0], 'IMS support');              // byte 32 b1
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
