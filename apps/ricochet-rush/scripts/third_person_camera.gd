class_name RushCamera
extends Camera3D

const WORLD_LAYER: int = 1 << 1
const TARGET_PIVOT_HEIGHT: float = 1.45
const HIP_DISTANCE: float = 4.0
const AIM_DISTANCE: float = 2.5
const SHOULDER_OFFSET: float = 0.7
const HIP_FOV: float = 72.0
const AIM_FOV: float = 56.0
const LOOK_SENSITIVITY: float = 0.0025
const DEFAULT_PITCH: float = -0.1745329252
const MIN_PITCH: float = -1.1344640138
const MAX_PITCH: float = 0.4363323129
const CAMERA_RADIUS: float = 0.22
const CAMERA_SKIN: float = 0.08
const FOLLOW_SPEED: float = 14.0
const OBSTRUCTED_FOLLOW_SPEED: float = 28.0
const FOV_SPEED: float = 10.0
const MAX_STEP: float = 0.25
const MIN_MOTION: float = 0.0001

var target: Node3D
var aiming: bool = false
var yaw: float = 0.0
var pitch: float = DEFAULT_PITCH

var _sphere_shape: SphereShape3D


func _init() -> void:
	projection = Camera3D.PROJECTION_PERSPECTIVE
	fov = HIP_FOV
	near = 0.08


func reset_follow(target_node: Node3D) -> void:
	target = target_node
	if not is_instance_valid(target):
		return
	yaw = wrapf(yaw, -PI, PI)
	pitch = clampf(pitch, MIN_PITCH, MAX_PITCH)
	var pivot: Vector3 = _target_pivot()
	if not _finite_vector(pivot):
		return
	var desired: Vector3 = _desired_position(pivot, _desired_distance())
	var safe_position: Vector3 = _safe_position(pivot, desired)
	_set_camera_pose(safe_position)
	fov = AIM_FOV if aiming else HIP_FOV


func look(relative: Vector2) -> void:
	if not _finite_vector2(relative):
		return
	yaw = wrapf(yaw - relative.x * LOOK_SENSITIVITY, -PI, PI)
	pitch = clampf(pitch - relative.y * LOOK_SENSITIVITY, MIN_PITCH, MAX_PITCH)


func move_vector(input: Vector2) -> Vector2:
	if not _finite_vector2(input):
		return Vector2.ZERO
	var constrained_input: Vector2 = input
	var input_length: float = constrained_input.length()
	if input_length > 1.0:
		constrained_input /= input_length
	var forward: Vector3 = _flat_forward()
	var right: Vector3 = _flat_right()
	var world_vector: Vector3 = right * constrained_input.x + forward * -constrained_input.y
	if not _finite_vector(world_vector):
		return Vector2.ZERO
	return Vector2(world_vector.x, world_vector.z)


func step(delta: float) -> void:
	if not is_finite(delta) or delta <= 0.0 or not is_instance_valid(target):
		return
	var step_delta: float = clampf(delta, 0.0, MAX_STEP)
	yaw = wrapf(yaw, -PI, PI)
	pitch = clampf(pitch, MIN_PITCH, MAX_PITCH)
	var pivot: Vector3 = _target_pivot()
	if not _finite_vector(pivot):
		return
	var desired: Vector3 = _desired_position(pivot, _desired_distance())
	if not _finite_vector(desired):
		return
	var safe_position: Vector3 = _safe_position(pivot, desired)
	var obstructed: bool = safe_position.distance_to(desired) > CAMERA_SKIN * 0.5
	var current_position: Vector3 = _current_position()
	var follow_rate: float = OBSTRUCTED_FOLLOW_SPEED if obstructed else FOLLOW_SPEED
	var follow_alpha: float = 1.0 - exp(-follow_rate * step_delta)
	var next_position: Vector3 = current_position.lerp(safe_position, follow_alpha)
	# A second cast keeps a stale or newly obstructed pose from crossing a wall
	# while the camera follows a moving target or recovers from an obstruction.
	next_position = _safe_position(pivot, next_position)
	_set_camera_pose(next_position)
	var desired_fov: float = AIM_FOV if aiming else HIP_FOV
	var fov_alpha: float = 1.0 - exp(-FOV_SPEED * step_delta)
	fov = lerpf(fov, desired_fov, fov_alpha)


func _target_pivot() -> Vector3:
	if not is_instance_valid(target):
		return Vector3.INF
	var target_position: Vector3 = (
		target.global_position if target.is_inside_tree() else target.position
	)
	return target_position + Vector3.UP * TARGET_PIVOT_HEIGHT


func _desired_distance() -> float:
	return AIM_DISTANCE if aiming else HIP_DISTANCE


func _desired_position(pivot: Vector3, distance: float) -> Vector3:
	return pivot - _camera_forward() * distance + _flat_right() * SHOULDER_OFFSET


func _camera_forward() -> Vector3:
	var cos_pitch: float = cos(pitch)
	return Vector3(-sin(yaw) * cos_pitch, sin(pitch), -cos(yaw) * cos_pitch).normalized()


func _flat_forward() -> Vector3:
	return Vector3(-sin(yaw), 0.0, -cos(yaw)).normalized()


func _flat_right() -> Vector3:
	return Vector3(cos(yaw), 0.0, -sin(yaw)).normalized()


func _current_position() -> Vector3:
	return global_position if is_inside_tree() else position


func _set_camera_pose(at: Vector3) -> void:
	if not _finite_vector(at):
		return
	if is_inside_tree():
		global_position = at
	else:
		position = at
	rotation = Vector3(pitch, yaw, 0.0)


func _safe_position(start: Vector3, desired: Vector3) -> Vector3:
	if not _finite_vector(start) or not _finite_vector(desired):
		return start
	var motion: Vector3 = desired - start
	var motion_length: float = motion.length()
	if motion_length <= MIN_MOTION or not is_inside_tree():
		return desired
	var world: World3D = get_world_3d()
	var safe_position: Vector3 = desired
	if world != null:
		_ensure_sphere_shape()
		var query := PhysicsShapeQueryParameters3D.new()
		query.shape = _sphere_shape
		query.transform = Transform3D(Basis.IDENTITY, start)
		query.motion = motion
		query.collision_mask = WORLD_LAYER
		query.collide_with_bodies = true
		query.collide_with_areas = false
		var excluded: Array[RID] = []
		if target is CollisionObject3D:
			var target_body: CollisionObject3D = target as CollisionObject3D
			var target_rid: RID = target_body.get_rid()
			if target_rid.is_valid():
				excluded.append(target_rid)
		query.exclude = excluded
		var cast_result: PackedFloat32Array = world.direct_space_state.cast_motion(query)
		if not cast_result.is_empty():
			var safe_fraction: float = float(cast_result[0])
			if not is_finite(safe_fraction):
				safe_position = start
			else:
				safe_fraction = clampf(safe_fraction, 0.0, 1.0)
				if safe_fraction < 1.0 - 0.0001:
					var safe_travel: float = maxf(motion_length * safe_fraction - CAMERA_SKIN, 0.0)
					safe_position = start + motion / motion_length * safe_travel
	return safe_position


func _ensure_sphere_shape() -> void:
	if is_instance_valid(_sphere_shape):
		return
	_sphere_shape = SphereShape3D.new()
	_sphere_shape.radius = CAMERA_RADIUS


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)


func _finite_vector2(value: Vector2) -> bool:
	return is_finite(value.x) and is_finite(value.y)
