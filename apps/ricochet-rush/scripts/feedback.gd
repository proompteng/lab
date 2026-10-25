class_name RushFeedback
extends Node3D

## Small, pooled 3D feedback pass for the arcade arena.
##
## Effects are line geometry in local arena meters. Keeping the effect nodes
## under this world child means a reset drops the complete pool with the world
## and cannot leave references to actors from the previous run.

const MAX_EFFECTS: int = 20
const RING_SEGMENTS: int = 24
const SPARK_COUNT: int = 8

const WARM_WHITE := Color("fff7e8")
const AMBER := Color("e5a34d")
const CYAN := Color("62e8f4")

var _player: Node3D
var _effect_nodes: Array[MeshInstance3D] = []
var _effect_meshes: Array[ImmediateMesh] = []
var _effect_materials: Array[StandardMaterial3D] = []
var _effect_active: Array[bool] = []
var _effect_kind: Array[StringName] = []
var _effect_position: Array[Vector3] = []
var _effect_age: Array[float] = []
var _effect_duration: Array[float] = []
var _effect_strength: Array[float] = []
var _effect_seed: Array[int] = []
var _slot_cursor: int = 0
var _event_sequence: int = 0


func _ready() -> void:
	# Effects are presentation only, so their brief tails can finish while the
	# arena is paused. They never read or write simulation state beyond position.
	process_mode = Node.PROCESS_MODE_ALWAYS
	_effect_nodes.resize(MAX_EFFECTS)
	_effect_meshes.resize(MAX_EFFECTS)
	_effect_materials.resize(MAX_EFFECTS)
	_effect_active.resize(MAX_EFFECTS)
	_effect_kind.resize(MAX_EFFECTS)
	_effect_position.resize(MAX_EFFECTS)
	_effect_age.resize(MAX_EFFECTS)
	_effect_duration.resize(MAX_EFFECTS)
	_effect_strength.resize(MAX_EFFECTS)
	_effect_seed.resize(MAX_EFFECTS)
	for index in MAX_EFFECTS:
		_create_effect_slot(index)


func bind_player(value: RushPlayer) -> void:
	if _player != value:
		_clear_effects()
	_player = null
	if is_instance_valid(value):
		_player = value


func play_event(kind: StringName, at: Vector3, value: int = 0) -> void:
	if _effect_nodes.size() != MAX_EFFECTS or not _finite_vector(at):
		return
	var event_kind := StringName(String(kind).strip_edges().to_lower())
	if _effect_duration_for(event_kind) <= 0.0:
		return
	var slot := _take_effect_slot()
	_effect_active[slot] = true
	_effect_kind[slot] = event_kind
	_effect_position[slot] = at
	_effect_age[slot] = 0.0
	_effect_duration[slot] = _effect_duration_for(event_kind)
	_effect_strength[slot] = clampf(1.0 + minf(absf(float(value)), 8.0) * 0.08, 0.9, 1.65)
	var location_seed := int(clampf(absf(at.x + at.z), 0.0, 100000.0) * 3.0)
	_effect_seed[slot] = _event_sequence * 97 + slot * 19 + location_seed
	_event_sequence = posmod(_event_sequence + 1, 1000000)
	_effect_nodes[slot].position = at
	_effect_nodes[slot].visible = true
	_update_effect_geometry(slot)


func _process(delta: float) -> void:
	if _player != null and not is_instance_valid(_player):
		_player = null
	var step := clampf(delta, 0.0, 0.1)
	for index in MAX_EFFECTS:
		if not _effect_active[index]:
			continue
		_effect_age[index] += step
		if _effect_age[index] >= _effect_duration[index]:
			_release_effect_slot(index)
		else:
			_update_effect_geometry(index)


func _create_effect_slot(index: int) -> void:
	var node := MeshInstance3D.new()
	node.name = "Effect%02d" % index
	node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	node.visible = false
	var mesh := ImmediateMesh.new()
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	material.albedo_color = Color(1.0, 1.0, 1.0, 0.0)
	node.mesh = mesh
	node.material_override = material
	add_child(node)
	_effect_nodes[index] = node
	_effect_meshes[index] = mesh
	_effect_materials[index] = material
	_effect_active[index] = false


func _take_effect_slot() -> int:
	for offset in MAX_EFFECTS:
		var candidate := posmod(_slot_cursor + offset, MAX_EFFECTS)
		if not _effect_active[candidate]:
			_slot_cursor = posmod(candidate + 1, MAX_EFFECTS)
			return candidate
	var replacement := _slot_cursor
	var oldest_age := -1.0
	for offset in MAX_EFFECTS:
		var candidate := posmod(_slot_cursor + offset, MAX_EFFECTS)
		if _effect_age[candidate] > oldest_age:
			oldest_age = _effect_age[candidate]
			replacement = candidate
	_slot_cursor = posmod(replacement + 1, MAX_EFFECTS)
	return replacement


