from __future__ import annotations

import math

from ...models.response_models import StepExportException
from ..dto import AxialRange, EvaluatedPipeBody, Frame3D
from .booleans import subtract_shape
from .frames import create_frame, point_along_axis, scale_vec3, sub_vec3, to_tuple, vec3
from .trims import safe_small, sample_branch_notch_curve


def load_cadquery():
    try:
        import cadquery as cq  # type: ignore
    except ModuleNotFoundError as exc:  # pragma: no cover - depends on local runtime
        raise StepExportException(
            "cad_runtime_unavailable",
            "CadQuery/OpenCascade runtime is not installed. Use Python 3.12 and install backend dependencies.",
            status_code=503,
        ) from exc

    return cq


def build_solid_cylinder(frame: Frame3D, axial_range: AxialRange, radius: float):
    cq = load_cadquery()
    height = axial_range.end - axial_range.start
    if radius <= 0 or height <= 0:
        raise StepExportException(
            "invalid_dimensions",
            "Cylinder dimensions must be greater than 0.",
        )

    start = point_along_axis(frame, axial_range.start)
    return cq.Solid.makeCylinder(
        radius,
        height,
        pnt=to_tuple(start),
        dir=to_tuple(frame.axis),
    )


def build_hollow_cylinder(frame: Frame3D, axial_range: AxialRange, outer_radius: float, inner_radius: float):
    outer = build_solid_cylinder(frame, axial_range, outer_radius)
    if inner_radius <= 0:
        return outer

    clearance = max(1.0, outer_radius * 0.02)
    inner = build_solid_cylinder(
        frame,
        AxialRange(axial_range.start - clearance, axial_range.end + clearance),
        inner_radius,
    )
    return subtract_shape(outer, inner, part_name="PipeBody", label="inner bore")


def resolve_single_ended_stock_start(
    *,
    receiver_radius: float,
    branch_radius: float,
    offset: float,
    axis_angle_rad: float,
    axial_shift: float,
    segments: int = 256,
    error_part_name: str = "BranchPipe",
) -> float:
    s_theta = safe_small(math.sin(axis_angle_rad))
    t_theta = safe_small(math.tan(axis_angle_rad))
    max_lower_root = -math.inf
    min_upper_root = math.inf

    for index in range(segments + 1):
        alpha = (index / segments) * math.pi * 2.0
        term = (receiver_radius ** 2) - (((branch_radius * math.sin(alpha)) + offset) ** 2)

        if term < -0.1:
            raise StepExportException(
                "invalid_intersection",
                "Geometry Error: Pipes do not intersect.",
                details={"part": error_part_name},
            )

        term = max(term, 0.0)
        root_span = math.sqrt(term) / s_theta
        root_midpoint = ((branch_radius * math.cos(alpha)) / t_theta) - axial_shift

        max_lower_root = max(max_lower_root, root_midpoint - root_span)
        min_upper_root = min(min_upper_root, root_midpoint + root_span)

    if (
        not math.isfinite(max_lower_root)
        or not math.isfinite(min_upper_root)
        or min_upper_root < max_lower_root - 1e-6
    ):
        raise StepExportException(
            "invalid_intersection",
            "Geometry Error: Could not isolate a single receiver-trim interval.",
            details={"part": error_part_name},
        )

    return max_lower_root + (max(0.0, min_upper_root - max_lower_root) * 0.5)


def receiver_cutter_length(body: EvaluatedPipeBody) -> float:
    stock_length = body.axial_range.end - body.axial_range.start
    return max(body.outer_diameter * 6.0, stock_length + (body.outer_diameter * 4.0))


