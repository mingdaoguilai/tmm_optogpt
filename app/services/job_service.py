from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Dict

from app.schemas import InverseJobRequest
from app.services.evaluation_service import evaluate_candidate, target_vector
from app.services.optogpt_service import optogpt_service


class InverseJobManager:
    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="optogpt")
        self._jobs: Dict[str, dict] = {}
        self._lock = threading.Lock()

    def create(self, request: InverseJobRequest) -> dict:
        job_id = uuid.uuid4().hex
        now = datetime.now(timezone.utc).isoformat()
        job = {
            "id": job_id,
            "status": "queued",
            "stage": "queued",
            "message": "Waiting for the OptoGPT worker",
            "progress": 0.0,
            "cancel_requested": False,
            "created_at": now,
            "updated_at": now,
            "result": None,
            "error": None,
        }
        with self._lock:
            self._jobs[job_id] = job
        self._executor.submit(self._run, job_id, request)
        return self.get(job_id)

    def get(self, job_id: str) -> dict:
        with self._lock:
            if job_id not in self._jobs:
                raise KeyError(job_id)
            return dict(self._jobs[job_id])

    def cancel(self, job_id: str) -> dict:
        self._update(job_id, cancel_requested=True, message="Cancellation requested")
        return self.get(job_id)

    def _update(self, job_id: str, **changes) -> None:
        with self._lock:
            self._jobs[job_id].update(changes)
            self._jobs[job_id]["updated_at"] = datetime.now(timezone.utc).isoformat()

    def _cancelled(self, job_id: str) -> bool:
        with self._lock:
            return bool(self._jobs[job_id]["cancel_requested"])

    def _run(self, job_id: str, request: InverseJobRequest) -> None:
        try:
            self._update(
                job_id,
                status="running",
                stage="model",
                message="Loading OptoGPT model",
                progress=0.02,
            )
            vector = target_vector(request.target)

            def generation_progress(value: float, message: str) -> None:
                self._update(
                    job_id,
                    stage="generation",
                    message=message,
                    progress=0.08 + value * 0.47,
                )

            structures = optogpt_service.generate_many(
                vector,
                candidate_count=request.candidate_count,
                top_k=request.top_k,
                temperature=request.temperature,
                max_layers=request.max_layers,
                seed=request.seed,
                progress=generation_progress,
                cancelled=lambda: self._cancelled(job_id),
            )
            if self._cancelled(job_id):
                self._update(job_id, status="cancelled", stage="cancelled", progress=1.0)
                return
            if not structures:
                raise RuntimeError("OptoGPT did not generate a valid candidate")

            candidates = []
            for index, structure in enumerate(structures):
                if self._cancelled(job_id):
                    self._update(job_id, status="cancelled", stage="cancelled", progress=1.0)
                    return
                self._update(
                    job_id,
                    stage="verification",
                    message=f"TMM verification {index + 1} of {len(structures)}",
                    progress=0.55 + (index / len(structures)) * 0.43,
                )
                candidates.append(
                    evaluate_candidate(
                        structure,
                        request.target,
                        reflectance_weight=request.reflectance_weight,
                        transmittance_weight=request.transmittance_weight,
                    )
                )

            candidates.sort(key=lambda item: item.score)
            for rank, candidate in enumerate(candidates, start=1):
                candidate.rank = rank
            self._update(
                job_id,
                status="completed",
                stage="completed",
                message=f"Completed with {len(candidates)} verified candidates",
                progress=1.0,
                result={"candidates": [candidate.model_dump() for candidate in candidates]},
            )
        except Exception as error:  # pragma: no cover - surfaced through job API
            self._update(
                job_id,
                status="failed",
                stage="failed",
                message=str(error),
                error={"message": str(error), "traceback": traceback.format_exc()},
                progress=1.0,
            )


inverse_job_manager = InverseJobManager()
