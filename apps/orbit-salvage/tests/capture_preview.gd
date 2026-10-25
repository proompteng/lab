extends SceneTree


func _initialize() -> void:
	_capture.call_deferred()


func _capture() -> void:
	var game := OrbitSalvageGame.new()
	game.profile.path = "user://preview-only.cfg"
	root.add_child(game)
	for _index: int in 12:
		await process_frame
	await RenderingServer.frame_post_draw
	var directory: String = ProjectSettings.globalize_path("res://build/previews")
	DirAccess.make_dir_recursive_absolute(directory)
	root.get_texture().get_image().save_png(directory.path_join("title.png"))
	game.start_run()
	for _index: int in 12:
		await process_frame
	await RenderingServer.frame_post_draw
	root.get_texture().get_image().save_png(directory.path_join("flight.png"))
	print("Captured rendered game previews in ", directory)
	game.queue_free()
	await process_frame
	quit()
