class_name RicochetGame
extends Node3D

enum Phase { TITLE, PLAYING, PAUSED, UPGRADING, OVER }

const MAX_ENEMIES: int = 48
const MAX_PROJECTILES: int = 220
const MAX_PICKUPS: int = 100
const ECHO_COOLDOWN: float = 6.0
const UPGRADE_DEFINITIONS: Array[Dictionary] = [
	{
		"id": &"ricochet",
		"title": "BANK SHOT",
		"description": "+1 wall bounce. Banked kills score double."
	},
	{
		"id": &"rapid",
		"title": "HOT BARREL",
		"description": "Fire 18% faster. Keep the combo alive."
	},
	{
		"id": &"spread",
		"title": "SPLIT SHOT",
		"description": "+1 projectile per shot. Cover more angles."
	},
	{
		"id": &"power",
		"title": "HEAVY HITTER",
		"description": "+1 damage per projectile. Punch through brutes."
	},
	{
		"id": &"health",
		"title": "SECOND WIND",
		"description": "+1 maximum health and repair 3 health."
	},
	{
		"id": &"speed",
		"title": "QUICKSTEP",
		"description": "+8% movement speed. Weave through the crowd."
	},
	{"id": &"magnet", "title": "VACUUM", "description": "Collect energy from 1.2 m farther away."},
]

var phase: Phase = Phase.TITLE
var score: int = 0
var best_score: int = 0
var kills: int = 0
var wave: int = 1
var elapsed: float = 0.0
var combo: int = 0
var combo_time: float = 0.0
var level: int = 1
var xp: int = 0
var xp_goal: int = 8
var muted: bool = false
var last_run_new_best: bool = false
var storage_notice: String = ""
var upgrade_choices: Array[Dictionary] = []
var player: RushPlayer
var enemies: Array[RushEnemy] = []
var pickups: Array[RushPickup] = []
var projectiles: Array[RushProjectile] = []
var echoes: Array[RushEcho] = []
var echoes_created: int = 0
var sync_kills: int = 0
var echo_charge: float:
	get:
		return clampf(1.0 - _echo_cooldown / ECHO_COOLDOWN, 0.0, 1.0)
var echo_history: float:
	get:
		return _echo_tape.duration
var echo_ready: bool:
	get:
		return (
			phase == Phase.PLAYING
			and _echo_cooldown <= 0.0
			and echo_history >= RushEchoTape.MIN_DURATION
		)
var active_echoes: int:
	get:
		return echoes.size()
var echo_remaining: float:
	get:
		var remaining: float = 0.0
		for echo: RushEcho in echoes:
			remaining = maxf(remaining, echo.duration - echo.elapsed)
		return remaining
var manual_input: bool = false
var fire_input: bool = false
var spawning_enabled: bool = true
var damage: int = 1
var bounces: int = 1
var pellets: int = 1
var shot_interval: float = 0.18
var magnet_radius: float = 3.4
var profile := RushProfile.new()
var hud: RushHUD
var camera: Camera3D
var world: Node3D
var feedback: RushFeedback
var sound: RushSoundscape

var _rng := RandomNumberGenerator.new()
var _shot_time: float = 0.0
var _spawn_time: float = 0.0
var _spawn_count: int = 0
var _pending_spawns: Array[Dictionary] = []
var _last_health: int = 5
var _reticle: MeshInstance3D
var _echo_tape := RushEchoTape.new()
var _echo_cooldown: float = 0.0
var _frame_shots: Array[Dictionary] = []


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_configure_inputs()
	_rng.randomize()
	var loaded: Error = profile.load_profile()
	if loaded != OK:
		storage_notice = "Saved record unavailable. You can still play."
	best_score = profile.best_score
	muted = profile.muted
	sound = RushSoundscape.new()
	add_child(sound)
	sound.set_muted(muted)
	add_child(RushArena.new())
	camera = Camera3D.new()
	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera.size = 22.0
	camera.position = Vector3(0.0, 24.0, 18.0)
	add_child(camera)
	camera.look_at(Vector3.ZERO)
	camera.current = true
	_build_world()
	player.active = false
	player.position = Vector3(3.0, 0.0, -1.0)
	for index: int in 4:
		var enemy: RushEnemy = _spawn_enemy(index, Vector3(5.5 + float(index) * 1.2, 0, 2.0))
		enemy.set_physics_process(false)
	var canvas := CanvasLayer.new()
	add_child(canvas)
	hud = RushHUD.new()
	hud.game = self
	canvas.add_child(hud)
	hud.start_requested.connect(start_run)
	hud.retry_requested.connect(start_run)
	hud.resume_requested.connect(toggle_pause)
	hud.upgrade_chosen.connect(choose_upgrade)
	hud.sound_requested.connect(toggle_sound)
	hud.set_phase(phase)


