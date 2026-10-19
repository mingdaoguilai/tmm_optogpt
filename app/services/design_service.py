"""One objective definition for preview, ranking, and future refinement."""
from __future__ import annotations

import numpy as np

from app.schemas.models import DesignRequirements, Layer, SimulationRequest, TargetSpectrum
from app.services.tmm_service import _simulate_polarization, interpolate_spectrum

MODEL_GRID = np.arange(400., 1101., 10.)


def verification_grid(requirements: DesignRequirements) -> np.ndarray:
    # Preserve exact band boundaries even for sub-10 nm specifications.
    return np.unique(np.concatenate([MODEL_GRID, [x for b in requirements.bands for x in (b.start_nm, b.end_nm)]]))


def objective_arrays(target: TargetSpectrum, requirements: DesignRequirements, grid: np.ndarray):
    raw = np.array([interpolate_spectrum(target.wavelengths_nm, values, grid)
                    for values in (target.reflectance, target.transmittance)])
    weights = np.zeros_like(raw)
    tolerance = np.zeros_like(raw)
    kinds = np.zeros_like(raw, dtype=int)  # 0=match, 1=minimum, 2=maximum
    values = raw.copy()
    owners = np.full_like(kinds, -1)
    for c, enabled, channel_weight in [(0, requirements.enabled_r, requirements.weight_r),
                                       (1, requirements.enabled_t, requirements.weight_t)]:
        if not enabled or channel_weight == 0:
            continue
        if requirements.scope == "full":
            weights[c] = channel_weight
            tolerance[c] = requirements.tolerance
        for index, band in enumerate(requirements.bands):
            if band.channel != ("R" if c == 0 else "T") or band.kind == "ignore":
                continue
            mask = (grid >= band.start_nm) & (grid <= band.end_nm)
            weights[c, mask] = channel_weight * band.weight
            tolerance[c, mask] = band.tolerance
            kinds[c, mask] = {"match": 0, "minimum": 1, "maximum": 2}[band.kind]
            values[c, mask] = raw[c, mask] if band.kind == "match" else band.value
            owners[c, mask] = index
        # Ignore intervals always win, regardless of row ordering.
        for band in requirements.bands:
            if band.channel == ("R" if c == 0 else "T") and band.kind == "ignore":
                weights[c, (grid >= band.start_nm) & (grid <= band.end_nm)] = 0
    return {"raw": raw, "values": values, "weights": weights, "tolerance": tolerance, "kinds": kinds, "owners": owners}


def residual_arrays(actual, objective):
    delta = np.asarray(actual) - objective["values"]
    error = np.where(objective["kinds"] == 1, np.maximum(-delta, 0),
                     np.where(objective["kinds"] == 2, np.maximum(delta, 0), np.abs(delta)))
    return error, np.maximum(error - objective["tolerance"], 0)


def complete_model_target(target, requirements, reference_layers=None):
    objective = objective_arrays(target, requirements, MODEL_GRID)
    known = objective["weights"] > 0
    if requirements.completion == "reference":
        reference = _simulate_polarization(SimulationRequest(layers=reference_layers or [], polarization="s"), MODEL_GRID, "s")
        preferred = np.array([reference['R'], reference['T']])
    else:
        # Anchor the helper on the actually specified channel, not a disabled R curve.
        preferred = (np.array([1 - objective['raw'][1], objective['raw'][1]])
                     if not known[0].any() and known[1].any()
                     else np.array([objective['raw'][0], 1 - objective['raw'][0]]))
    preferred[known] = objective['values'][known]
    if requirements.completion == "no_absorption":
        for c in (0, 1):
            mask = known[c] & ~known[1 - c]
            preferred[1 - c, mask] = 1 - preferred[c, mask]
    low = np.where(known, np.maximum(objective['values'] - objective['tolerance'], 0), 0)
    high = np.where(known, np.minimum(objective['values'] + objective['tolerance'], 1), 1)
    low[(objective['kinds'] == 2) | ~known] = 0
    high[(objective['kinds'] == 1) | ~known] = 1
    if np.any(low.sum(axis=0) > 1 + 1e-8):
        raise ValueError("指定 R/T 要求及容差存在物理冲突：最低可接受值之和大于 1")
    preferred = np.clip(preferred, low, high)
    # First reduce helper values, then any slack inside specified tolerance.
    for i in range(preferred.shape[1]):
        excess = max(float(preferred[:, i].sum() - 1), 0)
        for c in sorted((0, 1), key=lambda c: bool(known[c, i])):
            reduction = min(excess, max(float(preferred[c, i] - low[c, i]), 0))
            preferred[c, i] -= reduction
            excess -= reduction
    return TargetSpectrum(wavelengths_nm=MODEL_GRID.tolist(), reflectance=preferred[0].tolist(), transmittance=preferred[1].tolist())