def build_branch_pipe_body_from_profile_lofts(body: EvaluatedPipeBody, *, axis_angle_rad: float):
    cq = load_cadquery()
    notch = body.receiver_notch
    if notch is None:
        raise StepExportException(
            "invalid_geometry",
            "Branch notch definition is missing.",
            details={"part": body.name},
        )

    outer_curve_points = sample_branch_notch_curve(
        body.frame,
        notch,
        axis_angle_rad=axis_angle_rad,
        branch_mesh_radius=notch.branch_outer_radius,
        segments=192,
    )
    inner_curve_points = sample_branch_notch_curve(
        body.frame,
        notch,
        axis_angle_rad=axis_angle_rad,
        branch_mesh_radius=notch.branch_inner_radius,
        segments=192,
    )

    outer_curve = cq.Wire.assembleEdges([
        cq.Edge.makeSpline([cq.Vector(*to_tuple(point)) for point in outer_curve_points], periodic=True),
    ])
    inner_curve = cq.Wire.assembleEdges([
        cq.Edge.makeSpline([cq.Vector(*to_tuple(point)) for point in inner_curve_points], periodic=True),
    ])

    far_outer = cq.Wire.makeCircle(
        notch.branch_outer_radius,
        to_tuple(point_along_axis(body.frame, notch.far_end_axial)),
        to_tuple(body.frame.axis),
    )
    far_inner = cq.Wire.makeCircle(
        notch.branch_inner_radius,
        to_tuple(point_along_axis(body.frame, notch.far_end_axial)),
        to_tuple(body.frame.axis),
    )

    try:
        faces = [
            cq.Face.makeRuledSurface(outer_curve, far_outer),
            cq.Face.makeRuledSurface(inner_curve, far_inner),
            cq.Face.makeRuledSurface(outer_curve, inner_curve),
            cq.Face.makeFromWires(far_outer, [far_inner]),
        ]
        shell = cq.Shell.makeShell(faces)
        solid = cq.Solid.makeSolid(shell).fix()
    except Exception as exc:  # pragma: no cover - depends on CAD kernel runtime
        raise StepExportException(
            "body_generation_failure",
            "Failed to build branch notch body.",
            details={"part": body.name},
        ) from exc

    return solid


def build_main_pipe_body(body: EvaluatedPipeBody):
    shell = build_hollow_cylinder(
        body.frame,
        body.axial_range,
        body.outer_diameter / 2.0,
        body.inner_diameter / 2.0,
    )

    if body.opening_subtract is None:
        return shell

    tool = build_solid_cylinder(
        body.opening_subtract.frame,
        body.opening_subtract.axial_range,
        body.opening_subtract.radius,
    )
    return subtract_shape(shell, tool, part_name=body.name, label="opening tool")


def build_branch_pipe_body(body: EvaluatedPipeBody, *, axis_angle_rad: float):
    notch = body.receiver_notch
    if notch is None:
        return build_hollow_cylinder(
            body.frame,
            body.axial_range,
            body.outer_diameter / 2.0,
            body.inner_diameter / 2.0,
        )

    if notch.branch_contour_surface == "branch-inner":
        return build_branch_pipe_body_from_profile_lofts(body, axis_angle_rad=axis_angle_rad)

    stock_start = resolve_single_ended_stock_start(
        receiver_radius=notch.receiver_radius,
        branch_radius=notch.branch_outer_radius,
        offset=notch.offset,
        axis_angle_rad=axis_angle_rad,
        axial_shift=notch.penetration_depth - notch.welding_gap,
        error_part_name=body.name,
    )
    stock_range = AxialRange(start=stock_start, end=notch.far_end_axial)

    if stock_range.end <= stock_range.start + 1.0:
        raise StepExportException(
            "invalid_dimensions",
            "Geometry Error: Branch stock range is too short after receiver trim.",
            details={"part": body.name},
        )

    shell = build_hollow_cylinder(
        body.frame,
        stock_range,
        body.outer_diameter / 2.0,
        body.inner_diameter / 2.0,
    )
    receiver_shift = notch.penetration_depth - notch.welding_gap
    receiver_frame = create_frame(
        sub_vec3(vec3(0.0, 0.0, 0.0), scale_vec3(body.frame.axis, receiver_shift)),
        vec3(0.0, 1.0, 0.0),
    )
    cutter_length = receiver_cutter_length(body)
    receiver_cutter = build_solid_cylinder(
        receiver_frame,
        AxialRange(start=-(cutter_length / 2.0), end=cutter_length / 2.0),
        notch.receiver_radius,
    )

    return subtract_shape(shell, receiver_cutter, part_name=body.name, label="receiver notch")
