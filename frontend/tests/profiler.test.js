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

const FNS = ['profilerNormHex', 'profilerNormHexStrict', 'profilerMatch', 'profilerMatchMin', 'profilerMaskPrefix4', 'profilerFileFields', 'profilerContentKindForFileType', 'profilerEmptyRecordContent', 'profilerValidateProfile', 'profilerCustomNameForPath', 'profilerUpdateRulePath'];
let code = '';
for (const f of FNS) code += extractFunc(html, f) + '\n';
code += extractFunc(html, 'profilerBuildFileRule', true) + '\n';
code += extractFunc(html, 'profilerRunRule', true) + '\n';
code += extractFunc(html, 'profilerScanCard', true) + '\n';
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

// --- FCP/FCI verification modes ---

test('profilerNormHexStrict strips non-hex and drops wildcards', () => {
	assert.strictEqual(profilerNormHexStrict('62 10 82 02 40 21'), '621082024021');
	assert.strictEqual(profilerNormHexStrict('aabb?cc'), 'AABBCC');
	assert.strictEqual(profilerNormHexStrict(''), '');
});

test('profilerBuildFileRule stores fciMode and fciHex from the select response', async () => {
	mockFetch({ '/api/select': () => ({ ...KCGPRS_SELECT, fci_hex: '62 10 82 02 40 21' }) });
	const rule = await profilerBuildFileRule('MF/7F20/6F52',
		{ fid: '6F52', name: 'EF.KcGPRS' }, new Set(['6F52']), new Set(['EF.KCGPRS']), 'exact');
	assert.strictEqual(rule.fciMode, 'exact');
	assert.strictEqual(rule.fciHex, '62 10 82 02 40 21');
});

test('profilerBuildFileRule defaults fciMode to type_size and fciHex to null when unavailable', async () => {
	mockFetch({ '/api/select': () => KCGPRS_SELECT });
	const rule = await profilerBuildFileRule('MF/7F20/6F52',
		{ fid: '6F52', name: 'EF.KcGPRS' }, new Set(), new Set());
	assert.strictEqual(rule.fciMode, 'type_size');
	assert.strictEqual(rule.fciHex, null);
});

function runSelect(extra) {
	return { name: 'EF.ADN', fid: '6F3A', file_type: 'transparent', file_size: 4, record_len: null, num_of_rec: null, exists: true, ...(extra || {}) };
}

test('profilerRunRule in type mode skips size checks', async () => {
	mockFetch({ '/api/select': () => runSelect({ file_size: 99 }) });
	const res = await profilerRunRule({ path: 'MF/7F20/6F3A', fileType: 'transparent', fileSize: 4, fciMode: 'type' });
	assert.strictEqual(res.status, 'pass');
	assert.ok(!res.checks.some(c => c.label === 'fileSize'));
});

test('profilerRunRule in type_size mode checks size', async () => {
	mockFetch({ '/api/select': () => runSelect({ file_size: 99 }) });
	const res = await profilerRunRule({ path: 'MF/7F20/6F3A', fileType: 'transparent', fileSize: 4, fciMode: 'type_size' });
	assert.strictEqual(res.status, 'fail');
	assert.ok(res.checks.some(c => c.label === 'fileSize' && c.ok === false));
});

test('profilerRunRule legacy rule (no fciMode) still checks size', async () => {
	mockFetch({ '/api/select': () => runSelect({ file_size: 4 }) });
	const res = await profilerRunRule({ path: 'MF/7F20/6F3A', fileType: 'transparent', fileSize: 4 });
	assert.strictEqual(res.status, 'pass');
	assert.ok(res.checks.some(c => c.label === 'fileSize' && c.ok === true));
});

test('profilerRunRule exact FCI passes on byte-identical FCI', async () => {
	mockFetch({ '/api/select': () => runSelect({ fci_hex: '621082024021' }) });
	const res = await profilerRunRule({ path: 'MF/7F20/6F3A', fileType: 'transparent', fileSize: 4, fciMode: 'exact', fciHex: '62 10 82 02 40 21' });
	assert.strictEqual(res.status, 'pass');
	assert.ok(res.checks.some(c => c.label === 'fci' && c.ok === true));
});

