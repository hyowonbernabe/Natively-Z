// Personal build (Natively Z): Whisper loop collapsing (electron/audio/whisper/hallucinationFilter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { collapseLoops, filterHallucination } = await import(pathToFileURL(path.resolve(here, '../../../../dist-electron/electron/audio/whisper/hallucinationFilter.js')).href);

test('a phrase looped 3+ times keeps one copy', () => {
  assert.equal(collapseLoops('ang paglamang sa pangalawang sa pangalawang sa pangalawang sa pangalawang set'), 'ang paglamang sa pangalawang set');
  assert.equal(collapseLoops('he had to have to have to have to have to go'), 'he had to have to go');
});

test('natural repetition survives', () => {
  assert.equal(collapseLoops('no, no, no that is wrong'), 'no, no, no that is wrong');
  assert.equal(collapseLoops('very very good'), 'very very good');
  assert.equal(collapseLoops('I built it and I built it again'), 'I built it and I built it again');
});

test('filterHallucination applies it', () => {
  assert.equal(filterHallucination('sige sige sige sige sige na'), 'sige na');
});
