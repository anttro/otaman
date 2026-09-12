const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunc(src, name) {
	const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
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

let code = 'var pysimFsTreeRoot = null;\nvar _pysimFsProbe = null;\nvar pysimFsSort = "fid";\n';
for (const fn of ['getParentSel', 'pysimFsSortChildren', 'pysimFsLoadChildren', 'pysimFsSelectBody', 'pysimFsProbeUi', 'pysimFsProbeAll']) {
	code += extractFunc(html, fn) + '\n';
}
code += 'globalThis.esc = s => s;\nglobalThis.t = s => s;\nglobalThis.pysimCustomInject = () => {};\n';
eval(code);

function fakeEl() {
	const classes = new Set();
	return {
		textContent: '',
		attrs: {},
		classList: {
			add: (...cs) => cs.forEach(c => classes.add(c)),
			remove: (...cs) => cs.forEach(c => classes.delete(c)),
			contains: c => classes.has(c),
			toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
		},
		setAttribute(k, v) { this.attrs[k] = v; },
	};
}

let els = {};
let calls = [];

function setup(routes) {
	els = { 'pysim-fs-probe-status': fakeEl(), 'pysim-fs-probe-btn': fakeEl() };
	calls = [];
	globalThis.document = { getElementById: id => els[id] || null };
	globalThis.pysimFetch = async (p, body) => {
		calls.push({ path: p, body: body || {} });
		for (const r of routes) {
			if (r.path !== p) continue;
			if (r.name && (!body || body.name !== r.name)) continue;
			return typeof r.reply === 'function' ? r.reply(body, calls) : JSON.parse(JSON.stringify(r.reply));
		}
		throw new Error('unexpected fetch ' + p + ' ' + JSON.stringify(body));
	};
	globalThis.pysimFsRenderTree = () => {};
}

function root(children) {
	pysimFsTreeRoot = { name: 'MF', fid: '3f00', isDir: true, expanded: true, exists: true, children: null, parent: null };
	pysimFsTreeRoot.children = children.map(c => Object.assign({ children: null, expanded: false, exists: true, parent: pysimFsTreeRoot }, c));
	return pysimFsTreeRoot;
}

const df = (name, fid) => ({ name, fid, isDir: true });
const ef = (name, fid) => ({ name, fid, isDir: false });
const selectNames = () => calls.filter(c => c.path === '/api/select').map(c => c.body.name);

test('probes dirs and files, including custom entries, and reports counts', async () => {
	root([df('DF.A', '5f01'), ef('EF.ROOT', '2f01'), Object.assign(ef('EF.CUSTOM', '6fcc'), { custom: true })]);
	let sawStop = null;
	setup([
		{ path: '/api/tree', name: 'DF.A', reply: { exists: true, children: [{ name: 'EF.1', fid: '6f01', isDir: false }] } },
		{ path: '/api/select', name: 'EF.1', reply: () => { sawStop = els['pysim-fs-probe-btn'].textContent; return { exists: true }; } },
		{ path: '/api/select', name: 'EF.ROOT', reply: { error: 'SW 6a82', exists: false } },
		{ path: '/api/select', name: 'EF.CUSTOM', reply: { exists: true } },
	]);
	await pysimFsProbeAll();
	assert.strictEqual(sawStop, 'Stop');
	assert.deepStrictEqual(selectNames(), ['EF.1', 'EF.ROOT', 'EF.CUSTOM']);
	assert.strictEqual(pysimFsTreeRoot.children[0].children[0].exists, true);
	assert.strictEqual(pysimFsTreeRoot.children[1].exists, false);
	assert.strictEqual(pysimFsTreeRoot.children[2].exists, true);
	const status = els['pysim-fs-probe-status'].textContent;
	assert.match(status, /4\/4 files/);
	assert.match(status, /3 present/);
	assert.match(status, /1 absent/);
	assert.strictEqual(els['pysim-fs-probe-btn'].textContent, 'Probe all files');
	assert.strictEqual(els['pysim-fs-probe-btn'].attrs['data-l10n'], 'Probe all files');
});

test('an absent directory is marked and its subtree is never fetched', async () => {
	root([df('DF.B', '5f02'), ef('EF.ROOT', '2f01')]);
	setup([
		{ path: '/api/tree', name: 'DF.B', reply: { success: false, error: 'SW 6a82', exists: false } },
		{ path: '/api/select', name: 'EF.ROOT', reply: { error: 'SW 6a82', exists: false } },
	]);
	await pysimFsProbeAll();
	assert.strictEqual(pysimFsTreeRoot.children[0].exists, false);
	assert.deepStrictEqual(selectNames(), ['EF.ROOT']);
	assert.strictEqual(calls.filter(c => c.path === '/api/tree' && c.body.name === 'DF.B').length, 2);
	const status = els['pysim-fs-probe-status'].textContent;
	assert.match(status, /2\/2 files/);
	assert.match(status, /0 present/);
	assert.match(status, /2 absent/);
});

test('stop halts the walk and still reports a summary', async () => {
	root([ef('EF.X', '6f01'), ef('EF.Y', '6f02')]);
	setup([
		{ path: '/api/select', name: 'EF.X', reply: () => { _pysimFsProbe.stop = true; return { exists: true }; } },
	]);
	await pysimFsProbeAll();
	assert.deepStrictEqual(selectNames(), ['EF.X']);
	const status = els['pysim-fs-probe-status'].textContent;
	assert.ok(status.startsWith('Stopped —'), status);
	assert.strictEqual(els['pysim-fs-probe-btn'].textContent, 'Probe all files');
});
