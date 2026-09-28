class_name RushActorVisual
extends Node3D

## Drives the authored mech pivots without owning actor simulation.
##
## Art exports a small, stable marker contract. The driver resolves that
## contract once when a model is bound, then only mutates cached transforms in
## step(), so movement never creates scene nodes or searches the model tree.

const LEG_NAMES: Array[String] = ["Leg_FL", "Leg_FR", "Leg_RL", "Leg_RR"]
const KNEE_NAMES: Array[String] = ["Knee_FL", "Knee_FR", "Knee_RL", "Knee_RR"]
const LEG_PHASE_OFFSETS: Array[float] = [0.0, PI, PI, 0.0]

const STRIDE_LENGTH: float = 1.35
const GAIT_REFERENCE_SPEED: float = 6.0
const GAIT_RESPONSE: float = 9.0
const LEG_SWING: float = 0.24
const KNEE_SWING: float = 0.18
const MAX_WEAPON_PITCH: float = 1.553343

var marker_contract_valid: bool = false

var _model: Node
var _body_node: Node3D
var _weapon_pitch: Node3D
var _muzzle: Node3D
var _torso: Node3D
var _leg_nodes: Array[Node3D] = []
var _leg_base_rotations: Array[Vector3] = []
var _leg_phase_offsets: Array[float] = []
var _knee_nodes: Array[Node3D] = []
var _knee_base_rotations: Array[Vector3] = []
var _knee_phase_offsets: Array[float] = []
var _mesh_nodes: Array[MeshInstance3D] = []
var _flash_material: StandardMaterial3D
var _flash_enabled: bool = false

var _body_base_position: Vector3 = Vector3.ZERO
var _body_base_rotation: Vector3 = Vector3.ZERO
var _weapon_base_rotation: Vector3 = Vector3.ZERO
var _gait_distance: float = 0.0
var _gait_speed: float = 0.0


func _ready() -> void:
	# Actors and echoes call step explicitly. Disabling this node prevents a
	# second autonomous animation clock from fighting the simulation clock.
	process_mode = Node.PROCESS_MODE_DISABLED


func bind_model(value: Node) -> void:
	if _model == value and is_instance_valid(_model):
		return
	_clear_bindings()
	if not is_instance_valid(value):
		return
	_model = value
	_body_node = value as Node3D
	_torso = _find_node(value, "Torso")
	if is_instance_valid(_torso):
		_body_node = _torso
	_weapon_pitch = _find_node(value, "WeaponPitch")
	_muzzle = _find_node(value, "Muzzle")
	if is_instance_valid(_body_node):
		_body_base_position = _body_node.position
		_body_base_rotation = _body_node.rotation
	if is_instance_valid(_weapon_pitch):
		_weapon_base_rotation = _weapon_pitch.rotation

	for index in LEG_NAMES.size():
		var leg: Node3D = _find_node(value, LEG_NAMES[index])
		if not is_instance_valid(leg):
			continue
		_leg_nodes.append(leg)
		_leg_base_rotations.append(leg.rotation)
		_leg_phase_offsets.append(LEG_PHASE_OFFSETS[index])
		var knee: Node3D = _find_node(value, KNEE_NAMES[index])
		if is_instance_valid(knee):
			_knee_nodes.append(knee)
			_knee_base_rotations.append(knee.rotation)
			_knee_phase_offsets.append(LEG_PHASE_OFFSETS[index])

	_collect_meshes(value)
	_flash_material = _new_flash_material()
	var markers_present: bool = is_instance_valid(_weapon_pitch) and is_instance_valid(_muzzle)
	var muzzle_is_driven: bool = markers_present and _weapon_pitch.is_ancestor_of(_muzzle)
	marker_contract_valid = markers_present and muzzle_is_driven
	if not marker_contract_valid:
		var missing_markers: Array[String] = []
		if not is_instance_valid(_weapon_pitch):
			missing_markers.append("WeaponPitch")
		if not is_instance_valid(_muzzle):
			missing_markers.append("Muzzle")
		if markers_present and not muzzle_is_driven:
			missing_markers.append("Muzzle descendant of WeaponPitch")
		push_error(
			(
				"RushActorVisual model is missing required exact marker(s): %s"
				% ", ".join(missing_markers)
			)
		)
	reset_motion()


func has_muzzle() -> bool:
	return is_instance_valid(_muzzle) and is_instance_valid(_model)


func muzzle_global_position() -> Vector3:
	if not has_muzzle():
		return Vector3.INF
	return _muzzle.global_position


func set_weapon_aim(value: Vector3) -> void:
	if not is_instance_valid(_weapon_pitch) or not _finite_vector(value):
		return
	if value.length_squared() < 0.0001:
		return
	var direction: Vector3 = value.normalized()
	var local_direction: Vector3 = _to_actor_local(direction)
	var horizontal_length: float = sqrt(
		local_direction.x * local_direction.x + local_direction.z * local_direction.z
	)
	var pitch: float = atan2(local_direction.y, horizontal_length)
	pitch = clampf(pitch, -MAX_WEAPON_PITCH, MAX_WEAPON_PITCH)
	_weapon_pitch.rotation = _weapon_base_rotation + Vector3(pitch, 0.0, 0.0)


