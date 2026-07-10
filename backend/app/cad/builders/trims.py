from __future__ import annotations

import math

from ...models.response_models import StepExportException
from ..dto import EvaluatedReceiverNotchTrim, Frame3D, Vec3
from .frames import sample_point_on_frame


def safe_small(value: float, fallback_magnitude: float = 1e-6) -> float:
    if abs(value) >= fallback_magnitude:
        return value

    return fallback_magnitude if value >= 0 else -fallback_magnitude


def validate_receiver_notch(trim: EvaluatedReceiverNotchTrim, segments: int = 128) -> None:
    for step in range(segments + 1):
        alpha = (step / segments) * math.pi * 2.0
        term = (trim.receiver_radius ** 2) - (
            ((trim.trim_contour_radius * math.sin(alpha)) + trim.offset) ** 2
        )
        if term < -0.1:
            raise StepExportException(
                "invalid_intersection",
                "Geometry Error: Pipes do not intersect.",
                details={"part": "BranchPipe"},
            )


def calculate_receiver_notch_depth_with_angle(
    trim: EvaluatedReceiverNotchTrim,
    *,
    axis_angle_rad: float,
    alpha: float,
    branch_mesh_radius: float,
) -> float:
    sin_alpha = math.sin(alpha)
    cos_alpha = math.cos(alpha)
    term = (trim.receiver_radius ** 2) - (
        ((trim.trim_contour_radius * sin_alpha) + trim.offset) ** 2
    )
    if term < 0:
        term = 0

    s_theta = safe_small(math.sin(axis_angle_rad))
    t_theta = safe_small(math.tan(axis_angle_rad))

    return (
        (1.0 / s_theta) * math.sqrt(term)
        + ((branch_mesh_radius * cos_alpha) / t_theta)
        + trim.welding_gap
        - trim.penetration_depth
    )


def sample_branch_notch_curve(
    frame: Frame3D,
    trim: EvaluatedReceiverNotchTrim,
    *,
    axis_angle_rad: float,
    branch_mesh_radius: float,
    segments: int = 128,
) -> list[Vec3]:
    validate_receiver_notch(trim, segments)
    points: list[Vec3] = []

    for step in range(segments):
        alpha = (step / segments) * math.pi * 2.0
        axial = calculate_receiver_notch_depth_with_angle(
            trim,
            axis_angle_rad=axis_angle_rad,
            alpha=alpha,
            branch_mesh_radius=branch_mesh_radius,
        )
        points.append(
            sample_point_on_frame(
                frame,
                axial,
                normal_offset=branch_mesh_radius * math.sin(alpha),
                tangent_offset=branch_mesh_radius * math.cos(alpha),
            )
        )

    return points
