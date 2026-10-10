import { NumberField } from "../components/NumberField";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { TargetEditor } from "../components/TargetEditor";
import type { Candidate, InverseJob, TargetEditorState, TargetSpectrum } from "../types";
import { downloadText, formatPercent } from "../utils";
import { validateSpectrum } from "../targetEditor";

interface InversePageProps {
  target: TargetSpectrum;
  editor: TargetEditorState;
  onEditorChange: (editor: TargetEditorState) => void;
  onCandidatesChange: (candidates: Candidate[], snapshot: TargetSpectrum) => void;
  onUseCandidate: (candidate: Candidate) => void;
}

export function InversePage({ target, editor, onEditorChange, onCandidatesChange, onUseCandidate }: InversePageProps) {
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
        if (next.status === "completed" && next.result) onCandidatesChange(next.result.candidates, submittedTarget.current);
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
    try { validateSpectrum(target); } catch (caught) { setError((caught as Error).message); return; }
    setSubmitting(true);
    submittedTarget.current = structuredClone(target);
    setError(null);
    try {
      setJob(await api.createInverseJob({
        target: submittedTarget.current,
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

  const candidates = job?.result?.candidates ?? [];
  let targetError = "";
  try { validateSpectrum(target); } catch (caught) { targetError = (caught as Error).message; }
  const active = job && ["queued", "running"].includes(job.status);
  return (
    <main className="page-shell">
      <div className="page-title">
        <div><span className="eyebrow">INVERSE DESIGN · V4</span><h1>OptoGPT 逆向设计</h1><p>绘制自定义 R/T 目标，生成并验证候选膜系。</p></div>
        <div className="title-actions">
          {active ? <button className="danger-button" onClick={() => api.cancelInverseJob(job.id).then(setJob).catch(e => setError(String(e)))}>停止</button> : <button className="primary-button" disabled={submitting || !!targetError} title={targetError} onClick={start}>{submitting ? "提交中…" : "生成候选"}</button>}
        </div>
      </div>

      {error && <div className="alert error-alert">{error}</div>}
      <div className="constraint-banner"><strong>当前模型边界</strong><span>400–1100 nm · 10 nm 采样 · 最多 20 层 · 模型材料词表 · 法向入射验证</span></div>
      <TargetEditor value={editor} onChange={onEditorChange} />
      <div className="workspace-grid inverse-grid">
        <section className="panel inverse-controls">
          <div className="panel-heading"><h2>生成设置</h2></div>
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
          {job?.result?.search_summary && <div className="job-card"><strong>本次搜索统计</strong><p>随机抽样 {job.result.search_summary.sampled_count} 次 · 总输出 {job.result.search_summary.raw_count} 组 · 重复 {job.result.search_summary.duplicate_count} 组</p><p>已验证 {job.result.search_summary.verified_count} 组 · 保留 {job.result.search_summary.retained_count} 组</p><small>按 R/T 平均 MAE 优先排序，复杂度仅用于误差相同时排序。</small><button className="small-button" onClick={() => downloadText('optogpt-search-v3.json', JSON.stringify(job.result, null, 2))}>导出本次搜索（含参数和目标）</button></div>}
          <div className="target-stats"><span>目标点数<strong>{target.wavelengths_nm.length}</strong></span><span>波长范围<strong>{target.wavelengths_nm[0]}–{target.wavelengths_nm[target.wavelengths_nm.length - 1]} nm</strong></span></div>
          {job && <div className="job-card"><div className="job-title"><span>{job.message}</span><strong>{Math.round(job.progress * 100)}%</strong></div><div className="progress-track"><span style={{ width: `${job.progress * 100}%` }} /></div><small>阶段：{job.stage}</small></div>}
        </section>
        <section className="panel candidate-preview">
          <div className="panel-heading"><h2>候选预览</h2><span>{candidates.length ? `${candidates.length} 组已验证` : "等待生成"}</span></div>
          {candidates.length === 0 ? <div className="empty-state"><div className="empty-orbit">◎</div><h3>目标准备完成</h3><p>点击“生成候选”后，OptoGPT 将生成多组膜系并交给 TMM 评分。</p></div> :
            <div className="candidate-list">{candidates.slice(0, 6).map((candidate) => <div className="candidate-card" key={candidate.rank}><div className="rank-badge">#{candidate.rank}</div><div className="candidate-main"><strong>{candidate.tokens.join(" / ")}</strong><span>{candidate.layer_count} 层 · {candidate.total_thickness_nm.toFixed(0)} nm · R MAE {formatPercent(candidate.mae_r)} · T MAE {formatPercent(candidate.mae_t)} · {candidate.sources?.join(" + ")}</span></div><button className="small-button" onClick={() => onUseCandidate(candidate)}>用于正向设计</button></div>)}</div>}
        </section>
      </div>
    </main>
  );
}