func step(delta: float, planar_velocity: Vector3, value: Vector3) -> void:
	if not is_instance_valid(_model):
		_clear_bindings()
		return
	var step_size: float = clampf(delta, 0.0, 0.1)
	var safe_velocity: Vector3 = (
		planar_velocity if _finite_vector(planar_velocity) else Vector3.ZERO
	)
	var local_velocity: Vector3 = _to_actor_local(safe_velocity)
	var target_speed: float = clampf(local_velocity.length() / GAIT_REFERENCE_SPEED, 0.0, 1.0)
	_gait_speed = move_toward(_gait_speed, target_speed, step_size * GAIT_RESPONSE)
	if step_size > 0.0:
		_gait_distance = fmod(_gait_distance + local_velocity.length() * step_size, STRIDE_LENGTH)
		if _gait_distance < 0.0:
			_gait_distance += STRIDE_LENGTH
	var phase: float = _gait_distance / STRIDE_LENGTH * TAU
	_apply_body_weight(local_velocity, phase)
	_apply_gait(phase)
	set_weapon_aim(value)


func set_flash(amount: float) -> void:
	if not is_instance_valid(_flash_material):
		return
	var strength: float = clampf(amount, 0.0, 1.0)
	if strength <= 0.001:
		if _flash_enabled:
			for mesh: MeshInstance3D in _mesh_nodes:
				if is_instance_valid(mesh):
					mesh.material_overlay = null
			_flash_enabled = false
		_flash_material.albedo_color = Color(1.0, 1.0, 1.0, 0.0)
		return
	if not _flash_enabled:
		for mesh: MeshInstance3D in _mesh_nodes:
			if is_instance_valid(mesh):
				mesh.material_overlay = _flash_material
		_flash_enabled = true
	_flash_material.albedo_color = Color(1.0, 0.96, 0.84, strength * 0.82)


func reset_motion() -> void:
	_gait_distance = 0.0
	_gait_speed = 0.0
	if is_instance_valid(_body_node):
		_body_node.position = _body_base_position
		_body_node.rotation = _body_base_rotation
	if is_instance_valid(_weapon_pitch):
		_weapon_pitch.rotation = _weapon_base_rotation
	for index in _leg_nodes.size():
		if is_instance_valid(_leg_nodes[index]):
			_leg_nodes[index].rotation = _leg_base_rotations[index]
	for index in _knee_nodes.size():
		if is_instance_valid(_knee_nodes[index]):
			_knee_nodes[index].rotation = _knee_base_rotations[index]
	set_flash(0.0)


func _apply_gait(phase: float) -> void:
	var leg_strength: float = _gait_speed * _gait_speed
	for index in _leg_nodes.size():
		var leg: Node3D = _leg_nodes[index]
		if not is_instance_valid(leg):
			continue
		var swing: float = sin(phase + _leg_phase_offsets[index]) * LEG_SWING * leg_strength
		leg.rotation = _leg_base_rotations[index] + Vector3(swing, 0.0, 0.0)
	for index in _knee_nodes.size():
		var knee: Node3D = _knee_nodes[index]
		if not is_instance_valid(knee):
			continue
		var swing: float = sin(phase + _knee_phase_offsets[index] + PI) * KNEE_SWING * leg_strength
		knee.rotation = _knee_base_rotations[index] + Vector3(swing, 0.0, 0.0)


func _apply_body_weight(local_velocity: Vector3, phase: float) -> void:
	if not is_instance_valid(_body_node):
		return
	var bob: float = sin(phase * 2.0) * lerpf(0.006, 0.025, _gait_speed) * _gait_speed
	var forward_lean: float = clampf(-local_velocity.z / GAIT_REFERENCE_SPEED * 0.08, -0.08, 0.08)
	var side_lean: float = clampf(-local_velocity.x / GAIT_REFERENCE_SPEED * 0.06, -0.06, 0.06)
	_body_node.position = _body_base_position + Vector3(0.0, bob, 0.0)
	_body_node.rotation = _body_base_rotation + Vector3(forward_lean, 0.0, side_lean)


func _to_actor_local(value: Vector3) -> Vector3:
	var actor: Node3D = get_parent() as Node3D
	var basis: Basis = actor.global_basis if is_instance_valid(actor) else global_basis
	return basis.inverse() * value


func _find_node(root: Node, node_name: String) -> Node3D:
	if not is_instance_valid(root):
		return null
	var found: Node = root.find_child(node_name, true, false)
	return found as Node3D


func _collect_meshes(node: Node) -> void:
	if node is MeshInstance3D:
		_mesh_nodes.append(node as MeshInstance3D)
	for child: Node in node.get_children():
		_collect_meshes(child)


func _new_flash_material() -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	material.albedo_color = Color(1.0, 0.96, 0.84, 0.0)
	material.emission_enabled = true
	material.emission = Color(1.0, 0.86, 0.62, 1.0)
	material.emission_energy_multiplier = 2.4
	return material


func _clear_bindings() -> void:
	set_flash(0.0)
	_model = null
	_body_node = null
	_weapon_pitch = null
	_muzzle = null
	_torso = null
	_leg_nodes.clear()
	_leg_base_rotations.clear()
	_leg_phase_offsets.clear()
	_knee_nodes.clear()
	_knee_base_rotations.clear()
	_knee_phase_offsets.clear()
	_mesh_nodes.clear()
	_flash_material = null
	_flash_enabled = false
	marker_contract_valid = false


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)
