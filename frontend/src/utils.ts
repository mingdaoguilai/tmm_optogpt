import type { TargetSpectrum } from "./types";
import { validateSpectrum } from "./targetEditor";

export type TargetTemplate = "high-reflector" | "anti-reflection" | "bandpass" | "edge-filter";

export function createTarget(template: TargetTemplate): TargetSpectrum {
  const wavelengths_nm = Array.from({ length: 71 }, (_, index) => 400 + index * 10);
  const reflectance = wavelengths_nm.map((wavelength) => {
    if (template === "high-reflector") return wavelength >= 500 && wavelength <= 750 ? 0.98 : 0.08;
    if (template === "anti-reflection") return 0.02;
    if (template === "bandpass") return wavelength >= 540 && wavelength <= 680 ? 0.04 : 0.94;
    return wavelength < 650 ? 0.96 : 0.04;
  });
  const transmittance = reflectance.map((value) => 1 - value);
  return { wavelengths_nm, reflectance, transmittance };
}

export function downloadText(filename: string, text: string, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function parseTargetCsv(text: string): TargetSpectrum {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rows[0]?.replace(/^\uFEFF/, "").split(",")[0].trim().toLowerCase().match(/^(wavelength_nm|wavelength|nm)$/)) rows.shift();
  const values = rows.map((row, index) => {
    const cells = row.split(",").slice(0, 3).map(value => value.trim());
    if (cells.length !== 3 || cells.some(value => !value || !Number.isFinite(Number(value)))) throw new Error(`CSV 数据行 ${index + 1} 无效，请提供 wavelength_nm,R,T 三列数值`);
    return cells.map(Number);
  });
  if (values.length < 2) throw new Error("CSV 至少需要两行数值，列顺序为 wavelength_nm,R,T");
  values.sort((left, right) => left[0] - right[0]);
  if (values[0][0] > 400 || values[values.length - 1][0] < 1100) {
    throw new Error("目标光谱必须覆盖 400–1100 nm");
  }
  const reflectance = values.map((row) => row[1]);
  const transmittance = values.map((row) => row[2]);
  if ([...reflectance, ...transmittance].some((value) => value < 0 || value > 1)) {
    throw new Error("R 和 T 必须位于 0–1 之间");
  }
  const target = {
    wavelengths_nm: values.map((row) => row[0]),
    reflectance,
    transmittance,
  };
  validateSpectrum(target, false);
  return target;
}

export function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}
