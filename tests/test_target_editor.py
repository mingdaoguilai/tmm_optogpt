import unittest

from pydantic import ValidationError
from app.schemas.models import InverseJobRequest, ProjectDocument, SimulationRequest, TargetEditorState, TargetSpectrum


class TargetEditorTests(unittest.TestCase):
    def editor(self):
        return TargetEditorState(points={
            'R': [{'wavelength_nm': 400, 'value': 0.1}, {'wavelength_nm': 650.3, 'value': 0.8}, {'wavelength_nm': 1100, 'value': 0.1}],
            'T': [{'wavelength_nm': 400, 'value': 0.9}, {'wavelength_nm': 650.3, 'value': 0.2}, {'wavelength_nm': 1100, 'value': 0.9}],
        }, interpolation='pchip', linked=True, source_label='custom.csv')

    def test_project_roundtrip_preserves_editable_target_and_accepts_legacy(self):
        project = ProjectDocument(simulation=SimulationRequest(), target_editor=self.editor())
        restored = ProjectDocument.model_validate_json(project.model_dump_json())
        self.assertEqual(restored, project)
        self.assertEqual(restored.target_editor.points.R[1].wavelength_nm, 650.3)
        self.assertIsNone(ProjectDocument(schema_version=1, simulation=SimulationRequest()).target_editor)

    def test_nonfinite_and_duplicate_target_wavelengths_rejected(self):
        for waves, r in [([400, 400, 1100], [0, 0, 0]), ([400, float('nan')], [0, 0]), ([400, 1100], [float('nan'), 0])]:
            with self.assertRaises(ValidationError):
                TargetSpectrum(wavelengths_nm=waves, reflectance=r, transmittance=[0] * len(waves))

    def test_passive_conflict_can_be_saved_but_not_generated(self):
        target = TargetSpectrum(wavelengths_nm=[400, 1100], reflectance=[0.8, 0.8], transmittance=[0.5, 0.5])
        ProjectDocument(simulation=SimulationRequest(), target=target)
        with self.assertRaises(ValidationError):
            InverseJobRequest(target=target)

    def test_editor_endpoints_order_and_generator_validation(self):
        original = self.editor().model_dump()
        for bad in [dict(original, generator={'low': 0.9, 'high': 0.5}),
                    dict(original, points={'R': [{'wavelength_nm': 400, 'value': 0}, {'wavelength_nm': 400, 'value': 1}], 'T': original['points']['T']})]:
            with self.assertRaises(ValidationError):
                TargetEditorState.model_validate(bad)


if __name__ == '__main__':
    unittest.main()