test('profilerRunRule exact FCI fails on byte mismatch', async () => {
	mockFetch({ '/api/select': () => runSelect({ fci_hex: '621082024022' }) });
	const res = await profilerRunRule({ path: 'MF/7F20/6F3A', fileType: 'transparent', fileSize: 4, fciMode: 'exact', fciHex: '621082024021' });
	assert.strictEqual(res.status, 'fail');
	assert.ok(res.checks.some(c => c.label === 'fci' && c.ok === false));
});

test('profilerRunRule exact FCI fails when the live FCI is missing', async () => {
	mockFetch({ '/api/select': () => runSelect({ fci_hex: null }) });
	const res = await profilerRunRule({ path: 'MF/7F20/6F3A', fileType: 'transparent', fileSize: 4, fciMode: 'exact', fciHex: '621082024021' });
	assert.strictEqual(res.status, 'fail');
	assert.ok(res.checks.some(c => c.label === 'fci' && c.ok === false));
});

test('profilerValidateProfile accepts valid fciMode and rejects unknown', () => {
	assert.strictEqual(profilerValidateProfile({ name: 'x', rules: [{ type: 'file', path: 'MF/6F07', fciMode: 'type' }] }), null);
	assert.strictEqual(profilerValidateProfile({ name: 'x', rules: [{ type: 'file', path: 'MF/6F07', fciMode: 'type_size' }] }), null);
	assert.strictEqual(profilerValidateProfile({ name: 'x', rules: [{ type: 'file', path: 'MF/6F07', fciMode: 'exact' }] }), null);
	assert.strictEqual(profilerValidateProfile({ name: 'x', rules: [{ type: 'file', path: 'MF/6F07', fciMode: 'bogus' }] }), 'Invalid FCP/FCI mode: bogus');
});

// --- scan progress ---

test('profilerScanCard reports discovery total then per-file progress', async () => {
	const SEL = (fid, name) => ({ name, fid, file_type: 'transparent', file_size: 4, record_len: null, num_of_rec: null, exists: true });
	const tree = {
		MF: { exists: true, name: 'MF', children: [
			{ name: 'DF.GSM', fid: '7f20', isDir: true },
			{ name: 'EF.IMSI', fid: '6f07', isDir: false },
		] },
		'DF.GSM': { exists: true, name: 'DF.GSM', children: [
			{ name: 'EF.ADN', fid: '6f3a', isDir: false },
			{ name: 'EF.LOCI', fid: '6f7e', isDir: false },
		] },
	};
	global.pysimCustomFiles = [{ path: 'MF/7F10/6F3A', fid: '6F3A', name: 'My ADN' }];
	global.pysimFetch = async (path, body) => {
		if (path === '/api/tree') {
			const key = body.name === 'DF.GSM' ? 'DF.GSM' : 'MF';
			return tree[key];
		}
		if (path === '/api/select') {
			const fid = body.path.split('/').pop();
			return SEL(fid, 'EF.' + fid);
		}
		throw new Error('unexpected fetch: ' + path);
	};

	const progress = [];
	const rules = await profilerScanCard(new Set(), new Set(), 'type', (done, total, path) => {
		progress.push([done, total, path]);
	});

	assert.strictEqual(rules.length, 4);
	// initial 0/total report
	assert.deepStrictEqual(progress[0], [0, 4, '']);
	// then 1..4 with the file path, in scan order
	assert.strictEqual(progress.length, 5);
	assert.strictEqual(progress[4][0], 4);
	assert.strictEqual(progress[4][1], 4);
	const paths = progress.slice(1).map(p => p[2]);
	assert.deepStrictEqual(paths, ['MF/7F20/6F3A', 'MF/7F20/6F7E', 'MF/6F07', 'MF/7F10/6F3A']);
});

test('profilerScanCard without onProgress still works (back-compat)', async () => {
	global.pysimCustomFiles = [];
	global.pysimFetch = async (path, body) => {
		if (path === '/api/tree') return { exists: true, name: 'MF', children: [{ name: 'EF.IMSI', fid: '6f07', isDir: false }] };
		if (path === '/api/select') return { name: 'EF.IMSI', fid: '6F07', file_type: 'transparent', file_size: 9, record_len: null, num_of_rec: null, exists: true };
		throw new Error('unexpected fetch: ' + path);
	};
	const rules = await profilerScanCard(new Set(), new Set(), 'type_size');
	assert.strictEqual(rules.length, 1);
});
