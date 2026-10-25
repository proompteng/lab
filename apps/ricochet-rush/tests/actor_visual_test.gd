extends SceneTree

const MODEL_PATHS: Array[String] = [
	"res://assets/models/player.glb",
	"res://assets/models/enemy_chaser.glb",
	"res://assets/models/enemy_runner.glb",
	"res://assets/models/enemy_brute.glb",
	"res://assets/models/enemy_turret.glb",
]
const MODEL_LABELS: Array[String] = ["player", "chaser", "runner", "brute", "turret"]

var _checks: int = 0
var _failures: int = 0


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	await _test_authored_models()
	await _test_player_camera_visibility()
	print("Actor visual tests: %d/%d checks passed" % [_checks - _failures, _checks])
	quit(1 if _failures > 0 else 0)


func _test_authored_models() -> void:
	for index: int in MODEL_PATHS.size():
		await _test_model(MODEL_PATHS[index], MODEL_LABELS[index], _required_legs(index))


func _test_model(path: String, label: String, required_legs: Array[String]) -> void:
	var packed_model: PackedScene = load(path) as PackedScene
	_check(packed_model != null, "%s GLB loads as a PackedScene" % label)
	if packed_model == null:
		return
	var actor := Node3D.new()
	actor.name = "ActorHarness_%s" % label
	root.add_child(actor)
	var model: Node3D = packed_model.instantiate() as Node3D
	_check(model != null, "%s GLB instantiates as Node3D" % label)
	if model == null:
		actor.queue_free()
		await process_frame
		return
	actor.add_child(model)
	var driver := RushActorVisual.new()
	driver.name = "ActorVisualHarness"
	actor.add_child(driver)
	driver.bind_model(model)
	await process_frame

	_check(driver.marker_contract_valid, "%s has the required weapon marker contract" % label)
	var weapon_pitch: Node3D = _find_node(model, "WeaponPitch")
	var muzzle: Node3D = _find_node(model, "Muzzle")
	_check(weapon_pitch != null, "%s exposes exact WeaponPitch marker" % label)
	_check(muzzle != null, "%s exposes exact Muzzle marker" % label)
	if weapon_pitch != null and muzzle != null:
		_check(weapon_pitch.is_ancestor_of(muzzle), "%s Muzzle is driven below WeaponPitch" % label)
	var muzzle_position: Vector3 = driver.muzzle_global_position()
	_check(_finite_vector(muzzle_position), "%s muzzle position is finite" % label)
	_check(
		(
			muzzle_position.distance_to(actor.global_position) > 0.05
			and muzzle_position.distance_to(actor.global_position) < 4.0
		),
		"%s muzzle sits within the model envelope" % label
	)
	_check(
		muzzle_position.y >= -0.05 and muzzle_position.y <= 3.5,
		"%s muzzle height is physically plausible" % label
	)

	var mesh: MeshInstance3D = _find_mesh(model)
	_check(mesh != null, "%s contains authored mesh geometry" % label)
	var leg_nodes: Array[Node3D] = []
	var leg_before: Array[Vector3] = []
	for leg_name: String in required_legs:
		var leg: Node3D = _find_node(model, leg_name)
		_check(leg != null, "%s exposes exact %s pivot" % [label, leg_name])
		if leg != null:
			leg_nodes.append(leg)
			leg_before.append(leg.rotation)
	if required_legs.is_empty():
		_check(label == "turret", "%s is the only stationary model without leg pivots" % label)

	var base_weapon_rotation: Vector3 = (
		weapon_pitch.rotation if weapon_pitch != null else Vector3.ZERO
	)
	driver.set_weapon_aim(Vector3(0.0, 0.0, -1.0))
	var level_muzzle: Vector3 = driver.muzzle_global_position()
	var level_pitch: float = weapon_pitch.rotation.x if weapon_pitch != null else 0.0
	driver.set_weapon_aim(Vector3(0.0, 0.72, -1.0).normalized())
	var elevated_muzzle: Vector3 = driver.muzzle_global_position()
	var elevated_pitch: float = weapon_pitch.rotation.x if weapon_pitch != null else 0.0
	_check(
		weapon_pitch != null and absf(elevated_pitch - level_pitch) > 0.05,
		"%s weapon pitch responds to full 3D aim" % label
	)
	_check(
		_finite_vector(elevated_muzzle) and elevated_muzzle.distance_to(level_muzzle) > 0.001,
		"%s authored muzzle follows weapon elevation" % label
	)
	var steep_down_aim: Vector3 = Vector3(0.0, -3.73205, -1.0).normalized()
	driver.set_weapon_aim(steep_down_aim)
	var steep_down_pitch: float = weapon_pitch.rotation.x if weapon_pitch != null else 0.0
	var steep_down_muzzle: Vector3 = driver.muzzle_global_position()
	_check(
		weapon_pitch != null and absf(steep_down_pitch - base_weapon_rotation.x + 1.309) < 0.12,
		"%s weapon pitch follows a steep downward 75 degree aim" % label
	)
	_check(
		(
			_finite_vector(steep_down_muzzle)
			and steep_down_muzzle.y >= -0.2
			and steep_down_muzzle.y <= 3.5
		),
		"%s steep downward muzzle remains finite and above the floor" % label
	)

	driver.set_flash(1.0)
	_check(
		mesh != null and mesh.material_overlay != null,
		"%s damage flash overlays authored mesh" % label
	)
	driver.set_flash(0.0)
	_check(
		mesh == null or mesh.material_overlay == null,
		"%s damage flash clears without replacing mesh material" % label
	)

	for _step_index: int in 12:
		driver.step(1.0 / 60.0, Vector3(6.0, 0.0, 0.0), Vector3.FORWARD)
	for index: int in leg_nodes.size():
		var leg_after: Node3D = leg_nodes[index]
		_check(
			leg_after != null and not leg_after.rotation.is_equal_approx(leg_before[index]),
			"%s gait moves %s by traveled distance" % [label, leg_after.name]
		)
	driver.reset_motion()
	for index: int in leg_nodes.size():
		var reset_leg: Node3D = leg_nodes[index]
		_check(
			reset_leg != null and reset_leg.rotation.is_equal_approx(leg_before[index]),
			"%s gait reset restores %s pivot" % [label, reset_leg.name]
		)
	_check(
		weapon_pitch == null or weapon_pitch.rotation.is_equal_approx(base_weapon_rotation),
		"%s aim reset restores WeaponPitch" % label
	)
	_check(mesh == null or mesh.material_overlay == null, "%s reset clears mesh flash" % label)

	actor.queue_free()
	await process_frame


