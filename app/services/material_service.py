from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Dict, Iterable, List

import numpy as np
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[2]
NK_DIRECTORY = PROJECT_ROOT / "third_party" / "optogpt" / "optogpt" / "nk"


class MaterialNotFoundError(ValueError):
    pass


class MaterialService:
    def __init__(self, nk_directory: Path = NK_DIRECTORY):
        self.nk_directory = nk_directory

    @lru_cache(maxsize=128)
    def _load(self, material: str) -> tuple[np.ndarray, np.ndarray]:
        if material == "Air":
            return np.array([1.0, 10_000_000.0]), np.array([1.0 + 0j, 1.0 + 0j])

        path = self.nk_directory / f"{material}.csv"
        if not path.is_file():
            raise MaterialNotFoundError(f"Unknown material: {material}")

        frame = pd.read_csv(path).dropna()
        if "nm" in frame.columns:
            wavelengths_nm = frame["nm"].to_numpy(dtype=float)
        elif "wl" in frame.columns:
            wavelengths_nm = frame["wl"].to_numpy(dtype=float)
            if np.nanmax(wavelengths_nm) < 50:
                wavelengths_nm = wavelengths_nm * 1000
        else:
            raise ValueError(f"Material file has no wavelength column: {path.name}")

        order = np.argsort(wavelengths_nm)
        wavelengths_nm = wavelengths_nm[order]
        refractive_index = frame["n"].to_numpy(dtype=float)[order]
        extinction = frame["k"].to_numpy(dtype=float)[order]
        return wavelengths_nm, refractive_index + 1j * extinction

    def refractive_index(self, material: str, wavelengths_nm: Iterable[float]) -> np.ndarray:
        target = np.asarray(list(wavelengths_nm), dtype=float)
        source_wavelengths, source_nk = self._load(material)
        real = np.interp(target, source_wavelengths, source_nk.real)
        imag = np.interp(target, source_wavelengths, source_nk.imag)
        return real + 1j * imag

    def list_materials(self) -> List[Dict[str, object]]:
        materials: List[Dict[str, object]] = [
            {
                "id": "Air",
                "label": "Air",
                "category": "medium",
                "wavelength_min_nm": 1.0,
                "wavelength_max_nm": 10_000_000.0,
            }
        ]
        metals = {"Ag", "Al", "Au", "Cr", "Ni", "Ti"}
        for path in sorted(self.nk_directory.glob("*.csv")):
            material = path.stem
            wavelengths, _ = self._load(material)
            if material.endswith("_HZ"):
                category = "alternate"
            elif material.endswith("_Substrate"):
                category = "substrate"
            elif material in metals:
                category = "metal"
            else:
                category = "dielectric"
            materials.append(
                {
                    "id": material,
                    "label": material.replace("_Substrate", " substrate"),
                    "category": category,
                    "wavelength_min_nm": float(wavelengths.min()),
                    "wavelength_max_nm": float(wavelengths.max()),
                }
            )
        return materials


material_service = MaterialService()
