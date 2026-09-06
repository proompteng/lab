extends SceneTree

var _checks: int = 0
var _failures: int = 0
var _game: RicochetGame
var _save_path: String = "user://rush-test-%d-%d.cfg" % [OS.get_process_id(), Time.get_ticks_usec()]


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
	_game = RicochetGame.new()
	_game.profile.path = _save_path
	_game.manual_input = true
	_game.spawning_enabled = false
	root.add_child(_game)
	await _frames(3)
	_check(_game.phase == RicochetGame.Phase.TITLE, "opens at title without starting combat")
	_check(not _game.player.active, "title preview cannot damage the player")
	await _test_storage_notice()
	_game.start_run()
	_check(not _game.try_echo(), "empty recording cannot deploy an echo")
	await _test_movement_and_echo()
	await _test_scoring()
	await _test_upgrades()
	await _test_spawning()
	await _test_game_over_and_retry()
	_game.queue_free()
	paused = false
	await process_frame
	DirAccess.remove_absolute(_save_path)
	print("Game acceptance: %d/%d checks passed" % [_checks - _failures, _checks])
	quit(0 if _failures == 0 else 1)


func _test_movement_and_echo() -> void:
	_game.player.move_input = Vector2.RIGHT
	_game.player.aim_direction = Vector3.FORWARD
	_game.fire_input = true
	await _frames(75)
	_game.player.move_input = Vector2.ZERO
	_game.fire_input = false
	_check(_game.player.position.x > 7.0, "direct movement crosses the arena promptly")
	_check(_game.projectiles.size() > 0, "holding fire creates real projectiles")
	_check(_game.echo_ready, "movement and fire produce a deployable recording")
	var before: Vector3 = _game.player.position
	var event := InputEventKey.new()
	event.physical_keycode = KEY_E
	event.pressed = true
	_game._unhandled_input(event)
	_check(_game.echoes_created == 1, "E deploys the recorded echo through the input handler")
	_check(_game.active_echoes == 1, "one replay actor joins the live arena")
	_check(
		_game.player.position.is_equal_approx(before), "summoning preserves the player's position"
	)
	_check(
		_game.echoes[0].position.x < before.x - 5.0, "echo starts at the earlier recorded position"
	)
	_check(not _game.try_echo(), "cooldown prevents repeated activation")
	var echo: RushEcho = _game.echoes[0]
	_game.toggle_pause()
	var replay_time: float = echo.elapsed
	var game_time: float = _game.elapsed
	var charge: float = _game.echo_charge
	await _frames(15)
	_check(is_equal_approx(echo.elapsed, replay_time), "pause freezes the replay clock")
	_check(is_equal_approx(_game.elapsed, game_time), "pause freezes the run clock")
	_check(is_equal_approx(_game.echo_charge, charge), "pause freezes ability recharge")
	_game.toggle_pause()
	await _frames(20)
	var echo_projectiles: int = 0
	for projectile: RushProjectile in _game.projectiles:
		if projectile.from_echo:
			echo_projectiles += 1
	_check(echo_projectiles > 0, "replay emits damaging echo projectiles into the world")
	_check(echo.position.x > 1.0, "replay follows the recorded movement")
	await _frames(90)
	_check(_game.active_echoes == 0, "replay removes itself after the recorded duration")
	_check(root.gui_get_focus_owner() == null, "resume returns keyboard focus to combat")


func _test_scoring() -> void:
	_game.start_run()
	await _frames(2)
	_check(
		is_equal_approx(_game.hud._dash_bar.value, _game.hud._dash_bar.max_value),
		"a ready dash displays a full recharge bar"
	)
	var visible_pips: int = 0
	for pip: Control in _game.hud._health_pips.get_children():
		if pip.visible:
			visible_pips += 1
	_check(visible_pips == _game.player.max_health, "health shows one pip per actual hit point")
	var enemy: RushEnemy = _game._spawn_enemy(RushEnemy.Kind.CHASER, Vector3(7, 0, 5))
	enemy.set_physics_process(false)
	var base_score: int = enemy.score_value
	enemy.take_hit(enemy.health, Vector3.RIGHT, false)
	_check(_game.kills == 1 and _game.score == base_score, "a direct kill awards its actual score")
	_check(
		not enemy.take_hit(10, Vector3.RIGHT, true), "a dead enemy cannot award a duplicate kill"
	)
	var bank: RushEnemy = _game._spawn_enemy(RushEnemy.Kind.CHASER, Vector3(-7, 0, 5))
	bank.set_physics_process(false)
	bank.take_hit(bank.health, Vector3.RIGHT, true)
	_check(_game.score == base_score * 3, "a bounced kill scores double")
	var synchronized: RushEnemy = _game._spawn_enemy(RushEnemy.Kind.BRUTE, Vector3(7, 0, -5))
	synchronized.set_physics_process(false)
	var score_before: int = _game.score
	synchronized.take_hit(1, Vector3.RIGHT, false, false)
	synchronized.take_hit(synchronized.health, Vector3.LEFT, false, true)
	_check(_game.sync_kills == 1, "player and echo hits produce a sync kill")
	_check(
		_game.score - score_before == synchronized.score_value * 2, "sync doubles the kill score"
	)
	_check(_game.combo == 3, "consecutive kills build the combo")
	await _frames(190)
	_check(_game.combo == 0, "the chain expires without another kill")


