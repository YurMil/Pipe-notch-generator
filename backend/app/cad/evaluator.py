from __future__ import annotations

import math

from ..models.request_models import StepExportRequestModel
from ..models.response_models import StepExportException
from .builders.cylinders import resolve_single_ended_stock_start
from .builders.frames import create_frame, scale_vec3, add_vec3, vec3
from .dto import (
    AxialRange,
    EvaluatedAssemblyDefinition,
    EvaluatedOpeningSubtract,
    EvaluatedPipeBody,
    EvaluatedPlaneTrim,
    EvaluatedReceiverNotchTrim,
)
from .step.naming import ASSEMBLY_NAME, BRANCH_PART_NAME, MAIN_PART_NAME, build_step_filename


def _inner_diameter(od: float, wall: float) -> float:
    return od - (wall * 2.0)


def _resolved_penetration(request: StepExportRequestModel, main_wall: float) -> float:
    if request.project.connection.type != "set_in":
        return 0.0

    if request.project.connection.penetrationMode == "by_rule":
        return main_wall

    return request.project.connection.penetrationDepth


def _selected_branch_radius(branch_od: float, branch_id: float, use_outer: bool) -> float:
    return (branch_od / 2.0) if use_outer else (branch_id / 2.0)


def _receiver_radius(main_od: float, main_id: float, connection_type: str) -> float:
    return (main_id / 2.0) if connection_type == "set_in" else (main_od / 2.0)


def _main_stock_length(main_od: float, branch_od: float) -> float:
    return max(main_od * 3.0, branch_od * 2.0 + 200.0)


def _branch_axial_range(main_od: float, branch_od: float, resolved_penetration: float) -> AxialRange:
    return AxialRange(
        start=-(branch_od * 0.75),
        end=max(main_od + (main_od * 1.5) + 100.0 - resolved_penetration, branch_od * 2.5),
    )


def evaluate_step_export(request: StepExportRequestModel) -> EvaluatedAssemblyDefinition:
    main_od = request.project.main.od
    main_wall = request.project.main.wall
    branch_od = request.project.branch.od
    branch_wall = request.project.branch.wall
    main_id = _inner_diameter(main_od, main_wall)
    branch_id = _inner_diameter(branch_od, branch_wall)

    if main_id <= 0 or branch_id <= 0:
        raise StepExportException(
            "invalid_dimensions",
            "Pipe wall thickness leaves a non-positive inner diameter.",
        )

    axis_angle_deg = request.project.connection.axisAngleDeg
    if axis_angle_deg < 1 or axis_angle_deg > 90:
        raise StepExportException(
            "invalid_angle",
            "Axis angle must stay between 1 and 90 degrees.",
        )

    resolved_penetration = _resolved_penetration(request, main_wall)
    selected_branch_radius = _selected_branch_radius(
        branch_od,
        branch_id,
        request.project.connection.useOuterBranchContour,
    )
    receiver_radius = _receiver_radius(
        main_od,
        main_id,
        request.project.connection.type,
    )
    max_offset = max(0.0, receiver_radius - max(selected_branch_radius, 0.0))

    if abs(request.project.connection.offset) > max_offset + 1e-6:
        raise StepExportException(
            "invalid_offset",
            f"Center offset exceeds the valid range of +/- {max_offset:.2f} mm.",
        )

    if request.project.connection.type == "set_in" and resolved_penetration < 0:
        raise StepExportException(
            "invalid_penetration",
            "Penetration depth cannot be negative.",
        )

    axis_angle_rad = math.radians(axis_angle_deg)
    main_frame = create_frame(vec3(0.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0))
    branch_frame = create_frame(
        vec3(0.0, 0.0, request.project.connection.offset),
        vec3(math.sin(axis_angle_rad), math.cos(axis_angle_rad), 0.0),
    )

    main_length = _main_stock_length(main_od, branch_od)
    main_range = AxialRange(start=-(main_length / 2.0), end=main_length / 2.0)
    branch_range = _branch_axial_range(main_od, branch_od, resolved_penetration)
    opening_frame = create_frame(
        add_vec3(branch_frame.origin, scale_vec3(branch_frame.axis, -resolved_penetration)),
        branch_frame.axis,
    )

    warnings: list[str] = []
    if main_wall < 1:
        warnings.append("Main pipe wall is very thin.")
    if branch_wall < 1:
        warnings.append("Branch pipe wall is very thin.")
    if request.project.connection.weldingGap < 0.5:
        warnings.append("Welding gap is small; fit-up may be tight.")

    branch_contour_surface = (
        "branch-outer" if request.project.connection.useOuterBranchContour else "branch-inner"
    )
    receiver_surface = "main-inner" if request.project.connection.type == "set_in" else "main-outer"
    branch_contour_radius = (branch_od / 2.0) if request.project.connection.useOuterBranchContour else (branch_id / 2.0)
    opening_tool_radius = max(branch_contour_radius, 0.1)

    opening_start = resolve_single_ended_stock_start(
        receiver_radius=main_od / 2.0,
        branch_radius=opening_tool_radius,
        offset=request.project.connection.offset,
        axis_angle_rad=axis_angle_rad,
        axial_shift=resolved_penetration,
        error_part_name=MAIN_PART_NAME,
    )

    if not (branch_range.end > opening_start + 1.0):
        raise StepExportException(
            "invalid_dimensions",
            "Geometry Error: Opening tool range is too short after receiver trim.",
            details={"part": MAIN_PART_NAME},
        )

    main = EvaluatedPipeBody(
        name=MAIN_PART_NAME,
        outer_diameter=main_od,
        inner_diameter=main_id,
        frame=main_frame,
        axial_range=main_range,
        plane_trims=[
            EvaluatedPlaneTrim(
                id="trim-main-top",
                label="Main Top Cap",
                keep_side="less",
                offset=main_range.end,
            ),
            EvaluatedPlaneTrim(
                id="trim-main-bottom",
                label="Main Bottom Cap",
                keep_side="greater",
                offset=main_range.start,
            ),
        ],
        opening_subtract=EvaluatedOpeningSubtract(
            radius=opening_tool_radius,
            frame=opening_frame,
            axial_range=AxialRange(start=opening_start, end=branch_range.end),
        ),
    )

    branch = EvaluatedPipeBody(
        name=BRANCH_PART_NAME,
        outer_diameter=branch_od,
        inner_diameter=branch_id,
        frame=branch_frame,
        axial_range=branch_range,
        plane_trims=[
            EvaluatedPlaneTrim(
                id="trim-branch-end",
                label="Branch Far End",
                keep_side="less",
                offset=branch_range.end,
            ),
        ],
        receiver_notch=EvaluatedReceiverNotchTrim(
            receiver_surface=receiver_surface,
            branch_contour_surface=branch_contour_surface,
            receiver_radius=receiver_radius,
            trim_contour_radius=branch_contour_radius,
            branch_outer_radius=branch_od / 2.0,
            branch_inner_radius=branch_id / 2.0,
            offset=request.project.connection.offset,
            welding_gap=request.project.connection.weldingGap,
            penetration_depth=resolved_penetration,
            far_end_axial=branch_range.end,
        ),
    )

    return EvaluatedAssemblyDefinition(
        units="mm",
        assembly_name=ASSEMBLY_NAME,
        filename=build_step_filename(
            connection_type=request.project.connection.type,
            branch_od=branch_od,
            branch_wall=branch_wall,
            main_od=main_od,
            main_wall=main_wall,
            axis_angle_deg=axis_angle_deg,
        ),
        main=main,
        branch=branch,
        include_fused_body=request.exportOptions.includeFusedBody,
        warnings=warnings,
    )
