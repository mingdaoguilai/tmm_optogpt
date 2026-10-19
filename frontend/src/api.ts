import type {
  HealthResponse,
  InverseJob,
  Material,
  SimulationRequest,
  SimulationResult,
  TargetSpectrum,
  DesignRequirements, ManufacturingConstraints, DesignPreview, Layer,
  RefinementSettings,
  Candidate, CandidateReview, CandidateVerification, CandidateVerificationRequest,
} from "./types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    const detail = Array.isArray(body.detail)
      ? body.detail.map((item: { msg: string }) => item.msg).join("; ")
      : body.detail;
    throw new Error(detail ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  reviewCandidate: (candidate:Candidate,target:TargetSpectrum,requirements:DesignRequirements) => request<CandidateReview>('/api/candidates/review', {method:'POST',body:JSON.stringify({candidate,target,requirements})}),
  verifyCandidate: (payload:CandidateVerificationRequest) => request<CandidateVerification>('/api/candidates/verify',{method:'POST',body:JSON.stringify(payload)}),
  designPreview: (payload: {target: TargetSpectrum; requirements: DesignRequirements; constraints: ManufacturingConstraints; reference_layers: Layer[]; max_layers: number}) => request<DesignPreview>("/api/inverse/preview", {method:"POST", body:JSON.stringify(payload)}),
  capabilities: () => request<{materials: Record<string, number[]>}>("/api/inverse/capabilities"),
  health: () => request<HealthResponse>("/api/health"),
  materials: async () => {
    const result = await request<{ materials: Material[] }>("/api/materials");
    return result.materials;
  },
  simulate: (simulation: SimulationRequest) =>
    request<SimulationResult>("/api/simulate", {
      method: "POST",
      body: JSON.stringify(simulation),
    }),
  createInverseJob: (payload: {
    refinement?: RefinementSettings;
    requirements?: DesignRequirements;
    constraints?: ManufacturingConstraints;
    reference_layers?: Layer[];
    target: TargetSpectrum;
    candidate_count: number;
    max_layers: number;
    top_k: number;
    temperatures: number[];
    top_p: number;
    sample_count: number;
    seed_count: number;
    include_greedy: boolean;
    beam_width: number;
    length_penalty: number;
    seed: number;
    reflectance_weight: number;
    transmittance_weight: number;
  }) =>
    request<InverseJob>("/api/inverse/jobs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  inverseJob: (id: string) => request<InverseJob>(`/api/inverse/jobs/${id}`),
  cancelInverseJob: (id: string) =>
    request<InverseJob>(`/api/inverse/jobs/${id}`, { method: "DELETE" }),
};
