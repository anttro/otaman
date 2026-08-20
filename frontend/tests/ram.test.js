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
	}
}

const els = {};
function el(id, value = '') {
	if (!els[id]) els[id] = new StubEl(value);
	return els[id];
}

function reset() {
	for (const id of Object.keys(els)) delete els[id];
}

const FNS = ['berLenStr', 'buildApdu', 'genRam'];
let code = '';
for (const f of FNS) code += extractFunc(html, f) + '\n';
eval(code);

// document.getElementById stub: global getElementById in the extracted functions
const doc = {
	getElementById: (id) => {
		if (!els[id]) els[id] = new StubEl();
		return els[id];
	},
};
// genRam also references document.getElementById via global document
global.document = doc;

function set(id, v) { el(id).value = v; }
function setChecked(id, v) { el(id).checked = v; }

function genRamResult() {
	genRam();
	return els['ram-result'].value;
}

function genRamApdu() {
	reset();
	set('ram-cmd', 'install-install');
	set('ram-aid', 'A000000151000000');
	set('ram-priv', '00');
	setChecked('ram-toolkit-enable', true);
	set('ram-tk-mode', 'ea');
	set('ram-tk-priority', '0');
	set('ram-tk-timers', '0');
	set('ram-tk-textlen', '0');
	set('ram-tk-menus', '2');
	set('ram-tk-firstpos', '1');
	set('ram-tk-firstid', '01');
	set('ram-tk-lastpos', '2');
	set('ram-tk-lastid', '02');
	set('ram-tk-channels', '0');
	set('ram-tk-msl', '16');
	set('ram-tk-tar', 'B00001');
	set('ram-tk-ad', '');
	set('ram-tk-services', '0');
	return genRamResult();
}

test('UICC toolkit nested inside EA (m=2, services 0)', () => {
	const apdu = genRamApdu();
	assert.ok(apdu.includes('EA128010000000020101020200011603B0000100'), apdu);
});

test('UICC m=1 emits single pair', () => {
	reset();
	set('ram-cmd', 'install-install');
	set('ram-aid', 'A000000151000000');
	set('ram-priv', '00');
	setChecked('ram-toolkit-enable', true);
	set('ram-tk-mode', 'ea');
	set('ram-tk-priority', '0');
	set('ram-tk-timers', '0');
	set('ram-tk-textlen', '0');
	set('ram-tk-menus', '1');
	set('ram-tk-firstpos', '1');
	set('ram-tk-firstid', '01');
	set('ram-tk-lastpos', '0');
	set('ram-tk-lastid', '00');
	set('ram-tk-channels', '0');
	set('ram-tk-msl', '16');
	set('ram-tk-tar', 'B00001');
	set('ram-tk-ad', '');
	set('ram-tk-services', '0');
	const apdu = genRamResult();
	assert.ok(apdu.includes('EA10800E00000001010100011603B0000100'), apdu);
});

test('UICC m=3 fills middle pair with 0000', () => {
	reset();
	set('ram-cmd', 'install-install');
	set('ram-aid', 'A000000151000000');
	set('ram-priv', '00');
	setChecked('ram-toolkit-enable', true);
	set('ram-tk-mode', 'ea');
	set('ram-tk-priority', '0');
	set('ram-tk-timers', '0');
	set('ram-tk-textlen', '0');
	set('ram-tk-menus', '3');
	set('ram-tk-firstpos', '1');
	set('ram-tk-firstid', '01');
	set('ram-tk-lastpos', '3');
	set('ram-tk-lastid', '03');
	set('ram-tk-channels', '0');
	set('ram-tk-msl', '16');
	set('ram-tk-tar', 'B00001');
	set('ram-tk-ad', '');
	set('ram-tk-services', '0');
	const apdu = genRamResult();
	assert.ok(apdu.includes('EA1480120000000301010000030300011603B0000100'), apdu);
});

test('UICC services 7 appended as final byte', () => {
	reset();
	set('ram-cmd', 'install-install');
	set('ram-aid', 'A000000151000000');
	set('ram-priv', '00');
	setChecked('ram-toolkit-enable', true);
	set('ram-tk-mode', 'ea');
	set('ram-tk-priority', '0');
	set('ram-tk-timers', '0');
	set('ram-tk-textlen', '0');
	set('ram-tk-menus', '2');
	set('ram-tk-firstpos', '1');
	set('ram-tk-firstid', '01');
	set('ram-tk-lastpos', '2');
	set('ram-tk-lastid', '02');
	set('ram-tk-channels', '0');
	set('ram-tk-msl', '16');
	set('ram-tk-tar', 'B00001');
	set('ram-tk-ad', '');
	set('ram-tk-services', '7');
	const apdu = genRamResult();
	assert.ok(apdu.includes('EA128010000000020101020200011603B0000107'), apdu);
});

