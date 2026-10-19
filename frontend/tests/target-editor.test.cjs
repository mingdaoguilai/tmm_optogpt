const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Compile pure TS utilities in memory; no new runtime dependency or build files.
const cache = new Map();
function load(name) {
  const candidate = path.resolve(__dirname, '../src', name);
  const filename = fs.existsSync(candidate + '.ts') ? candidate + '.ts' : candidate + '.tsx';
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename, module);
  cache.set(filename, mod);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = requested => requested.startsWith('.') ? load(path.relative(path.resolve(__dirname,'../src'),path.resolve(path.dirname(filename),requested))) : require(requested);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx:ts.JsxEmit.ReactJSX } });
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}
const editor = load('targetEditor');
const utils = load('utils');
const settings = load('designRequirements');
const refinement = load('refinement');
const workflow = load('workflow');
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const seedTarget = { wavelengths_nm: [400, 650, 1100], reflectance: [0.1, 0.8, 0.2], transmittance: [0.9, 0.2, 0.8] };

const sampleCandidate = () => ({rank:1,tokens:['SiO2_100'],layers:[{material:'SiO2',thickness_nm:137.23456789,coherent:true}],
  layer_count:1,total_thickness_nm:137.23456789,mae_r:.03,mae_t:.03,max_error:.08,score:.03,
  requirement_score:.01,weighted_mae:.03,max_deviation:.08,max_violation:.06,pass_rate:.5,
  simulation:{wavelengths_nm:[400,600.3,1100],reflectance:[.1,.2,.1],transmittance:[.9,.8,.9],absorptance:[0,0,0],max_energy_error:0},
  refinement:{accepted:true,status:'improved',message:'test',evaluations:5,starts_completed:1,elapsed_s:.1,solver_messages:[],
    initial_layers:[{material:'SiO2',thickness_nm:100,coherent:true}],
    initial_simulation:{wavelengths_nm:[400,600.3,1100],reflectance:[.2,.3,.2],transmittance:[.8,.7,.8],absorptance:[0,0,0],max_energy_error:0},
    initial_metrics:{requirement_score:.05,weighted_mae:.06,max_deviation:.15,max_violation:.13,pass_rate:0,mae_r:.06,mae_t:.06,max_error:.15,score:.05},initial_band_metrics:[]}});

test('adoption selects real float thickness or original layers without token reconstruction', () => {
  const c=sampleCandidate();
  const current=workflow.adoptCandidate(c,'current',seedTarget,settings.defaultRequirements);
  const initial=workflow.adoptCandidate(c,'initial',seedTarget,settings.defaultRequirements);
  assert.equal(current.conditions.layers[0].thickness_nm,137.23456789);
  assert.equal(initial.conditions.layers[0].thickness_nm,100);
  assert.equal(initial.candidate.max_error,.15);
  assert.equal(current.conditions.polarization,'s');
  current.conditions.layers[0].thickness_nm=200;
  assert.equal(c.layers[0].thickness_nm,137.23456789);
  assert.equal(c.refinement.initial_layers[0].thickness_nm,100);
});

test('verification key detects tiny edits and changed target/rules but ignores object key order', () => {
  const a=workflow.adoptCandidate(sampleCandidate(),'current',seedTarget,settings.defaultRequirements);
  const payload=workflow.verificationRequest(a,a.conditions);
  assert.deepEqual(payload.evaluation_wavelengths_nm,[400,600.3,1100]);
  const restored=JSON.parse(JSON.stringify(payload));
  assert.equal(workflow.fingerprint(payload),workflow.fingerprint(restored));
  restored.simulation.layers[0].thickness_nm+=1e-8;
  assert.notEqual(workflow.fingerprint(payload),workflow.fingerprint(restored));
  const rules=structuredClone(payload);rules.requirements.tolerance=.1;
  assert.notEqual(workflow.fingerprint(payload),workflow.fingerprint(rules));
  assert.equal(workflow.fingerprint({a:1,b:2}),workflow.fingerprint({b:2,a:1}));
});

test('CSV export preserves actual decimal thickness and exact grid, never original token thickness', () => {
  const c=sampleCandidate();
  assert.match(workflow.structureCsv(c),/137\.23456789/);
  assert.match(workflow.structureCsv(workflow.initialCandidate(c)),/100/);
  assert.match(workflow.spectrumCsv(c.simulation),/600\.3,0\.2,0\.8,0/);
  assert.equal(workflow.structureCsv(c).split('\n')[0],'layer,material,thickness_nm,coherent');
});

test('job design snapshot preserves search provenance for saved and partial results', () => {
  const result={model_target:seedTarget,requirements:settings.defaultRequirements,constraints:settings.defaultConstraints,
    reference_layers:[],search_settings:{seed:7},search_summary:{verified_count:2}};
  const snapshot=workflow.designSnapshot({id:'job-1',status:'cancelled',result});
  assert.equal(snapshot.job_status,'cancelled');assert.equal(snapshot.search_settings.seed,7);
  assert.equal(snapshot.search_summary.verified_count,2);
});

