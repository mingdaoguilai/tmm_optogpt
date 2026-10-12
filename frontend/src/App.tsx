import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ComparePage } from "./pages/ComparePage";
import { ForwardPage } from "./pages/ForwardPage";
import { InversePage } from "./pages/InversePage";
import { MaterialsPage } from "./pages/MaterialsPage";
import type { Candidate, CandidateDesignSnapshot, DesignRequirements, ManufacturingConstraints, HealthResponse, Material, PageId, SimulationRequest, TargetEditorState, TargetSpectrum } from "./types";
import { createTarget, downloadText } from "./utils";
import { editorFromSpectrum, editorToSpectrum, validateEditor } from "./targetEditor";
import { defaultConstraints, defaultRequirements, validateSettings } from "./designRequirements";

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

const draftKey = "optiforge-draft-v2";
export default function App() {
  const [restored, setRestored] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [candidateTarget, setCandidateTarget] = useState<TargetSpectrum | null>(null);
  const [requirements, setRequirements] = useState<DesignRequirements>(()=>structuredClone(defaultRequirements));
  const [constraints, setConstraints] = useState<ManufacturingConstraints>(()=>structuredClone(defaultConstraints));
  const [candidateRequirements, setCandidateRequirements] = useState<DesignRequirements | null>(null);
  const [candidateDesign, setCandidateDesign] = useState<CandidateDesignSnapshot | null>(null);
  const [history, setHistory] = useState<SimulationRequest[]>([]);
  const [notice, setNotice] = useState("");
  const [projectRevision, setProjectRevision] = useState(0);

  const [page, setPage] = useState<PageId>("forward");
  const [projectName, setProjectName] = useState("新建薄膜项目");
  const [simulation, setSimulation] = useState(initialSimulation);
  const [target, setTarget] = useState<TargetSpectrum>(createTarget("bandpass"));
  const [targetEditor, setTargetEditor] = useState<TargetEditorState>(() => editorFromSpectrum(createTarget("bandpass"), "带通模板"));
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

  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.simulation?.layers && saved.target?.wavelengths_nm) {
          const editor = saved.target_editor ?? editorFromSpectrum(saved.target);
          validateEditor(editor);
          const r = saved.design_requirements ?? structuredClone(defaultRequirements);
          const c = saved.manufacturing_constraints ?? structuredClone(defaultConstraints);
          validateSettings(r,c); setRequirements(r); setConstraints(c);
          setCandidateRequirements(saved.candidate_requirements ?? null); setCandidateDesign(saved.candidate_design_snapshot ?? null);
          setTargetEditor(editor); setTarget(editorToSpectrum(editor));
          setSimulation(saved.simulation); setCandidates(saved.candidates ?? []);
          setCandidateTarget(saved.candidate_target ?? saved.target); setProjectName(saved.name ?? "恢复项目");
          setNotice("已恢复本机草稿"); setDirty(true);
        }
      }
    } catch { setNotice("草稿无法恢复，请打开已保存项目"); }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ name: projectName, simulation, target, target_editor: targetEditor, design_requirements:requirements, manufacturing_constraints:constraints, candidate_requirements:candidateRequirements, candidate_design_snapshot:candidateDesign, candidates, candidate_target: candidateTarget })); }
    catch { setNotice("草稿存储空间不足，请手动保存项目"); }
  }, [restored, projectName, simulation, target, targetEditor, requirements, constraints, candidateRequirements, candidateDesign, candidates, candidateTarget]);
  const editTarget = (editor: TargetEditorState) => {
    setTargetEditor(editor); setTarget(editorToSpectrum(editor)); setDirty(true);
  };
  const editSimulation = (next: SimulationRequest) => {
    setHistory(previous => [...previous.slice(-49), simulation]); setSimulation(next); setDirty(true);
  };
  const useCandidate = (candidate: Candidate) => {
    editSimulation({ ...initialSimulation, layers: candidate.layers, wavelength_step_nm: 10, polarization: "s" });
    setNotice("已采用候选验证条件：法向入射、500000 nm 非相干玻璃基底、空气出射");
    setPage("forward");
  };
  const saveProject = () => { downloadText("thin-film-project.json", JSON.stringify({ schema_version: 3, name: projectName, simulation, target, target_editor: targetEditor, design_requirements:requirements, manufacturing_constraints:constraints, candidate_requirements:candidateRequirements, candidate_design_snapshot:candidateDesign, candidates, candidate_target: candidateTarget }, null, 2)); setDirty(false); };
  const loadProject = async (file: File) => {
    try {
      const input = JSON.parse(await file.text());
      const checked = await fetch("/api/projects/validate", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(input) });
      if (!checked.ok) throw new Error("项目格式或参数无效，未替换当前项目");
      const project = (await checked.json()).project;
      if (!project.simulation) throw new Error("项目文件缺少 simulation 字段");
      const editor = project.target_editor ?? editorFromSpectrum(project.target ?? createTarget("bandpass"));
      validateEditor(editor);
      validateSettings(project.design_requirements, project.manufacturing_constraints);
      sessionStorage.removeItem('optiforge-inverse');
      setProjectRevision(value => value + 1);
      setProjectName(project.name ?? "导入项目");
      setSimulation(project.simulation);
      setTargetEditor(editor); setTarget(editorToSpectrum(editor));
      setRequirements(project.design_requirements); setConstraints(project.manufacturing_constraints); setCandidateRequirements(project.candidate_requirements ?? null); setCandidateDesign(project.candidate_design_snapshot ?? null);
      setCandidates(project.candidates ?? []);
      setCandidateTarget(project.candidate_target ?? project.target ?? null); setHistory([]); setDirty(false);
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
        <div className="brand" title={health?.project_root}><div className="brand-mark"><span /><span /><span /></div><div><strong>OptiForge · V4</strong><small>TMM + OptoGPT · {health?.version ?? "连接中"}</small></div></div>
        <nav>{nav.map((item) => <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => setPage(item.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}<small>{item.caption}</small></span></button>)}</nav>
        <div className="sidebar-note"><span className={health?.optogpt.model_present ? "online-dot" : "offline-dot"} /><div><strong>{health?.optogpt.model_present ? "计算核心就绪" : "模型未找到"}</strong><small>{health?.optogpt.device ?? "正在连接后端"}</small></div></div>
      </aside>
      <div className="main-column">
        <header className="topbar"><div className="project-name"><span>项目</span><input value={projectName} onChange={(event) => { setProjectName(event.target.value); setDirty(true); }} /></div><div className="topbar-actions"><button onClick={() => projectInput.current?.click()}>打开</button><input ref={projectInput} hidden type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadProject(file); event.target.value = ""; }} /><button onClick={saveProject}>{dirty ? "保存 · 有修改" : "保存"}</button><button disabled={!history.length} onClick={() => { setSimulation(history[history.length-1]); setHistory(history.slice(0,-1)); setDirty(true); }}>撤销</button><div className="divider" /><span className="engine-status"><i className={health ? "ready" : ""} />{health?.optogpt.cuda_available ? `CUDA ${health.optogpt.cuda_version}` : "CPU"}</span></div></header>
        {notice && <div className="notice-bar" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
        {appError && <div className="global-error" onClick={() => setAppError(null)}>{appError}<span>×</span></div>}
        <div hidden={page !== "forward"}><ForwardPage request={simulation} materials={materials} onRequestChange={editSimulation} /></div>
        <div hidden={page !== "inverse"}><InversePage key={projectRevision} target={target} editor={targetEditor} onEditorChange={editTarget} requirements={requirements} onRequirementsChange={value=>{setRequirements(value);setDirty(true);}} constraints={constraints} onConstraintsChange={value=>{setConstraints(value);setDirty(true);}} referenceLayers={simulation.layers} materials={materials} onCandidatesChange={(values, snapshot, rules, design) => { setCandidates(values); setCandidateTarget(snapshot); setCandidateRequirements(rules ?? null); setCandidateDesign(design ?? null); setDirty(true); }} onUseCandidate={useCandidate} /></div>
        <div hidden={page !== "compare"}><ComparePage candidates={candidates} target={candidateTarget ?? target} requirements={candidateRequirements} onUseCandidate={useCandidate} /></div>
        {page === "materials" && <MaterialsPage materials={materials} />}
      </div>
    </div>
  );
}
