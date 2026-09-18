from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.schemas import InverseJobRequest, ProjectDocument, SimulationRequest
from app.services.job_service import inverse_job_manager
from app.services.material_service import MaterialNotFoundError, material_service
from app.services.optogpt_service import optogpt_service
from app.services.tmm_service import simulate


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"

app = FastAPI(
    title="TMM + OptoGPT Workbench",
    version="0.1.0",
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


@app.post("/api/inverse/jobs", status_code=202)
def create_inverse_job(request: InverseJobRequest) -> dict:
    if not optogpt_service.model_path.is_file():
        raise HTTPException(
            status_code=503,
            detail=f"OptoGPT checkpoint not found at {optogpt_service.model_path}",
        )
    try:
        target_vector = request.target
        if len(target_vector.wavelengths_nm) < 2:
            raise ValueError("Target spectrum must contain at least two points")
        return inverse_job_manager.create(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


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


if FRONTEND_DIST.is_dir():
    assets = FRONTEND_DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}")
    def serve_frontend(full_path: str):
        requested = FRONTEND_DIST / full_path
        if full_path and requested.is_file():
            return FileResponse(requested)
        return FileResponse(FRONTEND_DIST / "index.html")
