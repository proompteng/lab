class_name SalvageTether
extends Node2D

signal snapped

const MAX_ATTACH_DISTANCE: float = 190.0
const MAX_SEPARATION: float = 300.0
const MAX_TETHER_FORCE: float = 2600.0
const SPRING_STIFFNESS: float = 16.0
const RADIAL_DAMPING: float = 8.0
const DEFAULT_REST_LENGTH: float = 110.0
const MIN_REST_LENGTH: float = 8.0
const CABLE_SEGMENTS: int = 12
const TUG_HITCH_OFFSET: Vector2 = Vector2(-20.0, 0.0)

var tug: SalvageTug
var cargo: SalvageCargo
var tension: float = 0.0
var rest_length: float = DEFAULT_REST_LENGTH

var _snapped_emitted: bool = false


func _ready() -> void:
	position = Vector2.ZERO
	queue_redraw()


func attach(new_tug: SalvageTug, new_cargo: SalvageCargo) -> bool:
	if is_attached():
		return false
	if tug != null or cargo != null:
		_detach()
	if not is_instance_valid(new_tug) or not is_instance_valid(new_cargo):
		return false
	if new_cargo.delivered or new_cargo.tethered:
		return false
	var separation_vector: Vector2 = new_cargo.global_position - new_tug.global_position
	if not _finite_vector(separation_vector):
		return false
	var separation: float = separation_vector.length()
	if not is_finite(separation) or separation > MAX_ATTACH_DISTANCE:
		return false
	if not is_finite(rest_length) or rest_length < MIN_REST_LENGTH:
		rest_length = maxf(separation, MIN_REST_LENGTH)
	rest_length = minf(rest_length, MAX_SEPARATION - MIN_REST_LENGTH)
	tug = new_tug
	cargo = new_cargo
	cargo.tethered = true
	tension = 0.0
	_snapped_emitted = false
	queue_redraw()
	return true


func release() -> void:
	_detach()
	_snapped_emitted = false


func is_attached() -> bool:
	if not is_instance_valid(tug) or not is_instance_valid(cargo):
		if tug != null or cargo != null:
			_detach()
		return false
	if cargo.delivered:
		_detach()
		return false
	return true


func _physics_process(_delta: float) -> void:
	if not is_attached():
		if tug != null or cargo != null:
			_detach()
	else:
		_simulate_link()
	queue_redraw()


func _simulate_link() -> void:
	var hitch_offset: Vector2 = TUG_HITCH_OFFSET.rotated(tug.rotation)
	var tug_position: Vector2 = tug.global_position + hitch_offset
	var cargo_position: Vector2 = cargo.global_position
	var separation_vector: Vector2 = cargo_position - tug_position
	if not _finite_vector(tug_position) or not _finite_vector(cargo_position):
		_detach()
		return
	var separation: float = separation_vector.length()
	if not is_finite(separation):
		_detach()
		return
	if separation > MAX_SEPARATION:
		_snap()
		return
	if not is_finite(rest_length) or rest_length < MIN_REST_LENGTH:
		rest_length = clampf(separation, MIN_REST_LENGTH, MAX_SEPARATION - MIN_REST_LENGTH)
	var extension: float = separation - rest_length
	var tension_span: float = maxf(MAX_SEPARATION - rest_length, MIN_REST_LENGTH)
	tension = clampf(maxf(extension, 0.0) / tension_span, 0.0, 1.0)
	# Slack cables cannot push; damping applies only once the cable is stretched.
	if extension <= 0.0 or separation <= 0.001:
		return
	_apply_spring_force(separation_vector / separation, extension, hitch_offset)


func _apply_spring_force(direction: Vector2, extension: float, hitch_offset: Vector2) -> void:
	var hitch_velocity: Vector2 = (
		tug.linear_velocity + Vector2(-hitch_offset.y, hitch_offset.x) * tug.angular_velocity
	)
	if not _finite_vector(hitch_velocity) or not _finite_vector(cargo.linear_velocity):
		_detach()
		return
	var radial_velocity: float = (cargo.linear_velocity - hitch_velocity).dot(direction)
	var magnitude: float = maxf(
		extension * SPRING_STIFFNESS + radial_velocity * RADIAL_DAMPING, 0.0
	)
	if not is_finite(radial_velocity) or not is_finite(magnitude):
		_detach()
		return
	if magnitude > MAX_TETHER_FORCE:
		_snap()
		return
	var force: Vector2 = direction * magnitude
	if not _finite_vector(force):
		_detach()
		return
	# apply_force takes an offset from the body origin, expressed in global axes.
	tug.apply_force(force, hitch_offset)
	cargo.apply_central_force(-force)


func _detach() -> void:
	if is_instance_valid(cargo):
		cargo.tethered = false
	tug = null
	cargo = null
	tension = 0.0
	queue_redraw()


func _snap() -> void:
	if _snapped_emitted:
		return
	_snapped_emitted = true
	tension = 1.0
	_detach()
	emit_signal("snapped")


func _finite_vector(value: Vector2) -> bool:
	return is_finite(value.x) and is_finite(value.y)


func _draw() -> void:
	if not is_attached():
		return
	var start: Vector2 = to_local(tug.global_position + TUG_HITCH_OFFSET.rotated(tug.rotation))
	var end: Vector2 = to_local(cargo.global_position)
	var delta: Vector2 = end - start
	if not _finite_vector(start) or not _finite_vector(end) or not _finite_vector(delta):
		return
	var distance: float = delta.length()
	if distance <= 0.001 or not is_finite(distance):
		return
	var perpendicular: Vector2 = Vector2(-delta.y, delta.x) / distance
	var sag_amount: float = clampf(distance * 0.075 * (1.0 - tension), 0.0, 20.0)
	var outer_color: Color = Color(0.05, 0.08, 0.09, 0.88)
	var cable_color: Color = Color(0.72, 0.82, 0.8, 0.94)
	var strain_color: Color = Color(1.0, 0.57, 0.13, 0.98)
	var points: PackedVector2Array = PackedVector2Array()
	for index: int in range(CABLE_SEGMENTS + 1):
		var progress: float = float(index) / float(CABLE_SEGMENTS)
		var sag: float = sin(progress * PI) * sag_amount
		points.append(start.lerp(end, progress) + perpendicular * sag)
	for index: int in range(CABLE_SEGMENTS):
		var first: Vector2 = points[index]
		var second: Vector2 = points[index + 1]
		draw_line(first, second, outer_color, 4.2, true)
		var segment_color: Color = strain_color if tension > 0.64 else cable_color
		if tension <= 0.64 and index % 2 == 1:
			segment_color = Color(0.49, 0.61, 0.61, 0.94)
		draw_line(first, second, segment_color, 2.0, true)
	draw_circle(start, 3.0, strain_color if tension > 0.64 else cable_color)
	draw_circle(end, 3.0, strain_color if tension > 0.64 else cable_color)
