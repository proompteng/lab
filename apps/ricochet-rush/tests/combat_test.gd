extends SceneTree

var _checks: int = 0
var _failures: int = 0
var _killed_count: int = 0
var _last_kill_sync: bool = false
var _bounce_count: int = 0
var _turret_fire_count: int = 0
var _last_fire_direction: Vector3 = Vector3.ZERO


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	await _test_player_motion()
	await _test_dash_wall_stop_and_invulnerability()
	await _test_enemy_setup_and_kill_contract()
	await _test_runner_orbit_stability()
	await _test_turret_fire_telegraph()
	await _test_projectile_reflection()
	await _test_hostile_projectile_filter()
	await _test_sync_window_and_pause_clock()
	paused = false
	print("Combat tests: %d/%d checks passed" % [_checks - _failures, _checks])
	quit(1 if _failures > 0 else 0)


func _test_player_motion() -> void:
	var world := _new_world()
	var player := _add_player(world, Vector3.ZERO)
	await _frames(2)
	player.move_input = Vector2(0.5, 0.0)
	await _frames(20)
	_check(
		absf(player.velocity.x - player.speed * 0.5) < 0.2,
		"analog movement preserves half-strength input",
	)
	_check(absf(player.velocity.z) < 0.1, "analog movement does not add a perpendicular component")

	player.move_input = Vector2.ONE
	await _frames(20)
	_check(
		absf(player.velocity.length() - player.speed) < 0.2, "diagonal movement stays normalized"
	)
	_check(player.velocity.x > 0.0 and player.velocity.z > 0.0, "diagonal input moves on both axes")

	player.move_input = Vector2.ZERO
	await _frames(10)
	_check(player.velocity.length() < 0.2, "released movement settles to a stop")
	await _destroy_world(world)


func _test_dash_wall_stop_and_invulnerability() -> void:
	var world := _new_world(true)
	var player := _add_player(world, Vector3(10.5, 0.0, 0.0))
	await _frames(3)
	player.move_input = Vector2.RIGHT
	player.aim_direction = Vector3.RIGHT
	_check(player.try_dash(), "dash starts from a valid movement direction")
	player.move_input = Vector2.ZERO
	await _frames(18)
	_check(player.position.x > 10.5, "dash advances before reaching the boundary")
	_check(player.position.x < 11.75, "dash stops at the arena wall")
	_check(player.velocity.length() < 0.2, "dash releases its velocity after wall contact")

	player.reset_at(Vector3.ZERO)
	_check(player.take_damage(), "first damage applies")
	var health_after_hit: int = player.health
	_check(not player.take_damage(), "hit invulnerability blocks an immediate second hit")
	_check(player.health == health_after_hit, "blocked damage does not reduce health")
	await _frames(40)
	_check(player.take_damage(), "damage applies after invulnerability expires")
	await _destroy_world(world)


func _test_enemy_setup_and_kill_contract() -> void:
	var world := _new_world()
	var expected_xp: Array[int] = [1, 2, 4, 3]
	for kind: int in range(RushEnemy.Kind.TURRET + 1):
		var enemy := RushEnemy.new()
		world.add_child(enemy)
		enemy.setup(kind, 1)
		enemy.set_physics_process(false)
		_check(
			enemy.xp_value == expected_xp[kind], "enemy kind %d has the intended XP value" % kind
		)
		_check(enemy.health > 0, "enemy kind %d starts with health" % kind)

	_killed_count = 0
	_last_kill_sync = false
	var killer := RushEnemy.new()
	killer.setup(RushEnemy.Kind.CHASER, 1)
	world.add_child(killer)
	killer.set_physics_process(false)
	killer.killed.connect(_on_enemy_killed)
	var initial_health: int = killer.health
	_check(killer.take_hit(initial_health, Vector3.RIGHT, false), "lethal enemy damage is accepted")
	_check(not killer.sync_kill, "a single real source is not a sync kill")
	_check(not killer.take_hit(1, Vector3.RIGHT, true), "a dead enemy rejects later damage")
	_check(_killed_count == 1, "enemy death emits exactly one killed signal")
	_check(not _last_kill_sync, "the killed callback observes a non-sync kill")
	await _destroy_world(world)


func _test_runner_orbit_stability() -> void:
	var world := _new_world()
	var player := _add_player(world, Vector3.ZERO)
	var runner := RushEnemy.new()
	runner.position = Vector3(5.0, 0.0, 0.0)
	runner.setup(RushEnemy.Kind.RUNNER, 1)
	runner.target = player
	world.add_child(runner)
	await _frames(3)
	var orbit_sign: int = 0
	var stable: bool = true
	for _index: int in 8:
		await physics_frame
		await process_frame
		if absf(runner.velocity.z) < 0.1:
			continue
		var current_sign: int = 1 if runner.velocity.z > 0.0 else -1
		if orbit_sign == 0:
			orbit_sign = current_sign
		else:
			stable = stable and current_sign == orbit_sign
	_check(orbit_sign != 0, "runner establishes a tangential orbit velocity")
	_check(stable, "runner keeps one orbit direction across physics frames")
	await _destroy_world(world)


func _test_turret_fire_telegraph() -> void:
	var world := _new_world()
	var player := _add_player(world, Vector3.ZERO)
	var turret := RushEnemy.new()
	turret.position = Vector3(0.0, 0.0, -5.0)
	turret.setup(RushEnemy.Kind.TURRET, 1)
	turret.target = player
	turret.fired.connect(_on_turret_fired)
	_turret_fire_count = 0
	_last_fire_direction = Vector3.ZERO
	world.add_child(turret)
	await _frames(90)
	_check(_turret_fire_count >= 1, "turret completes its visible warning and fires")
	_check(_finite_vector(_last_fire_direction), "turret fire direction stays finite")
	_check(
		absf(_last_fire_direction.length() - 1.0) < 0.01,
		"turret fires a normalized direction",
	)
	await _destroy_world(world)


