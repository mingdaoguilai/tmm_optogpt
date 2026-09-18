import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { SpectrumPlot } from "../components/SpectrumPlot";
import type { Candidate, InverseJob, TargetSpectrum } from "../types";
import { createTarget, formatPercent, parseTargetCsv, type TargetTemplate } from "../utils";

interface InversePageProps {
  target: TargetSpectrum;
  onTargetChange: (target: TargetSpectrum) => void;
  onCandidatesChange: (candidates: Candidate[]) => void;
  onUseCandidate: (candidate: Candidate) => void;
}

export function InversePage({ target, onTargetChange, onCandidatesChange, onUseCandidate }: InversePageProps) {
  const [template, setTemplate] = useState<TargetTemplate>("bandpass");
  const [candidateCount, setCandidateCount] = useState(20);
  const [maxLayers, setMaxLayers] = useState(20);
  const [temperature, setTemperature] = useState(1);
  const [seed, setSeed] = useState(42);
  const [job, setJob] = useState<InverseJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.inverseJob(job.id);
        setJob(next);
        if (next.status === "completed" && next.result) onCandidatesChange(next.result.candidates);
        if (next.status === "failed") setError(next.error?.message ?? next.message);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }, 900);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  const start = async () => {
    setError(null);
    try {
      setJob(await api.createInverseJob({
        target,
        candidate_count: candidateCount,
        max_layers: maxLayers,
        top_k: 50,
        temperature,
        seed,
        reflectance_weight: 1,
        transmittance_weight: 1,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const importCsv = async (file: File) => {
    try {
      onTargetChange(parseTargetCsv(await file.text()));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const candidates = job?.result?.candidates ?? [];
  const active = job && ["queued", "running"].includes(job.status);
  return (
    <main className="page-shell">
      <div className="page-title">
        <div><span className="eyebrow">INVERSE DESIGN</span><h1>OptoGPT 逆向设计</h1><p>从目标 R/T 光谱生成结构，并由 TMM 逐组复算排名。</p></div>
        <div className="title-actions">
          <button className="secondary-button" onClick={() => uploadRef.current?.click()}>导入目标 CSV</button>
          <input ref={uploadRef} hidden type="file" accept=".csv,text/csv" onChange={(event) => event.target.files?.[0] && importCsv(event.target.files[0])} />
          {active ? <button className="danger-button" onClick={() => api.cancelInverseJob(job.id)}>停止</button> : <button className="primary-button" onClick={start}>生成候选</button>}
        </div>
      </div>

      {error && <div className="alert error-alert">{error}</div>}
      <div className="constraint-banner"><strong>当前模型边界</strong><span>400–1100 nm · 10 nm 采样 · 最多 20 层 · 模型材料词表 · 法向入射验证</span></div>
      <div className="workspace-grid inverse-grid">
        <section className="panel inverse-controls">
          <div className="panel-heading"><h2>目标与生成设置</h2></div>
          <label>快速目标模板
            <select value={template} onChange={(event) => { const next = event.target.value as TargetTemplate; setTemplate(next); onTargetChange(createTarget(next)); }}>
              <option value="high-reflector">宽带高反</option><option value="anti-reflection">宽带增透</option><option value="bandpass">带通滤光</option><option value="edge-filter">长波通边缘</option>
            </select>
          </label>
          <div className="form-grid two-columns">
            <label>候选数量<input type="number" min="1" max="100" value={candidateCount} onChange={(event) => setCandidateCount(Number(event.target.value))} /></label>
            <label>最大层数<input type="number" min="1" max="20" value={maxLayers} onChange={(event) => setMaxLayers(Number(event.target.value))} /></label>
            <label>采样温度<input type="number" min="0.1" max="5" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} /></label>
            <label>随机种子<input type="number" min="0" value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label>
          </div>
          <div className="target-stats"><span>目标点数<strong>{target.wavelengths_nm.length}</strong></span><span>波长范围<strong>{target.wavelengths_nm[0]}–{target.wavelengths_nm[target.wavelengths_nm.length - 1]} nm</strong></span></div>
          {job && <div className="job-card"><div className="job-title"><span>{job.message}</span><strong>{Math.round(job.progress * 100)}%</strong></div><div className="progress-track"><span style={{ width: `${job.progress * 100}%` }} /></div><small>阶段：{job.stage}</small></div>}
        </section>
        <section className="panel target-chart"><div className="panel-heading"><h2>目标光谱</h2><span className="status-dot">R + T</span></div><SpectrumPlot target={target} compact /></section>
        <section className="panel candidate-preview">
          <div className="panel-heading"><h2>候选预览</h2><span>{candidates.length ? `${candidates.length} 组已验证` : "等待生成"}</span></div>
          {candidates.length === 0 ? <div className="empty-state"><div className="empty-orbit">◎</div><h3>目标准备完成</h3><p>点击“生成候选”后，OptoGPT 将生成多组膜系并交给 TMM 评分。</p></div> :
            <div className="candidate-list">{candidates.slice(0, 6).map((candidate) => <div className="candidate-card" key={candidate.rank}><div className="rank-badge">#{candidate.rank}</div><div className="candidate-main"><strong>{candidate.tokens.join(" / ")}</strong><span>{candidate.layer_count} 层 · {candidate.total_thickness_nm.toFixed(0)} nm · R MAE {formatPercent(candidate.mae_r)}</span></div><button className="small-button" onClick={() => onUseCandidate(candidate)}>用于正向设计</button></div>)}</div>}
        </section>
      </div>
    </main>
  );
}
