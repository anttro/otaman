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

let code = 'var pysimCustomFiles = [];\nvar pysimCustomEditIndex = null;\n';
for (const fn of ['pysimCustomSave', 'pysimCustomSubmit', 'pysimCustomEdit', 'pysimCustomEditCancel', 'pysimCustomRemove', 'pysimCustomRender']) {
	code += extractFunc(html, fn) + '\n';
}
code += 'globalThis.esc = s => s;\nglobalThis.t = s => s;\n';
eval(code);

function fakeEl(id) {
	const classes = new Set();
	return {
		id,
		value: '',
		innerHTML: '',
		textContent: '',
		attrs: {},
		focused: 0,
		classList: {
			add: (...cs) => cs.forEach(c => classes.add(c)),
			remove: (...cs) => cs.forEach(c => classes.delete(c)),
			contains: c => classes.has(c),
		},
		setAttribute(k, v) { this.attrs[k] = v; },
		focus() { this.focused++; },
	};
}

function setup(entries) {
	const els = {
		'pysim-cf-path': fakeEl('pysim-cf-path'),
		'pysim-cf-name': fakeEl('pysim-cf-name'),
		'pysim-cf-list': fakeEl('pysim-cf-list'),
		'pysim-cf-add-btn': fakeEl('pysim-cf-add-btn'),
		'pysim-cf-cancel-btn': fakeEl('pysim-cf-cancel-btn'),
	};
	els['pysim-cf-cancel-btn'].classList.add('hidden');
	const store = {};
	globalThis.localStorage = {
		getItem: k => (k in store ? store[k] : null),
		setItem: (k, v) => { store[k] = String(v); },
	};
	globalThis.document = { getElementById: id => els[id] || null };
	globalThis.alertCalls = [];
	globalThis.alert = m => { globalThis.alertCalls.push(m); };
	pysimCustomFiles = (entries || []).map(e => Object.assign({}, e));
	pysimCustomEditIndex = null;
	return els;
}

const entry = (fid, name, parentFid) => ({ path: (parentFid || '3F00') + '/' + fid, name, fid, parentFid: parentFid || '3F00' });

test('rows render Edit and Delete buttons instead of the X glyph', () => {
	const els = setup([entry('6F46', 'EF.SPN')]);
	pysimCustomRender();
	const out = els['pysim-cf-list'].innerHTML;
	assert.match(out, /pysimCustomEdit\(0\)/);
	assert.match(out, /pysimCustomRemove\(0\)/);
	assert.match(out, />Edit</);
	assert.match(out, />Delete</);
	assert.ok(!out.includes('✕'), 'old X glyph must be gone');
});

test('edit fills the top form and switches it to Save mode', () => {
	const els = setup([entry('6F46', 'EF.SPN')]);
	pysimCustomEdit(0);
	assert.strictEqual(pysimCustomEditIndex, 0);
	assert.strictEqual(els['pysim-cf-path'].value, '3F00/6F46');
	assert.strictEqual(els['pysim-cf-name'].value, 'EF.SPN');
	assert.strictEqual(els['pysim-cf-add-btn'].textContent, 'Save');
	assert.strictEqual(els['pysim-cf-add-btn'].attrs['data-l10n'], 'Save');
	assert.ok(!els['pysim-cf-cancel-btn'].classList.contains('hidden'));
	assert.strictEqual(els['pysim-cf-path'].focused, 1);
});

test('submit in edit mode updates the entry in place', () => {
	const els = setup([entry('6F46', 'EF.SPN')]);
	pysimCustomEdit(0);
	els['pysim-cf-path'].value = '3F00/7F20/6F46';
	els['pysim-cf-name'].value = 'EF.SPNX';
	pysimCustomSubmit();
	assert.strictEqual(pysimCustomFiles.length, 1);
	assert.deepStrictEqual(pysimCustomFiles[0], { path: '3F00/7F20/6F46', name: 'EF.SPNX', fid: '6F46', parentFid: '7F20' });
	assert.strictEqual(pysimCustomEditIndex, null);
	assert.strictEqual(els['pysim-cf-add-btn'].textContent, 'Add');
	assert.ok(els['pysim-cf-cancel-btn'].classList.contains('hidden'));
});

test('saving an edited entry with its own path is not a duplicate', () => {
	const els = setup([entry('6F46', 'EF.SPN')]);
	pysimCustomEdit(0);
	pysimCustomSubmit();
	assert.strictEqual(pysimCustomFiles.length, 1);
	assert.deepStrictEqual(globalThis.alertCalls, []);
});

test('editing to another entry path is rejected as duplicate', () => {
	const els = setup([entry('6F46', 'EF.SPN'), entry('6F44', 'EF.SPN2')]);
	pysimCustomEdit(0);
	els['pysim-cf-path'].value = '3F00/6F44';
	pysimCustomSubmit();
	assert.deepStrictEqual(globalThis.alertCalls, ['Path already exists']);
	assert.deepStrictEqual(pysimCustomFiles.map(c => c.path), ['3F00/6F46', '3F00/6F44']);
	assert.strictEqual(pysimCustomEditIndex, 0);
});

test('cancel restores the Add mode and clears the inputs', () => {
	const els = setup([entry('6F46', 'EF.SPN')]);
	pysimCustomEdit(0);
	pysimCustomEditCancel();
	assert.strictEqual(pysimCustomEditIndex, null);
	assert.strictEqual(els['pysim-cf-path'].value, '');
	assert.strictEqual(els['pysim-cf-name'].value, '');
	assert.strictEqual(els['pysim-cf-add-btn'].textContent, 'Add');
	assert.strictEqual(els['pysim-cf-add-btn'].attrs['data-l10n'], 'Add');
	assert.ok(els['pysim-cf-cancel-btn'].classList.contains('hidden'));
});

test('deleting the entry being edited cancels the edit', () => {
	const els = setup([entry('6F46', 'EF.SPN')]);
	pysimCustomEdit(0);
	pysimCustomRemove(0);
	assert.deepStrictEqual(pysimCustomFiles, []);
	assert.strictEqual(pysimCustomEditIndex, null);
	assert.strictEqual(els['pysim-cf-add-btn'].textContent, 'Add');
});

test('deleting before the edited row shifts the edit index', () => {
	setup([entry('6F46', 'EF.SPN'), entry('6F44', 'EF.SPN2'), entry('6F42', 'EF.SPN3')]);
	pysimCustomEdit(2);
	pysimCustomRemove(0);
	assert.strictEqual(pysimCustomEditIndex, 1);
	assert.strictEqual(pysimCustomFiles[1].name, 'EF.SPN3');
});

test('submit adds a new entry when not editing', () => {
	const els = setup([]);
	els['pysim-cf-path'].value = '3f00/6f46';
	els['pysim-cf-name'].value = 'EF.SPN';
	pysimCustomSubmit();
	assert.deepStrictEqual(pysimCustomFiles, [{ path: '3F00/6F46', name: 'EF.SPN', fid: '6F46', parentFid: '3F00' }]);
	assert.strictEqual(els['pysim-cf-path'].value, '');
	assert.strictEqual(els['pysim-cf-name'].value, '');
});
