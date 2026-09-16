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
    assert.deepStrictEqual(tabs, ['c-apdu', 'scp80', 'scp81', 'cards', 'profiler', 'pysim', 'phone']);
    assert.match(html, /data-tab="c-apdu">Remote APDU</);
});

test('cards list shows the SCP81 PSK column with blue/red row buttons', () => {
    assert.match(html, /data-l10n="SCP81">SCP81</);
    const fn = /function cardsRender\(\)[\s\S]*?\n\}/.exec(html);
    assert.ok(fn, 'cardsRender not found');
    assert.match(fn[0], /cardsEdit\(' \+ i \+ '\)" class="[^"]*bg-blue-600 text-white/);
    assert.match(fn[0], /cardsRemove\(' \+ i \+ '\)" class="[^"]*bg-red-600 text-white/);
});

test('PLI qualifier tables cover all standard qualifiers', () => {
    // ESN (07), MEID (0B) and Supported RATs (1A) must at least be named, in
    // both the TR Config dictionary and the proactive-log short labels.
    const pli = /const PLI_QUALIFIERS = \[([\s\S]*?)\];/.exec(html);
    assert.ok(pli, 'PLI_QUALIFIERS not found');
    for (const code of ['07', '0B', '1A']) {
        assert.ok(pli[1].includes("{code:'" + code + "'"), 'PLI_QUALIFIERS missing ' + code);
    }
    const block = /const CMD_QUALIFIER_SHORT = \{([\s\S]*?)\n\};/.exec(html);
    assert.ok(block, 'CMD_QUALIFIER_SHORT not found');
    const short = /'26': \{([^}]*)\}/.exec(block[1]);
    assert.ok(short, "CMD_QUALIFIER_SHORT['26'] not found");
    for (const key of ['0x07', '0x0B', '0x1A']) {
        assert.ok(short[1].includes(key + ':'), 'CMD_QUALIFIER_SHORT 26 missing ' + key);
    }
});

test('profile rows have a Clone action', () => {
    assert.match(html, /onclick="profilerClone\(' \+ i \+ '\)"/);
    assert.match(html, /t\('Clone'\)/);
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

test('header status indicator has a compact ADM badge', () => {
    assert.ok(html.includes('id="state-indicator-adm"'));
});

test('file manager has FID / Name sort pills', () => {
    assert.match(html, /data-fs-sort="fid" onclick="pysimFsSetSort\('fid'\)"/);
    assert.match(html, /data-fs-sort="name" onclick="pysimFsSetSort\('name'\)"/);
    assert.ok(html.includes('pysim-fs-sort-pill'));
});

test('file manager keeps sort/probe controls above the scrolling tree', () => {
    // The sort pills and the Probe all files button/status must sit outside
    // the scrolling tree container so they stay visible while it scrolls.
    assert.ok(html.indexOf('id="pysim-fs-probe-btn"') < html.indexOf('id="pysim-fs-tree"'));
    assert.ok(html.indexOf('pysim-fs-sort-pill') < html.indexOf('id="pysim-fs-tree"'));
    assert.match(html, /style="max-height:65vh"[^>]*>\s*<div id="pysim-fs-tree">/);
});

test('custom files form has add/save and cancel controls', () => {
    assert.match(html, /id="pysim-cf-add-btn"[^>]*data-l10n="Add"/);
    assert.match(html, /id="pysim-cf-cancel-btn"[^>]*class="hidden[^"]*"[^>]*data-l10n="Cancel"/);
    assert.ok(html.includes("event.key==='Enter')pysimCustomSubmit()"));
    assert.ok(!html.includes('pysimCustomAdd'));
});

test('file manager has a probe-all-files button and status line', () => {
    assert.match(html, /id="pysim-fs-probe-btn"[^>]*data-needs="card"/);
    assert.match(html, /id="pysim-fs-probe-btn"[^>]*data-l10n="Probe all files"/);
    assert.ok(html.includes('onclick="pysimFsProbeAll()"'));
    assert.ok(html.includes('id="pysim-fs-probe-status"'));
});

test('file manager shows FCI info and keeps the selection in state, not the DOM', () => {
    const detail = html.indexOf('id="pysim-fs-detail"');
    const info = html.indexOf('id="pysim-fs-info"');
    const content = html.indexOf('id="pysim-fs-content"');
    assert.ok(detail !== -1 && info > detail && info < content, 'pysim-fs-info must sit above the content');
    assert.ok(html.includes('function pysimFsInfoHtml'));
    assert.ok(html.includes("pysimFsInfoHtml(sel)"));
    assert.ok(!html.includes('pysim-fs-filename'));
    assert.ok(html.includes('let pysimFsSelected = null;'));
    assert.ok(html.includes('pysimFsSelected = name;'));
    assert.ok(!html.includes('pysimFsSelect()'));
});

test('profile list has a Profile from snapshot button', () => {
    assert.match(html, /data-l10n="Profile from snapshot">Profile from snapshot</);
    assert.ok(html.includes('onclick="profilerFromSnapshot()"'));
    assert.ok(html.includes('function profilerScanFromSnapshot(si)'));
    assert.ok(html.includes('function profilerBuildFileRuleFromSnapshot('));
});
