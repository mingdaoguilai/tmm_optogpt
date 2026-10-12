from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np
import torch

from app.services.decoding import beam_decode, sampling_probabilities
from app.services.constraint_service import compile_token_masks


PROJECT_ROOT = Path(__file__).resolve().parents[2]
OPTOGPT_ROOT = PROJECT_ROOT / "third_party" / "optogpt" / "optogpt"
DEFAULT_MODEL_PATH = PROJECT_ROOT / "models" / "optogpt" / "optogpt.pt"
MODEL_PATH = Path(os.environ.get("OPTOGPT_MODEL_PATH", DEFAULT_MODEL_PATH))


ProgressCallback = Callable[[float, str], None]
CancelCallback = Callable[[], bool]


class OptoGPTService:
    def __init__(self, model_path: Path = MODEL_PATH):
        self.model_path = model_path
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = None
        self.config = None
        self.word_to_id = None
        self.id_to_word = None
        self._load_lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def status(self) -> dict:
        return {
            "model_present": self.model_path.is_file(),
            "loaded": self.loaded,
            "device": str(self.device),
            "cuda_available": torch.cuda.is_available(),
            "cuda_version": torch.version.cuda,
            "model_path": str(self.model_path),
        }

    def load(self) -> None:
        if self.loaded:
            return
        with self._load_lock:
            if self.loaded:
                return
            if not self.model_path.is_file():
                raise FileNotFoundError(
                    f"OptoGPT checkpoint not found at {self.model_path}"
                )
            if str(OPTOGPT_ROOT) not in sys.path:
                sys.path.insert(0, str(OPTOGPT_ROOT))

            from core.models.transformer import make_model_I
            from core.trains.train import NoamOpt  # noqa: F401 - checkpoint unpickling

            checkpoint = torch.load(self.model_path, map_location=self.device)
            self.config = checkpoint["configs"]
            self.model = make_model_I(
                self.config.spec_dim,
                self.config.struc_dim,
                self.config.layers,
                self.config.d_model,
                self.config.d_ff,
                self.config.head_num,
                self.config.dropout,
            ).to(self.device)
            self.model.load_state_dict(checkpoint["model_state_dict"])
            self.model.eval()
            self.word_to_id = self.config.struc_word_dict
            self.id_to_word = self.config.struc_index_dict

    @torch.inference_mode()
    def _next_log_probs(self, spectrum_target, ids):
        source = torch.as_tensor(spectrum_target, dtype=torch.float32, device=self.device).view(1, 1, -1)
        generated = torch.tensor([[self.word_to_id["BOS"], *ids]], dtype=torch.long, device=self.device)
        mask = torch.ones((1, generated.size(1), generated.size(1)),
                          dtype=torch.bool, device=self.device).tril()
        output = self.model(source, generated, None, mask)
        logits = self.model.generator(output[:, -1]).squeeze(0).clone()
        for token in ("BOS", "PAD", "UNK"):
            if token in self.word_to_id:
                logits[self.word_to_id[token]] = -torch.inf
        # Empty structures are not valid optical candidates.
        if not ids:
            logits[self.word_to_id["EOS"]] = -torch.inf
        return torch.log_softmax(logits, dim=-1)

    @torch.inference_mode()
    def _constrained_log_probs(self, target, ids, token_masks=None):
        logits = self._next_log_probs(target, ids)
        if token_masks is not None:
            logits = logits.clone().masked_fill(~token_masks[len(ids)], -torch.inf)
            if not torch.isfinite(logits).any():
                raise ValueError("当前层在工艺约束下没有可生成的 token")
            logits = torch.log_softmax(logits, dim=-1)
        return logits

    def capabilities(self):
        self.load()
        by_material = {}
        for word in self.word_to_id:
            try:
                material, thickness = word.rsplit('_', 1)
                by_material.setdefault(material, []).append(float(thickness))
            except ValueError:
                continue
        return {"materials": {m: sorted(set(t)) for m, t in by_material.items()}}

    @torch.inference_mode()
    def sample(
        self,
        spectrum_target: np.ndarray,
        top_k: int,
        temperature: float,
        max_layers: int,
        top_p: float = 1.0,
        generator=None,
        greedy: bool = False,
        cancelled: Optional[CancelCallback] = None,
        token_masks=None,
    ) -> List[str]:
        self.load()

        expected_dimension = int(self.config.spec_dim)
        target = np.asarray(spectrum_target, dtype=np.float32)
        if target.shape != (expected_dimension,):
            raise ValueError(
                f"Model expects a {expected_dimension}-value spectrum, received {target.shape}"
            )

        if not np.all(np.isfinite(target)):
            raise ValueError("Target spectrum must be finite")
        eos_id = self.word_to_id["EOS"]
        ids = []
        structure: List[str] = []

        for _ in range(max_layers):
            if cancelled and cancelled():
                return []
            logits = self._constrained_log_probs(target, ids, token_masks)
            if greedy:
                next_id = int(torch.argmax(logits))
            else:
                probabilities = sampling_probabilities(logits, top_k, top_p, temperature)
                next_id = int(torch.multinomial(probabilities, num_samples=1, generator=generator).item())
            if next_id == eos_id:
                break
            structure.append(self.id_to_word[next_id])
            ids.append(next_id)
        return structure

    def generate_many(
        self,
        spectrum_target: np.ndarray,
        candidate_count: int,
        top_k: int,
        temperature: float,
        max_layers: int,
        seed: int,
        progress: Optional[ProgressCallback] = None,
        cancelled: Optional[CancelCallback] = None,
        sample_count: int = 300,
        seed_count: int = 4,
        temperatures: Optional[List[float]] = None,
        top_p: float = 0.85,
        include_greedy: bool = True,
        beam_width: int = 5,
        length_penalty: float = 0.6,
        constraints=None,
    ) -> dict:
        self.load()
        token_masks = (compile_token_masks(self.word_to_id, constraints, max_layers, self.device)
                       if constraints is not None else None)
        target = np.asarray(spectrum_target, dtype=np.float32)
        if target.shape != (int(self.config.spec_dim),) or not np.all(np.isfinite(target)):
            raise ValueError("Invalid target spectrum shape or nonfinite values")
        cancelled = cancelled or (lambda: False)
        temperatures = temperatures if temperatures is not None else [temperature]
        seeds = [(seed + offset) % (2**32) for offset in range(seed_count)]
        # One independent RNG stream per seed/temperature cell; no global RNG mutation.
        cells = [(value, torch.Generator(device=self.device).manual_seed(s))
                 for s in seeds for value in temperatures]
        candidates: List[List[str]] = []
        seen = set()
        provenance = {}
        raw_count = 0
        sampled = 0

        def add(structure, origin):
            nonlocal raw_count
            if not structure:
                return
            raw_count += 1
            key = tuple(structure)
            if key not in seen:
                seen.add(key)
                candidates.append(structure)
                provenance[key] = []
            if origin not in provenance[key]:
                provenance[key].append(origin)

        for attempt in range(sample_count):
            if cancelled():
                break
            value, rng = cells[attempt % len(cells)]
            structure = self.sample(
                target,
                top_k=top_k,
                top_p=top_p,
                temperature=value,
                max_layers=max_layers,
                generator=rng,
                cancelled=cancelled,
                token_masks=token_masks,
            )
            if cancelled():
                break
            sampled += 1
            add(structure, "sampling")
            if progress:
                progress(
                    0.85 * sampled / sample_count,
                    f"随机抽样 {sampled}/{sample_count} · 唯一结构 {len(candidates)}",
                )
        if include_greedy and not cancelled():
            if progress:
                progress(0.86, "正在生成 greedy 候选")
            add(self.sample(target, top_k, 1.0, max_layers, greedy=True,
                            cancelled=cancelled, token_masks=token_masks), "greedy")
        if beam_width and not cancelled():
            if progress:
                progress(0.9, "正在进行长度归一化 beam search")
            beams = beam_decode(lambda ids: self._constrained_log_probs(target, ids, token_masks),
                                self.word_to_id["EOS"], max_layers, beam_width,
                                length_penalty, cancelled)
            for ids in beams:
                add([self.id_to_word[i] for i in ids], "beam")
        if progress and not cancelled():
            progress(1.0, f"搜索完成 · {len(candidates)} 个唯一结构待 TMM 验证")
        return {"structures": candidates, "provenance": provenance,
                "summary": {"sampled_count": sampled, "raw_count": raw_count,
                            "unique_count": len(candidates),
                            "duplicate_count": raw_count - len(candidates),
                            "seeds": seeds, "temperatures": temperatures}}


optogpt_service = OptoGPTService()
