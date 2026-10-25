class_name SalvageSoundscape
extends Node

## Procedural radio and engine bed for the salvage tug. The stream is kept
## deliberately small and quiet; this is atmosphere, not an alarm system.

const ENGINE_RATE := 16000
const CUE_RATE := 16000
const ENGINE_DURATION := 1.2

var muted: bool = false
var engine_level: float = 0.0
var strain_level: float = 0.0

var _audio_enabled: bool = false
var _engine_stream: AudioStreamWAV
var _engine_player: AudioStreamPlayer
var _cue_players: Array[AudioStreamPlayer] = []
var _engine_mix: float = 0.0
var _strain_mix: float = 0.0
var _output_gain: float = 1.0
var _engine_volume_db: float = -80.0
var _cue_gain: float = 1.0


func _ready() -> void:
	_audio_enabled = not _is_headless_display()
	if not _audio_enabled:
		# Headless CI and scene parsers should not allocate an audio device or
		# stream buffers. The public API remains safe to call as a no-op.
		set_process(false)
		return
	_setup_engine()


func _process(delta: float) -> void:
	if not _audio_enabled:
		return
	_engine_mix = lerpf(_engine_mix, clampf(engine_level, 0.0, 1.0), 1.0 - exp(-delta * 5.5))
	_strain_mix = lerpf(_strain_mix, clampf(strain_level, 0.0, 1.0), 1.0 - exp(-delta * 4.0))
	var target_output := 0.0 if muted else 1.0
	_output_gain = lerpf(_output_gain, target_output, 1.0 - exp(-delta * 9.0))
	_cue_gain = lerpf(_cue_gain, target_output, 1.0 - exp(-delta * 12.0))
	_update_engine_output(delta)
	_update_cue_output()


func set_muted(value: bool) -> void:
	muted = value


func play_cue(kind: String) -> void:
	if not _audio_enabled or muted:
		return
	var normalized := kind.strip_edges().to_lower()
	if _cue_duration(normalized) <= 0.0:
		return
	var player := AudioStreamPlayer.new()
	player.stream = _build_cue_stream(normalized)
	player.playback_type = AudioServer.PLAYBACK_TYPE_STREAM
	player.volume_db = -80.0 if muted else -13.0
	add_child(player)
	_cue_players.append(player)
	player.finished.connect(_on_cue_finished.bind(player))
	player.play()


func _setup_engine() -> void:
	_engine_stream = _build_engine_stream()
	_engine_player = AudioStreamPlayer.new()
	_engine_player.stream = _engine_stream
	_engine_player.playback_type = AudioServer.PLAYBACK_TYPE_STREAM
	_engine_player.volume_db = -80.0
	add_child(_engine_player)
	_engine_player.play()


func _build_engine_stream() -> AudioStreamWAV:
	# The loop length is one full cycle of the slow breath, with integer cycles
	# for the motor harmonics. That makes the loop seam silent without an edge
	# envelope and avoids the lifetime hazards of a generator playback object.
	var frame_count := int(ENGINE_DURATION * ENGINE_RATE)
	var data := PackedByteArray()
	data.resize(frame_count * 4)
	var offset := 0
	for frame_index in range(frame_count):
		var time := float(frame_index) / float(ENGINE_RATE)
		var slow_breath := 0.72 + sin(TAU * time * 0.8333333) * 0.13
		var fundamental := sin(TAU * time * 80.0)
		var second_harmonic := sin(TAU * time * 160.0 + 0.42) * 0.19
		var motor_wobble := sin(TAU * time * 2.5) * 0.07
		var sample := (fundamental * 0.32 + second_harmonic + motor_wobble) * slow_breath * 0.18
		_write_i16(data, offset, sample)
		_write_i16(data, offset + 2, sample * 0.965)
		offset += 4
	var stream := AudioStreamWAV.new()
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate = ENGINE_RATE
	stream.stereo = true
	stream.loop_mode = AudioStreamWAV.LOOP_FORWARD
	stream.loop_begin = 0
	stream.loop_end = frame_count
	stream.data = data
	return stream


func _update_engine_output(delta: float) -> void:
	if not is_instance_valid(_engine_player):
		return
	var target_gain := _engine_mix * _output_gain
	var target_db := -80.0 if target_gain < 0.001 else lerpf(-58.0, -28.0, target_gain)
	_engine_volume_db = lerpf(_engine_volume_db, target_db, 1.0 - exp(-delta * 8.0))
	_engine_player.volume_db = _engine_volume_db
	_engine_player.pitch_scale = 1.0 + _strain_mix * 0.035


func _update_cue_output() -> void:
	var cue_volume_db := lerpf(-80.0, -13.0, _cue_gain)
	for player in _cue_players.duplicate():
		if is_instance_valid(player):
			player.volume_db = cue_volume_db


