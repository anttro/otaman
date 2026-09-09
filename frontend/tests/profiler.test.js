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

const FNS = ['profilerNormHex', 'profilerMatch', 'profilerMatchMin', 'profilerValidateProfile'];
let code = '';
for (const f of FNS) code += extractFunc(html, f) + '\n';
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

test('profile validation', () => {
	assert.strictEqual(profilerValidateProfile(null), 'Not an object');
	assert.strictEqual(profilerValidateProfile({ name: 'x' }), 'Missing rules array');
	assert.strictEqual(profilerValidateProfile({ name: 'x', rules: [{ type: 'ota' }] }), 'Unsupported rule type: ota');
	assert.strictEqual(profilerValidateProfile({ name: 'x', rules: [{ type: 'file' }] }), 'Rule missing path');
	assert.strictEqual(profilerValidateProfile({ name: 'x', rules: [{ type: 'file', path: 'MF/7F10/6F3A' }] }), null);
});
