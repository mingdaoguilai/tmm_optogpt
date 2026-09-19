from __future__ import annotations

import unittest

import numpy as np

from app.schemas import Layer, SimulationRequest, TargetSpectrum
from app.services.evaluation_service import normalize_target, parse_candidate
from app.services.material_service import material_service
from app.services.tmm_service import simulate


class MaterialServiceTests(unittest.TestCase):
    def test_detail_matches_calculation_at_sample_points(self):
        detail = material_service.detail('SiO2')
        result = material_service.refractive_index('SiO2', detail['wavelengths_nm'])
        np.testing.assert_allclose(result.real, detail['n'])
        np.testing.assert_allclose(result.imag, detail['k'])

    def test_out_of_range_is_rejected(self):
        with self.assertRaises(ValueError):
            material_service.refractive_index('SiO2', [0.1])

    def test_path_traversal_is_rejected(self):
        with self.assertRaises(ValueError):
            material_service.detail('../SiO2')

    def test_material_interpolation(self):
        values = material_service.refractive_index("SiO2", [400, 550, 1100])
        self.assertEqual(values.shape, (3,))
        self.assertTrue(np.all(values.real > 1))


class TmmServiceTests(unittest.TestCase):
    def test_simulation_returns_energy_balanced_spectrum(self):
        result = simulate(
            SimulationRequest(
                layers=[Layer(material="SiO2", thickness_nm=100)],
                wavelength_start_nm=400,
                wavelength_end_nm=500,
                wavelength_step_nm=10,
            )
        )
        self.assertEqual(len(result.wavelengths_nm), 11)
        for reflection, transmission, absorption in zip(
            result.reflectance, result.transmittance, result.absorptance
        ):
            self.assertAlmostEqual(reflection + transmission + absorption, 1.0, places=9)


class EvaluationTests(unittest.TestCase):
    def test_candidate_tokens_are_parsed_from_right(self):
        layers = parse_candidate(["SiO2_120", "Glass_Substrate_500"])
        self.assertEqual(layers[1].material, "Glass_Substrate")
        self.assertEqual(layers[1].thickness_nm, 500)

    def test_target_is_interpolated_to_optogpt_grid(self):
        target = TargetSpectrum(
            wavelengths_nm=[400, 750, 1100],
            reflectance=[0, 1, 0],
            transmittance=[1, 0, 1],
        )
        reflection, transmission = normalize_target(target)
        self.assertEqual(len(reflection), 71)
        self.assertEqual(len(transmission), 71)


if __name__ == "__main__":
    unittest.main()
