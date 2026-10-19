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


class SpectralBand(BaseModel):
    channel: Literal["R", "T"] = "T"
    start_nm: float = Field(default=550, ge=400, le=1100, allow_inf_nan=False)
    end_nm: float = Field(default=650, ge=400, le=1100, allow_inf_nan=False)
    kind: Literal["match", "minimum", "maximum", "ignore"] = "match"
    value: float = Field(default=0.9, ge=0, le=1, allow_inf_nan=False)
    weight: float = Field(default=1, ge=0, le=1000, allow_inf_nan=False)
    tolerance: float = Field(default=0.02, ge=0, le=1, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_range(self) -> "SpectralBand":
        if self.end_nm <= self.start_nm:
            raise ValueError("波段终点必须大于起点")
        return self


class DesignRequirements(BaseModel):
    schema_version: Literal[1] = 1
    enabled_r: bool = True
    enabled_t: bool = True
    weight_r: float = Field(default=1, ge=0, le=1000, allow_inf_nan=False)
    weight_t: float = Field(default=1, ge=0, le=1000, allow_inf_nan=False)
    tolerance: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    scope: Literal["full", "bands"] = "full"
    completion: Literal["no_absorption", "reference"] = "no_absorption"
    bands: List[SpectralBand] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_bands(self) -> "DesignRequirements":
        for i, first in enumerate(self.bands):
            for second in self.bands[i + 1:]:
                if (first.channel == second.channel and first.kind != "ignore" and second.kind != "ignore"
                        and max(first.start_nm, second.start_nm) < min(first.end_nm, second.end_nm)):
                    raise ValueError("同一通道的考核波段不能重叠；不关心区间可覆盖考核波段")
        return self


class LayerConstraint(BaseModel):
    index: int = Field(ge=1, le=20)
    material: Optional[str] = None
    thickness_nm: Optional[float] = Field(default=None, gt=0, le=1000000, allow_inf_nan=False)
    min_nm: Optional[float] = Field(default=None, gt=0, le=1000000, allow_inf_nan=False)
    max_nm: Optional[float] = Field(default=None, gt=0, le=1000000, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_rule(self) -> "LayerConstraint":
        if self.material is not None and not self.material.strip():
            raise ValueError("锁定材料不能为空")
        if all(v is None for v in (self.material, self.thickness_nm, self.min_nm, self.max_nm)):
            raise ValueError("逐层约束至少需要材料、厚度或边界之一")
        return self


class ManufacturingConstraints(BaseModel):
    min_thickness_nm: float = Field(default=10, gt=0, le=1000000, allow_inf_nan=False)
    max_thickness_nm: float = Field(default=500, gt=0, le=1000000, allow_inf_nan=False)
    layers: List[LayerConstraint] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_bounds(self) -> "ManufacturingConstraints":
        if self.min_thickness_nm > self.max_thickness_nm:
            raise ValueError("最小厚度不能大于最大厚度")
        if len({layer.index for layer in self.layers}) != len(self.layers):
            raise ValueError("同一层只能有一条逐层约束")
        for layer in self.layers:
            low = max(self.min_thickness_nm, layer.min_nm or self.min_thickness_nm)
            high = min(self.max_thickness_nm, layer.max_nm or self.max_thickness_nm)
            if low > high or (layer.thickness_nm is not None and not low <= layer.thickness_nm <= high):
                raise ValueError(f"第 {layer.index} 层的厚度或边界与全局范围冲突")
        return self


class DesignPreviewRequest(BaseModel):
    target: TargetSpectrum
    requirements: DesignRequirements = Field(default_factory=DesignRequirements)
    constraints: ManufacturingConstraints = Field(default_factory=ManufacturingConstraints)
    reference_layers: List[Layer] = Field(default_factory=list, max_length=20)
    max_layers: int = Field(default=20, ge=1, le=20)

    @model_validator(mode="after")
    def validate_layers(self) -> "DesignPreviewRequest":
        if any(rule.index > self.max_layers for rule in self.constraints.layers):
            raise ValueError("逐层约束编号不能超过最大层数")
        return self


class RefinementSettings(BaseModel):
    enabled: bool = False
    candidate_count: int = Field(default=5, ge=1, le=10)
    starts: int = Field(default=2, ge=1, le=8)
    max_evaluations: int = Field(default=160, ge=20, le=2000)
    time_budget_s: float = Field(default=180, ge=1, le=3600, allow_inf_nan=False)
    perturbation: float = Field(default=0.1, ge=0, le=0.5, allow_inf_nan=False)
    optimization_step_nm: Literal[2, 5] = 5
    verification_step_nm: Literal[1, 2] = 2
    loss: Literal["linear", "huber"] = "linear"


class InverseJobRequest(BaseModel):
    target: TargetSpectrum
    refinement: RefinementSettings = Field(default_factory=RefinementSettings)
    requirements: Optional[DesignRequirements] = None
    constraints: ManufacturingConstraints = Field(default_factory=ManufacturingConstraints)
    reference_layers: List[Layer] = Field(default_factory=list, max_length=20)
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
    reflectance_weight: float = Field(default=1.0, ge=0, allow_inf_nan=False)
    transmittance_weight: float = Field(default=1.0, ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_search(self) -> "InverseJobRequest":
        if self.requirements is None and any(r + t > 1 + 1e-8 for r, t in zip(self.target.reflectance, self.target.transmittance)):
            raise ValueError("Passive target requires R + T <= 1 at every wavelength")
        if any(rule.index > self.max_layers for rule in self.constraints.layers):
            raise ValueError("逐层约束编号不能超过最大层数")
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
    refinement: Optional[dict] = None
    rank: int = 0
    sources: List[str] = Field(default_factory=list)
    tokens: List[str]
    layers: List[Layer]
    mae_r: float
    mae_t: float
    max_error: float
    score: float
    requirement_score: Optional[float] = None
    weighted_mae: Optional[float] = None
    max_violation: Optional[float] = None
    max_deviation: Optional[float] = None
    pass_rate: Optional[float] = None
    band_metrics: List[dict] = Field(default_factory=list)
    layer_count: int
    total_thickness_nm: float
    simulation: SimulationResult


class CandidateDesignSnapshot(BaseModel):
    model_config = {"protected_namespaces": ()}
    model_target: TargetSpectrum
    requirements: DesignRequirements
    constraints: ManufacturingConstraints
    refinement: RefinementSettings = Field(default_factory=RefinementSettings)
    reference_layers: List[Layer] = Field(default_factory=list)
    search_settings: Optional[dict] = None
    search_summary: Optional[dict] = None
    job_id: Optional[str] = None
    job_status: Optional[str] = None


class CandidateReviewRequest(BaseModel):
    candidate: CandidateResult
    target: TargetSpectrum
    requirements: DesignRequirements = Field(default_factory=DesignRequirements)


class CandidateVerificationRequest(BaseModel):
    simulation: SimulationRequest
    target: TargetSpectrum
    requirements: DesignRequirements
    evaluation_wavelengths_nm: List[float] = Field(min_length=2, max_length=12000)

    @field_validator("evaluation_wavelengths_nm")
    @classmethod
    def validate_grid(cls, grid):
        if (grid[0] != 400 or grid[-1] != 1100 or any(
                not math.isfinite(x) or x < 400 or x > 1100 or (i and x <= grid[i - 1])
                for i, x in enumerate(grid))):
            raise ValueError("复核网格必须为400–1100 nm之间递增且唯一的有限波长，并包含两个端点")
        return grid


class CandidateVerificationResult(CandidateVerificationRequest):
    result: SimulationResult
    metrics: dict

    @model_validator(mode="after")
    def validate_result_grid(self):
        if self.result.wavelengths_nm != self.evaluation_wavelengths_nm or any(
                len(values) != len(self.evaluation_wavelengths_nm) or not all(math.isfinite(v) for v in values)
                for values in (self.result.reflectance, self.result.transmittance, self.result.absorptance)):
            raise ValueError("复核结果的光谱与考核网格不匹配")
        return self


class AdoptedCandidate(BaseModel):
    variant: Literal["initial", "current"] = "current"
    candidate: CandidateResult
    target: TargetSpectrum
    requirements: DesignRequirements
    conditions: SimulationRequest

    @model_validator(mode="after")
    def validate_adopted_layers(self):
        if self.conditions.layers != self.candidate.layers:
            raise ValueError("采用快照的计算膜层必须与所选候选实际厚度一致")
        return self


class ProjectDocument(BaseModel):
    schema_version: Literal[1, 2, 3, 4] = 4
    name: str = "Untitled project"
    simulation: SimulationRequest
    target: Optional[TargetSpectrum] = None
    target_editor: Optional[TargetEditorState] = None
    design_requirements: DesignRequirements = Field(default_factory=DesignRequirements)
    manufacturing_constraints: ManufacturingConstraints = Field(default_factory=ManufacturingConstraints)
    refinement_settings: RefinementSettings = Field(default_factory=RefinementSettings)
    candidate_requirements: Optional[DesignRequirements] = None
    candidate_design_snapshot: Optional[CandidateDesignSnapshot] = None
    candidate_target: Optional[TargetSpectrum] = None
    candidates: List[CandidateResult] = Field(default_factory=list)
    adopted_candidate: Optional[AdoptedCandidate] = None
    forward_verification: Optional[CandidateVerificationResult] = None