func _test_upgrades() -> void:
	_game.start_run()
	await _frames(2)
	var energy: RushPickup = _game._spawn_pickup(Vector3(0, 0.4, 0), _game.xp_goal + 2)
	_check(energy.value == 10, "dropped energy preserves its amount")
	await _frames(20)
	_check(
		_game.phase == RicochetGame.Phase.UPGRADING and paused, "collected XP pauses for a choice"
	)
	_check(_game.upgrade_choices.size() == 3, "the choice offers three upgrades")
	var ids: Array[StringName] = []
	for choice: Dictionary in _game.upgrade_choices:
		_check(not ids.has(choice["id"]), "upgrade choices are distinct")
		ids.append(choice["id"])
	var saved_xp: int = _game.xp
	_check(not _game.choose_upgrade(&"unoffered"), "unknown upgrades are rejected")
	_check(_game.xp == saved_xp and paused, "rejected choices preserve XP and pause")
	_check(_game.choose_upgrade(ids[0]), "an offered upgrade can be selected")
	_check(_game.level == 2 and _game.xp == 2, "levelling preserves excess XP")
	_check(_game.phase == RicochetGame.Phase.PLAYING and not paused, "the choice resumes combat")
	_check(root.gui_get_focus_owner() == null, "upgrade selection releases keyboard focus")
	_game.player.max_health = 9
	_game.player.health = 5
	_game.bounces = 5
	_game.pellets = 5
	_game.shot_interval = 0.07
	_game.player.speed = 13.0
	_game.magnet_radius = 9.0
	_game.xp = _game.xp_goal
	_game._offer_upgrades()
	for choice: Dictionary in _game.upgrade_choices:
		if choice["id"] == &"health":
			_check(
				not "+1" in str(choice["description"]),
				"capped health offers describe repair honestly"
			)
	_check(_game.choose_upgrade(&"health"), "repair remains available at the maximum health cap")
	_check(
		_game.player.max_health == 9 and _game.player.health == 8,
		"capped repair restores three health"
	)


func _test_spawning() -> void:
	_game.start_run()
	_game.spawning_enabled = true
	await _frames(15)
	_check(_game.enemies.is_empty(), "spawn warning precedes the enemy")
	_check(not _game._pending_spawns.is_empty(), "the opening threat has a pending telegraph")
	await _frames(50)
	_check(not _game.enemies.is_empty(), "the telegraphed threat enters the arena")
	_game.spawning_enabled = false


func _test_game_over_and_retry() -> void:
	_game.score = 12345
	_game.player.take_damage(100)
	_check(
		_game.phase == RicochetGame.Phase.OVER and paused, "lethal damage ends and freezes the run"
	)
	_check(_game.best_score == 12345, "a new record is retained")
	await _test_storage_notice()
	var reloaded := RushProfile.new()
	reloaded.path = _save_path
	_check(
		reloaded.load_profile() == OK and reloaded.best_score == 12345,
		"record survives a fresh load"
	)
	_game.start_run()
	await _frames(2)
	_check(
		_game.player.health == 5 and _game.player.active, "retry creates a healthy active player"
	)
	_check(
		_game.score == 0 and _game.level == 1 and _game.kills == 0, "retry resets run progression"
	)
	_check(
		_game.active_echoes == 0 and _game.echoes_created == 0,
		"retry clears previous replay actors"
	)
	_check(_game.echo_history < 0.2, "retry starts a fresh recording")
	_check(_game.best_score == 12345, "retry preserves the best record")
	_game.profile.path = "user://missing-rush-directory/record.cfg"
	_game.toggle_sound()
	_check(not _game.storage_notice.is_empty(), "save failure is visible to the player")
	_game.profile.path = _save_path
	_game.toggle_sound()
	_check(_game.storage_notice.is_empty(), "successful saving clears the prior error")


func _test_storage_notice() -> void:
	_game.profile.path = "user://missing-rush-directory/record.cfg"
	_game.toggle_sound()
	await _frames(2)
	_check(
		(
			_game.hud._storage_notice.is_visible_in_tree()
			and not _game.hud._storage_notice.text.is_empty()
		),
		"save failure is displayed in phase %d" % _game.phase
	)
	_game.profile.path = _save_path
	_game.toggle_sound()
	await _frames(2)
	_check(not _game.hud._storage_notice.visible, "recovery clears the visible save notice")


func _test_profile() -> void:
	var profile := RushProfile.new()
	profile.path = _save_path
	profile.best_score = 999
	_check(
		profile.load_profile() == OK and profile.best_score == 0, "missing profile resets defaults"
	)
	profile.best_score = 350
	profile.best_kills = 4
	profile.muted = true
	_check(profile.save_profile() == OK, "profile saves atomically")
	var fresh := RushProfile.new()
	fresh.path = _save_path
	_check(fresh.load_profile() == OK, "saved profile loads")
	_check(
		fresh.best_score == 350 and fresh.best_kills == 4 and fresh.muted,
		"profile round trip retains values"
	)
	var malformed := ConfigFile.new()
	malformed.set_value("pilot", "best_score", "invalid")
	malformed.save(_save_path)
	_check(fresh.load_profile() == ERR_INVALID_DATA, "malformed profile is rejected")
	_check(fresh.best_score == 350, "a failed load leaves the previous valid record intact")
	DirAccess.remove_absolute(_save_path)
