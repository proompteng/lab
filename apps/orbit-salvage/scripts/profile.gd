class_name SalvageProfile
extends RefCounted

var best_haul: int = 0
var completed_runs: int = 0
var muted: bool = false
var path: String = "user://pilot.cfg"


func load_profile() -> Error:
	var config := ConfigFile.new()
	var result: Error = config.load(path)
	if result == ERR_FILE_NOT_FOUND:
		best_haul = 0
		completed_runs = 0
		muted = false
		return OK
	if result != OK:
		return result
	var best: Variant = config.get_value("pilot", "best_haul", 0)
	var runs: Variant = config.get_value("pilot", "completed_runs", 0)
	var sound: Variant = config.get_value("audio", "muted", false)
	if not best is int or not runs is int or not sound is bool:
		return ERR_INVALID_DATA
	if best < 0 or runs < 0:
		return ERR_INVALID_DATA
	best_haul = best
	completed_runs = runs
	muted = sound
	return OK


func save_profile() -> Error:
	var config := ConfigFile.new()
	config.set_value("pilot", "best_haul", best_haul)
	config.set_value("pilot", "completed_runs", completed_runs)
	config.set_value("audio", "muted", muted)
	return config.save(path)


func finish_run(earned: int) -> Error:
	best_haul = maxi(best_haul, earned)
	completed_runs += 1
	return save_profile()
