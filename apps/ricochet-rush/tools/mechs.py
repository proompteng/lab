"""Angular enemy silhouettes matching the four roles on the model sheet."""

import math

import bpy
from mathutils import Vector


def build_enemy(art, materials, role):
    collection, root = art._model_collection(f"Enemy{role.title()}")
    dark = materials["graphite"]
    steel = materials["graphite_light"]
    black = materials["ink"]
    light = materials["lime_hot"]
    paint = materials[
        {
            "chaser": "pink",
            "runner": "violet_dark",
            "brute": "violet",
            "turret": "steel",
        }[role]
    ]

    def box(name, at, size, mat, parent, bevel=0.014):
        return art._attach(
            art._box(collection, name, at, size, mat, bevel=bevel), parent
        )

    def rod(name, start, end, radius, mat, parent, vertices=16):
        obj = art._beam_between(
            collection, name, start, end, radius, mat, vertices=vertices, bevel=0.005
        )
        for polygon in obj.data.polygons:
            polygon.use_smooth = len(polygon.vertices) == 4
        return art._attach(obj, parent)

    def plate(name, points, thickness, mat, parent):
        vertices = [tuple(art._to_blender_location(p)) for p in points]
        vertices += [
            tuple(art._to_blender_location(Vector(p) + Vector(thickness)))
            for p in points
        ]
        n = len(points)
        faces = [tuple(reversed(range(n))), tuple(range(n, n * 2))]
        faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        collection.objects.link(obj)
        return art._attach(
            art._finish_mesh(obj, collection, mat, bevel=0.012, segments=2), parent
        )

    def hull(name, rings, mat, parent):
        points = []
        for y, width, front, back in rings:
            corner = min(0.055, width * 0.20)
            outline = [
                (-width + corner, front),
                (width - corner, front),
                (width, front + corner),
                (width, back - corner),
                (width - corner, back),
                (-width + corner, back),
                (-width, back - corner),
                (-width, front + corner),
            ]
            points += [tuple(art._to_blender_location((x, y, z))) for x, z in outline]
        faces = [tuple(reversed(range(8))), tuple(range(len(points) - 8, len(points)))]
        for ring in range(len(rings) - 1):
            for i in range(8):
                a, b = ring * 8 + i, ring * 8 + (i + 1) % 8
                faces.append((a, b, b + 8, a + 8))
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(points, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        collection.objects.link(obj)
        return art._attach(
            art._finish_mesh(obj, collection, mat, bevel=0.013, segments=2), parent
        )

    def leg(name, hip, knee, ankle, heavy=False):
        pivot = art._pivot(collection, root, f"Leg_{name}", hip)
        knuckle = art._pivot(collection, root, f"Knee_{name}", knee)
        art._parent_preserve_world(knuckle, pivot)
        radius = 0.065 if heavy else 0.041
        x, y, z = hip
        rod(
            f"{name}_hip",
            (x - 0.09, y, z),
            (x + 0.09, y, z),
            radius * 1.45,
            steel,
            pivot,
        )
        rod(f"{name}_upper_link", hip, knee, radius, dark, pivot)
        rod(
            f"{name}_upper_piston",
            (x + 0.065, y - 0.025, z),
            (knee[0] + 0.065, knee[1] + 0.04, knee[2]),
            radius * 0.35,
            steel,
            pivot,
        )
        x, y, z = knee
        rod(
            f"{name}_knee",
            (x - 0.085, y, z),
            (x + 0.085, y, z),
            radius * 1.45,
            dark,
            knuckle,
        )
        rod(
            f"{name}_knee_cap",
            (x + 0.085, y, z),
            (x + 0.10, y, z),
            radius,
            steel,
            knuckle,
        )
        rod(f"{name}_lower_link", knee, ankle, radius * 0.75, dark, knuckle)
        rod(
            f"{name}_lower_piston",
            (x - 0.06, y - 0.025, z),
            (ankle[0] - 0.06, ankle[1] + 0.035, ankle[2]),
            radius * 0.35,
            steel,
            knuckle,
        )
        width = 0.115 if heavy else 0.075
        plate(
            f"{name}_shin_armor",
            [
                (x - width, y - 0.08, z - 0.065),
                (x + width, y - 0.08, z - 0.065),
                (ankle[0] + width * 0.70, ankle[1] + 0.02, ankle[2] - 0.07),
                (ankle[0] - width * 0.70, ankle[1] + 0.02, ankle[2] - 0.07),
            ],
            (0, 0, 0.035),
            paint,
            knuckle,
        )
        x, y, z = ankle
        rod(
            f"{name}_ankle",
            (x - 0.07, y, z),
            (x + 0.07, y, z),
            radius * 0.9,
            steel,
            knuckle,
        )
        for sign in (-1, 1):
            tx = x + sign * (0.062 if heavy else 0.043)
            box(
                f"{name}_toe_{sign}",
                (tx, 0.04, z - 0.10),
                (0.10 if heavy else 0.07, 0.07, 0.27),
                black,
                knuckle,
            )
            plate(
                f"{name}_toe_guard_{sign}",
                [
                    (tx - 0.033, 0.08, z - 0.22),
                    (tx + 0.033, 0.08, z - 0.22),
                    (tx + 0.035, 0.115, z - 0.02),
                    (tx - 0.035, 0.115, z - 0.02),
                ],
                (0, -0.022, 0),
                steel,
                knuckle,
            )

    height = {"chaser": 0.87, "runner": 0.68, "brute": 1.12, "turret": 0.73}[role]
    torso = art._pivot(collection, root, "Torso", (0, height, 0))
    weapon_height = {"chaser": 0.81, "runner": 0.70, "brute": 1.21, "turret": 1.03}[
        role
    ]
    weapon = art._pivot(collection, root, "WeaponPitch", (0, weapon_height, -0.14))
    art._parent_preserve_world(weapon, torso)
    muzzle = art._pivot(
        collection,
        root,
        "Muzzle",
        (0, weapon_height, -1.08 if role == "turret" else -0.84),
    )
    art._parent_preserve_world(muzzle, weapon)

    if role == "chaser":
        hull(
            "Ram_inner_chassis",
            [
                (0.64, 0.18, -0.42, 0.19),
                (1.14, 0.28, -0.36, 0.26),
                (1.28, 0.21, -0.12, 0.23),
            ],
            dark,
            torso,
        )
        for s in (-1, 1):
            plate(
                f"Sloping_ram_plate_{s}",
                [
                    (s * 0.012, 1.32, 0.18),
                    (s * 0.25, 1.30, 0.18),
                    (s * 0.31, 1.10, -0.27),
                    (s * 0.15, 0.73, -0.78),
                    (s * 0.012, 0.76, -0.80),
                ],
                (0, -0.032, 0.04),
                paint,
                torso,
            )
            plate(
                f"Ram_side_cheek_{s}",
                [
                    (s * 0.31, 1.12, -0.23),
                    (s * 0.29, 1.23, 0.20),
                    (s * 0.25, 0.79, 0.21),
                    (s * 0.18, 0.66, -0.40),
                ],
                (-s * 0.035, 0, 0),
                materials["pink_hot"],
                torso,
            )
            rod(
                f"Ram_shoulder_axle_{s}",
                (s * 0.18, 0.77, 0.12),
                (s * 0.33, 0.77, 0.12),
                0.09,
                steel,
                torso,
            )
            leg(
                "FL" if s < 0 else "FR",
                (s * 0.24, 0.72, 0.08),
                (s * 0.32, 0.38, 0.22),
                (s * 0.28, 0.12, -0.05),
            )
            for y, z in ((1.21, 0.09), (1.07, -0.22), (0.84, -0.62)):
                rod(
                    f"Ram_fastener_{s}_{y}",
                    (s * 0.13, y, z),
                    (s * 0.13, y + 0.015, z - 0.015),
                    0.013,
                    black,
                    torso,
                    8,
                )
        box(
            "Ram_recessed_sensor",
            (0, 0.785, -0.78),
            (0.13, 0.016, 0.021),
            light,
            torso,
            0.003,
        )
        for x in (-0.16, -0.08, 0, 0.08, 0.16):
            box(
                f"Ram_rear_heat_sink_{x}",
                (x, 1.15, 0.28),
                (0.035, 0.19, 0.055),
                steel,
                torso,
                0.005,
            )
    elif role == "runner":
        hull(
            "Runner_spine",
            [
                (0.58, 0.11, -0.57, 0.28),
                (0.83, 0.20, -0.38, 0.29),
                (0.98, 0.09, -0.02, 0.20),
            ],
            dark,
            torso,
        )
        for s in (-1, 1):
            plate(
                f"Runner_sloped_head_{s}",
                [
                    (s * 0.015, 0.98, 0.18),
                    (s * 0.20, 0.87, 0.17),
                    (s * 0.18, 0.75, -0.26),
                    (s * 0.035, 0.62, -0.64),
                    (s * 0.012, 0.70, -0.52),
                ],
                (0, -0.03, 0.03),
                steel,
                torso,
            )
            plate(
                f"Runner_swept_fin_{s}",
                [
                    (s * 0.15, 0.90, 0.02),
                    (s * 0.62, 0.81, 0.49),
                    (s * 0.48, 0.69, 0.63),
                    (s * 0.18, 0.73, 0.30),
                ],
                (0, -0.027, 0),
                paint,
                torso,
            )
            rod(
                f"Runner_fin_spar_{s}",
                (s * 0.18, 0.77, 0.10),
                (s * 0.47, 0.75, 0.47),
                0.019,
                steel,
                torso,
            )
            leg(
                "FL" if s < 0 else "FR",
                (s * 0.17, 0.57, 0.04),
                (s * 0.29, 0.30, 0.18),
                (s * 0.21, 0.10, -0.06),
            )
        box(
            "Runner_nose_sensor",
            (0, 0.64, -0.624),
            (0.065, 0.013, 0.02),
            light,
            torso,
            0.002,
        )
    elif role == "brute":
        hull(
            "Breacher_chassis",
            [
                (0.87, 0.36, -0.55, 0.53),
                (1.25, 0.53, -0.46, 0.53),
                (1.55, 0.44, -0.15, 0.40),
            ],
            dark,
            torso,
        )
        for s in (-1, 1):
            plate(
                f"Breacher_top_armor_{s}",
                [
                    (s * 0.014, 1.64, 0.38),
                    (s * 0.43, 1.60, 0.39),
                    (s * 0.54, 1.25, -0.37),
                    (s * 0.38, 1.04, -0.67),
                    (s * 0.014, 1.17, -0.58),
                ],
                (0, -0.07, 0.025),
                paint,
                torso,
            )
            plate(
                f"Breacher_side_skirt_{s}",
                [
                    (s * 0.54, 1.36, 0.39),
                    (s * 0.57, 1.18, -0.34),
                    (s * 0.51, 0.91, -0.35),
                    (s * 0.46, 0.92, 0.43),
                ],
                (-s * 0.045, 0, 0),
                paint,
                torso,
            )
            for name, z in (("F", -0.36), ("R", 0.38)):
                leg(
                    name + ("L" if s < 0 else "R"),
                    (s * 0.43, 0.91, z),
                    (s * 0.66, 0.46, z + 0.12),
                    (s * 0.65, 0.14, z - 0.11),
                    True,
                )
            box(
                f"Breacher_weapon_housing_{s}",
                (s * 0.31, 1.19, -0.63),
                (0.21, 0.23, 0.38),
                dark,
                weapon,
                0.025,
            )
            rod(
                f"Breacher_bore_{s}",
                (s * 0.31, 1.19, -0.75),
                (s * 0.31, 1.19, -0.88),
                0.068,
                steel,
                weapon,
            )
            rod(
                f"Breacher_bore_inset_{s}",
                (s * 0.31, 1.19, -0.88),
                (s * 0.31, 1.19, -0.888),
                0.045,
                black,
                weapon,
            )
            for y in (1.12, 1.20, 1.28, 1.36):
                box(
                    f"Breacher_rear_vent_{s}_{y}",
                    (s * 0.23, y, 0.548),
                    (0.30, 0.024, 0.04),
                    steel,
                    torso,
                    0.004,
                )
        box(
            "Breacher_sensor_recess",
            (0, 1.18, -0.60),
            (0.27, 0.055, 0.04),
            black,
            torso,
        )
        box(
            "Breacher_sensor",
            (0, 1.18, -0.625),
            (0.16, 0.013, 0.012),
            light,
            torso,
            0.002,
        )
    else:
        rod("Turret_column", (0, 0.20, 0), (0, 0.90, 0), 0.105, dark, root)
        for y, r in ((0.30, 0.19), (0.62, 0.23), (0.75, 0.21), (0.88, 0.17)):
            rod(
                f"Turret_turntable_{y}",
                (0, y - 0.035, 0),
                (0, y + 0.035, 0),
                r,
                steel,
                root,
                24,
            )
        for index in range(3):
            angle = index * math.tau / 3 + math.pi / 6
            dx, dz = math.cos(angle), math.sin(angle)
            rod(
                f"Turret_leg_{index}",
                (dx * 0.12, 0.35, dz * 0.12),
                (dx * 0.53, 0.08, dz * 0.53),
                0.063,
                dark,
                root,
            )
            rod(
                f"Turret_leg_piston_{index}",
                (dx * 0.17, 0.45, dz * 0.17),
                (dx * 0.44, 0.15, dz * 0.44),
                0.024,
                steel,
                root,
            )
            box(
                f"Turret_foot_{index}",
                (dx * 0.56, 0.045, dz * 0.56),
                (0.19, 0.08, 0.22),
                steel,
                root,
            )
        box(
            "Turret_gun_receiver",
            (0, 1.025, -0.19),
            (0.35, 0.26, 0.48),
            paint,
            weapon,
            0.035,
        )
        rod(
            "Turret_trunnion",
            (-0.235, 1.025, -0.08),
            (0.235, 1.025, -0.08),
            0.105,
            dark,
            torso,
            24,
        )
        rod(
            "Turret_barrel",
            (0, 1.03, -0.40),
            (0, 1.03, -1.06),
            0.065,
            steel,
            weapon,
            24,
        )
        for z in (-0.44, -0.59, -0.87, -1.035):
            rod(
                f"Turret_barrel_collar_{z}",
                (0, 1.03, z - 0.023),
                (0, 1.03, z + 0.023),
                0.083,
                dark,
                weapon,
                24,
            )
        rod("Turret_bore", (0, 1.03, -1.06), (0, 1.03, -1.07), 0.045, black, weapon, 24)
        for x in (-0.11, -0.055, 0, 0.055, 0.11):
            box(
                f"Turret_receiver_vent_{x}",
                (x, 1.171, -0.15),
                (0.023, 0.028, 0.30),
                dark,
                weapon,
                0.004,
            )
        box(
            "Turret_sensor",
            (0.195, 1.08, -0.22),
            (0.035, 0.035, 0.09),
            light,
            weapon,
            0.004,
        )

    root["role"] = f"enemy_{role}"
    root["forward_axis"] = "-Z"
    root["concept_reference"] = "art/concepts/mech-model-sheet-v1.png"
    return collection, root
