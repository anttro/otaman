const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const opens = (html.match(/<div\b/g) || []).length;
const closes = (html.match(/<\/div>/g) || []).length;

test('HTML <div> tags are balanced', () => {
    assert.strictEqual(opens, closes, `Unbalanced divs: ${opens} opens vs ${closes} closes`);
});

test('top-level tabs match the rearranged views', () => {
    const tabs = [...html.matchAll(/class="tab-btn[^"]*" data-tab="([^"]+)"/g)].map(m => m[1]);
    assert.deepStrictEqual(tabs, ['c-apdu', 'scp80', 'pysim', 'profiler', 'phone']);
    assert.match(html, /data-tab="c-apdu">Remote APDU</);
});

test('response parser is a Remote APDU pill', () => {
    assert.match(html, /data-sub="response" onclick="cApduSwitchSubtab\('response'\)"/);
    assert.ok(html.includes('id="c-apdu-sub-response"'));
});

test('profiler and phone simulator are top-level tab contents', () => {
    assert.ok(html.includes('id="tab-profiler" class="tab-content hidden"'));
    assert.ok(html.includes('id="tab-phone" class="tab-content hidden"'));
});

test('phone simulator has Phone / TR Config pills', () => {
    assert.match(html, /data-phone-sub="phone" onclick="phoneSwitchSubtab\('phone'\)"/);
    assert.match(html, /data-phone-sub="tr" onclick="phoneSwitchSubtab\('tr'\)"/);
    assert.ok(html.includes('id="phone-sub-phone"'));
    assert.ok(html.includes('id="phone-sub-tr"'));
});

test('scan name input starts scanning on Enter', () => {
    assert.match(html, /id="profiler-scan-name"[^>]*onkeydown="profilerScanNameKeydown\(event\)"/);
});

test('snapshot view has a timing summary block', () => {
    assert.ok(html.includes('id="snapshot-summary"'));
});

test('header state indicator and profiler custom-files tab', () => {
    assert.ok(html.includes('id="state-indicator"'));
    assert.ok(html.includes('id="profiler-list-custom"'));
    assert.ok(html.includes('data-list-tab="custom"'));
    assert.ok(!html.includes('data-pysim-sub="custom"'));
});
