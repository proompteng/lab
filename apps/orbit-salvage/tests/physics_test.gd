extends SceneTree

const TUG_SCRIPT: Script = preload("res://scripts/tug.gd")
const CARGO_SCRIPT: Script = preload("res://scripts/salvage.gd")
const TETHER_SCRIPT: Script = preload("res://scripts/tether.gd")
const ASTEROID_SCRIPT: Script = preload("res://scripts/asteroid.gd")

var _passed: int = 0
var _failed: int = 0
var _destroyed_events: int = 0


func _initialize() -> void:
	call_deferred("_run_tests")


func _run_tests() -> void:
	await process_frame
	await _test_attach_validation()
	await _test_mass_acceleration()
	await _test_spring_reaction_and_restoration()
	await _test_translation_invariance()
	await _test_release_and_stale_references()
	await _test_impact_damage_and_destroyed_signal()
	await _test_tug_controls_and_fuel()
	await _test_bidirectional_cruise_limit()
	await _test_thrust_brakes_above_cruise()
	await _test_slack_cable_is_force_free()
	print("Physics tests: %d PASS, %d FAIL" % [_passed, _failed])
	quit(1 if _failed > 0 else 0)


func _test_attach_validation() -> void:
	var world: Node2D = _new_world()
	var tug: SalvageTug = _new_tug(world, Vector2.ZERO)
	var cargo: SalvageCargo = _new_cargo(
		world, 1, 200, 3.0, Vector2(0.0, SalvageTether.MAX_ATTACH_DISTANCE + 12.0)
	)
	var tether: SalvageTether = _new_tether(world)
	_expect(not tether.attach(tug, cargo), "attach rejects cargo beyond maximum distance")
	_expect(not tether.is_attached(), "rejected attach leaves tether detached")
	cargo.global_position = Vector2(0.0, 120.0)
	_expect(tether.attach(tug, cargo), "attach accepts a valid undelivered pair")
	var second_cargo: SalvageCargo = _new_cargo(world, 2, 300, 4.0, Vector2(0.0, 135.0))
	_expect(not tether.attach(tug, second_cargo), "active tether cannot be overwritten")
	_expect(tether.cargo == cargo, "failed overwrite preserves the active cargo")
	tether.release()
	cargo.delivered = true
	_expect(not tether.attach(tug, cargo), "attach rejects delivered cargo")
	_expect(not cargo.tethered, "delivered cargo is not left tethered")
	await _cleanup(world)


func _test_mass_acceleration() -> void:
	var world: Node2D = _new_world()
	var light: SalvageCargo = _new_cargo(world, 10, 100, 1.5, Vector2(-80.0, -30.0))
	var heavy: SalvageCargo = _new_cargo(world, 11, 100, 7.0, Vector2(-80.0, 30.0))
	await _wait_physics(2)
	for _index: int in range(30):
		light.apply_central_force(Vector2.RIGHT * 350.0)
		heavy.apply_central_force(Vector2.RIGHT * 350.0)
		await physics_frame
	_expect(
		light.linear_velocity.x > heavy.linear_velocity.x + 8.0,
		"heavier cargo accelerates slower under the same force"
	)
	_expect(light.mass < heavy.mass, "cargo setup preserves the requested mass range")
	await _cleanup(world)


func _test_spring_reaction_and_restoration() -> void:
	var world: Node2D = _new_world()
	var tug: SalvageTug = _new_tug(world, Vector2.ZERO)
	var cargo: SalvageCargo = _new_cargo(world, 20, 250, 4.0, Vector2(120.0, 0.0))
	var tether: SalvageTether = _new_tether(world)
	tether.rest_length = 70.0
	_expect(tether.attach(tug, cargo), "spring test attaches valid bodies")
	await _wait_physics(2)
	var initial_distance: float = tug.global_position.distance_to(cargo.global_position)
	var initial_tug_velocity: Vector2 = tug.linear_velocity
	var initial_cargo_velocity: Vector2 = cargo.linear_velocity
	await physics_frame
	var tug_impulse: Vector2 = (tug.linear_velocity - initial_tug_velocity) * tug.mass
	var cargo_impulse: Vector2 = (cargo.linear_velocity - initial_cargo_velocity) * cargo.mass
	_expect(
		tug.linear_velocity.x > initial_tug_velocity.x,
		"stretched spring pulls the tug toward cargo"
	)
	_expect(
		cargo.linear_velocity.x < initial_cargo_velocity.x,
		"stretched spring pulls cargo toward tug"
	)
	_expect(
		(tug_impulse + cargo_impulse).length() < 1.0, "spring applies equal and opposite reaction"
	)
	await _wait_physics(45)
	var restored_distance: float = tug.global_position.distance_to(cargo.global_position)
	_expect(restored_distance < initial_distance - 4.0, "spring damping reduces cable stretch")
	_expect(
		tether.tension >= 0.0 and tether.tension <= 1.0,
		"spring tension stays in its declared range"
	)
	tether.release()
	await _cleanup(world)


