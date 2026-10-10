const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Compile pure TS utilities in memory; no new runtime dependency or build files.
const cache = new Map();
function load(name) {
  const filename = path.resolve(__dirname, '../src', name + '.ts');
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename, module);
  cache.set(filename, mod);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = requested => requested.startsWith('./') ? load(requested.slice(2)) : require(requested);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}
const editor = load('targetEditor');
const utils = load('utils');
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const seedTarget = { wavelengths_nm: [400, 650, 1100], reflectance: [0.1, 0.8, 0.2], transmittance: [0.9, 0.2, 0.8] };

test('PCHIP preserves control points, monotonicity and peak bounds', () => {
  const points = [{ wavelength_nm: 400, value: 0 }, { wavelength_nm: 500, value: 1 }, { wavelength_nm: 650, value: 0.2 }, { wavelength_nm: 1100, value: 0.2 }];
  const samples = editor.interpolatePoints(points, editor.editorWavelengths, 'pchip');
  close(samples[0], 0); close(samples[100], 1); close(samples[250], 0.2);
  assert.ok(samples.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  assert.ok(samples.slice(0, 101).every((v, i, a) => i === 0 || v >= a[i - 1]));
  assert.ok(samples.slice(100, 251).every((v, i, a) => i === 0 || v <= a[i - 1]));
  close(editor.interpolatePoints(points.slice(0, 2), [450], 'pchip')[0], 0.5);
});
test('linked edits complement the other channel; independent edits preserve absorption', () => {
  const state = editor.editorFromSpectrum(seedTarget);
  const changed = editor.setChannelPoints(state, state.points.R.map((p, i) => ({ ...p, value: i === 1 ? 0.4 : p.value })));
  const target = editor.editorToSpectrum(changed);
  target.reflectance.forEach((r, i) => close(r + target.transmittance[i], 1));
  const independent = editor.setChannelPoints({ ...changed, linked: false }, changed.points.R.map(p => ({ ...p, value: p.value / 2 })));
  assert.deepEqual(independent.points.T, changed.points.T);
  editor.validateSpectrum(editor.editorToSpectrum(independent));
});
test('Gaussian FWHM and component overlay retain multiple peaks', () => {
  let state = editor.editorFromSpectrum(seedTarget);
  state.generator = { ...state.generator, center_nm: 650, width_nm: 100, low: 0, high: 1 };
  state = editor.applyGenerator(state);
  let target = editor.editorToSpectrum(state);
  const at = x => target.reflectance[target.wavelengths_nm.indexOf(x)];
  close(at(650), 1); close(at(600), 0.5); close(at(700), 0.5);
  state.generator = { ...state.generator, center_nm: 850, operation: 'overlay' };
  state = editor.applyGenerator(state); target = editor.editorToSpectrum(state);
  close(at(650), 1); close(at(850), 1);
  editor.validateSpectrum(target);
});
test('notch, bandpass and edge generate finite bounded targets with declared transitions', () => {
  for (const shape of ['notch', 'bandpass', 'edge']) {
    let state = editor.editorFromSpectrum(seedTarget);
    state.generator = { ...state.generator, shape, low: 0, high: 1, center_nm: 650, transition_nm: 20 };
    state = editor.applyGenerator(state);
    const target = editor.editorToSpectrum(state);
    editor.validateSpectrum(target);
    const at = x => target.reflectance[target.wavelengths_nm.indexOf(x)];
    if (shape === 'notch') close(at(650), 0);
    if (shape === 'bandpass') assert.ok(at(650) > 0.99 && at(400) < 0.001);
    if (shape === 'edge') { close(at(640), 0.1); close(at(650), 0.5); close(at(660), 0.9); }
  }
});
test('CSV import rejects malformed rows, duplicate wavelengths and missing values instead of silently dropping them', () => {
  for (const input of ['400,0.1,0.9\n600,,0.2\n1100,0.1,0.9', '400,0.1,0.9\n600,foo,0.2\n1100,0.1,0.9', '400,0.1,0.9\n400,0.2,0.8\n1100,0.1,0.9']) assert.throws(() => utils.parseTargetCsv(input));
  const target = utils.parseTargetCsv('\ufeffwavelength_nm,R,T,A\n1100,0.2,0.7,0.1\n400,0.1,0.8,0.1');
  assert.equal(target.wavelengths_nm[0], 400);
  assert.deepEqual(utils.parseTargetCsv(editor.spectrumToCsv(target)), target);
});
test('editor JSON roundtrip retains off-grid points, raw imported data and component settings', () => {
  const raw = { wavelengths_nm: [350, 400, 645.3, 1100, 1200], reflectance: [0, 0.1, 0.7, 0.1, 0], transmittance: [1, 0.9, 0.3, 0.9, 1] };
  const state = editor.editorFromSpectrum(raw, 'measurement.csv');
  const restored = JSON.parse(JSON.stringify(state));
  editor.validateEditor(restored);
  assert.deepEqual(restored, state);
  assert.deepEqual(restored.source_spectrum, raw);
  assert.ok(editor.editorToSpectrum(restored).wavelengths_nm.includes(645.3));
});
test('invalid passive targets are editable drafts but cannot be submitted', () => {
  const bad = { wavelengths_nm: [400, 1100], reflectance: [0.8, 0.8], transmittance: [0.5, 0.5] };
  const state = editor.editorFromSpectrum(bad);
  assert.equal(state.linked, false);
  editor.validateEditor(state);
  assert.throws(() => editor.validateSpectrum(editor.editorToSpectrum(state)), /R \+ T/);
  assert.throws(() => editor.validateEditor({ ...state, points: { ...state.points, R: [state.points.R[0], state.points.R[0]] } }));
});
