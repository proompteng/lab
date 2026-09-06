class_name SalvageStarfield
extends Node2D

## A quiet, hand-built orbital backdrop. Everything is generated once from a
## fixed seed so a flight keeps the same landmarks without paying allocation
## costs every frame.

const BACKDROP := Color("#080f1b")
const WORLD_RECT := Rect2(-5200.0, -4200.0, 10400.0, 8400.0)
const FAR_EXTENT := 3200.0

var focus: Vector2 = Vector2.ZERO
var elapsed: float = 0.0

var _rng := RandomNumberGenerator.new()
var _far_stars: Array[Dictionary] = []
var _mid_stars: Array[Dictionary] = []
var _bright_stars: Array[Dictionary] = []
var _dust: Array[Dictionary] = []
var _clusters: Array[Dictionary] = []
var _nebulae: Array[Dictionary] = []


func _ready() -> void:
	z_index = -100
	_rng.seed = 0x4F52424954
	_build_nebulae()
	_build_stars()
	_build_dust()
	_build_clusters()
	queue_redraw()


func _process(delta: float) -> void:
	elapsed = fmod(elapsed + delta, 100000.0)
	queue_redraw()


func _draw() -> void:
	# This rectangle deliberately extends well beyond the playable flight box;
	# a Camera2D can never expose a clear edge while the tug crosses the map.
	draw_rect(WORLD_RECT, BACKDROP)
	_draw_nebulae()
	_draw_orbit_arcs()
	_draw_distant_planet()
	_draw_clusters()
	_draw_dust()
	_draw_stars(_far_stars, focus * 0.025, false)
	_draw_stars(_mid_stars, focus * 0.12, false)
	_draw_stars(_bright_stars, focus * 0.28, true)


func _build_nebulae() -> void:
	# A handful of large clouds provide orientation without turning the world
	# into a colorful gradient. The low alpha and layered blobs keep the navy
	# ground legible for cargo, rocks, and the tug silhouette.
	var cloud_specs := [
		[Vector2(-410.0, -220.0), 760.0, Color("#154353"), 1.45, 0.1],
		[Vector2(520.0, 470.0), 545.0, Color("#164653"), 1.25, -0.28],
		[Vector2(-1760.0, -1480.0), 460.0, Color("#1c5060"), 1.7, 0.35],
		[Vector2(-760.0, 1330.0), 620.0, Color("#13394b"), 1.25, -0.15],
		[Vector2(1070.0, -760.0), 510.0, Color("#1c4756"), 1.55, 0.25],
		[Vector2(1960.0, 1490.0), 360.0, Color("#15344d"), 1.15, -0.3],
		[Vector2(2170.0, -1940.0), 720.0, Color("#0f2d40"), 1.35, 0.45],
		[Vector2(-2260.0, 2050.0), 430.0, Color("#21434a"), 1.05, -0.2],
	]
	for spec in cloud_specs:
		(
			_nebulae
			. append(
				{
					"center": spec[0],
					"radius": spec[1],
					"color": spec[2],
					"stretch": spec[3],
					"rotation": spec[4],
				}
			)
		)


func _build_stars() -> void:
	for index in range(420):
		var tint := Color("#7f9aaa") if index % 5 != 0 else Color("#a6b9c0")
		(
			_far_stars
			. append(
				{
					"position": _random_world_position(),
					"radius": _rng.randf_range(0.35, 1.05),
					"alpha": _rng.randf_range(0.16, 0.42),
					"color": tint,
				}
			)
		)

	for index in range(118):
		var tint := Color("#a1bac2")
		if index % 9 == 0:
			tint = Color("#8ed7d1")
		elif index % 13 == 0:
			tint = Color("#d6b37c")
		(
			_mid_stars
			. append(
				{
					"position": _random_world_position(),
					"radius": _rng.randf_range(0.75, 1.65),
					"alpha": _rng.randf_range(0.3, 0.68),
					"color": tint,
				}
			)
		)

	for index in range(28):
		(
			_bright_stars
			. append(
				{
					"position": _random_world_position(),
					"radius": _rng.randf_range(1.35, 2.55),
					"alpha": _rng.randf_range(0.65, 0.92),
					"color": Color("#dce8de") if index % 4 != 0 else Color("#6fe2d1"),
					"phase": _rng.randf_range(0.0, TAU),
					"speed": _rng.randf_range(0.7, 1.7),
				}
			)
		)