func _test_release_and_stale_references() -> void:
	var world: Node2D = _new_world()
	var tug: SalvageTug = _new_tug(world, Vector2.ZERO)
	var cargo: SalvageCargo = _new_cargo(world, 30, 180, 2.5, Vector2(120.0, 0.0))
	var tether: SalvageTether = _new_tether(world)
	tether.rest_length = 60.0
	_expect(tether.attach(tug, cargo), "release test attaches valid bodies")
	await _wait_physics(2)
	tether.release()
	_expect(not tether.is_attached(), "release clears tether attachment")
	_expect(not cargo.tethered, "release clears cargo tether state")
	_expect(is_zero_approx(tether.tension), "release clears tension")
	tug.linear_velocity = Vector2.ZERO
	cargo.linear_velocity = Vector2.ZERO
	await _wait_physics(6)
	_expect(
		tug.linear_velocity.length() < 0.05 and cargo.linear_velocity.length() < 0.05,
		"released tether applies no later force"
	)

	var stale_tether: SalvageTether = _new_tether(world)
	var stale_cargo: SalvageCargo = _new_cargo(world, 31, 180, 3.0, Vector2(100.0, 0.0))
	_expect(stale_tether.attach(tug, stale_cargo), "stale reference test attaches valid bodies")
	stale_cargo.queue_free()
	await process_frame
	await physics_frame
	_expect(not stale_tether.is_attached(), "freed cargo is detached safely")
	_expect(
		stale_tether.tug == null and stale_tether.cargo == null,
		"freed cargo clears both stale references"
	)

	var delivered_tether: SalvageTether = _new_tether(world)
	var delivered_cargo: SalvageCargo = _new_cargo(world, 32, 180, 3.0, Vector2(100.0, 0.0))
	_expect(
		delivered_tether.attach(tug, delivered_cargo),
		"delivered reference test attaches valid bodies"
	)
	delivered_cargo.delivered = true
	await physics_frame
	_expect(not delivered_tether.is_attached(), "cargo delivered during tow releases safely")
	_expect(not delivered_cargo.tethered, "delivered cargo clears tether state")
	await _cleanup(world)


func _test_translation_invariance() -> void:
	var world_a: Node2D = _new_world()
	var world_b: Node2D = _new_world()
	world_b.position = Vector2(5000.0, -3000.0)
	var tug_a: SalvageTug = _new_tug(world_a, Vector2.ZERO)
	var cargo_a: SalvageCargo = _new_cargo(world_a, 40, 200, 4.5, Vector2(135.0, 18.0))
	var tether_a: SalvageTether = _new_tether(world_a)
	tether_a.rest_length = 72.0
	var offset: Vector2 = world_b.global_position
	var tug_b: SalvageTug = _new_tug(world_b, offset)
	var cargo_b: SalvageCargo = _new_cargo(world_b, 40, 200, 4.5, offset + Vector2(135.0, 18.0))
	var tether_b: SalvageTether = _new_tether(world_b)
	tether_b.rest_length = 72.0
	_expect(tether_a.attach(tug_a, cargo_a), "origin system attaches for translation check")
	_expect(tether_b.attach(tug_b, cargo_b), "translated system attaches for translation check")
	await _wait_physics(30)
	_expect(
		(tug_a.linear_velocity - tug_b.linear_velocity).length() < 0.05,
		"tether linear response is translation invariant"
	)
	_expect(
		absf(tug_a.angular_velocity - tug_b.angular_velocity) < 0.05,
		"tether torque response is translation invariant"
	)
	_expect(
		(tug_b.global_position - tug_a.global_position - offset).length() < 0.3,
		"translated tug preserves relative position"
	)
	await _cleanup(world_a)
	await _cleanup(world_b)


