"""Inference-only search policies; no checkpoint or vocabulary changes."""
from __future__ import annotations

import torch


def sampling_probabilities(log_probs, top_k, top_p, temperature):
    """Intersect top-k with nucleus on the ORIGINAL temperature-scaled mass.

    Keep the token crossing p (and at least one token), then renormalize.
    This matches the upstream joint top-k/top-p selection semantics.
    """
    probabilities = torch.softmax(log_probs / temperature, dim=-1)
    values, indices = torch.sort(probabilities, descending=True, stable=True)
    before = torch.cumsum(values, dim=-1) - values
    keep = (torch.arange(values.numel(), device=values.device) < top_k) & (before < top_p)
    filtered = torch.zeros_like(probabilities)
    filtered[indices[keep]] = values[keep]
    if not torch.isfinite(filtered).all() or filtered.sum() <= 0:
        raise ValueError("No finite sampling probability remains")
    return filtered / filtered.sum()


def beam_decode(next_log_probs, eos_id, max_layers, width, alpha, cancelled):
    """Bounded beam search with frozen EOS hypotheses and GNMT length score.

    next_log_probs receives layer ids only; the caller adds BOS. EOS counts
    toward length only when actually emitted. At the hard layer cap, return
    the physical prefix without inventing an EOS probability.
    """
    beams = [((), 0.0, False, 0)]
    for _ in range(max_layers):
        expanded = []
        for ids, log_score, ended, length in beams:
            if cancelled():
                return []
            if ended:
                expanded.append((ids, log_score, ended, length))
                continue
            probs = next_log_probs(ids)
            indices = torch.argsort(probs, descending=True, stable=True)[:width]
            for token in indices.tolist():
                if not torch.isfinite(probs[token]):
                    continue
                done = token == eos_id
                expanded.append((ids if done else ids + (token,),
                                 log_score + float(probs[token]), done, length + 1))
        beams = sorted(expanded, key=lambda item: item[1] / (((5 + item[3]) / 6) ** alpha),
                       reverse=True)[:width]
        if not beams or all(item[2] for item in beams):
            break
    return [list(item[0]) for item in beams if item[0]]
