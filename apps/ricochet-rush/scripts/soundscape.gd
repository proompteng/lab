class_name RushSoundscape
extends Node

## Short procedural arcade cues. There is no continuous bed: the arena stays
## quiet between player actions, while a small voice pool keeps impacts crisp.

const CUE_RATE: int = 16000
const MAX_CUE_PLAYERS: int = 5
const CUE_KINDS := [
	&"shot",
	&"bounce",
	&"hit",
	&"kill",
	&"dash",
	&"echo",
	&"sync",
	&"spawn",
	&"upgrade",
	&"pickup",
	&"click",
	&"game_over",
]

var muted: bool = false
var intensity: float = 0.65

var _audio_enabled: bool = false
var _cue_streams: Dictionary = {}
var _cue_players: Array[AudioStreamPlayer] = []
var _cue_cooldowns: Array[float] = []
var _next_player: int = 0
var _output_mix: float = 1.0
var _intensity_mix: float = 0.65


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_audio_enabled = not _is_headless_display()
	if not _audio_enabled:
		# Headless CI can instantiate the class and call its API without opening
		# an audio device or allocating generated PCM buffers.
		set_process(false)
		return
	_cue_cooldowns.resize(CUE_KINDS.size())
	for index in _cue_cooldowns.size():
		_cue_cooldowns[index] = 0.0
	_build_cue_cache()
	_create_voice_pool()


func _process(delta: float) -> void:
	if not _audio_enabled:
		return
	var step := clampf(delta, 0.0, 0.1)
	for index in _cue_cooldowns.size():
		_cue_cooldowns[index] = maxf(_cue_cooldowns[index] - step, 0.0)
	var target_output := 0.0 if muted else 1.0
	_output_mix = lerpf(_output_mix, target_output, 1.0 - exp(-step * 12.0))
	_intensity_mix = lerpf(_intensity_mix, clampf(intensity, 0.0, 1.0), 1.0 - exp(-step * 7.0))
	var gain := _output_mix * lerpf(0.32, 1.0, _intensity_mix)
	var volume_db := -80.0 if gain < 0.001 else lerpf(-28.0, -9.0, gain)
	for player in _cue_players:
		if is_instance_valid(player) and player.is_playing():
			player.volume_db = volume_db


func set_muted(value: bool) -> void:
	muted = value


func play_cue(kind: StringName) -> void:
	if not _audio_enabled or muted:
		return
	var normalized := StringName(String(kind).strip_edges().to_lower())
	var cue_index := _cue_index(normalized)
	if cue_index < 0 or _cue_cooldowns[cue_index] > 0.0:
		return
	var stream := _cue_streams.get(normalized) as AudioStream
	if stream == null:
		return
	var player := _take_voice()
	if player == null:
		return
	_cue_cooldowns[cue_index] = _cue_cooldown_for(normalized)
	player.stream = stream
	player.playback_type = AudioServer.PLAYBACK_TYPE_STREAM
	player.volume_db = -80.0
	player.play()


func _build_cue_cache() -> void:
	_cue_streams.clear()
	for kind: StringName in CUE_KINDS:
		_cue_streams[kind] = _build_cue_stream(kind)


func _create_voice_pool() -> void:
	for index in MAX_CUE_PLAYERS:
		var player := AudioStreamPlayer.new()
		player.name = "Voice%02d" % index
		player.playback_type = AudioServer.PLAYBACK_TYPE_STREAM
		player.volume_db = -80.0
		add_child(player)
		_cue_players.append(player)


func _take_voice() -> AudioStreamPlayer:
	for offset in MAX_CUE_PLAYERS:
		var candidate := posmod(_next_player + offset, MAX_CUE_PLAYERS)
		var player := _cue_players[candidate]
		if not player.is_playing():
			_next_player = posmod(candidate + 1, MAX_CUE_PLAYERS)
			return player
	# A full pool drops the newest low-latency cue instead of stealing a voice
	# that is already speaking. This is the audible cap for bullet-heavy play.
	return null


func _cue_index(kind: StringName) -> int:
	var index := -1
	match kind:
		&"shot":
			index = 0
		&"bounce":
			index = 1
		&"hit":
			index = 2
		&"kill":
			index = 3
		&"dash":
			index = 4
		&"echo":
			index = 5
		&"sync":
			index = 6
		&"spawn":
			index = 7
		&"upgrade":
			index = 8
		&"pickup":
			index = 9
		&"click":
			index = 10
		&"game_over":
			index = 11
	return index


func _cue_cooldown_for(kind: StringName) -> float:
	var cooldown := 0.0
	match kind:
		&"shot":
			cooldown = 0.045
		&"bounce":
			cooldown = 0.035
		&"hit":
			cooldown = 0.025
		&"dash":
			cooldown = 0.08
		&"echo":
			cooldown = 0.08
		&"sync":
			cooldown = 0.1
		&"pickup":
			cooldown = 0.06
	return cooldown


func _build_cue_stream(kind: StringName) -> AudioStreamWAV:
	var duration := _cue_duration_for(kind)
	var frame_count := maxi(int(duration * CUE_RATE), 1)
	var data := PackedByteArray()
	data.resize(frame_count * 4)
	var offset := 0
	for frame_index in frame_count:
		var time := float(frame_index) / float(CUE_RATE)
		var sample := clampf(_cue_sample(kind, time, duration), -1.0, 1.0) * 0.38
		_write_i16(data, offset, sample)
		_write_i16(data, offset + 2, sample * 0.97)
		offset += 4
	var stream := AudioStreamWAV.new()
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate = CUE_RATE
	stream.stereo = true
	stream.data = data
	return stream


