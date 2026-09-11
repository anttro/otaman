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

const FNS = ['profilerNormHex', 'profilerNormHexStrict', 'profilerMatch', 'profilerMatchMin', 'profilerMaskPrefix4', 'profilerFileFields', 'profilerContentKindForFileType', 'profilerEmptyRecordContent', 'profilerValidateProfile', 'profilerCustomNameForPath', 'profilerUpdateRulePath', 'profilerResultAspects', 'profilerAspectSummary', 'profilerNumRanges', 'esc', 'escHtml', 'profilerRawDataCheck', 'profilerRenderReport', 'parseBerLen', 'parseTlvList', 'fcpInt', 'fcpParseTlvs', 'fcpFileDescriptor', 'fcpLifeCycle', 'fcpSfi', 'fcpDo', 'fcpDecode', 'fcpDiffHtml', 'profilerFciPreviewItems', 'profilerUpdateFciPreview', 'profilerUpdateRule', 'profilerFciInput', 'profilerScanToggleAll', 'profilerScanIgnoreAllState', 'swapNibbles', 'decIccid', 'profilerSnapshotIccid', 'profilerValidateSnapshot', 'profilerListSwitch', 'profilerScanRefreshOptions', 'profilerLiveSource', 'profilerSnapshotSource', 'profilerVisibleResults'];
let code = '';
for (const f of FNS) code += extractFunc(html, f) + '\n';
code += extractFunc(html, 'profilerBuildFileRule', true) + '\n';
code += extractFunc(html, 'profilerRunRule', true) + '\n';
code += extractFunc(html, 'profilerScanCard', true) + '\n';
code += extractFunc(html, 'profilerBuildSnapshotFile', true) + '\n';
code += "var _scanTarget = 'profile';\n";
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
	return [...raw.matchAll(/\{ fid: '([^']*)', name: '([^']*)'(?:, checked: (true|false))? \}/g)]
		.map(m => ({ fid: m[1], name: m[2], checked: m[3] !== 'false' }));
}

test('ignore list FIDs are well-formed and KcGPRS uses the TS 51.011 FID (6F52)', () => {
	const files = parseIgnoreFiles();
	assert.ok(files.length >= 16);
	for (const f of files) {
		assert.match(f.fid, /^[0-9A-F]{4}$/, f.name + ' has a malformed FID');
		assert.ok(f.name.startsWith('EF.'), f.fid + ' has a malformed name');
	}
	assert.strictEqual(files.find(f => f.name === 'EF.KcGPRS').fid, '6F52');
	assert.strictEqual(files.find(f => f.name === 'EF.ACC').fid, '6F78');
	assert.strictEqual(files.find(f => f.name === 'EF.EPSNSC').fid, '6FE4');
	assert.strictEqual(files.find(f => f.name === 'EF.START-HFN').fid, '6F5B');
	assert.strictEqual(files.find(f => f.name === 'EF.ARR').fid, '2F06');
});

