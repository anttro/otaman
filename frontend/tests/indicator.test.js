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

let code = 'var _pysimServerAvailable = null;\nvar _pysimCardEquipped = false;\nvar _pysimEquipping = false;\n';
code += extractFunc(html, 'pysimAvailabilityState') + '\n';
code += extractFunc(html, 'pysimUpdateStateIndicator') + '\n';
code += 'globalThis.t = s => s;\n';
eval(code);

function fakeEl() {
	const classes = new Set();
	return {
		classes,
		attrs: {},
		classList: {
			add: (...cs) => cs.forEach(c => classes.add(c)),
			remove: (...cs) => cs.forEach(c => classes.delete(c)),
			contains: c => classes.has(c),
		},
		setAttribute(k, v) { this.attrs[k] = v; },
		removeAttribute(k) { delete this.attrs[k]; },
	};
}

function setup() {
	const els = {
		'state-indicator': fakeEl(),
		'state-indicator-dot': fakeEl(),
		'state-indicator-img': fakeEl(),
	};
	els['state-indicator-img'].src = '';
	globalThis.document = { getElementById: id => els[id] || null };
	_pysimServerAvailable = null;
	_pysimCardEquipped = false;
	_pysimEquipping = false;
	return els;
}

test('unprobed server shows a gray dot and a Connecting title', () => {
	const els = setup();
	pysimUpdateStateIndicator();
	const { 'state-indicator': wrap, 'state-indicator-dot': dot, 'state-indicator-img': img } = els;
	assert.ok(dot.classes.has('text-gray-400'));
	assert.ok(!dot.classes.has('hidden'));
	assert.ok(img.classes.has('hidden'));
	assert.strictEqual(wrap.attrs.title, 'Connecting...');
	assert.strictEqual(dot.attrs.title, 'Connecting...');
});

test('unreachable server shows a red dot', () => {
	const els = setup();
	_pysimServerAvailable = false;
	pysimUpdateStateIndicator();
	const { 'state-indicator': wrap, 'state-indicator-dot': dot, 'state-indicator-img': img } = els;
	assert.ok(dot.classes.has('text-red-500'));
	assert.ok(!dot.classes.has('text-gray-400'));
	assert.ok(img.classes.has('hidden'));
	assert.strictEqual(wrap.attrs.title, 'No server connection');
	assert.strictEqual(dot.attrs.title, 'No server connection');
});

test('server up without a card shows nosim.svg', () => {
	const els = setup();
	_pysimServerAvailable = true;
	pysimUpdateStateIndicator();
	const { 'state-indicator': wrap, 'state-indicator-dot': dot, 'state-indicator-img': img } = els;
	assert.ok(dot.classes.has('hidden'));
	assert.ok(!img.classes.has('hidden'));
	assert.strictEqual(img.src, 'nosim.svg');
	assert.strictEqual(wrap.attrs.title, 'Server connected, no card equipped');
	assert.strictEqual(dot.attrs.title, undefined);
});

test('equipped card shows sim.svg', () => {
	const els = setup();
	_pysimServerAvailable = true;
	_pysimCardEquipped = true;
	pysimUpdateStateIndicator();
	const { 'state-indicator': wrap, 'state-indicator-img': img } = els;
	assert.strictEqual(img.src, 'sim.svg');
	assert.strictEqual(wrap.attrs.title, 'Card equipped');
});

test('equipping shows the animated sim_anim.svg', () => {
	const els = setup();
	_pysimServerAvailable = true;
	_pysimEquipping = true;
	pysimUpdateStateIndicator();
	const { 'state-indicator': wrap, 'state-indicator-img': img } = els;
	assert.strictEqual(img.src, 'sim_anim.svg');
	assert.strictEqual(wrap.attrs.title, 'Card inserted — initializing...');
});

test('dot color transitions do not accumulate', () => {
	const els = setup();
	_pysimServerAvailable = false;
	pysimUpdateStateIndicator();
	_pysimServerAvailable = null;
	pysimUpdateStateIndicator();
	const dot = els['state-indicator-dot'];
	assert.ok(dot.classes.has('text-gray-400'));
	assert.ok(!dot.classes.has('text-red-500'));
});

test('indicator markup carries the dot and image elements', () => {
	assert.match(html, /id="state-indicator-dot"/);
	assert.match(html, /id="state-indicator-img"[^>]*src="nosim\.svg"/);
});

test('indicator image stays within the 32px header row budget', () => {
	const m = /id="state-indicator-img"[^>]*style="width:(\d+)px;height:(\d+)px"/.exec(html);
	assert.ok(m, 'inline image size not found');
	assert.strictEqual(m[1], m[2]);
	const size = Number(m[1]);
	assert.ok(size >= 24 && size <= 32, 'size ' + size + 'px would change the header height');
});
