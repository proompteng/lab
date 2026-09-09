extends SceneTree

var _checks: int = 0
var _failures: int = 0


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	await _test_camera_controls()
	await _test_camera_collision_and_recovery()
	print("Camera tests: %d/%d checks passed" % [_checks - _failures, _checks])
	quit(0 if _failures == 0 else 1)


func _test_camera_controls() -> void:
	var world := Node3D.new()
	root.add_child(world)
	var target := _new_target(world, Vector3.ZERO)
	var camera: RushCamera = RushCamera.new()
	world.add_child(camera)
	await physics_frame
	camera.reset_follow(target)
	_check(absf(camera.fov - RushCamera.HIP_FOV) < 0.001, "hip FOV starts at 72 degrees")
	_check(camera.position.x > 0.4, "right shoulder offset frames the player to the left")
	_check(camera.position.z > 3.5, "hip camera stays close behind the player")
	_check(_finite_vector(camera.global_position), "camera pose remains finite")

	var forward_move: Vector2 = camera.move_vector(Vector2.UP)
	_check(
		forward_move.is_equal_approx(Vector2(0.0, -1.0)), "default forward input maps to world -Z"
	)
	var diagonal: Vector2 = camera.move_vector(Vector2.ONE)
	_check(absf(diagonal.length() - 1.0) < 0.001, "diagonal camera input is normalized")
	var analog: Vector2 = camera.move_vector(Vector2(0.3, -0.4))
	_check(absf(analog.length() - 0.5) < 0.001, "analog camera input preserves magnitude")
	camera.yaw = PI * 0.5
	var rotated_forward: Vector2 = camera.move_vector(Vector2.UP)
	_check(
		rotated_forward.x < -0.99 and absf(rotated_forward.y) < 0.01,
		"yaw rotates forward movement in world XZ"
	)
	var rotated_right: Vector2 = camera.move_vector(Vector2.RIGHT)
	_check(
		rotated_right.y < -0.99 and absf(rotated_right.x) < 0.01,
		"yaw rotates right movement in world XZ"
	)

	camera.yaw = 0.0
	camera.pitch = RushCamera.DEFAULT_PITCH
	var yaw_before: float = camera.yaw
	var pitch_before: float = camera.pitch
	camera.look(Vector2(100.0, -100.0))
	_check(
		absf(camera.yaw - (yaw_before - 0.25)) < 0.001,
		"mouse look applies the configured sensitivity"
	)
	_check(absf(camera.pitch - (pitch_before + 0.25)) < 0.001, "vertical mouse look updates pitch")
	camera.look(Vector2(100000.0, 100000.0))
	_check(
		camera.pitch >= RushCamera.MIN_PITCH and camera.pitch <= RushCamera.MAX_PITCH,
		"pitch stays within finite limits"
	)

	camera.yaw = 0.0
	camera.pitch = RushCamera.DEFAULT_PITCH
	camera.aiming = true
	for _index: int in 60:
		camera.step(1.0 / 60.0)
	_check(absf(camera.fov - RushCamera.AIM_FOV) < 0.1, "ADS smoothly reaches the close FOV")
	var pivot: Vector3 = target.global_position + Vector3.UP * RushCamera.TARGET_PIVOT_HEIGHT
	_check(
		camera.global_position.distance_to(pivot) < 2.8,
		"ADS contracts to the close shoulder distance"
	)
	await _destroy_world(world)


func _test_camera_collision_and_recovery() -> void:
	var world := Node3D.new()
	root.add_child(world)
	var target := _new_target(world, Vector3.ZERO)
	var camera: RushCamera = RushCamera.new()
	world.add_child(camera)
	await physics_frame
	camera.reset_follow(target)
	_check(camera.global_position.z > 3.5, "target collision is excluded from the camera sweep")
	var wall := _add_wall(world, Vector3(0.0, 1.5, 2.25), Vector3(8.0, 4.0, 0.2))
	await physics_frame
	camera.reset_follow(target)
	_check(camera.global_position.z < 2.2, "sphere sweep contracts the camera before a wall")
	_check(_finite_vector(camera.global_position), "occluded camera position stays finite")

	wall.queue_free()
	await process_frame
	await physics_frame
	for _index: int in 60:
		camera.step(1.0 / 60.0)
	_check(camera.global_position.z > 3.4, "camera smoothly recovers after wall release")
	_check(_finite_vector(camera.global_position), "recovered camera position stays finite")
	await _destroy_world(world)


func _new_target(world: Node3D, at: Vector3) -> CharacterBody3D:
	var target := CharacterBody3D.new()
	target.position = at
	target.collision_layer = 1
	target.collision_mask = 0
	var collision := CollisionShape3D.new()
	var shape := CapsuleShape3D.new()
	shape.radius = 0.45
	shape.height = 1.8
	collision.shape = shape
	collision.position = Vector3(0.0, 0.9, 0.0)
	target.add_child(collision)
	world.add_child(target)
	return target


func _add_wall(world: Node3D, at: Vector3, size: Vector3) -> StaticBody3D:
	var wall := StaticBody3D.new()
	wall.position = at
	wall.collision_layer = RushCamera.WORLD_LAYER
	wall.collision_mask = 0
	var collision := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = size
	collision.shape = shape
	wall.add_child(collision)
	world.add_child(wall)
	return wall


func _destroy_world(world: Node3D) -> void:
	if is_instance_valid(world):
		world.queue_free()
	await process_frame


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)


func _check(condition: bool, description: String) -> void:
	_checks += 1
	if condition:
		print("PASS: ", description)
	else:
		_failures += 1
		push_error("FAIL: " + description)