func _configure_inputs() -> void:
	_add_keys(&"rush_left", [KEY_A, KEY_LEFT])
	_add_keys(&"rush_right", [KEY_D, KEY_RIGHT])
	_add_keys(&"rush_up", [KEY_W, KEY_UP])
	_add_keys(&"rush_down", [KEY_S, KEY_DOWN])
	_add_keys(&"rush_dash", [KEY_SPACE])
	_add_keys(&"rush_echo", [KEY_E])
	var echo_click := InputEventMouseButton.new()
	echo_click.button_index = MOUSE_BUTTON_RIGHT
	if not InputMap.action_has_event(&"rush_echo", echo_click):
		InputMap.action_add_event(&"rush_echo", echo_click)
	_add_keys(&"rush_pause", [KEY_ESCAPE])
	_add_keys(&"rush_mute", [KEY_M])
	_add_keys(&"rush_restart", [KEY_R])
	for index: int in 3:
		_add_keys(StringName("rush_choice_%d" % index), [KEY_1 + index])
	if not InputMap.has_action(&"rush_fire"):
		InputMap.add_action(&"rush_fire")
		var click := InputEventMouseButton.new()
		click.button_index = MOUSE_BUTTON_LEFT
		InputMap.action_add_event(&"rush_fire", click)


func _add_keys(action: StringName, keys: Array) -> void:
	if InputMap.has_action(action):
		return
	InputMap.add_action(action, 0.15)
	for key: int in keys:
		var event := InputEventKey.new()
		event.physical_keycode = key as Key
		InputMap.action_add_event(action, event)


func _build_world() -> void:
	if is_instance_valid(world):
		remove_child(world)
		world.queue_free()
	enemies.clear()
	pickups.clear()
	projectiles.clear()
	echoes.clear()
	_echo_tape.clear()
	_frame_shots.clear()
	_pending_spawns.clear()
	world = Node3D.new()
	world.name = "Run"
	world.process_mode = Node.PROCESS_MODE_PAUSABLE
	add_child(world)
	feedback = RushFeedback.new()
	world.add_child(feedback)
	player = RushPlayer.new()
	world.add_child(player)
	player.health_changed.connect(_on_health_changed)
	player.died.connect(_end_run)
	player.dashed.connect(_on_dash)
	feedback.bind_player(player)
	_reticle = MeshInstance3D.new()
	var ring := TorusMesh.new()
	ring.inner_radius = 0.19
	ring.outer_radius = 0.24
	ring.rings = 20
	ring.ring_segments = 8
	_reticle.mesh = ring
	_reticle.scale.y = 0.2
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.albedo_color = Color("d8dbd5")
	_reticle.material_override = material
	_reticle.visible = false
	world.add_child(_reticle)


func start_run() -> void:
	get_tree().paused = false
	_build_world()
	score = 0
	kills = 0
	echoes_created = 0
	sync_kills = 0
	_echo_cooldown = 0.0
	wave = 1
	elapsed = 0.0
	combo = 0
	combo_time = 0.0
	level = 1
	xp = 0
	xp_goal = 8
	damage = 1
	bounces = 1
	pellets = 1
	shot_interval = 0.18
	magnet_radius = 3.4
	_shot_time = 0.0
	_spawn_time = 0.15
	_spawn_count = 0
	_last_health = player.health
	fire_input = false
	last_run_new_best = false
	upgrade_choices.clear()
	_set_phase(Phase.PLAYING)
	sound.play_cue(&"click")


func _set_phase(value: Phase) -> void:
	phase = value
	get_tree().paused = value == Phase.PAUSED or value == Phase.UPGRADING or value == Phase.OVER
	_reticle.visible = value == Phase.PLAYING
	if is_instance_valid(hud):
		hud.set_phase(value)


