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

class StubEl {
	constructor(value = '') {
		this.value = value;
		this.checked = false;
		this.style = {};
		this.disabled = false;
	}
}

const els = {};
const doc = {
	getElementById: (id) => {
		if (!els[id]) els[id] = new StubEl();
		return els[id];
	},
	querySelector: () => new StubEl(),
};
global.document = doc;

const FNS = ['buildApdu', 'buildOpNoCla', 'buildSelect', 'getSelValue', 'buildSelectApdu',
	'updateSimUsimFields', 'updateP1P2Display', 'genSimUsim', 'OPS'];
let code = '';
for (const f of FNS) {
	if (f === 'OPS') {
		const m = html.match(/const OPS = \{[\s\S]*?\n\};/);
		code += m[0].replace(/^const /, 'var ') + '\n';
	} else {
		code += extractFunc(html, f) + '\n';
	}
}
code += '\nvar SIM_PRESETS = {};';
eval(code);

function set(id, v) { els[id] = Object.assign(new StubEl(), { value: v }); }
function setChecked(id, v) { els[id] = Object.assign(new StubEl(), { checked: v }); }

function setup(mode, opts) {
	for (const k of Object.keys(els)) delete els[k];
	set(mode + '-cmd', opts.cmd);
	setChecked(mode + '-select', !!opts.doSelect);
	set(mode + '-sel-method', opts.selMethod || 'fid');
	set(mode + '-sel-fid', opts.fid || '');
	set(mode + '-sel-path', opts.path || '');
	set(mode + '-sel-dfname', opts.dfname || '');
	set(mode + '-sel-chain', opts.chain || '');
	set(mode + '-record', opts.record || '1');
	set(mode + '-rec-mode', opts.recMode || '04');
	set(mode + '-offset', opts.offset || '0000');
	set(mode + '-le', opts.le || '00');
	set(mode + '-data', opts.data || '');
	set(mode + '-recsize', opts.recsize || '0');
	set(mode + '-pin', opts.pin || '01');
	set(mode + '-pin-val', opts.pinVal || '');
	set(mode + '-pin-old', opts.pinOld || '');
	set(mode + '-pin-new', opts.pinNew || '');
	set(mode + '-act-target', opts.actTarget || 'current');
	set(mode + '-act-file', opts.actFile || '');
	set(mode + '-override', '');
	els[mode + '-result'] = new StubEl();
	els[mode + '-pack-btn'] = new StubEl();
	genSimUsim(mode);
	return els[mode + '-result'].value;
}

test('VERIFY PIN FF-pads to 8 bytes (Lc=08)', () => {
	const apdu = setup('usim', { cmd: 'verify', pin: '01', pinVal: '1234' });
	assert.strictEqual(apdu, '002000010831323334FFFFFFFF');
});

test('CHANGE PIN emits two 8-byte fields (Lc=10)', () => {
	const apdu = setup('usim', { cmd: 'change', pin: '01', pinOld: '1234', pinNew: '5678' });
	assert.strictEqual(apdu, '002400011031323334FFFFFFFF35363738FFFFFFFF');
});

test('DISABLE PIN single padded PIN (INS 26)', () => {
	const apdu = setup('usim', { cmd: 'disable', pin: '02', pinVal: '9999' });
	assert.strictEqual(apdu, '002600020839393939FFFFFFFF');
});

test('ENABLE PIN single padded PIN (INS 28)', () => {
	const apdu = setup('usim', { cmd: 'enable', pin: '01', pinVal: '1111' });
	assert.strictEqual(apdu, '002800010831313131FFFFFFFF');
});

test('UNBLOCK PIN two padded PINs (INS 2C)', () => {
	const apdu = setup('usim', { cmd: 'unblock', pin: '02', pinOld: '12345678', pinNew: '4321' });
	assert.strictEqual(apdu, '002C000210313233343536373834333231FFFFFFFF');
});

test('ACTIVATE FILE case-1 (no data, no Le)', () => {
	const apdu = setup('usim', { cmd: 'activate-file' });
	assert.strictEqual(apdu, '00440000');
});

test('DEACTIVATE FILE case-1', () => {
	const apdu = setup('sim', { cmd: 'deactivate-file' });
	assert.strictEqual(apdu, 'A0040000');
});

test('ACTIVATE FILE by FID (P1=00 + Lc/FID)', () => {
	const apdu = setup('usim', { cmd: 'activate-file', actTarget: 'fid', actFile: '6F3B' });
	assert.strictEqual(apdu, '00440000026F3B');
});

test('ACTIVATE FILE by path from MF (P1=08)', () => {
	const apdu = setup('usim', { cmd: 'activate-file', actTarget: 'mfpath', actFile: '7FFF6FC5' });
	assert.strictEqual(apdu, '00440800047FFF6FC5');
});

test('DEACTIVATE FILE by path from current DF (P1=09, SIM CLA)', () => {
	const apdu = setup('sim', { cmd: 'deactivate-file', actTarget: 'dfpath', actFile: '6F3B' });
	assert.strictEqual(apdu, 'A0040900026F3B');
});

test('READ RECORD next mode forces P1=00', () => {
	const apdu = setup('usim', { cmd: 'read-record', recMode: '02', le: '20' });
	assert.strictEqual(apdu, '00B2000220');
});

test('SELECT by FID USIM: P2=0C, no Le', () => {
	const apdu = setup('usim', { cmd: 'select', selMethod: 'fid', fid: '6FC5' });
	assert.strictEqual(apdu, '00A4000C026FC5');
});

test('SELECT by path USIM: P2=04, Le=00', () => {
	const apdu = setup('usim', { cmd: 'select', selMethod: 'path', path: '7FFF6FC5' });
	assert.strictEqual(apdu, '00A40804047FFF6FC500');
});

test('SELECT by FID SIM (CLA A0): no Le anywhere', () => {
	const apdu = setup('sim', { cmd: 'select', selMethod: 'fid', fid: '6FC5' });
	assert.strictEqual(apdu, 'A0A40000026FC5');
});
