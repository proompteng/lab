class_name SalvageCargo
extends RigidBody2D

var cargo_id: int = 0
var credits: int = 150
var label: String = "ALLOY CRATE"
var radius: float = 23.0
var delivered: bool = false:
	set(value):
		delivered = value
		if is_inside_tree():
			collision_layer = 0 if delivered else 2
			collision_mask = 0 if delivered else 7
			queue_redraw()
var accent: Color = Color(0.94, 0.52, 0.17)
var tethered: bool = false

var _configured_mass: float = 3.0
var _collision: CollisionShape2D


func setup(id: int, value: int, cargo_mass: float, title: String, color: Color) -> void:
	cargo_id = id
	credits = maxi(value, 0)
	if is_finite(cargo_mass):
		_configured_mass = clampf(cargo_mass, 1.5, 7.0)
	else:
		_configured_mass = 3.0
	label = title if not title.strip_edges().is_empty() else "ALLOY CRATE"
	accent = color
	radius = clampf(16.0 + sqrt(_configured_mass) * 4.0, 20.0, 32.0)
	if is_inside_tree():
		_apply_physics()
	queue_redraw()


func _ready() -> void:
	_apply_physics()
	queue_redraw()


func _apply_physics() -> void:
	mass = clampf(_configured_mass, 1.5, 7.0)
	gravity_scale = 0.0
	linear_damp = 0.06
	angular_damp = 0.35
	collision_layer = 0 if delivered else 2
	collision_mask = 0 if delivered else 7
	continuous_cd = RigidBody2D.CCD_MODE_CAST_SHAPE
	_collision = _find_or_create_collision_shape()
	var circle: CircleShape2D = CircleShape2D.new()
	circle.radius = maxf(radius * 0.84, 8.0)
	_collision.shape = circle


func _find_or_create_collision_shape() -> CollisionShape2D:
	for child: Node in get_children():
		if child is CollisionShape2D:
			return child as CollisionShape2D
	var collision: CollisionShape2D = CollisionShape2D.new()
	collision.name = "CargoCollision"
	add_child(collision)
	return collision


func _draw() -> void:
	var opacity: float = 0.48 if delivered else 1.0
	var base: Color = Color(0.12, 0.15, 0.17, opacity)
	var shell: Color = Color(0.5, 0.53, 0.52, opacity)
	var bright_accent: Color = Color(accent.r, accent.g, accent.b, opacity)
	var dark_accent: Color = Color(accent.r * 0.62, accent.g * 0.62, accent.b * 0.62, opacity)
	var outline: Color = Color(0.04, 0.06, 0.07, opacity)
	var scale_factor: float = radius / 23.0
	var shadow_radius: float = radius * 0.96
	draw_circle(Vector2(1.5, 2.5), shadow_radius, Color(0.01, 0.02, 0.025, 0.6 * opacity))

	match posmod(cargo_id, 3):
		0:
			_draw_crate(scale_factor, base, shell, bright_accent, dark_accent, outline)
		1:
			_draw_reactor(scale_factor, shell, bright_accent, dark_accent, outline)
		_:
			_draw_machine(scale_factor, base, shell, bright_accent, dark_accent, outline)

	if tethered:
		draw_arc(
			Vector2.ZERO, radius * 0.94, 0.0, TAU, 32, Color(1.0, 0.77, 0.28, opacity), 1.4, true
		)
	if delivered:
		draw_line(
			Vector2(-radius * 0.52, -radius * 0.52),
			Vector2(radius * 0.52, radius * 0.52),
			Color(0.8, 0.9, 0.86, 0.8),
			1.8,
			true
		)
		draw_line(
			Vector2(radius * 0.52, -radius * 0.52),
			Vector2(-radius * 0.52, radius * 0.52),
			Color(0.8, 0.9, 0.86, 0.8),
			1.8,
			true
		)


func _draw_crate(
	scale_factor: float,
	base: Color,
	shell: Color,
	bright_accent: Color,
	dark_accent: Color,
	outline: Color
) -> void:
	var half_width: float = 16.0 * scale_factor
	var half_height: float = 13.0 * scale_factor
	var chamfer: float = 4.0 * scale_factor
	var body: PackedVector2Array = PackedVector2Array(
		[
			Vector2(-half_width + chamfer, -half_height),
			Vector2(half_width - chamfer, -half_height),
			Vector2(half_width, -half_height + chamfer),
			Vector2(half_width, half_height - chamfer),
			Vector2(half_width - chamfer, half_height),
			Vector2(-half_width + chamfer, half_height),
			Vector2(-half_width, half_height - chamfer),
			Vector2(-half_width, -half_height + chamfer),
		]
	)
	draw_colored_polygon(body, shell)
	draw_polyline(_closed_polygon(body), outline, 1.6, true)
	draw_rect(
		Rect2(
			-half_width + 3.0 * scale_factor,
			-3.0 * scale_factor,
			(half_width * 2.0) - 6.0 * scale_factor,
			6.0 * scale_factor
		),
		base,
		true
	)
	draw_line(
		Vector2(-half_width + 2.0 * scale_factor, -half_height + 3.0 * scale_factor),
		Vector2(half_width - 2.0 * scale_factor, -half_height + 3.0 * scale_factor),
		bright_accent,
		2.2 * scale_factor,
		true
	)
	draw_line(
		Vector2(-half_width + 2.0 * scale_factor, half_height - 3.0 * scale_factor),
		Vector2(half_width - 2.0 * scale_factor, half_height - 3.0 * scale_factor),
		dark_accent,
		2.2 * scale_factor,
		true
	)
	for index: int in range(3):
		var stripe_x: float = (-8.0 + float(index) * 6.0) * scale_factor
		draw_line(
			Vector2(stripe_x - 3.0 * scale_factor, -3.5 * scale_factor),
			Vector2(stripe_x + 1.0 * scale_factor, 3.5 * scale_factor),
			bright_accent,
			1.7 * scale_factor,
			true
		)
	draw_circle(
		Vector2(-half_width + 4.0 * scale_factor, -half_height + 4.0 * scale_factor),
		1.7 * scale_factor,
		bright_accent
	)
	draw_circle(
		Vector2(half_width - 4.0 * scale_factor, half_height - 4.0 * scale_factor),
		1.7 * scale_factor,
		bright_accent
	)
	draw_rect(
		Rect2(-4.0 * scale_factor, -8.0 * scale_factor, 8.0 * scale_factor, 4.0 * scale_factor),
		Color(0.07, 0.21, 0.22, shell.a),
		true
	)


