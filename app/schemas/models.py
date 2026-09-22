from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class Layer(BaseModel):
    material: str
    thickness_nm: float = Field(gt=0, le=1_000_000)
    coherent: bool = True


class SimulationRequest(BaseModel):
    incident_material: str = "Air"
    exit_material: str = "Air"
    substrate_material: str = "Glass_Substrate"
    substrate_thickness_nm: float = Field(default=500_000, gt=0)
    substrate_coherent: bool = False
    layers: List[Layer] = Field(default_factory=list)
    wavelength_start_nm: float = Field(default=400, gt=0)
    wavelength_end_nm: float = Field(default=1100, gt=0)
    wavelength_step_nm: float = Field(default=10, gt=0)
    angle_deg: float = Field(default=0, ge=0, lt=90)
    polarization: Literal["s", "p", "unpolarized"] = "unpolarized"
    p_ratio: float = Field(default=0.5, ge=0, le=1)

    @model_validator(mode="after")
    def validate_range(self) -> "SimulationRequest":
        if self.wavelength_end_nm <= self.wavelength_start_nm:
            raise ValueError("wavelength_end_nm must be greater than wavelength_start_nm")
        return self


class SimulationResult(BaseModel):
    wavelengths_nm: List[float]
    reflectance: List[float]
    transmittance: List[float]
    absorptance: List[float]
    max_energy_error: float


class TargetSpectrum(BaseModel):
    wavelengths_nm: List[float]
    reflectance: List[float]
    transmittance: List[float]

    @field_validator("reflectance", "transmittance")
    @classmethod
    def validate_unit_interval(cls, spectrum: List[float]) -> List[float]:
        if any(value < 0 or value > 1 for value in spectrum):
            raise ValueError("Spectrum values must be in the range [0, 1]")
        return spectrum

    @model_validator(mode="after")
    def validate_lengths(self) -> "TargetSpectrum":
        if (
            len(self.reflectance) != len(self.wavelengths_nm)
            or len(self.transmittance) != len(self.wavelengths_nm)
        ):
            raise ValueError("Wavelength, reflectance, and transmittance lengths must match")
        return self


class InverseJobRequest(BaseModel):
    target: TargetSpectrum
    candidate_count: int = Field(default=20, ge=1, le=100)
    max_layers: int = Field(default=20, ge=1, le=20)
    top_k: int = Field(default=10, ge=1, le=1000)
    top_p: float = Field(default=0.85, gt=0, le=1)
    sample_count: int = Field(default=300, ge=1, le=1000)
    seed_count: int = Field(default=4, ge=1, le=8)
    temperatures: Optional[List[float]] = None
    include_greedy: bool = True
    beam_width: int = Field(default=5, ge=0, le=20)
    length_penalty: float = Field(default=0.6, ge=0, le=2)
    temperature: float = Field(default=1.0, gt=0, le=5)
    seed: int = Field(default=42, ge=0, le=2**32 - 1)
    reflectance_weight: float = Field(default=1.0, ge=0)
    transmittance_weight: float = Field(default=1.0, ge=0)

    @model_validator(mode="after")
    def validate_search(self) -> "InverseJobRequest":
        # Legacy clients can still supply a single temperature.
        if self.temperatures is None:
            self.temperatures = ([self.temperature] if "temperature" in self.model_fields_set
                                 else [0.7, 0.85, 1.0])
        if not 1 <= len(self.temperatures) <= 5 or any(
            not 0.1 <= value <= 5 for value in self.temperatures
        ):
            raise ValueError("Provide 1-5 finite temperatures between 0.1 and 5")
        if self.reflectance_weight + self.transmittance_weight <= 0:
            raise ValueError("At least one spectrum weight must be positive")
        if self.sample_count < self.seed_count * len(self.temperatures):
            raise ValueError("Sampling budget must cover every seed/temperature combination")
        return self


class CandidateResult(BaseModel):
    rank: int = 0
    sources: List[str] = Field(default_factory=list)
    tokens: List[str]
    layers: List[Layer]
    mae_r: float
    mae_t: float
    max_error: float
    score: float
    layer_count: int
    total_thickness_nm: float
    simulation: SimulationResult


class ProjectDocument(BaseModel):
    schema_version: int = 1
    name: str = "Untitled project"
    simulation: SimulationRequest
    target: Optional[TargetSpectrum] = None
    candidate_target: Optional[TargetSpectrum] = None
    candidates: List[CandidateResult] = Field(default_factory=list)
