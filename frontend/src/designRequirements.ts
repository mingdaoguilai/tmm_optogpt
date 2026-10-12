import type { DesignRequirements, ManufacturingConstraints } from "./types";

export const defaultRequirements: DesignRequirements = {
  schema_version: 1, enabled_r: true, enabled_t: true, weight_r: 1, weight_t: 1,
  tolerance: 0, scope: "full", completion: "no_absorption", bands: [],
};
export const defaultConstraints: ManufacturingConstraints = { min_thickness_nm: 10, max_thickness_nm: 500, layers: [] };

// Draft restore uses the same structural checks as project inputs; feasibility
// and vocabulary intersection are decided by the backend preview/search.
export function validateSettings(r: DesignRequirements, c: ManufacturingConstraints) {
  const finite = (x: number, lo: number, hi: number) => Number.isFinite(x) && x >= lo && x <= hi;
  if (!r || r.schema_version !== 1 || typeof r.enabled_r !== "boolean" || typeof r.enabled_t !== "boolean"
      || !finite(r.weight_r, 0, 1000) || !finite(r.weight_t, 0, 1000) || !finite(r.tolerance, 0, 1)
      || !["full", "bands"].includes(r.scope) || !["no_absorption", "reference"].includes(r.completion)
      || !Array.isArray(r.bands) || r.bands.length > 20) throw new Error("设计要求格式无效");
  r.bands.forEach(b => {
    if (!["R", "T"].includes(b.channel) || !["match", "minimum", "maximum", "ignore"].includes(b.kind)
        || !finite(b.start_nm, 400, 1100) || !finite(b.end_nm, 400, 1100) || b.end_nm <= b.start_nm
        || !finite(b.value, 0, 1) || !finite(b.weight, 0, 1000) || !finite(b.tolerance, 0, 1)) throw new Error("波段范围或数值无效");
  });
  r.bands.forEach((b,i) => r.bands.slice(i+1).forEach(other => {
    if (b.channel===other.channel && b.kind!=="ignore" && other.kind!=="ignore" && Math.max(b.start_nm,other.start_nm)<Math.min(b.end_nm,other.end_nm)) throw new Error("同通道考核波段不能重叠");
  }));
  if (!c || !finite(c.min_thickness_nm, Number.MIN_VALUE, 1000000)
      || !finite(c.max_thickness_nm, c.min_thickness_nm, 1000000) || !Array.isArray(c.layers)
      || c.layers.length > 20 || new Set(c.layers.map(l => l.index)).size !== c.layers.length) throw new Error("工艺范围或层编号无效");
  c.layers.forEach(l => {
    if (!Number.isInteger(l.index) || !finite(l.index, 1, 20)
        || (l.material != null && (typeof l.material !== "string" || !l.material.trim()))
        || [l.thickness_nm, l.min_nm, l.max_nm].some(v => v != null && !finite(v, Number.MIN_VALUE, 1000000))) throw new Error("逐层约束格式无效");
    const low=Math.max(c.min_thickness_nm,l.min_nm ?? c.min_thickness_nm), high=Math.min(c.max_thickness_nm,l.max_nm ?? c.max_thickness_nm);
    if (low>high || (l.thickness_nm!=null && (l.thickness_nm<low || l.thickness_nm>high))) throw new Error(`第${l.index}层与全局厚度范围冲突`);
  });
}
