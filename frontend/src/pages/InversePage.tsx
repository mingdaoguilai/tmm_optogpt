import { NumberField } from "../components/NumberField";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { TargetEditor } from "../components/TargetEditor";
import { DesignSettings } from "../components/DesignSettings";
import type { Candidate, CandidateDesignSnapshot, DesignPreview, DesignRequirements, InverseJob, Layer, ManufacturingConstraints, Material, TargetEditorState, TargetSpectrum } from "../types";
import { downloadText, formatPercent } from "../utils";
import { validateSettings } from "../designRequirements";
import type { RefinementSettings } from "../types";
import { RefinementSettingsPanel } from "../components/RefinementSettingsPanel";
import { designSnapshot } from "../workflow";

interface InversePageProps {
  candidates: Candidate[];
  candidateDesign: CandidateDesignSnapshot | null;
  onReviewCandidates: ()=>void;
  refinement: RefinementSettings;
  onRefinementChange: (value: RefinementSettings) => void;
  target: TargetSpectrum;
  editor: TargetEditorState;
  onEditorChange: (editor: TargetEditorState) => void;
  requirements: DesignRequirements;
  onRequirementsChange: (r: DesignRequirements) => void;
  constraints: ManufacturingConstraints;
  onConstraintsChange: (c: ManufacturingConstraints) => void;
  referenceLayers: Layer[];
  materials: Material[];
  onCandidatesChange: (candidates: Candidate[], snapshot: TargetSpectrum, requirements?: DesignRequirements, design?: CandidateDesignSnapshot) => void;
  onUseCandidate: (candidate: Candidate) => void;
}

