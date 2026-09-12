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

let code = 'var _pysimCardStateKey = null;\nvar _pysimCardSession = null;\n'
	+ 'var _pysimServerAvailable = null;\nvar _pysimCardEquipped = false;\n';
code += extractFunc(html, 'pysimCardStateUpdate') + '\n';
code += extractFunc(html, 'pysimAvailabilityState') + '\n';
code += extractFunc(html, 'pysimControlDisabled') + '\n';
code += '\nglobalThis.esc = s => s;\n';
code += 'globalThis.t = s => s;\n';
eval(code);

function setup() {
	const el = { textContent: 'status line', innerHTML: '' };
	const calls = { connected: [], resets: [], refreshStatus: [] };
	_pysimCardStateKey = null;
	_pysimCardSession = null;
	globalThis.document = { getElementById: () => el, querySelectorAll: () => [] };
	globalThis.pysimSetConnected = v => calls.connected.push(v);
	globalThis.pysimResetCardData = refresh => calls.resets.push(refresh);
	globalThis.pysimApplyAvailability = () => {};
	return { el, calls };
}

function status(extra) {
	return Object.assign({ connected: false, card_present: false, equipping: false, auto_equip: false, card_session: 1 }, extra);
}

test('disconnect without card shows the no-card message', () => {
	const { el, calls } = setup();
	pysimCardStateUpdate(status({}));
	assert.deepStrictEqual(calls.connected, [false]);
	assert.ok(el.innerHTML.includes('No card detected'), el.innerHTML);
});

test('disconnect with card present shows the Equip hint when auto-equip is off', () => {
	const { el } = setup();
	pysimCardStateUpdate(status({ card_present: true }));
	assert.ok(el.innerHTML.includes('Card inserted — press Equip'), el.innerHTML);
});

test('disconnect with auto-equip shows the initializing message', () => {
	const { el } = setup();
	pysimCardStateUpdate(status({ card_present: true, auto_equip: true }));
	assert.ok(el.innerHTML.includes('initializing'), el.innerHTML);
});

test('unchanged state key does not touch the UI again', () => {
	const { el, calls } = setup();
	pysimCardStateUpdate(status({ card_session: 7 }));
	el.innerHTML = 'unchanged';
	calls.connected.length = 0;
	pysimCardStateUpdate(status({ card_session: 7 }));
	assert.deepStrictEqual(calls.connected, []);
	assert.strictEqual(el.innerHTML, 'unchanged');
});

test('connected restores the UI and reloads card data', () => {
	const { calls } = setup();
	pysimCardStateUpdate(status({ connected: true, card_present: true, card_session: 2 }));
	assert.deepStrictEqual(calls.connected, [true]);
	assert.deepStrictEqual(calls.resets, [true]);
});

test('card session change triggers a data reset', () => {
	const { calls } = setup();
	pysimCardStateUpdate(status({ card_session: 3 }));
	calls.resets.length = 0;
	pysimCardStateUpdate(status({ card_session: 4 }));
	assert.deepStrictEqual(calls.resets, [false]);
});

test('first observation does not trigger a reset on its own', () => {
	const { calls } = setup();
	pysimCardStateUpdate(status({ card_session: 9 }));
	assert.deepStrictEqual(calls.resets, []);
});

test('payload without connected flag is ignored', () => {
	const { calls } = setup();
	pysimCardStateUpdate({ reader: 'x' });
	pysimCardStateUpdate(null);
	assert.deepStrictEqual(calls.connected, []);
});

test('availability state and control gating follow server/card state', () => {
	_pysimServerAvailable = null;
	assert.strictEqual(pysimAvailabilityState(), 'server-down');
	assert.strictEqual(pysimControlDisabled('server', 'server-down'), true);
	assert.strictEqual(pysimControlDisabled('card', 'server-down'), true);

	_pysimServerAvailable = true;
	_pysimCardEquipped = false;
	assert.strictEqual(pysimAvailabilityState(), 'no-card');
	assert.strictEqual(pysimControlDisabled('server', 'no-card'), false);
	assert.strictEqual(pysimControlDisabled('card', 'no-card'), true);

	_pysimCardEquipped = true;
	assert.strictEqual(pysimAvailabilityState(), 'card');
	assert.strictEqual(pysimControlDisabled('card', 'card'), false);
	assert.strictEqual(pysimControlDisabled('server', 'card'), false);
});

test('no card with auto-equip enabled still shows the no-card message', () => {
	const { el } = setup();
	pysimCardStateUpdate(status({ connected: false, card_present: false, auto_equip: true }));
	assert.ok(el.innerHTML.includes('No card detected'), el.innerHTML);
	assert.ok(!el.innerHTML.includes('initializing'), el.innerHTML);
});
