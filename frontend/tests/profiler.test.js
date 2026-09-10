const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunc(src, name, asyncFn) {
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
	return (asyncFn ? 'async ' : '') + src.slice(m.index, i + 1);
}

const FNS = ['profilerNormHex', 'profilerMatch', 'profilerMatchMin', 'profilerMaskPrefix4', 'profilerFileFields', 'profilerContentKindForFileType', 'profilerEmptyRecordContent', 'profilerValidateProfile', 'profilerCustomNameForPath', 'profilerUpdateRulePath'];
let code = '';
for (const f of FNS) code += extractFunc(html, f) + '\n';
code += extractFunc(html, 'profilerBuildFileRule', true) + '\n';
code += html.match(/const PROFILER_MASK_PREFIX4_FIDS = \{[\s\S]*?\n\};/)[0] + '\n';
eval(code);

test('profilerNormHex uppercases and strips non-hex', () => {
	assert.strictEqual(profilerNormHex('aabbcc'), 'AABBCC');
	assert.strictEqual(profilerNormHex(' aa bb cc '), 'AABBCC');
	assert.strictEqual(profilerNormHex('08?91?'), '08?91?');
	assert.strictEqual(profilerNormHex(''), '');
});

test('exact match requires full equality', () => {
	assert.ok(profilerMatch('exact', 'AABBCC', 'aabbcc'));
	assert.ok(!profilerMatch('exact', 'AABB', 'AABBCC'));
	assert.ok(!profilerMatch('exact', 'AABBCC', 'AABB'));
	assert.ok(!profilerMatch('exact', '', 'AABB'));
});

test('mask with ? wildcard matches per nibble', () => {
	assert.ok(profilerMatch('mask', '08?91?', '081910'));
	assert.ok(profilerMatch('mask', '08?91?', '08A91B'));
	assert.ok(!profilerMatch('mask', '08?91?', '091910'));
	assert.ok(!profilerMatch('mask', '08?91?', '0891')); // length mismatch
});

test('mask without ? is a prefix match', () => {
	assert.ok(profilerMatch('mask', '0891', '08911012345678'));
	assert.ok(profilerMatch('mask', '0891', '0891'));
	assert.ok(!profilerMatch('mask', '0891', '081910'));
	assert.ok(!profilerMatch('mask', '', '0891'));
});

test('profilerMatchMin compares the shorter overlapping portion', () => {
	// shorter expected vs longer actual -> compare prefix
	assert.ok(profilerMatchMin('exact', '1122FFFF', '1122FFFFFF'));
	assert.ok(!profilerMatchMin('exact', '1122FFFF', '1122FFAA'));
	// shorter actual vs longer expected -> compare prefix
	assert.ok(profilerMatchMin('exact', '1122FFFFFF', '1122FFFF'));
	// equal lengths behave like profilerMatch
	assert.ok(profilerMatchMin('exact', '1122FFFF', '1122FFFF'));
	assert.ok(!profilerMatchMin('exact', '1122FFFF', '1122FFEE'));
	// mask with ? over a shorter actual
	assert.ok(profilerMatchMin('mask', '08?91?AA', '081910'));
	assert.ok(!profilerMatchMin('mask', '08?91?AA', '091110'));
});

test('profilerMaskPrefix4 keeps first 4 bytes and masks the rest', () => {
	assert.strictEqual(profilerMaskPrefix4('082905911234567890'), '08290591??????????');
	assert.strictEqual(profilerMaskPrefix4('08290591'), '08290591');
	assert.strictEqual(profilerMaskPrefix4('1234'), '1234');
});

test('profilerFileFields maps file type to applicable fields', () => {
	assert.deepStrictEqual(profilerFileFields('transparent'), { size: true, records: false });
	assert.deepStrictEqual(profilerFileFields('ber_tlv'), { size: true, records: false });
	assert.deepStrictEqual(profilerFileFields('linear_fixed'), { size: false, records: true });
	assert.deepStrictEqual(profilerFileFields('cyclic'), { size: false, records: true });
	assert.deepStrictEqual(profilerFileFields('df'), { size: false, records: false });
	assert.deepStrictEqual(profilerFileFields(null), { size: true, records: true });
	assert.deepStrictEqual(profilerFileFields(''), { size: true, records: true });
});

