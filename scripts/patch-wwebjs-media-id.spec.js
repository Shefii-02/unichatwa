'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyMediaIdPatch, FIND, REPLACE, UTILS_PATH } = require('./patch-wwebjs-media-id');

/**
 * Fixture is the INSTALLED Utils.js, un-patched first when postinstall already ran, so the suite
 * proves the patcher matches the shape upstream really ships rather than one written for the test.
 */
const INSTALLED = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', UTILS_PATH);

function pristineSource() {
  let source = fs.readFileSync(INSTALLED, 'utf8');
  if (source.includes(REPLACE)) source = source.replace(REPLACE, FIND);
  return source;
}

function fakeWwjs(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-media-id-'));
  const injected = path.join(dir, 'src', 'util', 'Injected');
  fs.mkdirSync(injected, { recursive: true });
  fs.writeFileSync(path.join(injected, 'Utils.js'), source);
  return { dir, file: path.join(injected, 'Utils.js') };
}

test('the installed tree still has the shape the patcher targets', () => {
  assert.ok(pristineSource().includes(FIND), 'upstream no longer matches the sendMessage message-object shape');
});

test('restores the message key for media sends only, and is idempotent', () => {
  const { dir, file } = fakeWwjs(pristineSource());
  const first = applyMediaIdPatch({ wwjsDir: dir });
  assert.deepEqual(first.applied, ['media-id']);

  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.includes('delete message.__x_id;'));
  assert.ok(patched.includes('message.id = newMsgKey;'));
  // gated on a media send so plain text keeps the exact upstream path
  assert.ok(patched.includes('if (Object.keys(mediaOptions).length > 0) {\n            delete message.__x_id;'));

  const second = applyMediaIdPatch({ wwjsDir: dir });
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ['media-id']);
  assert.equal(fs.readFileSync(file, 'utf8'), patched, 'second run must not change the file');
});

test('refuses an unknown shape instead of patching blind', () => {
  const { dir } = fakeWwjs('window.WWebJS.sendMessage = async () => {};\n');
  assert.throws(() => applyMediaIdPatch({ wwjsDir: dir }), /refusing to patch blind/);
});

test('fails when whatsapp-web.js is not installed', () => {
  assert.throws(() => applyMediaIdPatch({ wwjsDir: path.join(os.tmpdir(), 'no-such-wwjs-dir') }), /not found/);
});
