class_name RushProfile
extends RefCounted

var path: String = "user://ricochet-rush.cfg"
var best_score: int = 0
var best_kills: int = 0
var muted: bool = false


func load_profile() -> Error:
	if not FileAccess.file_exists(path):
		best_score = 0
		best_kills = 0
		muted = false
		return OK
	var file := ConfigFile.new()
	var result: Error = file.load(path)
	if result != OK:
		return result
	var saved_score: Variant = file.get_value("pilot", "best_score", 0)
	var saved_kills: Variant = file.get_value("pilot", "best_kills", 0)
	var saved_muted: Variant = file.get_value("pilot", "muted", false)
	if not saved_score is int or not saved_kills is int or not saved_muted is bool:
		return ERR_INVALID_DATA
	if saved_score < 0 or saved_kills < 0:
		return ERR_INVALID_DATA
	best_score = saved_score
	best_kills = saved_kills
	muted = saved_muted
	return OK


func save_profile() -> Error:
	var file := ConfigFile.new()
	file.set_value("pilot", "best_score", best_score)
	file.set_value("pilot", "best_kills", best_kills)
	file.set_value("pilot", "muted", muted)
	var temporary_path: String = path + ".tmp"
	var result: Error = file.save(temporary_path)
	if result != OK:
		return result
	return DirAccess.rename_absolute(temporary_path, path)
