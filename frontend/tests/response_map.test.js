const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractBlock(startMarker, endMarker) {
	const start = html.indexOf(startMarker);
	const end = html.indexOf(endMarker, start);
	if (start < 0 || end < 0) throw new Error('block not found');
	return html.slice(start, end);
}

// Response parser maps + lookupSw live between SW_MAP and updateRespCmd.
// Rewrite top-level const -> var so the maps leak out of sloppy-mode eval.
eval(extractBlock('const SW_MAP = {', 'function updateRespCmd').replace(/^const /gm, 'var '));

test('lookupSw wildcard 91XX resolves proactive pending (any length)', () => {
	const desc = lookupSw('91', '14', 'uicc');
	assert.ok(desc.includes('proactive'), desc);
	assert.ok(!desc.includes('no response data'));
});

test('lookupSw 63CX extracts retry counter', () => {
	const desc = lookupSw('63', 'C3', 'uicc');
	assert.ok(desc.includes('3'), desc);
});

test('SW_MAP.generic covers ISO 6A85/6A89/6A8A', () => {
	assert.ok(SW_MAP.generic['6A85']);
	assert.ok(SW_MAP.generic['6A89']);
	assert.ok(SW_MAP.generic['6A8A']);
});

test('gp 6310 label does not reference removed P2=42 option', () => {
	assert.ok(!SW_MAP.gp['6310'].includes('42'));
});

test('LIFECYCLE_MAP per GPC v2.3 life cycles', () => {
	assert.strictEqual(LIFECYCLE_MAP['01'], 'OP_READY (card) / LOADED (ELF)');
	assert.strictEqual(LIFECYCLE_MAP['03'], 'INSTALLED');
	assert.strictEqual(LIFECYCLE_MAP['07'], 'SELECTABLE');
	assert.strictEqual(LIFECYCLE_MAP['0F'], 'SECURED (card)');
	assert.strictEqual(LIFECYCLE_MAP['1F'], 'PERSONALIZED (SD)');
	assert.strictEqual(LIFECYCLE_MAP['7F'], 'CARD_LOCKED');
	assert.strictEqual(LIFECYCLE_MAP['FF'], 'TERMINATED');
	assert.strictEqual(LIFECYCLE_MAP['83'], 'LOCKED (SD)');
});

test('PRIVILEGE_NAMES matches GPC v2.3 Tables 11-7/11-8/11-9', () => {
	assert.strictEqual(PRIVILEGE_NAMES[0][7], 'Mandated DAP Verification');
	assert.strictEqual(PRIVILEGE_NAMES[1][2], 'Token Verification');
	assert.strictEqual(PRIVILEGE_NAMES[1][7], 'Global Service');
	assert.strictEqual(PRIVILEGE_NAMES[2][0], 'Receipt Generation');
	assert.strictEqual(PRIVILEGE_NAMES[2][3], 'Contactless Self-Activation');
});