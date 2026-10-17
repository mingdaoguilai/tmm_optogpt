from __future__ import annotations

from typing import Dict, Iterable

import numpy as np

from app.schemas import SimulationRequest, SimulationResult
from app.services.material_service import material_service
from tmm import inc_tmm


MAX_WAVELENGTH_POINTS = 10_000


def _wavelength_grid(request: SimulationRequest) -> np.ndarray:
    count = int(np.floor(
        (request.wavelength_end_nm - request.wavelength_start_nm)
        / request.wavelength_step_nm
    )) + 1
    if count > MAX_WAVELENGTH_POINTS:
        raise ValueError(f"A simulation may contain at most {MAX_WAVELENGTH_POINTS} wavelength points")
    wavelengths = request.wavelength_start_nm + np.arange(count) * request.wavelength_step_nm
    if wavelengths[-1] < request.wavelength_end_nm - 1e-9:
        wavelengths = np.append(wavelengths, request.wavelength_end_nm)
    return wavelengths


def _simulate_polarization(
    request: SimulationRequest,
    wavelengths_nm: np.ndarray,
    polarization: str,
    nk_cache: dict | None = None,
) -> Dict[str, np.ndarray]:
    material_names = (
        [request.incident_material]
        + [layer.material for layer in request.layers]
        + [request.substrate_material, request.exit_material]
    )
    nk_by_material = nk_cache if nk_cache is not None else {
        material: material_service.refractive_index(material, wavelengths_nm)
        for material in set(material_names)
    }

    thicknesses = (
        [np.inf]
        + [layer.thickness_nm for layer in request.layers]
        + [request.substrate_thickness_nm, np.inf]
    )
    coherence = (
        ["i"]
        + [("c" if layer.coherent else "i") for layer in request.layers]
        + [("c" if request.substrate_coherent else "i"), "i"]
    )

    reflectance = np.empty(len(wavelengths_nm), dtype=float)
    transmittance = np.empty(len(wavelengths_nm), dtype=float)
    angle_rad = np.deg2rad(request.angle_deg)

    for index, wavelength in enumerate(wavelengths_nm):
        n_list = [nk_by_material[material][index] for material in material_names]
        result = inc_tmm(
            polarization,
            n_list,
            thicknesses,
            coherence,
            angle_rad,
            float(wavelength),
        )
        reflectance[index] = float(np.real(result["R"]))
        transmittance[index] = float(np.real(result["T"]))

    return {"R": reflectance, "T": transmittance}


def simulate(request: SimulationRequest) -> SimulationResult:
    wavelengths_nm = _wavelength_grid(request)
    if request.polarization in {"s", "p"}:
        result = _simulate_polarization(request, wavelengths_nm, request.polarization)
    else:
        s_result = _simulate_polarization(request, wavelengths_nm, "s")
        p_result = _simulate_polarization(request, wavelengths_nm, "p")
        result = {
            key: (1 - request.p_ratio) * s_result[key] + request.p_ratio * p_result[key]
            for key in ("R", "T")
        }

    absorptance = 1.0 - result["R"] - result["T"]
    energy_error = np.abs(result["R"] + result["T"] + absorptance - 1.0)
    return SimulationResult(
        wavelengths_nm=wavelengths_nm.tolist(),
        reflectance=result["R"].tolist(),
        transmittance=result["T"].tolist(),
        absorptance=absorptance.tolist(),
        max_energy_error=float(energy_error.max(initial=0.0)),
    )


def interpolate_spectrum(
    source_wavelengths: Iterable[float],
    source_values: Iterable[float],
    target_wavelengths: np.ndarray,
) -> np.ndarray:
    wavelengths = np.asarray(list(source_wavelengths), dtype=float)
    values = np.asarray(list(source_values), dtype=float)
    if len(wavelengths) != len(values) or len(wavelengths) < 2:
        raise ValueError("A target spectrum must contain at least two wavelength/value pairs")
    order = np.argsort(wavelengths)
    if wavelengths[order][0] > target_wavelengths[0] or wavelengths[order][-1] < target_wavelengths[-1]:
        raise ValueError("The target spectrum must cover 400-1100 nm")
    return np.interp(target_wavelengths, wavelengths[order], values[order])
