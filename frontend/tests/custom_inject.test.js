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

let code = 'var pysimCustomFiles = [];\n';
for (const fn of ['pysimFsNodePath', 'pysimCustomInject', 'pysimCustomParent', 'pysimCustomFid']) {
	code += extractFunc(html, fn) + '\n';
}
eval(code);

function node(name, fid, parent, children) {
	return { name, fid, parent: parent || null, children: children || null, isDir: true };
}

function tree() {
	const mf = node('MF', '3F00', null, []);
	const dfA = node('DF.A', '5F01', mf);
	const dfB = node('DF.B', '5F02', mf);
	const dfC = node('DF.C', '5F03', mf, [node('EF.X', '6F46', null)]);
	dfC.children[0].parent = dfC;
	const adf = node('ADF.USIM', '7FFF', mf);
	const efImsi = node('EF.IMSI', '6F07', adf);
	adf.children = [efImsi];
	mf.children = [dfA, dfB, dfC, adf];
	return { mf, dfA, dfB, dfC, adf, efImsi };
}

test('pysimFsNodePath builds canonical paths from MF and ADF roots', () => {
	const t = tree();
	assert.strictEqual(pysimFsNodePath(t.mf), 'MF');
	assert.strictEqual(pysimFsNodePath(t.dfA), 'MF/5F01');
	assert.strictEqual(pysimFsNodePath(t.dfC.children[0]), 'MF/5F03/6F46');
	assert.strictEqual(pysimFsNodePath(t.adf), 'ADF.USIM');
	assert.strictEqual(pysimFsNodePath(t.efImsi), 'ADF.USIM/6F07');
});

test('injection matches full paths, so same-FID DFs stay apart', () => {
	const t = tree();
	pysimCustomFiles = [
		{ path: 'MF/5F01/6F46', name: 'EF.ONLY-A', kind: 'ef' },
		{ path: 'MF/5F02/6F46', name: 'EF.ONLY-B', kind: 'ef' },
		{ path: 'ADF.USIM/6F07', name: 'EF.MY-IMSI', kind: 'ef' },
	];
	pysimCustomInject(t.mf);
	assert.strictEqual(t.mf.children.length, 4, 'MF-level injection adds nothing');
	pysimCustomInject(t.dfA);
	assert.strictEqual(t.dfA.children.length, 1);
	assert.strictEqual(t.dfA.children[0].name, 'EF.ONLY-A');
	assert.strictEqual(t.dfA.children[0].customPath, 'MF/5F01/6F46');
	pysimCustomInject(t.dfB);
	assert.strictEqual(t.dfB.children[0].name, 'EF.ONLY-B');
	pysimCustomInject(t.dfC);
	assert.strictEqual(t.dfC.children.length, 1, 'unrelated DF is untouched');
	pysimCustomInject(t.adf);
	assert.strictEqual(t.adf.children.length, 1);
	assert.strictEqual(t.adf.children[0].name, 'EF.MY-IMSI');
	assert.strictEqual(t.adf.children[0].customPath, 'ADF.USIM/6F07');
});

test('injection renames and marks an existing model node', () => {
	const t = tree();
	pysimCustomFiles = [{ path: 'MF/5F03/6F46', name: 'EF.RENAMED', kind: 'ef' }];
	pysimCustomInject(t.dfC);
	assert.strictEqual(t.dfC.children.length, 1);
	assert.strictEqual(t.dfC.children[0].name, 'EF.RENAMED');
	assert.strictEqual(t.dfC.children[0].custom, true);
});

test('injected DFs are directories and can host their own children', () => {
	const t = tree();
	pysimCustomFiles = [
		{ path: 'MF/5F10', name: 'DF.NEW', kind: 'df' },
		{ path: 'MF/5F10/6F46', name: 'EF.UNDER-NEW', kind: 'ef' },
	];
	pysimCustomInject(t.mf);
	const df = t.mf.children.find(c => c.fid === '5F10');
	assert.ok(df, 'custom DF injected into MF');
	assert.strictEqual(df.isDir, true);
	assert.strictEqual(pysimFsNodePath(df), 'MF/5F10');
	pysimCustomInject(df);
	assert.strictEqual(df.children.length, 1);
	assert.strictEqual(df.children[0].name, 'EF.UNDER-NEW');
});
