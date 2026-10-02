class_name OrbitSalvageGame
extends Node2D

enum Phase { TITLE, PLAYING, PAUSED, WON, LOST }

const CONTRACT_GOAL: int = 1200
const SECTOR_RADIUS: float = 2400.0
const DOCK_SPEED: float = 80.0
const START_POSITION := Vector2(205.0, 65.0)
const TEAL := Color("7bdfcd")
const AMBER := Color("edb879")

var phase: Phase = Phase.TITLE
var credits: int = 0
var earned: int = 0
var recovered: int = 0
var elapsed: float = 0.0
var upgrade_level: int = 0
var docked: bool = false
var profile := SalvageProfile.new()
var world: Node2D
var tug: SalvageTug
var tether: SalvageTether
var station: SalvageStation
var starfield: SalvageStarfield
var sound: SalvageSoundscape
var camera: Camera2D
var hud: SalvageHUD
var cargoes: Array[SalvageCargo] = []
var target: SalvageCargo
var message: String = ""
var message_time: float = 0.0
var manual_input: bool = false
var storage_notice: String = ""
var _last_hull: float = 100.0
var _boundary_damage_time: float = 0.0
var _profile_error: Error = OK


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_configure_inputs()
	_profile_error = profile.load_profile()
	sound = SalvageSoundscape.new()
	add_child(sound)
	sound.set_muted(profile.muted)
	starfield = SalvageStarfield.new()
	starfield.z_index = -100
	add_child(starfield)
	station = SalvageStation.new()
	station.z_index = -5
	add_child(station)
	camera = Camera2D.new()
	camera.position = Vector2(-210.0, -70.0)
	camera.zoom = Vector2.ONE * 0.95
	add_child(camera)
	_build_world()
	_stage_title()
	var canvas := CanvasLayer.new()
	add_child(canvas)
	hud = SalvageHUD.new()
	hud.game = self
	canvas.add_child(hud)
	hud.start_requested.connect(start_run)
	hud.resume_requested.connect(toggle_pause)
	hud.home_requested.connect(return_to_title)
	hud.sound_requested.connect(toggle_sound)
	hud.upgrade_requested.connect(buy_upgrade)
	if _profile_error != OK:
		storage_notice = "Pilot record unavailable. This flight is still available."


func _configure_inputs() -> void:
	_add_keys("thrust", [KEY_W, KEY_UP])
	_add_keys("reverse", [KEY_S, KEY_DOWN])
	_add_keys("turn_left", [KEY_A, KEY_LEFT])
	_add_keys("turn_right", [KEY_D, KEY_RIGHT])
	_add_keys("brake", [KEY_SPACE])
	_add_keys("boost", [KEY_SHIFT])
	_add_keys("tether", [KEY_E])
	_add_keys("pause_flight", [KEY_ESCAPE])
	_add_keys("toggle_sound", [KEY_M])
	_add_keys("upgrade", [KEY_U])
	_add_axis("thrust", JOY_AXIS_LEFT_Y, -1.0)
	_add_axis("reverse", JOY_AXIS_LEFT_Y, 1.0)
	_add_axis("turn_left", JOY_AXIS_LEFT_X, -1.0)
	_add_axis("turn_right", JOY_AXIS_LEFT_X, 1.0)
	_add_button("brake", JOY_BUTTON_A)
	_add_button("tether", JOY_BUTTON_X)
	_add_button("boost", JOY_BUTTON_RIGHT_SHOULDER)
	_add_button("pause_flight", JOY_BUTTON_START)


func _add_keys(action: StringName, keys: Array) -> void:
	if InputMap.has_action(action):
		return
	InputMap.add_action(action, 0.18)
	for key: int in keys:
		var event := InputEventKey.new()
		event.physical_keycode = key as Key
		InputMap.action_add_event(action, event)


func _add_axis(action: StringName, axis: JoyAxis, value: float) -> void:
	var event := InputEventJoypadMotion.new()
	event.axis = axis
	event.axis_value = value
	if not InputMap.action_has_event(action, event):
		InputMap.action_add_event(action, event)


