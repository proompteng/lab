extends SceneTree

var _checks: int = 0
var _failures: int = 0
var _fired: Array[Dictionary] = []
var _finished_count: int = 0


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_test_tape_window_and_detachment()
	_test_invalid_history_rejected()
	_test_echo_replay_timing()
	await process_frame
	await process_frame
	print("Echo tests: %d/%d checks passed" % [_checks - _failures, _checks])
	quit(1 if _failures > 0 else 0)


func _test_tape_window_and_detachment() -> void:
	var tape: RushEchoTape = RushEchoTape.new()
	var original_shot: Dictionary = _shot(Vector3(1.0, 0.65, 0.0), Vector3.RIGHT, 2, 3, 26.0)
	for index: int in 300:
		var shots: Array[Dictionary] = [original_shot]
		tape.record(0.02, Vector3(index, 0.0, -index * 0.1), Vector3.FORWARD, shots)

	var captured: Array[Dictionary] = tape.snapshot()
	_check(captured.size() <= 240, "tape stays within the 240 sample bound")
	_check(tape.duration <= RushEchoTape.DURATION + 0.0001, "tape keeps at most three seconds")
	_check(tape.duration > 2.9, "tape retains the available three-second window")
	_check(not captured.is_empty(), "recorded history produces a snapshot")
	if captured.is_empty():
		return
	var first: Dictionary = captured[0]
	var last: Dictionary = captured[captured.size() - 1]
	original_shot["damage"] = 999
	_check(first["shots"][0]["damage"] == 2, "later weapon changes cannot rewrite recorded shots")
	_check(absf(float(first["time"])) < 0.0001, "snapshot time is rebased to zero")
	_check(
		absf(float(last["time"]) - tape.duration) < 0.0001,
		"snapshot duration matches its rebased final sample"
	)

	first["position"] = Vector3(999.0, 999.0, 999.0)
	var detached_shots: Array[Dictionary] = first["shots"]
	if not detached_shots.is_empty():
		detached_shots[0]["origin"] = Vector3(888.0, 888.0, 888.0)
	var reread: Array[Dictionary] = tape.snapshot()
	var reread_position: Vector3 = reread[0]["position"]
	_check(
		reread_position != Vector3(999.0, 999.0, 999.0),
		"snapshot position mutation does not alter the tape"
	)
	var reread_shots: Array[Dictionary] = reread[0]["shots"]
	if not reread_shots.is_empty():
		var reread_origin: Vector3 = reread_shots[0]["origin"]
		_check(
			reread_origin != Vector3(888.0, 888.0, 888.0),
			"nested snapshot shot mutation does not alter the tape"
		)
	tape.clear()
	_check(is_zero_approx(tape.duration), "clear removes all recorded duration")
	_check(tape.snapshot().is_empty(), "clear removes all recorded samples")


func _test_invalid_history_rejected() -> void:
	var empty_echo: RushEcho = RushEcho.new()
	_check(not empty_echo.setup([]), "echo rejects a zero-history deployment")
	empty_echo.free()
	var short_samples: Array[Dictionary] = [
		_sample(0.0, Vector3.ZERO, Vector3.FORWARD, []),
		_sample(0.2, Vector3.RIGHT, Vector3.FORWARD, []),
	]
	var short_echo: RushEcho = RushEcho.new()
	_check(not short_echo.setup(short_samples), "echo rejects history shorter than 0.65 seconds")
	short_echo.free()
	var long_samples: Array[Dictionary] = [
		_sample(0.0, Vector3.ZERO, Vector3.FORWARD, []),
		_sample(3.1, Vector3.RIGHT, Vector3.FORWARD, []),
	]
	var long_echo: RushEcho = RushEcho.new()
	_check(not long_echo.setup(long_samples), "echo rejects traces longer than three seconds")
	long_echo.free()
	var invalid_shot: Dictionary = {"origin": Vector3.ZERO, "damage": 1}
	var malformed_samples: Array[Dictionary] = [
		_sample(0.0, Vector3.ZERO, Vector3.FORWARD, [invalid_shot]),
		_sample(0.8, Vector3.RIGHT, Vector3.FORWARD, []),
	]
	var malformed_echo: RushEcho = RushEcho.new()
	_check(not malformed_echo.setup(malformed_samples), "echo rejects malformed shot traces")
	malformed_echo.free()


func _test_echo_replay_timing() -> void:
	var shot_a: Dictionary = _shot(Vector3(0.0, 0.65, 0.0), Vector3.RIGHT, 2, 1, 24.0)
	var shot_b: Dictionary = _shot(Vector3(4.0, 0.65, 0.0), Vector3.LEFT, 3, 2, 27.0)
	var samples: Array[Dictionary] = [
		_sample(0.0, Vector3.ZERO, Vector3.FORWARD, [shot_a]),
		_sample(0.4, Vector3(4.0, 0.0, 0.0), Vector3.RIGHT, []),
		_sample(0.9, Vector3(9.0, 0.0, 0.0), Vector3.LEFT, [shot_b]),
	]
	var echo: RushEcho = RushEcho.new()
	_check(echo.setup(samples), "echo accepts a complete recorded trace")
	_check(echo.position == samples[0]["position"], "setup seeds the first recorded world position")
	echo.process_mode = Node.PROCESS_MODE_DISABLED
	echo.fired.connect(_on_fired)
	echo.finished.connect(_on_finished)
	root.add_child(echo)

	echo.advance(0.05)
	_check(_fired.size() == 1, "time-zero shot fires on the first replay advance")
	if _fired.size() == 1:
		_check(_fired[0]["origin"] == shot_a["origin"], "replayed origin is exact")
		_check(_fired[0]["damage"] == shot_a["damage"], "replayed damage is exact")
		_check(_fired[0]["bounces"] == shot_a["bounces"], "replayed bounce count is exact")

	echo.advance(0.35)
	_check(_fired.size() == 1, "no shot fires before its recorded sample time")
	_check(absf(echo.position.x - 4.0) < 0.001, "varied-delta replay reaches the interpolated pose")
	echo.advance(0.5)
	_check(_fired.size() == 2, "final sample shot fires exactly once")
	_check(_finished_count == 1, "replay emits finished exactly once")
	_check(echo.is_queued_for_deletion(), "replay queues itself after the final sample")
	echo.advance(1.0)
	_check(_fired.size() == 2, "replay does not duplicate shots after finishing")
	_check(_finished_count == 1, "replay does not duplicate finished after finishing")
	if _fired.size() == 2:
		_check(_fired[1]["direction"] == shot_b["direction"], "final direction is exact")
		_check(_fired[1]["speed"] == shot_b["speed"], "final speed is exact")


func _sample(time: float, position: Vector3, aim: Vector3, shots: Array[Dictionary]) -> Dictionary:
	return {"time": time, "position": position, "aim": aim, "shots": shots}


func _shot(
	origin: Vector3, direction: Vector3, damage: int, bounces: int, speed: float
) -> Dictionary:
	return {
		"origin": origin,
		"direction": direction,
		"damage": damage,
		"bounces": bounces,
		"speed": speed,
	}


func _on_fired(
	origin: Vector3, direction: Vector3, damage: int, bounces: int, speed: float
) -> void:
	var shot: Dictionary = {
		"origin": origin,
		"direction": direction,
		"damage": damage,
		"bounces": bounces,
		"speed": speed,
	}
	_fired.append(shot)


func _on_finished() -> void:
	_finished_count += 1


func _check(condition: bool, description: String) -> void:
	_checks += 1
	if condition:
		print("PASS: ", description)
	else:
		_failures += 1
		push_error("FAIL: " + description)
