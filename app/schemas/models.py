from __future__ import annotations

from typing import List, Literal, Optional
import math

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
        if any(not math.isfinite(value) or value < 0 or value > 1 for value in spectrum):
            raise ValueError("Spectrum values must be in the range [0, 1]")
        return spectrum

    @model_validator(mode="after")
    def validate_lengths(self) -> "TargetSpectrum":
        if len(self.wavelengths_nm) < 2 or len(self.wavelengths_nm) > 10000:
            raise ValueError("Target must contain between 2 and 10000 points")
        if any(not math.isfinite(x) or x <= 0 or (i > 0 and x <= self.wavelengths_nm[i - 1])
               for i, x in enumerate(self.wavelengths_nm)):
            raise ValueError("Wavelengths must be finite, positive, increasing and unique")
        if (
            len(self.reflectance) != len(self.wavelengths_nm)
            or len(self.transmittance) != len(self.wavelengths_nm)
        ):
            raise ValueError("Wavelength, reflectance, and transmittance lengths must match")
        return self


class ControlPoint(BaseModel):
    wavelength_nm: float = Field(ge=400, le=1100, allow_inf_nan=False)
    value: float = Field(ge=0, le=1, allow_inf_nan=False)


class EditorChannels(BaseModel):
    R: List[ControlPoint] = Field(min_length=2, max_length=2000)
    T: List[ControlPoint] = Field(min_length=2, max_length=2000)

    @model_validator(mode="after")
    def validate_points(self) -> "EditorChannels":
        for points in (self.R, self.T):
            if points[0].wavelength_nm != 400 or points[-1].wavelength_nm != 1100:
                raise ValueError("Editor control points must start at 400 and end at 1100 nm")
            if any(right.wavelength_nm <= left.wavelength_nm for left, right in zip(points, points[1:])):
                raise ValueError("Editor control points must have unique increasing wavelengths")
        return self


class SpectrumGenerator(BaseModel):
    shape: Literal["gaussian", "notch", "bandpass", "edge"] = "gaussian"
    center_nm: float = Field(default=650, ge=400, le=1100, allow_inf_nan=False)
    width_nm: float = Field(default=100, ge=1, le=700, allow_inf_nan=False)
    transition_nm: float = Field(default=15, ge=1, le=200, allow_inf_nan=False)
    low: float = Field(default=0.05, ge=0, le=1, allow_inf_nan=False)
    high: float = Field(default=0.9, ge=0, le=1, allow_inf_nan=False)
    operation: Literal["replace", "overlay"] = "replace"

    @model_validator(mode="after")
    def validate_amplitudes(self) -> "SpectrumGenerator":
        if self.low >= self.high:
            raise ValueError("Generator low amplitude must be less than high amplitude")
        return self


class TargetEditorState(BaseModel):
    schema_version: Literal[1] = 1
    channel: Literal["R", "T"] = "R"
    interpolation: Literal["linear", "pchip"] = "linear"
    linked: bool = False
    points: EditorChannels
    generator: SpectrumGenerator = Field(default_factory=SpectrumGenerator)
    source_label: Optional[str] = None
    source_spectrum: Optional[TargetSpectrum] = None


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
        if any(r + t > 1 + 1e-8 for r, t in zip(self.target.reflectance, self.target.transmittance)):
            raise ValueError("Passive target requires R + T <= 1 at every wavelength")
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
    schema_version: Literal[1, 2] = 2
    name: str = "Untitled project"
    simulation: SimulationRequest
    target: Optional[TargetSpectrum] = None
    target_editor: Optional[TargetEditorState] = None
    candidate_target: Optional[TargetSpectrum] = None
    candidates: List[CandidateResult] = Field(default_factory=list)
