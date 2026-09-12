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

let code = '';
code += extractFunc(html, 'getParentSel') + '\n';
code += extractFunc(html, 'getParentPath') + '\n';
code += extractFunc(html, 'pysimFsLoadChildren') + '\n';
code += 'globalThis.pysimCustomInject = () => {};\n';
eval(code);

let calls = [];
let responses = [];
let renders = 0;

function setup() {
	calls = [];
	responses = [];
	renders = 0;
	globalThis.pysimFetch = async (p, body) => {
		calls.push({ path: p, body: JSON.parse(JSON.stringify(body)) });
		const r = responses.shift();
		if (r instanceof Error) throw r;
		return JSON.parse(JSON.stringify(r));
	};
	globalThis.pysimFsRenderTree = () => { renders++; };
	const node = { name: 'DF.USIM', fid: '7fff', isDir: true, children: null, exists: null, parent: { name: 'MF', fid: '3f00' } };
	return node;
}

test('tree error payload marks the directory as absent', async () => {
	const node = setup();
	responses = [
		{ success: false, error: 'SW ... 6a82', exists: false },
		{ success: false, error: 'SW ... 6a82', exists: false },
	];
	await pysimFsLoadChildren(node);
	assert.strictEqual(node.exists, false);
	assert.strictEqual(node.children, null);
	assert.strictEqual(renders, 1);
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].body.parent_sel, 'MF');
	assert.deepStrictEqual(calls[0].body.parent_path, ['MF']);
});

test('error payload without exists is not treated as an empty listing', async () => {
	const node = setup();
	responses = [
		{ success: false, error: 'boom' },
		{ success: false, error: 'boom' },
	];
	await pysimFsLoadChildren(node);
	assert.strictEqual(node.exists, false);
	assert.strictEqual(node.children, null);
	assert.strictEqual(renders, 1);
	assert.strictEqual(calls.length, 1);
});

test('a 200 exists:false response marks the directory absent without retrying', async () => {
	const node = setup();
	responses = [{ exists: false }];
	await pysimFsLoadChildren(node);
	assert.strictEqual(node.exists, false);
	assert.strictEqual(node.children, null);
	assert.strictEqual(calls.length, 1);
});

test('a node with loaded children is not fetched again', async () => {
	const node = setup();
	node.exists = true;
	node.children = [{ name: 'EF.UPLMNWLAN', fid: '4f42', isDir: false, exists: true }];
	await pysimFsLoadChildren(node);
	assert.strictEqual(node.exists, true);
	assert.strictEqual(node.children.length, 1);
	assert.strictEqual(calls.length, 0);
});

test('empty successful listing keeps the directory present', async () => {
	const node = setup();
	responses = [{ exists: true, children: [] }];
	await pysimFsLoadChildren(node);
	assert.strictEqual(node.exists, true);
	assert.deepStrictEqual(node.children, []);
});