func _test_impact_damage_and_destroyed_signal() -> void:
	var overlap_world: Node2D = _new_world()
	var overlap_tug: SalvageTug = _new_tug(overlap_world, Vector2.ZERO)
	var overlap_asteroid: SalvageAsteroid = _new_asteroid(overlap_world, 48.0, 90, Vector2.ZERO)
	await _wait_physics(2)
	_expect(
		overlap_tug.hull == SalvageTug.HULL_MAX, "initial overlap does not cause zero-time crash"
	)
	await _cleanup(overlap_world)

	var world: Node2D = _new_world()
	var tug: SalvageTug = _new_tug(world, Vector2(-150.0, 0.0))
	var asteroid: SalvageAsteroid = _new_asteroid(world, 46.0, 91, Vector2.ZERO)
	await _wait_physics(5)
	tug.linear_velocity = Vector2(300.0, 0.0)
	await _wait_physics(26)
	_expect(tug.hull < SalvageTug.HULL_MAX, "high-speed asteroid impact damages the tug")

	_destroyed_events = 0
	var signal_tug: SalvageTug = _new_tug(world, Vector2(500.0, 0.0))
	signal_tug.destroyed.connect(_on_destroyed)
	signal_tug.take_damage(SalvageTug.HULL_MAX)
	_expect(signal_tug.hull == 0.0, "fatal damage clamps hull at zero")
	_expect(_destroyed_events == 1, "fatal damage emits destroyed exactly once")
	signal_tug.take_damage(10.0)
	_expect(_destroyed_events == 1, "destroyed tug ignores repeated fatal damage")
	await _cleanup(world)


func _test_tug_controls_and_fuel() -> void:
	var world: Node2D = _new_world()
	var tug: SalvageTug = _new_tug(world, Vector2.ZERO)
	tug.controls_enabled = true
	tug.input_thrust = 1.0
	tug.input_boost = false
	await _wait_physics(75)
	_expect(
		tug.linear_velocity.length() > 80.0,
		"ordinary thrust gives an empty tug meaningful momentum"
	)
	_expect(is_equal_approx(tug.fuel, SalvageTug.FUEL_MAX), "ordinary thrust does not drain fuel")
	var boosted_fuel: float = tug.fuel
	tug.input_boost = true
	await _wait_physics(10)
	_expect(tug.fuel < boosted_fuel, "boost drains fuel while active")
	tug.input_boost = false
	await _cleanup(world)


func _test_bidirectional_cruise_limit() -> void:
	var world: Node2D = _new_world()
	var forward_tug: SalvageTug = _new_tug(world, Vector2(0.0, -200.0))
	var reverse_tug: SalvageTug = _new_tug(world, Vector2(0.0, 200.0))
	var analog_tug: SalvageTug = _new_tug(world, Vector2(0.0, 600.0))
	forward_tug.controls_enabled = true
	forward_tug.input_thrust = 1.0
	reverse_tug.controls_enabled = true
	reverse_tug.input_thrust = -1.0
	analog_tug.controls_enabled = true
	analog_tug.input_thrust = -0.5
	analog_tug.linear_velocity = Vector2(-600.0, 0.0)
	await _wait_physics(1200)
	var maximum_speed: float = SalvageTug.MAX_CRUISE_SPEED + SalvageTug.CRUISE_SPEED_BAND
	_expect(
		forward_tug.linear_velocity.length() <= maximum_speed,
		"sustained forward thrust stays within the cruise band"
	)
	_expect(
		reverse_tug.linear_velocity.length() <= maximum_speed,
		"sustained reverse thrust stays within the cruise band"
	)
	_expect(
		absf(forward_tug.linear_velocity.x + reverse_tug.linear_velocity.x) < 0.1,
		"forward and reverse cruise limits are symmetric"
	)
	_expect(
		analog_tug.linear_velocity.length() <= maximum_speed,
		"partial reverse input respects the same cruise band"
	)
	await _cleanup(world)