func _cue_sample(kind: StringName, time: float, duration: float) -> float:
	var progress := clampf(time / maxf(duration, 0.001), 0.0, 1.0)
	var sample := 0.0
	match kind:
		&"shot":
			var envelope := exp(-time * 34.0) * _envelope(time, duration, 0.002, 0.055)
			var chirp := lerpf(1180.0, 560.0, progress)
			sample = (
				envelope * (sin(TAU * chirp * time) * 0.78 + sin(TAU * 2.01 * chirp * time) * 0.12)
			)
		&"bounce":
			var envelope := _envelope(time, duration, 0.008, 0.1)
			var frequency := lerpf(240.0, 470.0, progress)
			sample = (
				envelope
				* (sin(TAU * frequency * time) * 0.7 + sin(TAU * frequency * 2.0 * time) * 0.18)
			)
		&"hit":
			var envelope := _envelope(time, duration, 0.003, 0.09)
			var thump := exp(-time * 24.0) * sin(TAU * 128.0 * time) * 0.75
			var crack := sin(TAU * 740.0 * time) * exp(-time * 48.0) * 0.24
			sample = envelope * (thump + crack)
		&"kill":
			sample = (
				_note(time, duration, 430.0, 0.0)
				+ _note(time, duration, 650.0, 0.12)
				+ _note(time, duration, 920.0, 0.24)
			)
		&"dash":
			var envelope := _envelope(time, duration, 0.015, 0.13)
			var frequency := lerpf(160.0, 1120.0, progress * progress)
			var shimmer := sin(TAU * frequency * 1.47 * time + 0.7) * 0.18
			sample = envelope * (sin(TAU * frequency * time) * 0.56 + shimmer)
		&"echo":
			var envelope := _envelope(time, duration, 0.01, 0.19)
			var frequency := lerpf(86.0, 180.0, progress)
			var overtone := sin(TAU * frequency * 2.03 * time + 0.2) * 0.22
			sample = envelope * (sin(TAU * frequency * time) * 0.72 + overtone)
		&"sync":
			var envelope := _envelope(time, duration, 0.004, 0.2)
			var thump := exp(-time * 12.0) * sin(TAU * 104.0 * time) * 0.82
			var impact := sin(TAU * 238.0 * time + 0.4) * exp(-time * 18.0) * 0.3
			sample = envelope * (thump + impact)
		&"spawn":
			sample = _note(time, duration, 420.0, 0.0) + _note(time, duration, 680.0, 0.1)
		&"upgrade":
			sample = (
				_note(time, duration, 520.0, 0.0)
				+ _note(time, duration, 760.0, 0.15)
				+ _note(time, duration, 1020.0, 0.3)
			)
		&"pickup":
			sample = _note(time, duration, 690.0, 0.0) + _note(time, duration, 910.0, 0.12)
		&"click":
			var envelope := exp(-time * 58.0) * _envelope(time, duration, 0.001, 0.035)
			sample = envelope * sin(TAU * 920.0 * time)
		&"game_over":
			sample = (
				_note(time, duration, 520.0, 0.0)
				+ _note(time, duration, 390.0, 0.2)
				+ _note(time, duration, 260.0, 0.4)
			)
	return sample


func _note(time: float, duration: float, frequency: float, start: float) -> float:
	var note_duration := minf(0.22, duration - start)
	var local_time := time - start
	if note_duration <= 0.0 or local_time < 0.0 or local_time >= note_duration:
		return 0.0
	var envelope := _envelope(local_time, note_duration, 0.008, 0.08)
	return (
		envelope
		* (sin(TAU * frequency * local_time) * 0.62 + sin(TAU * frequency * 2.0 * local_time) * 0.1)
	)


func _cue_duration_for(kind: StringName) -> float:
	var duration := 0.0
	match kind:
		&"shot":
			duration = 0.075
		&"bounce":
			duration = 0.23
		&"hit":
			duration = 0.17
		&"kill":
			duration = 0.52
		&"dash":
			duration = 0.27
		&"echo":
			duration = 0.38
		&"sync":
			duration = 0.64
		&"spawn":
			duration = 0.3
		&"upgrade":
			duration = 0.62
		&"pickup":
			duration = 0.34
		&"click":
			duration = 0.08
		&"game_over":
			duration = 0.72
	return duration


func _envelope(time: float, duration: float, attack: float, release: float) -> float:
	var attack_phase := clampf(time / maxf(attack, 0.001), 0.0, 1.0)
	var release_phase := clampf((duration - time) / maxf(release, 0.001), 0.0, 1.0)
	var attack_curve := attack_phase * attack_phase * (3.0 - 2.0 * attack_phase)
	var release_curve := release_phase * release_phase * (3.0 - 2.0 * release_phase)
	return attack_curve * release_curve


func _write_i16(data: PackedByteArray, offset: int, value: float) -> void:
	var signed_value := clampi(int(value * 32767.0), -32768, 32767)
	var unsigned_value := signed_value if signed_value >= 0 else signed_value + 65536
	data[offset] = unsigned_value & 0xff
	data[offset + 1] = (unsigned_value >> 8) & 0xff


func _is_headless_display() -> bool:
	return DisplayServer.get_name().to_lower() == "headless"


func _exit_tree() -> void:
	_audio_enabled = false
	for player in _cue_players:
		if is_instance_valid(player):
			player.stop()
			player.stream = null
			player.free()
	_cue_players.clear()
	_cue_streams.clear()
	_cue_cooldowns.clear()
