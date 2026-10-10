import type { ControlPoint, SpectrumGenerator, TargetEditorState, TargetSpectrum } from "./types";

export const defaultGenerator: SpectrumGenerator = {
  shape: "gaussian", center_nm: 650, width_nm: 100, transition_nm: 15,
  low: 0.05, high: 0.9, operation: "replace",
};
export const modelWavelengths = Array.from({ length: 71 }, (_, i) => 400 + 10 * i);
export const editorWavelengths = Array.from({ length: 701 }, (_, i) => 400 + i);

export function validateSpectrum(target: TargetSpectrum, passive = true): void {
  const { wavelengths_nm: x, reflectance: r, transmittance: t } = target;
  if (!Array.isArray(x) || !Array.isArray(r) || !Array.isArray(t)
      || x.length < 2 || x.length !== r.length || x.length !== t.length) throw new Error("光谱需要至少两组完整的波长、R、T 数值");
  if (x.some((v, i) => !Number.isFinite(v) || v <= 0 || (i > 0 && v <= x[i - 1]))) throw new Error("波长必须为正数，按升序排列且不能重复");
  if (x[0] > 400 || x[x.length - 1] < 1100) throw new Error("目标光谱必须覆盖 400–1100 nm");
  if ([...r, ...t].some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error("R 和 T 必须是 0–1 之间的有限数值");
  if (passive && r.some((v, i) => v + t[i] > 1 + 1e-8)) throw new Error("目标存在 R + T > 1 的区间；请修改曲线，或明确开启无吸收联动");
}

// Shape-preserving cubic Hermite interpolation: no ringing/overshoot at peaks.
export function interpolatePoints(points: ControlPoint[], grid: number[], method: "linear" | "pchip"): number[] {
  const h = points.slice(1).map((p, i) => p.wavelength_nm - points[i].wavelength_nm);
  const d = points.slice(1).map((p, i) => (p.value - points[i].value) / h[i]);
  const slopes = Array(points.length).fill(0) as number[];
  const endpoint = (h0: number, h1: number, d0: number, d1: number) => {
    let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(m) !== Math.sign(d0)) m = 0;
    else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > Math.abs(3 * d0)) m = 3 * d0;
    return m;
  };
  if (points.length === 2) slopes.fill(d[0]);
  else {
    slopes[0] = endpoint(h[0], h[1], d[0], d[1]);
    const last = h.length - 1;
    slopes[slopes.length - 1] = endpoint(h[last], h[last - 1], d[last], d[last - 1]);
    for (let i = 1; i < points.length - 1; i++) {
      if (d[i - 1] * d[i] <= 0) continue;
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      slopes[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  let cursor = 0;
  return grid.map(x => {
    while (cursor < points.length - 2 && points[cursor + 1].wavelength_nm < x) cursor++;
    if (x <= points[0].wavelength_nm) return points[0].value;
    if (x >= points[points.length - 1].wavelength_nm) return points[points.length - 1].value;
    const i = cursor, u = (x - points[i].wavelength_nm) / h[i];
    const linear = points[i].value * (1 - u) + points[i + 1].value * u;
    if (method === "linear") return linear;
    const value = (2 * u ** 3 - 3 * u ** 2 + 1) * points[i].value
      + (u ** 3 - 2 * u ** 2 + u) * h[i] * slopes[i]
      + (-2 * u ** 3 + 3 * u ** 2) * points[i + 1].value
      + (u ** 3 - u ** 2) * h[i] * slopes[i + 1];
    return Math.min(1, Math.max(0, value));
  });
}

export function editorToSpectrum(editor: TargetEditorState): TargetSpectrum {
  // Include exact control-point coordinates, including narrow off-grid features.
  const grid = [...new Set([...editorWavelengths, ...editor.points.R.map(p => p.wavelength_nm),
    ...editor.points.T.map(p => p.wavelength_nm)])].sort((a, b) => a - b);
  const active = interpolatePoints(editor.points[editor.channel], grid, editor.interpolation);
  const r = editor.linked && editor.channel === "T" ? active.map(v => 1 - v)
    : interpolatePoints(editor.points.R, grid, editor.interpolation);
  const t = editor.linked && editor.channel === "R" ? active.map(v => 1 - v)
    : interpolatePoints(editor.points.T, grid, editor.interpolation);
  return { wavelengths_nm: grid, reflectance: r, transmittance: t };
}

export function editorFromSpectrum(target: TargetSpectrum, label = "导入目标"): TargetEditorState {
  validateSpectrum(target, false);
  if (target.wavelengths_nm.length > 2000) throw new Error("目标最多支持 2000 个原始数据点，请先适度重采样");
  const grid = [...new Set([400, 1100, ...target.wavelengths_nm.filter(x => x >= 400 && x <= 1100)])].sort((a, b) => a - b);
  const raw = (values: number[]) => target.wavelengths_nm.map((wavelength_nm, i) => ({ wavelength_nm, value: values[i] }));
  const make = (values: number[]) => interpolatePoints(raw(values), grid, "linear").map((value, i) => ({ wavelength_nm: grid[i], value }));
  return {
    schema_version: 1, channel: "R", interpolation: "linear",
    linked: target.reflectance.every((v, i) => Math.abs(v + target.transmittance[i] - 1) < 1e-8),
    points: { R: make(target.reflectance), T: make(target.transmittance) },
    generator: { ...defaultGenerator }, source_label: label, source_spectrum: structuredClone(target),
  };
}

export function validateEditor(editor: TargetEditorState): void {
  if (!editor || editor.schema_version !== 1 || !["R", "T"].includes(editor.channel)
      || !["linear", "pchip"].includes(editor.interpolation) || typeof editor.linked !== "boolean") throw new Error("目标编辑数据格式无效");
  for (const channel of ["R", "T"] as const) {
    const points = editor.points?.[channel];
    if (!Array.isArray(points) || points.length < 2 || points.length > 2000
        || points[0].wavelength_nm !== 400 || points[points.length - 1].wavelength_nm !== 1100
        || points.some((p, i) => !Number.isFinite(p.wavelength_nm) || !Number.isFinite(p.value)
          || p.value < 0 || p.value > 1 || (i > 0 && p.wavelength_nm <= points[i - 1].wavelength_nm))) throw new Error("控制点必须覆盖 400–1100 nm，数值有效且波长不能重复");
  }
  const g = editor.generator;
  if (!g || !["gaussian", "notch", "bandpass", "edge"].includes(g.shape)
      || !["replace", "overlay"].includes(g.operation)
      || !Number.isFinite(g.center_nm) || g.center_nm < 400 || g.center_nm > 1100
      || !Number.isFinite(g.width_nm) || g.width_nm < 1 || g.width_nm > 700
      || !Number.isFinite(g.transition_nm) || g.transition_nm < 1 || g.transition_nm > 200
      || !Number.isFinite(g.low) || !Number.isFinite(g.high) || g.low < 0 || g.high > 1 || g.low >= g.high) throw new Error("光谱组件参数无效，低值必须小于高值");
  if (editor.source_spectrum) validateSpectrum(editor.source_spectrum, false);
}

export function setChannelPoints(editor: TargetEditorState, points: ControlPoint[]): TargetEditorState {
  const other = editor.channel === "R" ? "T" : "R";
  return { ...editor, points: { ...editor.points, [editor.channel]: points,
    ...(editor.linked ? { [other]: points.map(p => ({ ...p, value: 1 - p.value })) } : {}) } };
}

export function applyGenerator(editor: TargetEditorState): TargetEditorState {
  validateEditor(editor);
  const g = editor.generator;
  const grid = [...new Set([400, 1100, g.center_nm,
    ...Array.from({ length: 141 }, (_, i) => 400 + 5 * i),
    ...Array.from({ length: 25 }, (_, i) => g.center_nm + (i - 12) * g.width_nm / 12),
    ...[g.center_nm - g.width_nm / 2, g.center_nm + g.width_nm / 2].flatMap(edge =>
      Array.from({ length: 9 }, (_, i) => edge + (i - 4) * g.transition_nm / 2)),
    ...editor.points[editor.channel].map(p => p.wavelength_nm)]
    .filter(x => x >= 400 && x <= 1100).map(x => Math.round(x * 1e6) / 1e6))].sort((a, b) => a - b);
  if (grid.length > 2000) throw new Error("控制点过多，请移除部分控制点后再叠加组件");
  const existing = interpolatePoints(editor.points[editor.channel], grid, editor.interpolation);
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const points = grid.map((wavelength_nm, i) => {
    const delta = wavelength_nm - g.center_nm;
    let profile: number;
    if (g.shape === "gaussian" || g.shape === "notch") {
      profile = Math.exp(-4 * Math.log(2) * (delta / g.width_nm) ** 2);
      if (g.shape === "notch") profile = 1 - profile;
    } else if (g.shape === "bandpass") {
      const k = 2 * Math.log(9) / g.transition_nm;
      profile = sigmoid(k * (delta + g.width_nm / 2)) * sigmoid(k * (g.width_nm / 2 - delta));
    } else profile = sigmoid(2 * Math.log(9) * delta / g.transition_nm);
    let value = g.low + (g.high - g.low) * profile;
    if (g.operation === "overlay") value = g.shape === "notch" ? Math.min(existing[i], value) : Math.max(existing[i], value);
    return { wavelength_nm, value };
  });
  return setChannelPoints({ ...editor, interpolation: "pchip", source_label: "自定义组件" }, points);
}

export function spectrumToCsv(target: TargetSpectrum): string {
  return "wavelength_nm,R,T\n" + target.wavelengths_nm.map((x, i) => `${x},${target.reflectance[i]},${target.transmittance[i]}`).join("\n");
}