test('review updates saved metrics only if its original candidate still matches', () => {
  const source=sampleCandidate();const updated=structuredClone(source);updated.max_deviation=.07;
  assert.equal(workflow.replaceReviewedCandidate([source],source,updated)[0].max_deviation,.07);
  const changed=structuredClone(source);changed.layers[0].thickness_nm=150;
  assert.equal(workflow.replaceReviewedCandidate([changed],source,updated)[0].layers[0].thickness_nm,150);
});

test('metric table distinguishes active max deviation from post-tolerance violation', () => {
  const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
  const {CandidateMetrics}=load('components/CandidateMetrics');
  const c=sampleCandidate();
  const markup=renderToStaticMarkup(React.createElement(CandidateMetrics,{current:c,initial:workflow.initialCandidate(c)}));
  assert.match(markup,/最大考核偏差/);assert.match(markup,/最大超差/);
  assert.match(markup,/15\.00%/);assert.match(markup,/8\.00%/);
});

test('refinement settings preserve bounded budgets and reject invalid restoration', () => {
  const saved = JSON.parse(JSON.stringify({...refinement.defaultRefinement, enabled:true, starts:3}));
  refinement.validateRefinement(saved);
  assert.equal(saved.starts,3);
  assert.throws(()=>refinement.validateRefinement({...saved,max_evaluations:19}));
  assert.throws(()=>refinement.validateRefinement({...saved,starts:1.5}));
  assert.throws(()=>refinement.validateRefinement({...saved,time_budget_s:NaN}));
  assert.throws(()=>refinement.validateRefinement({...saved,verification_step_nm:10}));
});

test('refinement panel renders all budgets and no-quantization caveat', () => {
  const React = require('react');
  const {renderToStaticMarkup} = require('react-dom/server');
  const {RefinementSettingsPanel} = load('components/RefinementSettingsPanel');
  const markup = renderToStaticMarkup(React.createElement(RefinementSettingsPanel, {value:{...refinement.defaultRefinement,enabled:true},onChange:()=>{}}));
  assert.match(markup,/每组总TMM求值预算/);
  assert.match(markup,/全部候选优化时限/);
  assert.match(markup,/尚未量化/);
});

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

test('requirements and manufacturing boundaries serialize independently of curve data', () => {
  const rules = {...settings.defaultRequirements,enabled_r:false,scope:'bands',bands:[{channel:'T',start_nm:550,end_nm:650,kind:'minimum',value:0.9,tolerance:0.02,weight:2}]};
  const constraints = {...settings.defaultConstraints,layers:[{index:2,material:'TiO2',thickness_nm:100}]};
  const restored = JSON.parse(JSON.stringify({rules,constraints}));
  settings.validateSettings(restored.rules,restored.constraints);
  assert.deepEqual(restored,{rules,constraints});
});
test('restored malformed bands and contradictory layer limits fail explicitly', () => {
  const rules = {...settings.defaultRequirements,bands:[{channel:'T',start_nm:650,end_nm:550,kind:'match',value:0.9,tolerance:0,weight:1}]};
  assert.throws(()=>settings.validateSettings(rules,settings.defaultConstraints));
  assert.throws(()=>settings.validateSettings(settings.defaultRequirements,{...settings.defaultConstraints,min_thickness_nm:200,layers:[{index:1,thickness_nm:100}]}));
  assert.throws(()=>settings.validateSettings(settings.defaultRequirements,{...settings.defaultConstraints,layers:[{index:1,material:'SiO2'},{index:1,material:'TiO2'}]}));
});

test('requirements panel renders restored T-only threshold and locked-layer settings', () => {
  const React=require('react');
  const {renderToStaticMarkup}=require('react-dom/server');
  const {DesignSettings}=load('components/DesignSettings');
  const html=renderToStaticMarkup(React.createElement(DesignSettings,{
    requirements:{...settings.defaultRequirements,enabled_r:false,scope:'bands',bands:[{channel:'T',start_nm:550,end_nm:650,kind:'minimum',value:0.9,tolerance:0.02,weight:1}]},
    constraints:{...settings.defaultConstraints,layers:[{index:2,material:'TiO2',thickness_nm:100}]},
    onRequirementsChange:()=>{},onConstraintsChange:()=>{},referenceLayers:[],materials:[],pending:false,
    preview:{active_r_points:0,active_t_points:11,evaluation_wavelengths_nm:Array(71)}
  }));
  assert.match(html,/设计要求与工艺边界/);
  assert.match(html,/至少 ≥/);
  assert.match(html,/value="90"/);
  assert.match(html,/value="100"/);
  assert.match(html,/TiO2/);
  assert.match(html,/锁定厚度/);
});