export function InversePage({ candidates, candidateDesign, onReviewCandidates, refinement, onRefinementChange, target, editor, onEditorChange, requirements, onRequirementsChange, constraints, onConstraintsChange, referenceLayers, materials, onCandidatesChange, onUseCandidate }: InversePageProps) {
  const [candidateCount, setCandidateCount] = useState(20);
  const [maxLayers, setMaxLayers] = useState(20);
  const [temperatures, setTemperatures] = useState([0.7, 0.85, 1.0]);
  const [sampleCount, setSampleCount] = useState(300);
  const [seedCount, setSeedCount] = useState(4);
  const [topK, setTopK] = useState(10);
  const [topP, setTopP] = useState(0.85);
  const [includeGreedy, setIncludeGreedy] = useState(true);
  const [beamWidth, setBeamWidth] = useState(5);
  const [lengthPenalty, setLengthPenalty] = useState(0.6);
  const [settingsRestored, setSettingsRestored] = useState(false);
  const [seed, setSeed] = useState(42);
  const [job, setJob] = useState<InverseJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submittedTarget = useRef<TargetSpectrum>(target);
  const [submitting, setSubmitting] = useState(false);
  const previewPayload = {target, requirements, constraints, reference_layers:requirements.completion==="reference"?referenceLayers:[], max_layers:maxLayers};
  const previewKey = JSON.stringify(previewPayload);
  const [preview, setPreview] = useState<{key:string; data?:DesignPreview; error?:string} | null>(null);
  const previewReady = preview?.key === previewKey && !!preview.data;
  useEffect(() => {
    let disposed = false;
    const timer = window.setTimeout(async () => {
      try {
        validateSettings(requirements, constraints);
        const data = await api.designPreview(previewPayload);
        if (!disposed) setPreview({key:previewKey,data});
      } catch (caught) { if (!disposed) setPreview({key:previewKey,error:caught instanceof Error?caught.message:String(caught)}); }
    }, 450);
    return () => { disposed=true; window.clearTimeout(timer); };
  }, [previewKey]);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem('optiforge-inverse') || 'null');
      if (saved) {
        setCandidateCount(saved.candidateCount); setMaxLayers(saved.maxLayers);
        setSeed(saved.seed);
        if (saved.version === 3) {
          setTemperatures(saved.temperatures); setSampleCount(saved.sampleCount);
          setSeedCount(saved.seedCount); setTopK(saved.topK); setTopP(saved.topP);
          setIncludeGreedy(saved.includeGreedy); setBeamWidth(saved.beamWidth);
          setLengthPenalty(saved.lengthPenalty);
        }
        if (saved.job) { submittedTarget.current = saved.target; setJob(saved.job); }
      }
    } catch { /* Missing or obsolete session data can be ignored. */ }
    setSettingsRestored(true);
  }, []);
  useEffect(() => {
    if (!settingsRestored) return;
    try { sessionStorage.setItem('optiforge-inverse', JSON.stringify({version:3, job, target:submittedTarget.current, candidateCount,maxLayers,temperatures,seed,sampleCount,seedCount,topK,topP,includeGreedy,beamWidth,lengthPenalty})); }
    catch { /* Project export remains available if session storage is full. */ }
  }, [settingsRestored, job, candidateCount, maxLayers, temperatures, seed, sampleCount, seedCount, topK, topP, includeGreedy, beamWidth, lengthPenalty]);

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.inverseJob(job.id);
        if (cancelled) return;
        setJob(next);
        if (next.result?.candidates.length) onCandidatesChange(next.result.candidates, next.result.target ?? submittedTarget.current, next.result.requirements, designSnapshot(next));
        if (next.status === "failed") setError(next.error?.message ?? next.message);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setJob(current => current ? {...current, status:'failed', message:'任务连接已中断；请确认服务是否重启'} : null);
      }
    }, 900);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [job?.id, job?.status]);

  const start = async () => {
    if (!previewReady) return;
    setSubmitting(true);
    submittedTarget.current = structuredClone(target);
    setError(null);
    try {
      setJob(await api.createInverseJob({
        target: submittedTarget.current,
        refinement: structuredClone(refinement),
        requirements: structuredClone(requirements),
        constraints: structuredClone(constraints),
        reference_layers: structuredClone(previewPayload.reference_layers),
        candidate_count: candidateCount,
        max_layers: maxLayers,
        top_k: topK,
        top_p: topP,
        temperatures,
        sample_count: sampleCount,
        seed_count: seedCount,
        include_greedy: includeGreedy,
        beam_width: beamWidth,
        length_penalty: lengthPenalty,
        seed,
        reflectance_weight: 1,
        transmittance_weight: 1,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setSubmitting(false); }
  };

  const targetError = preview?.key === previewKey ? preview.error ?? "" : "正在检查设计要求";
  const active = job && ["queued", "running"].includes(job.status);
  return (
    <main className="page-shell">
      <div className="page-title">
        <div><span className="eyebrow">INVERSE DESIGN · V4</span><h1>OptoGPT 逆向设计</h1><p>绘制自定义 R/T 目标，生成候选并可选连续厚度精修。</p></div>
        <div className="title-actions">
          <button className="secondary-button" disabled={!candidates.length} onClick={onReviewCandidates}>比较 / 采用已保存候选</button>
          {active ? <button className="danger-button" onClick={() => api.cancelInverseJob(job.id).then(setJob).catch(e => setError(String(e)))}>停止</button> : <button className="primary-button" disabled={submitting || !previewReady} title={targetError} onClick={start}>{submitting ? "提交中…" : "生成候选"}</button>}
        </div>
      </div>

      {error && <div className="alert error-alert">{error}</div>}
      {candidateDesign?.job_status && <p className="search-help">候选来自任务 {candidateDesign.job_id?.slice(0,8)} · 状态 {candidateDesign.job_status}。运行中可查看部分已验证结果；后续排名仍可能改变。当前编辑不会改写这些候选的目标快照。</p>}
      <div className="constraint-banner"><strong>当前模型边界</strong><span>400–1100 nm · 10 nm 采样 · 最多 20 层 · 模型材料词表 · 法向入射验证</span></div>
      <DesignSettings requirements={requirements} onRequirementsChange={onRequirementsChange} constraints={constraints} onConstraintsChange={onConstraintsChange} referenceLayers={referenceLayers} materials={materials} preview={previewReady?preview?.data:undefined} pending={preview?.key!==previewKey} error={targetError} />
      <TargetEditor value={editor} onChange={onEditorChange} passiveValidation={false} modelInput={previewReady?preview?.data?.model_target:undefined} />
      <div className="workspace-grid inverse-grid">
        <section className="panel inverse-controls">
          <div className="panel-heading"><h2>生成设置</h2></div>
          <RefinementSettingsPanel value={refinement} onChange={onRefinementChange} />
          <div className="form-grid two-columns">
            <label>最终保留数量<NumberField value={candidateCount} onChange={(value) => setCandidateCount(value)} min={1} max={100} integer /></label>
            <label>最大层数<NumberField value={maxLayers} onChange={(value) => setMaxLayers(value)} min={1} max={20} integer /></label>
            <label>随机抽样次数<NumberField value={sampleCount} onChange={setSampleCount} min={200} max={500} integer /></label>
            <label>种子数量<NumberField value={seedCount} onChange={setSeedCount} min={4} max={8} integer /></label>
            <label>Top-k<NumberField value={topK} onChange={setTopK} min={1} max={1000} integer /></label>
            <label>Top-p<NumberField value={topP} onChange={setTopP} min={0.01} max={1} step={0.05} /></label>
            <label>起始种子<NumberField value={seed} onChange={setSeed} min={0} max={4294967295} integer /></label>
          </div>
          <p className="search-help">抽样预算在种子 × 温度组合间均分；重复结果也计入预算。Greedy 与 beam 候选额外加入。</p>
          <div className="form-grid three-columns">{temperatures.map((value, index) => <label key={index}>温度 {index + 1}<NumberField value={value} min={0.1} max={5} step={0.05} onChange={next => setTemperatures(current => current.map((t, i) => i === index ? next : t))} /></label>)}</div>
          <details className="search-options"><summary>辅助搜索与参数说明</summary>
            <label className="search-check"><input type="checkbox" checked={includeGreedy} onChange={e => setIncludeGreedy(e.target.checked)} />加入 greedy 候选</label>
            <div className="form-grid two-columns">
              <label>Beam 宽度（0 关闭）<NumberField value={beamWidth} onChange={setBeamWidth} min={0} max={20} integer /></label>
              <label>长度归一化 α<NumberField value={lengthPenalty} onChange={setLengthPenalty} min={0} max={2} step={0.1} /></label>
            </div>
            <p className="search-help">Top-k 限制每步候选 token 数，Top-p 截取累计概率；低温度偏向高概率选择。Greedy 每步取最大概率，beam 同时保留多条序列。α 缓解长序列累积概率偏低的问题，不能保证光谱更准。</p>
          </details>
          {job?.result?.search_summary && <div className="job-card"><strong>本次搜索统计</strong><p>随机抽样 {job.result.search_summary.sampled_count} 次 · 总输出 {job.result.search_summary.raw_count} 组 · 重复 {job.result.search_summary.duplicate_count} 组</p><p>已验证 {job.result.search_summary.verified_count} 组 · 保留 {job.result.search_summary.retained_count} 组</p><small>按要求违反误差优先排序，再按考核误差和复杂度排序。</small><button className="small-button" onClick={() => downloadText('optogpt-search-v4-requirements.json', JSON.stringify(job.result, null, 2))}>导出本次搜索（含参数和目标）</button></div>}
          <div className="target-stats"><span>目标点数<strong>{target.wavelengths_nm.length}</strong></span><span>波长范围<strong>{target.wavelengths_nm[0]}–{target.wavelengths_nm[target.wavelengths_nm.length - 1]} nm</strong></span></div>
          {job && <div className="job-card"><div className="job-title"><span>{job.message}</span><strong>{Math.round(job.progress * 100)}%</strong></div><div className="progress-track"><span style={{ width: `${job.progress * 100}%` }} /></div><small>阶段：{job.stage}</small></div>}
        </section>
        <section className="panel candidate-preview">
          <div className="panel-heading"><h2>候选预览</h2><span>{candidates.length ? `${candidates.length} 组已验证` : "等待生成"}</span></div>
          {candidates.length === 0 ? <div className="empty-state"><div className="empty-orbit">◎</div><h3>目标准备完成</h3><p>点击“生成候选”后，OptoGPT 将生成多组膜系并交给 TMM 评分。</p></div> :
            <div className="candidate-list">{candidates.slice(0, 6).map((candidate) => <div className="candidate-card" key={candidate.rank}><div className="rank-badge">#{candidate.rank}</div><div className="candidate-main"><strong>{candidate.layers.map(l=>`${l.material} ${l.thickness_nm.toFixed(3)} nm`).join(" / ")}</strong><span>{candidate.layer_count} 层 · {candidate.total_thickness_nm.toFixed(1)} nm · R MAE {formatPercent(candidate.mae_r)} · T MAE {formatPercent(candidate.mae_t)} · {candidate.sources?.join(" + ")}</span>{candidate.requirement_score!=null && <span>违反要求 {formatPercent(candidate.requirement_score)} · 加权达标 {formatPercent(candidate.pass_rate ?? 0)}</span>}{candidate.refinement && <span>{candidate.refinement.accepted?"连续精修已改善":"保留初始厚度"} · {candidate.refinement.message} · 求值 {candidate.refinement.evaluations}</span>}</div><button className="small-button" onClick={() => onUseCandidate(candidate)}>用于正向设计</button></div>)}</div>}
        </section>
      </div>
    </main>
  );
}
