class_name SalvageAsteroid
extends StaticBody2D

var radius: float = 50.0
var rock_seed: int = 1

var _outline: PackedVector2Array = PackedVector2Array()
var _facet_colors: Array[Color] = []
var _crater_centers: Array[Vector2] = []
var _crater_radii: Array[float] = []
var _crater_angles: Array[float] = []
var _cracks: Array[PackedVector2Array] = []
var _collision_polygon: CollisionPolygon2D


func setup(size: float, seed: int) -> void:
	if is_finite(size) and size > 0.0:
		radius = size
	else:
		radius = 50.0
	rock_seed = seed
	if is_inside_tree():
		_build_geometry()
	queue_redraw()


func _ready() -> void:
	collision_layer = 4
	collision_mask = 3
	var material: PhysicsMaterial = PhysicsMaterial.new()
	material.friction = 0.82
	material.bounce = 0.14
	physics_material_override = material
	_build_geometry()
	queue_redraw()


func _build_geometry() -> void:
	_generate_surface_data()
	_collision_polygon = _find_or_create_collision_polygon()
	_collision_polygon.build_mode = CollisionPolygon2D.BUILD_SOLIDS
	_collision_polygon.polygon = _outline


func _find_or_create_collision_polygon() -> CollisionPolygon2D:
	for child: Node in get_children():
		if child is CollisionPolygon2D:
			return child as CollisionPolygon2D
	var collision: CollisionPolygon2D = CollisionPolygon2D.new()
	collision.name = "RockCollision"
	add_child(collision)
	return collision


func _generate_surface_data() -> void:
	_outline = PackedVector2Array()
	_facet_colors.clear()
	_crater_centers.clear()
	_crater_radii.clear()
	_crater_angles.clear()
	_cracks.clear()
	var generator: RandomNumberGenerator = RandomNumberGenerator.new()
	generator.seed = rock_seed
	var point_count: int = 12 + posmod(rock_seed, 5)
	for index: int in range(point_count):
		var progress: float = float(index) / float(point_count)
		var angle: float = progress * TAU + generator.randf_range(-0.075, 0.075)
		var scale: float = generator.randf_range(0.84, 1.14)
		_outline.append(Vector2(cos(angle), sin(angle)) * radius * scale)
		_facet_colors.append(_facet_color(generator, index))

	var crater_count: int = 3 + posmod(rock_seed, 3)
	for _index: int in range(crater_count):
		var angle: float = generator.randf_range(0.0, TAU)
		var distance: float = generator.randf_range(radius * 0.12, radius * 0.56)
		_crater_centers.append(Vector2(cos(angle), sin(angle)) * distance)
		_crater_radii.append(generator.randf_range(radius * 0.075, radius * 0.17))
		_crater_angles.append(generator.randf_range(0.0, TAU))

	var crack_count: int = 2 + posmod(rock_seed, 2)
	for _index: int in range(crack_count):
		var crack: PackedVector2Array = PackedVector2Array()
		var direction_angle: float = generator.randf_range(0.0, TAU)
		var direction: Vector2 = Vector2(cos(direction_angle), sin(direction_angle))
		var normal: Vector2 = Vector2(-direction.y, direction.x)
		var start: Vector2 = direction * generator.randf_range(radius * 0.08, radius * 0.32)
		crack.append(start)
		for segment: int in range(1, 4):
			var along: float = radius * 0.13 * float(segment)
			var offset: float = generator.randf_range(-radius * 0.12, radius * 0.12)
			crack.append(start + direction * along + normal * offset)
		_cracks.append(crack)


func _facet_color(generator: RandomNumberGenerator, index: int) -> Color:
	var palette: Array[Color] = [
		Color(0.22, 0.26, 0.28),
		Color(0.29, 0.31, 0.31),
		Color(0.34, 0.35, 0.33),
		Color(0.18, 0.22, 0.25),
	]
	var palette_index: int = posmod(index + generator.randi_range(0, 3), palette.size())
	return palette[palette_index]


func _draw() -> void:
	if _outline.size() < 3:
		return
	var shadow: PackedVector2Array = _scaled_polygon(_outline, 1.05, Vector2(2.0, 3.0))
	draw_colored_polygon(shadow, Color(0.015, 0.025, 0.032, 0.78))
	draw_colored_polygon(_outline, Color(0.25, 0.28, 0.29, 1.0))
	var center: Vector2 = Vector2.ZERO
	for index: int in range(_outline.size()):
		var next_index: int = (index + 1) % _outline.size()
		var facet: PackedVector2Array = PackedVector2Array(
			[center, _outline[index], _outline[next_index]]
		)
		draw_colored_polygon(facet, _facet_colors[index])

	for index: int in range(_crater_centers.size()):
		var crater_center: Vector2 = _crater_centers[index]
		var crater_radius: float = _crater_radii[index]
		var crater_angle: float = _crater_angles[index]
		var shade: Color = Color(0.08, 0.11, 0.13, 0.7)
		draw_circle(crater_center + Vector2(1.2, 1.8), crater_radius, Color(0.08, 0.1, 0.11, 0.55))
		draw_circle(crater_center, crater_radius * 0.82, shade)
		draw_arc(
			crater_center,
			crater_radius * 0.92,
			crater_angle + 0.35,
			crater_angle + PI * 1.35,
			14,
			Color(0.47, 0.48, 0.44, 0.72),
			1.5,
			true
		)
		draw_arc(
			crater_center,
			crater_radius * 0.72,
			crater_angle + PI + 0.2,
			crater_angle + TAU - 0.4,
			10,
			Color(0.14, 0.17, 0.18, 0.8),
			1.2,
			true
		)

	for crack: PackedVector2Array in _cracks:
		draw_polyline(crack, Color(0.045, 0.06, 0.07, 0.9), 2.0, true)
		if crack.size() >= 2:
			draw_line(
				crack[0] - Vector2(0.0, 1.0),
				crack[1] - Vector2(0.0, 1.0),
				Color(0.48, 0.5, 0.46, 0.38),
				0.8,
				true
			)

	draw_polyline(_closed_polygon(_outline), Color(0.05, 0.07, 0.08, 1.0), 2.3, true)
	var highlight: Color = Color(0.7, 0.69, 0.61, 0.75)
	for index: int in range(0, _outline.size(), 3):
		var point: Vector2 = _outline[index]
		draw_circle(point * 0.88, maxf(radius * 0.018, 0.8), highlight)


func _scaled_polygon(
	polygon: PackedVector2Array, scale: float, offset: Vector2
) -> PackedVector2Array:
	var result: PackedVector2Array = PackedVector2Array()
	for point: Vector2 in polygon:
		result.append(point * scale + offset)
	return result


func _closed_polygon(polygon: PackedVector2Array) -> PackedVector2Array:
	var result: PackedVector2Array = PackedVector2Array()
	for point: Vector2 in polygon:
		result.append(point)
	if not polygon.is_empty():
		result.append(polygon[0])
	return result
