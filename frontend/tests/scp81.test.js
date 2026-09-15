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

eval(extractFunc(html, 'scp81LogLine'));

test('scp81LogLine renders a BIP open entry', () => {
	assert.strictEqual(
		scp81LogLine({ seq: 4, kind: 'open', channel: 1, requested: '77.221.153.19:10174', target: '127.0.0.1:8443' }),
		'4 open ch1 77.221.153.19:10174 -> 127.0.0.1:8443');
});

test('scp81LogLine renders a TLS request with the GP headers', () => {
	assert.strictEqual(
		scp81LogLine({ seq: 5, kind: 'tls-request', method: 'POST', uri: '/server/adminagent?cmd=1', agent: '0123456789', bytes: 0 }),
		'5 tls-request from=0123456789 POST /server/adminagent?cmd=1');
});

test('scp81LogLine renders handshake and errors', () => {
	assert.strictEqual(
		scp81LogLine({ seq: 6, kind: 'tls-handshake', cipher: 'PSK-AES128-CBC-SHA256', identity: 'id-1' }),
		'6 tls-handshake id=id-1 PSK-AES128-CBC-SHA256');
	assert.strictEqual(scp81LogLine({ seq: 7, kind: 'tls-error', error: 'boom' }), '7 tls-error boom');
});

test('scp81 log covers the dump mode kinds', () => {
	assert.strictEqual(scp81LogLine({ seq: 1, kind: 'dump-rx', bytes: 71 }), '1 dump-rx 71B');
});

test('scp81LogLine renders script entries', () => {
	assert.strictEqual(
		scp81LogLine({ seq: 9, kind: 'script-send', index: 1, apdu: '80CAFF2100' }),
		'9 script-send #1 80CAFF2100');
	assert.strictEqual(
		scp81LogLine({ seq: 12, kind: 'script-rapdu', index: 1, sw: '9000', bytes: 14 }),
		'12 script-rapdu #1 SW 9000 14B');
	assert.strictEqual(
		scp81LogLine({ seq: 13, kind: 'script-memory', applets: 4, free_nv: 61600, free_volatile: 2048 }),
		'13 script-memory applets=4 free NV=61600 free vol=2048');
});