func _test_thrust_brakes_above_cruise() -> void:
	var world: Node2D = _new_world()
	var forward_tug: SalvageTug = _new_tug(world, Vector2(0.0, -200.0))
	var reverse_tug: SalvageTug = _new_tug(world, Vector2(0.0, 200.0))
	var coasting_tug: SalvageTug = _new_tug(world, Vector2(0.0, 600.0))
	forward_tug.controls_enabled = true
	forward_tug.input_thrust = -1.0
	forward_tug.linear_velocity = Vector2(600.0, 0.0)
	reverse_tug.controls_enabled = true
	reverse_tug.input_thrust = 1.0
	reverse_tug.linear_velocity = Vector2(-600.0, 0.0)
	coasting_tug.linear_velocity = Vector2(600.0, 0.0)
	await _wait_physics(60)
	var coasting_speed: float = coasting_tug.linear_velocity.length()
	_expect(
		forward_tug.linear_velocity.length() < coasting_speed - 50.0,
		"reverse thrust still brakes forward travel above the cruise band"
	)
	_expect(
		reverse_tug.linear_velocity.length() < coasting_speed - 50.0,
		"forward thrust still brakes reverse travel above the cruise band"
	)
	await _cleanup(world)


func _test_slack_cable_is_force_free() -> void:
	var world: Node2D = _new_world()
	var tug: SalvageTug = _new_tug(world, Vector2.ZERO)
	var cargo: SalvageCargo = _new_cargo(world, 50, 150, 5.0, Vector2(80.0, 0.0))
	var tether: SalvageTether = _new_tether(world)
	tether.rest_length = 105.0
	_expect(tether.attach(tug, cargo), "slack test attaches valid bodies")
	await _wait_physics(2)
	var tug_velocity: Vector2 = tug.linear_velocity
	var cargo_velocity: Vector2 = cargo.linear_velocity
	await _wait_physics(12)
	_expect(tether.tension == 0.0, "slack cable reports zero tension")
	_expect(
		(tug.linear_velocity - tug_velocity).length() < 0.05, "slack cable applies no tug force"
	)
	_expect(
		(cargo.linear_velocity - cargo_velocity).length() < 0.05,
		"slack cable applies no cargo force"
	)
	await _cleanup(world)


func _new_world() -> Node2D:
	var world: Node2D = Node2D.new()
	world.name = "PhysicsTestWorld"
	get_root().add_child(world)
	return world


func _new_tug(world: Node2D, position: Vector2) -> SalvageTug:
	var tug: SalvageTug = TUG_SCRIPT.new() as SalvageTug
	world.add_child(tug)
	tug.global_position = position
	return tug


func _new_cargo(
	world: Node2D, cargo_id: int, value: int, cargo_mass: float, position: Vector2
) -> SalvageCargo:
	var cargo: SalvageCargo = CARGO_SCRIPT.new() as SalvageCargo
	cargo.setup(cargo_id, value, cargo_mass, "TEST CARGO", Color(0.95, 0.44, 0.12))
	world.add_child(cargo)
	cargo.global_position = position
	return cargo


func _new_tether(world: Node2D) -> SalvageTether:
	var tether: SalvageTether = TETHER_SCRIPT.new() as SalvageTether
	world.add_child(tether)
	return tether


func _new_asteroid(
	world: Node2D, asteroid_radius: float, seed: int, position: Vector2
) -> SalvageAsteroid:
	var asteroid: SalvageAsteroid = ASTEROID_SCRIPT.new() as SalvageAsteroid
	asteroid.setup(asteroid_radius, seed)
	world.add_child(asteroid)
	asteroid.global_position = position
	return asteroid


func _wait_physics(frames: int) -> void:
	for _index: int in range(maxi(frames, 0)):
		await physics_frame


func _cleanup(world: Node2D) -> void:
	world.queue_free()
	await process_frame
	await physics_frame


func _on_destroyed() -> void:
	_destroyed_events += 1


func _expect(condition: bool, message: String) -> void:
	if condition:
		_passed += 1
		print("PASS: %s" % message)
	else:
		_failed += 1
		push_error("FAIL: %s" % message)