func _test_projectile_reflection() -> void:
	var world := _new_world()
	_add_box(world, Vector3(0.0, 0.55, 0.0), Vector3(0.08, 1.1, 4.0), RushProjectile.WORLD_LAYER)
	var projectile := RushProjectile.new()
	projectile.setup(Vector3.RIGHT, 1, 1, false, 24.0)
	projectile.position = Vector3(-1.0, 0.55, 0.0)
	_bounce_count = 0
	projectile.bounced.connect(_on_projectile_bounced)
	world.add_child(projectile)
	await _frames(16)
	_check(_bounce_count == 1, "projectile registers one thin-wall bounce")
	_check(projectile.has_bounced, "projectile records its bounced state")
	_check(projectile.direction.x < -0.9, "projectile reflects away from the wall")
	await _destroy_world(world)


func _test_hostile_projectile_filter() -> void:
	var world := _new_world()
	var player := _add_player(world, Vector3(3.0, 0.0, 0.0))
	var enemy := RushEnemy.new()
	enemy.position = Vector3(1.0, 0.0, 0.0)
	enemy.setup(RushEnemy.Kind.CHASER, 1)
	world.add_child(enemy)
	await _frames(3)
	var enemy_health: int = enemy.health
	var projectile := RushProjectile.new()
	projectile.setup(Vector3.RIGHT, 1, 0, true, 24.0)
	projectile.position = Vector3(-1.0, 0.55, 0.0)
	world.add_child(projectile)
	await _frames(15)
	_check(enemy.health == enemy_health, "hostile projectiles pass through enemies")
	_check(player.health == player.max_health - 1, "hostile projectiles damage the player")
	await _destroy_world(world)


func _test_sync_window_and_pause_clock() -> void:
	var world := _new_world()
	var enemy := RushEnemy.new()
	enemy.setup(RushEnemy.Kind.CHASER, 1)
	world.add_child(enemy)
	enemy.killed.connect(_on_enemy_killed)
	_killed_count = 0
	_last_kill_sync = false
	await _frames(2)
	_check(enemy.take_hit(1, Vector3.RIGHT, false, false), "real source hit is recorded")
	_check(enemy.take_hit(1, Vector3.LEFT, false, true), "echo source hit is recorded")
	_check(enemy.take_hit(1, Vector3.RIGHT, false, false), "sync lethal hit is accepted")
	_check(enemy.sync_kill, "real and echo hits within the window set sync_kill")
	_check(_last_kill_sync, "sync_kill is set before the killed signal callback")
	_check(_killed_count == 1, "sync kill still emits one killed signal")
	await _destroy_world(world)

	world = _new_world()
	enemy = RushEnemy.new()
	enemy.setup(RushEnemy.Kind.CHASER, 1)
	world.add_child(enemy)
	await _frames(2)
	_check(enemy.take_hit(1, Vector3.RIGHT, false, false), "expiry case records the real source")
	await _frames(80)
	_check(enemy.take_hit(1, Vector3.LEFT, false, true), "expiry case records the late echo source")
	_check(enemy.take_hit(1, Vector3.RIGHT, false, true), "expiry case accepts the lethal echo hit")
	_check(not enemy.sync_kill, "sources outside 1.2 seconds do not sync")
	await _destroy_world(world)

	world = _new_world()
	enemy = RushEnemy.new()
	enemy.setup(RushEnemy.Kind.CHASER, 1)
	world.add_child(enemy)
	await _frames(2)
	_check(enemy.take_hit(1, Vector3.RIGHT, false, false), "pause case records the real source")
	paused = true
	await _frames(90)
	paused = false
	_check(enemy.take_hit(1, Vector3.LEFT, false, true), "pause case records the echo source")
	_check(enemy.take_hit(1, Vector3.RIGHT, false, false), "pause case accepts the lethal hit")
	_check(enemy.sync_kill, "paused time does not expire the sync window")
	await _destroy_world(world)


func _new_world(with_arena: bool = false) -> Node3D:
	var world := Node3D.new()
	root.add_child(world)
	if with_arena:
		world.add_child(RushArena.new())
	return world


func _add_player(world: Node3D, at: Vector3) -> RushPlayer:
	var player := RushPlayer.new()
	player.position = at
	world.add_child(player)
	return player


func _add_box(world: Node3D, at: Vector3, size: Vector3, layer: int) -> StaticBody3D:
	var body := StaticBody3D.new()
	body.collision_layer = layer
	body.collision_mask = 0
	body.position = at
	var collision := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = size
	collision.shape = shape
	body.add_child(collision)
	world.add_child(body)
	return body


func _destroy_world(world: Node3D) -> void:
	if is_instance_valid(world):
		world.queue_free()
	await process_frame


func _frames(count: int) -> void:
	for _index: int in count:
		await physics_frame
		await process_frame


func _on_enemy_killed(enemy: RushEnemy, _by_ricochet: bool) -> void:
	_killed_count += 1
	_last_kill_sync = enemy.sync_kill


func _on_projectile_bounced(_at: Vector3) -> void:
	_bounce_count += 1


func _on_turret_fired(_origin: Vector3, direction: Vector3) -> void:
	_turret_fire_count += 1
	_last_fire_direction = direction


func _check(condition: bool, description: String) -> void:
	_checks += 1
	if condition:
		print("PASS: ", description)
	else:
		_failures += 1
		push_error("FAIL: " + description)


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)
