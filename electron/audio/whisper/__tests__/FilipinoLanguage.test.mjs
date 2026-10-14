// Personal build (Natively Z): Filipino and English + Filipino (Taglish) recognition languages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (rel) => pathToFileURL(path.resolve(here, '../../../../dist-electron/electron', rel)).href;
const { RECOGNITION_LANGUAGES, TAGLISH_LANGUAGE_KEY } = await import(dist('config/languages.js'));
const { resolveWhisperLanguage, getLocalModelLanguageSupport } = await import(dist('audio/whisper/modelLanguageSupport.js'));

test('both Filipino options exist as their own language groups', () => {
  assert.equal(RECOGNITION_LANGUAGES.filipino.iso639, 'tl');
  assert.equal(RECOGNITION_LANGUAGES.filipino.bcp47, 'fil-PH');
  assert.equal(RECOGNITION_LANGUAGES[TAGLISH_LANGUAGE_KEY].iso639, 'tl');
  assert.deepEqual(RECOGNITION_LANGUAGES[TAGLISH_LANGUAGE_KEY].alternates, ['en-US']);
  assert.notEqual(RECOGNITION_LANGUAGES.filipino.group, RECOGNITION_LANGUAGES[TAGLISH_LANGUAGE_KEY].group);
});

test('Whisper is told Tagalog explicitly for both (transformers.js "auto" silently means English)', () => {
  assert.equal(resolveWhisperLanguage('filipino'), 'tagalog');
  assert.equal(resolveWhisperLanguage(TAGLISH_LANGUAGE_KEY), 'tagalog');
  assert.equal(resolveWhisperLanguage('fil-PH'), 'tagalog');
  assert.equal(resolveWhisperLanguage('tl'), 'tagalog');
});

test('only models that understand Tagalog offer the Filipino options', () => {
  const offers = (id) => getLocalModelLanguageSupport(id).allowedLanguageKeys.includes('filipino')
    && getLocalModelLanguageSupport(id).allowedLanguageKeys.includes(TAGLISH_LANGUAGE_KEY);
  assert.equal(offers('onnx-community/whisper-large-v3-turbo'), true);
  assert.equal(offers('Xenova/whisper-small'), true);
  assert.equal(offers('onnx-community/moonshine-base-ONNX'), false);
  assert.equal(offers('Xenova/whisper-small.en'), false);
  const parakeet = 'istupakov/parakeet-tdt-0.6b-v3-onnx';
  const known = getLocalModelLanguageSupport(parakeet);
  if (known.allowedLanguageKeys.length) assert.equal(known.allowedLanguageKeys.includes('filipino'), false);
});