func toggle_pause() -> void:
	if phase == Phase.PLAYING:
		_set_phase(Phase.PAUSED)
	elif phase == Phase.PAUSED:
		_set_phase(Phase.PLAYING)


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT and phase == Phase.PLAYING and not manual_input:
		toggle_pause()


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed(&"rush_mute"):
		toggle_sound()
	elif event.is_action_pressed(&"rush_pause"):
		toggle_pause()
	elif phase == Phase.PLAYING and event.is_action_pressed(&"rush_dash"):
		player.try_dash()
	elif phase == Phase.PLAYING and event.is_action_pressed(&"rush_echo"):
		try_echo()
	elif phase == Phase.OVER and event.is_action_pressed(&"rush_restart"):
		start_run()
	elif phase == Phase.UPGRADING:
		for index: int in upgrade_choices.size():
			if event.is_action_pressed(StringName("rush_choice_%d" % index)):
				choose_upgrade(upgrade_choices[index]["id"])
				break


func _process(delta: float) -> void:
	if phase == Phase.PLAYING and not manual_input:
		_update_aim()
	if is_instance_valid(hud):
		hud.refresh(delta)
	sound.intensity = clampf(float(wave) * 0.12, 0.0, 1.0) if phase == Phase.PLAYING else 0.0


func _update_aim() -> void:
	var mouse: Vector2 = get_viewport().get_mouse_position()
	var point: Variant = Plane(Vector3.UP, 0.65).intersects_ray(
		camera.project_ray_origin(mouse), camera.project_ray_normal(mouse)
	)
	if not point is Vector3:
		return
	var destination: Vector3 = point
	destination.x = clampf(destination.x, -11.9, 11.9)
	destination.z = clampf(destination.z, -7.9, 7.9)
	_reticle.position = Vector3(destination.x, 0.04, destination.z)
	var direction: Vector3 = destination - player.position
	direction.y = 0.0
	if direction.length_squared() > 0.01:
		player.aim_direction = direction.normalized()


func _physics_process(delta: float) -> void:
	if phase != Phase.PLAYING:
		return
	_frame_shots.clear()
	_echo_cooldown = maxf(_echo_cooldown - delta, 0.0)
	if not manual_input:
		player.move_input = Input.get_vector(&"rush_left", &"rush_right", &"rush_up", &"rush_down")
		fire_input = Input.is_action_pressed(&"rush_fire")
	elapsed += delta
	wave = 1 + int(elapsed / 20.0)
	combo_time = maxf(combo_time - delta, 0.0)
	if combo_time <= 0.0:
		combo = 0
	_shot_time -= delta
	if fire_input and _shot_time <= 0.0:
		_fire_weapon()
		_shot_time = shot_interval
	if spawning_enabled:
		_tick_spawns(delta)
	_echo_tape.record(delta, player.position, player.aim_direction, _frame_shots)


func _fire_weapon() -> void:
	var aim: Vector3 = player.aim_direction.normalized()
	for index: int in pellets:
		var angle: float = (float(index) - float(pellets - 1) * 0.5) * 0.16
		var direction: Vector3 = aim.rotated(Vector3.UP, angle)
		var origin: Vector3 = player.position + direction * 0.35 + Vector3.UP * 0.65
		var projectile: RushProjectile = _spawn_projectile(
			origin, direction, false, damage, bounces
		)
		if projectile != null:
			(
				_frame_shots
				. append(
					{
						"origin": origin,
						"direction": direction,
						"damage": damage,
						"bounces": bounces,
						"speed": 24.0,
					}
				)
			)
	feedback.play_event(&"shot", player.position + aim * 0.7 + Vector3.UP * 0.65)
	sound.play_cue(&"shot")


func _spawn_projectile(
	at: Vector3,
	direction: Vector3,
	hostile: bool,
	shot_damage: int,
	shot_bounces: int,
	shot_speed: float = 24.0,
	from_echo: bool = false
) -> RushProjectile:
	if projectiles.size() >= MAX_PROJECTILES:
		return null
	var projectile := RushProjectile.new()
	projectile.from_echo = from_echo
	var excluded: Array[RID] = []
	if not hostile:
		excluded.append(player.get_rid())
	projectile.setup(direction, shot_damage, shot_bounces, hostile, shot_speed, excluded)
	projectile.position = at
	world.add_child(projectile)
	projectiles.append(projectile)
	projectile.tree_exiting.connect(func() -> void: projectiles.erase(projectile))
	projectile.bounced.connect(_on_bounce)
	projectile.struck.connect(func(point: Vector3) -> void: feedback.play_event(&"hit", point))
	return projectile


