class_name RushEcho
extends Node3D

signal fired(origin: Vector3, direction: Vector3, damage: int, bounces: int, speed: float)
signal finished

const PLAYER_MODEL_PATH: String = "res://assets/models/player.glb"
const MIN_DURATION: float = 0.65
const MAX_DURATION: float = 3.0
const MAX_SAMPLES: int = 240
const TIME_EPSILON: float = 0.000001
const TRAIL_POINTS: int = 8

var elapsed: float = 0.0
var duration: float = 0.0
var aim_direction: Vector3 = Vector3(0.0, 0.0, -1.0)

var _samples: Array[Dictionary] = []
var _valid: bool = false
var _finished: bool = false
var _next_shot_sample: int = 0
var _pose_segment: int = 0
var _visual_ready: bool = false
var _model_instance: Node
var _ring: MeshInstance3D
var _trail: MeshInstance3D
var _trail_mesh: ImmediateMesh
var _trail_material: StandardMaterial3D
var _trail_positions: Array[Vector3] = []


func setup(samples: Array[Dictionary]) -> bool:
	_samples.clear()
	_trail_positions.clear()
	elapsed = 0.0
	duration = 0.0
	_next_shot_sample = 0
	_pose_segment = 0
	_valid = false
	_finished = false
	if samples.is_empty() or samples.size() > MAX_SAMPLES:
		return _reject_setup()

	var first_time: float = 0.0
	var previous_time: float = -INF
	for sample: Dictionary in samples:
		var sample_time_value: Variant = sample.get("time")
		if not _is_number(sample_time_value):
			return _reject_setup()
		var sample_time: float = float(sample_time_value)
		if (
			not is_finite(sample_time)
			or sample_time < 0.0
			or sample_time + TIME_EPSILON < previous_time
		):
			return _reject_setup()
		if _samples.is_empty():
			first_time = sample_time
		var copied_sample: Dictionary = _copy_sample(sample, first_time)
		if copied_sample.is_empty():
			return _reject_setup()
		_samples.append(copied_sample)
		previous_time = sample_time

	duration = float(_samples[_samples.size() - 1]["time"])
	if duration + TIME_EPSILON < MIN_DURATION or duration > MAX_DURATION + TIME_EPSILON:
		return _reject_setup()
	_valid = true
	# The parent adds the echo after setup; seed local position immediately so
	# activation feedback and any first-frame queries see the recorded origin.
	position = _samples[0]["position"]
	_apply_pose(0.0)
	if is_inside_tree():
		_ensure_visual()
	return true


func _ready() -> void:
	if _finished:
		queue_free()
	elif _valid:
		_ensure_visual()


func advance(delta: float) -> void:
	if not _valid or _finished or not is_finite(delta) or delta < 0.0:
		return
	var next_elapsed: float = minf(elapsed + delta, duration)
	if not is_finite(next_elapsed):
		return
	elapsed = next_elapsed
	_apply_pose(elapsed)
	_emit_shots_until(elapsed)
	if elapsed >= duration - TIME_EPSILON:
		_finish()


func _physics_process(delta: float) -> void:
	if _finished:
		queue_free()
		return
	advance(delta)


func _process(delta: float) -> void:
	if is_instance_valid(_ring):
		_ring.rotate_y(clampf(delta, 0.0, 0.1) * 1.4)


func _emit_shots_until(until: float) -> void:
	while _next_shot_sample < _samples.size():
		var sample: Dictionary = _samples[_next_shot_sample]
		var sample_time: float = float(sample["time"])
		if sample_time > until + TIME_EPSILON:
			break
		var shots: Array[Dictionary] = sample["shots"]
		for shot: Dictionary in shots:
			emit_signal(
				"fired",
				shot["origin"],
				shot["direction"],
				shot["damage"],
				shot["bounces"],
				shot["speed"]
			)
		_next_shot_sample += 1