func _build_dust() -> void:
	for index in range(145):
		(
			_dust
			. append(
				{
					"position": _random_world_position(),
					"angle": _rng.randf_range(0.0, TAU),
					"length": _rng.randf_range(3.0, 15.0),
					"alpha": _rng.randf_range(0.06, 0.18),
					"color": Color("#71909c") if index % 4 else Color("#5da9a0"),
				}
			)
		)
	# The near corridor gets a second pass of larger, still-muted particles so
	# the tug has a sense of speed around Kestrel without a noisy star curtain.
	for index in range(72):
		(
			_dust
			. append(
				{
					"position":
					Vector2(
						_rng.randf_range(-1750.0, 1750.0),
						_rng.randf_range(-1250.0, 1250.0),
					),
					"angle": _rng.randf_range(0.0, TAU),
					"length": _rng.randf_range(7.0, 22.0),
					"alpha": _rng.randf_range(0.09, 0.2),
					"color": Color("#5c8c9a") if index % 3 else Color("#5caaa0"),
				}
			)
		)


func _build_clusters() -> void:
	var cluster_centers := [
		Vector2(-2050.0, -420.0),
		Vector2(-1230.0, 720.0),
		Vector2(-120.0, -1740.0),
		Vector2(820.0, 1690.0),
		Vector2(1860.0, -270.0),
		Vector2(2260.0, 960.0),
	]
	for center in cluster_centers:
		var members: Array[Dictionary] = []
		for index in range(14):
			(
				members
				. append(
					{
						"position":
						(
							center
							+ Vector2(
								_rng.randf_range(-170.0, 170.0),
								_rng.randf_range(-105.0, 105.0),
							)
						),
						"radius": _rng.randf_range(0.45, 1.25),
						"alpha": _rng.randf_range(0.2, 0.5),
						"color": Color("#779da9") if index % 3 else Color("#82c5b9"),
					}
				)
			)
		(
			_clusters
			. append(
				{
					"center": center,
					"members": members,
				}
			)
		)


func _random_world_position() -> Vector2:
	return Vector2(
		_rng.randf_range(-FAR_EXTENT, FAR_EXTENT),
		_rng.randf_range(-FAR_EXTENT, FAR_EXTENT),
	)


func _draw_nebulae() -> void:
	for nebula in _nebulae:
		var center: Vector2 = nebula["center"] + focus * 0.025
		var base_radius: float = nebula["radius"]
		var color: Color = nebula["color"]
		var stretch: float = nebula["stretch"]
		var rotation: float = nebula["rotation"]
		for layer in range(5):
			var layer_fraction := float(layer) / 4.0
			var layer_angle := rotation + layer_fraction * 1.7
			var layer_pos := (
				center
				+ Vector2(cos(layer_angle), sin(layer_angle)) * base_radius * 0.13 * layer_fraction
			)
			var layer_radius := base_radius * (1.0 - layer_fraction * 0.16)
			var layer_color := _with_alpha(color, 0.026 + (1.0 - layer_fraction) * 0.018)
			draw_set_transform(layer_pos, rotation + layer_fraction * 0.15, Vector2(stretch, 1.0))
			draw_circle(Vector2.ZERO, layer_radius, layer_color)
			# Reset after every blob so later world-space geometry cannot inherit the
			# cloud's elongated transform.
			draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)