test('profilerContentKindForFileType', () => {
	assert.strictEqual(profilerContentKindForFileType('linear_fixed'), 'record');
	assert.strictEqual(profilerContentKindForFileType('cyclic'), 'record');
	assert.strictEqual(profilerContentKindForFileType('transparent'), 'transparent');
	assert.strictEqual(profilerContentKindForFileType('ber_tlv'), 'transparent');
	assert.strictEqual(profilerContentKindForFileType('df'), 'transparent');
});

test('profilerEmptyRecordContent seeds one empty record row', () => {
	const c = profilerEmptyRecordContent('exact');
	assert.strictEqual(c.kind, 'record');
	assert.strictEqual(c.mode, 'exact');
	assert.strictEqual(c.records.length, 1);
	assert.deepStrictEqual(c.records[0], { num: 1, data: '' });
});

test('profile validation', () => {
	assert.strictEqual(profilerValidateProfile(null), 'Not an object');
	assert.strictEqual(profilerValidateProfile({ name: 'x' }), 'Missing rules array');
	assert.strictEqual(profilerValidateProfile({ name: 'x', rules: [{ type: 'ota' }] }), 'Unsupported rule type: ota');
	assert.strictEqual(profilerValidateProfile({ name: 'x', rules: [{ type: 'file' }] }), 'Rule missing path');
	assert.strictEqual(profilerValidateProfile({ name: 'x', rules: [{ type: 'file', path: 'MF/7F10/6F3A' }] }), null);
});

// --- "Profile from card" ignore list ---

function parseIgnoreFiles() {
	const raw = html.match(/const PROFILER_IGNORE_FILES = \[([\s\S]*?)\n\];/)[1];
	return [...raw.matchAll(/\{ fid: '([^']*)', name: '([^']*)' \}/g)].map(m => ({ fid: m[1], name: m[2] }));
}

test('ignore list FIDs are well-formed and KcGPRS uses the TS 51.011 FID (6F52)', () => {
	const files = parseIgnoreFiles();
	assert.ok(files.length >= 12);
	for (const f of files) {
		assert.match(f.fid, /^[0-9A-F]{4}$/, f.name + ' has a malformed FID');
		assert.ok(f.name.startsWith('EF.'), f.fid + ' has a malformed name');
	}
	assert.strictEqual(files.find(f => f.name === 'EF.KcGPRS').fid, '6F52');
});

test('ignore list has no duplicate FIDs or names', () => {
	const files = parseIgnoreFiles();
	assert.strictEqual(new Set(files.map(f => f.fid)).size, files.length);
	assert.strictEqual(new Set(files.map(f => f.name)).size, files.length);
});

function mockFetch(handlers) {
	const calls = [];
	global.pysimFetch = async (path, body) => {
		calls.push(path);
		if (handlers[path]) return handlers[path](body);
		throw new Error('unexpected fetch: ' + path);
	};
	return calls;
}

const KCGPRS_SELECT = {
	name: 'EF.KcGPRS', fid: '6F52', file_type: 'transparent',
	file_size: 9, record_len: null, num_of_rec: null, exists: true,
};

test('profilerBuildFileRule skips contents for an ignored FID', async () => {
	const calls = mockFetch({ '/api/select': () => KCGPRS_SELECT });
	const rule = await profilerBuildFileRule('MF/7F20/6F52',
		{ fid: '6f52', name: 'EF.KcGPRS' }, new Set(['6F52']), new Set(['EF.KCGPRS']));
	assert.strictEqual(rule.content, null);
	assert.strictEqual(rule.path, 'MF/7F20/6F52');
	assert.strictEqual(rule.fileType, 'transparent');
	assert.strictEqual(rule.fileSize, 9);
	assert.strictEqual(rule.name, 'EF.KcGPRS');
	assert.ok(!calls.includes('/api/read'), 'contents must not be read for ignored files');
});