func _release_effect_slot(index: int) -> void:
	_effect_active[index] = false
	_effect_nodes[index].visible = false
	_effect_meshes[index].clear_surfaces()


func _clear_effects() -> void:
	if _effect_active.size() != MAX_EFFECTS:
		return
	for index in MAX_EFFECTS:
		if _effect_active[index]:
			_release_effect_slot(index)


func _update_effect_geometry(index: int) -> void:
	var duration: float = maxf(_effect_duration[index], 0.001)
	var progress := clampf(_effect_age[index] / duration, 0.0, 1.0)
	var kind: StringName = _effect_kind[index]
	var material := _effect_materials[index]
	var color := _effect_color_for(kind)
	material.albedo_color = _with_alpha(color, _effect_alpha_for(kind, progress))
	var mesh := _effect_meshes[index]
	mesh.clear_surfaces()
	mesh.surface_begin(Mesh.PRIMITIVE_LINES, material)
	match kind:
		&"shot":
			_draw_shot(mesh, progress, _effect_seed[index])
		&"bounce":
			_draw_bounce(mesh, progress, _effect_seed[index])
		&"hit":
			_draw_hit(mesh, progress, _effect_seed[index])
		&"kill":
			_draw_kill(mesh, progress, _effect_seed[index], _effect_strength[index])
		&"dash":
			_draw_dash(mesh, progress, _effect_seed[index])
		&"echo":
			_draw_echo(mesh, progress, _effect_seed[index])
		&"sync":
			_draw_sync(mesh, progress, _effect_seed[index], _effect_strength[index])
		&"spawn":
			_draw_spawn(mesh, progress, _effect_seed[index])
		&"pickup":
			_draw_pickup(mesh, progress, _effect_seed[index])
	mesh.surface_end()


func _draw_shot(mesh: ImmediateMesh, progress: float, seed: int) -> void:
	var length := lerpf(0.18, 0.68, progress)
	for ray in 4:
		var angle := TAU * _noise(seed + ray * 31)
		var direction := Vector3(cos(angle), 0.04 + _noise(seed + ray * 43) * 0.08, sin(angle))
		_emit_line(mesh, direction * 0.08, direction * length)


func _draw_bounce(mesh: ImmediateMesh, progress: float, seed: int) -> void:
	var eased := _ease_out(progress)
	_emit_ring(mesh, lerpf(0.18, 0.88, eased), 0.06, RING_SEGMENTS)
	_emit_ring(mesh, lerpf(0.1, 0.52, eased), 0.065, 18)
	_draw_sparks(mesh, seed, 5, lerpf(0.28, 0.72, eased), progress, 0.1)


func _draw_hit(mesh: ImmediateMesh, progress: float, seed: int) -> void:
	var eased := _ease_out(progress)
	_emit_ring(mesh, lerpf(0.12, 0.48, eased), 0.08, 18)
	_draw_sparks(mesh, seed, SPARK_COUNT, lerpf(0.22, 0.58, eased), progress, 0.12)


func _draw_kill(mesh: ImmediateMesh, progress: float, seed: int, strength: float) -> void:
	var eased := _ease_out(progress)
	var scale := clampf(strength, 0.9, 1.65)
	_emit_ring(mesh, lerpf(0.22, 1.12 * scale, eased), 0.07, RING_SEGMENTS)
	_emit_ring(mesh, lerpf(0.12, 0.66 * scale, eased), 0.075, 18)
	_draw_sparks(mesh, seed, 10, lerpf(0.34, 0.98 * scale, eased), progress, 0.14)


func _draw_dash(mesh: ImmediateMesh, progress: float, seed: int) -> void:
	var eased := _ease_out(progress)
	_emit_ring(mesh, lerpf(0.22, 0.72, eased), 0.06, 20)
	var trail_length := lerpf(0.32, 1.0, eased)
	_emit_line(mesh, Vector3(-0.12, 0.2, -0.12), Vector3(-trail_length, 0.2, -0.12))
	_emit_line(mesh, Vector3(0.12, 0.23, 0.12), Vector3(0.12, 0.23, trail_length))
	_draw_sparks(mesh, seed, 6, lerpf(0.42, 0.92, eased), progress, 0.18)


func _draw_echo(mesh: ImmediateMesh, progress: float, seed: int) -> void:
	var eased := _ease_out(progress)
	_emit_ring(mesh, lerpf(0.16, 0.86, eased), 0.08, RING_SEGMENTS)
	_emit_ring(mesh, lerpf(0.1, 0.46, eased), 0.085, 18)
	_draw_sparks(mesh, seed, 7, lerpf(0.25, 0.78, eased), progress, 0.22)