func _add_button(action: StringName, button: JoyButton) -> void:
	var event := InputEventJoypadButton.new()
	event.button_index = button
	if not InputMap.action_has_event(action, event):
		InputMap.action_add_event(action, event)


func _build_world() -> void:
	if is_instance_valid(world):
		remove_child(world)
		world.queue_free()
	cargoes.clear()
	target = null
	world = Node2D.new()
	world.name = "SalvageSector"
	world.process_mode = Node.PROCESS_MODE_PAUSABLE
	add_child(world)
	tug = SalvageTug.new()
	tug.position = START_POSITION
	world.add_child(tug)
	tug.destroyed.connect(_on_destroyed)
	tug.hull_changed.connect(_on_hull_changed)
	tug.freeze = true
	tether = SalvageTether.new()
	tether.z_index = -1
	world.add_child(tether)
	tether.snapped.connect(_on_tether_snapped)
	var positions: Array[Vector2] = [
		Vector2(420, 65),
		Vector2(700, -270),
		Vector2(960, 210),
		Vector2(880, 720),
		Vector2(220, 950),
		Vector2(-400, 600),
		Vector2(-690, -150),
		Vector2(-1100, -680),
		Vector2(470, -1160),
		Vector2(1530, -780),
		Vector2(-1430, 510),
		Vector2(1460, 1050),
	]
	var values: Array[int] = [140, 240, 160, 360, 180, 300, 200, 420, 240, 520, 320, 450]
	var titles: Array[String] = ["ALLOY CRATE", "ION BATTERY", "SCRAP MODULE", "DRIVE CORE"]
	for index: int in positions.size():
		var cargo := SalvageCargo.new()
		var cargo_mass: float = 1.5 + float(values[index]) / 95.0
		cargo.setup(index, values[index], cargo_mass, titles[index % titles.size()], AMBER)
		cargo.position = positions[index]
		cargo.rotation = float(index) * 0.81
		world.add_child(cargo)
		cargo.freeze = true
		cargoes.append(cargo)
	_spawn_asteroids(positions)


func _spawn_asteroids(salvage_positions: Array[Vector2]) -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 728194
	for index: int in 44:
		var candidate := Vector2.ZERO
		var radius: float = rng.randf_range(24.0, 73.0)
		var clear: bool = false
		for _attempt: int in 40:
			candidate = Vector2.from_angle(rng.randf() * TAU) * rng.randf_range(500.0, 2060.0)
			clear = true
			for salvage_position: Vector2 in salvage_positions:
				if candidate.distance_to(salvage_position) < radius + 115.0:
					clear = false
					break
			if clear:
				break
		if not clear:
			continue
		var asteroid := SalvageAsteroid.new()
		asteroid.setup(radius, index * 71 + 19)
		asteroid.position = candidate
		asteroid.rotation = rng.randf() * TAU
		world.add_child(asteroid)


func _stage_title() -> void:
	for item: Node in world.get_children():
		if item is SalvageAsteroid:
			(item as SalvageAsteroid).hide()
	for cargo: SalvageCargo in cargoes:
		cargo.hide()
	tug.position = Vector2(145.0, 80.0)
	tug.rotation = PI
	cargoes[0].position = Vector2(300.0, 80.0)
	cargoes[0].show()
	tether.attach(tug, cargoes[0])


func start_run() -> void:
	get_tree().paused = false
	_build_world()
	credits = 0
	earned = 0
	recovered = 0
	elapsed = 0.0
	upgrade_level = 0
	docked = false
	_last_hull = 100.0
	_boundary_damage_time = 0.0
	phase = Phase.PLAYING
	tug.freeze = false
	tug.controls_enabled = true
	for cargo: SalvageCargo in cargoes:
		cargo.freeze = false
	camera.position = tug.position
	_notify_phase()
	notify_pilot("KESTREL: Your first crate is just east of the dock. Bring it home, pilot.", 8.0)
	sound.play_cue("click")


