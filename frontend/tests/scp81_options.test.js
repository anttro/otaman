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
for (const fn of ['scp81OptionsState', 'scp81OptionsFromForm', 'scp81OptionsSyncDisabled',
	'scp81OptionsBadge', 'scp81OptionsLoad', 'scp81OptionsPersist', 'scp81OptionsReset',
	'scp81NextUriToggle', 'scp81TargetedAppToggle']) {
	code += extractFunc(html, fn) + '\n';
}
code += 'globalThis.t = s => s;\n';
eval(code);

function setup(opts) {
	const spec = Object.assign({
		'opt-chunked': true,
		'opt-chunk-size': 0,
		'opt-conn-header': 'none',
		'opt-compact': false,
		'opt-next-uri': true,
		'opt-next-uri-value': '/api/scp81?req=%d',
		'opt-link-events': true,
		'opt-script-template': 'indefinite',
		'opt-cr-tag': false,
		'opt-targeted-app-on': false,
		'opt-targeted-app': '',
		'scp81-opts-badge': ''
	}, opts || {});
	const els = {};
	for (const [id, v] of Object.entries(spec)) {
		const checkbox = typeof v === 'boolean';
		els[id] = {
			checked: checkbox ? v : true,
			value: checkbox ? '' : String(v),
			disabled: false,
			textContent: '',
			classList: { toggle() {} },
		};
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
		'opt-conn-header': 'keep-alive',
		'opt-compact': true,
		'opt-next-uri-value': '/adminserver?apdu_id=%d',
		'opt-link-events': false,
		'opt-script-template': 'definite',
		'opt-cr-tag': true,
		'opt-targeted-app-on': true,
		'opt-targeted-app': ' //aid/A000000151000000 '
	});
	assert.deepStrictEqual(scp81OptionsFromForm(), {
		chunked: false,
		chunk_size: 100,
		conn_header: 'keep-alive',
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

test('X-Admin-Targeted-Application is only sent when its checkbox is ticked', () => {
	// text left in the box with the checkbox off must never leak out
	setup({ 'opt-targeted-app-on': false, 'opt-targeted-app': '//aid/A000000151000000' });
	assert.strictEqual(scp81OptionsFromForm().targeted_app, '');
	setup({ 'opt-targeted-app-on': true, 'opt-targeted-app': ' //aid/A000000151000000 ' });
	assert.strictEqual(scp81OptionsFromForm().targeted_app, '//aid/A000000151000000');
});

test('the dependent fields are disabled while their checkbox is off', () => {
	const els = setup({ 'opt-next-uri': false, 'opt-targeted-app-on': false });
	scp81OptionsSyncDisabled();
	assert.strictEqual(els['opt-next-uri-value'].disabled, true);
	assert.strictEqual(els['opt-targeted-app'].disabled, true);
	els['opt-next-uri'].checked = true;
	els['opt-targeted-app-on'].checked = true;
	scp81OptionsSyncDisabled();
	assert.strictEqual(els['opt-next-uri-value'].disabled, false);
	assert.strictEqual(els['opt-targeted-app'].disabled, false);
});

test('the custom badge flags anything that differs from the defaults', () => {
	const els = setup();
	scp81OptionsBadge();
	assert.strictEqual(els['scp81-opts-badge'].textContent, '');
	setup({ 'opt-compact': true, 'scp81-opts-badge': '' });
	scp81OptionsBadge();
	assert.strictEqual(globalThis.document.getElementById('scp81-opts-badge').textContent, 'custom');
	// an empty Next-URI text is not a change (the default template applies)
	setup({ 'opt-next-uri-value': '', 'scp81-opts-badge': '' });
	scp81OptionsBadge();
	assert.strictEqual(globalThis.document.getElementById('scp81-opts-badge').textContent, '');
});

test('load/persist/reset round-trip through localStorage', () => {
	const store = fakeStorage();
	setup({
		'opt-chunked': false,
		'opt-chunk-size': 100,
		'opt-conn-header': 'keep-alive',
		'opt-compact': true,
		'opt-next-uri': false,
		'opt-link-events': false,
		'opt-script-template': 'definite',
		'opt-cr-tag': true,
		'opt-targeted-app-on': true,
		'opt-targeted-app': '//aid/A000000151000000'
	});
	scp81OptionsPersist();
	assert.ok(store['simple_scp81_opts'].includes('"chunkSize":100'));
	assert.ok(store['simple_scp81_opts'].includes('"targetedAppOn":true'));
	assert.ok(!store['simple_scp81_opts'].includes('keepAlive'));
	// a reload restores the saved setup
	setup({});
	scp81OptionsLoad();
	const get = id => globalThis.document.getElementById(id);
	assert.strictEqual(get('opt-chunked').checked, false);
	assert.strictEqual(get('opt-chunk-size').value, 100);
	assert.strictEqual(get('opt-conn-header').value, 'keep-alive');
	assert.strictEqual(get('opt-next-uri').checked, false);
	assert.strictEqual(get('opt-script-template').value, 'definite');
	assert.strictEqual(get('opt-cr-tag').checked, true);
	assert.strictEqual(get('opt-targeted-app-on').checked, true);
	assert.strictEqual(get('opt-targeted-app').value, '//aid/A000000151000000');
	// reset clears the saved entry and restores the defaults
	scp81OptionsReset();
	assert.ok(!('simple_scp81_opts' in store));
	scp81OptionsLoad();
	assert.strictEqual(get('opt-chunked').checked, true);
	assert.strictEqual(get('opt-next-uri').checked, true);
	assert.strictEqual(get('opt-conn-header').value, 'none');
	assert.strictEqual(get('opt-targeted-app-on').checked, false);
});

test('the Listener UI wires the framing options into Start', () => {
	for (const id of ['scp81-opts', 'scp81-opts-badge', 'scp81-opts-http', 'scp81-opts-script',
		'opt-chunked', 'opt-chunk-size', 'opt-conn-header', 'opt-compact',
		'opt-next-uri', 'opt-next-uri-value', 'opt-script-template', 'opt-cr-tag',
		'opt-targeted-app-on', 'opt-targeted-app', 'opt-link-events']) {
		assert.ok(html.includes('id="' + id + '"'), id);
	}
	// collapsed by default: a <details> without the open attribute
	assert.match(html, /<details id="scp81-opts" class="[^"]*">/);
	assert.ok(!/<details id="scp81-opts"[^>]*\sopen/.test(html));
	// the removed switch must not come back
	assert.ok(!html.includes('opt-keep-alive'));
	// the options travel in the start body
	assert.ok(html.includes('body.chunk_size = opts.chunk_size;'));
	assert.ok(html.includes('body.next_uri = opts.next_uri;'));
	assert.ok(html.includes('body.targeted_app = opts.targeted_app || null;'));
	assert.ok(html.includes('body.script_template = opts.script_template;'));
	assert.ok(html.includes("httpOpts.classList.toggle('hidden', mode !== 'tls')"));
	assert.ok(html.includes("scriptOpts.classList.toggle('hidden', mode !== 'tls')"));
});
