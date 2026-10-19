import { NumberField } from "../components/NumberField";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { SpectrumPlot } from "../components/SpectrumPlot";
import { StackEditor } from "../components/StackEditor";
import { AdoptionVerification } from "../components/AdoptionVerification";
import type { AdoptedCandidate, CandidateVerification } from "../types";
import type { Material, SimulationRequest, SimulationResult } from "../types";
import { downloadText, formatPercent } from "../utils";

interface ForwardPageProps {
  adoption: AdoptedCandidate | null;
  verification: CandidateVerification | null;
  onVerification: (value:CandidateVerification)=>void;
  onCompare: ()=>void;
  request: SimulationRequest;
  materials: Material[];
  onRequestChange: (request: SimulationRequest) => void;
}

export function ForwardPage({ adoption, verification, onVerification, onCompare, request, materials, onRequestChange }: ForwardPageProps) {
  const [auto, setAuto] = useState(true);
  const sequence = useRef(0);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [resultRequest, setResultRequest] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const id = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const response = await api.simulate(request);
      if (id === sequence.current) { setResult(response); setResultRequest(JSON.stringify(request)); }
    } catch (caught) {
      if (id === sequence.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (id === sequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    sequence.current++;
    setLoading(false);
    if (!auto) return;
    const timer = window.setTimeout(run, 350);
    return () => window.clearTimeout(timer);
  }, [request, auto]);

  const summary = useMemo(() => {
    if (!result) return null;
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      r: average(result.reflectance),
      t: average(result.transmittance),
      a: average(result.absorptance),
    };
  }, [result]);

  const patch = (change: Partial<SimulationRequest>) => onRequestChange({ ...request, ...change });
  const exportCsv = () => {
    if (!result || loading || error || resultRequest !== JSON.stringify(request)) return;
    const rows = ["wavelength_nm,R,T,A"];
    result.wavelengths_nm.forEach((wavelength, index) => {
      rows.push([wavelength, result.reflectance[index], result.transmittance[index], result.absorptance[index]].join(","));
    });
    downloadText("tmm-spectrum.csv", rows.join("\n"), "text/csv");
  };

  return (
    <main className="page-shell">
      <div className="page-title">
        <div><span className="eyebrow">FORWARD DESIGN</span><h1>多层膜正向仿真</h1><p>编辑膜系后自动使用 TMM 更新光谱。</p></div>
        <div className="title-actions">
          <button className="secondary-button" onClick={exportCsv} disabled={!result || loading || !!error || resultRequest !== JSON.stringify(request)}>导出 CSV</button>
          <button className="primary-button" onClick={run} disabled={loading}>{loading ? "计算中…" : "立即计算"}</button>
        </div>
      </div>

      {error && <div className="alert error-alert">{error}</div>}
      {adoption && <AdoptionVerification key={JSON.stringify(adoption)} adoption={adoption} request={request} verification={verification} onVerification={onVerification} onCompare={onCompare} />}
      <div className="workspace-grid forward-grid">
        <section className="panel controls-panel">
          <div className="panel-heading"><h2>计算条件</h2><label className="auto-toggle"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />自动更新</label></div>
          <div className="form-grid three-columns">
            <label>起始波长<NumberField value={request.wavelength_start_nm} onChange={(value) => patch({ wavelength_start_nm: value })} min={0} unit="nm" /></label>
            <label>终止波长<NumberField value={request.wavelength_end_nm} onChange={(value) => patch({ wavelength_end_nm: value })} min={0} unit="nm" /></label>
            <label>步长<NumberField value={request.wavelength_step_nm} onChange={(value) => patch({ wavelength_step_nm: value })} min={0.1} unit="nm" /></label>
            <label>入射角 / °<NumberField value={request.angle_deg} onChange={(value) => patch({ angle_deg: value })} min={0} max={89} unit="°" /></label>
            <label>偏振<select value={request.polarization} onChange={(event) => patch({ polarization: event.target.value as SimulationRequest["polarization"] })}><option value="unpolarized">非偏振</option><option value="s">s 偏振</option><option value="p">p 偏振</option></select></label>
            <label>基底<select value={request.substrate_material} onChange={(event) => patch({ substrate_material: event.target.value })}>{materials.filter((item) => item.id !== "Air" && item.category !== "alternate").map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          </div>
          <div className="form-grid three-columns"><label>基底厚度<NumberField value={request.substrate_thickness_nm} onChange={value => patch({substrate_thickness_nm:value})} min={0.001} unit="nm" /></label><label>基底相干性<select value={String(request.substrate_coherent)} onChange={e => patch({substrate_coherent:e.target.value === "true"})}><option value="false">非相干</option><option value="true">相干</option></select></label></div>
          <p className="stack-direction">光照方向：{request.incident_material} → 膜层 1 至 {request.layers.length} → {request.substrate_material} → {request.exit_material}</p>
          <div className="stack-summary">
            <span>{request.layers.length} 层</span><span>{request.layers.reduce((sum, layer) => sum + Number(layer.thickness_nm || 0), 0).toFixed(1)} nm 总厚度</span>
          </div>
          <StackEditor layers={request.layers} materials={materials} onChange={(layers) => patch({ layers })} />
        </section>

        <section className="panel chart-panel">
          <div className="panel-heading"><h2>光谱响应</h2><span className={loading ? "status-dot busy" : "status-dot"}>{loading ? "计算中" : error ? "计算失败，保留上次结果" : resultRequest !== JSON.stringify(request) ? "待计算" : "已更新"}</span></div>
          <SpectrumPlot simulation={result} />
          <div className="metric-row">
            <div className="metric"><span>平均反射率</span><strong>{summary ? formatPercent(summary.r) : "—"}</strong></div>
            <div className="metric"><span>平均透射率</span><strong>{summary ? formatPercent(summary.t) : "—"}</strong></div>
            <div className="metric"><span>平均吸收率</span><strong>{summary ? formatPercent(summary.a) : "—"}</strong></div>
            <div className="metric"><span>吸收率定义</span><strong>A = 1 − R − T</strong></div>
          </div>
        </section>
      </div>
    </main>
  );
}
