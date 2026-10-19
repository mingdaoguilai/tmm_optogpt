from __future__ import annotations

import unittest
from unittest.mock import patch
import numpy as np
from pydantic import ValidationError

from app.schemas.models import (AdoptedCandidate, CandidateReviewRequest, CandidateVerificationRequest,
    CandidateVerificationResult, DesignRequirements, Layer, ProjectDocument, SimulationRequest, TargetSpectrum)
from app.services.design_service import score_requirements
from app.services.evaluation_service import evaluate_candidate
from app.services.workflow_service import review_candidate, verify_candidate


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.target=TargetSpectrum(wavelengths_nm=[400,600.3,1100],reflectance=[.1,.3,.1],transmittance=[.9,.7,.9])
        self.rules=DesignRequirements(enabled_r=False,scope='bands',bands=[
            {'start_nm':550.2,'end_nm':650.4,'kind':'minimum','value':.8,'tolerance':.02}])
        self.grid=np.array([400.,550.2,600.3,650.4,1100.])

    def candidate(self):
        initial=evaluate_candidate(['SiO2_100'],self.target,requirements=self.rules,grid=self.grid)
        current=evaluate_candidate(['SiO2_100'],self.target,requirements=self.rules,grid=self.grid,
            layers=[Layer(material='SiO2',thickness_nm=137.23456789)])
        current.rank=1
        current.refinement={'accepted':True,'status':'improved','message':'test','evaluations':5,
            'starts_completed':1,'elapsed_s':.1,'optimization_step_nm':5,'verification_step_nm':2,
            'initial_layers':[l.model_dump() for l in initial.layers],
            'initial_simulation':initial.simulation.model_dump(),
            'initial_metrics':{'requirement_score':initial.requirement_score,'weighted_mae':initial.weighted_mae,
                'max_violation':initial.max_violation,'pass_rate':initial.pass_rate,'mae_r':initial.mae_r,'mae_t':initial.mae_t},
            'solver_messages':[]}
        return current

    def test_review_uses_float_layers_not_original_tokens_and_same_grid(self):
        c=self.candidate()
        # Saved scalar metrics may be stale; review recomputes rather than trusting them.
        c.requirement_score=99
        with patch('app.services.optogpt_service.optogpt_service.load',side_effect=AssertionError('must not load model')):
            data=review_candidate(CandidateReviewRequest(candidate=c,target=self.target,requirements=self.rules))
        self.assertEqual(data['current']['layers'][0]['thickness_nm'],137.23456789)
        self.assertEqual(data['initial']['layers'][0]['thickness_nm'],100)
        self.assertEqual(data['current']['tokens'],['SiO2_100'])
        self.assertEqual(data['current']['simulation']['wavelengths_nm'],data['initial']['simulation']['wavelengths_nm'])
        self.assertNotEqual(data['current']['requirement_score'],99)
        self.assertIn('max_deviation',data['current']['refinement']['initial_metrics'])
        self.assertIn('initial_band_metrics',data['current']['refinement'])
        np.testing.assert_allclose(data['current']['simulation']['reflectance'],c.simulation.reflectance)
        self.assertEqual(c.requirement_score,99)  # Never mutate saved candidate.

    def test_review_nonrefined_and_missing_or_wrong_initial_structure(self):
        c=self.candidate();c.refinement=None
        data=review_candidate(CandidateReviewRequest(candidate=c,target=self.target,requirements=self.rules))
        self.assertIsNone(data['initial'])
        for report in ({'initial_layers':[]},{'initial_layers':[{'material':'TiO2','thickness_nm':100}]},{'accepted':True}):
            c.refinement=report
            with self.assertRaises(ValueError): review_candidate(CandidateReviewRequest(candidate=c,target=self.target,requirements=self.rules))

    def test_verification_reproduces_original_nonuniform_grid_and_metrics(self):
        c=self.candidate()
        request=CandidateVerificationRequest(simulation=SimulationRequest(layers=c.layers,polarization='s'),
            target=self.target,requirements=self.rules,evaluation_wavelengths_nm=self.grid.tolist())
        data=verify_candidate(request)
        self.assertEqual(data.evaluation_wavelengths_nm,self.grid.tolist())
        np.testing.assert_allclose(data.result.reflectance,c.simulation.reflectance,atol=1e-12)
        self.assertAlmostEqual(data.metrics['requirement_score'],c.requirement_score)
        self.assertEqual(data.simulation.layers[0].thickness_nm,137.23456789)

    def test_changed_angle_and_polarization_are_recomputed_not_reused(self):
        c=self.candidate()
        request=CandidateVerificationRequest(simulation=SimulationRequest(layers=c.layers,angle_deg=40,polarization='unpolarized',p_ratio=.3),
            target=self.target,requirements=self.rules,evaluation_wavelengths_nm=self.grid.tolist())
        result=verify_candidate(request)
        self.assertEqual(result.simulation.angle_deg,40)
        self.assertGreater(np.max(np.abs(np.array(result.result.reflectance)-c.simulation.reflectance)),.001)

    def test_max_deviation_is_active_pre_tolerance_error_not_full_spectrum(self):
        target=TargetSpectrum(wavelengths_nm=[400,1100],reflectance=[0,0],transmittance=[1,1])
        rules=DesignRequirements(enabled_r=False,scope='bands',bands=[
            {'start_nm':500,'end_nm':600,'kind':'minimum','value':.9,'tolerance':.02}])
        grid=np.array([400,500,600,1100.])
        result=score_requirements(target,rules,grid,np.array([[1,1,1,1],[0,.88,.87,0]]))
        self.assertAlmostEqual(result['max_deviation'],.03)
        self.assertAlmostEqual(result['max_violation'],.01)
        self.assertAlmostEqual(result['pass_rate'],.5)
        self.assertAlmostEqual(result['band_metrics'][0]['max_deviation'],.03)

    def test_invalid_grids_and_mismatched_saved_results_rejected(self):
        kwargs=dict(simulation=SimulationRequest(),target=self.target,requirements=self.rules)
        for grid in ([400,400,1100],[400,float('nan'),1100],[400,500],[400,1200,1100],[400,600,500,1100]):
            with self.assertRaises(ValidationError): CandidateVerificationRequest(**kwargs,evaluation_wavelengths_nm=grid)
        valid=verify_candidate(CandidateVerificationRequest(**kwargs,evaluation_wavelengths_nm=self.grid.tolist())).model_dump()
        valid['result']['wavelengths_nm']=[400,1100]
        with self.assertRaises(ValidationError): CandidateVerificationResult(**valid)

    def test_schema_four_roundtrip_adopted_versions_and_verification(self):
        reviewed=review_candidate(CandidateReviewRequest(candidate=self.candidate(),target=self.target,requirements=self.rules))
        for variant in ('initial','current'):
            candidate=reviewed[variant]
            conditions=SimulationRequest(layers=candidate['layers'],polarization='s')
            adoption=AdoptedCandidate(variant=variant,candidate=candidate,target=self.target,requirements=self.rules,conditions=conditions)
            verification=verify_candidate(CandidateVerificationRequest(simulation=conditions,target=self.target,
                requirements=self.rules,evaluation_wavelengths_nm=self.grid.tolist()))
            project=ProjectDocument(simulation=conditions,adopted_candidate=adoption,forward_verification=verification)
            restored=ProjectDocument.model_validate_json(project.model_dump_json())
            self.assertEqual(restored.schema_version,4)
            self.assertEqual(restored.adopted_candidate,adoption)
            self.assertEqual(restored.forward_verification,verification)
        with self.assertRaises(ValidationError):
            AdoptedCandidate(variant='current',candidate=reviewed['current'],target=self.target,
                requirements=self.rules,conditions=SimulationRequest())
        for version in (1,2,3):
            self.assertIsNone(ProjectDocument(schema_version=version,simulation=SimulationRequest()).adopted_candidate)


if __name__=='__main__': unittest.main()
