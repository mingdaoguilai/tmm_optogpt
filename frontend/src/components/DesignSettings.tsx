import { useState } from "react";
import { NumberField } from "./NumberField";
import { api } from "../api";
import type { DesignPreview, DesignRequirements, Layer, ManufacturingConstraints, Material, SpectralBand } from "../types";

type Props = {
  requirements: DesignRequirements; onRequirementsChange: (r: DesignRequirements) => void;
  constraints: ManufacturingConstraints; onConstraintsChange: (c: ManufacturingConstraints) => void;
  referenceLayers: Layer[]; materials: Material[];
  preview?: DesignPreview; pending: boolean; error?: string;
};
const pct = (v: number) => Number((v * 100).toFixed(4));

export function DesignSettings({requirements: r, onRequirementsChange: setR, constraints: c, onConstraintsChange: setC, referenceLayers, materials, preview, pending, error}: Props) {
  const [vocabulary, setVocabulary] = useState<Record<string, number[]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [vocabularyError, setVocabularyError] = useState("");
  const band = (index: number, patch: Partial<SpectralBand>) => setR({...r, bands:r.bands.map((b,i) => i === index ? {...b,...patch} : b)});
  const materialNames = vocabulary ? Object.keys(vocabulary).sort() : materials.filter(m => m.category !== "alternate" && m.category !== "substrate" && m.id !== "Air").map(m => m.id);
  return <section className="panel design-settings">
    <div className="panel-heading"><h2>设计要求与工艺边界</h2><span>第四版 · 第二阶段</span></div>
    <div className="spectrum-editor-body">
      <div className="editor-toolbar">
        <label className="editor-check"><input type="checkbox" checked={r.enabled_r} onChange={e => setR({...r,enabled_r:e.target.checked})} />考核 R</label>
        <label className="editor-check"><input type="checkbox" checked={r.enabled_t} onChange={e => setR({...r,enabled_t:e.target.checked})} />考核 T</label>
        <label>考核范围<select value={r.scope} onChange={e => setR({...r,scope:e.target.value as "full"|"bands"})}><option value="full">全波段（允许局部覆盖）</option><option value="bands">仅考核下列波段</option></select></label>
        <label>未指定部分的模型补全<select value={r.completion} onChange={e => setR({...r,completion:e.target.value as "no_absorption"|"reference"})}><option value="no_absorption">明确采用无吸收互补</option><option value="reference">正向页当前膜系作参考</option></select></label>
      </div>
      <div className="form-grid three-columns">
        <label>R 通道权重<NumberField value={r.weight_r} min={0} max={1000} onChange={weight_r => setR({...r,weight_r})} /></label>
        <label>T 通道权重<NumberField value={r.weight_t} min={0} max={1000} onChange={weight_t => setR({...r,weight_t})} /></label>
        <label>全波段曲线容差<NumberField value={pct(r.tolerance)} unit="百分点" min={0} max={100} step={0.5} onChange={v => setR({...r,tolerance:v/100})} /></label>
      </div>
      <p className="search-help">权重为0或未启用的通道不评分；仅波段模式下，其他区间也不评分。补全只是模型的输入提示，绝不作为额外要求。参考膜系有 {referenceLayers.length} 层，按法向、500 μm非相干玻璃条件重新计算。容差以内不计违反要求的误差。</p>
      <div className="band-list">{r.bands.map((b,index) => <div className="band-rule" key={index}>
        <div className="band-title"><strong>波段 {index+1}</strong><button className="small-button" onClick={() => setR({...r,bands:r.bands.filter((_,i) => i !== index)})}>删除波段 {index+1}</button></div>
        <div className="form-grid four-columns">
          <label>通道<select value={b.channel} onChange={e => band(index,{channel:e.target.value as "R"|"T"})}><option>R</option><option>T</option></select></label>
          <label>起点<NumberField value={b.start_nm} min={400} max={1100} unit="nm" onChange={start_nm => band(index,{start_nm})} /></label>
          <label>终点<NumberField value={b.end_nm} min={400} max={1100} unit="nm" onChange={end_nm => band(index,{end_nm})} /></label>
          <label>要求<select value={b.kind} onChange={e => band(index,{kind:e.target.value as SpectralBand["kind"]})}><option value="match">匹配绘制曲线</option><option value="minimum">至少 ≥</option><option value="maximum">至多 ≤</option><option value="ignore">不关心此区间</option></select></label>
          <label>阈值<NumberField value={pct(b.value)} min={0} max={100} unit="%" disabled={b.kind === "match" || b.kind === "ignore"} onChange={v => band(index,{value:v/100})} /></label>
          <label>波段权重<NumberField value={b.weight} min={0} max={1000} disabled={b.kind === "ignore"} onChange={weight => band(index,{weight})} /></label>
          <label>波段容差<NumberField value={pct(b.tolerance)} min={0} max={100} unit="百分点" disabled={b.kind === "ignore"} step={0.5} onChange={v => band(index,{tolerance:v/100})} /></label>
        </div>
      </div>)}</div>
      <button className="secondary-button" disabled={r.bands.length>=20} onClick={() => setR({...r,bands:[...r.bands,{channel:r.enabled_t?"T":"R",start_nm:550,end_nm:650,kind:"match",value:0.9,weight:1,tolerance:0.02}]})}>添加考核 / 忽略波段</button>
      <p className="search-help">同通道考核波段不得重叠；“不关心”区间优先排除。例：选择“仅考核下列波段”，添加 T 的 550–650 nm“至少 ≥ 90%”。</p>
      {pending ? <p className="search-help" role="status">正在核对要求并更新模型补全预览…</p> : error ? <div className="alert error-alert" role="alert">{error}</div> : preview && <div className="requirements-summary" role="status">有效考核：R {preview.active_r_points} 点 / T {preview.active_t_points} 点 · 评分网格 {preview.evaluation_wavelengths_nm.length} 点（10 nm＋精确波段边界）。下方黄色虚线为实际补全后的模型输入。</div>}
      {preview && !preview.constraints_checked && <p className="search-help">模型尚未加载：工艺词表将在生成前核验，也可以先点击下方“读取模型材料 / 厚度词表”。</p>}
      {preview?.warnings?.map((warning,i)=><p className="editor-warning" key={i}>{warning}</p>)}
      <details className="editor-section" open><summary>厚度范围与逐层锁定</summary>
        <div className="form-grid three-columns">
          <label>所有层最小厚度<NumberField value={c.min_thickness_nm} min={1} max={1000000} unit="nm" onChange={min_thickness_nm => setC({...c,min_thickness_nm})} /></label>
          <label>所有层最大厚度<NumberField value={c.max_thickness_nm} min={1} max={1000000} unit="nm" onChange={max_thickness_nm => setC({...c,max_thickness_nm})} /></label>
          <button className="secondary-button" disabled={loading} onClick={async () => {setLoading(true);setVocabularyError("");try {setVocabulary((await api.capabilities()).materials);} catch(e){setVocabularyError(String(e));} finally {setLoading(false);} }}>{loading?"读取中…":"读取模型材料 / 厚度词表"}</button>
        </div>
        {vocabularyError && <div className="alert error-alert">{vocabularyError}</div>}
        {c.layers.map((l,index) => <div className="band-rule" key={index}>
          <div className="band-title"><strong>逐层约束 {index+1}</strong><button className="small-button" onClick={() => setC({...c,layers:c.layers.filter((_,i) => i!==index)})}>删除逐层约束 {index+1}</button></div>
          <div className="form-grid four-columns">
            <label>层编号<NumberField value={l.index} min={1} max={20} integer onChange={value => setC({...c,layers:c.layers.map((rule,i) => i===index?{...rule,index:value}:rule)})} /></label>
            <label>锁定材料<select value={l.material ?? ""} onChange={e => setC({...c,layers:c.layers.map((rule,i) => i===index?{...rule,material:e.target.value||null}:rule)})}><option value="">不限材料</option>{[...new Set([...materialNames,...(l.material?[l.material]:[])])].map(m => <option key={m}>{m}</option>)}</select></label>
            <label>该层最小厚度<NumberField value={l.min_nm ?? c.min_thickness_nm} min={1} max={1000000} unit="nm" onChange={min_nm => setC({...c,layers:c.layers.map((rule,i) => i===index?{...rule,min_nm}:rule)})} /></label>
            <label>该层最大厚度<NumberField value={l.max_nm ?? c.max_thickness_nm} min={1} max={1000000} unit="nm" onChange={max_nm => setC({...c,layers:c.layers.map((rule,i) => i===index?{...rule,max_nm}:rule)})} /></label>
            <label className="editor-check"><input type="checkbox" checked={l.thickness_nm!=null} onChange={e => setC({...c,layers:c.layers.map((rule,i) => i===index?{...rule,thickness_nm:e.target.checked?100:null}:rule)})} />锁定厚度</label>
            {l.thickness_nm!=null && <label>固定厚度<NumberField value={l.thickness_nm} min={1} max={1000000} unit="nm" onChange={thickness_nm => setC({...c,layers:c.layers.map((rule,i) => i===index?{...rule,thickness_nm}:rule)})} /></label>}
          </div>
          {vocabulary && l.material && <p className="search-help">{l.material} 可生成厚度：{vocabulary[l.material]?.join(" / ") || "不在模型词表"} nm</p>}
        </div>)}
        <button className="secondary-button" disabled={c.layers.length>=20} onClick={() => {const index=Array.from({length:20},(_,i)=>i+1).find(i=>!c.layers.some(l=>l.index===i));if(index)setC({...c,layers:[...c.layers,{index,material:"SiO2"}]});}}>添加逐层约束</button>
        <p className="search-help">层编号从入射侧开始。约束层必须存在；全局范围与逐层范围取交集。随机、greedy、beam 都遵守同一边界，锁定厚度必须存在于模型词表，不会自动取整。连续厚度精修在下一阶段接入。</p>
      </details>
    </div>
  </section>;
}