func _build_cue_stream(kind: String) -> AudioStreamWAV:
	var duration := _cue_duration(kind)
	var frame_count := int(duration * CUE_RATE)
	var data := PackedByteArray()
	data.resize(frame_count * 4)
	var offset := 0
	for frame_index in range(frame_count):
		var time := float(frame_index) / float(CUE_RATE)
		var sample := clampf(_cue_sample(kind, time, duration), -1.0, 1.0) * 0.34
		_write_i16(data, offset, sample)
		_write_i16(data, offset + 2, sample * 0.97)
		offset += 4
	var stream := AudioStreamWAV.new()
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate = CUE_RATE
	stream.stereo = true
	stream.data = data
	return stream


func _cue_sample(kind: String, time: float, duration: float) -> float:
	var result := 0.0
	match kind:
		"attach":
			var progress := time / duration
			var envelope := _envelope(time, duration, 0.028, 0.11)
			var frequency := lerpf(470.0, 760.0, progress)
			result = (
				envelope
				* (sin(TAU * frequency * time) * 0.72 + sin(TAU * frequency * 2.01 * time) * 0.08)
			)
		"release":
			var progress := time / duration
			var envelope := _envelope(time, duration, 0.024, 0.13)
			var frequency := lerpf(690.0, 390.0, progress)
			result = (
				envelope
				* (sin(TAU * frequency * time) * 0.68 + sin(TAU * frequency * 1.51 * time) * 0.1)
			)
		"deliver":
			result = _chime_sequence(time, [540.0, 670.0, 820.0], 0.14, 0.22)
		"damage":
			var envelope := _envelope(time, duration, 0.012, 0.17)
			var thump := exp(-time * 14.0) * sin(TAU * 156.0 * time) * 0.62
			var low_tone := sin(TAU * 245.0 * time + 0.4) * 0.18
			result = envelope * (thump + low_tone)
		"win":
			result = _chime_sequence(time, [520.0, 650.0, 780.0, 1040.0], 0.16, 0.32)
		"click":
			var envelope := exp(-time * 55.0) * _envelope(time, duration, 0.004, 0.045)
			result = envelope * (sin(TAU * 880.0 * time) * 0.34 + sin(TAU * 1760.0 * time) * 0.06)
	return result


func _chime_sequence(
	time: float, frequencies: Array, spacing: float, note_duration: float
) -> float:
	var result := 0.0
	for index in range(frequencies.size()):
		var start := 0.015 + float(index) * spacing
		var local_time := time - start
		if local_time < 0.0 or local_time >= note_duration:
			continue
		var frequency: float = frequencies[index]
		var envelope := _envelope(local_time, note_duration, 0.018, 0.13)
		var harmonic := sin(TAU * frequency * 2.0 * local_time + 0.15) * 0.1
		result += envelope * (sin(TAU * frequency * local_time) * 0.56 + harmonic)
	return result


func _envelope(time: float, duration: float, attack: float, release: float) -> float:
	var attack_phase := clampf(time / attack, 0.0, 1.0)
	var release_phase := clampf((duration - time) / release, 0.0, 1.0)
	var attack_curve := attack_phase * attack_phase * (3.0 - 2.0 * attack_phase)
	var release_curve := release_phase * release_phase * (3.0 - 2.0 * release_phase)
	return attack_curve * release_curve


func _cue_duration(kind: String) -> float:
	var duration := 0.0
	match kind:
		"attach":
			duration = 0.28
		"release":
			duration = 0.26
		"deliver":
			duration = 0.62
		"damage":
			duration = 0.29
		"win":
			duration = 0.88
		"click":
			duration = 0.09
	return duration


func _write_i16(data: PackedByteArray, offset: int, value: float) -> void:
	var signed_value := clampi(int(value * 32767.0), -32768, 32767)
	var unsigned_value := signed_value if signed_value >= 0 else signed_value + 65536
	data[offset] = unsigned_value & 0xff
	data[offset + 1] = (unsigned_value >> 8) & 0xff


func _on_cue_finished(player: AudioStreamPlayer) -> void:
	_cue_players.erase(player)
	if is_instance_valid(player):
		player.queue_free()


func _is_headless_display() -> bool:
	return DisplayServer.get_name().to_lower() == "headless"


func _exit_tree() -> void:
	var engine_player := _engine_player
	_engine_player = null
	_engine_stream = null
	if is_instance_valid(engine_player):
		engine_player.stop()
		engine_player.stream = null
		engine_player.free()
	for player in _cue_players.duplicate():
		if is_instance_valid(player):
			player.stop()
			player.free()
	_cue_players.clear()
