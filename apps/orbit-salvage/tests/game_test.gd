extends SceneTree

var _failures: int = 0
var _checks: int = 0
var _game: OrbitSalvageGame
var _save_path: String = "user://orbit-salvage-test-%d.cfg" % OS.get_process_id()


func _initialize() -> void:
	_run.call_deferred()


func _check(condition: bool, description: String) -> void:
	_checks += 1
	if condition:
		print("PASS: ", description)
	else:
		_failures += 1
		push_error("FAIL: " + description)


func _frames(count: int) -> void:
	for _index: int in count:
		await physics_frame
		await process_frame


func _run() -> void:
	_test_profile()
	_game = OrbitSalvageGame.new()
	_game.profile.path = _save_path
	_game.manual_input = true
	root.add_child(_game)
	await _frames(3)
	_check(_game.phase == OrbitSalvageGame.Phase.TITLE, "game opens at the title screen")
	_check(_game.cargoes.size() == 12, "sector contains twelve recoverable pieces")
	await _test_parallax_depth()
	_game.start_run()
	await _frames(4)
	_check(_game.tug.controls_enabled, "launch enables actual flight controls")
	_check(not _game.tug.freeze, "launch enables the physics simulation")
	_game.tug.input_thrust = 1.0
	await _frames(30)
	_game.tug.input_thrust = 0.0
	_check(
		_game.tug.position.x > OrbitSalvageGame.START_POSITION.x + 3.0,
		"engine thrust moves the ship through the physics world"
	)
	_game.toggle_pause()
	var stopped_at: Vector2 = _game.tug.position
	for _index: int in 12:
		await process_frame
	_check(_game.tug.position.is_equal_approx(stopped_at), "pause freezes actual ship motion")
	_game.toggle_pause()
	_check(_game.phase == OrbitSalvageGame.Phase.PLAYING, "resume restores flight")
	_check(
		root.gui_get_focus_owner() == null, "resuming releases GUI focus so Space brakes the ship"
	)
	_test_save_failure_recovery()
	await _test_first_haul()
	await _test_delivery_rules()
	await _test_upgrades_and_completion()
	await _test_loss_and_retry()
	_game.return_to_title()
	_game.queue_free()
	await process_frame
	DirAccess.remove_absolute(_save_path)
	print("Game acceptance: %d/%d checks passed" % [_checks - _failures, _checks])
	quit(0 if _failures == 0 else 1)


func _test_parallax_depth() -> void:
	var camera_position: Vector2 = _game.camera.position
	var layers: Array[float] = [
		SalvageStarfield.FAR_STAR_MOTION,
		SalvageStarfield.MID_STAR_MOTION,
		SalvageStarfield.BRIGHT_STAR_MOTION,
	]
	var before: Array[Vector2] = []
	for motion: float in layers:
		before.append(
			(
				_game.starfield.get_global_transform_with_canvas()
				* _game.starfield._parallax_offset(motion)
			)
		)
	var camera_travel := Vector2(400.0, 200.0)
	_game.camera.position += camera_travel
	await _frames(3)
	var screen_travel: Vector2 = camera_travel * _game.camera.zoom
	var distances: Array[float] = []
	for index: int in layers.size():
		var after: Vector2 = (
			_game.starfield.get_global_transform_with_canvas()
			* _game.starfield._parallax_offset(layers[index])
		)
		var displacement: Vector2 = after - before[index]
		distances.append(displacement.length())
		_check(
			displacement.dot(screen_travel) < 0.0,
			"star layer %d moves opposite the camera on screen" % index
		)
	_check(
		(
			distances[0] < distances[1]
			and distances[1] < distances[2]
			and distances[2] < screen_travel.length()
		),
		"far stars move slower than nearer stars and foreground geometry"
	)
	_game.camera.position = camera_position
	await _frames(3)


