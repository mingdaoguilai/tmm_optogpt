from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import WORKBENCH_VERSION

from app.schemas import InverseJobRequest, ProjectDocument, SimulationRequest
from app.services.job_service import inverse_job_manager
from app.services.material_service import MaterialNotFoundError, material_service
from app.services.optogpt_service import optogpt_service
from app.services.tmm_service import simulate
from app.schemas.models import DesignPreviewRequest, CandidateReviewRequest, CandidateVerificationRequest
from app.services.workflow_service import review_candidate, verify_candidate
from app.services.design_service import prepare_design
from app.services.constraint_service import compile_token_masks


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"

app = FastAPI(
    title="TMM + OptoGPT Workbench",
    version=WORKBENCH_VERSION,
    description="Local-first multilayer thin-film simulation and inverse design API.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "application": "TMM + OptoGPT Workbench",
        "version": WORKBENCH_VERSION,
        "project_root": str(PROJECT_ROOT),
        "optogpt": optogpt_service.status(),
    }


@app.get("/api/materials")
def materials() -> dict:
    return {"materials": material_service.list_materials()}


@app.post("/api/simulate")
def run_simulation(request: SimulationRequest) -> dict:
    try:
        return simulate(request).model_dump()
    except (ValueError, MaterialNotFoundError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get('/api/materials/{material}')
def material_detail(material: str) -> dict:
    try:
        return material_service.detail(material)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/inverse/jobs", status_code=202)
def create_inverse_job(request: InverseJobRequest) -> dict:
    if not optogpt_service.model_path.is_file():
        raise HTTPException(
            status_code=503,
            detail=f"OptoGPT checkpoint not found at {optogpt_service.model_path}",
        )
    try:
        if request.requirements is not None:
            prepare_design(request.target, request.requirements, request.reference_layers)
        if optogpt_service.loaded:
            compile_token_masks(optogpt_service.word_to_id, request.constraints, request.max_layers, optogpt_service.device)
        target_vector = request.target
        if len(target_vector.wavelengths_nm) < 2:
            raise ValueError("Target spectrum must contain at least two points")
        return inverse_job_manager.create(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/api/inverse/preview")
def preview_design(request: DesignPreviewRequest) -> dict:
    try:
        result = prepare_design(request.target, request.requirements, request.reference_layers)
        if optogpt_service.loaded:
            compile_token_masks(optogpt_service.word_to_id, request.constraints, request.max_layers, optogpt_service.device)
        return {**result, "constraints_checked": optogpt_service.loaded}
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/api/inverse/capabilities")
def inverse_capabilities() -> dict:
    try:
        return optogpt_service.capabilities()
    except (ValueError, FileNotFoundError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/inverse/jobs/{job_id}")
def get_inverse_job(job_id: str) -> dict:
    try:
        return inverse_job_manager.get(job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Inverse-design job not found") from error


@app.delete("/api/inverse/jobs/{job_id}")
def cancel_inverse_job(job_id: str) -> dict:
    try:
        return inverse_job_manager.cancel(job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Inverse-design job not found") from error


@app.post("/api/projects/validate")
def validate_project(project: ProjectDocument) -> dict:
    return {"valid": True, "project": project.model_dump()}


@app.post("/api/candidates/review")
def review_saved_candidate(request: CandidateReviewRequest) -> dict:
    try:
        return review_candidate(request)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/api/candidates/verify")
def verify_adopted_candidate(request: CandidateVerificationRequest) -> dict:
    try:
        return verify_candidate(request).model_dump()
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


if FRONTEND_DIST.is_dir():
    assets = FRONTEND_DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}")
    def serve_frontend(full_path: str):
        requested = (FRONTEND_DIST / full_path).resolve()
        if FRONTEND_DIST.resolve() not in requested.parents:
            return FileResponse(FRONTEND_DIST / 'index.html')
        if full_path and requested.is_file():
            return FileResponse(requested)
        return FileResponse(FRONTEND_DIST / "index.html")
