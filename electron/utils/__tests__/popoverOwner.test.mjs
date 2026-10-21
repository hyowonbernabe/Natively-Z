// Personal build (Natively Z): popover owner refresh. Platform injected, so both branches run on either OS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { refreshPopoverOwner } = require(path.join(repoRoot, 'dist-electron/electron/utils/popoverOwner.js'));

const owner = { isDestroyed: () => false };
const popover = (visible = true) => {
  const calls = [];
  return { calls, isDestroyed: () => false, isVisible: () => visible, setParentWindow: p => calls.push(p) };
};

test('win32: a visible popover is detached then re-attached to the same owner', () => {
  const win = popover();
  assert.equal(refreshPopoverOwner(win, owner, 'win32'), true);
  assert.deepEqual(win.calls, [null, owner]);
});

test('darwin: never re-parents (AppKit child panels)', () => {
  const win = popover();
  assert.equal(refreshPopoverOwner(win, owner, 'darwin'), false);
  assert.deepEqual(win.calls, []);
});

test('win32: hidden popover or missing owner is left alone', () => {
  const hidden = popover(false);
  assert.equal(refreshPopoverOwner(hidden, owner, 'win32'), false);
  const noOwner = popover();
  assert.equal(refreshPopoverOwner(noOwner, null, 'win32'), false);
  assert.deepEqual([...hidden.calls, ...noOwner.calls], []);
});