func try_echo() -> bool:
	if not echo_ready:
		return false
	var echo := RushEcho.new()
	if not echo.setup(_echo_tape.snapshot()):
		echo.free()
		return false
	echo.fired.connect(_on_echo_fired)
	world.add_child(echo)
	echoes.append(echo)
	echo.tree_exiting.connect(func() -> void: echoes.erase(echo))
	_echo_cooldown = ECHO_COOLDOWN
	echoes_created += 1
	feedback.play_event(&"echo", echo.position + Vector3.UP * 0.5)
	sound.play_cue(&"echo")
	return true


func _on_echo_fired(
	origin: Vector3, direction: Vector3, shot_damage: int, shot_bounces: int, shot_speed: float
) -> void:
	if phase == Phase.PLAYING:
		_spawn_projectile(origin, direction, false, shot_damage, shot_bounces, shot_speed, true)


func _tick_spawns(delta: float) -> void:
	for index: int in range(_pending_spawns.size() - 1, -1, -1):
		var entry: Dictionary = _pending_spawns[index]
		entry["time"] = float(entry["time"]) - delta
		if float(entry["time"]) <= 0.0:
			_spawn_enemy(int(entry["kind"]), entry["point"])
			_pending_spawns.remove_at(index)
	_spawn_time -= delta
	if _spawn_time > 0.0 or enemies.size() + _pending_spawns.size() >= MAX_ENEMIES:
		return
	_spawn_time = maxf(0.24, 1.05 - float(wave) * 0.08)
	var kind: int = _next_enemy_kind()
	var point: Vector3 = _spawn_position()
	_pending_spawns.append({"kind": kind, "point": point, "time": 0.8})
	feedback.play_event(&"spawn", point)


func _next_enemy_kind() -> int:
	_spawn_count += 1
	if wave == 1:
		return RushEnemy.Kind.TURRET if _spawn_count % 3 == 2 else RushEnemy.Kind.CHASER
	var roster: Array[int] = [
		RushEnemy.Kind.CHASER, RushEnemy.Kind.CHASER, RushEnemy.Kind.RUNNER, RushEnemy.Kind.TURRET
	]
	if wave >= 3:
		roster.append(RushEnemy.Kind.BRUTE)
	return roster[_rng.randi_range(0, roster.size() - 1)]


func _spawn_position() -> Vector3:
	var point := Vector3.ZERO
	for _attempt: int in 8:
		var edge: int = _rng.randi_range(0, 3)
		point = Vector3(_rng.randf_range(-10.5, 10.5), 0.0, _rng.randf_range(-6.5, 6.5))
		if edge < 2:
			point.x = -10.7 if edge == 0 else 10.7
		else:
			point.z = -6.7 if edge == 2 else 6.7
		if point.distance_to(player.position) >= 5.0:
			return point
	var farthest: float = 0.0
	for corner: Vector3 in [
		Vector3(-10, 0, -6), Vector3(10, 0, -6), Vector3(-10, 0, 6), Vector3(10, 0, 6)
	]:
		var distance: float = corner.distance_to(player.position)
		if distance > farthest:
			farthest = distance
			point = corner
	return point


func _spawn_enemy(kind: int, at: Vector3) -> RushEnemy:
	var enemy := RushEnemy.new()
	enemy.setup(kind, wave)
	enemy.position = at
	enemy.target = player
	world.add_child(enemy)
	enemies.append(enemy)
	enemy.killed.connect(_on_enemy_killed)
	enemy.damaged.connect(
		func(point: Vector3, _amount: int) -> void: feedback.play_event(&"hit", point)
	)
	enemy.fired.connect(_on_enemy_fired)
	return enemy


func _on_enemy_fired(at: Vector3, direction: Vector3) -> void:
	if phase == Phase.PLAYING:
		_spawn_projectile(at, direction, true, 1, 0, 9.0)


func _on_enemy_killed(enemy: RushEnemy, banked: bool) -> void:
	if phase != Phase.PLAYING or not enemies.has(enemy):
		return
	enemies.erase(enemy)
	kills += 1
	combo += 1
	combo_time = 3.0
	var multiplier: int = 1 + mini((combo - 1) / 5, 4)
	var awarded: int = enemy.score_value * multiplier * (2 if banked else 1)
	if enemy.sync_kill:
		awarded *= 2
		sync_kills += 1
		feedback.play_event(&"sync", enemy.position + Vector3.UP * 0.5)
		sound.play_cue(&"sync")
	score += awarded
	feedback.play_event(&"kill", enemy.position + Vector3.UP * 0.5, awarded)
	sound.play_cue(&"kill")
	_spawn_pickup(enemy.position + Vector3.UP * 0.4, enemy.xp_value + (1 if banked else 0))


