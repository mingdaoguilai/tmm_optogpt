import type { Layer, Material } from "../types";

interface StackEditorProps {
  layers: Layer[];
  materials: Material[];
  onChange: (layers: Layer[]) => void;
}

export function StackEditor({ layers, materials, onChange }: StackEditorProps) {
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
      <div className="table-header">
        <span>层</span><span>材料</span><span>厚度 / nm</span><span>相干</span><span />
      </div>
      {layers.map((layer, index) => (
        <div className="layer-row" key={`${index}-${layer.material}`}>
          <span className="layer-index">{index + 1}</span>
          <select value={layer.material} onChange={(event) => update(index, { material: event.target.value })}>
            {selectable.map((material) => <option value={material.id} key={material.id}>{material.label}</option>)}
          </select>
          <input
            type="number"
            min="0.1"
            step="1"
            value={layer.thickness_nm}
            onChange={(event) => update(index, { thickness_nm: Number(event.target.value) })}
          />
          <label className="switch compact-switch">
            <input type="checkbox" checked={layer.coherent} onChange={(event) => update(index, { coherent: event.target.checked })} />
            <span />
          </label>
          <div className="row-actions">
            <button className="icon-button" onClick={() => move(index, -1)} disabled={index === 0} title="上移">↑</button>
            <button className="icon-button" onClick={() => move(index, 1)} disabled={index === layers.length - 1} title="下移">↓</button>
            <button className="icon-button danger" onClick={() => onChange(layers.filter((_, current) => current !== index))} title="删除">×</button>
          </div>
        </div>
      ))}
      <button
        className="add-layer"
        onClick={() => onChange([...layers, { material: "SiO2", thickness_nm: 100, coherent: true }])}
      >
        ＋ 添加膜层
      </button>
    </div>
  );
}