def validate_design(target, requirements):
    # Also validate on raw target knots and band boundaries, not just model bins.
    grid = np.unique(np.concatenate([np.asarray(target.wavelengths_nm), verification_grid(requirements)]))
    grid = grid[(grid >= 400) & (grid <= 1100)]
    objective = objective_arrays(target, requirements, grid)
    if objective['weights'].sum() <= 0:
        raise ValueError("至少需要一个启用且权重大于零的考核通道或波段")
    known = objective['weights'] > 0
    low = np.maximum(objective['values'] - objective['tolerance'], 0)
    low[(objective['kinds'] == 2) | ~known] = 0
    if np.any(low.sum(axis=0) > 1 + 1e-8):
        raise ValueError("指定 R/T 要求及容差存在物理冲突：最低可接受值之和大于 1")


def prepare_design(target, requirements, reference_layers=None):
    validate_design(target, requirements)
    model_target = complete_model_target(target, requirements, reference_layers)
    grid = verification_grid(requirements)
    objective = objective_arrays(target, requirements, grid)
    return {"model_target": model_target.model_dump(), "evaluation_wavelengths_nm": grid.tolist(),
            "active_r_points": int((objective['weights'][0] > 0).sum()),
            "active_t_points": int((objective['weights'][1] > 0).sum()),
            "completion": requirements.completion,
            "warnings": [f"{band.channel} {band.start_nm}–{band.end_nm} nm 没有落在模型10 nm采样点上；评分仍含波段边界，但生成可能难以响应此要求"
                         for band in requirements.bands if band.kind != 'ignore' and band.weight > 0
                         and (requirements.enabled_r if band.channel == 'R' else requirements.enabled_t)
                         and not ((MODEL_GRID >= band.start_nm) & (MODEL_GRID <= band.end_nm)).any()]}


def score_requirements(target, requirements, grid, actual):
    objective = objective_arrays(target, requirements, grid)
    error, violation = residual_arrays(actual, objective)
    weights = objective['weights']
    mask = weights > 0
    total = float(weights.sum())
    if total <= 0:
        raise ValueError("考核网格没有有效要求")
    metrics = []
    for index, band in enumerate(requirements.bands):
        c = 0 if band.channel == 'R' else 1
        selected = (objective['owners'][c] == index) & mask[c]
        if band.kind != 'ignore' and selected.any():
            metrics.append({"channel": band.channel, "start_nm": band.start_nm, "end_nm": band.end_nm,
                            "kind": band.kind, "mae": float(error[c, selected].mean()),
                            "max_deviation": float(error[c, selected].max()),
                            "max_violation": float(violation[c, selected].max()),
                            "pass_rate": float((violation[c, selected] <= 1e-8).mean())})
    return {"requirement_score": float((violation * weights).sum() / total),
            "weighted_mae": float((error * weights).sum() / total),
            "max_violation": float(violation[mask].max()),
            "max_deviation": float(error[mask].max()),
            "pass_rate": float(weights[violation <= 1e-8].sum() / total), "band_metrics": metrics}