func _test_save_failure_recovery() -> void:
	_game.profile.path = "user://missing-directory-%d/pilot.cfg" % OS.get_process_id()
	_game.toggle_sound()
	_check(
		not _game.storage_notice.is_empty(), "a failed preference save produces a visible notice"
	)
	_game.profile.path = _save_path
	_game.toggle_sound()
	_check(_game.storage_notice.is_empty(), "a successful save clears the earlier failure notice")


func _test_profile() -> void:
	var profile := SalvageProfile.new()
	profile.path = _save_path
	_check(
		profile.load_profile() == OK and profile.best_haul == 0,
		"a new pilot needs no existing save file"
	)
	profile.muted = true
	_check(profile.finish_run(345) == OK, "flight record saves successfully")
	var restored := SalvageProfile.new()
	restored.path = _save_path
	_check(restored.load_profile() == OK, "saved pilot record reloads")
	_check(
		restored.best_haul == 345 and restored.completed_runs == 1 and restored.muted,
		"best haul and sound preference survive reload"
	)
	_check(
		restored.finish_run(100) == OK and restored.best_haul == 345,
		"a smaller haul preserves the best record"
	)
	var invalid := ConfigFile.new()
	invalid.set_value("pilot", "best_haul", "not-a-score")
	invalid.save(_save_path)
	_check(restored.load_profile() == ERR_INVALID_DATA, "invalid save data is reported explicitly")
	DirAccess.remove_absolute(_save_path)
	_check(
		restored.load_profile() == OK and restored.best_haul == 0,
		"a removed save reloads fresh defaults"
	)


func _test_first_haul() -> void:
	var first: SalvageCargo = _game.cargoes[0]
	_game.interact_tether()
	if not _game.tether.is_attached():
		_game.tug.input_thrust = 0.6
		await _frames(36)
		_game.tug.input_thrust = 0.0
		_game.interact_tether()
	_check(
		_game.tether.is_attached(),
		"pilot can approach and attach the first salvage through the game interaction"
	)
	var initial_cargo_position: Vector2 = first.position
	var actual_tow: bool = false
	for index: int in 3600:
		if first.delivered or _game.phase != OrbitSalvageGame.Phase.PLAYING:
			break
		_steer_toward(Vector2(-70.0, 0.0))
		await _frames(1)
		if first.position.distance_to(initial_cargo_position) > 70.0:
			actual_tow = true
		if index % 600 == 599:
			print(
				"Haul progress: tug=",
				_game.tug.position,
				" cargo=",
				first.position,
				" attached=",
				_game.tether.is_attached()
			)
	_game.tug.input_thrust = 0.0
	_game.tug.input_turn = 0.0
	_game.tug.input_brake = false
	_check(actual_tow, "the cable physically transports cargo through the sector")
	_check(
		first.delivered and _game.recovered == 1,
		"a complete piloted tow reaches the station and sells the cargo"
	)
	_check(
		_game.earned == first.credits, "the recovered cargo adds its actual value to the contract"
	)


func _steer_toward(destination: Vector2) -> void:
	var tug: SalvageTug = _game.tug
	var offset: Vector2 = destination - tug.position
	var desired_velocity: Vector2 = offset.normalized() * minf(88.0, offset.length() * 0.8)
	var acceleration: Vector2 = (desired_velocity - tug.linear_velocity) * 1.4
	var error: float = wrapf(acceleration.angle() - tug.rotation, -PI, PI)
	tug.input_turn = clampf(error * 2.1 - tug.angular_velocity * 0.9, -1.0, 1.0)
	tug.input_thrust = clampf(acceleration.length() / 86.0, 0.0, 0.8) if absf(error) < 0.6 else 0.0
	tug.input_brake = offset.length() < 22.0


func _place_body(body: RigidBody2D, point: Vector2, velocity: Vector2 = Vector2.ZERO) -> void:
	body.freeze = true
	body.position = point
	body.linear_velocity = velocity
	body.angular_velocity = 0.0
	await _frames(2)
	body.freeze = false
	PhysicsServer2D.body_set_state(
		body.get_rid(), PhysicsServer2D.BODY_STATE_LINEAR_VELOCITY, velocity
	)


