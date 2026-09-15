"""Reference-guided hard-surface player model, in Godot's Y-up coordinates."""

import math

import bpy
from mathutils import Vector


def build_player(art, materials):
    collection, root = art._model_collection("PlayerBot")
    armor = materials["ceramic"]
    edge = materials["ceramic_shadow"]
    dark = materials["graphite"]
    steel = materials["steel"]
    machined = materials["graphite_light"]
    amber = materials["lime_hot"]
    black = materials["ink"]

    def attach(obj, parent):
        bpy.context.view_layer.update()
        return art._parent_preserve_world(obj, parent)

    def box(name, at, size, material, parent, bevel=0.012):
        return attach(
            art._box(collection, name, at, size, material, bevel=bevel), parent
        )

    def rod(name, start, end, radius, material, parent, vertices=20):
        obj = art._beam_between(
            collection,
            name,
            start,
            end,
            radius,
            material,
            vertices=vertices,
            bevel=min(radius * 0.15, 0.006),
        )
        for polygon in obj.data.polygons:
            polygon.use_smooth = len(polygon.vertices) == 4
        return attach(obj, parent)

    def panel(name, points, thickness, material, parent):
        vertices = [tuple(art._to_blender_location(p)) for p in points]
        vertices += [
            tuple(art._to_blender_location(Vector(p) + Vector(thickness)))
            for p in points
        ]
        count = len(points)
        faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
        faces += [
            (i, (i + 1) % count, (i + 1) % count + count, i + count)
            for i in range(count)
        ]
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        collection.objects.link(obj)
        art._finish_mesh(obj, collection, material, bevel=0.009, segments=3)
        return attach(obj, parent)

    def cable(name, points, radius, material, parent):
        curve = bpy.data.curves.new(name, "CURVE")
        curve.dimensions = "3D"
        curve.resolution_u = 6
        curve.bevel_depth = radius
        curve.bevel_resolution = 2
        spline = curve.splines.new("BEZIER")
        spline.bezier_points.add(len(points) - 1)
        for point, at in zip(spline.bezier_points, points, strict=True):
            point.co = art._to_blender_location(at)
            point.handle_left_type = "AUTO"
            point.handle_right_type = "AUTO"
        obj = bpy.data.objects.new(name, curve)
        collection.objects.link(obj)
        obj.data.materials.append(material)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.convert(target="MESH")
        obj = bpy.context.object
        return attach(obj, parent)

    def fastener(name, at, normal, parent, radius=0.012):
        start = Vector(at)
        rod(
            name,
            start,
            start + Vector(normal) * 0.007,
            radius,
            dark,
            parent,
            vertices=8,
        )

    torso = art._pivot(collection, root, "Torso", (0, 1.10, 0))
    weapon = art._pivot(collection, root, "WeaponPitch", (0.57, 1.32, -0.12))
    attach(weapon, torso)
    muzzle = art._pivot(collection, root, "Muzzle", (0.57, 1.27, -1.08))
    attach(muzzle, weapon)

    # A narrow mechanical core carries separate armor plates. The seams expose
    # the underlying structure, including from the player's rear camera.
    box("Spinal_carriage", (0, 1.47, 0.065), (0.29, 0.43, 0.28), dark, torso, 0.025)
    box("Thoracic_frame", (0, 1.60, 0.005), (0.72, 0.20, 0.29), black, torso, 0.025)
    for side in (-1, 1):
        panel(
            f"Breast_plate_{side}",
            [
                (side * 0.022, 1.73, -0.25),
                (side * 0.32, 1.71, -0.22),
                (side * 0.43, 1.57, -0.19),
                (side * 0.29, 1.28, -0.29),
                (side * 0.10, 1.23, -0.34),
                (side * 0.025, 1.44, -0.35),
            ],
            (0, 0, 0.065),
            armor,
            torso,
        )
        panel(
            f"Clavicle_guard_{side}",
            [
                (side * 0.04, 1.76, -0.20),
                (side * 0.34, 1.77, -0.17),
                (side * 0.44, 1.68, 0.08),
                (side * 0.08, 1.69, 0.10),
            ],
            (0, -0.045, 0),
            edge,
            torso,
        )
        panel(
            f"Rib_guard_{side}",
            [
                (side * 0.39, 1.59, -0.12),
                (side * 0.37, 1.58, 0.20),
                (side * 0.22, 1.22, 0.22),
                (side * 0.24, 1.24, -0.14),
            ],
            (side * 0.045, 0, 0),
            edge,
            torso,
        )
        panel(
            f"Scapula_plate_{side}",
            [
                (side * 0.22, 1.73, 0.22),
                (side * 0.39, 1.62, 0.21),
                (side * 0.28, 1.23, 0.20),
                (side * 0.21, 1.20, 0.26),
            ],
            (0, 0, 0.05),
            armor,
            torso,
        )
        for y in (1.48, 1.40, 1.32):
            rod(
                f"Exposed_rib_{side}_{y}",
                (side * 0.18, y, 0.06),
                (side * 0.31, y + 0.025, 0.11),
                0.021,
                machined,
                torso,
            )
        for x, y, z in (
            (0.075, 1.68, -0.27),
            (0.33, 1.56, -0.235),
            (0.145, 1.30, -0.35),
        ):
            fastener(f"Chest_bolt_{side}_{y}", (side * x, y, z), (0, 0, -1), torso)

    box("Recessed_sensor_socket", (0, 1.60, -0.318), (0.48, 0.054, 0.035), black, torso)
    box(
        "Amber_sensor_slit",
        (0, 1.599, -0.342),
        (0.30, 0.009, 0.009),
        amber,
        torso,
        0.002,
    )
    for x in (-0.14, -0.04, 0.06, 0.16):
        box(
            f"Sensor_protective_divider_{x}",
            (x, 1.60, -0.348),
            (0.012, 0.043, 0.009),
            dark,
            torso,
            0.002,
        )

    # Backpack: steel cage, cylindrical energy cells, cooling fins, and service
    # hoses. Small emissive inserts leave the mechanical assembly readable.
    box("Backpack_tray", (0, 1.48, 0.255), (0.39, 0.49, 0.14), dark, torso, 0.025)
    box(
        "Backpack_upper_vent_recess", (0, 1.67, 0.352), (0.34, 0.14, 0.06), black, torso
    )
    for y in (1.62, 1.65, 1.68, 1.71):
        box(
            f"Cooling_louver_{y}",
            (0, y, 0.39),
            (0.31, 0.014, 0.043),
            machined,
            torso,
            0.004,
        )
    for x in (-0.09, 0.09):
        rod(f"Power_cell_{x}", (x, 1.27, 0.366), (x, 1.56, 0.366), 0.038, amber, torso)
        for y in (1.265, 1.57):
            rod(
                f"Cell_terminal_{x}_{y}",
                (x, y - 0.026, 0.366),
                (x, y + 0.026, 0.366),
                0.052,
                machined,
                torso,
            )
        for y in (1.32, 1.44, 1.53):
            box(
                f"Cell_retainer_{x}_{y}",
                (x, y, 0.406),
                (0.10, 0.013, 0.015),
                dark,
                torso,
                0.003,
            )
    for x in (-0.21, 0.21):
        rod(
            f"Backpack_cage_{x}",
            (x, 1.23, 0.355),
            (x, 1.72, 0.355),
            0.022,
            machined,
            torso,
        )
        cable(
            f"Spinal_cable_{x}",
            [
                (x, 1.25, 0.33),
                (x * 1.28, 1.13, 0.31),
                (x * 0.80, 1.01, 0.22),
                (x * 0.58, 1.06, 0.13),
            ],
            0.014,
            black,
            torso,
        )
    box("Battery_service_latch", (0, 1.215, 0.34), (0.20, 0.042, 0.09), edge, torso)

    # Waist and pelvis retain visible separation from both torso and legs.
    rod("Lumbar_actuator", (0, 0.96, 0.055), (0, 1.23, 0.055), 0.115, dark, root)
    for y in (1.03, 1.085, 1.14):
        rod(
            f"Lumbar_bearing_{y}",
            (0, y - 0.011, 0.055),
            (0, y + 0.011, 0.055),
            0.13,
            machined,
            root,
        )
    box("Pelvis_crossmember", (0, 0.96, 0.04), (0.54, 0.13, 0.20), dark, root, 0.025)
    panel(
        "Pelvis_front_guard",
        [
            (-0.23, 1.035, -0.09),
            (0.23, 1.035, -0.09),
            (0.16, 0.88, -0.17),
            (-0.16, 0.88, -0.17),
        ],
        (0, 0, 0.04),
        edge,
        root,
    )

    for side, sign in (("FL", -1), ("FR", 1)):
        x = sign * 0.27
        leg = art._pivot(collection, root, f"Leg_{side}", (x, 0.94, 0.045))
        knee = art._pivot(collection, root, f"Knee_{side}", (sign * 0.30, 0.53, 0.10))
        attach(knee, leg)
        rod(
            f"Hip_bearing_{side}",
            (x - 0.085, 0.94, 0.045),
            (x + 0.085, 0.94, 0.045),
            0.108,
            machined,
            leg,
        )
        rod(
            f"Femur_frame_{side}",
            (x, 0.90, 0.045),
            (sign * 0.30, 0.54, 0.10),
            0.065,
            dark,
            leg,
        )
        rod(
            f"Thigh_hydraulic_{side}",
            (x - sign * 0.08, 0.89, -0.01),
            (sign * 0.30 - sign * 0.08, 0.59, 0.07),
            0.026,
            steel,
            leg,
        )
        panel(
            f"Thigh_shield_{side}",
            [
                (x - 0.105, 0.92, -0.10),
                (x + 0.105, 0.92, -0.10),
                (sign * 0.30 + 0.09, 0.65, -0.065),
                (sign * 0.30, 0.59, -0.08),
                (sign * 0.30 - 0.09, 0.66, -0.065),
            ],
            (0, 0, 0.065),
            armor,
            leg,
        )
        for y in (0.87, 0.70):
            fastener(f"Thigh_fastener_{side}_{y}", (x, y, -0.112), (0, 0, -1), leg)
        rod(
            f"Knee_outer_drum_{side}",
            (sign * 0.30 - 0.115, 0.53, 0.10),
            (sign * 0.30 + 0.115, 0.53, 0.10),
            0.105,
            dark,
            knee,
            24,
        )
        rod(
            f"Knee_end_cap_{side}",
            (sign * 0.30 + sign * 0.11, 0.53, 0.10),
            (sign * 0.30 + sign * 0.128, 0.53, 0.10),
            0.075,
            machined,
            knee,
            24,
        )
        rod(
            f"Knee_axle_{side}",
            (sign * 0.30 + sign * 0.126, 0.53, 0.10),
            (sign * 0.30 + sign * 0.137, 0.53, 0.10),
            0.027,
            black,
            knee,
            8,
        )
        rod(
            f"Tibia_rail_{side}",
            (sign * 0.30, 0.50, 0.10),
            (x, 0.16, -0.10),
            0.048,
            dark,
            knee,
        )
        rod(
            f"Shin_piston_sleeve_{side}",
            (x - sign * 0.055, 0.44, 0.15),
            (x - sign * 0.055, 0.30, 0.06),
            0.034,
            machined,
            knee,
        )
        rod(
            f"Shin_piston_rod_{side}",
            (x - sign * 0.055, 0.30, 0.06),
            (x - sign * 0.055, 0.15, -0.10),
            0.018,
            steel,
            knee,
        )
        panel(
            f"Shin_shield_{side}",
            [
                (x - 0.085, 0.43, 0.015),
                (x + 0.085, 0.43, 0.015),
                (x + 0.065, 0.17, -0.16),
                (x - 0.06, 0.15, -0.17),
            ],
            (0, 0, 0.035),
            edge,
            knee,
        )
        cable(
            f"Knee_hose_{side}",
            [
                (x + sign * 0.10, 0.46, 0.10),
                (x + sign * 0.16, 0.33, 0.16),
                (x + sign * 0.04, 0.19, -0.08),
            ],
            0.012,
            black,
            knee,
        )
        rod(
            f"Ankle_bearing_{side}",
            (x - 0.09, 0.135, -0.105),
            (x + 0.09, 0.135, -0.105),
            0.065,
            machined,
            knee,
        )
        for offset in (-0.062, 0.062):
            tx = x + offset
            box(
                f"Toe_sole_{side}_{offset}",
                (tx, 0.042, -0.225),
                (0.105, 0.07, 0.36),
                black,
                knee,
                0.018,
            )
            panel(
                f"Toe_armor_{side}_{offset}",
                [
                    (tx - 0.046, 0.083, -0.38),
                    (tx + 0.046, 0.083, -0.38),
                    (tx + 0.05, 0.14, -0.12),
                    (tx - 0.05, 0.14, -0.12),
                ],
                (0, -0.027, 0),
                armor,
                knee,
            )
        box(f"Heel_{side}", (x, 0.065, 0.06), (0.18, 0.10, 0.16), dark, knee)

    # Separate shoulder plates sit over circular bearings and exposed arms.
    for sign in (-1, 1):
        x = sign * 0.49
        rod(
            f"Shoulder_axle_{sign}",
            (sign * 0.35, 1.57, 0),
            (sign * 0.60, 1.57, 0),
            0.12,
            dark,
            torso,
            24,
        )
        panel(
            f"Shoulder_roof_{sign}",
            [
                (sign * 0.36, 1.77, -0.18),
                (sign * 0.60, 1.75, -0.18),
                (sign * 0.69, 1.60, -0.12),
                (sign * 0.67, 1.59, 0.22),
                (sign * 0.52, 1.76, 0.23),
                (sign * 0.37, 1.78, 0.16),
            ],
            (0, -0.055, 0),
            armor,
            torso,
        )
        panel(
            f"Shoulder_lower_lamella_{sign}",
            [
                (sign * 0.61, 1.62, -0.15),
                (sign * 0.70, 1.49, -0.08),
                (sign * 0.68, 1.46, 0.20),
                (sign * 0.63, 1.58, 0.22),
            ],
            (-sign * 0.025, 0, 0),
            edge,
            torso,
        )
        rod(
            f"Upper_arm_{sign}",
            (x + sign * 0.05, 1.52, 0.015),
            (sign * 0.60, 1.27, -0.10),
            0.065,
            dark,
            torso,
        )
        rod(
            f"Arm_piston_{sign}",
            (x, 1.52, -0.09),
            (sign * 0.56, 1.29, -0.15),
            0.022,
            steel,
            torso,
        )
        rod(
            f"Elbow_drum_{sign}",
            (sign * 0.53, 1.27, -0.12),
            (sign * 0.67, 1.27, -0.12),
            0.085,
            machined,
            torso,
        )
        for z in (-0.125, 0.16):
            fastener(
                f"Shoulder_rear_fastener_{sign}_{z}",
                (sign * 0.58, 1.715, z),
                (0, 1, 0),
                torso,
            )
    panel(
        "Left_forearm_guard",
        [
            (-0.70, 1.29, -0.15),
            (-0.52, 1.28, -0.18),
            (-0.51, 1.02, -0.30),
            (-0.63, 0.96, -0.29),
            (-0.71, 1.09, -0.23),
        ],
        (0, 0, 0.075),
        armor,
        torso,
    )
    rod(
        "Left_wrist_actuator",
        (-0.60, 1.20, -0.13),
        (-0.61, 0.94, -0.22),
        0.044,
        dark,
        torso,
    )
    box("Left_hand_palm", (-0.61, 0.94, -0.24), (0.13, 0.09, 0.14), machined, torso)
    for x in (-0.65, -0.61, -0.57):
        box(
            f"Gripper_finger_{x}",
            (x, 0.90, -0.285),
            (0.027, 0.055, 0.08),
            dark,
            torso,
            0.006,
        )

    # The gun is aligned with local -Z and mounted entirely below WeaponPitch.
    rod(
        "Cannon_receiver",
        (0.57, 1.27, -0.16),
        (0.57, 1.27, -0.61),
        0.11,
        dark,
        weapon,
        16,
    )
    box(
        "Cannon_upper_receiver",
        (0.57, 1.37, -0.39),
        (0.17, 0.09, 0.38),
        edge,
        weapon,
        0.018,
    )
    rod(
        "Cannon_barrel",
        (0.57, 1.27, -0.48),
        (0.57, 1.27, -1.04),
        0.065,
        machined,
        weapon,
        24,
    )
    for z in (-0.57, -0.70, -0.92):
        rod(
            f"Cannon_collar_{z}",
            (0.57, 1.27, z - 0.035),
            (0.57, 1.27, z + 0.035),
            0.084,
            dark,
            weapon,
            24,
        )
    for angle in (0, math.pi / 2, math.pi, math.pi * 1.5):
        x = 0.57 + math.cos(angle) * 0.087
        y = 1.27 + math.sin(angle) * 0.087
        rod(
            f"Barrel_heat_rail_{angle}",
            (x, y, -0.58),
            (x, y, -0.94),
            0.012,
            steel,
            weapon,
            8,
        )
    rod(
        "Muzzle_shroud",
        (0.57, 1.27, -0.98),
        (0.57, 1.27, -1.062),
        0.084,
        machined,
        weapon,
        24,
    )
    rod(
        "Dark_bore", (0.57, 1.27, -1.062), (0.57, 1.27, -1.07), 0.055, black, weapon, 24
    )
    box(
        "Receiver_identification_stripe",
        (0.681, 1.28, -0.39),
        (0.01, 0.035, 0.19),
        edge,
        weapon,
        0.002,
    )

    root["role"] = "player"
    root["forward_axis"] = "-Z"
    root["nominal_height"] = 1.85
    root["nominal_radius"] = 0.55
    root["concept_reference"] = "art/concepts/mech-model-sheet-v1.png"
    return collection, root
