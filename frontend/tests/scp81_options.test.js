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

let code = html.match(/const SCP81_OPT_DEFAULTS = \{[\s\S]*?\n\};/)[0].replace('const ', 'var ') + '\n';
for (const fn of ['scp81OptionsLoad', 'scp81OptionsFromForm', 'scp81OptionsPersist', 'scp81OptionsReset']) {
	code += extractFunc(html, fn) + '\n';
}
eval(code);

function setup(opts) {
	const spec = Object.assign({
		'opt-chunked': true,
		'opt-chunk-size': 0,
		'opt-keep-alive': true,
		'opt-conn-header': 'none',
		'opt-compact': false,
		'opt-next-uri': true,
		'opt-next-uri-value': '/api/scp81?req=%d',
		'opt-link-events': true,
		'opt-script-template': 'indefinite',
		'opt-cr-tag': false,
		'opt-targeted-app': ''
	}, opts || {});
	const els = {};
	for (const [id, v] of Object.entries(spec)) {
		els[id] = typeof v === 'boolean' ? { checked: v, value: '' } : { checked: true, value: String(v) };
	}
	globalThis.document = { getElementById: id => els[id] || null };
	return els;
}

function fakeStorage(initial) {
	const store = Object.assign({}, initial || {});
	globalThis.localStorage = {
		getItem: k => (k in store ? store[k] : null),
		setItem: (k, v) => { store[k] = String(v); },
		removeItem: k => { delete store[k]; },
		_store: store,
	};
	return store;
}

test('scp81OptionsFromForm maps the reference defaults', () => {
	setup();
	assert.deepStrictEqual(scp81OptionsFromForm(), {
		chunked: true,
		chunk_size: 0,
		keep_alive: true,
		conn_header: 'none',
		compact_headers: false,
		next_uri: '/api/scp81?req=%d',
		link_events: true,
		script_template: 'indefinite',
		cr_tag: false,
		targeted_app: ''
	});
});

test('scp81OptionsFromForm reflects a changed setup', () => {
	setup({
		'opt-chunked': false,
		'opt-chunk-size': '100',
		'opt-keep-alive': false,
		'opt-conn-header': 'close',
		'opt-compact': true,
		'opt-next-uri-value': '/adminserver?apdu_id=%d',
		'opt-link-events': false,
		'opt-script-template': 'definite',
		'opt-cr-tag': true,
		'opt-targeted-app': ' //aid/A000000151000000 '
	});
	assert.deepStrictEqual(scp81OptionsFromForm(), {
		chunked: false,
		chunk_size: 100,
		keep_alive: false,
		conn_header: 'close',
		compact_headers: true,
		next_uri: '/adminserver?apdu_id=%d',
		link_events: false,
		script_template: 'definite',
		cr_tag: true,
		targeted_app: '//aid/A000000151000000'
	});
});

test('unchecked Next-URI omits the header; empty text falls back to the template', () => {
	setup({ 'opt-next-uri': false });
	assert.strictEqual(scp81OptionsFromForm().next_uri, '');
	setup({ 'opt-next-uri': true, 'opt-next-uri-value': '   ' });
	assert.strictEqual(scp81OptionsFromForm().next_uri, '/api/scp81?req=%d');
});

test('load/persist/reset round-trip through localStorage', () => {
	const store = fakeStorage();
	setup({
		'opt-chunked': false,
		'opt-chunk-size': 100,
		'opt-keep-alive': false,
		'opt-conn-header': 'close',
		'opt-compact': true,
		'opt-next-uri': false,
		'opt-link-events': false,
		'opt-script-template': 'definite',
		'opt-cr-tag': true,
		'opt-targeted-app': '//aid/A000000151000000'
	});
	scp81OptionsPersist();
	assert.ok(store['otaman_scp81_opts'].includes('"chunkSize":100'));
	// a reload restores the saved setup
	setup({});
	scp81OptionsLoad();
	assert.strictEqual(globalThis.document.getElementById('opt-chunked').checked, false);
	assert.strictEqual(globalThis.document.getElementById('opt-chunk-size').value, 100);
	assert.strictEqual(globalThis.document.getElementById('opt-conn-header').value, 'close');
	assert.strictEqual(globalThis.document.getElementById('opt-next-uri').checked, false);
	assert.strictEqual(globalThis.document.getElementById('opt-script-template').value, 'definite');
	assert.strictEqual(globalThis.document.getElementById('opt-cr-tag').checked, true);
	assert.strictEqual(globalThis.document.getElementById('opt-targeted-app').value, '//aid/A000000151000000');
	// reset clears the saved entry and restores the defaults
	scp81OptionsReset();
	assert.ok(!('otaman_scp81_opts' in store));
	scp81OptionsLoad();
	assert.strictEqual(globalThis.document.getElementById('opt-chunked').checked, true);
	assert.strictEqual(globalThis.document.getElementById('opt-next-uri').checked, true);
	assert.strictEqual(globalThis.document.getElementById('opt-conn-header').value, 'none');
});

test('the Listener UI wires the framing options into Start', () => {
	for (const id of ['scp81-opts-http', 'scp81-opts-script', 'opt-chunked',
		'opt-chunk-size', 'opt-keep-alive', 'opt-conn-header', 'opt-compact',
		'opt-next-uri', 'opt-next-uri-value', 'opt-script-template', 'opt-cr-tag',
		'opt-targeted-app', 'opt-link-events']) {
		assert.ok(html.includes('id="' + id + '"'), id);
	}
	assert.ok(html.includes('body.link_events = opts.link_events;'));
	assert.ok(html.includes('body.chunk_size = opts.chunk_size;'));
	assert.ok(html.includes('body.next_uri = opts.next_uri;'));
	assert.ok(html.includes('body.script_template = opts.script_template;'));
	assert.ok(html.includes("httpOpts.classList.toggle('hidden', mode !== 'tls')"));
	assert.ok(html.includes("scriptOpts.classList.toggle('hidden', mode !== 'tls')"));
});
