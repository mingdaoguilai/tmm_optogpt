import { useState } from "react";
import { MaterialDetail } from "./MaterialDetail";
import { NumberField } from "./NumberField";
import type { Layer, Material } from "../types";

interface StackEditorProps {
  layers: Layer[];
  materials: Material[];
  onChange: (layers: Layer[]) => void;
}

export function StackEditor({ layers, materials, onChange }: StackEditorProps) {
  const [detail, setDetail] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const selectable = materials.filter((material) => material.id !== "Air" && material.category !== "alternate");
  const update = (index: number, change: Partial<Layer>) => {
    onChange(layers.map((layer, current) => (current === index ? { ...layer, ...change } : layer)));
  };
  const move = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= layers.length) return;
    const next = [...layers];
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
  };

  return (
    <div className="stack-editor">
      <input aria-label="筛选材料" placeholder="搜索材料（保留各层当前材料）" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="table-header">
        <span>层</span><span>材料</span><span>厚度 / nm</span><span>相干</span><span />
      </div>
      {layers.map((layer, index) => (
        <div className="layer-row" key={`${index}-${layer.material}`}>
          <span className="layer-index">{index + 1}</span>
          <select value={layer.material} onChange={(event) => update(index, { material: event.target.value })}>
            {selectable.filter(m => m.id === layer.material || m.id.toLowerCase().includes(search.toLowerCase())).map((material) => <option value={material.id} key={material.id}>{material.label}</option>)}
          </select>
          <NumberField value={layer.thickness_nm} onChange={(value) => update(index, { thickness_nm: value })} min={0.1} step={1} unit="nm" />
          <label className="switch compact-switch">
            <input type="checkbox" checked={layer.coherent} onChange={(event) => update(index, { coherent: event.target.checked })} />
            <span />
          </label>
          <div className="row-actions">
            <button className="icon-button" title="查看材料光学数据" onClick={() => setDetail(layer.material)}>i</button>
            <button className="icon-button" title="复制膜层" onClick={() => onChange([...layers.slice(0,index+1), {...layer}, ...layers.slice(index+1)])}>⧉</button>
            <button className="icon-button" onClick={() => move(index, -1)} disabled={index === 0} title="上移">↑</button>
            <button className="icon-button" onClick={() => move(index, 1)} disabled={index === layers.length - 1} title="下移">↓</button>
            <button className="icon-button danger" onClick={() => onChange(layers.filter((_, current) => current !== index))} title="删除">×</button>
          </div>
        </div>
      ))}
      {detail && <MaterialDetail material={detail} close={() => setDetail(null)} />}
      <button
        className="add-layer"
        onClick={() => onChange([...layers, { material: "SiO2", thickness_nm: 100, coherent: true }])}
      >
        ＋ 添加膜层
      </button>
    </div>
  );
}
