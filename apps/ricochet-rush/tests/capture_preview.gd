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
	await _frames(12)
	await _save_preview("title.png")
	game.start_run()
	game.player.move_input = Vector2(-0.5, 0.0)
	game.player.aim_direction = Vector3(0.0, 0.0, -1.0)
	game.fire_input = true
	await _frames(150)
	game.player.move_input = Vector2(0.0, 0.8)
	game._spawn_enemy(RushEnemy.Kind.BRUTE, Vector3(4, 0, -3))
	game._spawn_enemy(RushEnemy.Kind.TURRET, Vector3(-5, 0, -5))
	game._spawn_enemy(RushEnemy.Kind.CHASER, Vector3(7, 0, 3))
	game._spawn_enemy(RushEnemy.Kind.RUNNER, Vector3(0, 0, -5))
	game.try_echo()
	await _frames(28)
	game.player.aim_direction = (Vector3(4, 0, -3) - game.player.position).normalized()
	await _frames(4)
	await _save_preview("echo.png")
	game.toggle_pause()
	await _frames(3)
	await _save_preview("pause.png")
	game.queue_free()
	paused = false
	await process_frame
	print("Rendered previews saved in res://build/previews")
	quit()
