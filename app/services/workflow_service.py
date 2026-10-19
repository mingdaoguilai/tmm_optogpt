"""Recompute saved structures from actual thicknesses, independent of model loading."""
from __future__ import annotations

import numpy as np

from app.schemas.models import (CandidateVerificationRequest, CandidateVerificationResult,
                                Layer, SimulationRequest, SimulationResult)
from app.services.design_service import score_requirements, validate_design
from app.services.evaluation_service import evaluate_candidate
from app.services.tmm_service import _simulate_polarization


def verify_candidate(request: CandidateVerificationRequest) -> CandidateVerificationResult:
    validate_design(request.target, request.requirements)
    grid = np.asarray(request.evaluation_wavelengths_nm, dtype=float)
    simulation = request.simulation
    if simulation.polarization == 'unpolarized':
        s = _simulate_polarization(simulation, grid, 's')
        p = _simulate_polarization(simulation, grid, 'p')
        physical = {key: (1 - simulation.p_ratio) * s[key] + simulation.p_ratio * p[key] for key in ('R', 'T')}
    else:
        physical = _simulate_polarization(simulation, grid, simulation.polarization)
    actual = np.array([physical['R'], physical['T']])
    if not np.isfinite(actual).all():
        raise ValueError("复算得到非有限光谱")
    result = SimulationResult(wavelengths_nm=grid.tolist(), reflectance=actual[0].tolist(),
        transmittance=actual[1].tolist(), absorptance=(1 - actual.sum(axis=0)).tolist(), max_energy_error=0)
    return CandidateVerificationResult(**request.model_dump(), result=result,
        metrics=score_requirements(request.target, request.requirements, grid, actual))


def review_candidate(request):
    candidate, target, requirements = request.candidate, request.target, request.requirements
    grid = candidate.simulation.wavelengths_nm
    # Reuse the same strict grid validation as forward verification. No token reparsing.
    CandidateVerificationRequest(simulation=SimulationRequest(layers=candidate.layers),
        target=target, requirements=requirements, evaluation_wavelengths_nm=grid)
    validate_design(target, requirements)
    current = evaluate_candidate(candidate.tokens, target, requirements=requirements,
        layers=candidate.layers, grid=grid)
    current.rank, current.sources = candidate.rank, candidate.sources
    initial = None
    report = candidate.refinement
    if report:
        try:
            layers = [Layer.model_validate(layer) for layer in report['initial_layers']]
        except (KeyError, TypeError) as error:
            raise ValueError("精修初始厚度记录不完整，不能复算初值") from error
        if not layers or [l.material for l in layers] != [l.material for l in candidate.layers]:
            raise ValueError("精修前后材料序列不一致")
        initial = evaluate_candidate(candidate.tokens, target, requirements=requirements, layers=layers, grid=grid)
        initial.rank, initial.sources = candidate.rank, candidate.sources
        report = dict(report)
        report.update(initial_layers=[l.model_dump() for l in layers],
            initial_simulation=initial.simulation.model_dump(), initial_band_metrics=initial.band_metrics,
            initial_metrics={name: getattr(initial, name) for name in ('requirement_score', 'weighted_mae',
                'max_deviation', 'max_violation', 'pass_rate', 'mae_r', 'mae_t', 'max_error', 'score')})
        current.refinement = report
    return {"current": current.model_dump(), "initial": initial.model_dump() if initial else None,
            "conditions": SimulationRequest(layers=current.layers, polarization='s', wavelength_step_nm=2).model_dump(),
            "target": target.model_dump(), "requirements": requirements.model_dump()}