func _test_delivery_rules() -> void:
	_game.start_run()
	await _frames(3)
	var cargo: SalvageCargo = _game.cargoes[1]
	_check(not _game.deliver_cargo(cargo), "distant cargo cannot be sold")
	await _place_body(cargo, Vector2(30, 0), Vector2(180, 0))
	_check(not _game.deliver_cargo(cargo), "cargo arriving above docking speed cannot be sold")
	await _place_body(cargo, Vector2(30, 0))
	await _frames(3)
	_check(
		cargo.delivered and _game.credits == cargo.credits,
		"slow cargo inside the dock sells automatically"
	)
	var balance: int = _game.credits
	_check(
		not _game.deliver_cargo(cargo) and _game.credits == balance,
		"delivering the same cargo twice cannot mint credits"
	)
	var stranger := SalvageCargo.new()
	stranger.setup(999, 9000, 2.0, "FOREIGN CARGO", Color.WHITE)
	_game.world.add_child(stranger)
	_check(not _game.deliver_cargo(stranger), "only cargo owned by the current sector can be sold")
	stranger.queue_free()


func _test_upgrades_and_completion() -> void:
	_check(not _game.buy_upgrade(), "upgrades cannot be purchased away from the station")
	await _place_body(_game.tug, Vector2(-50, 0))
	await _frames(3)
	_check(_game.docked, "a slow tug inside the station enters the dock")
	_check(not _game.buy_upgrade(), "the dock rejects an unaffordable upgrade")
	var cargo: SalvageCargo = _game.cargoes[0]
	await _place_body(cargo, Vector2(30, 30))
	await _frames(3)
	var earned_before: int = _game.earned
	var balance_before: int = _game.credits
	await _place_body(_game.tug, Vector2(450, 0))
	_game.docked = true
	_check(
		not _game.buy_upgrade(), "a stale dock flag cannot authorize an upgrade outside the station"
	)
	await _place_body(_game.tug, Vector2(-50, 0))
	await _frames(3)
	_check(_game.buy_upgrade(), "salvage earnings buy a thruster upgrade at the station")
	_check(
		_game.credits == balance_before - 300 and _game.tug.engine_power > 1.0,
		"upgrade debits credits and changes engine power"
	)
	_check(_game.earned == earned_before, "upgrade spending does not erase contract progress")
	for item: SalvageCargo in _game.cargoes:
		if item.delivered:
			continue
		await _place_body(item, Vector2(35, -35))
		await _frames(3)
		if _game.phase == OrbitSalvageGame.Phase.WON:
			break
	_check(
		_game.phase == OrbitSalvageGame.Phase.WON,
		"the actual station recovery loop completes the contract"
	)
	_check(paused and not _game.tug.controls_enabled, "completion safely freezes the flight")
	var record := SalvageProfile.new()
	record.path = _save_path
	_check(
		record.load_profile() == OK and record.best_haul >= OrbitSalvageGame.CONTRACT_GOAL,
		"completed contract persists a real haul record"
	)
	var old_record_count: int = record.completed_runs
	_game.finish_run(true)
	record.load_profile()
	_check(
		record.completed_runs == old_record_count,
		"a repeated completion does not record the run twice"
	)


func _test_loss_and_retry() -> void:
	_game.start_run()
	await _frames(3)
	_check(
		_game.credits == 0 and _game.recovered == 0 and not paused,
		"retry starts a clean playable contract"
	)
	_game.tug.take_damage(100.0)
	await process_frame
	_check(_game.phase == OrbitSalvageGame.Phase.LOST, "hull destruction reaches the loss screen")
	_game.start_run()
	await _frames(3)
	_check(
		_game.tug.hull == 100.0 and _game.phase == OrbitSalvageGame.Phase.PLAYING,
		"retry after destruction restores a working tug"
	)
