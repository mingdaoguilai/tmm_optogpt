export type Polarization = "s" | "p" | "unpolarized";

export interface Layer {
  material: string;
  thickness_nm: number;
  coherent: boolean;
}

export interface SimulationRequest {
  incident_material: string;
  exit_material: string;
  substrate_material: string;
  substrate_thickness_nm: number;
  substrate_coherent: boolean;
  layers: Layer[];
  wavelength_start_nm: number;
  wavelength_end_nm: number;
  wavelength_step_nm: number;
  angle_deg: number;
  polarization: Polarization;
  p_ratio: number;
}

export interface SimulationResult {
  wavelengths_nm: number[];
  reflectance: number[];
  transmittance: number[];
  absorptance: number[];
  max_energy_error: number;
}

export interface TargetSpectrum {
  wavelengths_nm: number[];
  reflectance: number[];
  transmittance: number[];
}

export interface ControlPoint { wavelength_nm: number; value: number }
export interface SpectrumGenerator {
  shape: "gaussian" | "notch" | "bandpass" | "edge";
  center_nm: number;
  width_nm: number;
  transition_nm: number;
  low: number;
  high: number;
  operation: "replace" | "overlay";
}
export interface TargetEditorState {
  schema_version: 1;
  channel: "R" | "T";
  interpolation: "linear" | "pchip";
  linked: boolean;
  points: { R: ControlPoint[]; T: ControlPoint[] };
  generator: SpectrumGenerator;
  source_label?: string;
  source_spectrum?: TargetSpectrum;
}

export interface Material {
  id: string;
  label: string;
  category: string;
  wavelength_min_nm: number;
  wavelength_max_nm: number;
}

export interface Candidate {
  sources?: string[];
  rank: number;
  tokens: string[];
  layers: Layer[];
  mae_r: number;
  mae_t: number;
  max_error: number;
  score: number;
  layer_count: number;
  total_thickness_nm: number;
  simulation: SimulationResult;
}

export interface OptoGPTStatus {
  model_present: boolean;
  loaded: boolean;
  device: string;
  cuda_available: boolean;
  cuda_version: string | null;
  model_path: string;
}

export interface HealthResponse {
  version?: string;
  project_root?: string;
  status: string;
  application: string;
  optogpt: OptoGPTStatus;
}

export interface InverseJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  message: string;
  progress: number;
  error?: { message: string } | null;
  result?: {
    candidates: Candidate[];
    target?: TargetSpectrum;
    search_settings?: Record<string, unknown>;
    search_summary?: {
      sampled_count: number; raw_count: number; unique_count: number;
      duplicate_count: number; verified_count: number; retained_count: number;
      seeds: number[]; temperatures: number[];
    };
  } | null;
}

export type PageId = "forward" | "inverse" | "compare" | "materials";