test('profilerBuildFileRule skips contents when the name matches but the FID differs', async () => {
	// Regression: a KcGPRS copy at the TS 31.102 DF.GSM-ACCESS FID (4F52) must
	// still be ignored when the user checked EF.KcGPRS in the ignore list.
	const calls = mockFetch({
		'/api/select': () => ({ name: 'EF.KcGPRS', fid: '4F52', file_type: 'transparent', file_size: 9, record_len: null, num_of_rec: null, exists: true }),
	});
	const rule = await profilerBuildFileRule('MF/5F3B/4F52',
		{ fid: '4f52', name: 'EF.KcGPRS' }, new Set(['6F52']), new Set(['EF.KCGPRS']));
	assert.strictEqual(rule.content, null);
	assert.ok(!calls.includes('/api/read'), 'contents must not be read for name-matched files');
});

test('profilerBuildFileRule captures contents for non-ignored files', async () => {
	const calls = mockFetch({
		'/api/select': () => ({ name: 'EF.ADN', fid: '6F3A', file_type: 'transparent', file_size: 4, record_len: null, num_of_rec: null, exists: true }),
		'/api/read': () => ({ success: true, data: 'AABBCCDD' }),
	});
	const rule = await profilerBuildFileRule('MF/7F20/6F3A',
		{ fid: '6f3a', name: 'EF.ADN' }, new Set(['6F52']), new Set(['EF.KCGPRS']));
	assert.ok(rule.content);
	assert.strictEqual(rule.content.mode, 'exact');
	assert.strictEqual(rule.content.expected, 'AABBCCDD');
	assert.strictEqual(rule.name, 'EF.ADN');
	assert.ok(calls.includes('/api/read'));
});

test('profilerBuildFileRule falls back to the select name when the child has none', async () => {
	mockFetch({ '/api/select': () => KCGPRS_SELECT });
	const rule = await profilerBuildFileRule('MF/7F20/6F52', { fid: '6F52' }, new Set(), new Set());
	assert.strictEqual(rule.name, 'EF.KcGPRS');
});

test('profilerBuildFileRule stores null when no symbolic name is known', async () => {
	mockFetch({ '/api/select': () => ({ fid: '6F3A', file_type: 'transparent', file_size: 0, exists: true }) });
	const rule = await profilerBuildFileRule('MF/7F20/6F3A', { fid: '6F3A' }, new Set(), new Set());
	assert.strictEqual(rule.name, null);
});

test('profilerCustomNameForPath resolves saved custom file names', () => {
	global.pysimCustomFiles = [
		{ path: '3F00/7F10/6F3A', fid: '6F3A', name: 'My ADN' },
		{ path: 'MF/7F20/6F7E', fid: '6F7E', name: 'My LOCI' },
	];
	assert.strictEqual(profilerCustomNameForPath('MF/7F10/6F3A'), 'My ADN');
	assert.strictEqual(profilerCustomNameForPath('MF/7F20/6F7E'), 'My LOCI');
	assert.strictEqual(profilerCustomNameForPath('MF/7F20/6F3A'), null);
	assert.strictEqual(profilerCustomNameForPath(''), null);
	assert.strictEqual(profilerCustomNameForPath(null), null);
});

test('profilerUpdateRulePath clears the scan-time name and refreshes the label', () => {
	global.pysimCustomFiles = [{ path: 'MF/7F10/6F3A', fid: '6F3A', name: 'My ADN' }];
	global.profilerDraft = { rules: [{ path: 'MF/7F20/6F3A', name: 'EF.ADN' }] };
	const span = { textContent: '' };
	const input = { parentElement: { querySelector: () => span } };
	profilerUpdateRulePath(0, 'MF/7F10/6F3A', input);
	assert.strictEqual(global.profilerDraft.rules[0].path, 'MF/7F10/6F3A');
	assert.strictEqual(global.profilerDraft.rules[0].name, null);
	assert.strictEqual(span.textContent, 'My ADN');
	profilerUpdateRulePath(0, 'MF/7F10/6FB1', input);
	assert.strictEqual(span.textContent, '');
	global.profilerDraft = null;
	profilerUpdateRulePath(0, 'x', input);
});

test('profilerBuildFileRule still ignores when ignoreNames is omitted (back-compat)', async () => {
	const calls = mockFetch({ '/api/select': () => KCGPRS_SELECT });
	const rule = await profilerBuildFileRule('MF/7F20/6F52',
		{ fid: '6F52', name: 'EF.KcGPRS' }, new Set(['6F52']));
	assert.strictEqual(rule.content, null);
	assert.ok(!calls.includes('/api/read'));
});
