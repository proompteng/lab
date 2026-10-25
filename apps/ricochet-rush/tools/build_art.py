"""Build and export the RICOCHET RUSH combat robot art set.

Run from any directory with:

    blender --background --python tools/build_art.py -- [output-directory]

Custom armor meshes, rigid articulation pivots, and baked Principled materials
remain portable across Godot's Compatibility renderer and the Web export.
Every model is authored in the same coordinate system and exported at a fixed
scale. The editable Blender scene includes the generated concept reference.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Vector


APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT / "tools"))
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
    "ink": _color("0B1013"),
    "graphite": _color("242A2C"),
    "graphite_light": _color("58615F"),
    "steel": _color("6D746E"),
    "ceramic": _color("D6D1C6"),
    "ceramic_shadow": _color("89847B"),
    "lime": _color("B09B65"),
    "lime_hot": _color("D2B779"),
    "cyan": _color("5FE4EF"),
    "violet": _color("565747"),
    "violet_dark": _color("1C2325"),
    "pink": _color("754437"),
    "pink_hot": _color("A56546"),
    "amber": _color("B17C4E"),
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
        "ceramic": _material("MAT_player_ceramic", PALETTE["ceramic"], roughness=0.48),
        "ceramic_shadow": _material(
            "MAT_player_ceramic_shadow", PALETTE["ceramic_shadow"], roughness=0.52
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
    topology = bmesh.new()
    topology.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(topology, faces=list(topology.faces))
    topology.to_mesh(obj.data)
    topology.free()
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


def _parent_preserve_world(
    obj: bpy.types.Object, parent: bpy.types.Object
) -> bpy.types.Object:
    """Parent an authored part without changing its already placed pose."""

    bpy.context.view_layer.update()
    matrix_world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = matrix_world
    return obj


def _pivot(
    collection: bpy.types.Collection,
    root: bpy.types.Object,
    name: str,
    location: tuple[float, float, float],
) -> bpy.types.Object:
    """Create an exported animation pivot at a game-space coordinate."""

    pivot = bpy.data.objects.new(name, None)
    pivot.empty_display_type = "ARROWS"
    pivot.empty_display_size = 0.09
    collection.objects.link(pivot)
    pivot.parent = root
    pivot.location = _to_blender_location(location)
    pivot["role"] = "pivot"
    pivot["contract_name"] = name
    return pivot


def _beam_between(
    collection: bpy.types.Collection,
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius: float,
    material: bpy.types.Material,
    *,
    vertices: int = 8,
    bevel: float = 0.0,
) -> bpy.types.Object:
    """Place a cylindrical actuator along two game-space points."""

    start_vector = Vector(start)
    end_vector = Vector(end)
    midpoint = (start_vector + end_vector) * 0.5
    direction = end_vector - start_vector
    blender_direction = _GAME_TO_BLENDER @ direction
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=direction.length,
        end_fill_type="NGON",
        location=_to_blender_location(midpoint),
        rotation=blender_direction.to_track_quat("Z", "Y").to_euler(),
    )
    obj = bpy.context.object
    obj.name = name
    return _finish_mesh(obj, collection, material, bevel=bevel, segments=2)


def _model_collection(name: str) -> tuple[bpy.types.Collection, bpy.types.Object]:
    collection = bpy.data.collections.new(f"{name}_ART")
    bpy.context.scene.collection.children.link(collection)
    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "CUBE"
    root.empty_display_size = 0.08
    collection.objects.link(root)
    return collection, root


def _attach(obj: bpy.types.Object, parent: bpy.types.Object) -> bpy.types.Object:
    return _parent_preserve_world(obj, parent)


def _build_player(materials: dict[str, bpy.types.Material]):
    from hero import build_player

    return build_player(sys.modules[__name__], materials)


def _build_chaser(materials: dict[str, bpy.types.Material]):
    from mechs import build_enemy

    return build_enemy(sys.modules[__name__], materials, "chaser")


def _build_runner(materials: dict[str, bpy.types.Material]):
    from mechs import build_enemy

    return build_enemy(sys.modules[__name__], materials, "runner")


def _build_brute(materials: dict[str, bpy.types.Material]):
    from mechs import build_enemy

    return build_enemy(sys.modules[__name__], materials, "brute")


def _build_turret(materials: dict[str, bpy.types.Material]):
    from mechs import build_enemy

    return build_enemy(sys.modules[__name__], materials, "turret")


def _merge_static_meshes(root: bpy.types.Object) -> None:
    """Join direct static siblings by material while retaining animation pivots."""

    hierarchy = [root]
    for obj in bpy.data.objects:
        if obj == root or obj.type != "EMPTY":
            continue
        current = obj.parent
        while current is not None and current != root:
            current = current.parent
        if current == root:
            hierarchy.append(obj)
    for parent in hierarchy:
        grouped: dict[str, list[bpy.types.Object]] = {}
        for child in list(parent.children):
            if child.type != "MESH" or not child.data.materials:
                continue
            material_name = child.data.materials[0].name
            grouped.setdefault(material_name, []).append(child)
        for material_name, meshes in grouped.items():
            if len(meshes) < 2:
                continue
            bpy.ops.object.select_all(action="DESELECT")
            for mesh in meshes:
                mesh.select_set(True)
            bpy.context.view_layer.objects.active = meshes[0]
            bpy.ops.object.join()
            meshes[0].name = f"{root.name}_{parent.name}_{material_name}_static"
            meshes[0].select_set(False)


def _descendants(root: bpy.types.Object) -> list[bpy.types.Object]:
    descendants: list[bpy.types.Object] = []
    for obj in bpy.data.objects:
        current = obj.parent
        while current is not None and current != root:
            current = current.parent
        if current == root:
            descendants.append(obj)
    return descendants


def _export_pivot_names(root: bpy.types.Object) -> list[tuple[bpy.types.Object, str]]:
    """Temporarily make contract pivots exact and unique for one GLB export."""

    all_pivots = [obj for obj in bpy.data.objects if obj.get("role") == "pivot"]
    saved_names = [(obj, obj.name) for obj in all_pivots]
    for index, (obj, _) in enumerate(saved_names):
        obj.name = f"__pivot_export_{index}"
    for obj in _descendants(root):
        if obj.get("role") != "pivot":
            continue
        contract_name = obj.get("contract_name")
        if contract_name:
            obj.name = str(contract_name)
    return saved_names


def _restore_pivot_names(saved_names: list[tuple[bpy.types.Object, str]]) -> None:
    for index, (obj, original_name) in enumerate(saved_names):
        obj.name = f"__pivot_restore_{index}"
    for obj, original_name in saved_names:
        obj.name = original_name


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
    # fabricated chamber hardware in the third-person camera.
    wall_specs = (
        ("north", (0.0, 2.5, -8.27), (25.4, 5.0, 0.6)),
        ("south", (0.0, 2.5, 8.27), (25.4, 5.0, 0.6)),
        ("west", (-12.27, 2.5, 0.0), (0.6, 5.0, 16.0)),
        ("east", (12.27, 2.5, 0.0), (0.6, 5.0, 16.0)),
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

    # Upper wall bays carry the eye toward the ceiling. Each bay is a shallow
    # inset with a contrasting service rib, so the chamber reads as assembled
    # panels instead of a single unbroken cube.
    for side, z in (("north", -7.94), ("south", 7.94)):
        for index, x in enumerate((-9.5, -4.75, 0.0, 4.75, 9.5)):
            _parent(
                _box(
                    collection,
                    f"Arena_wall_upper_panel_{side}_{index}",
                    (x, 2.8, z),
                    (3.8, 2.75, 0.045),
                    dark,
                    bevel=0.05,
                ),
                root,
            )
            _parent(
                _box(
                    collection,
                    f"Arena_wall_upper_rib_{side}_{index}",
                    (
                        x + (1.5 if index % 2 == 0 else -1.5),
                        2.8,
                        z - (0.04 if side == "north" else -0.04),
                    ),
                    (0.14, 2.9, 0.05),
                    steel,
                    bevel=0.018,
                ),
                root,
            )
    for side, x in (("west", -11.96), ("east", 11.96)):
        for index, z in enumerate((-5.2, -1.75, 1.75, 5.2)):
            _parent(
                _box(
                    collection,
                    f"Arena_wall_upper_panel_{side}_{index}",
                    (x, 2.8, z),
                    (0.045, 2.75, 2.65),
                    dark,
                    bevel=0.05,
                ),
                root,
            )
            _parent(
                _box(
                    collection,
                    f"Arena_wall_upper_rib_{side}_{index}",
                    (
                        x - (0.04 if side == "east" else -0.04),
                        2.8,
                        z + (1.0 if index % 2 == 0 else -1.0),
                    ),
                    (0.05, 2.9, 0.14),
                    steel,
                    bevel=0.018,
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
        ("north", (0.0, 4.92, -7.99), (24.0, 0.11, 0.13)),
        ("south", (0.0, 4.92, 7.99), (24.0, 0.11, 0.13)),
        ("west", (-11.99, 4.92, 0.0), (0.13, 0.11, 15.0)),
        ("east", (11.99, 4.92, 0.0), (0.13, 0.11, 15.0)),
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

    # Faceted corner service pylons sit in the wall line and give the chamber a
    # visible silhouette without obstructing the clear combat floor.
    for index, (x, z) in enumerate(
        ((-11.5, -7.5), (11.5, -7.5), (-11.5, 7.5), (11.5, 7.5))
    ):
        _parent(
            _prism(
                collection,
                f"Arena_corner_pylon_{index}",
                ((-0.28, -0.23), (0.24, -0.3), (0.3, 0.24), (-0.22, 0.3)),
                0.0,
                4.85,
                graphite_light,
                bevel=0.05,
            ),
            root,
        ).location = _to_blender_location((x, 0.0, z))
        _parent(
            _box(
                collection,
                f"Arena_corner_pylon_cap_{index}",
                (x, 4.84, z),
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
                (x, 2.7, z - 0.3),
                (0.07, 0.26, 0.025),
                warm,
                bevel=0.008,
            ),
            root,
        )

    # Tall corner columns, overhead trusses, and a suspended service gantry
    # provide the vertical scale that a close third-person camera needs. All
    # supports remain outside the playable rectangle; only their silhouettes
    # and the ceiling are visible above the clear arena floor.
    for index, (x, z) in enumerate(
        ((-12.58, -8.42), (12.58, -8.42), (-12.58, 8.42), (12.58, 8.42))
    ):
        _parent(
            _box(
                collection,
                f"Arena_structural_column_{index}",
                (x, 2.72, z),
                (0.7, 5.45, 0.7),
                graphite,
                bevel=0.085,
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Arena_structural_column_base_{index}",
                (x, 0.28, z),
                (1.05, 0.5, 1.05),
                steel,
                bevel=0.08,
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Arena_structural_column_cap_{index}",
                (x, 5.48, z),
                (0.98, 0.22, 0.98),
                graphite_light,
                bevel=0.045,
            ),
            root,
        )

    for index, z in enumerate((-6.4, -2.2, 2.2, 6.4)):
        _parent(
            _box(
                collection,
                f"Arena_ceiling_truss_{index}",
                (0.0, 5.35, z),
                (24.4, 0.22, 0.22),
                graphite_light,
                bevel=0.035,
            ),
            root,
        )
        for x in (-9.0, -3.0, 3.0, 9.0):
            _parent(
                _box(
                    collection,
                    f"Arena_ceiling_truss_post_{index}_{x:g}",
                    (x, 5.05, z),
                    (0.13, 0.62, 0.13),
                    steel,
                    bevel=0.018,
                    rotation=(0.0, 0.0, math.radians(9.0 if index % 2 == 0 else -9.0)),
                ),
                root,
            )
    for x in (-8.0, 0.0, 8.0):
        _parent(
            _box(
                collection,
                f"Arena_crossbeam_{x:g}",
                (x, 5.56, 0.0),
                (0.24, 0.22, 16.1),
                graphite,
                bevel=0.035,
            ),
            root,
        )
    for index, x in enumerate((-8.0, 0.0, 8.0)):
        _parent(
            _box(
                collection,
                f"Arena_crossbeam_light_{index}",
                (x, 5.42, 0.0),
                (0.08, 0.025, 10.4),
                warm_hot,
                bevel=0.008,
            ),
            root,
        )
    for index, z in enumerate((-6.4, -2.2, 2.2, 6.4)):
        _parent(
            _box(
                collection,
                f"Arena_ceiling_panel_{index}",
                (0.0, 5.78, z),
                (24.0, 0.08, 3.72),
                dark,
                bevel=0.04,
            ),
            root,
        )

    gantry_x, gantry_y, gantry_z = 0.0, 4.45, -5.25
    _parent(
        _box(
            collection,
            "Arena_suspended_gantry_beam",
            (gantry_x, gantry_y, gantry_z),
            (6.6, 0.28, 0.34),
            graphite_light,
            bevel=0.04,
        ),
        root,
    )
    for index, x in enumerate((-2.65, 2.65)):
        _parent(
            _box(
                collection,
                f"Arena_gantry_hanger_{index}",
                (x, 4.05, gantry_z),
                (0.16, 0.9, 0.16),
                steel,
                bevel=0.025,
            ),
            root,
        )
        _parent(
            _box(
                collection,
                f"Arena_gantry_brace_{index}",
                (x, 4.06, gantry_z + (0.34 if index == 0 else -0.34)),
                (0.13, 0.72, 0.13),
                rust,
                bevel=0.018,
                rotation=(math.radians(22.0 if index == 0 else -22.0), 0.0, 0.0),
            ),
            root,
        )
    _parent(
        _box(
            collection,
            "Arena_suspended_reactor",
            (gantry_x, 3.7, gantry_z),
            (1.35, 0.7, 0.9),
            graphite,
            bevel=0.085,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Arena_suspended_reactor_face",
            (gantry_x, 3.7, gantry_z + 0.47),
            (0.72, 0.32, 0.04),
            steel,
            bevel=0.025,
        ),
        root,
    )
    _parent(
        _box(
            collection,
            "Arena_suspended_reactor_indicator",
            (gantry_x, 3.82, gantry_z + 0.5),
            (0.24, 0.045, 0.025),
            warm,
            bevel=0.006,
        ),
        root,
    )

    # Conduit trays hug the upper wall line. Repeated brackets and drop
    # elbows keep the vertical walls detailed while leaving the center open.
    for side, z in (("north", -7.73), ("south", 7.73)):
        _parent(
            _box(
                collection,
                f"Arena_conduit_tray_{side}",
                (0.0, 4.52, z),
                (21.8, 0.34, 0.28),
                dark,
                bevel=0.045,
            ),
            root,
        )
        for index, x in enumerate((-9.0, -4.5, 0.0, 4.5, 9.0)):
            _parent(
                _box(
                    collection,
                    f"Arena_conduit_clamp_{side}_{index}",
                    (x, 4.32, z),
                    (0.16, 0.42, 0.36),
                    steel,
                    bevel=0.02,
                ),
                root,
            )
    for side, x in (("west", -11.73), ("east", 11.73)):
        _parent(
            _box(
                collection,
                f"Arena_conduit_tray_{side}",
                (x, 4.52, 0.0),
                (0.28, 0.34, 13.8),
                dark,
                bevel=0.045,
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
    root["wall_height"] = 5.0
    return collection, root


def _build_showroom(
    materials: dict[str, bpy.types.Material],
    arena_root: bpy.types.Object,
    roots: list[bpy.types.Object],
) -> None:
    scene = bpy.context.scene
    showroom = bpy.data.collections.new("Showroom")
    scene.collection.children.link(showroom)
    concept_path = APP_ROOT / "art" / "concepts" / "mech-model-sheet-v1.png"
    if concept_path.is_file():
        concept_image = bpy.data.images.load(str(concept_path), check_existing=True)
        concept_image.pack()
        concept_image.filepath = "//../concepts/mech-model-sheet-v1.png"
        concept_reference = bpy.data.objects.new("ConceptReference_MechSheet", None)
        concept_reference.empty_display_type = "IMAGE"
        concept_reference.data = concept_image
        concept_reference.empty_display_size = 3.8
        concept_reference.color[3] = 0.42
        concept_reference.hide_render = True
        concept_reference.location = _to_blender_location((15.0, 2.0, -1.0))
        showroom.objects.link(concept_reference)
    arena_root.location = _to_blender_location((0.0, 0.0, 0.0))
    # The source scene is a playable third-person composition: the player is
    # foregrounded near the camera and the other silhouettes recede into the
    # chamber. This makes opening the .blend useful for art review instead of
    # showing an overhead asset lineup.
    display_positions = [
        (0.0, 0.0, 3.4),
        (-3.2, 0.0, -1.2),
        (3.6, 0.0, -2.5),
        (-4.6, 0.0, -5.1),
        (5.2, 0.0, -4.2),
    ]
    for root, position in zip(roots, display_positions, strict=True):
        root.location = _to_blender_location(position)

    camera_data = bpy.data.cameras.new("ShowroomCamera")
    camera = bpy.data.objects.new("ShowroomCamera", camera_data)
    showroom.objects.link(camera)
    camera.location = _to_blender_location((1.35, 2.05, 6.9))
    camera.rotation_euler = (
        (_to_blender_location((0.0, 0.94, 3.4)) - camera.location)
        .to_track_quat("-Z", "Y")
        .to_euler()
    )
    camera_data.lens = 36.0
    camera_data.passepartout_alpha = 0.9
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
            space.region_3d.view_camera_zoom = 14.0

    key_data = bpy.data.lights.new("ShowroomKey", type="AREA")
    key_data.energy = 1450.0
    key_data.shape = "DISK"
    key_data.size = 6.0
    key = bpy.data.objects.new("ShowroomKey", key_data)
    showroom.objects.link(key)
    key.location = _to_blender_location((-5.0, 8.5, 3.0))
    key.rotation_euler = (
        (_to_blender_location((0.0, 0.8, -2.5)) - key.location)
        .to_track_quat("-Z", "Y")
        .to_euler()
    )

    fill_data = bpy.data.lights.new("ShowroomFill", type="AREA")
    fill_data.energy = 620.0
    fill_data.color = (0.55, 0.68, 0.82)
    fill_data.shape = "RECTANGLE"
    fill_data.size = 5.0
    fill = bpy.data.objects.new("ShowroomFill", fill_data)
    showroom.objects.link(fill)
    fill.location = _to_blender_location((6.0, 5.5, 1.5))
    fill.rotation_euler = (
        (_to_blender_location((0.0, 1.0, -2.0)) - fill.location)
        .to_track_quat("-Z", "Y")
        .to_euler()
    )

    rim_data = bpy.data.lights.new("ShowroomRim", type="AREA")
    rim_data.energy = 760.0
    rim_data.color = (0.92, 0.52, 0.28)
    rim_data.shape = "RECTANGLE"
    rim_data.size = 7.0
    rim = bpy.data.objects.new("ShowroomRim", rim_data)
    showroom.objects.link(rim)
    rim.location = _to_blender_location((-7.0, 4.5, -6.5))
    rim.rotation_euler = (
        (_to_blender_location((0.0, 1.0, -2.5)) - rim.location)
        .to_track_quat("-Z", "Y")
        .to_euler()
    )

    # Use a real procedural sky for reflections in the Blender source. The
    # modeled chamber blocks the horizon in the review camera, while this sky
    # keeps ceramic and steel from reading as flat gray under ambient-only
    # lighting.
    if scene.world is None:
        scene.world = bpy.data.worlds.new("RICOCHET_World")
    scene.world.use_nodes = True
    world_nodes = scene.world.node_tree.nodes
    world_links = scene.world.node_tree.links
    world_nodes.clear()
    world_output = world_nodes.new("ShaderNodeOutputWorld")
    world_background = world_nodes.new("ShaderNodeBackground")
    world_sky = world_nodes.new("ShaderNodeTexSky")
    world_sky.sky_type = "MULTIPLE_SCATTERING"
    world_sky.sun_elevation = math.radians(34.0)
    world_sky.sun_rotation = math.radians(142.0)
    world_sky.altitude = 0.35
    world_sky.air_density = 1.15
    world_background.inputs["Strength"].default_value = 0.32
    world_links.new(world_sky.outputs["Color"], world_background.inputs["Color"])
    world_links.new(
        world_background.outputs["Background"], world_output.inputs["Surface"]
    )
    scene.world.color = (0.02, 0.028, 0.036)
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
    saved_pivot_names = _export_pivot_names(root)
    try:
        _select_hierarchy(root)
        bpy.ops.export_scene.gltf(
            filepath=str(file_path),
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_materials="EXPORT",
            export_texcoords=True,
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
    finally:
        _restore_pivot_names(saved_pivot_names)
        root.location = display_location
        bpy.ops.object.select_all(action="DESELECT")


def main() -> None:
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    SOURCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _configure_scene()
    from surfaces import apply_paint, project_uvs

    materials = _materials()
    apply_paint(materials, APP_ROOT / "art" / "textures")
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
    for root in [*roots, arena_root]:
        _merge_static_meshes(root)
        project_uvs(root)
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
