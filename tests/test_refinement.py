from __future__ import annotations

import time
import unittest
from unittest.mock import patch

import numpy as np
from pydantic import ValidationError

from app.schemas.models import (DesignRequirements, InverseJobRequest, Layer,
    ManufacturingConstraints, ProjectDocument, RefinementSettings, SimulationRequest, TargetSpectrum)
from app.services.design_service import objective_arrays, residual_arrays
from app.services.evaluation_service import evaluate_candidate
from app.services.job_service import InverseJobManager
from app.services.material_service import material_service
from app.services.refinement_service import (CachedStack, ranking, refine_candidates,
    refine_one, refinement_grid, select_diverse, thickness_bounds)
from app.services.tmm_service import _simulate_polarization


class RefinementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.requirements = DesignRequirements()
        cls.constraints = ManufacturingConstraints()
        grid = np.arange(400., 1101., 2.)
        physical = _simulate_polarization(SimulationRequest(layers=[
            Layer(material='SiO2', thickness_nm=137.2)], polarization='s'), grid, 's')
        cls.target = TargetSpectrum(wavelengths_nm=grid.tolist(),
            reflectance=physical['R'].tolist(), transmittance=physical['T'].tolist())

    def candidate(self, token='SiO2_100'):
        return evaluate_candidate([token], self.target, requirements=self.requirements,
            grid=refinement_grid(self.target, self.requirements, 2))

    def run_one(self, settings=None, constraints=None, cancelled=lambda: False, progress=lambda *_: None, deadline=None):
        return refine_one(self.candidate(), self.target, self.requirements,
            constraints or self.constraints, settings or RefinementSettings(enabled=True, starts=1, max_evaluations=40),
            42, deadline or time.monotonic()+60, cancelled, progress)

    def test_known_stack_improves_without_recovering_unique_inverse(self):
        initial = self.candidate()
        result = self.run_one()
        self.assertTrue(result.refinement['accepted'])
        self.assertLess(result.requirement_score, initial.requirement_score * .05)
        self.assertEqual(result.tokens, ['SiO2_100'])
        self.assertNotEqual(result.layers[0].thickness_nm, 100)
        self.assertEqual(result.refinement['initial_layers'][0]['thickness_nm'], 100)
        self.assertEqual(result.simulation.wavelengths_nm,
                         result.refinement['initial_simulation']['wavelengths_nm'])
        np.testing.assert_allclose(result.simulation.reflectance,
            CachedStack(result.layers, np.array(result.simulation.wavelengths_nm)).simulate(
                [l.thickness_nm for l in result.layers])['R'])

    def test_material_cache_matches_original_tmm_and_does_not_reload(self):
        for tokens in [['SiO2_100', 'TiO2_80'], ['Ag_40', 'SiO2_100']]:
            candidate = evaluate_candidate(tokens, self.target)
            grid = np.arange(400., 1101., 10.)
            with patch.object(material_service, 'refractive_index', wraps=material_service.refractive_index) as load:
                stack = CachedStack(candidate.layers, grid)
                count = load.call_count
                result = stack.simulate([l.thickness_nm for l in candidate.layers])
                stack.simulate([l.thickness_nm + .1 for l in candidate.layers])
                self.assertEqual(load.call_count, count)
            expected = _simulate_polarization(SimulationRequest(layers=candidate.layers), grid, 's')
            np.testing.assert_allclose(result['R'], expected['R'], atol=1e-12)
            np.testing.assert_allclose(result['T'], expected['T'], atol=1e-12)

    def test_diverse_selection_uses_material_sequence_not_tokens(self):
        candidates = [self.candidate(t) for t in ['SiO2_100', 'SiO2_110', 'TiO2_100']]
        selected = select_diverse(candidates, 5)
        self.assertEqual(len(selected), 2)
        self.assertEqual(len({tuple(l.material for l in c.layers) for c in selected}), 2)

    def test_locked_layers_and_intersecting_bounds(self):
        locked = ManufacturingConstraints(layers=[{'index':1, 'material':'SiO2', 'thickness_nm':100}])
        result = self.run_one(constraints=locked)
        self.assertEqual(result.layers[0].thickness_nm, 100)
        self.assertEqual(result.refinement['status'], 'locked')
        self.assertEqual(result.refinement['evaluations'], 0)
        limited = ManufacturingConstraints(min_thickness_nm=90, max_thickness_nm=110,
            layers=[{'index':1, 'min_nm':95, 'max_nm':105}])
        result = self.run_one(constraints=limited)
        self.assertTrue(95 <= result.layers[0].thickness_nm <= 105)
        self.assertLessEqual(ranking(result), ranking(self.candidate()))
        with self.assertRaises(ValueError):
            thickness_bounds(self.candidate().layers, ManufacturingConstraints(layers=[{'index':1,'material':'TiO2'}]))

    def test_evaluation_budget_counts_numerical_jacobian_across_starts(self):
        progress = []
        settings = RefinementSettings(enabled=True, starts=3, max_evaluations=20, loss='huber')
        result = self.run_one(settings, progress=lambda _, msg: progress.append(msg))
        self.assertLessEqual(result.refinement['evaluations'], 20)
        self.assertEqual(result.refinement['evaluations'], len(progress))
        self.assertEqual(result.refinement['starts_completed'], 3)

    def test_cancel_and_deadline_preserve_valid_best(self):
        count = [0]
        def progress(*_): count[0] += 1
        result = self.run_one(cancelled=lambda: count[0] >= 3, progress=progress)
        self.assertEqual(result.refinement['status'], 'cancelled')
        self.assertEqual(result.refinement['evaluations'], 3)
        self.assertLessEqual(ranking(result), ranking(self.candidate()))
        result = self.run_one(deadline=time.monotonic()-1)
        self.assertEqual(result.refinement['status'], 'time_limit')
        self.assertEqual(result.refinement['evaluations'], 0)

    def test_solver_failure_keeps_initial_and_reason(self):
        with patch('app.services.refinement_service.least_squares', side_effect=ValueError('solver failure')):
            result = self.run_one()
        self.assertEqual(result.layers, self.candidate().layers)
        self.assertEqual(result.refinement['status'], 'solver_error')
        self.assertIn('solver failure', result.refinement['message'])

    def test_refinement_grid_contains_raw_knots_and_exact_boundaries(self):
        target = TargetSpectrum(wavelengths_nm=[400, 601.3, 1100], reflectance=[.1,.2,.1], transmittance=[.9,.8,.9])
        requirements = DesignRequirements(enabled_r=False, scope='bands', bands=[
            {'start_nm':600.1,'end_nm':600.4,'kind':'minimum','value':.7}])
        grid = refinement_grid(target, requirements, 5)
        self.assertTrue(all(x in grid for x in [600.1,600.4,601.3]))
        objective = objective_arrays(target, requirements, grid)
        error, violation = residual_arrays(np.ones((2,len(grid))), objective)
        self.assertEqual(objective['weights'][0].sum(), 0)
        self.assertEqual(float((violation*objective['weights']).sum()), 0)

    def test_pool_scores_finalists_on_same_grid_and_publishes(self):
        candidates = sorted([self.candidate(t) for t in ['SiO2_100','TiO2_100']], key=ranking)
        published = []
        result = refine_candidates(candidates, self.target, self.requirements, self.constraints,
            RefinementSettings(enabled=True, starts=1, max_evaluations=20), 42, 1,
            publish=lambda values: published.append([c.model_dump() for c in values]))
        self.assertTrue(published)
        self.assertEqual(len(result), 1)
        self.assertEqual(len(result[0].simulation.wavelengths_nm), 351)

    def test_project_roundtrip_preserves_float_layers_and_initial_snapshot(self):
        result = self.run_one()
        project = ProjectDocument(simulation=SimulationRequest(layers=result.layers), candidates=[result],
            refinement_settings=RefinementSettings(enabled=True))
        restored = ProjectDocument.model_validate_json(project.model_dump_json())
        self.assertEqual(restored.candidates[0].layers, result.layers)
        self.assertEqual(restored.candidates[0].refinement, result.refinement)
        self.assertTrue(restored.refinement_settings.enabled)
        self.assertFalse(ProjectDocument(simulation=SimulationRequest()).refinement_settings.enabled)

    def test_job_integrates_refinement_and_cancel_keeps_partial_results(self):
        request = InverseJobRequest(target=self.target, candidate_count=1,
            refinement=RefinementSettings(enabled=True, starts=1, max_evaluations=20))
        search = {'structures':[['SiO2_100']], 'provenance':{('SiO2_100',):['test']}, 'summary':{'unique_count':1}}
        manager = InverseJobManager()
        try:
            for cancel in (False, True):
                manager._jobs['test'] = {'cancel_requested':False, 'status':'queued'}
                def publish_and_cancel(*args, **kwargs):
                    result = refine_candidates(*args, **kwargs)
                    if cancel: manager.cancel('test')
                    return result
                with patch('app.services.job_service.optogpt_service.generate_many', return_value=search), \
                     patch('app.services.job_service.refine_candidates', side_effect=publish_and_cancel):
                    manager._run('test', request)
                job = manager.get('test')
                self.assertEqual(job['status'], 'cancelled' if cancel else 'completed', job)
                self.assertTrue(job['result']['candidates'][0]['refinement']['accepted'])
                self.assertTrue(job['result']['refinement']['enabled'])
        finally:
            manager._executor.shutdown(wait=True)

    def test_settings_and_twenty_layer_limit_validation(self):
        for kwargs in ({'starts':0}, {'max_evaluations':19}, {'time_budget_s':float('nan')}, {'candidate_count':11}):
            with self.assertRaises(ValidationError): RefinementSettings(**kwargs)
        self.assertEqual(InverseJobRequest(target=self.target, max_layers=20).max_layers, 20)
        with self.assertRaises(ValidationError): InverseJobRequest(target=self.target, max_layers=21)


if __name__ == '__main__':
    unittest.main()
