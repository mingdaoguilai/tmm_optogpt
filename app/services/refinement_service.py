"""Bounded, cancellable continuous-thickness post-processing; no model retraining."""
from __future__ import annotations

import time
import numpy as np
from scipy.optimize import least_squares

from app.schemas.models import SimulationRequest
from app.services.design_service import objective_arrays, residual_arrays
from app.services.evaluation_service import evaluate_candidate
from app.services.material_service import material_service
from app.services.tmm_service import _simulate_polarization


def ranking(candidate):
    return candidate.requirement_score, candidate.weighted_mae, candidate.score


def refinement_grid(target, requirements, step):
    # Raw knots and exact band boundaries retain off-grid/narrow features.
    raw = np.asarray(target.wavelengths_nm)
    return np.unique(np.concatenate((np.arange(400., 1100.1, step),
        raw[(raw >= 400) & (raw <= 1100)],
        [x for b in requirements.bands for x in (b.start_nm, b.end_nm)])))


def select_diverse(candidates, count):
    selected, seen = [], set()
    for candidate in sorted(candidates, key=ranking):
        sequence = tuple(layer.material for layer in candidate.layers)
        if sequence not in seen:
            selected.append(candidate)
            seen.add(sequence)
        if len(selected) == count:
            break
    return selected


def thickness_bounds(layers, constraints):
    low, high = [], []
    if any(rule.index > len(layers) for rule in constraints.layers):
        raise ValueError("候选缺少受约束层")
    for index, layer in enumerate(layers, 1):
        rule = next((r for r in constraints.layers if r.index == index), None)
        lo = max(constraints.min_thickness_nm, (rule.min_nm if rule else None) or constraints.min_thickness_nm)
        hi = min(constraints.max_thickness_nm, (rule.max_nm if rule else None) or constraints.max_thickness_nm)
        if rule and rule.material is not None and layer.material != rule.material:
            raise ValueError("候选材料与锁定材料不符")
        if rule and rule.thickness_nm is not None:
            lo = hi = rule.thickness_nm
        if not lo <= layer.thickness_nm <= hi:
            raise ValueError("候选初始厚度不在工艺边界内")
        low.append(lo)
        high.append(hi)
    return np.asarray(low), np.asarray(high)


class CachedStack:
    def __init__(self, layers, grid):
        self.layers, self.grid = layers, grid
        self.request = SimulationRequest(layers=layers, polarization="s")
        self.nk = {name: material_service.refractive_index(name, grid)
                   for name in {"Air", "Glass_Substrate", *(layer.material for layer in layers)}}

    def simulate(self, thicknesses):
        request = self.request.model_copy(update={"layers": [
            layer.model_copy(update={"thickness_nm": float(d)})
            for layer, d in zip(self.layers, thicknesses)]})
        result = _simulate_polarization(request, self.grid, "s", nk_cache=self.nk)
        actual = np.array([result["R"], result["T"]], dtype=np.float64)
        if not np.isfinite(actual).all():
            raise ValueError("TMM 返回非有限光谱")
        return result


class StopRefinement(Exception):
    pass


