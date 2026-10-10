import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { NumberField } from "./NumberField";
import type { ControlPoint, TargetEditorState } from "../types";
import { createTarget, downloadText, parseTargetCsv, type TargetTemplate } from "../utils";
import { applyGenerator, editorFromSpectrum, editorToSpectrum, interpolatePoints, modelWavelengths, setChannelPoints, spectrumToCsv, validateEditor, validateSpectrum } from "../targetEditor";

type Props = { value: TargetEditorState; onChange: (value: TargetEditorState) => void };
const X0 = 52, Y0 = 22, WIDTH = 688, HEIGHT = 232;
const px = (x: number) => X0 + (x - 400) * WIDTH / 700;
const py = (v: number) => Y0 + (1 - v) * HEIGHT;
const percent = (value: number) => Number((value * 100).toFixed(4));
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

export function TargetEditor({ value, onChange }: Props) {
  const [past, setPast] = useState<TargetEditorState[]>([]);
  const [future, setFuture] = useState<TargetEditorState[]>([]);
  const [draft, setDraft] = useState<TargetEditorState | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [csv, setCsv] = useState("");
  const [showModel, setShowModel] = useState(true);
  const svg = useRef<SVGSVGElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ index: number; base: TargetEditorState; latest: TargetEditorState } | null>(null);
  const working = draft ?? value;
  const spectrum = useMemo(() => editorToSpectrum(working), [working]);
  const points = working.points[working.channel];
  const index = Math.min(selected, points.length - 1);
  const point = points[index];
  let warning = "";
  try { validateSpectrum(spectrum); } catch (caught) { warning = (caught as Error).message; }
  const path = (values: number[]) => spectrum.wavelengths_nm.map((x, i) => `${i ? "L" : "M"}${px(x).toFixed(2)},${py(values[i]).toFixed(2)}`).join(" ");
  const modelValues = interpolatePoints(spectrum.wavelengths_nm.map((wavelength_nm, i) => ({ wavelength_nm, value: working.channel === "R" ? spectrum.reflectance[i] : spectrum.transmittance[i] })), modelWavelengths, "linear");
  const modelPath = modelWavelengths.map((x, i) => `${i ? "L" : "M"}${px(x)},${py(modelValues[i])}`).join(" ");
  const reconstructed = interpolatePoints(modelWavelengths.map((wavelength_nm, i) => ({ wavelength_nm, value: modelValues[i] })), spectrum.wavelengths_nm, "linear");
  const mismatch = reconstructed.reduce((largest, v, i) => Math.max(largest, Math.abs(v - (working.channel === "R" ? spectrum.reflectance[i] : spectrum.transmittance[i]))), 0);

  const commit = (next: TargetEditorState, base = value) => {
    try {
      validateEditor(next);
      if (JSON.stringify(next) === JSON.stringify(base)) return;
      setPast(current => [...current.slice(-29), structuredClone(base)]);
      setFuture([]); onChange(next); setError("");
    } catch (caught) { setError((caught as Error).message); }
  };
  const undo = () => {
    if (!past.length) return;
    setFuture(current => [...current, structuredClone(value)]);
    onChange(past[past.length - 1]); setPast(past.slice(0, -1)); setSelected(0); setError("");
  };
  const redo = () => {
    if (!future.length) return;
    setPast(current => [...current, structuredClone(value)]);
    onChange(future[future.length - 1]); setFuture(future.slice(0, -1)); setSelected(0); setError("");
  };
  const limits = (at: number, list = points) => ({
    min: at === 0 ? 400 : list[at - 1].wavelength_nm + 0.01,
    max: at === list.length - 1 ? 1100 : list[at + 1].wavelength_nm - 0.01,
  });
  const editPoint = (x: number, y: number) => {
    const next = points.map((p, i) => i === index ? { wavelength_nm: x, value: y } : p);
    commit(setChannelPoints(value, next));
  };
  const addPoint = (x?: number, y?: number) => {
    if (points.length >= 2000) { setError("最多支持 2000 个控制点"); return; }
    if (x === undefined) {
      let gap = 0, at = 0;
      points.slice(1).forEach((p, i) => { const width = p.wavelength_nm - points[i].wavelength_nm; if (width > gap) { gap = width; at = i; } });
      x = (points[at].wavelength_nm + points[at + 1].wavelength_nm) / 2;
    }
    x = Math.round(clamp(x, 400, 1100) * 100) / 100;
    const existing = points.findIndex(p => Math.abs(p.wavelength_nm - x!) < 0.01);
    if (existing >= 0) { setSelected(existing); return; }
    y ??= interpolatePoints(points, [x], working.interpolation)[0];
    const next = [...points, { wavelength_nm: x, value: clamp(y, 0, 1) }].sort((a, b) => a.wavelength_nm - b.wavelength_nm);
    setSelected(next.findIndex(p => p.wavelength_nm === x));
    commit(setChannelPoints(value, next));
  };
  const removePoint = () => {
    if (index === 0 || index === points.length - 1) return;
    commit(setChannelPoints(value, points.filter((_, i) => i !== index))); setSelected(index - 1);
  };
  const coordinate = (event: ReactPointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return { x: 400, y: 0 };
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: 400 + (position.x - X0) * 700 / WIDTH, y: 1 - (position.y - Y0) / HEIGHT };
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const { base, index: at } = drag.current;
    const list = base.points[base.channel], bounds = limits(at, list), p = coordinate(event);
    const wavelength_nm = at === 0 ? 400 : at === list.length - 1 ? 1100
      : Math.round(clamp(p.x, bounds.min, bounds.max) * 100) / 100;
    const next = setChannelPoints(base, list.map((original, i) => i === at
      ? { wavelength_nm, value: Math.round(clamp(p.y, 0, 1) * 10000) / 10000 } : original));
    drag.current.latest = next; setDraft(next);
  };
  const finish = (event: ReactPointerEvent<SVGSVGElement>, cancelled = false) => {
    if (drag.current && !cancelled) commit(drag.current.latest, drag.current.base);
    drag.current = null; setDraft(null);
    if (svg.current?.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId);
  };
  const importText = (text: string, label: string) => {
    try { commit(editorFromSpectrum(parseTargetCsv(text), label)); setSelected(0); }
    catch (caught) { setError((caught as Error).message); }
  };
  const patchGenerator = (patch: Partial<TargetEditorState["generator"]>) => commit({ ...value, generator: { ...value.generator, ...patch } });

  return <section className="panel spectrum-editor">
    <div className="panel-heading"><h2>自由目标光谱</h2><span>控制点编辑 · 400–1100 nm</span></div>
    <div className="spectrum-editor-body">
      <div className="editor-toolbar">
        <label>编辑通道<select value={value.channel} onChange={e => { onChange({ ...value, channel: e.target.value as "R" | "T" }); setSelected(0); }}><option value="R">反射率 R</option><option value="T">透射率 T</option></select></label>
        <label>连接方式<select value={value.interpolation} onChange={e => commit({ ...value, interpolation: e.target.value as "linear" | "pchip" })}><option value="linear">折线</option><option value="pchip">保形平滑</option></select></label>
        <label className="editor-check"><input type="checkbox" checked={value.linked} onChange={e => commit(setChannelPoints({ ...value, linked: e.target.checked }, points))} />无吸收联动（R + T = 1）</label>
        <button className="small-button" disabled={!past.length || !!draft} onClick={undo}>撤销光谱</button>
        <button className="small-button" disabled={!future.length || !!draft} onClick={redo}>重做光谱</button>
      </div>
      <p className="search-help">拖动圆点改变曲线；双击图内添加控制点。先选中控制点，可用方向键微调、Delete 删除。端点波长固定。关闭联动后 R/T 独立编辑，支持吸收目标。</p>
      {error && <div className="alert error-alert" role="alert">{error}</div>}
      {warning && <div className="alert error-alert" role="alert">{warning}；此目标暂不能提交反演。</div>}
      <svg ref={svg} className="target-editor-svg" viewBox="0 0 760 300" role="group" aria-label="可编辑目标光谱图，双击添加点，拖动控制点修改" onDoubleClick={e => { const p = coordinate(e); if (p.x > 400 && p.x < 1100 && p.y >= 0 && p.y <= 1) addPoint(p.x, p.y); }} onPointerMove={move} onPointerUp={e => finish(e)} onPointerCancel={e => finish(e, true)}>
        <defs><clipPath id="target-edit-clip"><rect x={X0} y={Y0} width={WIDTH} height={HEIGHT} /></clipPath></defs>
        {[0, 0.25, 0.5, 0.75, 1].map(v => <g key={v}><line className="editor-grid" x1={X0} x2={X0 + WIDTH} y1={py(v)} y2={py(v)} /><text x={X0 - 8} y={py(v) + 4} textAnchor="end">{v * 100}%</text></g>)}
        {[400, 500, 600, 700, 800, 900, 1000, 1100].map(x => <g key={x}><line className="editor-grid" x1={px(x)} x2={px(x)} y1={Y0} y2={Y0 + HEIGHT} /><text x={px(x)} y={Y0 + HEIGHT + 20} textAnchor="middle">{x}</text></g>)}
        <text x="400" y="295" textAnchor="middle">波长 / nm</text>
        <g clipPath="url(#target-edit-clip)">
          <path d={path(spectrum.reflectance)} className="editor-curve r" />
          <path d={path(spectrum.transmittance)} className="editor-curve t" />
          {showModel && <path d={modelPath} className="editor-model" />}
        </g>
        {points.map((p, at) => <circle key={at} data-testid={`control-point-${at}`} className={`editor-point ${working.channel.toLowerCase()} ${index === at ? "selected" : ""}`} cx={px(p.wavelength_nm)} cy={py(p.value)} r={index === at ? 6 : 3.5} tabIndex={0} role="button" aria-label={`${working.channel} 控制点 ${at + 1}，${p.wavelength_nm.toFixed(2)} nm，${(p.value * 100).toFixed(2)}%`} onDoubleClick={e => e.stopPropagation()} onPointerDown={e => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); e.currentTarget.focus(); setSelected(at); drag.current = { index: at, base: value, latest: value }; svg.current?.setPointerCapture(e.pointerId); }} onKeyDown={e => {
          if (e.key === "Escape") { drag.current = null; setDraft(null); return; }
          if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); if (at > 0 && at < points.length - 1) { commit(setChannelPoints(value, points.filter((_, i) => i !== at))); setSelected(at - 1); } return; }
          if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
          e.preventDefault(); setSelected(at);
          const bounds = limits(at);
          const next: ControlPoint = { wavelength_nm: at === 0 || at === points.length - 1 ? p.wavelength_nm : clamp(p.wavelength_nm + (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0), bounds.min, bounds.max), value: clamp(p.value + (e.key === "ArrowUp" ? 0.01 : e.key === "ArrowDown" ? -0.01 : 0), 0, 1) };
          commit(setChannelPoints(value, points.map((original, i) => i === at ? next : original)));
        }} />)}
      </svg>
      <div className="editor-legend"><span className="r">● 目标 R</span><span className="t">● 目标 T</span><label className="editor-check"><input type="checkbox" checked={showModel} onChange={e => setShowModel(e.target.checked)} />虚线：当前通道的模型输入（10 nm）</label></div>
      {mismatch > 0.02 && <p className="editor-warning" role="status">当前曲线含有细于模型采样网格的变化，重采样后最大偏差约 {(mismatch * 100).toFixed(1)} 个百分点。拖拽精度不会改变模型的10 nm输入限制。</p>}
      <div className="editor-point-controls">
        <label>选中控制点<select value={index} onChange={e => setSelected(Number(e.target.value))}>{points.map((p, i) => <option key={i} value={i}>{i + 1} · {p.wavelength_nm.toFixed(2)} nm</option>)}</select></label>
        <label>控制点波长<NumberField value={point.wavelength_nm} onChange={x => editPoint(x, point.value)} min={limits(index).min} max={limits(index).max} unit="nm" step={1} disabled={index === 0 || index === points.length - 1} /></label>
        <label>控制点幅值<NumberField value={percent(point.value)} onChange={y => editPoint(point.wavelength_nm, y / 100)} min={0} max={100} unit="%" step={1} /></label>
        <button className="small-button" onClick={() => addPoint()}>添加控制点</button>
        <button className="small-button" disabled={index === 0 || index === points.length - 1} onClick={removePoint}>删除选中点</button>
      </div>
      <details className="editor-section" open><summary>参数化光谱组件</summary>
        <div className="form-grid three-columns">
          <label>组件类型<select value={value.generator.shape} onChange={e => patchGenerator({ shape: e.target.value as TargetEditorState["generator"]["shape"] })}><option value="gaussian">高斯峰</option><option value="notch">高斯陷波</option><option value="bandpass">带通</option><option value="edge">长波通边缘</option></select></label>
          <label>中心 / 边缘位置<NumberField value={value.generator.center_nm} onChange={center_nm => patchGenerator({ center_nm })} min={400} max={1100} unit="nm" /></label>
          <label>带宽（高斯为半高全宽）<NumberField value={value.generator.width_nm} onChange={width_nm => patchGenerator({ width_nm })} min={1} max={700} unit="nm" disabled={value.generator.shape === "edge"} /></label>
          <label>边缘过渡宽度（10–90%）<NumberField value={value.generator.transition_nm} onChange={transition_nm => patchGenerator({ transition_nm })} min={1} max={200} unit="nm" disabled={value.generator.shape === "gaussian" || value.generator.shape === "notch"} /></label>
          <label>低幅值<NumberField value={percent(value.generator.low)} onChange={low => patchGenerator({ low: low / 100 })} min={0} max={value.generator.high * 100 - 0.01} unit="%" step={1} /></label>
          <label>高幅值<NumberField value={percent(value.generator.high)} onChange={high => patchGenerator({ high: high / 100 })} min={value.generator.low * 100 + 0.01} max={100} unit="%" step={1} /></label>
          <label>应用方式<select value={value.generator.operation} onChange={e => patchGenerator({ operation: e.target.value as "replace" | "overlay" })}><option value="replace">替换当前通道</option><option value="overlay">叠加（峰取高值，陷波取低值）</option></select></label>
          <button className="secondary-button" onClick={() => { try { commit(applyGenerator(value)); setSelected(0); } catch (caught) { setError((caught as Error).message); } }}>应用光谱组件</button>
        </div>
        <p className="search-help">应用后可继续拖拽与数值编辑，也可以叠加多个峰或陷波。开启无吸收联动时，另一个通道会同步更新。</p>
      </details>
      <details className="editor-section"><summary>模板、CSV 导入与导出</summary>
        <div className="editor-toolbar"><label>应用快捷模板<select defaultValue="" onChange={e => { if (e.target.value) { commit(editorFromSpectrum(createTarget(e.target.value as TargetTemplate), "快捷模板")); setSelected(0); e.target.value = ""; } }}><option value="">选择后应用…</option><option value="high-reflector">高反波段</option><option value="anti-reflection">宽带增透</option><option value="bandpass">带通滤光</option><option value="edge-filter">长波通边缘</option></select></label>
          <button className="secondary-button" onClick={() => input.current?.click()}>导入目标 CSV</button>
          <input ref={input} hidden type="file" accept=".csv,text/csv" onChange={async e => { const file = e.target.files?.[0]; if (file) { try { importText(await file.text(), file.name); } catch (caught) { setError(String(caught)); } } e.target.value = ""; }} />
          <button className="secondary-button" onClick={() => downloadText("target-spectrum.csv", spectrumToCsv(spectrum), "text/csv")}>导出编辑后的 CSV</button>
          {value.source_spectrum && <button className="small-button" onClick={() => downloadText("original-target.csv", spectrumToCsv(value.source_spectrum!), "text/csv")}>导出原始目标数据</button>}
        </div>
        <label>或粘贴 CSV（wavelength_nm,R,T）<textarea rows={4} value={csv} onChange={e => setCsv(e.target.value)} placeholder={"wavelength_nm,R,T\n400,0.1,0.9\n1100,0.8,0.2"} /></label>
        <button className="small-button" onClick={() => importText(csv, "粘贴 CSV")}>应用粘贴的 CSV</button>
      </details>
      <p className="search-help">{points.length} 个 {value.channel} 控制点 · {value.source_label ?? "自定义目标"}。顶部“保存”会保存两条曲线、控制点、连接方式与组件参数；浏览器草稿也会自动恢复。</p>
    </div>
  </section>;
}
