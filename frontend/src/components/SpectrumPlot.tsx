import Plot from "react-plotly.js";
import type { Candidate, SimulationResult, TargetSpectrum } from "../types";

interface SpectrumPlotProps {
  simulation?: SimulationResult | null;
  target?: TargetSpectrum | null;
  candidates?: Candidate[];
  compact?: boolean;
  channel?: "R" | "T";
}

export function SpectrumPlot({ simulation, target, candidates = [], compact = false, channel = "R" }: SpectrumPlotProps) {
  const data: Plotly.Data[] = [];
  if (target) {
    data.push(
      {
        x: target.wavelengths_nm,
        y: target.reflectance,
        name: "目标 R",
        type: "scatter",
        mode: "lines",
        line: { color: "#76a9ff", width: 3, dash: "dot" },
      },
      {
        x: target.wavelengths_nm,
        y: target.transmittance,
        name: "目标 T",
        type: "scatter",
        mode: "lines",
        line: { color: "#7fe4c4", width: 3, dash: "dot" },
      },
    );
  }
  if (simulation) {
    data.push(
      {
        x: simulation.wavelengths_nm,
        y: simulation.reflectance,
        name: "R",
        type: "scatter",
        mode: "lines",
        line: { color: "#76a9ff", width: 2.5 },
      },
      {
        x: simulation.wavelengths_nm,
        y: simulation.transmittance,
        name: "T",
        type: "scatter",
        mode: "lines",
        line: { color: "#77dec0", width: 2.5 },
      },
      {
        x: simulation.wavelengths_nm,
        y: simulation.absorptance,
        name: "A",
        type: "scatter",
        mode: "lines",
        line: { color: "#ff8b91", width: 2 },
      },
    );
  }
  candidates.forEach((candidate, index) => {
    const palette = ["#a78bfa", "#fb7185", "#38bdf8", "#f59e0b"];
    data.push({
      x: candidate.simulation.wavelengths_nm,
      y: channel === "R" ? candidate.simulation.reflectance : candidate.simulation.transmittance,
      name: `#${candidate.rank} ${channel}`,
      type: "scatter",
      mode: "lines",
      line: { color: palette[index % palette.length], width: 1.8 },
    });
  });

  return (
    <Plot
      data={data}
      layout={{
        autosize: true,
        height: compact ? 280 : 460,
        margin: { l: 56, r: 20, t: 18, b: 48 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(7,12,25,.34)",
        font: { color: "#aeb9ce", family: "Inter, Segoe UI, sans-serif" },
        legend: { orientation: "h", x: 0, y: 1.12 },
        xaxis: {
          title: { text: "波长 / nm" },
          gridcolor: "rgba(148,163,184,.12)",
          zeroline: false,
        },
        yaxis: {
          title: { text: "光学响应" },
          range: [-0.03, 1.03],
          tickformat: ".0%",
          gridcolor: "rgba(148,163,184,.12)",
          zeroline: false,
        },
        hovermode: "x unified",
      }}
      config={{ responsive: true, displaylogo: false, scrollZoom: true, modeBarButtonsToRemove: ['sendChartToCloud'] }}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  );
}
