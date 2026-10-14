// Personal build: Settings observes the meeting's streams without opening devices.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { transformSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const appClass = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AppState');
const names = new Set(['startAudioTest', 'stopAudioTest', 'publishMeetingAudioLevel']);
const methods = appClass.members.filter(node => names.has(node.name?.getText(parsed))).map(node => node.getText(parsed));
assert.equal(methods.length, 3);
const compiled = transformSync(`class MeterHarness { ${methods.join('\n')} }; module.exports = MeterHarness;`, { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} };
new Function('module', compiled)(mod);

function harness() {
  const h = new mod.exports();
  h._audioTestEpoch = 0;
  h.isMeetingActive = true;
  const events = [];
  const window = { isDestroyed: () => false };
  h.settingsWindowHelper = { getSettingsWindow: () => window };
  h.getWindowHelper = () => ({ getLauncherWindow: () => null, getOverlayWindow: () => null });
  h.sendToWindow = (_window, event, value) => events.push({ event, value });
  h._startAudioTestImpl = () => { throw new Error('Must not open devices during a meeting'); };
  return { h, events };
}

test('opening and closing Settings meters during a meeting never starts or stops its captures', async () => {
  const { h, events } = harness();
  h.microphoneCapture = h.systemAudioCapture = { stop: () => { throw new Error('Meeting capture stopped'); } };
  await h.startAudioTest('selected-mic');
  const pcm = Buffer.alloc(40); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(5000, i);
  h.publishMeetingAudioLevel('mic', pcm);
  h.publishMeetingAudioLevel('system', pcm);
  assert.deepEqual(events, [{ event: 'audio-test-level', value: 0.5 }, { event: 'audio-test-system-level', value: 0.5 }]);
  h.stopAudioTest();
  h.publishMeetingAudioLevel('mic', pcm);
  assert.equal(events.length, 2, 'no meter traffic after Settings closes');
});

test('silent, short and clipped chunks produce bounded meter values without exceptions', async () => {
  const { h, events } = harness(); await h.startAudioTest();
  h.publishMeetingAudioLevel('mic', Buffer.alloc(1));
  const clipped = Buffer.alloc(2); clipped.writeInt16LE(-32768);
  h.publishMeetingAudioLevel('system', clipped);
  assert.deepEqual(events.map(e => e.value), [0, 1]);
});

test('outside a meeting, Settings retains the independent device-test path', async () => {
  const { h } = harness(); h.isMeetingActive = false;
  let selected; h._startAudioTestImpl = async id => { selected = id; };
  await h.startAudioTest('usb-mic'); assert.equal(selected, 'usb-mic');
  assert.equal(h._audioTestStarting, false);
});
