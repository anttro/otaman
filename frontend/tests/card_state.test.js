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

let code = 'var _pysimLastConnected = null;\n';
code += extractFunc(html, 'pysimCardStateUpdate') + '\n';
code += '\nglobalThis.esc = s => s;\n';
code += 'globalThis.t = s => s;\n';
eval(code);

function setup() {
	const el = { textContent: 'status line', innerHTML: '' };
	const calls = { connected: [], refresh: 0 };
	globalThis.document = { getElementById: () => el };
	globalThis.pysimSetConnected = v => calls.connected.push(v);
	globalThis.pysimRefresh = () => { calls.refresh++; };
	return { el, calls };
}

test('disconnect without card shows the no-card message', () => {
	_pysimLastConnected = true;
	const { el, calls } = setup();
	pysimCardStateUpdate({ connected: false, card_present: false });
	assert.deepStrictEqual(calls.connected, [false]);
	assert.ok(el.innerHTML.includes('No card detected'), el.innerHTML);
});

test('disconnect with card present shows the Equip hint', () => {
	_pysimLastConnected = true;
	const { el } = setup();
	pysimCardStateUpdate({ connected: false, card_present: true });
	assert.ok(el.innerHTML.includes('Card inserted'), el.innerHTML);
});

test('unchanged state does not touch the UI again', () => {
	_pysimLastConnected = false;
	const { el, calls } = setup();
	el.innerHTML = 'unchanged';
	pysimCardStateUpdate({ connected: false, card_present: false });
	assert.deepStrictEqual(calls.connected, []);
	assert.strictEqual(el.innerHTML, 'unchanged');
});

test('reconnect restores the connected UI and refreshes', () => {
	_pysimLastConnected = false;
	const { calls } = setup();
	pysimCardStateUpdate({ connected: true, card_present: true });
	assert.deepStrictEqual(calls.connected, [true]);
	assert.strictEqual(calls.refresh, 1);
});

test('payload without connected flag is ignored', () => {
	_pysimLastConnected = null;
	const { calls } = setup();
	pysimCardStateUpdate({ reader: 'x' });
	pysimCardStateUpdate(null);
	assert.deepStrictEqual(calls.connected, []);
});