func _test_player_camera_visibility() -> void:
	var player := RushPlayer.new()
	root.add_child(player)
	await process_frame
	var model: Node3D = player.get_node_or_null("ModelAsset") as Node3D
	_check(model != null, "player actor owns the authored ModelAsset")
	if model == null:
		player.queue_free()
		await process_frame
		return
	_check(model.visible, "player model starts visible")
	player.set_camera_clearance(0.5)
	_check(not model.visible, "close camera clearance hides only the player model")
	player.set_camera_clearance(0.74)
	_check(not model.visible, "camera hide hysteresis holds through the middle band")
	player.set_camera_clearance(0.9)
	_check(model.visible, "camera clearance restores the player model")
	player.set_camera_clearance(0.74)
	_check(model.visible, "restored model stays visible through the middle band")
	player.reset_at(Vector3.ZERO)
	_check(model.visible, "player reset restores model visibility")
	player.queue_free()
	await process_frame


func _required_legs(index: int) -> Array[String]:
	match index:
		0, 1, 2:
			return ["Leg_FL", "Leg_FR"]
		3:
			return ["Leg_FL", "Leg_FR", "Leg_RL", "Leg_RR"]
		_:
			return []


func _find_node(root_node: Node, node_name: String) -> Node3D:
	if not is_instance_valid(root_node):
		return null
	return root_node.find_child(node_name, true, false) as Node3D


func _find_mesh(node: Node) -> MeshInstance3D:
	if node is MeshInstance3D:
		return node as MeshInstance3D
	for child: Node in node.get_children():
		var found: MeshInstance3D = _find_mesh(child)
		if found != null:
			return found
	return null


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)


func _check(condition: bool, description: String) -> void:
	_checks += 1
	if condition:
		print("PASS: ", description)
	else:
		_failures += 1
		push_error("FAIL: " + description)
