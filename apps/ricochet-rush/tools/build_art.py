"""Build and export the RICOCHET RUSH combat robot art set.

Run from any directory with:

    blender --background --python tools/build_art.py -- [output-directory]

The script deliberately uses only Blender primitives, bevels, and Principled
materials so the resulting GLBs stay portable across Godot's Compatibility
renderer and the web export.  Every model is built from the same deterministic
source scene and exported at the same scale on every invocation.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Euler, Vector


APP_ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = APP_ROOT / "art" / "source" / "ricochet_set.blend"
DEFAULT_OUTPUT = APP_ROOT / "assets" / "models"


def _output_directory() -> Path:
    """Read the optional path after Blender's ``--`` separator."""

    try:
        separator = sys.argv.index("--")
    except ValueError:
        return DEFAULT_OUTPUT
    if separator + 1 >= len(sys.argv):
        return DEFAULT_OUTPUT
    return Path(sys.argv[separator + 1]).expanduser().resolve()


OUTPUT_DIRECTORY = _output_directory()

# Blender's native scene basis is Z-up.  The game and the exported glTFs use
# Y-up, with local -Z as forward.  Keeping all dimensions and rotations in the
# game basis here makes the authored coordinates match the Godot actors while
# the small conversion below keeps the .blend source pleasant to edit.
_GAME_TO_BLENDER = Euler((math.pi / 2.0, 0.0, 0.0), "XYZ").to_matrix()


def _to_blender_location(location: tuple[float, float, float] | Vector) -> Vector:
    return _GAME_TO_BLENDER @ Vector(location)


def _to_blender_rotation(
    rotation: tuple[float, float, float],
) -> tuple[float, float, float]:
    game_rotation = Euler(rotation, "XYZ").to_matrix()
    return (_GAME_TO_BLENDER @ game_rotation).to_euler("XYZ")


def _color(hex_value: str) -> tuple[float, float, float, float]:
    value = hex_value.lstrip("#")

    def srgb_to_linear(channel: int) -> float:
        normalized = channel / 255.0
        return (
            normalized / 12.92
            if normalized <= 0.04045
            else ((normalized + 0.055) / 1.055) ** 2.4
        )

    return (
        srgb_to_linear(int(value[0:2], 16)),
        srgb_to_linear(int(value[2:4], 16)),
        srgb_to_linear(int(value[4:6], 16)),
        1.0,
    )


PALETTE = {
    "ink": _color("080A0E"),
    "graphite": _color("151A1D"),
    "graphite_light": _color("2B3335"),
    "steel": _color("4B5554"),
    "ceramic": _color("CDD0C8"),
    "ceramic_shadow": _color("7E8581"),
    "lime": _color("E2D6B8"),
    "lime_hot": _color("FFF1D1"),
    "cyan": _color("5FE4EF"),
    "violet": _color("3B4242"),
    "violet_dark": _color("111619"),
    "pink": _color("7A4D3C"),
    "pink_hot": _color("B77A54"),
    "amber": _color("B48A58"),
}


