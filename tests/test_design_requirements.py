import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import torch
from pydantic import ValidationError
from app.schemas.models import DesignRequirements, ManufacturingConstraints, ProjectDocument, SimulationRequest, TargetSpectrum
from app.services.design_service import MODEL_GRID, objective_arrays, prepare_design, score_requirements, verification_grid
from app.services.constraint_service import check_structure, compile_token_masks
from app.services.optogpt_service import OptoGPTService


class TinyDesigner(OptoGPTService):
    def __init__(self):
        super().__init__(Path('unused'))
        self.device = torch.device('cpu')
        self.config = SimpleNamespace(spec_dim=4)
        self.word_to_id = {'BOS': 0, 'EOS': 1, 'SiO2_100': 2, 'TiO2_100': 3, 'SiO2_200': 4}
        self.id_to_word = {i:w for w,i in self.word_to_id.items()}
    def load(self):
        pass
    def _next_log_probs(self, target, ids):
        return torch.tensor([0., 0.8, 0.07, 0.07, 0.06]).log()


class RequirementsTests(unittest.TestCase):
    def target(self, r=0.8, t=0.9):
        return TargetSpectrum(wavelengths_nm=[400,1100], reflectance=[r,r], transmittance=[t,t])

    def test_unspecified_r_is_completed_but_never_scored(self):
        rules = DesignRequirements(enabled_r=False)
        preview = prepare_design(self.target(), rules)
        np.testing.assert_allclose(preview['model_target']['reflectance'], 0.1)
        score1 = score_requirements(self.target(),rules,MODEL_GRID,np.array([np.zeros(71),np.full(71,0.85)]))
        score2 = score_requirements(self.target(r=0.1),rules,MODEL_GRID,np.array([np.ones(71),np.full(71,0.85)]))
        self.assertAlmostEqual(score1['requirement_score'],0.05)
        self.assertEqual(score1,score2)

    def test_threshold_ignore_and_tolerance_have_correct_score(self):
        rules = DesignRequirements(enabled_r=False,scope='bands',bands=[
            {'channel':'T','start_nm':550,'end_nm':650,'kind':'minimum','value':0.9,'tolerance':0.02},
            {'channel':'T','start_nm':590,'end_nm':610,'kind':'ignore'}])
        grid=np.array([400.,550.,600.,650.,1100.])
        actual=np.array([[0]*5,[0.,0.87,0.,0.95,0.]])
        score=score_requirements(self.target(),rules,grid,actual)
        self.assertAlmostEqual(score['requirement_score'],0.005)
        self.assertAlmostEqual(score['pass_rate'],0.5)
        self.assertEqual(len(score['band_metrics']),1)
        self.assertAlmostEqual(score['band_metrics'][0]['max_violation'],0.01)

    def test_maximum_requirement_does_not_force_matching_upper_limit(self):
        rules=DesignRequirements(enabled_r=False,scope='bands',bands=[{'channel':'T','start_nm':400,'end_nm':1100,'kind':'maximum','value':0.2,'tolerance':0}])
        good=score_requirements(self.target(),rules,MODEL_GRID,np.array([np.zeros(71),np.full(71,0.1)]))
        self.assertEqual(good['requirement_score'],0)
        self.assertEqual(good['pass_rate'],1)

    def test_reference_completion_is_projected_only_where_needed(self):
        rules=DesignRequirements(enabled_r=False,completion='reference')
        physical={'R':np.full(71,0.3),'T':np.full(71,0.6)}
        with patch('app.services.design_service._simulate_polarization',return_value=physical):
            preview=prepare_design(self.target(t=0.8),rules)
        np.testing.assert_allclose(preview['model_target']['reflectance'],0.2)
        np.testing.assert_allclose(preview['model_target']['transmittance'],0.8)

    def test_weights_select_rank_and_zero_weight_is_excluded(self):
        rules=DesignRequirements(weight_r=3,weight_t=1)
        target=self.target(r=0.2,t=0.5)
        score=score_requirements(target,rules,MODEL_GRID,np.array([np.full(71,0.3),np.full(71,0.7)]))
        self.assertAlmostEqual(score['requirement_score'],0.125)
        with self.assertRaises(ValueError): prepare_design(target,DesignRequirements(enabled_r=False,enabled_t=False))
        with self.assertRaises(ValueError): prepare_design(target,DesignRequirements(weight_r=0,weight_t=0))

    def test_physical_conflicts_checked_on_off_grid_points(self):
        with self.assertRaises(ValueError): prepare_design(self.target(),DesignRequirements())
        target=TargetSpectrum(wavelengths_nm=[400,605,1100],reflectance=[0,0.8,0],transmittance=[0,0.8,0])
        with self.assertRaises(ValueError): prepare_design(target,DesignRequirements())
        # Allowable tolerance ranges can have a feasible passive intersection.
        preview=prepare_design(self.target(r=0.6,t=0.5),DesignRequirements(tolerance=0.1))
        self.assertTrue(all(r+t<=1+1e-8 for r,t in zip(preview['model_target']['reflectance'],preview['model_target']['transmittance'])))

    def test_narrow_band_boundaries_are_scored_and_input_limit_is_reported(self):
        rules=DesignRequirements(enabled_r=False,scope='bands',bands=[{'channel':'T','start_nm':605,'end_nm':606,'kind':'minimum'}])
        preview=prepare_design(self.target(),rules)
        self.assertIn(605,verification_grid(rules))
        self.assertEqual(preview['active_t_points'],2)
        self.assertTrue(preview['warnings'])

    def test_t_only_band_completion_does_not_use_disabled_r_as_outside_hint(self):
        rules=DesignRequirements(enabled_r=False,scope='bands',bands=[{'channel':'T','start_nm':550,'end_nm':650,'kind':'minimum'}])
        first=prepare_design(self.target(r=0.1,t=0.8),rules)
        second=prepare_design(self.target(r=0.9,t=0.8),rules)
        self.assertEqual(first['model_target'],second['model_target'])

    def test_shared_endpoint_has_one_owner_in_band_metrics(self):
        rules=DesignRequirements(enabled_r=False,scope='bands',bands=[
            {'channel':'T','start_nm':500,'end_nm':600,'kind':'minimum','value':0.9,'tolerance':0},
            {'channel':'T','start_nm':600,'end_nm':700,'kind':'maximum','value':0.2,'tolerance':0}])
        score=score_requirements(self.target(),rules,np.array([500.,600.,700.]),np.array([[0,0,0],[0.9,0.2,0.2]]))
        self.assertEqual(score['requirement_score'],0)
        self.assertTrue(all(b['pass_rate']==1 for b in score['band_metrics']))

    def test_conflicting_bands_and_manufacturing_bounds_rejected(self):
        with self.assertRaises(ValidationError):
            DesignRequirements(bands=[{'start_nm':500,'end_nm':600},{'start_nm':550,'end_nm':650}])
        for data in [{'min_thickness_nm':200,'max_thickness_nm':100},
                     {'layers':[{'index':1,'material':'SiO2'},{'index':1,'material':'TiO2'}]},
                     {'min_thickness_nm':150,'layers':[{'index':1,'thickness_nm':100}]}]:
            with self.assertRaises(ValidationError): ManufacturingConstraints(**data)

    def test_sampling_greedy_and_beam_all_obey_bounds_and_lock(self):
        service=TinyDesigner()
        constraints=ManufacturingConstraints(min_thickness_nm=90,max_thickness_nm=110,layers=[{'index':2,'material':'TiO2','thickness_nm':100}])
        result=service.generate_many(np.zeros(4),candidate_count=2,top_k=10,temperature=1,max_layers=3,seed=42,sample_count=12,beam_width=3,constraints=constraints)
        self.assertTrue(result['structures'])
        for tokens in result['structures']:
            self.assertGreaterEqual(len(tokens),2)
            self.assertEqual(tokens[1],'TiO2_100')
            check_structure(tokens,constraints)
        self.assertTrue(any('greedy' in sources for sources in result['provenance'].values()))
        self.assertTrue(any('beam' in sources for sources in result['provenance'].values()))
        masks=compile_token_masks(service.word_to_id,constraints,3,'cpu')
        self.assertFalse(masks[1][service.word_to_id['EOS']])

    def test_unavailable_locked_thickness_and_empty_vocabulary_intersection_fail_explicitly(self):
        service=TinyDesigner()
        for data in [{'layers':[{'index':1,'material':'SiO2','thickness_nm':105}]}, {'min_thickness_nm':150,'max_thickness_nm':160}]:
            with self.assertRaises(ValueError): compile_token_masks(service.word_to_id,ManufacturingConstraints(**data),3,'cpu')
        with self.assertRaises(ValueError): check_structure(['SiO2_200'],ManufacturingConstraints(max_thickness_nm=110))

    def test_project_schema_migration_and_requirements_roundtrip(self):
        rules=DesignRequirements(enabled_r=False,scope='bands',bands=[{'channel':'T','kind':'minimum','value':0.9}])
        constraints=ManufacturingConstraints(layers=[{'index':2,'material':'TiO2'}])
        project=ProjectDocument(simulation=SimulationRequest(),design_requirements=rules,manufacturing_constraints=constraints)
        self.assertEqual(ProjectDocument.model_validate_json(project.model_dump_json()),project)
        for version in [1,2]:
            legacy=ProjectDocument(schema_version=version,simulation=SimulationRequest())
            self.assertEqual(legacy.design_requirements,DesignRequirements())


if __name__=='__main__': unittest.main()