test('SIM (CA) access domain FIRST, no services byte', () => {
	reset();
	set('ram-cmd', 'install-install');
	set('ram-aid', 'A000000151000000');
	set('ram-priv', '00');
	setChecked('ram-toolkit-enable', true);
	set('ram-tk-mode', 'ca');
	set('ram-tk-priority', '0');
	set('ram-tk-timers', '0');
	set('ram-tk-textlen', '0');
	set('ram-tk-menus', '2');
	set('ram-tk-firstpos', '1');
	set('ram-tk-firstid', '01');
	set('ram-tk-lastpos', '2');
	set('ram-tk-lastid', '02');
	set('ram-tk-channels', '0');
	set('ram-tk-msl', '16');
	set('ram-tk-tar', 'B00001');
	set('ram-tk-ad', '5A');
	set('ram-tk-services', '0');
	const apdu = genRamResult();
	assert.ok(apdu.includes('CA11015A000000020101020200011603B00001'), apdu);
});

test('SIM (CA) blank access domain emits length byte 00', () => {
	reset();
	set('ram-cmd', 'install-install');
	set('ram-aid', 'A000000151000000');
	set('ram-priv', '00');
	setChecked('ram-toolkit-enable', true);
	set('ram-tk-mode', 'ca');
	set('ram-tk-priority', '0');
	set('ram-tk-timers', '0');
	set('ram-tk-textlen', '0');
	set('ram-tk-menus', '2');
	set('ram-tk-firstpos', '1');
	set('ram-tk-firstid', '01');
	set('ram-tk-lastpos', '2');
	set('ram-tk-lastid', '02');
	set('ram-tk-channels', '0');
	set('ram-tk-msl', '16');
	set('ram-tk-tar', 'B00001');
	set('ram-tk-ad', '');
	set('ram-tk-services', '0');
	const apdu = genRamResult();
	assert.ok(apdu.includes('CA1000000000020101020200011603B00001'), apdu);
});

test('SIM (CA) m=3, no TAR, blank access domain', () => {
	reset();
	set('ram-cmd', 'install-install');
	set('ram-aid', 'A000000151000000');
	set('ram-priv', '00');
	setChecked('ram-toolkit-enable', true);
	set('ram-tk-mode', 'ca');
	set('ram-tk-priority', '0');
	set('ram-tk-timers', '0');
	set('ram-tk-textlen', '0');
	set('ram-tk-menus', '3');
	set('ram-tk-firstpos', '1');
	set('ram-tk-firstid', '01');
	set('ram-tk-lastpos', '3');
	set('ram-tk-lastid', '03');
	set('ram-tk-channels', '0');
	set('ram-tk-msl', '16');
	set('ram-tk-tar', '');
	set('ram-tk-ad', '');
	set('ram-tk-services', '0');
	const apdu = genRamResult();
	assert.ok(apdu.includes('CA0F000000000301010000030300011600'), apdu);
});

test('UICC m=60 uses long-form BER lengths (EA 81 87 / inner 81 84)', () => {
	reset();
	set('ram-cmd', 'install-install');
	set('ram-aid', 'A000000151000000');
	set('ram-priv', '00');
	setChecked('ram-toolkit-enable', true);
	set('ram-tk-mode', 'ea');
	set('ram-tk-priority', '0');
	set('ram-tk-timers', '0');
	set('ram-tk-textlen', '0');
	set('ram-tk-menus', '60');
	set('ram-tk-firstpos', '1');
	set('ram-tk-firstid', '01');
	set('ram-tk-lastpos', '60');
	set('ram-tk-lastid', '3C');
	set('ram-tk-channels', '0');
	set('ram-tk-msl', '16');
	set('ram-tk-tar', 'B00001');
	set('ram-tk-ad', '');
	set('ram-tk-services', '0');
	const apdu = genRamResult();
	assert.ok(apdu.includes('EA8187808184'), apdu);
});

test('LOAD P1 fixed to 80 (last block)', () => {
	reset();
	set('ram-cmd', 'load');
	set('ram-data', 'AABBCC');
	set('ram-block', '0');
	const apdu = genRamResult();
	assert.ok(apdu.startsWith('80E88000'), apdu);
});

test('DELETE: P1=00, mode in P2', () => {
	reset();
	set('ram-cmd', 'delete');
	set('ram-aid', 'AA1902BC225501');
	set('ram-del-mode', '00');
	let apdu = genRamResult();
	assert.ok(apdu.startsWith('80E40000'), apdu);

	set('ram-del-mode', '80');
	apdu = genRamResult();
	assert.ok(apdu.startsWith('80E40080'), apdu);
});

test('STORE DATA ram-enc P1 values 00/40/80/C0/E0', () => {
	for (const [enc, p1] of [['00','00'],['40','40'],['80','80'],['C0','C0'],['E0','E0']]) {
		reset();
		set('ram-cmd', 'store-data');
		set('ram-data', 'AABB');
		set('ram-enc', enc);
		set('ram-block', '0');
		const apdu = genRamResult();
		assert.ok(apdu.startsWith('80E2' + p1 + '00'), enc + ' -> P1 ' + p1);
	}
});