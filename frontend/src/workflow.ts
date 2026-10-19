import type {AdoptedCandidate, Candidate, CandidateDesignSnapshot, CandidateVerificationRequest,
  DesignRequirements, InverseJob, SimulationRequest, SimulationResult, TargetSpectrum} from './types';

// Deterministic equality independent of JSON field order, without rounding thickness.
export function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${fingerprint(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function initialCandidate(candidate:Candidate):Candidate | null {
  const r=candidate.refinement;
  if (!r) return null;
  const metrics=r.initial_metrics;
  return {...structuredClone(candidate), layers:structuredClone(r.initial_layers),
    simulation:structuredClone(r.initial_simulation), refinement:null,
    total_thickness_nm:r.initial_layers.reduce((sum,l)=>sum+l.thickness_nm,0), layer_count:r.initial_layers.length,
    mae_r:metrics.mae_r ?? candidate.mae_r, mae_t:metrics.mae_t ?? candidate.mae_t,
    max_error:metrics.max_error ?? candidate.max_error, score:metrics.score ?? candidate.score,
    requirement_score:metrics.requirement_score, weighted_mae:metrics.weighted_mae,
    pass_rate:metrics.pass_rate, max_deviation:metrics.max_deviation, max_violation:metrics.max_violation,
    band_metrics:r.initial_band_metrics ?? []};
}

export function adoptCandidate(candidate:Candidate, variant:'initial'|'current', target:TargetSpectrum,
  requirements:DesignRequirements):AdoptedCandidate {
  const selected=variant==='initial'?initialCandidate(candidate):structuredClone(candidate);
  if (!selected) throw new Error('此候选没有精修初值记录');
  return {variant, candidate:selected, target:structuredClone(target), requirements:structuredClone(requirements),
    conditions:{incident_material:'Air',exit_material:'Air',substrate_material:'Glass_Substrate',
      substrate_thickness_nm:500000,substrate_coherent:false,layers:structuredClone(selected.layers),
      wavelength_start_nm:400,wavelength_end_nm:1100,wavelength_step_nm:2,angle_deg:0,polarization:'s',p_ratio:0.5}};
}

export function verificationRequest(adoption:AdoptedCandidate, simulation:SimulationRequest):CandidateVerificationRequest {
  return {simulation:structuredClone(simulation),target:adoption.target,requirements:adoption.requirements,
    evaluation_wavelengths_nm:adoption.candidate.simulation.wavelengths_nm};
}
export function structureCsv(candidate:Candidate):string {
  const quote=(s:string)=>`"${s.replace(/"/g,'""')}"`;
  return ['layer,material,thickness_nm,coherent',...candidate.layers.map((l,i)=>
    [i+1,quote(l.material),l.thickness_nm,l.coherent].join(','))].join('\n');
}
export function spectrumCsv(simulation:SimulationResult):string {
  return ['wavelength_nm,R,T,A',...simulation.wavelengths_nm.map((w,i)=>
    [w,simulation.reflectance[i],simulation.transmittance[i],simulation.absorptance[i]].join(','))].join('\n');
}
export function designSnapshot(job:InverseJob):CandidateDesignSnapshot | undefined {
  const r=job.result;
  if (!r?.model_target || !r.requirements || !r.constraints) return undefined;
  return {model_target:r.model_target,requirements:r.requirements,constraints:r.constraints,
    refinement:r.refinement,reference_layers:r.reference_layers ?? [],search_settings:r.search_settings,
    search_summary:r.search_summary,job_id:job.id,job_status:job.status};
}

export function replaceReviewedCandidate(candidates:Candidate[],source:Candidate,updated:Candidate):Candidate[] {
  return candidates.map(candidate=>candidate.rank===source.rank&&fingerprint(candidate)===fingerprint(source)
    ?structuredClone(updated):candidate);
}
