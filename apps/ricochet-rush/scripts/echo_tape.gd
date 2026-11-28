class_name RushEchoTape
extends RefCounted

const DURATION: float = 3.0
const MIN_DURATION: float = 0.65
const MAX_SAMPLES: int = 240
const SHOT_KEYS: Array[String] = ["origin", "direction", "damage", "bounces", "speed"]

var duration: float:
	get:
		if _samples.is_empty():
			return 0.0
		var first_time: float = float(_samples[0]["time"])
		var last_time: float = float(_samples[_samples.size() - 1]["time"])
		return clampf(last_time - first_time, 0.0, DURATION)

var _samples: Array[Dictionary] = []
var _elapsed: float = 0.0


func clear() -> void:
	_samples.clear()
	_elapsed = 0.0


func record(delta: float, position: Vector3, aim: Vector3, shots: Array[Dictionary]) -> void:
	if not is_finite(delta) or delta < 0.0:
		return
	if not _finite_vector(position) or not _finite_vector(aim):
		return

	var copied_shots: Array[Dictionary] = []
	for shot: Dictionary in shots:
		var copied_shot: Dictionary = _copy_shot(shot)
		if copied_shot.is_empty():
			return
		copied_shots.append(copied_shot)

	var next_elapsed: float = _elapsed + delta
	if not is_finite(next_elapsed):
		return
	_elapsed = next_elapsed
	var sample: Dictionary = {
		"time": _elapsed,
		"position": position,
		"aim": aim,
		"shots": copied_shots,
	}
	_samples.append(sample)
	_trim_to_window()


func snapshot() -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	if _samples.is_empty():
		return result

	var base_time: float = float(_samples[0]["time"])
	for sample: Dictionary in _samples:
		var copied_shots: Array[Dictionary] = []
		var sample_shots: Array[Dictionary] = sample["shots"]
		for shot: Dictionary in sample_shots:
			copied_shots.append(_copy_shot(shot))
		var copied_sample: Dictionary = {
			"time": maxf(float(sample["time"]) - base_time, 0.0),
			"position": sample["position"],
			"aim": sample["aim"],
			"shots": copied_shots,
		}
		result.append(copied_sample)
	return result


func _trim_to_window() -> void:
	while _samples.size() > MAX_SAMPLES:
		_samples.remove_at(0)
	var cutoff: float = _elapsed - DURATION
	while _samples.size() > 1 and float(_samples[0]["time"]) < cutoff:
		_samples.remove_at(0)


func _copy_shot(shot: Dictionary) -> Dictionary:
	var has_required_keys: bool = true
	for key: String in SHOT_KEYS:
		has_required_keys = has_required_keys and shot.has(key)
	if not has_required_keys:
		return {}

	var origin_value: Variant = shot["origin"]
	var direction_value: Variant = shot["direction"]
	var damage_value: Variant = shot["damage"]
	var bounces_value: Variant = shot["bounces"]
	var speed_value: Variant = shot["speed"]
	var has_valid_types: bool = (
		origin_value is Vector3
		and direction_value is Vector3
		and damage_value is int
		and bounces_value is int
		and _is_number(speed_value)
	)
	if not has_valid_types:
		return {}

	var origin: Vector3 = origin_value
	var shot_direction: Vector3 = direction_value
	var shot_damage: int = damage_value
	var shot_bounces: int = bounces_value
	var shot_speed: float = float(speed_value)
	var has_valid_values: bool = (
		_finite_vector(origin)
		and _finite_vector(shot_direction)
		and shot_direction.length_squared() > 0.0001
		and shot_damage > 0
		and shot_bounces >= 0
		and is_finite(shot_speed)
		and shot_speed >= 0.0
	)
	if not has_valid_values:
		return {}
	return {
		"origin": origin,
		"direction": shot_direction,
		"damage": shot_damage,
		"bounces": shot_bounces,
		"speed": shot_speed,
	}


func _is_number(value: Variant) -> bool:
	return value is int or value is float


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)