func _draw_reactor(
	scale_factor: float, shell: Color, bright_accent: Color, dark_accent: Color, outline: Color
) -> void:
	var outer_radius: float = 15.0 * scale_factor
	draw_circle(Vector2.ZERO, outer_radius, dark_accent)
	draw_arc(Vector2.ZERO, outer_radius, 0.0, TAU, 36, outline, 2.0, true)
	draw_arc(Vector2.ZERO, outer_radius * 0.76, 0.0, TAU, 36, shell, 3.2, true)
	draw_circle(Vector2.ZERO, outer_radius * 0.5, Color(0.07, 0.24, 0.25, bright_accent.a))
	draw_circle(Vector2.ZERO, outer_radius * 0.28, bright_accent)
	for index: int in range(6):
		var angle: float = TAU * float(index) / 6.0
		var radial: Vector2 = Vector2(cos(angle), sin(angle))
		draw_line(
			radial * outer_radius * 0.72,
			radial * outer_radius * 1.07,
			shell,
			2.0 * scale_factor,
			true
		)
		draw_circle(radial * outer_radius * 1.12, 1.8 * scale_factor, bright_accent)
	draw_line(
		Vector2(-outer_radius * 0.92, outer_radius * 0.78),
		Vector2(outer_radius * 0.92, outer_radius * 0.78),
		outline,
		1.5,
		true
	)
	draw_line(
		Vector2(-outer_radius * 0.92, -outer_radius * 0.78),
		Vector2(outer_radius * 0.92, -outer_radius * 0.78),
		outline,
		1.5,
		true
	)


func _draw_machine(
	scale_factor: float,
	base: Color,
	shell: Color,
	bright_accent: Color,
	dark_accent: Color,
	outline: Color
) -> void:
	var width: float = 17.0 * scale_factor
	var height: float = 12.0 * scale_factor
	draw_colored_polygon(
		PackedVector2Array(
			[
				Vector2(-width, -height * 0.55),
				Vector2(-width * 0.65, -height),
				Vector2(width * 0.72, -height),
				Vector2(width, -height * 0.45),
				Vector2(width, height * 0.62),
				Vector2(width * 0.4, height),
				Vector2(-width * 0.82, height),
				Vector2(-width, height * 0.45),
			]
		),
		shell
	)
	draw_polyline(
		PackedVector2Array(
			[
				Vector2(-width, -height * 0.55),
				Vector2(-width * 0.65, -height),
				Vector2(width * 0.72, -height),
				Vector2(width, -height * 0.45),
				Vector2(width, height * 0.62),
				Vector2(width * 0.4, height),
				Vector2(-width * 0.82, height),
				Vector2(-width, height * 0.45),
				Vector2(-width, -height * 0.55),
			]
		),
		outline,
		1.6,
		true
	)
	draw_rect(Rect2(-width * 0.6, -height * 0.45, width * 1.15, height * 0.85), base, true)
	draw_rect(Rect2(-width * 0.54, -height * 0.35, width * 0.44, height * 0.62), dark_accent, true)
	draw_rect(
		Rect2(width * 0.02, -height * 0.35, width * 0.47, height * 0.62),
		Color(0.08, 0.22, 0.23, bright_accent.a),
		true
	)
	draw_line(
		Vector2(-width * 0.52, -height * 0.18),
		Vector2(width * 0.47, -height * 0.18),
		bright_accent,
		1.8 * scale_factor,
		true
	)
	draw_line(
		Vector2(-width * 0.5, height * 0.18),
		Vector2(width * 0.47, height * 0.18),
		bright_accent,
		1.8 * scale_factor,
		true
	)
	for index: int in range(4):
		var x: float = -width * 0.77 + float(index) * width * 0.5
		draw_circle(Vector2(x, height * 0.74), 1.7 * scale_factor, bright_accent)
	draw_line(
		Vector2(-width * 0.9, -height * 1.13),
		Vector2(-width * 0.42, -height * 1.13),
		bright_accent,
		2.0 * scale_factor,
		true
	)
	draw_line(
		Vector2(-width * 0.68, -height * 1.13),
		Vector2(-width * 0.68, -height * 0.86),
		shell,
		1.6 * scale_factor,
		true
	)


func _closed_polygon(polygon: PackedVector2Array) -> PackedVector2Array:
	var closed: PackedVector2Array = PackedVector2Array()
	for point: Vector2 in polygon:
		closed.append(point)
	if not polygon.is_empty():
		closed.append(polygon[0])
	return closed
