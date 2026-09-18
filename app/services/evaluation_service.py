from __future__ import annotations

from typing import Iterable, List

import numpy as np

from app.schemas import CandidateResult, Layer, SimulationRequest, TargetSpectrum
from app.services.tmm_service import interpolate_spectrum, simulate


OPTOGPT_WAVELENGTHS = np.arange(400.0, 1101.0, 10.0)


def parse_candidate(tokens: Iterable[str]) -> List[Layer]:
    layers: List[Layer] = []
    for token in tokens:
        try:
            material, thickness = token.rsplit("_", 1)
            layers.append(Layer(material=material, thickness_nm=float(thickness), coherent=True))
        except (ValueError, TypeError) as error:
            raise ValueError(f"Invalid OptoGPT structure token: {token}") from error
    if not layers:
        raise ValueError("OptoGPT returned an empty structure")
    return layers


def normalize_target(target: TargetSpectrum) -> tuple[np.ndarray, np.ndarray]:
    target_r = interpolate_spectrum(
        target.wavelengths_nm, target.reflectance, OPTOGPT_WAVELENGTHS
    )
    target_t = interpolate_spectrum(
        target.wavelengths_nm, target.transmittance, OPTOGPT_WAVELENGTHS
    )
    return target_r, target_t


def target_vector(target: TargetSpectrum) -> np.ndarray:
    target_r, target_t = normalize_target(target)
    return np.concatenate([target_r, target_t]).astype(np.float32)


def evaluate_candidate(
    tokens: List[str],
    target: TargetSpectrum,
    reflectance_weight: float = 1.0,
    transmittance_weight: float = 1.0,
) -> CandidateResult:
    layers = parse_candidate(tokens)
    simulation = simulate(
        SimulationRequest(
            layers=layers,
            wavelength_start_nm=400,
            wavelength_end_nm=1100,
            wavelength_step_nm=10,
            angle_deg=0,
            polarization="s",
            substrate_material="Glass_Substrate",
            substrate_thickness_nm=500_000,
            substrate_coherent=False,
        )
    )
    target_r, target_t = normalize_target(target)
    result_r = np.asarray(simulation.reflectance)
    result_t = np.asarray(simulation.transmittance)
    error_r = np.abs(result_r - target_r)
    error_t = np.abs(result_t - target_t)
    mae_r = float(error_r.mean())
    mae_t = float(error_t.mean())
    total_thickness = float(sum(layer.thickness_nm for layer in layers))

    weight_sum = reflectance_weight + transmittance_weight
    if weight_sum <= 0:
        weight_sum = 1.0
    spectral_score = (
        reflectance_weight * mae_r + transmittance_weight * mae_t
    ) / weight_sum
    complexity_penalty = len(layers) * 0.00015 + total_thickness * 0.0000001

    return CandidateResult(
        tokens=tokens,
        layers=layers,
        mae_r=mae_r,
        mae_t=mae_t,
        max_error=float(max(error_r.max(), error_t.max())),
        score=float(spectral_score + complexity_penalty),
        layer_count=len(layers),
        total_thickness_nm=total_thickness,
        simulation=simulation,
    )
