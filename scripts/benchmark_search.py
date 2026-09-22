"""Compare the retained v2 sampling policy with v3 on real checkpoint/TMM.

Run from the repository root with OPTOGPT_MODEL_PATH configured:
  python -m scripts.benchmark_search --samples 300 --targets bandpass
Results are printed as JSON; no model or project files are modified.
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np
import torch

from app.schemas.models import InverseJobRequest, TargetSpectrum
from app.services.evaluation_service import evaluate_candidate, target_vector
from app.services.job_service import InverseJobManager
from app.services.optogpt_service import optogpt_service


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--samples', type=int, default=300)
    parser.add_argument('--targets', nargs='+', default=['bandpass', 'anti-reflection'])
    options = parser.parse_args()
    optogpt_service.load()
    # The original CLI sampler has the same top-k=50, temperature=1 policy
    # as v2. Share loaded weights to avoid allocating a second model.
    from inverse_design.infer_optogpt import OptoGPTDesigner
    baseline = OptoGPTDesigner.__new__(OptoGPTDesigner)
    for key in ('device', 'model', 'config', 'word_to_id', 'id_to_word'):
        setattr(baseline, key, getattr(optogpt_service, key))
    print(json.dumps({'device': str(optogpt_service.device),
                      'spec_dim': int(optogpt_service.config.spec_dim)}, ensure_ascii=False), flush=True)
    manager = InverseJobManager()
    try:
        for name in options.targets:
            waves = np.arange(400, 1101, 10)
            if name == 'bandpass':
                reflection = np.where((waves >= 540) & (waves <= 680), 0.04, 0.94)
            elif name == 'anti-reflection':
                reflection = np.full(71, 0.02)
            else:
                raise ValueError('Unknown target: ' + name)
            target = TargetSpectrum(wavelengths_nm=waves.tolist(), reflectance=reflection.tolist(),
                                    transmittance=(1 - reflection).tolist())
            torch.manual_seed(42)
            started = time.perf_counter()
            raw = baseline.generate_many(target_vector(target), candidate_count=20)
            old = [evaluate_candidate(tokens, target) for tokens in raw]
            old.sort(key=lambda c: c.score)
            print(json.dumps({'target': name, 'policy': 'v2', 'seconds': time.perf_counter() - started,
                              'unique_count': len(old),
                              'top1_spectral_mae': (old[0].mae_r + old[0].mae_t) / 2,
                              'best_spectral_mae': min((c.mae_r + c.mae_t) / 2 for c in old)}), flush=True)
            request = InverseJobRequest(target=target, sample_count=options.samples)
            manager._jobs[name] = {'cancel_requested': False}
            started = time.perf_counter()
            manager._run(name, request)
            job = manager.get(name)
            if job['status'] != 'completed':
                raise RuntimeError(job)
            result = job['result']
            candidate = result['candidates'][0]
            print(json.dumps({'target': name, 'policy': 'v3', 'seconds': time.perf_counter() - started,
                              **result['search_summary'],
                              'best_spectral_mae': (candidate['mae_r'] + candidate['mae_t']) / 2,
                              'sources': candidate['sources'], 'tokens': candidate['tokens']},
                             ensure_ascii=False), flush=True)
    finally:
        manager._executor.shutdown(wait=True)


if __name__ == '__main__':
    main()