func _apply_pose(at_time: float) -> void:
	if _samples.is_empty():
		return
	var before_index: int = _pose_segment
	while before_index + 1 < _samples.size():
		var next_time: float = float(_samples[before_index + 1]["time"])
		if at_time <= next_time + TIME_EPSILON:
			break
		before_index += 1
	_pose_segment = before_index
	var after_index: int = mini(before_index + 1, _samples.size() - 1)
	var before: Dictionary = _samples[before_index]
	var after: Dictionary = _samples[after_index]
	var before_time: float = float(before["time"])
	var after_time: float = float(after["time"])
	var blend: float = 0.0
	if after_time > before_time + TIME_EPSILON:
		blend = clampf((at_time - before_time) / (after_time - before_time), 0.0, 1.0)
	var before_position: Vector3 = before["position"]
	var after_position: Vector3 = after["position"]
	var replay_position: Vector3 = before_position.lerp(after_position, blend)
	if is_inside_tree():
		global_position = replay_position
	else:
		position = replay_position
	var before_aim: Vector3 = before["aim"]
	var after_aim: Vector3 = after["aim"]
	aim_direction = before_aim.lerp(after_aim, blend)
	if aim_direction.length_squared() > 0.0001 and _finite_vector(aim_direction):
		aim_direction = aim_direction.normalized()
		rotation.y = atan2(-aim_direction.x, -aim_direction.z)
	_update_trail()


func _copy_sample(sample: Dictionary, base_time: float) -> Dictionary:
	if not sample.has("position") or not sample.has("aim") or not sample.has("shots"):
		return {}
	var position_value: Variant = sample["position"]
	var aim_value: Variant = sample["aim"]
	var shots_value: Variant = sample["shots"]
	if not position_value is Vector3 or not aim_value is Vector3 or not shots_value is Array:
		return {}
	var position: Vector3 = position_value
	var aim: Vector3 = aim_value
	if not _finite_vector(position) or not _finite_vector(aim):
		return {}
	var copied_shots: Array[Dictionary] = []
	var raw_shots: Array = shots_value
	for shot_variant: Variant in raw_shots:
		if not shot_variant is Dictionary:
			return {}
		var shot: Dictionary = shot_variant
		var copied_shot: Dictionary = _copy_shot(shot)
		if copied_shot.is_empty():
			return {}
		copied_shots.append(copied_shot)
	return {
		"time": maxf(float(sample["time"]) - base_time, 0.0),
		"position": position,
		"aim": aim,
		"shots": copied_shots,
	}


func _copy_shot(shot: Dictionary) -> Dictionary:
	var has_required_keys: bool = true
	for key: String in ["origin", "direction", "damage", "bounces", "speed"]:
		has_required_keys = has_required_keys and shot.has(key)
	if not has_required_keys:
		return {}
	var origin_value: Variant = shot["origin"]
	var direction_value: Variant = shot["direction"]
	var damage_value: Variant = shot["damage"]
	var bounces_value: Variant = shot["bounces"]
	var speed_value: Variant = shot["speed"]
	if (
		(not origin_value is Vector3)
		or (not direction_value is Vector3)
		or (not damage_value is int)
		or (not bounces_value is int)
		or (not _is_number(speed_value))
	):
		return {}
	var origin: Vector3 = origin_value
	var shot_direction: Vector3 = direction_value
	var shot_damage: int = damage_value
	var shot_bounces: int = bounces_value
	var shot_speed: float = float(speed_value)
	var valid: bool = (
		_finite_vector(origin)
		and _finite_vector(shot_direction)
		and shot_direction.length_squared() > 0.0001
		and shot_damage > 0
		and shot_bounces >= 0
		and is_finite(shot_speed)
		and shot_speed >= 0.0
	)
	if not valid:
		return {}
	return {
		"origin": origin,
		"direction": shot_direction,
		"damage": shot_damage,
		"bounces": shot_bounces,
		"speed": shot_speed,
	}


