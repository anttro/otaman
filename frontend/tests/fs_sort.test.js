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

eval(extractFunc(html, 'pysimFsSortChildren'));

const f = (fid, name) => ({ fid, name, isDir: false });
const d = (fid, name) => ({ fid, name, isDir: true });

test('DFs sort before EFs in both modes', () => {
	const children = [f('6F07', 'EF.IMSI'), d('7F20', 'DF.GSM'), f('2FE2', 'EF.ICCID'), d('7F10', 'DF.TELECOM')];
	assert.deepStrictEqual(pysimFsSortChildren(children, 'fid').map(x => x.fid), ['7F10', '7F20', '2FE2', '6F07']);
	assert.deepStrictEqual(pysimFsSortChildren(children, 'name').map(x => x.name), ['DF.GSM', 'DF.TELECOM', 'EF.ICCID', 'EF.IMSI']);
});

test('FID mode sorts EFs numerically by FID string', () => {
	const children = [f('6F3A', 'EF.ADN'), f('2FE2', 'EF.ICCID'), f('6F07', 'EF.IMSI')];
	assert.deepStrictEqual(pysimFsSortChildren(children, 'fid').map(x => x.fid), ['2FE2', '6F07', '6F3A']);
});

test('name mode sorts case-insensitively', () => {
	const children = [f('6F3A', 'EF.ADN'), f('2FE2', 'ef.iccid'), f('6F07', 'EF.IMSI')];
	assert.deepStrictEqual(pysimFsSortChildren(children, 'name').map(x => x.name), ['EF.ADN', 'ef.iccid', 'EF.IMSI']);
});

test('missing name falls back to the FID as the sort key', () => {
	const children = [f('2FE2', null), f('6F07', 'EF.IMSI'), f('6F3A', '')];
	// keys: '2FE2', 'EF.IMSI', '6F3A' -> '2FE2' < '6F3A' < 'EF.IMSI'
	assert.deepStrictEqual(pysimFsSortChildren(children, 'name').map(x => x.fid), ['2FE2', '6F3A', '6F07']);
});

test('custom entries use their isDir flag for the DF priority', () => {
	const children = [f('6F3A', 'EF.ADN'), d('7F20', 'DF.GSM')];
	assert.strictEqual(pysimFsSortChildren(children, 'fid')[0].name, 'DF.GSM');
});

test('equal keys keep a deterministic tie-break by the other field', () => {
	const children = [f('6F07', 'EF.SAME'), f('2FE2', 'EF.SAME')];
	assert.deepStrictEqual(pysimFsSortChildren(children, 'name').map(x => x.fid), ['2FE2', '6F07']);
	assert.deepStrictEqual(pysimFsSortChildren(children, 'fid').map(x => x.fid), ['2FE2', '6F07']);
});

test('does not mutate the input array', () => {
	const children = [f('6F3A', 'B'), f('2FE2', 'A')];
	pysimFsSortChildren(children, 'fid');
	assert.deepStrictEqual(children.map(x => x.fid), ['6F3A', '2FE2']);
});