func return_to_title() -> void:
	get_tree().paused = false
	phase = Phase.TITLE
	_build_world()
	_stage_title()
	camera.position = Vector2(-210.0, -70.0)
	message_time = 0.0
	_notify_phase()


func toggle_pause() -> void:
	if phase == Phase.PLAYING:
		phase = Phase.PAUSED
		get_tree().paused = true
	elif phase == Phase.PAUSED:
		phase = Phase.PLAYING
		get_tree().paused = false
	else:
		return
	_notify_phase()


func _notify_phase() -> void:
	if is_instance_valid(hud):
		hud.set_phase(phase)


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("toggle_sound"):
		toggle_sound()
	elif event.is_action_pressed("pause_flight"):
		toggle_pause()
	elif phase == Phase.PLAYING:
		if event.is_action_pressed("tether"):
			interact_tether()
		elif event.is_action_pressed("upgrade"):
			buy_upgrade()


func _process(delta: float) -> void:
	if not is_instance_valid(tug):
		return
	if phase == Phase.PLAYING:
		if not manual_input:
			tug.input_thrust = Input.get_axis("reverse", "thrust")
			tug.input_turn = Input.get_axis("turn_left", "turn_right")
			tug.input_brake = Input.is_action_pressed("brake")
			tug.input_boost = Input.is_action_pressed("boost")
		var look_ahead: Vector2 = tug.linear_velocity.limit_length(150.0) * 0.28
		camera.position = camera.position.lerp(tug.position + look_ahead, 1.0 - exp(-delta * 4.0))
		message_time = maxf(message_time - delta, 0.0)
	starfield.focus = camera.position
	sound.engine_level = absf(tug.input_thrust) if phase == Phase.PLAYING else 0.0
	sound.strain_level = tether.tension if phase == Phase.PLAYING else 0.0
	station.highlighted = phase == Phase.PLAYING and tether.is_attached()
	if is_instance_valid(hud):
		hud.refresh()
	queue_redraw()


func _physics_process(delta: float) -> void:
	if phase != Phase.PLAYING:
		return
	elapsed += delta
	target = nearest_cargo()
	docked = is_docked()
	if docked:
		tug.repair_and_refuel()
	for cargo: SalvageCargo in cargoes:
		if not is_instance_valid(cargo) or cargo.delivered:
			continue
		if (
			cargo.position.length() < SalvageStation.DOCK_RADIUS
			and cargo.linear_velocity.length() < DOCK_SPEED
		):
			deliver_cargo(cargo)
			if phase != Phase.PLAYING:
				return
	_boundary_damage_time = maxf(0.0, _boundary_damage_time - delta)
	if tug.position.length() > SECTOR_RADIUS:
		notify_pilot("SIGNAL LOST: Turn toward Kestrel. Radiation is damaging your hull.", 1.2)
		if _boundary_damage_time <= 0.0:
			tug.take_damage(8.0)
			_boundary_damage_time = 1.0


func nearest_cargo() -> SalvageCargo:
	var closest: SalvageCargo = null
	var distance: float = INF
	for cargo: SalvageCargo in cargoes:
		if not is_instance_valid(cargo) or cargo.delivered:
			continue
		var candidate: float = tug.position.distance_squared_to(cargo.position)
		if candidate < distance:
			distance = candidate
			closest = cargo
	return closest


func interact_tether() -> void:
	if phase != Phase.PLAYING:
		return
	if tether.is_attached():
		tether.release()
		sound.play_cue("release")
		notify_pilot("Cable released. Cargo keeps its momentum.")
		return
	var candidate: SalvageCargo = nearest_cargo()
	if is_instance_valid(candidate) and tether.attach(tug, candidate):
		sound.play_cue("attach")
		notify_pilot(
			"%s secured. Ease into the throttle; bring it to the teal dock." % candidate.label, 5.0
		)
	else:
		notify_pilot("No salvage in cable range. Fly within 190 m of a marked crate.")


