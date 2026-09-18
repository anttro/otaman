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

let code = '';
for (const fn of ['swapNibbles', 'encIccid', 'decIccid',
	'cardsNormIccid', 'cardsFindByIccid', 'cardsAutoSelectByIccid']) {
	code += extractFunc(html, fn) + '\n';
}
eval(code);

// live-card style raw EF.ICCID content (nibble-swapped digits + 'F' pad)
const RAW_HEX = '980711090000640090F8';
const DIGITS = '8970119000004600098';

function fakeDoc() {
	const els = { 'sp-card-sel': { value: '' }, 'ram-card-sel': { value: '' } };
	globalThis.document = { getElementById: id => els[id] || null };
	return els;
}

test('cardsNormIccid accepts digits, separators and raw EF hex', () => {
	assert.strictEqual(cardsNormIccid(DIGITS), DIGITS);
	assert.strictEqual(cardsNormIccid(' 89 70 1190-0000 4600 098 '), DIGITS);
	assert.strictEqual(cardsNormIccid(RAW_HEX), DIGITS);
	assert.strictEqual(cardsNormIccid(RAW_HEX.toLowerCase()), DIGITS);
	assert.strictEqual(cardsNormIccid(''), '');
	assert.strictEqual(cardsNormIccid(null), '');
});

test('cardsFindByIccid matches regardless of the stored form', () => {
	globalThis.cards = [
		{ name: 'A', iccid: '1111111111111111111' },
		{ name: 'B', iccid: RAW_HEX },
		{ name: 'C', iccid: '89 70 1190 0000 4600 098' },
	];
	assert.strictEqual(cardsFindByIccid(DIGITS), 1);
	assert.strictEqual(cardsFindByIccid('1111111111111111111'), 0);
	assert.strictEqual(cardsFindByIccid('2222222222222222222'), -1);
	assert.strictEqual(cardsFindByIccid(''), -1);
});

test('cardsAutoSelectByIccid selects the preset in both SCP80 views', () => {
	const els = fakeDoc();
	const applied = [];
	globalThis.cardsApply = idx => applied.push(idx);
	globalThis.cards = [{ name: 'A', iccid: RAW_HEX }, { name: 'B', iccid: '' }];
	globalThis._ramCardIdx = null;
	globalThis._cardsAutoIccid = null;
	const idx = cardsAutoSelectByIccid(DIGITS);
	assert.strictEqual(idx, 0);
	assert.strictEqual(els['sp-card-sel'].value, '0');
	assert.strictEqual(els['ram-card-sel'].value, '0');
	assert.deepStrictEqual(applied, ['0']);
	assert.strictEqual(globalThis._ramCardIdx, 0);
});

test('cardsAutoSelectByIccid does not override a manual choice for the same card', () => {
	const els = fakeDoc();
	const applied = [];
	globalThis.cardsApply = idx => applied.push(idx);
	globalThis.cards = [{ name: 'A', iccid: DIGITS }, { name: 'B', iccid: '' }];
	globalThis._ramCardIdx = null;
	globalThis._cardsAutoIccid = null;
	assert.strictEqual(cardsAutoSelectByIccid(DIGITS), 0);
	// user picks the empty preset B for this card, then status polls repeat
	els['sp-card-sel'].value = '1';
	els['ram-card-sel'].value = '1';
	assert.strictEqual(cardsAutoSelectByIccid(DIGITS), -1);
	assert.strictEqual(els['sp-card-sel'].value, '1');
	assert.deepStrictEqual(applied, ['0']);
});

test('cardsAutoSelectByIccid reacts to a card swap and to unreadable ICCIDs', () => {
	fakeDoc();
	globalThis.cardsApply = () => {};
	globalThis.cards = [{ name: 'A', iccid: DIGITS }, { name: 'B', iccid: '89390100000129506903' }];
	globalThis._cardsAutoIccid = null;
	assert.strictEqual(cardsAutoSelectByIccid(DIGITS), 0);
	assert.strictEqual(cardsAutoSelectByIccid('89390100000129506903'), 1);
	// ICCID not readable: reset the guard, keep the current selection
	assert.strictEqual(cardsAutoSelectByIccid(null), -1);
	assert.strictEqual(globalThis._cardsAutoIccid, null);
	assert.strictEqual(cardsAutoSelectByIccid(DIGITS), 0);
	assert.strictEqual(cardsAutoSelectByIccid('1234567890123456789'), -1);
});

test('the card-state update wires the ICCID into the preset selection', () => {
	assert.ok(html.includes('cardsAutoSelectByIccid(status.iccid);'));
	assert.ok(html.includes('_cardsAutoIccid = null;'));
	assert.ok(html.includes("(data.iccid ? ' | ICCID: <b>' + esc(data.iccid) + '</b>' : '')"));
});