func _ensure_visual() -> void:
	if _visual_ready:
		return
	_visual_ready = true
	var packed_model: PackedScene = load(PLAYER_MODEL_PATH) as PackedScene
	if packed_model == null:
		push_error("RushEcho player model is missing or not a PackedScene: %s" % PLAYER_MODEL_PATH)
	else:
		_model_instance = packed_model.instantiate()
		_model_instance.name = "HologramModel"
		add_child(_model_instance)
		_apply_hologram_materials(_model_instance)

	_ring = MeshInstance3D.new()
	_ring.name = "EchoRing"
	var ring_mesh: TorusMesh = TorusMesh.new()
	ring_mesh.inner_radius = 0.43
	ring_mesh.outer_radius = 0.48
	ring_mesh.rings = 24
	ring_mesh.ring_segments = 8
	_ring.mesh = ring_mesh
	_ring.position = Vector3(0.0, 0.05, 0.0)
	_ring.material_override = _new_hologram_material(0.34)
	add_child(_ring)

	_trail = MeshInstance3D.new()
	_trail.name = "EchoTrail"
	_trail_mesh = ImmediateMesh.new()
	_trail.mesh = _trail_mesh
	_trail_material = _new_hologram_material(0.22)
	_trail.material_override = _trail_material
	_trail.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(_trail)
	_update_trail()


func _apply_hologram_materials(node: Node) -> void:
	if node is MeshInstance3D:
		var mesh_instance: MeshInstance3D = node as MeshInstance3D
		mesh_instance.material_override = _new_hologram_material(0.24)
		mesh_instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	if node is CollisionObject3D:
		var collision_object: CollisionObject3D = node as CollisionObject3D
		collision_object.collision_layer = 0
		collision_object.collision_mask = 0
	if node is CollisionShape3D:
		var collision_shape: CollisionShape3D = node as CollisionShape3D
		collision_shape.set_deferred("disabled", true)
	for child: Node in node.get_children():
		_apply_hologram_materials(child)


func _new_hologram_material(alpha: float) -> StandardMaterial3D:
	var material: StandardMaterial3D = StandardMaterial3D.new()
	var cyan: Color = Color(0.26, 0.96, 1.0, clampf(alpha, 0.0, 1.0))
	material.albedo_color = cyan
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.cull_mode = BaseMaterial3D.CULL_BACK
	material.emission_enabled = true
	material.emission = Color(0.12, 0.86, 1.0, 1.0)
	material.emission_energy_multiplier = 0.7
	return material


func _update_trail() -> void:
	if not is_instance_valid(_trail_mesh) or not is_inside_tree():
		return
	if _trail_positions.is_empty() or _trail_positions[-1].distance_to(global_position) > 0.01:
		_trail_positions.append(global_position)
		while _trail_positions.size() > TRAIL_POINTS:
			_trail_positions.remove_at(0)
	_trail_mesh.clear_surfaces()
	if _trail_positions.size() < 2:
		return
	_trail_mesh.surface_begin(Mesh.PRIMITIVE_LINES, _trail_material)
	for index: int in range(_trail_positions.size() - 1):
		var from: Vector3 = to_local(_trail_positions[index] + Vector3.UP * 0.13)
		var to: Vector3 = to_local(_trail_positions[index + 1] + Vector3.UP * 0.13)
		_trail_mesh.surface_add_vertex(from)
		_trail_mesh.surface_add_vertex(to)
	_trail_mesh.surface_end()


func _finish() -> void:
	if _finished:
		return
	_finished = true
	_valid = false
	emit_signal("finished")
	queue_free()


func _reject_setup() -> bool:
	_samples.clear()
	duration = 0.0
	_valid = false
	_finished = true
	if is_inside_tree():
		queue_free()
	return false


func _is_number(value: Variant) -> bool:
	return value is int or value is float


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)
