"""Bake the mech's paint finish in Blender for portable glTF materials."""

from pathlib import Path

import bpy


def apply_paint(materials, texture_directory: Path):
    texture_directory.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    previous_engine = scene.render.engine
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    scene.cycles.seed = 0
    scene.cycles.device = "CPU"
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.mesh.primitive_plane_add(size=2, location=(0, 0, -100))
    plane = bpy.context.object
    material = bpy.data.materials.new("PaintBake")
    material.use_nodes = True
    plane.data.materials.append(material)
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    links.new(emission.outputs[0], output.inputs["Surface"])
    coordinates = nodes.new("ShaderNodeTexCoord")
    grime = nodes.new("ShaderNodeTexNoise")
    grime.inputs["Scale"].default_value = 9
    grime.inputs["Detail"].default_value = 4
    grime.inputs["Roughness"].default_value = 0.8
    links.new(coordinates.outputs["UV"], grime.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.30
    ramp.color_ramp.elements[0].color = (0.44, 0.44, 0.44, 1)
    ramp.color_ramp.elements[1].position = 0.67
    ramp.color_ramp.elements[1].color = (0.96, 0.96, 0.96, 1)
    links.new(grime.outputs["Fac"], ramp.inputs[0])
    fine = nodes.new("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = 290
    fine.inputs["Detail"].default_value = 2
    links.new(coordinates.outputs["UV"], fine.inputs["Vector"])
    mix = nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MULTIPLY"
    mix.inputs[0].default_value = 0.17
    links.new(ramp.outputs[0], mix.inputs[1])
    links.new(fine.outputs["Fac"], mix.inputs[2])
    tint = nodes.new("ShaderNodeMixRGB")
    tint.blend_type = "MULTIPLY"
    tint.inputs[0].default_value = 1
    links.new(mix.outputs[0], tint.inputs[1])
    links.new(tint.outputs[0], emission.inputs["Color"])
    target = nodes.new("ShaderNodeTexImage")
    nodes.active = target
    baked = {}
    try:
        for key in ("ceramic", "ceramic_shadow"):
            image = bpy.data.images.new(f"{key}_paint", 1024, 1024, alpha=False)
            image.filepath_raw = str(texture_directory / f"{key}_paint.png")
            image.file_format = "PNG"
            target.image = image
            tint.inputs[2].default_value = materials[key].diffuse_color
            bpy.ops.object.bake(type="EMIT", margin=0, use_clear=True)
            image.save()
            image.pack()
            image.filepath = "//../textures/" + Path(image.filepath).name
            baked[key] = image
        rough_image = bpy.data.images.new("paint_roughness", 1024, 1024, alpha=False)
        rough_image.colorspace_settings.name = "Non-Color"
        rough_image.filepath_raw = str(texture_directory / "paint_roughness.png")
        rough_image.file_format = "PNG"
        target.image = rough_image
        rough = nodes.new("ShaderNodeMapRange")
        rough.inputs["To Min"].default_value = 0.38
        rough.inputs["To Max"].default_value = 0.76
        links.new(grime.outputs["Fac"], rough.inputs["Value"])
        links.new(rough.outputs[0], emission.inputs["Color"])
        bpy.ops.object.bake(type="EMIT", margin=0, use_clear=True)
        rough_image.save()
        rough_image.pack()
        rough_image.filepath = "//../textures/paint_roughness.png"
    finally:
        bpy.data.objects.remove(plane, do_unlink=True)
        bpy.data.materials.remove(material)
        scene.render.engine = previous_engine
    for key, image in baked.items():
        mat = materials[key]
        shader = mat.node_tree.nodes.get("Principled BSDF")
        paint_node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        paint_node.image = image
        mat.node_tree.links.new(
            paint_node.outputs["Color"], shader.inputs["Base Color"]
        )
        rough_node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        rough_node.image = rough_image
        mat.node_tree.links.new(rough_node.outputs["Color"], shader.inputs["Roughness"])


def project_uvs(root):
    """Use metric box projection so separate rigid parts share paint density."""
    bpy.context.view_layer.update()
    for obj in root.children_recursive:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        uv = mesh.uv_layers.active or mesh.uv_layers.new(name="SurfaceUV")
        for polygon in mesh.polygons:
            normal = obj.matrix_world.to_3x3() @ polygon.normal
            axis = max(range(3), key=lambda index: abs(normal[index]))
            axes = [index for index in range(3) if index != axis]
            for loop_index in polygon.loop_indices:
                point = (
                    obj.matrix_world
                    @ mesh.vertices[mesh.loops[loop_index].vertex_index].co
                )
                uv.data[loop_index].uv = (point[axes[0]], point[axes[1]])