func _draw_orbit_arcs() -> void:
	var arc_color := Color("#3c8290")
	var arc_color_soft := Color("#255a6e")
	draw_arc(
		Vector2(-680.0, 320.0) + focus * 0.045,
		2050.0,
		-2.65,
		-0.18,
		160,
		_with_alpha(arc_color, 0.18),
		1.0,
		true
	)
	draw_arc(
		Vector2(-680.0, 320.0) + focus * 0.045,
		2064.0,
		0.36,
		1.52,
		100,
		_with_alpha(arc_color_soft, 0.16),
		1.0,
		true
	)
	draw_arc(
		Vector2(1150.0, -1050.0) + focus * 0.06,
		1480.0,
		1.82,
		4.92,
		160,
		_with_alpha(arc_color_soft, 0.2),
		1.0,
		true
	)
	draw_arc(
		Vector2(1150.0, -1050.0) + focus * 0.06,
		1491.0,
		2.15,
		3.08,
		72,
		_with_alpha(arc_color, 0.12),
		2.0,
		true
	)
	# Tiny broken navigation ticks make the huge arcs feel like old survey
	# hardware instead of decorative circles.
	for index in range(7):
		var angle := -2.45 + float(index) * 0.34
		var center := Vector2(-680.0, 320.0) + focus * 0.045 + Vector2.from_angle(angle) * 2050.0
		var tangent := Vector2.from_angle(angle + PI * 0.5) * 13.0
		draw_line(center - tangent, center + tangent, _with_alpha(arc_color, 0.3), 1.0, true)


func _draw_distant_planet() -> void:
	var planet_center := Vector2(1740.0, -1510.0) + focus * 0.035
	# A barely lit crescent sits behind the orbital arcs. The cutout matches the
	# backdrop so it reads as a crescent even where a cloud is not underneath.
	draw_circle(planet_center, 164.0, _with_alpha(Color("#183a4b"), 0.26))
	draw_circle(planet_center - Vector2(32.0, 12.0), 151.0, _with_alpha(Color("#080f1b"), 0.92))
	draw_arc(planet_center, 164.0, -2.28, 1.35, 72, _with_alpha(Color("#5a9a9e"), 0.32), 2.0, true)
	draw_arc(planet_center, 157.0, -2.22, 1.28, 64, _with_alpha(Color("#2e5f70"), 0.28), 1.0, true)
	draw_circle(planet_center + Vector2(-92.0, -74.0), 2.0, _with_alpha(Color("#d2c49b"), 0.55))


func _draw_clusters() -> void:
	for cluster in _clusters:
		var cluster_center: Vector2 = cluster["center"] + focus * 0.08
		draw_circle(cluster_center, 105.0, _with_alpha(Color("#153b49"), 0.012))
		var members: Array[Dictionary] = cluster["members"]
		for star in members:
			_draw_star(star, focus * 0.08, false)


func _draw_dust() -> void:
	for dust in _dust:
		var dust_position: Vector2 = dust["position"] + focus * 0.1
		var angle: float = dust["angle"]
		var direction: Vector2 = Vector2.from_angle(angle) * float(dust["length"])
		var color: Color = dust["color"]
		draw_line(
			dust_position,
			dust_position + direction,
			_with_alpha(color, dust["alpha"]),
			0.65,
			true,
		)


func _draw_stars(stars: Array[Dictionary], parallax: Vector2, twinkle: bool) -> void:
	for star in stars:
		_draw_star(star, parallax, twinkle)


func _draw_star(star: Dictionary, parallax: Vector2, twinkle: bool) -> void:
	var star_position: Vector2 = star["position"] + parallax
	var radius: float = star["radius"]
	var alpha: float = star["alpha"]
	if twinkle:
		var phase: float = star["phase"]
		var speed: float = star["speed"]
		alpha *= 0.72 + sin(elapsed * speed + phase) * 0.2
	var color: Color = star["color"]
	draw_circle(star_position, radius, _with_alpha(color, alpha))
	if twinkle:
		var flare_alpha := clampf(alpha * 0.32, 0.0, 0.34)
		var flare := _with_alpha(color, flare_alpha)
		draw_line(
			star_position - Vector2(radius * 2.8, 0.0),
			star_position + Vector2(radius * 2.8, 0.0),
			flare,
			0.6,
			true
		)
		draw_line(
			star_position - Vector2(0.0, radius * 2.8),
			star_position + Vector2(0.0, radius * 2.8),
			flare,
			0.6,
			true
		)


func _with_alpha(color: Color, alpha: float) -> Color:
	var result := color
	result.a = clampf(alpha, 0.0, 1.0)
	return result