func _spawn_pickup(at: Vector3, value: int) -> RushPickup:
	if pickups.size() >= MAX_PICKUPS:
		pickups[0].value += value
		return pickups[0]
	var pickup := RushPickup.new()
	pickup.position = at
	pickup.value = value
	pickup.target = player
	pickup.magnet_radius = magnet_radius
	world.add_child(pickup)
	pickups.append(pickup)
	pickup.collected.connect(_on_pickup_collected)
	return pickup


func _on_pickup_collected(pickup: RushPickup) -> void:
	if not pickups.has(pickup):
		return
	pickups.erase(pickup)
	xp += pickup.value
	feedback.play_event(&"pickup", player.position + Vector3.UP * 0.4)
	sound.play_cue(&"pickup")
	if phase == Phase.PLAYING and xp >= xp_goal:
		_offer_upgrades()


func _offer_upgrades() -> void:
	var available: Array[Dictionary] = []
	for entry: Dictionary in UPGRADE_DEFINITIONS:
		var id: StringName = entry["id"]
		if id == &"ricochet" and bounces >= 5:
			continue
		if id == &"spread" and pellets >= 5:
			continue
		if id == &"rapid" and shot_interval <= 0.075:
			continue
		if id == &"health" and player.max_health >= 9 and player.health == player.max_health:
			continue
		if id == &"speed" and player.speed >= 13.0:
			continue
		if id == &"magnet" and magnet_radius >= 9.0:
			continue
		var choice: Dictionary = entry.duplicate()
		if id == &"health" and player.max_health >= 9:
			choice["description"] = "Repair 3 health."
		available.append(choice)
	upgrade_choices.clear()
	while not available.is_empty() and upgrade_choices.size() < 3:
		var index: int = _rng.randi_range(0, available.size() - 1)
		upgrade_choices.append(available[index])
		available.remove_at(index)
	_set_phase(Phase.UPGRADING)
	sound.play_cue(&"upgrade")


func choose_upgrade(id: StringName) -> bool:
	if phase != Phase.UPGRADING:
		return false
	var offered: bool = false
	for entry: Dictionary in upgrade_choices:
		if entry["id"] == id:
			offered = true
	if not offered:
		return false
	match id:
		&"ricochet":
			bounces += 1
		&"rapid":
			shot_interval = maxf(0.07, shot_interval / 1.18)
		&"spread":
			pellets += 1
		&"power":
			damage += 1
		&"health":
			player.max_health = mini(player.max_health + 1, 9)
			player.health = mini(player.health + 3, player.max_health)
			player.health_changed.emit(player.health)
		&"speed":
			player.speed *= 1.08
		&"magnet":
			magnet_radius += 1.2
			for pickup: RushPickup in pickups:
				pickup.magnet_radius = magnet_radius
	xp -= xp_goal
	level += 1
	xp_goal = 8 + (level - 1) * 5
	upgrade_choices.clear()
	_set_phase(Phase.PLAYING)
	sound.play_cue(&"click")
	if xp >= xp_goal:
		_offer_upgrades()
	return true


func _on_bounce(at: Vector3) -> void:
	feedback.play_event(&"bounce", at)
	sound.play_cue(&"bounce")


func _on_dash() -> void:
	feedback.play_event(&"dash", player.position + Vector3.UP * 0.4)
	sound.play_cue(&"dash")


func _on_health_changed(value: int) -> void:
	if value < _last_health:
		feedback.play_event(&"hit", player.position + Vector3.UP * 0.6)
		sound.play_cue(&"hit")
	_last_health = value


func _end_run() -> void:
	if phase != Phase.PLAYING:
		return
	last_run_new_best = score > best_score
	best_score = maxi(score, best_score)
	profile.best_score = best_score
	profile.best_kills = maxi(kills, profile.best_kills)
	_save_profile()
	_set_phase(Phase.OVER)
	sound.play_cue(&"game_over")


func toggle_sound() -> void:
	muted = not muted
	profile.muted = muted
	sound.set_muted(muted)
	_save_profile()


func _save_profile() -> void:
	var result: Error = profile.save_profile()
	storage_notice = "" if result == OK else "Record could not be saved. This session still works."
