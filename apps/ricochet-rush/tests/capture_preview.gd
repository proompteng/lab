extends SceneTree


func _initialize() -> void:
	_capture.call_deferred()


func _frames(count: int) -> void:
	for _index: int in count:
		await physics_frame
		await process_frame


func _save_preview(filename: String) -> void:
	await RenderingServer.frame_post_draw
	var directory: String = ProjectSettings.globalize_path("res://build/previews")
	DirAccess.make_dir_recursive_absolute(directory)
	var result: Error = root.get_texture().get_image().save_png(directory.path_join(filename))
	if result != OK:
		push_error("Could not capture " + filename)
		quit(1)


func _capture() -> void:
	var game := RicochetGame.new()
	game.profile.path = "user://rush-preview-%d.cfg" % OS.get_process_id()
	game.manual_input = true
	game.spawning_enabled = false
	root.add_child(game)
	game.sound.set_muted(true)
	await _frames(24)
	await _save_preview("title.png")
	game.start_run()
	game.player.position = Vector3(2.0, 0.0, 4.0)
	game.camera.reset_follow(game.player)
	game.player.move_input = Vector2(-0.15, -0.06)
	game.player.aim_direction = Vector3(0.0, 0.0, -1.0)
	game.fire_input = true
	await _frames(180)
	game.player.move_input = Vector2(0.32, 0.0)
	game._spawn_enemy(RushEnemy.Kind.BRUTE, Vector3(0, 0, -4))
	game._spawn_enemy(RushEnemy.Kind.TURRET, Vector3(-4, 0, -5))
	game._spawn_enemy(RushEnemy.Kind.CHASER, Vector3(-3, 0, -2))
	game._spawn_enemy(RushEnemy.Kind.RUNNER, Vector3(4, 0, -3))
	game.try_echo()
	for _index: int in 24:
		game._update_aim()
		await _frames(1)
	await _save_preview("echo.png")
	print(
		(
			"Gameplay preview: %d FPS, %d draw calls, %d rendered primitives"
			% [
				Performance.get_monitor(Performance.TIME_FPS),
				Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
				Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME),
			]
		)
	)
	game.toggle_pause()
	await _frames(20)
	await _save_preview("pause.png")
	game.queue_free()
	paused = false
	await process_frame
	print("Rendered previews saved in res://build/previews")
	quit()
