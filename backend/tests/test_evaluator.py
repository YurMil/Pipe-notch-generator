from __future__ import annotations

import math
import unittest

from app.cad.evaluator import evaluate_step_export
from app.cad.step.assembly_writer import export_step_assembly
from app.models.request_models import StepExportRequestModel


class StepEvaluatorTests(unittest.TestCase):
    def test_builds_assembly_definition_for_default_set_on_case(self) -> None:
        request = StepExportRequestModel.model_validate(
            {
                "version": 1,
                "project": {
                    "main": {"od": 100, "wall": 3},
                    "branch": {"od": 50, "wall": 2},
                    "connection": {
                        "type": "set_on",
                        "axisAngleDeg": 45,
                        "offset": 0,
                        "weldingGap": 0,
                        "seamAngleDeg": 0,
                        "penetrationMode": "by_rule",
                        "penetrationDepth": 3,
                        "useOuterBranchContour": True,
                    },
                },
                "exportOptions": {
                    "mode": "assembly",
                    "units": "mm",
                    "includeMain": True,
                    "includeBranch": True,
                    "includeFusedBody": False,
                },
            }
        )

        definition = evaluate_step_export(request)

        self.assertEqual(definition.assembly_name, "PipeNotchAssembly")
        self.assertEqual(definition.main.name, "MainPipe")
        self.assertEqual(definition.branch.name, "BranchPipe")
        self.assertEqual(definition.filename, "pipe_notch_set_on_50x2_on_100x3_45deg_assembly.step")

    def test_main_opening_tool_does_not_pierce_back_wall(self) -> None:
        request = StepExportRequestModel.model_validate(
            {
                "version": 1,
                "project": {
                    "main": {"od": 100, "wall": 3},
                    "branch": {"od": 50, "wall": 2},
                    "connection": {
                        "type": "set_on",
                        "axisAngleDeg": 90,
                        "offset": 0,
                        "weldingGap": 0,
                        "seamAngleDeg": 0,
                        "penetrationMode": "by_rule",
                        "penetrationDepth": 3,
                        "useOuterBranchContour": True,
                    },
                },
                "exportOptions": {
                    "mode": "assembly",
                    "units": "mm",
                    "includeMain": True,
                    "includeBranch": True,
                    "includeFusedBody": False,
                },
            }
        )

        definition = evaluate_step_export(request)

        opening = definition.main.opening_subtract
        self.assertIsNotNone(opening)
        # The opening tool must not extend through the far (back) wall of the
        # main pipe — its axial start, measured along the branch axis from the
        # opening frame origin, has to stay above -main_outer_radius.
        main_outer_radius = 100 / 2.0
        self.assertGreater(opening.axial_range.start, -main_outer_radius + 1.0)
        self.assertGreater(opening.axial_range.end, opening.axial_range.start + 1.0)

    def test_exports_equal_diameter_perpendicular_set_on_step(self) -> None:
        request = StepExportRequestModel.model_validate(
            {
                "version": 1,
                "project": {
                    "main": {"od": 100, "wall": 3},
                    "branch": {"od": 100, "wall": 3},
                    "connection": {
                        "type": "set_on",
                        "axisAngleDeg": 90,
                        "offset": 0,
                        "weldingGap": 0,
                        "seamAngleDeg": 0,
                        "penetrationMode": "by_rule",
                        "penetrationDepth": 3,
                        "useOuterBranchContour": True,
                    },
                },
                "exportOptions": {
                    "mode": "assembly",
                    "units": "mm",
                    "includeMain": True,
                    "includeBranch": True,
                    "includeFusedBody": False,
                },
            }
        )

        definition = evaluate_step_export(request)
        step_bytes = export_step_assembly(
            definition,
            axis_angle_rad=math.radians(request.project.connection.axisAngleDeg),
        )

        self.assertGreater(len(step_bytes), 1024)
        self.assertIn(b"ISO-10303-21", step_bytes)
        self.assertIn(b"BranchPipe", step_bytes)
        self.assertGreaterEqual(step_bytes.count(b"MANIFOLD_SOLID_BREP"), 2)
        self.assertNotIn(b"SHELL_BASED_SURFACE_MODEL", step_bytes)

    def test_exports_equal_diameter_perpendicular_set_on_step_with_gap(self) -> None:
        request = StepExportRequestModel.model_validate(
            {
                "version": 1,
                "project": {
                    "main": {"od": 100, "wall": 3},
                    "branch": {"od": 100, "wall": 3},
                    "connection": {
                        "type": "set_on",
                        "axisAngleDeg": 90,
                        "offset": 0,
                        "weldingGap": 50,
                        "seamAngleDeg": 0,
                        "penetrationMode": "by_rule",
                        "penetrationDepth": 3,
                        "useOuterBranchContour": True,
                    },
                },
                "exportOptions": {
                    "mode": "assembly",
                    "units": "mm",
                    "includeMain": True,
                    "includeBranch": True,
                    "includeFusedBody": False,
                },
            }
        )

        definition = evaluate_step_export(request)
        step_bytes = export_step_assembly(
            definition,
            axis_angle_rad=math.radians(request.project.connection.axisAngleDeg),
        )

        self.assertGreater(len(step_bytes), 1024)
        self.assertIn(b"ISO-10303-21", step_bytes)
        self.assertIn(b"BranchPipe", step_bytes)
        self.assertGreaterEqual(step_bytes.count(b"MANIFOLD_SOLID_BREP"), 2)
        self.assertNotIn(b"SHELL_BASED_SURFACE_MODEL", step_bytes)

    def test_exports_equal_diameter_perpendicular_set_on_step_with_branch_id_reference(self) -> None:
        request = StepExportRequestModel.model_validate(
            {
                "version": 1,
                "project": {
                    "main": {"od": 100, "wall": 3},
                    "branch": {"od": 100, "wall": 3},
                    "connection": {
                        "type": "set_on",
                        "axisAngleDeg": 90,
                        "offset": 0,
                        "weldingGap": 5,
                        "seamAngleDeg": 0,
                        "penetrationMode": "by_rule",
                        "penetrationDepth": 3,
                        "useOuterBranchContour": False,
                    },
                },
                "exportOptions": {
                    "mode": "assembly",
                    "units": "mm",
                    "includeMain": True,
                    "includeBranch": True,
                    "includeFusedBody": False,
                },
            }
        )

        definition = evaluate_step_export(request)
        step_bytes = export_step_assembly(
            definition,
            axis_angle_rad=math.radians(request.project.connection.axisAngleDeg),
        )

        self.assertGreater(len(step_bytes), 1024)
        self.assertIn(b"ISO-10303-21", step_bytes)
        self.assertIn(b"BranchPipe", step_bytes)
        self.assertGreaterEqual(step_bytes.count(b"MANIFOLD_SOLID_BREP"), 2)
        self.assertNotIn(b"SHELL_BASED_SURFACE_MODEL", step_bytes)


if __name__ == "__main__":
    unittest.main()