def refine_one(candidate, target, requirements, constraints, settings, seed,
               deadline, cancelled, progress):
    """Input candidate has already been evaluated on the shared dense grid."""
    started = time.monotonic()
    initial = candidate.model_copy(deep=True)
    best = candidate.model_copy(deep=True)
    report = {"accepted": False, "status": "unchanged", "message": "未找到更优连续厚度",
              "evaluations": 0, "starts_completed": 0, "elapsed_s": 0.,
              "optimization_step_nm": settings.optimization_step_nm,
              "verification_step_nm": settings.verification_step_nm,
              "initial_layers": [layer.model_dump() for layer in initial.layers],
              "initial_simulation": initial.simulation.model_dump(),
              "initial_metrics": {name: getattr(initial, name) for name in
                  ("requirement_score", "weighted_mae", "max_violation", "max_deviation", "pass_rate", "mae_r", "mae_t", "max_error", "score")},
              "initial_band_metrics": initial.band_metrics,
              "solver_messages": [], "solver_runs": []}
    low, high = thickness_bounds(initial.layers, constraints)
    free = high > low
    if not free.any():
        report.update(status="locked", message="所有厚度已锁定，无可优化变量")
        best.refinement = report
        return best
    grid = refinement_grid(target, requirements, settings.optimization_step_nm)
    coarse = CachedStack(initial.layers, grid)
    fine = CachedStack(initial.layers, np.asarray(initial.simulation.wavelengths_nm))
    objective = objective_arrays(target, requirements, grid)
    weights = objective['weights']
    x0 = np.array([layer.thickness_nm for layer in initial.layers], dtype=float)
    rng = np.random.default_rng(seed)
    stop_reason = None

    def checkpoint():
        if cancelled():
            raise StopRefinement("cancelled")
        if time.monotonic() >= deadline:
            raise StopRefinement("time_limit")

    for start in range(settings.starts):
        trial_best = None
        trial_key = (float('inf'), float('inf'))
        # max_nfev alone does NOT count SciPy's finite-difference Jacobian calls.
        # Explicitly count every physical objective evaluation across all starts.
        limit = min(settings.max_evaluations,
                    (start + 1) * settings.max_evaluations // settings.starts)

        def residual(x):
            nonlocal trial_best, trial_key
            checkpoint()
            if report['evaluations'] >= limit:
                raise StopRefinement("evaluation_limit")
            thickness = x0.copy()
            thickness[free] = x
            physical = coarse.simulate(thickness)
            report['evaluations'] += 1
            error, violation = residual_arrays([physical['R'], physical['T']], objective)
            key = (float((violation * weights).sum() / weights.sum()),
                   float((error * weights).sum() / weights.sum()))
            if key < trial_key:
                trial_key, trial_best = key, thickness.copy()
            progress(report['evaluations'] / settings.max_evaluations,
                     f"起点 {start + 1}/{settings.starts} · TMM求值 {report['evaluations']}/{settings.max_evaluations}")
            delta = np.array([physical['R'], physical['T']]) - objective['values']
            signed = np.where(objective['kinds'] == 0, np.sign(delta), 1.)
            return (signed * violation * np.sqrt(weights)).ravel()

        try:
            checkpoint()
            guess = x0[free].copy() if start == 0 else np.clip(
                np.array([layer.thickness_nm for layer in best.layers])[free]
                + rng.normal(size=free.sum()) * settings.perturbation * (high - low)[free],
                low[free], high[free])
            result = least_squares(residual, guess, bounds=(low[free], high[free]),
                                   loss=settings.loss, f_scale=0.02, x_scale="jac",
                                   max_nfev=limit - report['evaluations'],
                                   ftol=1e-8, xtol=1e-8, gtol=1e-8)
            report['solver_messages'].append(str(result.message))
            report['solver_runs'].append({"success": bool(result.success), "status": int(result.status),
                "nfev": int(result.nfev), "message": str(result.message)})
        except StopRefinement as stopped:
            stop_reason = str(stopped)
            report['solver_messages'].append(stop_reason)
            report['solver_runs'].append({"success": False, "message": stop_reason})
        except (ValueError, FloatingPointError) as error:
            report['status'] = 'solver_error'
            report['message'] = str(error)
            report['solver_messages'].append(str(error))
            report['solver_runs'].append({"success": False, "message": str(error)})
        # Keep a valid partial improvement even when cancelled or out of budget.
        if trial_best is not None:
            physical = fine.simulate(trial_best)
            proposal = evaluate_candidate(initial.tokens, target, requirements=requirements,
                layers=[layer.model_copy(update={"thickness_nm": float(d)})
                        for layer, d in zip(initial.layers, trial_best)], grid=fine.grid, physical=physical)
            proposal.sources = initial.sources
            if ranking(proposal) < ranking(best):
                best = proposal
        report['starts_completed'] += 1
        if stop_reason in ('cancelled', 'time_limit'):
            break
        stop_reason = None
    report['accepted'] = ranking(best) < ranking(initial)
    if stop_reason:
        report.update(status=stop_reason, message={"cancelled": "已取消，保留已验证的最佳厚度",
                      "time_limit": "达到优化总时限，保留已验证的最佳厚度"}[stop_reason])
    elif report['status'] != 'solver_error':
        report.update(status='improved' if report['accepted'] else 'unchanged',
                      message='已通过加密网格复核，采用改善后的连续厚度' if report['accepted'] else '加密网格未改善，保留初始厚度')
    report['elapsed_s'] = time.monotonic() - started
    best.refinement = report
    return best


def refine_candidates(candidates, target, requirements, constraints, settings, seed,
                      retain_count, cancelled=lambda: False, progress=lambda *_: None,
                      publish=lambda *_: None):
    selected = select_diverse(candidates, settings.candidate_count)
    selected_tokens = {tuple(c.tokens) for c in selected}
    # Retained leaders plus diverse seeds; all finalists share ONE dense scoring grid.
    pool = list(candidates[:retain_count])
    pool.extend(c for c in selected if c not in pool)
    grid = refinement_grid(target, requirements, settings.verification_step_nm)
    dense = []
    for index, candidate in enumerate(pool):
        if cancelled():
            return candidates[:retain_count]
        progress(index / max(len(pool), 1) * .2, f"加密网格基线 {index + 1}/{len(pool)}")
        stack = CachedStack(candidate.layers, grid)
        result = evaluate_candidate(candidate.tokens, target, requirements=requirements,
            layers=candidate.layers, grid=grid,
            physical=stack.simulate([layer.thickness_nm for layer in candidate.layers]))
        result.sources = candidate.sources
        dense.append(result)
    publish(sorted(dense, key=ranking)[:retain_count])
    deadline = time.monotonic() + settings.time_budget_s
    total = len(selected_tokens)
    done = 0
    for index, candidate in enumerate(dense):
        if tuple(candidate.tokens) not in selected_tokens:
            continue
        if cancelled():
            break
        dense[index] = refine_one(candidate, target, requirements, constraints, settings,
            (seed + done) % 2**32, deadline, cancelled,
            lambda fraction, message: progress(.2 + .8 * (done + fraction) / total,
                f"厚度精修 {done + 1}/{total} · {message}"))
        done += 1
        publish(sorted(dense, key=ranking)[:retain_count])
    return sorted(dense, key=ranking)[:retain_count]
