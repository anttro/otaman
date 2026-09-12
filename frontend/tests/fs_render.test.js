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

let code = 'var pysimFsSort = "fid";\n';
code += extractFunc(html, 'pysimFsSortChildren') + '\n';
code += extractFunc(html, 'pysimFsRenderNode') + '\n';
code += 'globalThis.esc = s => s;\nglobalThis.t = s => s;\n';
eval(code);

const ef = (name, fid) => ({ name, fid, isDir: false, exists: true, children: null, expanded: false });
const df = (name, fid, extra) => Object.assign({ name, fid, isDir: true, exists: true, children: null, expanded: false }, extra || {});

test('absent directory renders a cross and no expand toggle', () => {
	const node = df('DF.WLAN', '5f40', { exists: false, children: [] });
	const out = pysimFsRenderNode(node, 0);
	assert.ok(out.includes('✗'), out);
	assert.ok(!out.includes('pysimFsToggleDir'), out);
	assert.ok(!out.includes('▶'), out);
});

test('expanded empty directory shows the (empty) placeholder', () => {
	const node = df('DF.EMPTY', '5f00', { children: [], expanded: true });
	const out = pysimFsRenderNode(node, 0);
	assert.ok(out.includes('(empty)'), out);
});

test('expanded directory with children renders no placeholder', () => {
	const node = df('DF.GSM', '7f20', { children: [ef('EF.IMSI', '6f07')], expanded: true });
	const out = pysimFsRenderNode(node, 0);
	assert.ok(out.includes('EF.IMSI'), out);
	assert.ok(!out.includes('(empty)'), out);
});

test('collapsed directory hides its children', () => {
	const node = df('DF.GSM', '7f20', { children: [ef('EF.IMSI', '6f07')], expanded: false });
	const out = pysimFsRenderNode(node, 0);
	assert.ok(!out.includes('EF.IMSI'), out);
});
