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

// Extract chain builder functions and dependencies
const FNS = ['berLenStr', 'buildApdu', 'escHtml', 'chainInit', 'chainRamBuildRowHex'];
let code = '';
for (const f of FNS) {
	code += extractFunc(html, f) + '\n';
}
const m = html.match(/const _chains = \{\};/);
if (m) code += m[0].replace(/^const /, 'var ') + '\n';
eval(code);

const els = {};
const doc = { getElementById: (id) => { if (!els[id]) els[id] = {value:''}; return els[id]; } };
global.document = doc;

function reset() { for (const id of Object.keys(els)) delete els[id]; }

function genRamResult(fields) {
	const row = { cmd: fields.cmd, fields: fields };
	return chainRamBuildRowHex(0, row);
}

function genRamApdu() {
	return genRamResult({
		cmd: 'install-install',
		aid: 'A000000151000000',
		elfAid: '',
		modAid: '',
		priv: '00',
		tkEnabled: true,
		tkMode: 'ea',
		tkPriority: '0',
		tkTimers: '0',
		tkTextlen: '0',
		tkMenus: '2',
		tkFirstpos: '1',
		tkFirstid: '01',
		tkLastpos: '2',
		tkLastid: '02',
		tkChannels: '0',
		tkMsl: '16',
		tkTar: 'B00001',
		tkAd: '',
		tkServices: '0',
	});
}

test('UICC toolkit nested inside EA (m=2, services 0)', () => {
	const apdu = genRamApdu();
	assert.ok(apdu.includes('EA13801100000002010102020002011603B0000100'), apdu);
});

test('UICC m=1 emits single pair', () => {
	const apdu = genRamResult({
		cmd: 'install-install', aid: 'A000000151000000', priv: '00',
		tkEnabled: true, tkMode: 'ea', tkPriority: '0', tkTimers: '0', tkTextlen: '0',
		tkMenus: '1', tkFirstpos: '1', tkFirstid: '01', tkLastpos: '0', tkLastid: '00',
		tkChannels: '0', tkMsl: '16', tkTar: 'B00001', tkAd: '', tkServices: '0',
	});
	assert.ok(apdu.includes('EA11800F0000000101010002011603B0000100'), apdu);
});

test('UICC m=3 fills middle pair with 0000', () => {
	const apdu = genRamResult({
		cmd: 'install-install', aid: 'A000000151000000', priv: '00',
		tkEnabled: true, tkMode: 'ea', tkPriority: '0', tkTimers: '0', tkTextlen: '0',
		tkMenus: '3', tkFirstpos: '1', tkFirstid: '01', tkLastpos: '3', tkLastid: '03',
		tkChannels: '0', tkMsl: '16', tkTar: 'B00001', tkAd: '', tkServices: '0',
	});
	assert.ok(apdu.includes('EA158013000000030101000003030002011603B0000100'), apdu);
});

test('UICC services 7 appended as final byte', () => {
	const apdu = genRamResult({
		cmd: 'install-install', aid: 'A000000151000000', priv: '00',
		tkEnabled: true, tkMode: 'ea', tkPriority: '0', tkTimers: '0', tkTextlen: '0',
		tkMenus: '2', tkFirstpos: '1', tkFirstid: '01', tkLastpos: '2', tkLastid: '02',
		tkChannels: '0', tkMsl: '16', tkTar: 'B00001', tkAd: '', tkServices: '7',
	});
	assert.ok(apdu.includes('EA13801100000002010102020002011603B0000107'), apdu);
});

test('SIM (CA) access domain FIRST, no services byte', () => {
	const apdu = genRamResult({
		cmd: 'install-install', aid: 'A000000151000000', priv: '00',
		tkEnabled: true, tkMode: 'ca', tkPriority: '0', tkTimers: '0', tkTextlen: '0',
		tkMenus: '2', tkFirstpos: '1', tkFirstid: '01', tkLastpos: '2', tkLastid: '02',
		tkChannels: '0', tkMsl: '16', tkTar: 'B00001', tkAd: '5A', tkServices: '0',
	});
	assert.ok(apdu.includes('EF14CA12015A00000002010102020002011603B00001'), apdu);
});

test('SIM (CA) blank access domain emits length byte 00', () => {
	const apdu = genRamResult({
		cmd: 'install-install', aid: 'A000000151000000', priv: '00',
		tkEnabled: true, tkMode: 'ca', tkPriority: '0', tkTimers: '0', tkTextlen: '0',
		tkMenus: '2', tkFirstpos: '1', tkFirstid: '01', tkLastpos: '2', tkLastid: '02',
		tkChannels: '0', tkMsl: '16', tkTar: 'B00001', tkAd: '', tkServices: '0',
	});
	assert.ok(apdu.includes('EF13CA110000000002010102020002011603B00001'), apdu);
});

test('SIM (CA) m=3, no TAR, blank access domain', () => {
	const apdu = genRamResult({
		cmd: 'install-install', aid: 'A000000151000000', priv: '00',
		tkEnabled: true, tkMode: 'ca', tkPriority: '0', tkTimers: '0', tkTextlen: '0',
		tkMenus: '3', tkFirstpos: '1', tkFirstid: '01', tkLastpos: '3', tkLastid: '03',
		tkChannels: '0', tkMsl: '16', tkTar: '', tkAd: '', tkServices: '0',
	});
	assert.ok(apdu.includes('EF12CA1000000000030101000003030002011600'), apdu);
});

test('UICC m=60 uses long-form BER lengths (EA 81 87 / inner 81 84)', () => {
	const apdu = genRamResult({
		cmd: 'install-install', aid: 'A000000151000000', priv: '00',
		tkEnabled: true, tkMode: 'ea', tkPriority: '0', tkTimers: '0', tkTextlen: '0',
		tkMenus: '60', tkFirstpos: '1', tkFirstid: '01', tkLastpos: '60', tkLastid: '3C',
		tkChannels: '0', tkMsl: '16', tkTar: 'B00001', tkAd: '', tkServices: '0',
	});
	assert.ok(apdu.includes('EA8188808185'), apdu);
});

test('LOAD P1 fixed to 80 (last block)', () => {
	const apdu = genRamResult({ cmd: 'load', data: 'AABBCC', block: '0' });
	assert.ok(apdu.startsWith('80E88000'), apdu);
});

test('DELETE: P1=00, mode in P2', () => {
	let apdu = genRamResult({ cmd: 'delete', aid: 'AA1902BC225501', delMode: '00' });
	assert.ok(apdu.startsWith('80E40000'), apdu);

	apdu = genRamResult({ cmd: 'delete', aid: 'AA1902BC225501', delMode: '80' });
	assert.ok(apdu.startsWith('80E40080'), apdu);
});

test('STORE DATA ram-enc P1 values 00/40/80/C0/E0', () => {
	for (const [enc, p1] of [['00','00'],['40','40'],['80','80'],['C0','C0'],['E0','E0']]) {
		const apdu = genRamResult({ cmd: 'store-data', data: 'AABB', enc: enc, block: '0' });
		assert.ok(apdu.startsWith('80E2' + p1 + '00'), enc + ' -> P1 ' + p1);
	}
});