test('ignore list checks every file by default except EF.ARR', () => {
	const files = parseIgnoreFiles();
	for (const f of files) {
		assert.strictEqual(f.checked, f.name !== 'EF.ARR', f.name + ' default-checked mismatch');
	}
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

// --- mask first 4 bytes (EF.IMSI / EF.ICCID) ---

const IMSI_SELECT = { name: 'EF.IMSI', fid: '6F07', file_type: 'transparent', file_size: 9, record_len: null, num_of_rec: null, exists: true };
const IMSI_DATA = '082905911234567890';

test('profilerBuildFileRule masks first 4 bytes when the FID is in maskFids', async () => {
	mockFetch({ '/api/select': () => IMSI_SELECT, '/api/read': () => ({ success: true, data: IMSI_DATA }) });
	const rule = await profilerBuildFileRule('MF/6F07', { fid: '6F07', name: 'EF.IMSI' }, new Set(), new Set(), 'type_size', new Set(['6F07']));
	assert.strictEqual(rule.content.mode, 'mask');
	assert.strictEqual(rule.content.expected, '08290591??????????');
});

test('profilerBuildFileRule uses exact contents when maskFids does not contain the FID', async () => {
	mockFetch({ '/api/select': () => IMSI_SELECT, '/api/read': () => ({ success: true, data: IMSI_DATA }) });
	const rule = await profilerBuildFileRule('MF/6F07', { fid: '6F07', name: 'EF.IMSI' }, new Set(), new Set(), 'type_size', new Set());
	assert.strictEqual(rule.content.mode, 'exact');
	assert.strictEqual(rule.content.expected, IMSI_DATA);
});

test('profilerBuildFileRule keeps the legacy mask default when maskFids is omitted', async () => {
	mockFetch({ '/api/select': () => IMSI_SELECT, '/api/read': () => ({ success: true, data: IMSI_DATA }) });
	const rule = await profilerBuildFileRule('MF/6F07', { fid: '6F07', name: 'EF.IMSI' }, new Set(), new Set(), 'type_size');
	assert.strictEqual(rule.content.mode, 'mask');
	assert.strictEqual(rule.content.expected, '08290591??????????');
});

test('profilerScanCard threads maskFids through to rule building', async () => {
	global.pysimCustomFiles = [];
	global.pysimFetch = async (path, body) => {
		if (path === '/api/tree') return { exists: true, name: 'MF', children: [{ name: 'EF.IMSI', fid: '6f07', isDir: false }] };
		if (path === '/api/select') return IMSI_SELECT;
		if (path === '/api/read') return { success: true, data: IMSI_DATA };
		throw new Error('unexpected fetch: ' + path);
	};
	const rules = await profilerScanCard(new Set(), new Set(), 'type_size', undefined, new Set());
	assert.strictEqual(rules.length, 1);
	assert.strictEqual(rules[0].content.mode, 'exact');
	assert.strictEqual(rules[0].content.expected, IMSI_DATA);
});

// --- result report (aspects, summary, matching records) ---

test('profilerNumRanges compresses consecutive record numbers', () => {
	assert.strictEqual(profilerNumRanges([]), '');
	assert.strictEqual(profilerNumRanges([1]), '1');
	assert.strictEqual(profilerNumRanges([1, 2, 3, 4, 5, 7, 8, 9, 10]), '1-5, 7-10');
	assert.strictEqual(profilerNumRanges([1, 3, 5]), '1, 3, 5');
	assert.strictEqual(profilerNumRanges([7, 8, 1, 2]), '1-2, 7-8');
	assert.strictEqual(profilerNumRanges([6]), '6');
});

test('profilerResultAspects groups checks and lets Exact FCI subsume type/size', () => {
	assert.deepStrictEqual(
		profilerResultAspects({ checks: [
			{ label: 'fileType', ok: true }, { label: 'fileSize', ok: true }, { label: 'content', ok: true },
		] }),
		[{ key: 'filetype', ok: true }, { key: 'size', ok: true }, { key: 'contents', ok: true }]);
	assert.deepStrictEqual(
		profilerResultAspects({ checks: [
			{ label: 'fileType', ok: true }, { label: 'fileSize', ok: true }, { label: 'fci', ok: false }, { label: 'content', ok: true },
		] }),
		[{ key: 'Exact FCI', ok: false }, { key: 'contents', ok: true }]);
	assert.deepStrictEqual(
		profilerResultAspects({ checks: [
			{ label: 'recordLen', ok: true }, { label: 'numRecords', ok: false },
		] }),
		[{ key: 'records', ok: false }]);
	assert.deepStrictEqual(profilerResultAspects({ checks: [{ label: 'exists', ok: true }] }), []);
});

test('profilerAspectSummary renders plain list when nothing failed', () => {
	const tr = s => s;
	assert.strictEqual(
		profilerAspectSummary([{ key: 'filetype', ok: true }, { key: 'size', ok: true }, { key: 'contents', ok: true }], false, tr),
		'filetype and size, contents');
	assert.strictEqual(
		profilerAspectSummary([{ key: 'filetype', ok: true }, { key: 'records', ok: true }, { key: 'contents', ok: true }], false, tr),
		'filetype and records, contents');
	assert.strictEqual(
		profilerAspectSummary([{ key: 'Exact FCI', ok: true }, { key: 'contents', ok: true }], false, tr),
		'Exact FCI, contents');
	assert.strictEqual(profilerAspectSummary([{ key: 'filetype', ok: true }], false, tr), 'filetype');
	assert.strictEqual(profilerAspectSummary([], false, tr), '');
});

test('profilerAspectSummary marks per-aspect when mixed', () => {
	const tr = s => s;
	assert.strictEqual(
		profilerAspectSummary([{ key: 'filetype', ok: true }, { key: 'size', ok: false }, { key: 'contents', ok: true }], true, tr),
		'filetype ✓, size ✗, contents ✓');
	assert.strictEqual(
		profilerAspectSummary([{ key: 'Exact FCI', ok: false }, { key: 'contents', ok: true }], true, tr),
		'Exact FCI ✗, contents ✓');
});

test('profilerRunRule records which records matched on a record mismatch', async () => {
	mockFetch({
		'/api/select': () => ({ name: 'EF.X', fid: '6F3A', file_type: 'linear_fixed', file_size: null, record_len: 2, num_of_rec: 3, exists: true }),
		'/api/read': () => ({ success: true, records: [{ num: 1, data: 'AA' }, { num: 2, data: 'XX' }, { num: 3, data: 'CC' }] }),
	});
	const res = await profilerRunRule({
		path: 'MF/7F20/6F3A', fileType: 'linear_fixed', recordLen: 2, numRecords: 3, fciMode: 'type_size',
		content: { mode: 'exact', kind: 'record', records: [{ num: 1, data: 'AA' }, { num: 2, data: 'BB' }, { num: 3, data: 'CC' }] },
	});
	assert.strictEqual(res.status, 'fail');
	assert.strictEqual(res.recordsMismatch, true);
	assert.deepStrictEqual(res.recordsMatched, [1, 3]);
});

const REC_SELECT_10 = { name: 'EF.X', fid: '6F3A', file_type: 'linear_fixed', file_size: null, record_len: 2, num_of_rec: 10, exists: true };
const REC_EXP_30 = (() => { const r = []; for (let i = 1; i <= 30; i++) r.push({ num: i, data: 'AB' }); return r; })();
const REC_ACT_10 = (() => { const r = []; for (let i = 1; i <= 10; i++) r.push({ num: i, data: 'AB' }); return r; })();

test('record count mismatch is reported once when numRecords is checked', async () => {
	mockFetch({ '/api/select': () => REC_SELECT_10, '/api/read': () => ({ success: true, records: REC_ACT_10 }) });
	const res = await profilerRunRule({
		path: 'MF/7F20/6F3A', fileType: 'linear_fixed', recordLen: 2, numRecords: 30, fciMode: 'type_size',
		content: { mode: 'exact', kind: 'record', records: REC_EXP_30 },
	});
	assert.strictEqual(res.status, 'fail');
	assert.ok(res.checks.some(c => c.label === 'numRecords' && c.ok === false));
	assert.ok(!res.checks.some(c => c.label === 'content.records'));
	assert.strictEqual(res.recordsMismatch, true);
	assert.deepStrictEqual(res.recordsMatched, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	global.t = s => s;
	global.pysimCustomFiles = [];
	const report = profilerRenderReport([res]);
	assert.ok(report.includes('matching records: 1-10'), report);
	delete global.t;
});

test('record count mismatch keeps content.records when numRecords is not checked (type mode)', async () => {
	mockFetch({ '/api/select': () => REC_SELECT_10, '/api/read': () => ({ success: true, records: REC_ACT_10 }) });
	const res = await profilerRunRule({
		path: 'MF/7F20/6F3A', fileType: 'linear_fixed', recordLen: 2, numRecords: 30, fciMode: 'type',
		content: { mode: 'exact', kind: 'record', records: REC_EXP_30 },
	});
	assert.strictEqual(res.status, 'fail');
	assert.ok(res.checks.some(c => c.label === 'content.records' && c.ok === false));
	assert.ok(!res.checks.some(c => c.label === 'numRecords'));
});

test('record count mismatch keeps content.records when numRecords passes but read differs', async () => {
	mockFetch({
		'/api/select': () => ({ ...REC_SELECT_10, num_of_rec: 3 }),
		'/api/read': () => ({ success: true, records: REC_ACT_10.slice(0, 2) }),
	});
	const res = await profilerRunRule({
		path: 'MF/7F20/6F3A', fileType: 'linear_fixed', recordLen: 2, numRecords: 3, fciMode: 'type_size',
		content: { mode: 'exact', kind: 'record', records: [{ num: 1, data: 'AB' }, { num: 2, data: 'AB' }, { num: 3, data: 'AB' }] },
	});
	assert.strictEqual(res.status, 'fail');
	assert.ok(res.checks.some(c => c.label === 'numRecords' && c.ok === true));
	assert.ok(res.checks.some(c => c.label === 'content.records' && c.ok === false));
});

test('profilerRenderReport includes the checked-aspects summary and matching-record note', () => {
	global.t = s => s;
	global.pysimCustomFiles = [];
	const html = profilerRenderReport([
		{ path: 'MF/7F20/6F3F', name: 'EF.GID2', status: 'pass', checks: [
			{ label: 'fileType', ok: true }, { label: 'fileSize', ok: true }, { label: 'content', ok: true },
		] },
		{ path: 'MF/7F20/6F3A', name: 'EF.X', status: 'fail', checks: [
			{ label: 'fileType', ok: true }, { label: 'fileSize', ok: false, expected: 4, actual: 99 }, { label: 'content', ok: true },
		] },
		{ path: 'MF/7F20/6F4E', name: 'EF.Y', status: 'fail', checks: [
			{ label: 'content.rec6', ok: false, expected: 'BB', actual: 'XX' },
			{ label: 'content.rec1', ok: true }, { label: 'content.rec2', ok: true }, { label: 'content.rec5', ok: true },
		], recordsMatched: [1, 2, 5] },
	]);
	assert.ok(html.includes('filetype and size, contents'));
	assert.ok(html.includes('filetype ✓, size ✗, contents ✓'));
	assert.ok(html.includes('matching records'));
	assert.ok(html.includes('1-2, 5'));
	delete global.t;
});

test('profilerRawDataCheck identifies raw-data checks', () => {
	assert.strictEqual(profilerRawDataCheck({ label: 'fci' }), true);
	assert.strictEqual(profilerRawDataCheck({ label: 'content', expected: 'AABBCC' }), true);
	assert.strictEqual(profilerRawDataCheck({ label: 'content.rec3' }), true);
	assert.strictEqual(profilerRawDataCheck({ label: 'content', expected: 'readable' }), false);
	assert.strictEqual(profilerRawDataCheck({ label: 'content.records' }), false);
	assert.strictEqual(profilerRawDataCheck({ label: 'fileSize' }), false);
});

test('profilerRenderReport renders raw-data mismatches as aligned readonly fields', () => {
	global.t = s => s;
	global.pysimCustomFiles = [];
	const html = profilerRenderReport([
		{ path: 'MF/6F07', name: 'EF.IMSI', status: 'fail', checks: [
			{ label: 'fci', ok: false, expected: '621082024021', actual: '621082024022' },
		] },
		{ path: 'MF/7F20/6F3A', name: 'EF.X', status: 'fail', checks: [
			{ label: 'content.records', ok: false, expected: '30 records', actual: '10 records' },
		] },
	]);
	const fciBlock = html.split('</div>').find(s => s.includes('621082024021'));
	assert.ok(html.includes('readonly'));
	assert.ok((html.match(/readonly/g) || []).length >= 2);
	assert.ok(html.includes('font-mono'));
	assert.ok(html.includes('value="621082024021"'));
	assert.ok(html.includes('value="621082024022"'));
	assert.ok(html.includes('w-24 text-right'));
	// non-raw check stays inline
	assert.ok(html.includes('content.records: expected'));
	assert.ok(!fciBlock.includes(': expected'));
	delete global.t;
});

// --- FCP/FCI decoding (ISO 7816-4 5.3.3, TS 102 221 11.1.1.4) ---

const FCP_TRANSPARENT = '6212800200098202412183026F078A0105880110';
const FCP_LINFIX = '620E82054221006E0583026F3A8A0105';
const FCP_DF = '620B8202782183027F208A0105';
const FCP_BERTLV = '620B8202792183026F018A0105';

test('fcpDecode decodes a transparent EF FCP template', () => {
	const d = fcpDecode(FCP_TRANSPARENT);
	assert.strictEqual(d.ok, true);
	assert.strictEqual(d.template, '62');
	const by = {};
	d.items.forEach(it => { by[it.key] = it; });
	assert.strictEqual(by['80'].decoded, '9 bytes');
	assert.strictEqual(by['82'].decoded, 'not shareable, working EF, transparent, data coding 21');
	assert.strictEqual(by['83'].decoded, '6F07');
	assert.strictEqual(by['8A'].decoded, 'operational, activated');
	assert.strictEqual(by['88'].decoded, '2');
});

test('fcpDecode decodes linear fixed file descriptor (record length/count)', () => {
	const d = fcpDecode(FCP_LINFIX);
	assert.strictEqual(d.ok, true);
	const fd = d.items.find(it => it.key === '82');
	assert.strictEqual(fd.decoded, 'not shareable, working EF, linear fixed, data coding 21, record length 110, 5 records');
});

test('fcpDecode decodes DF and BER-TLV structures', () => {
	assert.strictEqual(fcpDecode(FCP_DF).items.find(it => it.key === '82').decoded, 'not shareable, DF/ADF, data coding 21');
	assert.strictEqual(fcpDecode(FCP_BERTLV).items.find(it => it.key === '82').decoded, 'not shareable, BER-TLV EF, data coding 21');
});

test('fcpDecode maps life cycle status per table 11.7b', () => {
	const lcs = v => fcpDecode('6207820278218A01' + v).items.find(it => it.key === '8A').decoded;
	assert.strictEqual(lcs('00'), 'no information');
	assert.strictEqual(lcs('01'), 'creation');
	assert.strictEqual(lcs('03'), 'initialization');
	assert.strictEqual(lcs('05'), 'operational, activated');
	assert.strictEqual(lcs('04'), 'operational, deactivated');
	assert.strictEqual(lcs('0C'), 'termination');
	assert.strictEqual(lcs('0D'), 'termination');
	assert.strictEqual(lcs('80'), 'proprietary (80)');
});

test('fcpDecode decodes A5 proprietary sub-TLVs', () => {
	const d = fcpDecode('62128202412183026F078A0105A5058503000000');
	const by = {};
	d.items.forEach(it => { by[it.key] = it; });
	assert.strictEqual(by['A5'].decoded, null);
	assert.strictEqual(by['A5/85'].decoded, '0 bytes');
});

test('fcpDecode unwraps an FCI 6F template and rejects malformed input', () => {
	const d = fcpDecode('6F146212800200098202412183026F078A0105880110');
	assert.strictEqual(d.ok, true);
	assert.strictEqual(d.template, '62');
	assert.strictEqual(d.items.find(it => it.key === '80').decoded, '9 bytes');

	assert.strictEqual(fcpDecode('').ok, false);
	assert.strictEqual(fcpDecode('ZZZZ').ok, false);
	assert.strictEqual(fcpDecode('6214800200098202412183').ok, false); // truncated
	assert.strictEqual(fcpDecode('6213' + FCP_TRANSPARENT.slice(4)).ok, false); // wrong outer length
});

test('fcpDecode accepts long-form BER lengths (81/82) — editor preview regression', () => {
	// 62 12 <18B> vs 62 81 12 <same content>
	const long81 = '628112' + FCP_TRANSPARENT.slice(4);
	const d1 = fcpDecode(long81);
	assert.strictEqual(d1.ok, true);
	assert.strictEqual(d1.items.find(it => it.key === '80').decoded, '9 bytes');

	// 2-byte length form
	const d2 = fcpDecode('62820004' + '80020009');
	assert.strictEqual(d2.ok, true);
	assert.strictEqual(d2.items.find(it => it.key === '80').decoded, '9 bytes');

	// nested A5 with a long-form length (A5 81 05 …)
	const d3 = fcpDecode('62138202412183026F078A0105A581058503000000');
	assert.strictEqual(d3.ok, true);
	assert.strictEqual(d3.items.find(it => it.key === 'A5/85').decoded, '0 bytes');

	// FCP content >= 128 bytes uses a long-form outer length
	let big = '';
	for (let i = 0; i < 13; i++) big += '8808' + '0102030405060708'; // 13 x 10B = 130B
	const d4 = fcpDecode('628182' + big);
	assert.strictEqual(d4.ok, true);
	assert.strictEqual(d4.items.filter(it => it.key === '88').length, 13);

	global.t = s => s;
	assert.ok(profilerFciPreviewItems(long81).includes('File size: '));
	delete global.t;
});

test('fcpDiffHtml highlights differing FCI parameters', () => {
	global.t = s => s;
	const same = fcpDiffHtml(FCP_TRANSPARENT, FCP_TRANSPARENT);
	assert.ok(same.includes('File size'));
	assert.ok(!same.includes('text-red-600'));
	const diff = fcpDiffHtml(FCP_TRANSPARENT, '62128002000A8202412183026F078A0105880110');
	assert.ok(diff.includes('9 bytes'));
	assert.ok(diff.includes('10 bytes'));
	assert.ok(diff.includes('text-red-600'));
	assert.ok(fcpDiffHtml('garbage', FCP_TRANSPARENT).includes('Truncated length field'));
	assert.strictEqual(fcpDiffHtml('', ''), '');
	delete global.t;
});

test('profilerFciPreviewItems renders decoded items and degrades gracefully', () => {
	global.t = s => s;
	assert.ok(profilerFciPreviewItems(FCP_TRANSPARENT).includes('File size: '));
	assert.ok(profilerFciPreviewItems('not hex').includes('Decode failed'));
	assert.strictEqual(profilerFciPreviewItems(''), '');
	delete global.t;
});

test('profilerFciInput stores the edited FCI and re-decodes the preview', () => {
	global.t = s => s;
	global.profilerDraft = { rules: [{ fciHex: '', fciMode: 'exact' }] };
	const el = { innerHTML: '' };
	global.document = { getElementById: id => (id === 'profiler-fci-preview-0' ? el : null) };
	profilerFciInput(0, FCP_TRANSPARENT);
	assert.strictEqual(global.profilerDraft.rules[0].fciHex, FCP_TRANSPARENT);
	assert.ok(el.innerHTML.includes('File size: '));
	profilerFciInput(0, 'zz');
	assert.strictEqual(el.innerHTML, '');
	global.profilerDraft = null;
	delete global.document;
	delete global.t;
});

test('profilerRenderReport shows the decoded FCI diff for a raw fci mismatch', () => {
	global.t = s => s;
	global.pysimCustomFiles = [];
	const html = profilerRenderReport([
		{ path: 'MF/6F07', name: 'EF.IMSI', status: 'fail', checks: [
			{ label: 'fci', ok: false, expected: FCP_TRANSPARENT, actual: '62128002000A8202412183026F078A0105880110' },
		] },
	]);
	assert.ok(html.includes('FCI parameters'));
	assert.ok(html.includes('9 bytes'));
	assert.ok(html.includes('10 bytes'));
	assert.ok(html.includes('text-red-600'));
	delete global.t;
});

// --- partial/corrupt FCI decoding ---

test('fcpDecode reports truncation but keeps the TLVs parsed before it', () => {
	// outer declares 22 bytes (0x16) but only the 18-byte body is present
	const truncOuter = '6216' + FCP_TRANSPARENT.slice(4);
	const d1 = fcpDecode(truncOuter);
	assert.strictEqual(d1.ok, false);
	assert.match(d1.error, /TLV 62 declares 22 bytes, only 18 available/);
	assert.strictEqual(d1.items.find(it => it.key === '80').decoded, '9 bytes');

	// correct outer length, truncated inner TLV (82 declares 5 bytes, 2 present)
	const d2 = fcpDecode('620880020009820541 21'.replace(/ /g, ''));
	assert.strictEqual(d2.ok, false);
	assert.match(d2.error, /TLV 82 declares 5 bytes, only 2 available/);
	assert.strictEqual(d2.items.find(it => it.key === '80').decoded, '9 bytes');
	assert.ok(!d2.items.some(it => it.key === '82'));

	// truncated length field
	const d3 = fcpDecode('6281');
	assert.strictEqual(d3.ok, false);
	assert.match(d3.error, /truncated length field/);
	assert.strictEqual(d3.items.length, 0);

	// truncated inner A5 sub-TLV reports the context
	const d4 = fcpDecode('620A82024121A50488050102');
	assert.strictEqual(d4.ok, false);
	assert.match(d4.error, /In A5: TLV 88 declares 5 bytes, only 2 available/);
});

test('profilerFciPreviewItems shows decoded data plus an explicit failure note', () => {
	global.t = s => s;
	const trunc = '6216' + FCP_TRANSPARENT.slice(4);
	const html = profilerFciPreviewItems(trunc);
	assert.ok(html.includes('File size: '), html);
	assert.ok(html.includes('Decode failed'), html);
	assert.ok(html.includes('declares 22 bytes'), html);
	// empty input renders nothing; garbage reports the failure
	assert.strictEqual(profilerFciPreviewItems(''), '');
	assert.ok(profilerFciPreviewItems('not hex').includes('Decode failed'));
	delete global.t;
});

test('fcpDiffHtml appends decode-failure notes for corrupt sides', () => {
	global.t = s => s;
	const trunc = '6216' + FCP_TRANSPARENT.slice(4);
	const html = fcpDiffHtml(trunc, FCP_TRANSPARENT);
	assert.ok(html.includes('FCI parameters'), html);
	assert.ok(html.includes('9 bytes'));
	assert.ok(html.includes('expected: ') && html.includes('TLV 62 declares 22 bytes'));
	// both sides empty -> nothing rendered
	assert.strictEqual(fcpDiffHtml('', ''), '');
	delete global.t;
});

test('profilerScanToggleAll / profilerScanIgnoreAllState manage the ignore checkboxes', () => {
	const boxes = [{ checked: true }, { checked: false }, { checked: true }];
	const header = { checked: false, indeterminate: false };
	global.document = {
		querySelectorAll: sel => (sel === '#profiler-scan-ignore input[data-ignore-fid]' ? boxes : []),
		getElementById: id => (id === 'profiler-scan-ignore-all' ? header : null),
	};

	profilerScanIgnoreAllState();
	assert.strictEqual(header.checked, false);
	assert.strictEqual(header.indeterminate, true);

	boxes[1].checked = true;
	profilerScanIgnoreAllState();
	assert.strictEqual(header.checked, true);
	assert.strictEqual(header.indeterminate, false);

	profilerScanToggleAll(false);
	assert.ok(boxes.every(b => !b.checked));
	profilerScanIgnoreAllState();
	assert.strictEqual(header.checked, false);
	assert.strictEqual(header.indeterminate, false);

	profilerScanToggleAll(true);
	assert.ok(boxes.every(b => b.checked));
	profilerScanIgnoreAllState();
	assert.strictEqual(header.checked, true);
	assert.strictEqual(header.indeterminate, false);

	delete global.document;
});

// --- card snapshots ---

test('decIccid decodes nibble-swapped EF.ICCID digits and strips F padding', () => {
	assert.strictEqual(decIccid('980711090000640090F8'), '8970119000004600098');
	assert.strictEqual(decIccid('98103254769810325476'), '89012345678901234567');
	assert.strictEqual(decIccid('98 07 11 09 00 00 64 00 90 f8'), '8970119000004600098');
	assert.strictEqual(decIccid(''), '');
});

test('profilerSnapshotIccid finds EF.ICCID by name or FID and handles null cases', () => {
	const hex = '980711090000640090F8';
	assert.strictEqual(
		profilerSnapshotIccid([{ path: 'MF/2FE2', name: 'EF.ICCID', content: { kind: 'transparent', data: hex } }]),
		'8970119000004600098');
	assert.strictEqual(
		profilerSnapshotIccid([{ path: 'MF/6F07', name: 'x', content: { kind: 'transparent', data: hex } }]),
		null);
	assert.strictEqual(
		profilerSnapshotIccid([{ path: 'MF/2FE2', name: 'EF.ICCID', content: null }]),
		null);
	assert.strictEqual(profilerSnapshotIccid([]), null);
});

test('profilerValidateSnapshot checks name and files array', () => {
	assert.strictEqual(profilerValidateSnapshot(null), 'Not an object');
	assert.strictEqual(profilerValidateSnapshot({ name: 'x' }), 'Missing files array');
	assert.strictEqual(profilerValidateSnapshot({ name: 'x', files: 'nope' }), 'Missing files array');
	assert.strictEqual(profilerValidateSnapshot({ files: [] }), 'Missing name');
	assert.strictEqual(profilerValidateSnapshot({ name: 'x', files: [null] }), 'Invalid file entry');
	assert.strictEqual(profilerValidateSnapshot({ name: 'x', files: [{}] }), 'File entry missing path');
	assert.strictEqual(profilerValidateSnapshot({ name: 'x', files: [{ path: 'MF/6F07' }] }), null);
});

test('profilerBuildSnapshotFile captures exact contents for everything readable', async () => {
	// transparent file (IMSI) is captured exactly, no mask
	mockFetch({
		'/api/select': () => ({ name: 'EF.IMSI', fid: '6F07', file_type: 'transparent', file_size: 9, record_len: null, num_of_rec: null, fci_hex: '6212', exists: true }),
		'/api/read': () => ({ success: true, data: '082905911234567890' }),
	});
	const f = await profilerBuildSnapshotFile('MF/6F07', { fid: '6f07', name: 'EF.IMSI' });
	assert.strictEqual(f.name, 'EF.IMSI');
	assert.strictEqual(f.fileType, 'transparent');
	assert.strictEqual(f.fileSize, 9);
	assert.strictEqual(f.fciHex, '6212');
	assert.deepStrictEqual(f.content, { kind: 'transparent', data: '082905911234567890' });

	// record file
	mockFetch({
		'/api/select': () => ({ name: 'EF.ADN', fid: '6F3A', file_type: 'linear_fixed', file_size: null, record_len: 2, num_of_rec: 2, fci_hex: '620E', exists: true }),
		'/api/read': () => ({ success: true, records: [{ num: 1, data: 'AA' }, { num: 2, data: 'BB' }] }),
	});
	const r = await profilerBuildSnapshotFile('MF/7F20/6F3A', { fid: '6F3A', name: 'EF.ADN' });
	assert.strictEqual(r.recordLen, 2);
	assert.strictEqual(r.numRecords, 2);
	assert.deepStrictEqual(r.content, { kind: 'record', records: [{ num: 1, data: 'AA' }, { num: 2, data: 'BB' }] });

	// unreadable -> content null, metadata kept
	mockFetch({
		'/api/select': () => ({ name: 'EF.Kc', fid: '6F20', file_type: 'transparent', file_size: 9, record_len: null, num_of_rec: null, fci_hex: '620A', exists: true }),
		'/api/read': () => ({ success: false, sw: '6982' }),
	});
	const u = await profilerBuildSnapshotFile('MF/7F20/6F20', { fid: '6F20', name: 'EF.Kc' });
	assert.strictEqual(u.content, null);
	assert.strictEqual(u.fileSize, 9);
});

test('profilerScanCard snapshot mode builds snapshot entries with ICCID', async () => {
	global.pysimCustomFiles = [];
	global.pysimFetch = async (path, body) => {
		if (path === '/api/tree') return { exists: true, name: 'MF', children: [
			{ name: 'EF.ICCID', fid: '2fe2', isDir: false },
			{ name: 'EF.IMSI', fid: '6f07', isDir: false },
		] };
		if (path === '/api/select') {
			const fid = body.path.split('/').pop();
			if (fid === '2FE2') return { name: 'EF.ICCID', fid: '2FE2', file_type: 'transparent', file_size: 10, record_len: null, num_of_rec: null, fci_hex: '620E', exists: true };
			return { name: 'EF.IMSI', fid: '6F07', file_type: 'transparent', file_size: 9, record_len: null, num_of_rec: null, fci_hex: '6212', exists: true };
		}
		if (path === '/api/read') {
			return body.path.endsWith('2FE2')
				? { success: true, data: '980711090000640090F8' }
				: { success: true, data: '082905911234567890' };
		}
		throw new Error('unexpected ' + path);
	};
	const files = await profilerScanCard(new Set(), new Set(), 'exact', undefined, new Set(), 'snapshot');
	assert.strictEqual(files.length, 2);
	assert.ok(!files[0].fciMode, 'snapshot entries carry no FCI mode');
	assert.strictEqual(profilerSnapshotIccid(files), '8970119000004600098');
	// IMSI captured exactly (no mask)
	assert.strictEqual(files.find(f => f.name === 'EF.IMSI').content.data, '082905911234567890');
	delete global.pysimCustomFiles;
});

test('profilerListSwitch toggles the profiles/snapshots tabs', () => {
	const mkBtn = tab => ({
		dataset: { listTab: tab },
		classList: { _c: new Set(), toggle(c, on) { if (on) this._c.add(c); else this._c.delete(c); } },
	});
	const btns = [mkBtn('profiles'), mkBtn('snapshots')];
	const profilesEl = { hidden: false, classList: { toggle(cls, on) { profilesEl.hidden = on; } } };
	const snapsEl = { hidden: true, classList: { toggle(cls, on) { snapsEl.hidden = on; } } };
	global.document = {
		querySelectorAll: sel => (sel === '.profiler-list-tab' ? btns : []),
		getElementById: id => (id === 'profiler-list-profiles' ? profilesEl : id === 'profiler-list-snapshots' ? snapsEl : null),
	};

	profilerListSwitch('snapshots');
	assert.strictEqual(profilesEl.hidden, true);
	assert.strictEqual(snapsEl.hidden, false);
	assert.ok(btns[0].classList._c.has('bg-gray-200'));
	assert.ok(btns[1].classList._c.has('bg-blue-600'));

	profilerListSwitch('profiles');
	assert.strictEqual(profilesEl.hidden, false);
	assert.strictEqual(snapsEl.hidden, true);
	assert.ok(btns[0].classList._c.has('bg-blue-600'));
	assert.ok(btns[1].classList._c.has('bg-gray-200'));

	delete global.document;
});

test('profilerScanRefreshOptions re-translates mask labels without touching checkbox state', () => {
	global.t = s => (s === 'Match first 4 bytes for' ? 'FIRST4' : s);
	const span = { textContent: '' };
	const cb = {
		checked: true,
		parentElement: { querySelector: sel => (sel === 'span' ? span : null) },
		getAttribute: () => '6F07',
	};
	global.document = {
		querySelectorAll: sel => (sel === '#profiler-scan-mask input[data-mask-fid]' ? [cb] : []),
	};
	profilerScanRefreshOptions();
	assert.strictEqual(span.textContent, 'FIRST4 EF.IMSI');
	assert.strictEqual(cb.checked, true);
	delete global.document;
	delete global.t;
});


function snapFile(path, extra) {
	return {
		path: path, name: 'EF.X', fileType: 'transparent', fileSize: 4,
		recordLen: null, numRecords: null, fciHex: '621082024021',
		content: { kind: 'transparent', data: 'AABB' }, ...(extra || {}),
	};
}

test('profilerSnapshotSource selects file metadata by path (case-insensitive)', async () => {
	const src = profilerSnapshotSource({ files: [snapFile('MF/7F20/6F3A')] });
	const sel = await src.select('mf/7f20/6f3a');
	assert.strictEqual(sel.exists, true);
	assert.strictEqual(sel.file_type, 'transparent');
	assert.strictEqual(sel.file_size, 4);
	assert.strictEqual(sel.fci_hex, '621082024021');
});

test('profilerSnapshotSource reports a missing file as not existing', async () => {
	const src = profilerSnapshotSource({ files: [snapFile('MF/7F20/6F3A')] });
	assert.deepStrictEqual(await src.select('MF/6F07'), { exists: false });
});

test('profilerSnapshotSource read returns captured transparent data and records', async () => {
	const src = profilerSnapshotSource({ files: [
		snapFile('MF/6F3A'),
		snapFile('MF/6F3B', { fileType: 'linear_fixed', fileSize: null, recordLen: 2, numRecords: 1, content: { kind: 'record', records: [{ num: 1, data: 'AABB' }] } }),
	] });
	assert.strictEqual((await src.read('MF/6F3A')).data, 'AABB');
	assert.deepStrictEqual((await src.read('MF/6F3B')).records, [{ num: 1, data: 'AABB' }]);
});

test('profilerSnapshotSource flags uncaptured contents', async () => {
	const src = profilerSnapshotSource({ files: [snapFile('MF/6F3A', { content: null })] });
	assert.deepStrictEqual(await src.read('MF/6F3A'), { success: false, sw: 'not-captured' });
});

test('profilerRunRule against a snapshot passes on matching metadata and content', async () => {
	const src = profilerSnapshotSource({ files: [snapFile('MF/6F3A')] });
	const res = await profilerRunRule({ path: 'MF/6F3A', fileType: 'transparent', fileSize: 4, fciMode: 'type_size', content: { mode: 'exact', kind: 'transparent', expected: 'AABB' } }, src);
	assert.strictEqual(res.status, 'pass');
});

test('profilerRunRule against a snapshot fails on a missing file', async () => {
	const src = profilerSnapshotSource({ files: [] });
	const res = await profilerRunRule({ path: 'MF/6F3A' }, src);
	assert.strictEqual(res.status, 'fail');
	assert.ok(res.checks.some(c => c.label === 'exists' && c.ok === false));
});

test('profilerRunRule against a snapshot fails on metadata mismatch', async () => {
	const src = profilerSnapshotSource({ files: [snapFile('MF/6F3A', { fileSize: 9, fciHex: '621082024022' })] });
	const res = await profilerRunRule({ path: 'MF/6F3A', fileType: 'transparent', fileSize: 4, fciMode: 'exact', fciHex: '621082024021' }, src);
	assert.strictEqual(res.status, 'fail');
	assert.ok(res.checks.some(c => c.label === 'fileSize' && c.ok === false));
	assert.ok(res.checks.some(c => c.label === 'fci' && c.ok === false));
});

test('profilerRunRule against a snapshot reports uncaptured content as an error', async () => {
	global.t = s => s;
	const src = profilerSnapshotSource({ files: [snapFile('MF/6F3A', { content: null })] });
	const res = await profilerRunRule({ path: 'MF/6F3A', fileType: 'transparent', fileSize: 4, content: { mode: 'exact', kind: 'transparent', expected: 'AABB' } }, src);
	assert.strictEqual(res.status, 'error');
	assert.strictEqual(res.error, 'Content not captured in snapshot');
	assert.ok(res.checks.some(c => c.label === 'content' && c.ok === false));
	delete global.t;
});

test('profilerVisibleResults hides passing files when mismatch-only is on', () => {
	const results = [{ status: 'pass' }, { status: 'fail' }, { status: 'error' }, { status: 'pass' }];
	assert.strictEqual(profilerVisibleResults(results, false).length, 4);
	assert.deepStrictEqual(profilerVisibleResults(results, true).map(r => r.status), ['fail', 'error']);
	assert.strictEqual(profilerVisibleResults([{ status: 'pass' }], true).length, 0);
});