func _draw_sync(mesh: ImmediateMesh, progress: float, seed: int, strength: float) -> void:
	var eased := _ease_out(progress)
	var scale := clampf(strength, 0.9, 1.65)
	_emit_ring(mesh, lerpf(0.22, 1.24 * scale, eased), 0.1, RING_SEGMENTS)
	_emit_ring(mesh, lerpf(0.12, 0.72 * scale, eased), 0.105, 20)
	_draw_sparks(mesh, seed, 10, lerpf(0.32, 1.08 * scale, eased), progress, 0.24)


func _draw_spawn(mesh: ImmediateMesh, progress: float, seed: int) -> void:
	var eased := _ease_out(progress)
	_emit_ring(mesh, lerpf(0.12, 0.94, eased), 0.055, RING_SEGMENTS)
	_emit_ring(mesh, lerpf(0.08, 0.42, eased), 0.06, 16)
	_draw_sparks(mesh, seed, 6, lerpf(0.24, 0.68, eased), progress, 0.28)


func _draw_pickup(mesh: ImmediateMesh, progress: float, seed: int) -> void:
	var eased := _ease_out(progress)
	_emit_ring(mesh, lerpf(0.14, 0.7, eased), 0.08, 20)
	_draw_sparks(mesh, seed, 7, lerpf(0.3, 0.82, eased), progress, 0.22)


func _draw_sparks(
	mesh: ImmediateMesh, seed: int, count: int, length: float, progress: float, height: float
) -> void:
	var fade := 1.0 - _smoothstep(0.52, 1.0, progress)
	for ray in count:
		var angle := TAU * _noise(seed + ray * 29 + 7)
		var distance := 0.07 + _noise(seed + ray * 37 + 13) * 0.1
		var direction := Vector3(
			cos(angle), 0.04 + _noise(seed + ray * 47 + 23) * height, sin(angle)
		)
		_emit_line(mesh, direction * distance, direction * (distance + length * fade))


func _emit_ring(mesh: ImmediateMesh, radius: float, height: float, segments: int) -> void:
	var previous := Vector3(radius, height, 0.0)
	var segment_count := maxi(segments, 8)
	for segment in range(1, segment_count + 1):
		var angle := TAU * float(segment) / float(segment_count)
		var next := Vector3(cos(angle) * radius, height, sin(angle) * radius)
		_emit_line(mesh, previous, next)
		previous = next


func _emit_line(mesh: ImmediateMesh, from: Vector3, to: Vector3) -> void:
	mesh.surface_add_vertex(from)
	mesh.surface_add_vertex(to)


func _effect_duration_for(kind: StringName) -> float:
	var duration := 0.0
	match kind:
		&"shot":
			duration = 0.14
		&"bounce":
			duration = 0.32
		&"hit":
			duration = 0.24
		&"kill":
			duration = 0.56
		&"dash":
			duration = 0.28
		&"echo":
			duration = 0.38
		&"sync":
			duration = 0.64
		&"spawn":
			duration = 0.48
		&"pickup":
			duration = 0.38
	return duration


func _effect_color_for(kind: StringName) -> Color:
	var color := WARM_WHITE
	match kind:
		&"shot":
			color = WARM_WHITE
		&"bounce":
			color = AMBER
		&"hit":
			color = AMBER
		&"kill":
			color = WARM_WHITE
		&"dash":
			color = WARM_WHITE
		&"echo":
			color = CYAN
		&"sync":
			color = CYAN
		&"spawn":
			color = AMBER
		&"pickup":
			color = WARM_WHITE
	return color


func _effect_alpha_for(kind: StringName, progress: float) -> float:
	var fade := 1.0 - _smoothstep(0.48, 1.0, progress)
	match kind:
		&"shot":
			return 0.78 * fade
		&"hit":
			return 0.9 * fade
		&"kill":
			return 0.86 * fade
		&"echo":
			return 0.84 * fade
		&"sync":
			return 0.92 * fade
	return 0.72 * fade


func _ease_out(progress: float) -> float:
	var inverse := 1.0 - clampf(progress, 0.0, 1.0)
	return 1.0 - inverse * inverse


func _smoothstep(edge_a: float, edge_b: float, value: float) -> float:
	var progress := clampf((value - edge_a) / (edge_b - edge_a), 0.0, 1.0)
	return progress * progress * (3.0 - 2.0 * progress)


func _noise(seed: int) -> float:
	return absf(sin(float(seed) * 12.9898 + 78.233))


func _with_alpha(color: Color, alpha: float) -> Color:
	return Color(color.r, color.g, color.b, clampf(alpha, 0.0, 1.0))


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)


func _exit_tree() -> void:
	_player = null
	_effect_nodes.clear()
	_effect_meshes.clear()
	_effect_materials.clear()
	_effect_active.clear()
	_effect_kind.clear()
	_effect_position.clear()
	_effect_age.clear()
	_effect_duration.clear()
	_effect_strength.clear()
	_effect_seed.clear()
