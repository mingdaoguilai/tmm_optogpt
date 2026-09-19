import { MaterialDetail } from "../components/MaterialDetail";
import { useState } from "react";
import type { Material } from "../types";

export function MaterialsPage({ materials }: { materials: Material[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const visible = materials.filter((material) => material.id.toLowerCase().includes(query.toLowerCase()));
  return (
    <main className="page-shell">
      <div className="page-title"><div><span className="eyebrow">MATERIAL LIBRARY</span><h1>材料库</h1><p>查看当前 TMM 与 OptoGPT 配套的 n/k 数据范围。</p></div><div className="search-box">⌕<input placeholder="搜索材料" value={query} onChange={(event) => setQuery(event.target.value)} /></div></div>
      <section className="material-grid">{visible.map((material) => <article className="material-card" key={material.id}><button className="small-button material-open" onClick={() => setSelected(material.id)}>查看 n/k 数据</button><div className={`material-icon ${material.category}`}>{material.id.slice(0, 2)}</div><div><h3>{material.label}</h3><span className="category-tag">{material.category}</span></div><dl><div><dt>最小波长</dt><dd>{material.wavelength_min_nm.toFixed(0)} nm</dd></div><div><dt>最大波长</dt><dd>{material.wavelength_max_nm.toFixed(0)} nm</dd></div></dl></article>)}</section>
    {selected && <MaterialDetail material={selected} close={() => setSelected(null)} />}
    </main>
  );
}