func deliver_cargo(cargo: SalvageCargo) -> bool:
	if phase != Phase.PLAYING or not is_instance_valid(cargo) or cargo.delivered:
		return false
	if not cargoes.has(cargo):
		return false
	if (
		cargo.position.length() >= SalvageStation.DOCK_RADIUS
		or cargo.linear_velocity.length() >= DOCK_SPEED
	):
		return false
	cargo.delivered = true
	if tether.cargo == cargo:
		tether.release()
	cargo.hide()
	cargo.set_deferred("freeze", true)
	cargo.set_deferred("collision_layer", 0)
	cargo.set_deferred("collision_mask", 0)
	credits += cargo.credits
	earned += cargo.credits
	recovered += 1
	sound.play_cue("deliver")
	notify_pilot(
		"KESTREL: %s received. +%d credits. Nice flying." % [cargo.label, cargo.credits], 5.0
	)
	if earned >= CONTRACT_GOAL:
		finish_run(true)
	return true


func upgrade_cost() -> int:
	return 300 + upgrade_level * 200


func is_docked() -> bool:
	return (
		is_instance_valid(tug)
		and tug.position.length() < SalvageStation.DOCK_RADIUS
		and tug.linear_velocity.length() < DOCK_SPEED
	)


func buy_upgrade() -> bool:
	if phase != Phase.PLAYING or not is_docked() or upgrade_level >= 3:
		return false
	var cost: int = upgrade_cost()
	if credits < cost:
		notify_pilot("Kestrel can fit stronger thrusters for %d credits." % cost)
		return false
	credits -= cost
	upgrade_level += 1
	tug.engine_power = 1.0 + float(upgrade_level) * 0.25
	sound.play_cue("deliver")
	notify_pilot(
		"Thrusters upgraded to MK %d. Your next heavy haul just got easier." % (upgrade_level + 1)
	)
	return true


func finish_run(success: bool) -> void:
	if phase != Phase.PLAYING:
		return
	phase = Phase.WON if success else Phase.LOST
	tug.controls_enabled = false
	tug.input_thrust = 0.0
	tug.input_turn = 0.0
	tug.input_boost = false
	tug.input_brake = false
	tether.release()
	get_tree().paused = true
	var result: Error = profile.finish_run(earned)
	storage_notice = ""
	if result != OK:
		storage_notice = "Pilot record could not be saved: %s." % error_string(result)
		notify_pilot(
			"Flight complete. Pilot record could not be saved: %s." % error_string(result), 30.0
		)
	sound.play_cue("win" if success else "damage")
	_notify_phase()


func toggle_sound() -> void:
	profile.muted = not profile.muted
	sound.set_muted(profile.muted)
	var result: Error = profile.save_profile()
	storage_notice = ""
	if result != OK:
		storage_notice = "Audio preference could not be saved."
		notify_pilot("Audio changed for this session; preference could not be saved.", 6.0)


func notify_pilot(text: String, duration: float = 3.5) -> void:
	message = text
	message_time = duration


func _on_destroyed() -> void:
	finish_run(false)


func _on_hull_changed(value: float) -> void:
	if value < _last_hull and phase == Phase.PLAYING:
		sound.play_cue("damage")
	_last_hull = value


func _on_tether_snapped() -> void:
	sound.play_cue("release")
	notify_pilot("Cable snapped under strain. Slow down and reconnect.", 5.0)


func _draw() -> void:
	if phase != Phase.PLAYING or not is_instance_valid(target):
		return
	if not tether.is_attached():
		var point: Vector2 = target.position
		var radius: float = target.radius + 12.0
		var tint := Color(AMBER, 0.62)
		for index: int in 4:
			var angle: float = PI * 0.25 + float(index) * PI * 0.5
			draw_arc(point, radius, angle, angle + 0.55, 8, tint, 1.4, true)
