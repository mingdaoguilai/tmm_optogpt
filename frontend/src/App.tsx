import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ComparePage } from "./pages/ComparePage";
import { ForwardPage } from "./pages/ForwardPage";
import { InversePage } from "./pages/InversePage";
import { MaterialsPage } from "./pages/MaterialsPage";
import type { Candidate, HealthResponse, Material, PageId, SimulationRequest, TargetSpectrum } from "./types";
import { createTarget, downloadText } from "./utils";

const initialSimulation: SimulationRequest = {
  incident_material: "Air",
  exit_material: "Air",
  substrate_material: "Glass_Substrate",
  substrate_thickness_nm: 500000,
  substrate_coherent: false,
  layers: [
    { material: "SiO2", thickness_nm: 105, coherent: true },
    { material: "TiO2", thickness_nm: 70, coherent: true },
    { material: "SiO2", thickness_nm: 105, coherent: true },
  ],
  wavelength_start_nm: 400,
  wavelength_end_nm: 1100,
  wavelength_step_nm: 5,
  angle_deg: 0,
  polarization: "unpolarized",
  p_ratio: 0.5,
};

export default function App() {
  const [page, setPage] = useState<PageId>("forward");
  const [projectName, setProjectName] = useState("新建薄膜项目");
  const [simulation, setSimulation] = useState(initialSimulation);
  const [target, setTarget] = useState<TargetSpectrum>(createTarget("bandpass"));
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const projectInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([api.health(), api.materials()])
      .then(([status, materialList]) => { setHealth(status); setMaterials(materialList); })
      .catch((error) => setAppError(error instanceof Error ? error.message : String(error)));
  }, []);

  const useCandidate = (candidate: Candidate) => {
    setSimulation((current) => ({ ...current, layers: candidate.layers }));
    setPage("forward");
  };
  const saveProject = () => downloadText("thin-film-project.json", JSON.stringify({ schema_version: 1, name: projectName, simulation, target, candidates }, null, 2));
  const loadProject = async (file: File) => {
    try {
      const project = JSON.parse(await file.text());
      if (!project.simulation) throw new Error("项目文件缺少 simulation 字段");
      setProjectName(project.name ?? "导入项目");
      setSimulation(project.simulation);
      if (project.target) setTarget(project.target);
      setCandidates(project.candidates ?? []);
      setAppError(null);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  };

  const nav = [
    { id: "forward" as const, icon: "⌁", label: "正向仿真", caption: "TMM" },
    { id: "inverse" as const, icon: "✦", label: "逆向设计", caption: "OptoGPT" },
    { id: "compare" as const, icon: "◫", label: "候选比较", caption: String(candidates.length) },
    { id: "materials" as const, icon: "◈", label: "材料库", caption: String(materials.length) },
  ];

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>OptiForge</strong><small>TMM + OptoGPT</small></div></div>
        <nav>{nav.map((item) => <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => setPage(item.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}<small>{item.caption}</small></span></button>)}</nav>
        <div className="sidebar-note"><span className={health?.optogpt.model_present ? "online-dot" : "offline-dot"} /><div><strong>{health?.optogpt.model_present ? "计算核心就绪" : "模型未找到"}</strong><small>{health?.optogpt.device ?? "正在连接后端"}</small></div></div>
      </aside>
      <div className="main-column">
        <header className="topbar"><div className="project-name"><span>项目</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></div><div className="topbar-actions"><button onClick={() => projectInput.current?.click()}>打开</button><input ref={projectInput} hidden type="file" accept=".json,application/json" onChange={(event) => event.target.files?.[0] && loadProject(event.target.files[0])} /><button onClick={saveProject}>保存</button><div className="divider" /><span className="engine-status"><i className={health ? "ready" : ""} />{health?.optogpt.cuda_available ? `CUDA ${health.optogpt.cuda_version}` : "CPU"}</span></div></header>
        {appError && <div className="global-error" onClick={() => setAppError(null)}>{appError}<span>×</span></div>}
        {page === "forward" && <ForwardPage request={simulation} materials={materials} onRequestChange={setSimulation} />}
        {page === "inverse" && <InversePage target={target} onTargetChange={setTarget} onCandidatesChange={setCandidates} onUseCandidate={useCandidate} />}
        {page === "compare" && <ComparePage candidates={candidates} target={target} onUseCandidate={useCandidate} />}
        {page === "materials" && <MaterialsPage materials={materials} />}
      </div>
    </div>
  );
}
