import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { SpectrumPlot } from "../components/SpectrumPlot";
import { StackEditor } from "../components/StackEditor";
import type { Material, SimulationRequest, SimulationResult } from "../types";
import { downloadText, formatPercent } from "../utils";

interface ForwardPageProps {
  request: SimulationRequest;
  materials: Material[];
  onRequestChange: (request: SimulationRequest) => void;
}

export function ForwardPage({ request, materials, onRequestChange }: ForwardPageProps) {
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.simulate(request));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(run, 350);
    return () => window.clearTimeout(timer);
  }, [request]);

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
    if (!result) return;
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
          <button className="secondary-button" onClick={exportCsv} disabled={!result}>导出 CSV</button>
          <button className="primary-button" onClick={run} disabled={loading}>{loading ? "计算中…" : "立即计算"}</button>
        </div>
      </div>

      {error && <div className="alert error-alert">{error}</div>}
      <div className="workspace-grid forward-grid">
        <section className="panel controls-panel">
          <div className="panel-heading"><h2>计算条件</h2><span className="live-pill">自动更新</span></div>
          <div className="form-grid three-columns">
            <label>起始波长<input type="number" value={request.wavelength_start_nm} onChange={(event) => patch({ wavelength_start_nm: Number(event.target.value) })} /></label>
            <label>终止波长<input type="number" value={request.wavelength_end_nm} onChange={(event) => patch({ wavelength_end_nm: Number(event.target.value) })} /></label>
            <label>步长<input type="number" min="0.1" value={request.wavelength_step_nm} onChange={(event) => patch({ wavelength_step_nm: Number(event.target.value) })} /></label>
            <label>入射角 / °<input type="number" min="0" max="89" value={request.angle_deg} onChange={(event) => patch({ angle_deg: Number(event.target.value) })} /></label>
            <label>偏振<select value={request.polarization} onChange={(event) => patch({ polarization: event.target.value as SimulationRequest["polarization"] })}><option value="unpolarized">非偏振</option><option value="s">s 偏振</option><option value="p">p 偏振</option></select></label>
            <label>基底<select value={request.substrate_material} onChange={(event) => patch({ substrate_material: event.target.value })}>{materials.filter((item) => item.id !== "Air" && item.category !== "alternate").map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          </div>
          <div className="stack-summary">
            <span>{request.layers.length} 层</span><span>{request.layers.reduce((sum, layer) => sum + Number(layer.thickness_nm || 0), 0).toFixed(1)} nm 总厚度</span>
          </div>
          <StackEditor layers={request.layers} materials={materials} onChange={(layers) => patch({ layers })} />
        </section>

        <section className="panel chart-panel">
          <div className="panel-heading"><h2>光谱响应</h2><span className={loading ? "status-dot busy" : "status-dot"}>{loading ? "重新计算" : "已同步"}</span></div>
          <SpectrumPlot simulation={result} />
          <div className="metric-row">
            <div className="metric"><span>平均反射率</span><strong>{summary ? formatPercent(summary.r) : "—"}</strong></div>
            <div className="metric"><span>平均透射率</span><strong>{summary ? formatPercent(summary.t) : "—"}</strong></div>
            <div className="metric"><span>平均吸收率</span><strong>{summary ? formatPercent(summary.a) : "—"}</strong></div>
            <div className="metric"><span>能量误差</span><strong>{result ? result.max_energy_error.toExponential(1) : "—"}</strong></div>
          </div>
        </section>
      </div>
    </main>
  );
}