def _material(
    name: str,
    color: tuple[float, float, float, float],
    *,
    metallic: float = 0.0,
    roughness: float = 0.42,
    emission: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = color
    nodes = material.node_tree.nodes
    principled = nodes.get("Principled BSDF")
    if principled is None:
        raise RuntimeError(f"Principled BSDF was not created for {name}")
    principled.inputs["Base Color"].default_value = color
    principled.inputs["Metallic"].default_value = metallic
    principled.inputs["Roughness"].default_value = roughness
    coat_weight = principled.inputs.get("Coat Weight")
    if coat_weight is not None:
        coat_weight.default_value = 0.22 if roughness < 0.35 else 0.08
    coat_roughness = principled.inputs.get("Coat Roughness")
    if coat_roughness is not None:
        coat_roughness.default_value = 0.16
    if emission is not None:
        emission_input = principled.inputs.get(
            "Emission Color"
        ) or principled.inputs.get("Emission")
        if emission_input is not None:
            emission_input.default_value = emission
        strength_input = principled.inputs.get("Emission Strength")
        if strength_input is not None:
            strength_input.default_value = emission_strength
    return material


def _materials() -> dict[str, bpy.types.Material]:
    return {
        "ink": _material("MAT_ink", PALETTE["ink"], roughness=0.7),
        "graphite": _material(
            "MAT_graphite", PALETTE["graphite"], metallic=0.42, roughness=0.34
        ),
        "graphite_light": _material(
            "MAT_graphite_light", PALETTE["graphite_light"], metallic=0.5, roughness=0.3
        ),
        "steel": _material(
            "MAT_steel", PALETTE["steel"], metallic=0.62, roughness=0.34
        ),
        "ceramic": _material("MAT_player_ceramic", PALETTE["ceramic"], roughness=0.26),
        "ceramic_shadow": _material(
            "MAT_player_ceramic_shadow", PALETTE["ceramic_shadow"], roughness=0.32
        ),
        "lime": _material(
            "MAT_player_lime",
            PALETTE["lime"],
            metallic=0.05,
            roughness=0.3,
            emission=PALETTE["lime"],
            emission_strength=0.32,
        ),
        "lime_hot": _material(
            "MAT_player_lime_hot",
            PALETTE["lime_hot"],
            roughness=0.25,
            emission=PALETTE["lime_hot"],
            emission_strength=0.72,
        ),
        "cyan": _material(
            "MAT_player_sensor",
            PALETTE["cyan"],
            metallic=0.12,
            roughness=0.18,
            emission=PALETTE["cyan"],
            emission_strength=1.8,
        ),
        "violet": _material(
            "MAT_enemy_violet", PALETTE["violet"], metallic=0.24, roughness=0.32
        ),
        "violet_dark": _material(
            "MAT_enemy_violet_dark",
            PALETTE["violet_dark"],
            metallic=0.34,
            roughness=0.36,
        ),
        "pink": _material(
            "MAT_enemy_pink", PALETTE["pink"], metallic=0.32, roughness=0.42
        ),
        "pink_hot": _material(
            "MAT_enemy_pink_hot", PALETTE["pink_hot"], metallic=0.26, roughness=0.34
        ),
        "amber": _material(
            "MAT_enemy_amber", PALETTE["amber"], metallic=0.22, roughness=0.38
        ),
    }


def _link_to_collection(
    obj: bpy.types.Object, collection: bpy.types.Collection
) -> None:
    for old_collection in list(obj.users_collection):
        old_collection.objects.unlink(obj)
    collection.objects.link(obj)


def _apply_transform(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.select_set(False)


def _finish_mesh(
    obj: bpy.types.Object,
    collection: bpy.types.Collection,
    material: bpy.types.Material,
    *,
    bevel: float = 0.0,
    segments: int = 2,
) -> bpy.types.Object:
    _link_to_collection(obj, collection)
    if material.name not in {
        slot.material.name for slot in obj.material_slots if slot.material is not None
    }:
        obj.data.materials.append(material)
    _apply_transform(obj)
    if bevel > 0.0:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        modifier = obj.modifiers.new(name="Soft bevel", type="BEVEL")
        modifier.width = bevel
        modifier.segments = segments
        modifier.limit_method = "ANGLE"
        modifier.angle_limit = math.radians(28.0)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)
    return obj


def _box(
    collection: bpy.types.Collection,
    name: str,
    location: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    bevel: float = 0.0,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(
        location=_to_blender_location(location), rotation=_to_blender_rotation(rotation)
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = (dimensions[0] / 2.0, dimensions[1] / 2.0, dimensions[2] / 2.0)
    return _finish_mesh(obj, collection, material, bevel=bevel)


def _cylinder(
    collection: bpy.types.Collection,
    name: str,
    location: tuple[float, float, float],
    radius: float,
    depth: float,
    material: bpy.types.Material,
    *,
    vertices: int = 10,
    bevel: float = 0.0,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        end_fill_type="NGON",
        location=_to_blender_location(location),
        rotation=_to_blender_rotation(rotation),
    )
    obj = bpy.context.object
    obj.name = name
    return _finish_mesh(obj, collection, material, bevel=bevel, segments=2)


def _sphere(
    collection: bpy.types.Collection,
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    segments: int = 12,
    rings: int = 6,
) -> bpy.types.Object:
    # Icospheres avoid the UV-sphere cap index ordering that can vary between
    # Blender processes, keeping repeated head/dome exports byte-stable.
    del segments, rings
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=2,
        location=_to_blender_location(location),
        rotation=_to_blender_rotation((0.0, 0.0, 0.0)),
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return _finish_mesh(obj, collection, material)


def _ico_sphere(
    collection: bpy.types.Collection,
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    material: bpy.types.Material,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=2,
        location=_to_blender_location(location),
        rotation=_to_blender_rotation((0.0, 0.0, 0.0)),
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return _finish_mesh(obj, collection, material)


def _torus(
    collection: bpy.types.Collection,
    name: str,
    location: tuple[float, float, float],
    major_radius: float,
    minor_radius: float,
    material: bpy.types.Material,
    *,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        major_segments=12,
        minor_segments=6,
        major_radius=major_radius,
        minor_radius=minor_radius,
        location=_to_blender_location(location),
        rotation=_to_blender_rotation(rotation),
    )
    obj = bpy.context.object
    obj.name = name
    return _finish_mesh(obj, collection, material)


def _prism(
    collection: bpy.types.Collection,
    name: str,
    points: list[tuple[float, float]],
    y_min: float,
    y_max: float,
    material: bpy.types.Material,
    *,
    bevel: float = 0.0,
) -> bpy.types.Object:
    vertices = [tuple(_to_blender_location((x, y_min, z))) for x, z in points] + [
        tuple(_to_blender_location((x, y_max, z))) for x, z in points
    ]
    size = len(points)
    faces = [tuple(reversed(range(size))), tuple(range(size, size * 2))]
    for index in range(size):
        next_index = (index + 1) % size
        faces.append((index, next_index, next_index + size, index + size))
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return _finish_mesh(obj, collection, material, bevel=bevel, segments=2)


def _parent(obj: bpy.types.Object, root: bpy.types.Object) -> bpy.types.Object:
    obj.parent = root
    return obj


def _model_collection(name: str) -> tuple[bpy.types.Collection, bpy.types.Object]:
    collection = bpy.data.collections.new(f"{name}_ART")
    bpy.context.scene.collection.children.link(collection)
    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "CUBE"
    root.empty_display_size = 0.08
    collection.objects.link(root)
    return collection, root


def _add_wheel_pair(
    collection: bpy.types.Collection,
    root: bpy.types.Object,
    materials: dict[str, bpy.types.Material],
    *,
    x: float,
    y: float,
    z: float,
    radius: float,
    width: float,
    prefix: str,
) -> None:
    for side in (-1.0, 1.0):
        wheel = _cylinder(
            collection,
            f"{prefix}_wheel_{'L' if side < 0 else 'R'}",
            (x + side * 0.0, y, z),
            radius,
            width,
            materials["graphite"],
            vertices=10,
            bevel=0.018,
            rotation=(0.0, math.pi / 2.0, 0.0),
        )
        wheel.location.x = x + side * (width / 2.0)
        _parent(wheel, root)
        hub = _cylinder(
            collection,
            f"{prefix}_hub_{'L' if side < 0 else 'R'}",
            (x + side * (width / 2.0 + 0.012), y, z),
            radius * 0.42,
            0.024,
            materials["lime"],
            vertices=8,
            rotation=(0.0, math.pi / 2.0, 0.0),
        )
        _parent(hub, root)


def _build_player(
    materials: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Collection, bpy.types.Object]:
    collection, root = _model_collection("PlayerBot")
    graphite = materials["graphite"]
    graphite_light = materials["graphite_light"]
    steel = materials["steel"]
    ceramic = materials["ceramic"]
    ceramic_shadow = materials["ceramic_shadow"]
    lime = materials["lime"]
    lime_hot = materials["lime_hot"]

    # Compact tracked chassis with a ceramic upper shell and exposed service
    # rails. Every part is angular so the silhouette reads as equipment rather
    # than a mascot, even at the game's orthographic camera distance.
    _parent(
        _box(
            collection,
            "Player_charcoal_underside",
            (0.0, 0.12, 0.03),
            (0.74, 0.18, 0.56),
            graphite,
            bevel=0.045,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_left_track",
            (-0.31, 0.2, 0.03),
            (0.16, 0.25, 0.58),
            graphite_light,
            bevel=0.032,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_right_track",
            (0.31, 0.2, 0.03),
            (0.16, 0.25, 0.58),
            graphite_light,
            bevel=0.032,
        ),
        root,
    )
    for side, x in (("left", -0.4), ("right", 0.4)):
        _parent(
            _cylinder(
                collection,
                f"Player_{side}_drive_joint",
                (x, 0.2, -0.06),
                0.09,
                0.08,
                graphite,
                vertices=10,
                bevel=0.012,
                rotation=(0.0, math.pi / 2.0, 0.0),
            ),
            root,
        )
        _parent(
            _cylinder(
                collection,
                f"Player_{side}_drive_hub",
                (x + (-0.045 if x < 0.0 else 0.045), 0.2, -0.06),
                0.038,
                0.018,
                steel,
                vertices=8,
                rotation=(0.0, math.pi / 2.0, 0.0),
            ),
            root,
        )
    _parent(
        _prism(
            collection,
            "Player_ceramic_upper_shell",
            [(-0.34, 0.25), (0.34, 0.25), (0.27, -0.3), (-0.27, -0.3)],
            0.26,
            0.57,
            ceramic,
            bevel=0.045,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_underside_front",
            (0.0, 0.3, -0.32),
            (0.48, 0.16, 0.08),
            ceramic_shadow,
            bevel=0.02,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_left_service_plate",
            (-0.34, 0.45, 0.02),
            (0.12, 0.25, 0.42),
            ceramic_shadow,
            bevel=0.028,
            rotation=(0.0, 0.0, -0.15),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_right_service_plate",
            (0.34, 0.45, 0.02),
            (0.12, 0.25, 0.42),
            ceramic_shadow,
            bevel=0.028,
            rotation=(0.0, 0.0, 0.15),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_left_edge_mark",
            (-0.405, 0.47, -0.05),
            (0.018, 0.12, 0.25),
            lime,
            bevel=0.005,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_right_edge_mark",
            (0.405, 0.47, -0.05),
            (0.018, 0.12, 0.25),
            lime,
            bevel=0.005,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_low_avionics_deck",
            (0.0, 0.62, 0.08),
            (0.3, 0.12, 0.28),
            graphite_light,
            bevel=0.03,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_rear_comms_fin",
            (0.0, 0.76, 0.24),
            (0.16, 0.12, 0.08),
            ceramic_shadow,
            bevel=0.018,
            rotation=(math.radians(-10.0), 0.0, 0.0),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_rear_status_bar",
            (0.0, 0.81, 0.28),
            (0.12, 0.018, 0.022),
            lime_hot,
            bevel=0.004,
        ),
        root,
    )

    # The cannon is a visible, articulated assembly: side pivots, a receiver,
    # and a long barrel aligned to local -Z.
    _parent(
        _cylinder(
            collection,
            "Player_cannon_trunnion",
            (0.0, 0.63, -0.22),
            0.13,
            0.12,
            graphite,
            vertices=10,
            bevel=0.018,
            rotation=(math.pi / 2.0, 0.0, 0.0),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_cannon_receiver",
            (0.0, 0.64, -0.35),
            (0.25, 0.18, 0.25),
            steel,
            bevel=0.035,
        ),
        root,
    )
    for side, x in (("left", -0.15), ("right", 0.15)):
        _parent(
            _cylinder(
                collection,
                f"Player_cannon_{side}_pivot",
                (x, 0.64, -0.35),
                0.06,
                0.12,
                graphite_light,
                vertices=10,
                bevel=0.012,
                rotation=(0.0, math.pi / 2.0, 0.0),
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Player_cannon_{side}_brace",
                (x, 0.66, -0.43),
                (0.055, 0.1, 0.2),
                ceramic_shadow,
                bevel=0.012,
                rotation=(math.radians(-9.0), 0.0, 0.0),
            ),
            root,
        )
    _parent(
        _cylinder(
            collection,
            "Player_forward_cannon",
            (0.0, 0.65, -0.57),
            0.052,
            0.42,
            steel,
            vertices=10,
            bevel=0.01,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_cannon_heat_guard",
            (0.0, 0.65, -0.49),
            (0.11, 0.11, 0.18),
            graphite_light,
            bevel=0.018,
        ),
        root,
    )
    _parent(
        _torus(
            collection,
            "Player_cannon_muzzle_ring",
            (0.0, 0.65, -0.79),
            0.066,
            0.012,
            lime,
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Player_cannon_muzzle",
            (0.0, 0.65, -0.8),
            0.032,
            0.022,
            graphite,
            vertices=10,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_cannon_sight",
            (0.0, 0.75, -0.49),
            (0.025, 0.025, 0.2),
            lime_hot,
            bevel=0.004,
        ),
        root,
    )

    _parent(
        _box(
            collection,
            "Player_rear_radiator",
            (0.0, 0.5, 0.3),
            (0.26, 0.22, 0.08),
            steel,
            bevel=0.018,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_rear_service_bar",
            (0.0, 0.62, 0.35),
            (0.18, 0.04, 0.025),
            lime,
            bevel=0.006,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_rear_antenna",
            (0.0, 0.91, 0.27),
            (0.035, 0.16, 0.035),
            graphite_light,
            bevel=0.008,
            rotation=(math.radians(-8.0), 0.0, 0.0),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Player_rear_antenna_marker",
            (0.0, 1.01, 0.28),
            (0.03, 0.025, 0.03),
            lime_hot,
            bevel=0.005,
        ),
        root,
    )
    root["role"] = "player"
    root["forward_axis"] = "-Z"
    root["nominal_height"] = 1.1
    root["nominal_radius"] = 0.45
    return collection, root


def _build_chaser(
    materials: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Collection, bpy.types.Object]:
    """Build a headless pursuit rammer with a low armored vehicle silhouette."""

    collection, root = _model_collection("EnemyChaser")
    violet = materials["violet"]
    violet_dark = materials["violet_dark"]
    graphite = materials["graphite"]
    graphite_light = materials["graphite_light"]
    steel = materials["steel"]
    rust = materials["pink"]
    rust_hot = materials["pink_hot"]
    warm_hot = materials["lime_hot"]

    _parent(
        _prism(
            collection,
            "Chaser_low_tracked_hull",
            [
                (-0.28, 0.32),
                (0.28, 0.32),
                (0.34, -0.22),
                (0.22, -0.43),
                (-0.22, -0.43),
                (-0.34, -0.22),
            ],
            0.08,
            0.34,
            violet_dark,
            bevel=0.04,
        ),
        root,
    )
    for side, x in (("left", -1.0), ("right", 1.0)):
        _parent(
            _box(
                collection,
                f"Chaser_{side}_track_pod",
                (x * 0.31, 0.22, 0.0),
                (0.1, 0.24, 0.62),
                graphite,
                bevel=0.026,
            ),
            root,
        )
        _parent(
            _cylinder(
                collection,
                f"Chaser_{side}_track_axle",
                (x * 0.365, 0.22, -0.08),
                0.058,
                0.06,
                graphite_light,
                vertices=8,
                bevel=0.01,
                rotation=(0.0, math.pi / 2.0, 0.0),
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Chaser_{side}_armor_rail",
                (x * 0.37, 0.34, 0.12),
                (0.025, 0.06, 0.32),
                steel,
                bevel=0.004,
            ),
            root,
        )
    _parent(
        _prism(
            collection,
            "Chaser_upper_deck",
            [(-0.24, 0.18), (0.24, 0.18), (0.2, -0.27), (-0.2, -0.27)],
            0.34,
            0.55,
            violet,
            bevel=0.035,
        ),
        root,
    )
    _parent(
        _prism(
            collection,
            "Chaser_front_breacher_blade",
            [(-0.28, -0.3), (0.0, -0.52), (0.28, -0.3), (0.2, -0.25), (-0.2, -0.25)],
            0.28,
            0.42,
            steel,
            bevel=0.025,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_blade_reinforcement",
            (0.0, 0.39, -0.36),
            (0.3, 0.08, 0.07),
            rust,
            bevel=0.012,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_rear_equipment_fin",
            (0.0, 0.66, 0.25),
            (0.07, 0.22, 0.16),
            graphite_light,
            bevel=0.018,
            rotation=(math.radians(-9.0), 0.0, 0.0),
        ),
        root,
    )
    for index, x in enumerate((-0.11, 0.11)):
        _parent(
            _box(
                collection,
                f"Chaser_rear_vent_{index}",
                (x, 0.46, 0.31),
                (0.055, 0.05, 0.14),
                graphite,
                bevel=0.008,
            ),
            root,
        )
    _parent(
        _box(
            collection,
            "Chaser_rear_status_bar",
            (0.0, 0.6, 0.34),
            (0.13, 0.018, 0.022),
            warm_hot,
            bevel=0.004,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_side_warning_mark",
            (-0.39, 0.31, -0.08),
            (0.018, 0.07, 0.13),
            rust_hot,
            bevel=0.004,
        ),
        root,
    )
    root["role"] = "enemy_chaser"
    root["forward_axis"] = "-Z"
    root["nominal_height"] = 0.9
    root["nominal_radius"] = 0.42
    return collection, root


def _build_chaser_legacy(
    materials: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Collection, bpy.types.Object]:
    collection, root = _model_collection("EnemyChaser")
    violet = materials["violet"]
    violet_dark = materials["violet_dark"]
    pink = materials["pink"]
    pink_hot = materials["pink_hot"]
    graphite = materials["graphite"]
    graphite_light = materials["graphite_light"]
    steel = materials["steel"]
    lime_hot = materials["lime_hot"]

    # A narrow pursuit frame with exposed arm joints and a tall sensor spine.
    _parent(
        _prism(
            collection,
            "Chaser_lower_wedge",
            [(-0.29, 0.21), (0.29, 0.21), (0.24, -0.25), (-0.24, -0.25)],
            0.1,
            0.34,
            violet_dark,
            bevel=0.04,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_front_ram",
            (0.0, 0.31, -0.28),
            (0.4, 0.2, 0.1),
            violet,
            bevel=0.022,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_left_armor",
            (-0.32, 0.45, 0.02),
            (0.13, 0.3, 0.42),
            violet,
            bevel=0.035,
            rotation=(0.0, 0.0, -0.2),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_right_armor",
            (0.32, 0.45, 0.02),
            (0.13, 0.3, 0.42),
            violet,
            bevel=0.035,
            rotation=(0.0, 0.0, 0.2),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_spine",
            (0.0, 0.57, 0.08),
            (0.24, 0.42, 0.2),
            graphite,
            bevel=0.035,
            rotation=(math.radians(-7.0), 0.0, 0.0),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_spine_cap",
            (0.0, 0.75, 0.02),
            (0.28, 0.12, 0.22),
            steel,
            bevel=0.025,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_warm_sensor_slit",
            (0.0, 0.73, -0.12),
            (0.12, 0.022, 0.018),
            lime_hot,
            bevel=0.004,
        ),
        root,
    )
    for side, x, sign in (("left", -1.0, -1.0), ("right", 1.0, 1.0)):
        _parent(
            _cylinder(
                collection,
                f"Chaser_{side}_shoulder_joint",
                (x * 0.29, 0.5, -0.16),
                0.075,
                0.09,
                graphite_light,
                vertices=10,
                bevel=0.012,
                rotation=(0.0, math.pi / 2.0, 0.0),
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Chaser_{side}_upper_link",
                (x * 0.36, 0.39, -0.17),
                (0.1, 0.24, 0.14),
                steel,
                bevel=0.022,
                rotation=(0.0, 0.0, sign * 0.22),
            ),
            root,
        )
        _parent(
            _cylinder(
                collection,
                f"Chaser_{side}_elbow",
                (x * 0.39, 0.27, -0.18),
                0.06,
                0.1,
                graphite,
                vertices=8,
                bevel=0.01,
                rotation=(0.0, math.pi / 2.0, 0.0),
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Chaser_{side}_lower_link",
                (x * 0.37, 0.2, -0.22),
                (0.08, 0.18, 0.1),
                pink,
                bevel=0.016,
                rotation=(0.0, 0.0, sign * -0.18),
            ),
            root,
        )
    _parent(
        _box(
            collection,
            "Chaser_rear_keel",
            (0.0, 0.31, 0.27),
            (0.18, 0.22, 0.12),
            pink,
            bevel=0.025,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_rear_strobe",
            (0.0, 0.44, 0.34),
            (0.08, 0.04, 0.018),
            pink_hot,
            bevel=0.004,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Chaser_top_marker",
            (0.0, 0.86, 0.04),
            (0.05, 0.08, 0.05),
            pink_hot,
            bevel=0.01,
        ),
        root,
    )
    root["role"] = "enemy_chaser"
    root["forward_axis"] = "-Z"
    root["nominal_height"] = 0.9
    root["nominal_radius"] = 0.42
    return collection, root


def _build_runner(
    materials: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Collection, bpy.types.Object]:
    collection, root = _model_collection("EnemyRunner")
    violet = materials["violet"]
    violet_dark = materials["violet_dark"]
    pink = materials["pink"]
    pink_hot = materials["pink_hot"]
    graphite = materials["graphite"]
    amber = materials["amber"]
    lime_hot = materials["lime_hot"]

    # A low, elongated reconnaissance skimmer. The nose is a hard wedge and
    # the side rails are stabilizers, giving it a fast silhouette with no
    # anthropomorphic features.
    _parent(
        _prism(
            collection,
            "Runner_lower_skimmer",
            [(-0.28, 0.24), (0.28, 0.24), (0.2, -0.44), (-0.2, -0.44)],
            0.08,
            0.3,
            violet_dark,
            bevel=0.035,
        ),
        root,
    )
    _parent(
        _prism(
            collection,
            "Runner_upper_keel",
            [(-0.18, 0.16), (0.18, 0.16), (0.12, -0.28), (-0.12, -0.28)],
            0.28,
            0.48,
            violet,
            bevel=0.028,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Runner_nose_cap",
            (0.0, 0.2, -0.46),
            (0.2, 0.13, 0.07),
            materials["steel"],
            bevel=0.016,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Runner_rear_status_bar",
            (0.0, 0.4, 0.26),
            (0.11, 0.018, 0.02),
            lime_hot,
            bevel=0.004,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Runner_left_stabilizer",
            (-0.28, 0.19, 0.04),
            (0.07, 0.11, 0.48),
            pink,
            bevel=0.016,
            rotation=(0.0, 0.0, -0.18),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Runner_right_stabilizer",
            (0.28, 0.19, 0.04),
            (0.07, 0.11, 0.48),
            pink,
            bevel=0.016,
            rotation=(0.0, 0.0, 0.18),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Runner_left_rail",
            (-0.24, 0.35, 0.14),
            (0.025, 0.04, 0.27),
            pink_hot,
            bevel=0.004,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Runner_right_rail",
            (0.24, 0.35, 0.14),
            (0.025, 0.04, 0.27),
            pink_hot,
            bevel=0.004,
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Runner_left_skid_joint",
            (-0.2, 0.1, 0.1),
            0.06,
            0.16,
            graphite,
            vertices=8,
            bevel=0.01,
            rotation=(0.0, math.pi / 2.0, 0.0),
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Runner_right_skid_joint",
            (0.2, 0.1, 0.1),
            0.06,
            0.16,
            graphite,
            vertices=8,
            bevel=0.01,
            rotation=(0.0, math.pi / 2.0, 0.0),
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Runner_left_rear_thruster",
            (-0.14, 0.24, 0.34),
            0.07,
            0.12,
            graphite,
            vertices=8,
            bevel=0.012,
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Runner_right_rear_thruster",
            (0.14, 0.24, 0.34),
            0.07,
            0.12,
            graphite,
            vertices=8,
            bevel=0.012,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Runner_tail_fin",
            (0.0, 0.63, 0.18),
            (0.06, 0.24, 0.1),
            pink_hot,
            bevel=0.016,
            rotation=(math.radians(-10.0), 0.0, 0.0),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Runner_tail_marker",
            (0.0, 0.72, 0.16),
            (0.03, 0.05, 0.03),
            amber,
            bevel=0.005,
        ),
        root,
    )
    root["role"] = "enemy_runner"
    root["forward_axis"] = "-Z"
    root["nominal_height"] = 0.75
    root["nominal_radius"] = 0.35
    return collection, root


def _build_brute(
    materials: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Collection, bpy.types.Object]:
    """Build a heavy tracked gun platform with exposed industrial hardware."""

    collection, root = _model_collection("EnemyBrute")
    violet = materials["violet"]
    violet_dark = materials["violet_dark"]
    graphite = materials["graphite"]
    graphite_light = materials["graphite_light"]
    steel = materials["steel"]
    rust = materials["pink"]
    rust_hot = materials["pink_hot"]
    amber = materials["amber"]
    warm_hot = materials["lime_hot"]

    _parent(
        _box(
            collection,
            "Brute_underframe",
            (0.0, 0.18, 0.02),
            (0.98, 0.34, 0.78),
            graphite,
            bevel=0.085,
        ),
        root,
    )
    for side, x in (("left", -1.0), ("right", 1.0)):
        _parent(
            _box(
                collection,
                f"Brute_{side}_track_pod",
                (x * 0.46, 0.25, 0.02),
                (0.18, 0.32, 0.72),
                graphite_light,
                bevel=0.04,
            ),
            root,
        )
        _parent(
            _cylinder(
                collection,
                f"Brute_{side}_track_axle",
                (x * 0.55, 0.25, -0.08),
                0.085,
                0.06,
                graphite,
                vertices=10,
                bevel=0.014,
                rotation=(0.0, math.pi / 2.0, 0.0),
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Brute_{side}_track_rail",
                (x * 0.56, 0.38, 0.14),
                (0.025, 0.07, 0.42),
                steel,
                bevel=0.006,
            ),
            root,
        )
    _parent(
        _prism(
            collection,
            "Brute_armored_hull",
            [
                (-0.41, 0.32),
                (0.41, 0.32),
                (0.46, -0.15),
                (0.34, -0.43),
                (-0.34, -0.43),
                (-0.46, -0.15),
            ],
            0.34,
            0.82,
            violet_dark,
            bevel=0.07,
        ),
        root,
    )
    _parent(
        _prism(
            collection,
            "Brute_front_breacher_wedge",
            [(-0.4, -0.28), (0.0, -0.63), (0.4, -0.28), (0.3, -0.2), (-0.3, -0.2)],
            0.45,
            0.7,
            violet,
            bevel=0.04,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_breacher_edge",
            (0.0, 0.66, -0.49),
            (0.58, 0.07, 0.06),
            steel,
            bevel=0.012,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_breacher_warning",
            (0.0, 0.7, -0.55),
            (0.24, 0.018, 0.022),
            rust_hot,
            bevel=0.004,
        ),
        root,
    )

    # The upper mass is a rotating gun deck, never a head or torso.
    _parent(
        _prism(
            collection,
            "Brute_gun_deck",
            [(-0.3, 0.22), (0.3, 0.22), (0.26, -0.27), (-0.26, -0.27)],
            0.82,
            1.04,
            violet,
            bevel=0.04,
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Brute_cannon_trunnion",
            (0.0, 0.88, -0.24),
            0.14,
            0.2,
            graphite,
            vertices=10,
            bevel=0.022,
            rotation=(0.0, math.pi / 2.0, 0.0),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_cannon_receiver",
            (0.0, 0.9, -0.38),
            (0.3, 0.2, 0.25),
            steel,
            bevel=0.035,
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Brute_forward_cannon",
            (0.0, 0.91, -0.62),
            0.062,
            0.45,
            graphite_light,
            vertices=10,
            bevel=0.012,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_cannon_heat_guard",
            (0.0, 0.91, -0.53),
            (0.13, 0.12, 0.2),
            graphite,
            bevel=0.022,
        ),
        root,
    )
    _parent(
        _torus(
            collection,
            "Brute_cannon_muzzle_ring",
            (0.0, 0.91, -0.89),
            0.078,
            0.013,
            rust_hot,
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Brute_cannon_muzzle",
            (0.0, 0.91, -0.9),
            0.037,
            0.025,
            graphite,
            vertices=10,
        ),
        root,
    )

    _parent(
        _box(
            collection,
            "Brute_rear_engine_block",
            (0.0, 1.03, 0.26),
            (0.48, 0.36, 0.3),
            graphite_light,
            bevel=0.045,
        ),
        root,
    )
    for index, x in enumerate((-0.16, 0.16)):
        _parent(
            _box(
                collection,
                f"Brute_rear_exhaust_{index}",
                (x, 1.25, 0.31),
                (0.1, 0.36, 0.11),
                graphite,
                bevel=0.018,
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Brute_rear_exhaust_cap_{index}",
                (x, 1.46, 0.31),
                (0.12, 0.035, 0.13),
                steel,
                bevel=0.008,
            ),
            root,
        )
    _parent(
        _box(
            collection,
            "Brute_deck_status_bar",
            (0.0, 1.065, 0.3),
            (0.14, 0.018, 0.022),
            warm_hot,
            bevel=0.004,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_left_service_mark",
            (-0.58, 0.48, 0.14),
            (0.018, 0.1, 0.16),
            amber,
            bevel=0.004,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_right_service_mark",
            (0.58, 0.48, 0.14),
            (0.018, 0.1, 0.16),
            amber,
            bevel=0.004,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_rear_rust_plate",
            (0.0, 1.08, 0.43),
            (0.24, 0.08, 0.04),
            rust,
            bevel=0.01,
        ),
        root,
    )
    root["role"] = "enemy_brute"
    root["forward_axis"] = "-Z"
    root["nominal_height"] = 1.5
    root["nominal_radius"] = 0.65
    return collection, root


def _build_brute_legacy(
    materials: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Collection, bpy.types.Object]:
    collection, root = _model_collection("EnemyBrute")
    violet = materials["violet"]
    violet_dark = materials["violet_dark"]
    pink = materials["pink"]
    pink_hot = materials["pink_hot"]
    graphite = materials["graphite"]
    graphite_light = materials["graphite_light"]
    steel = materials["steel"]
    amber = materials["amber"]
    lime_hot = materials["lime_hot"]

    # Heavy breacher chassis. The silhouette is wide because of its hydraulic
    # arms, while the center remains a layered mechanical torso instead of a
    # face-like head.
    _parent(
        _box(
            collection,
            "Brute_charcoal_underframe",
            (0.0, 0.18, 0.03),
            (1.0, 0.34, 0.78),
            graphite,
            bevel=0.09,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_left_track",
            (-0.46, 0.24, 0.02),
            (0.2, 0.3, 0.72),
            materials["graphite_light"],
            bevel=0.045,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_right_track",
            (0.46, 0.24, 0.02),
            (0.2, 0.3, 0.72),
            graphite_light,
            bevel=0.045,
        ),
        root,
    )
    _parent(
        _prism(
            collection,
            "Brute_armored_torso",
            [(-0.42, 0.28), (0.42, 0.28), (0.36, -0.38), (-0.36, -0.38)],
            0.34,
            0.94,
            violet_dark,
            bevel=0.075,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_front_breacher_plate",
            (0.0, 0.64, -0.41),
            (0.7, 0.42, 0.12),
            violet,
            bevel=0.045,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_front_reinforcement",
            (0.0, 0.67, -0.49),
            (0.34, 0.2, 0.03),
            materials["steel"],
            bevel=0.012,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_warm_sensor_slit",
            (0.0, 0.82, -0.455),
            (0.16, 0.022, 0.018),
            lime_hot,
            bevel=0.004,
        ),
        root,
    )
    for side, x, sign in (("left", -1.0, -1.0), ("right", 1.0, 1.0)):
        _parent(
            _box(
                collection,
                f"Brute_{side}_shoulder_block",
                (x * 0.48, 0.86, 0.0),
                (0.23, 0.58, 0.6),
                violet,
                bevel=0.06,
                rotation=(0.0, 0.0, sign * 0.08),
            ),
            root,
        )
        _parent(
            _cylinder(
                collection,
                f"Brute_{side}_shoulder_joint",
                (x * 0.53, 0.74, -0.18),
                0.11,
                0.12,
                graphite,
                vertices=10,
                bevel=0.022,
                rotation=(0.0, math.pi / 2.0, 0.0),
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Brute_{side}_upper_hydraulic",
                (x * 0.56, 0.58, -0.2),
                (0.14, 0.34, 0.16),
                steel,
                bevel=0.022,
                rotation=(0.0, 0.0, sign * -0.12),
            ),
            root,
        )
        _parent(
            _cylinder(
                collection,
                f"Brute_{side}_elbow_joint",
                (x * 0.58, 0.4, -0.22),
                0.08,
                0.13,
                graphite,
                vertices=10,
                bevel=0.016,
                rotation=(0.0, math.pi / 2.0, 0.0),
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Brute_{side}_ram_guard",
                (x * 0.55, 0.27, -0.24),
                (0.16, 0.2, 0.22),
                pink,
                bevel=0.03,
                rotation=(0.0, 0.0, sign * 0.1),
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Brute_{side}_warning_mark",
                (x * 0.64, 0.29, -0.25),
                (0.022, 0.08, 0.1),
                amber,
                bevel=0.005,
            ),
            root,
        )
    _parent(
        _box(
            collection,
            "Brute_upper_machinery",
            (0.0, 1.08, 0.05),
            (0.46, 0.28, 0.38),
            graphite_light,
            bevel=0.045,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_upper_armor",
            (0.0, 1.22, -0.02),
            (0.3, 0.24, 0.26),
            violet,
            bevel=0.04,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_upper_sensor",
            (0.0, 1.28, -0.17),
            (0.11, 0.02, 0.018),
            lime_hot,
            bevel=0.004,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_rear_left_vent",
            (-0.23, 0.73, 0.4),
            (0.18, 0.26, 0.07),
            amber,
            bevel=0.018,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_rear_right_vent",
            (0.23, 0.73, 0.4),
            (0.18, 0.26, 0.07),
            amber,
            bevel=0.018,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_mast",
            (0.0, 1.4, 0.04),
            (0.05, 0.16, 0.05),
            pink,
            bevel=0.012,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Brute_mast_marker",
            (0.0, 1.49, 0.04),
            (0.03, 0.02, 0.03),
            pink_hot,
            bevel=0.004,
        ),
        root,
    )
    root["role"] = "enemy_brute"
    root["forward_axis"] = "-Z"
    root["nominal_height"] = 1.5
    root["nominal_radius"] = 0.65
    return collection, root


def _build_turret(
    materials: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Collection, bpy.types.Object]:
    collection, root = _model_collection("EnemyTurret")
    violet = materials["violet"]
    violet_dark = materials["violet_dark"]
    pink = materials["pink"]
    pink_hot = materials["pink_hot"]
    graphite = materials["graphite"]
    graphite_light = materials["graphite_light"]
    steel = materials["steel"]
    amber = materials["amber"]
    lime_hot = materials["lime_hot"]

    # A fixed gun platform with a machined drum, armored sensor housing, and a
    # separate cannon cradle. There is no dome or face; the warm slit is a
    # single targeting instrument recessed into the front plate.
    _parent(
        _cylinder(
            collection,
            "Turret_base_drum",
            (0.0, 0.14, 0.0),
            0.48,
            0.28,
            graphite,
            vertices=12,
            bevel=0.045,
            rotation=(math.pi / 2.0, 0.0, 0.0),
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Turret_base_bearing",
            (0.0, 0.3, 0.0),
            0.36,
            0.08,
            violet_dark,
            vertices=12,
            bevel=0.02,
            rotation=(math.pi / 2.0, 0.0, 0.0),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Turret_lower_skirt",
            (0.0, 0.39, 0.02),
            (0.68, 0.18, 0.54),
            violet_dark,
            bevel=0.045,
        ),
        root,
    )
    _parent(
        _prism(
            collection,
            "Turret_angular_housing",
            [(-0.34, 0.2), (0.34, 0.2), (0.28, -0.28), (-0.28, -0.28)],
            0.42,
            0.76,
            violet,
            bevel=0.05,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Turret_front_armor",
            (0.0, 0.55, -0.31),
            (0.48, 0.28, 0.1),
            materials["steel"],
            bevel=0.028,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Turret_left_side_plate",
            (-0.35, 0.6, 0.02),
            (0.12, 0.28, 0.38),
            materials["graphite_light"],
            bevel=0.028,
            rotation=(0.0, 0.0, -0.16),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Turret_right_side_plate",
            (0.35, 0.6, 0.02),
            (0.12, 0.28, 0.38),
            graphite_light,
            bevel=0.028,
            rotation=(0.0, 0.0, 0.16),
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Turret_left_cradle_hinge",
            (-0.2, 0.73, -0.2),
            0.09,
            0.1,
            graphite,
            vertices=10,
            bevel=0.014,
            rotation=(0.0, math.pi / 2.0, 0.0),
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Turret_right_cradle_hinge",
            (0.2, 0.73, -0.2),
            0.09,
            0.1,
            graphite,
            vertices=10,
            bevel=0.014,
            rotation=(0.0, math.pi / 2.0, 0.0),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Turret_cannon_cradle",
            (0.0, 0.76, -0.28),
            (0.3, 0.18, 0.25),
            graphite_light,
            bevel=0.035,
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Turret_forward_barrel",
            (0.0, 0.76, -0.5),
            0.062,
            0.42,
            pink,
            vertices=10,
            bevel=0.012,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Turret_barrel_heat_guard",
            (0.0, 0.76, -0.43),
            (0.12, 0.12, 0.18),
            steel,
            bevel=0.02,
        ),
        root,
    )
    _parent(
        _torus(
            collection, "Turret_muzzle_ring", (0.0, 0.76, -0.73), 0.078, 0.012, pink_hot
        ),
        root,
    )
    _parent(
        _cylinder(
            collection,
            "Turret_muzzle",
            (0.0, 0.76, -0.74),
            0.038,
            0.022,
            graphite,
            vertices=10,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Turret_rear_counterweight",
            (0.0, 0.66, 0.31),
            (0.32, 0.2, 0.14),
            graphite_light,
            bevel=0.025,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Turret_rear_warning_mark",
            (0.0, 0.74, 0.39),
            (0.1, 0.04, 0.018),
            amber,
            bevel=0.004,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Turret_top_service_plate",
            (0.0, 0.87, 0.18),
            (0.22, 0.1, 0.2),
            violet_dark,
            bevel=0.02,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Turret_rear_status_bar",
            (0.0, 0.94, 0.3),
            (0.1, 0.018, 0.022),
            lime_hot,
            bevel=0.004,
        ),
        root,
    )
    for index, (x, z) in enumerate(
        ((-0.31, -0.27), (0.31, -0.27), (-0.31, 0.27), (0.31, 0.27))
    ):
        _parent(
            _box(
                collection,
                f"Turret_stabilizer_{index}",
                (x, 0.19, z),
                (0.14, 0.1, 0.2),
                graphite_light,
                bevel=0.018,
                rotation=(0.0, 0.0, (-1.0 if x < 0.0 else 1.0) * 0.12),
            ),
            root,
        )
    root["role"] = "enemy_turret"
    root["forward_axis"] = "-Z"
    root["nominal_height"] = 1.1
    root["nominal_radius"] = 0.5
    return collection, root


def _build_arena(
    materials: dict[str, bpy.types.Material],
) -> tuple[bpy.types.Collection, bpy.types.Object]:
    """Author the shared arena visuals exported to ``arena.glb``."""

    collection, root = _model_collection("ArenaArt")
    ink = materials["ink"]
    graphite = materials["graphite"]
    graphite_light = materials["graphite_light"]
    steel = materials["steel"]
    dark = materials["violet_dark"]
    rust = materials["pink"]
    rust_hot = materials["pink_hot"]
    warm = materials["lime"]
    warm_hot = materials["lime_hot"]
    amber = materials["amber"]

    # The inner play space is x +/- 12 by z +/- 8.  The thin floor body sits
    # just below y=0 so actor origins can remain exactly on the ground plane.
    _parent(
        _box(
            collection,
            "Arena_floor_slab",
            (0.0, -0.1, 0.0),
            (25.4, 0.2, 17.4),
            ink,
            bevel=0.1,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Arena_floor_deck",
            (0.0, 0.02, 0.0),
            (24.0, 0.07, 16.0),
            graphite,
            bevel=0.08,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Arena_floor_service_border",
            (0.0, 0.065, 0.0),
            (23.56, 0.035, 15.56),
            dark,
            bevel=0.035,
        ),
        root,
    )

    # Machined seams and drains give the deck a believable construction grid
    # while keeping the center clear for combat readability.
    for index, x in enumerate((-9.0, -4.5, 0.0, 4.5, 9.0)):
        _parent(
            _box(
                collection,
                f"Arena_deck_seam_vertical_{index}",
                (x, 0.087, 0.0),
                (0.026, 0.014, 15.1),
                graphite_light,
                bevel=0.004,
            ),
            root,
        )
    for index, z in enumerate((-5.6, -2.8, 2.8, 5.6)):
        _parent(
            _box(
                collection,
                f"Arena_deck_seam_horizontal_{index}",
                (0.0, 0.088, z),
                (22.6, 0.014, 0.026),
                graphite_light,
                bevel=0.004,
            ),
            root,
        )
    _parent(
        _box(
            collection,
            "Arena_center_service_seam_x",
            (0.0, 0.094, 0.0),
            (8.2, 0.016, 0.045),
            steel,
            bevel=0.006,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Arena_center_service_seam_z",
            (0.0, 0.095, 0.0),
            (0.045, 0.016, 5.0),
            steel,
            bevel=0.006,
        ),
        root,
    )
    for side, z in (("north", -6.96), ("south", 6.96)):
        _parent(
            _box(
                collection,
                f"Arena_drain_channel_{side}",
                (0.0, 0.105, z),
                (21.6, 0.026, 0.18),
                steel,
                bevel=0.018,
            ),
            root,
        )
        for index, x in enumerate((-9.0, -6.0, -3.0, 0.0, 3.0, 6.0, 9.0)):
            _parent(
                _box(
                    collection,
                    f"Arena_drain_grate_{side}_{index}",
                    (x, 0.122, z),
                    (0.06, 0.018, 0.31),
                    dark,
                    bevel=0.006,
                ),
                root,
            )
    for side, x in (("west", -10.96), ("east", 10.96)):
        _parent(
            _box(
                collection,
                f"Arena_drain_channel_{side}",
                (x, 0.105, 0.0),
                (0.18, 0.026, 13.6),
                steel,
                bevel=0.018,
            ),
            root,
        )
        for index, z in enumerate((-5.0, -2.5, 0.0, 2.5, 5.0)):
            _parent(
                _box(
                    collection,
                    f"Arena_drain_grate_{side}_{index}",
                    (x, 0.122, z),
                    (0.31, 0.018, 0.06),
                    dark,
                    bevel=0.006,
                ),
                root,
            )

    # Four rectangular maintenance plates orient the eye without reading as
    # bright team spawn discs or UI markers.
    for index, (x, z, angle) in enumerate(
        ((-8.7, -5.2, -0.08), (8.7, -5.2, 0.08), (-8.7, 5.2, 0.08), (8.7, 5.2, -0.08))
    ):
        _parent(
            _box(
                collection,
                f"Arena_service_plate_{index}",
                (x, 0.108, z),
                (2.4, 0.04, 1.1),
                graphite_light,
                bevel=0.035,
                rotation=(0.0, angle, 0.0),
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Arena_service_plate_inset_{index}",
                (x, 0.136, z),
                (1.74, 0.022, 0.58),
                dark,
                bevel=0.018,
                rotation=(0.0, angle, 0.0),
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Arena_service_plate_mark_{index}",
                (x - 0.68, 0.153, z),
                (0.18, 0.014, 0.04),
                rust,
                bevel=0.004,
                rotation=(0.0, angle, 0.0),
            ),
            root,
        )

    # Deep beveled wall blocks define the physical bounds without becoming a
    # neon frame. The dark face, steel cap, and tiny warning marks read as
    # fabricated chamber hardware in the top-down Godot camera.
    wall_specs = (
        ("north", (0.0, 0.76, -8.27), (25.4, 1.52, 0.6)),
        ("south", (0.0, 0.76, 8.27), (25.4, 1.52, 0.6)),
        ("west", (-12.27, 0.76, 0.0), (0.6, 1.52, 16.0)),
        ("east", (12.27, 0.76, 0.0), (0.6, 1.52, 16.0)),
    )
    for side, location, dimensions in wall_specs:
        _parent(
            _box(
                collection,
                f"Arena_wall_{side}",
                location,
                dimensions,
                graphite,
                bevel=0.1,
            ),
            root,
        )

    for side, z in (("north", -7.96), ("south", 7.96)):
        for index, x in enumerate((-9.5, -4.75, 0.0, 4.75, 9.5)):
            _parent(
                _box(
                    collection,
                    f"Arena_wall_panel_{side}_{index}",
                    (x, 0.84, z),
                    (3.8, 0.82, 0.045),
                    dark,
                    bevel=0.04,
                ),
                root,
            )
            _parent(
                _box(
                    collection,
                    f"Arena_wall_rib_{side}_{index}",
                    (
                        x + (1.62 if index % 2 == 0 else -1.62),
                        0.82,
                        z - (0.035 if side == "north" else -0.035),
                    ),
                    (0.1, 0.92, 0.03),
                    steel,
                    bevel=0.012,
                ),
                root,
            )
    for side, x in (("west", -11.96), ("east", 11.96)):
        for index, z in enumerate((-5.2, -1.75, 1.75, 5.2)):
            _parent(
                _box(
                    collection,
                    f"Arena_wall_panel_{side}_{index}",
                    (x, 0.84, z),
                    (0.045, 0.82, 2.65),
                    dark,
                    bevel=0.04,
                ),
                root,
            )
            _parent(
                _box(
                    collection,
                    f"Arena_wall_rib_{side}_{index}",
                    (
                        x - (0.035 if side == "east" else -0.035),
                        0.82,
                        z + (1.05 if index % 2 == 0 else -1.05),
                    ),
                    (0.03, 0.92, 0.1),
                    steel,
                    bevel=0.012,
                ),
                root,
            )

    # Recessed warm-white strips are the sole perimeter illumination cue.
    for side, location, dimensions in (
        ("north", (0.0, 0.31, -7.94), (22.8, 0.07, 0.045)),
        ("south", (0.0, 0.31, 7.94), (22.8, 0.07, 0.045)),
        ("west", (-11.94, 0.31, 0.0), (0.045, 0.07, 14.8)),
        ("east", (11.94, 0.31, 0.0), (0.045, 0.07, 14.8)),
    ):
        _parent(
            _box(
                collection,
                f"Arena_recessed_strip_{side}",
                location,
                dimensions,
                warm_hot,
                bevel=0.012,
            ),
            root,
        )

    for side, location, dimensions in (
        ("north", (0.0, 1.5, -7.99), (24.0, 0.11, 0.13)),
        ("south", (0.0, 1.5, 7.99), (24.0, 0.11, 0.13)),
        ("west", (-11.99, 1.5, 0.0), (0.13, 0.11, 15.0)),
        ("east", (11.99, 1.5, 0.0), (0.13, 0.11, 15.0)),
    ):
        _parent(
            _box(
                collection,
                f"Arena_wall_cap_{side}",
                location,
                dimensions,
                steel,
                bevel=0.025,
            ),
            root,
        )

    # Faceted corner service pylons stay below the collision wall height and
    # give the chamber a visible silhouette without obstructing play.
    for index, (x, z) in enumerate(
        ((-11.5, -7.5), (11.5, -7.5), (-11.5, 7.5), (11.5, 7.5))
    ):
        _parent(
            _prism(
                collection,
                f"Arena_corner_pylon_{index}",
                ((-0.28, -0.23), (0.24, -0.3), (0.3, 0.24), (-0.22, 0.3)),
                0.0,
                1.5,
                graphite_light,
                bevel=0.05,
            ),
            root,
        ).location = _to_blender_location((x, 0.0, z))
        _parent(
            _box(
                collection,
                f"Arena_corner_pylon_cap_{index}",
                (x, 1.46, z),
                (0.38, 0.07, 0.38),
                rust_hot if index == 3 else steel,
                bevel=0.025,
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Arena_corner_pylon_light_{index}",
                (x, 0.84, z - 0.3),
                (0.07, 0.26, 0.025),
                warm,
                bevel=0.008,
            ),
            root,
        )

    # Structural context sits outside the playable rectangle. Its asymmetry
    # makes the Blender source feel like a real chamber while gameplay remains
    # bounded by the uniform collision contract in arena.gd.
    for index, (x, z, dims, angle, material) in enumerate(
        (
            (-13.35, -6.65, (0.62, 2.55, 1.1), -0.14, steel),
            (13.38, -3.0, (0.72, 2.0, 1.5), 0.09, graphite_light),
            (-5.8, 9.35, (3.2, 0.62, 0.48), 0.05, graphite_light),
            (7.6, 9.28, (1.8, 0.48, 0.66), -0.12, steel),
        )
    ):
        _parent(
            _box(
                collection,
                f"Arena_outer_structure_{index}",
                (x, dims[1] * 0.5, z),
                dims,
                material,
                bevel=0.06,
                rotation=(0.0, angle, 0.0),
            ),
            root,
        )
    _parent(
        _box(
            collection,
            "Arena_outer_brace_north",
            (-8.0, 1.2, -9.35),
            (0.28, 2.4, 0.28),
            rust,
            bevel=0.04,
            rotation=(0.0, 0.0, -0.25),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Arena_outer_brace_east",
            (13.35, 0.95, 4.8),
            (0.3, 1.9, 0.3),
            rust,
            bevel=0.04,
            rotation=(0.0, 0.0, 0.32),
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Arena_outer_dock",
            (10.5, 0.18, -9.2),
            (4.8, 0.24, 0.85),
            dark,
            bevel=0.06,
        ),
        root,
    )
    for index, x in enumerate((9.0, 10.0, 11.0, 12.0)):
        _parent(
            _box(
                collection,
                f"Arena_outer_dock_seam_{index}",
                (x, 0.32, -9.2),
                (0.035, 0.04, 0.76),
                graphite_light,
                bevel=0.006,
            ),
            root,
        )

    # Sparse warning marks break up long steel faces; they are deliberately
    # subdued and never become team-color indicators.
    for index, (x, z) in enumerate(
        ((-9.7, -8.0), (4.9, -8.0), (-12.0, 4.6), (12.0, -4.6))
    ):
        _parent(
            _box(
                collection,
                f"Arena_warning_mark_{index}",
                (x, 0.58, z),
                (0.34, 0.08, 0.035),
                amber,
                bevel=0.006,
            ),
            root,
        )

    root["role"] = "arena_visual"
    root["inner_width"] = 24.0
    root["inner_depth"] = 16.0
    root["wall_height"] = 1.5
    return collection, root


def _build_showroom(
    materials: dict[str, bpy.types.Material],
    arena_root: bpy.types.Object,
    roots: list[bpy.types.Object],
) -> None:
    scene = bpy.context.scene
    showroom = bpy.data.collections.new("Showroom")
    scene.collection.children.link(showroom)
    arena_root.location = _to_blender_location((0.0, 0.0, 0.0))
    display_positions = [
        (-5.8, 0.0, 3.4),
        (-2.6, 0.0, -2.2),
        (2.4, 0.0, -2.3),
        (6.0, 0.0, 2.4),
        (0.0, 0.0, 0.7),
    ]
    for root, position in zip(roots, display_positions, strict=True):
        root.location = _to_blender_location(position)

    camera_data = bpy.data.cameras.new("ShowroomCamera")
    camera = bpy.data.objects.new("ShowroomCamera", camera_data)
    showroom.objects.link(camera)
    camera.location = _to_blender_location((0.0, 21.5, -19.0))
    camera.rotation_euler = (
        (_to_blender_location((0.0, 0.0, 0.0)) - camera.location)
        .to_track_quat("-Z", "Y")
        .to_euler()
    )
    camera_data.lens = 47.0
    camera_data.clip_end = 100.0
    scene.camera = camera
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            space = area.spaces.active
            space.shading.type = "MATERIAL"
            space.shading.color_type = "MATERIAL"
            space.shading.use_scene_lights = True
            space.shading.use_scene_world = True
            space.shading.show_shadows = True
            space.shading.show_cavity = True
            space.overlay.show_overlays = False
            space.region_3d.view_perspective = "CAMERA"
            space.region_3d.view_camera_zoom = 0.85

    key_data = bpy.data.lights.new("ShowroomKey", type="AREA")
    key_data.energy = 1180.0
    key_data.shape = "DISK"
    key_data.size = 6.0
    key = bpy.data.objects.new("ShowroomKey", key_data)
    showroom.objects.link(key)
    key.location = _to_blender_location((-5.0, 12.0, -5.0))
    key.rotation_euler = (
        (_to_blender_location((0.0, 0.0, 0.0)) - key.location)
        .to_track_quat("-Z", "Y")
        .to_euler()
    )

    fill_data = bpy.data.lights.new("ShowroomFill", type="AREA")
    fill_data.energy = 430.0
    fill_data.color = (0.68, 0.62, 0.52)
    fill_data.shape = "RECTANGLE"
    fill_data.size = 5.0
    fill = bpy.data.objects.new("ShowroomFill", fill_data)
    showroom.objects.link(fill)
    fill.location = _to_blender_location((7.0, 7.0, 5.0))
    fill.rotation_euler = (
        (_to_blender_location((0.0, 0.0, 0.0)) - fill.location)
        .to_track_quat("-Z", "Y")
        .to_euler()
    )

    rim_data = bpy.data.lights.new("ShowroomRim", type="AREA")
    rim_data.energy = 520.0
    rim_data.color = (0.9, 0.58, 0.36)
    rim_data.shape = "RECTANGLE"
    rim_data.size = 7.0
    rim = bpy.data.objects.new("ShowroomRim", rim_data)
    showroom.objects.link(rim)
    rim.location = _to_blender_location((-8.0, 6.0, 8.0))
    rim.rotation_euler = (
        (_to_blender_location((0.0, 0.7, 0.0)) - rim.location)
        .to_track_quat("-Z", "Y")
        .to_euler()
    )

    scene.world.color = (0.008, 0.009, 0.01)
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 700
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False


def _configure_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 700
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    if scene.world is None:
        scene.world = bpy.data.worlds.new("RICOCHET_World")
    scene.world.color = (0.01, 0.015, 0.03)


def _select_hierarchy(root: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for descendant in bpy.data.objects:
        current = descendant.parent
        while current is not None:
            if current == root:
                descendant.select_set(True)
                break
            current = current.parent
    bpy.context.view_layer.objects.active = root


def _export_model(
    root: bpy.types.Object, file_path: Path, display_location: Vector
) -> None:
    root.location = Vector((0.0, 0.0, 0.0))
    bpy.context.view_layer.update()
    _select_hierarchy(root)
    bpy.ops.export_scene.gltf(
        filepath=str(file_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="EXPORT",
        export_texcoords=False,
        export_normals=True,
        export_tangents=False,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_morph=False,
        export_extras=True,
        export_yup=True,
        export_loglevel=-1,
    )
    root.location = display_location
    bpy.ops.object.select_all(action="DESELECT")


def main() -> None:
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    SOURCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _configure_scene()
    materials = _materials()
    model_builders = [
        _build_player,
        _build_chaser,
        _build_runner,
        _build_brute,
        _build_turret,
    ]
    built_models = [builder(materials) for builder in model_builders]
    roots = [root for _, root in built_models]
    _, arena_root = _build_arena(materials)
    _build_showroom(materials, arena_root, roots)
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE_PATH))

    display_locations = [root.location.copy() for root in roots]
    export_names = [
        "player.glb",
        "enemy_chaser.glb",
        "enemy_runner.glb",
        "enemy_brute.glb",
        "enemy_turret.glb",
    ]
    _export_model(
        arena_root, OUTPUT_DIRECTORY / "arena.glb", arena_root.location.copy()
    )
    for root, display_location, export_name in zip(
        roots, display_locations, export_names, strict=True
    ):
        _export_model(root, OUTPUT_DIRECTORY / export_name, display_location)

    print(f"RICOCHET art source: {SOURCE_PATH}")
    for export_name in export_names:
        print(f"RICOCHET art export: {OUTPUT_DIRECTORY / export_name}")


if __name__ == "__main__":
    main()
