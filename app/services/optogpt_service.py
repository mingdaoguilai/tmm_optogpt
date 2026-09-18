from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np
import torch


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
    def sample(
        self,
        spectrum_target: np.ndarray,
        top_k: int,
        temperature: float,
        max_layers: int,
    ) -> List[str]:
        self.load()
        from core.datasets.datasets import subsequent_mask

        expected_dimension = int(self.config.spec_dim)
        target = np.asarray(spectrum_target, dtype=np.float32)
        if target.shape != (expected_dimension,):
            raise ValueError(
                f"Model expects a {expected_dimension}-value spectrum, received {target.shape}"
            )

        source = torch.as_tensor(target, dtype=torch.float32, device=self.device).view(1, 1, -1)
        bos_id = self.word_to_id["BOS"]
        eos_id = self.word_to_id["EOS"]
        generated = torch.tensor([[bos_id]], dtype=torch.long, device=self.device)
        structure: List[str] = []

        for _ in range(max_layers):
            target_mask = subsequent_mask(generated.size(1)).to(self.device)
            output = self.model(source, generated, None, target_mask)
            logits = self.model.generator(output[:, -1]).squeeze(0) / temperature
            for special_token in ("BOS", "PAD", "UNK"):
                token_id = self.word_to_id.get(special_token)
                if token_id is not None:
                    logits[token_id] = -torch.inf
            probabilities = torch.softmax(logits, dim=-1)
            if 0 < top_k < probabilities.numel():
                indices = torch.topk(probabilities, top_k).indices
                filtered = torch.zeros_like(probabilities)
                filtered[indices] = probabilities[indices]
                probabilities = filtered
            probabilities = probabilities / probabilities.sum()
            next_id = int(torch.multinomial(probabilities, num_samples=1).item())
            if next_id == eos_id:
                break
            structure.append(self.id_to_word[next_id])
            generated = torch.cat(
                [generated, torch.tensor([[next_id]], device=self.device)], dim=1
            )
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
    ) -> List[List[str]]:
        self.load()
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        candidates: List[List[str]] = []
        seen = set()
        maximum_attempts = candidate_count * 10
        for attempt in range(maximum_attempts):
            if cancelled and cancelled():
                break
            structure = self.sample(
                spectrum_target,
                top_k=top_k,
                temperature=temperature,
                max_layers=max_layers,
            )
            key = tuple(structure)
            if structure and key not in seen:
                seen.add(key)
                candidates.append(structure)
            if progress:
                progress(
                    min(1.0, len(candidates) / candidate_count),
                    f"Generated {len(candidates)} of {candidate_count} unique candidates",
                )
            if len(candidates) >= candidate_count:
                break
        return candidates


optogpt_service = OptoGPTService()
