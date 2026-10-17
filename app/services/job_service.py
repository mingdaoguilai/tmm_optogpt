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
from app.schemas.models import DesignRequirements, TargetSpectrum
from app.services.design_service import prepare_design
from app.services.constraint_service import check_structure
from app.services.refinement_service import refine_candidates, ranking


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
        self._executor.submit(self._run, job_id, request.model_copy(deep=True))
        return self.get(job_id)

    def get(self, job_id: str) -> dict:
        with self._lock:
            if job_id not in self._jobs:
                raise KeyError(job_id)
            return dict(self._jobs[job_id])

    def cancel(self, job_id: str) -> dict:
        if self.get(job_id)["status"] in ("completed", "failed", "cancelled"):
            return self.get(job_id)
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
            requirements = request.requirements or DesignRequirements(weight_r=request.reflectance_weight, weight_t=request.transmittance_weight)
            design = prepare_design(request.target, requirements, request.reference_layers)
            vector = target_vector(TargetSpectrum(**design['model_target']))

            def generation_progress(value: float, message: str) -> None:
                self._update(
                    job_id,
                    stage="generation",
                    message=message,
                    progress=0.08 + value * 0.47,
                )

            search = optogpt_service.generate_many(
                vector,
                candidate_count=request.candidate_count,
                top_k=request.top_k,
                temperature=request.temperature,
                max_layers=request.max_layers,
                seed=request.seed,
                sample_count=request.sample_count,
                seed_count=request.seed_count,
                temperatures=request.temperatures,
                top_p=request.top_p,
                include_greedy=request.include_greedy,
                beam_width=request.beam_width,
                length_penalty=request.length_penalty,
                constraints=request.constraints,
                progress=generation_progress,
                cancelled=lambda: self._cancelled(job_id),
            )
            if self._cancelled(job_id):
                self._update(job_id, status="cancelled", stage="cancelled", progress=1.0)
                return
            structures = search["structures"]
            if not structures:
                raise RuntimeError("OptoGPT did not generate a valid candidate")

            candidates = []
            verified_count = 0

            def publish(values):
                values = sorted(values, key=ranking)[:request.candidate_count]
                for rank, value in enumerate(values, 1):
                    value.rank = rank
                self._update(job_id, result={
                    "candidates": [value.model_dump() for value in values],
                    "search_summary": {**search["summary"], "verified_count": verified_count,
                                       "retained_count": len(values)},
                    "search_settings": request.model_dump(exclude={"target"}),
                    "target": request.target.model_dump(), "model_target": design['model_target'],
                    "requirements": requirements.model_dump(), "constraints": request.constraints.model_dump(),
                    "refinement": request.refinement.model_dump(),
                    "reference_layers": [layer.model_dump() for layer in request.reference_layers]})

            for index, structure in enumerate(structures):
                check_structure(structure, request.constraints)
                if self._cancelled(job_id):
                    self._update(job_id, status="cancelled", stage="cancelled", progress=1.0)
                    return
                self._update(
                    job_id,
                    stage="verification",
                    message=f"TMM verification {index + 1} of {len(structures)}",
                    progress=0.55 + (index / len(structures)) * (0.15 if request.refinement.enabled else 0.43),
                )
                candidates.append(
                    evaluate_candidate(
                        structure,
                        request.target,
                        reflectance_weight=request.reflectance_weight,
                        transmittance_weight=request.transmittance_weight,
                        requirements=requirements,
                    )
                )
                candidates[-1].sources = search["provenance"].get(tuple(structure), [])
                verified_count += 1
                publish(candidates)

            if self._cancelled(job_id):
                self._update(job_id, status="cancelled", stage="cancelled", progress=1.0)
                return
            candidates.sort(key=ranking)
            if request.refinement.enabled:
                candidates = refine_candidates(candidates, request.target, requirements,
                    request.constraints, request.refinement, request.seed, request.candidate_count,
                    cancelled=lambda: self._cancelled(job_id),
                    progress=lambda value, message: self._update(job_id, stage="refinement",
                        progress=.70 + .28 * value, message=message), publish=publish)
            candidates = candidates[:request.candidate_count]
            publish(candidates)
            if self._cancelled(job_id):
                self._update(job_id, status="cancelled", stage="cancelled", progress=1.,
                             message="任务已取消，保留已验证结果（包含已完成的精修改善）")
                return
            self._update(
                job_id,
                status="completed",
                stage="completed",
                message=f"已验证 {verified_count} 组 · 保留最优 {len(candidates)} 组",
                progress=1.0,
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
