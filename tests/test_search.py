from __future__ import annotations

import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import torch
from pydantic import ValidationError

from app.schemas.models import InverseJobRequest, TargetSpectrum
from app.services.decoding import beam_decode, sampling_probabilities
from app.services.optogpt_service import OptoGPTService
from app.services.job_service import InverseJobManager


class ToyService(OptoGPTService):
    def __init__(self):
        super().__init__(Path('unused'))
        self.device = torch.device('cpu')
        self.config = SimpleNamespace(spec_dim=4)
        self.word_to_id = {'BOS': 0, 'EOS': 1, 'SiO2_100': 2, 'TiO2_100': 3}
        self.id_to_word = {v: k for k, v in self.word_to_id.items()}

    def load(self):
        pass

    def _next_log_probs(self, target, ids):
        return torch.tensor([0., 0.4 if ids else 0., 0.35, 0.25]).log()


class SearchTests(unittest.TestCase):
    def test_joint_top_k_top_p_keeps_crossing_token_without_prerenormalizing(self):
        logits = torch.tensor([0.4, 0.3, 0.2, 0.1]).log()
        result = sampling_probabilities(logits, 3, 0.8, 1)
        self.assertEqual(torch.count_nonzero(result), 3)
        torch.testing.assert_close(result, torch.tensor([4/9, 3/9, 2/9, 0.]))
        self.assertEqual(torch.count_nonzero(sampling_probabilities(logits, 4, 0.1, 1)), 1)
        self.assertEqual(torch.count_nonzero(sampling_probabilities(logits, 1, 1, 1)), 1)

    def test_temperature_changes_odds(self):
        logits = torch.tensor([0.75, 0.25]).log()
        result = sampling_probabilities(logits, 2, 1, 0.5)
        self.assertAlmostEqual(float(result[0] / result[1]), 9., places=5)

    def test_beam_freezes_eos_and_honors_cap(self):
        visited = []
        def next_probs(ids):
            visited.append(ids)
            self.assertNotIn(0, ids)
            return torch.tensor([0.6 if ids else 0., 0.3, 0.1]).log()
        result = beam_decode(next_probs, 0, 3, 2, 0.6, lambda: False)
        self.assertTrue(result)
        self.assertTrue(all(0 < len(ids) <= 3 and 0 not in ids for ids in result))
        self.assertEqual(beam_decode(next_probs, 0, 3, 2, 0.6, lambda: True), [])

    def test_length_normalization_can_change_ranking(self):
        def probabilities(ids):
            return (torch.tensor([0., 0.6, 0.4]) if not ids else
                    torch.tensor([0.45, 0.55, 0.]) if ids == (1,) else
                    torch.tensor([1., 0., 0.])).log()
        short = beam_decode(probabilities, 0, 3, 3, 0, lambda: False)
        normalized = beam_decode(probabilities, 0, 3, 3, 2, lambda: False)
        self.assertEqual(short[0], [2])
        self.assertEqual(normalized[0], [1, 1])

    def test_full_sampling_budget_reproducibility_and_dedup(self):
        service = ToyService()
        args = dict(candidate_count=1, top_k=3, temperature=1, max_layers=3,
                    seed=42, sample_count=24, seed_count=4, temperatures=[0.7, 0.85, 1],
                    beam_width=3)
        state = torch.get_rng_state().clone()
        first = service.generate_many(np.zeros(4), **args)
        second = service.generate_many(np.zeros(4), **args)
        self.assertEqual(first, second)
        self.assertTrue(torch.equal(state, torch.get_rng_state()))
        self.assertEqual(first['summary']['sampled_count'], 24)
        self.assertGreater(len(first['structures']), 1)
        self.assertEqual(len(first['structures']), len({tuple(x) for x in first['structures']}))
        self.assertTrue(any('greedy' in origins for origins in first['provenance'].values()))
        self.assertTrue(any('beam' in origins for origins in first['provenance'].values()))

    def test_cancellation_checked_within_sequence(self):
        service = ToyService()
        calls = []
        def cancel():
            calls.append(1)
            return len(calls) > 1
        self.assertEqual(service.sample(np.zeros(4), 3, 1, 20, cancelled=cancel), [])

    def test_request_validation_and_legacy_temperature(self):
        target = TargetSpectrum(wavelengths_nm=[400, 1100], reflectance=[0, 0], transmittance=[1, 1])
        self.assertEqual(InverseJobRequest(target=target).temperatures, [0.7, 0.85, 1])
        self.assertEqual(InverseJobRequest(target=target, temperature=0.9).temperatures, [0.9])
        for bad in ({'top_p': 0}, {'temperatures': []}, {'temperatures': [float('nan')]},
                    {'sample_count': 2}, {'reflectance_weight': 0, 'transmittance_weight': 0}):
            with self.assertRaises(ValidationError):
                InverseJobRequest(target=target, **bad)

    def test_all_unique_candidates_verified_before_retaining_best(self):
        from app.services.evaluation_service import evaluate_candidate
        target = TargetSpectrum(wavelengths_nm=[400, 1100], reflectance=[0, 0], transmittance=[1, 1])
        request = InverseJobRequest(target=target, candidate_count=1)
        structures = [['SiO2_100'], ['SiO2_200'], ['TiO2_100']]
        search = {'structures': structures, 'provenance': {}, 'summary': {'unique_count': 3}}
        manager = InverseJobManager()
        manager._jobs['test'] = {'cancel_requested': False}
        try:
            with patch('app.services.job_service.optogpt_service.generate_many', return_value=search), \
                 patch('app.services.job_service.evaluate_candidate', wraps=evaluate_candidate) as evaluate:
                manager._run('test', request)
                self.assertEqual(evaluate.call_count, 3)
            result = manager.get('test')
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(result['result']['search_summary']['verified_count'], 3)
            best = min((evaluate_candidate(tokens, target) for tokens in structures),
                       key=lambda candidate: (candidate.mae_r + candidate.mae_t, candidate.score))
            self.assertEqual(result['result']['candidates'][0]['tokens'], best.tokens)
        finally:
            manager._executor.shutdown(wait=True)


if __name__ == '__main__':
    unittest.main()
