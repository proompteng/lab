class_name SalvageStation
extends Node2D

const DOCK_RADIUS: float = 145.0

const HULL_SHADOW := Color("#060b13")
const HULL_DEEP := Color("#0a1722")
const HULL := Color("#132633")
const HULL_LIGHT := Color("#28424d")
const HULL_EDGE := Color("#54717a")
const TEAL := Color("#61e2d1")
const TEAL_MID := Color("#2ca6a1")
const TEAL_DEEP := Color("#1a5965")
const AMBER := Color("#f0a052")
const AMBER_BRIGHT := Color("#ffd18a")
const IVORY := Color("#f7f2da")

var pulse: float = 0.0
var highlighted: bool = false


func _ready() -> void:
	position = Vector2.ZERO
	queue_redraw()


func _process(delta: float) -> void:
	pulse = fmod(pulse + delta * (0.86 if highlighted else 0.48), TAU)
	queue_redraw()


func _draw() -> void:
	_draw_solar_wings()
	_draw_docking_zone()
	_draw_landing_bay()
	_draw_outer_rings()
	_draw_hub()
	_draw_antennas()
	_draw_docking_chevrons()
	_draw_nameplate()


func _draw_solar_wings() -> void:
	# Four folding wings sit behind the hub. Each wing is deliberately skewed
	# like a worn panel rather than a clean UI rectangle.
	for side in [-1.0, 1.0]:
		_draw_wing(side, -1.0)
		_draw_wing(side, 1.0)


func _draw_wing(side: float, vertical_side: float) -> void:
	var root_x := 72.0 * side
	var tip_x := 176.0 * side
	var root_y := 52.0 * vertical_side
	var tip_y := 70.0 * vertical_side
	var tip_far_y := 96.0 * vertical_side
	var root_far_y := 78.0 * vertical_side
	var panel := PackedVector2Array(
		[
			Vector2(root_x, root_y),
			Vector2(tip_x, tip_y),
			Vector2(tip_x, tip_far_y),
			Vector2(root_x, root_far_y),
		]
	)
	draw_colored_polygon(panel, _with_alpha(HULL_DEEP, 0.98))
	draw_polyline(panel, _with_alpha(HULL_EDGE, 0.78), 1.4, true)

	var inner_panel := PackedVector2Array(
		[
			Vector2(root_x + side * 8.0, root_y + vertical_side * 4.0),
			Vector2(tip_x - side * 5.0, tip_y + vertical_side * 4.0),
			Vector2(tip_x - side * 5.0, tip_far_y - vertical_side * 5.0),
			Vector2(root_x + side * 8.0, root_far_y - vertical_side * 4.0),
		]
	)
	draw_colored_polygon(inner_panel, _with_alpha(Color("#1a3540"), 0.96))

	for cell in range(1, 5):
		var fraction := float(cell) / 5.0
		var seam_start := Vector2(
			lerpf(root_x + side * 8.0, tip_x - side * 5.0, fraction),
			lerpf(root_y + vertical_side * 4.0, tip_y + vertical_side * 4.0, fraction),
		)
		var seam_end := Vector2(
			lerpf(root_x + side * 8.0, tip_x - side * 5.0, fraction),
			lerpf(root_far_y - vertical_side * 4.0, tip_far_y - vertical_side * 5.0, fraction),
		)
		draw_line(seam_start, seam_end, _with_alpha(TEAL_DEEP, 0.72), 0.8, true)

	# A single warm service lamp at each outboard tip gives the wings a sense
	# of power without making them look like neon signage.
	var lamp_position := Vector2(tip_x - side * 8.0, (tip_y + tip_far_y) * 0.5)
	draw_circle(lamp_position, 2.5, _with_alpha(AMBER, 0.22))
	draw_circle(lamp_position, 1.05, AMBER_BRIGHT)


func _draw_docking_zone() -> void:
	var ring_alpha := 0.42 if highlighted else 0.27
	var ring_color := TEAL if highlighted else TEAL_MID
	# A broad underglow makes the actual 145 m delivery zone readable against
	# the starfield while preserving a crisp single-pixel boundary.
	draw_arc(Vector2.ZERO, DOCK_RADIUS, 0.0, TAU, 160, _with_alpha(ring_color, 0.08), 12.0, true)
	draw_arc(
		Vector2.ZERO,
		DOCK_RADIUS - 4.0,
		0.0,
		TAU,
		160,
		_with_alpha(ring_color, ring_alpha * 0.35),
		2.0,
		true
	)
	_draw_dashed_arc(
		DOCK_RADIUS, -0.09 + pulse * 0.025, 30, 0.12, _with_alpha(ring_color, ring_alpha), 2.0
	)
	_draw_dashed_arc(
		DOCK_RADIUS + 7.0, 0.21 + pulse * 0.018, 30, 0.08, _with_alpha(TEAL_DEEP, 0.62), 1.0
	)


func _draw_landing_bay() -> void:
	# North-facing recovery apron. The amber plane is recessed into the hull,
	# with a low warm wash and five practical runway lamps.
	var bay := PackedVector2Array(
		[
			Vector2(-24.0, -37.0),
			Vector2(24.0, -37.0),
			Vector2(39.0, -126.0),
			Vector2(-39.0, -126.0),
		]
	)
	draw_colored_polygon(bay, _with_alpha(Color("#8e4d2f"), 0.21))
	draw_polyline(bay, _with_alpha(AMBER, 0.54), 1.1, true)

	var bay_inner := PackedVector2Array(
		[
			Vector2(-14.0, -44.0),
			Vector2(14.0, -44.0),
			Vector2(22.0, -117.0),
			Vector2(-22.0, -117.0),
		]
	)
	draw_colored_polygon(bay_inner, _with_alpha(Color("#f18c46"), 0.09))
	for index in range(5):
		var y := -52.0 - float(index) * 14.0
		var lamp_alpha := 0.58 + 0.16 * sin(pulse * 1.4 + float(index))
		draw_circle(Vector2(0.0, y), 2.8, _with_alpha(AMBER, lamp_alpha * 0.22))
		draw_circle(Vector2(0.0, y), 1.0, _with_alpha(AMBER_BRIGHT, lamp_alpha))
		# Short side markers turn the apron into a landing guide rather than a
		# flat colored stripe.
		draw_line(Vector2(-9.0, y), Vector2(-16.0, y - 2.0), _with_alpha(AMBER, 0.52), 0.8, true)
		draw_line(Vector2(9.0, y), Vector2(16.0, y - 2.0), _with_alpha(AMBER, 0.52), 0.8, true)


func _draw_outer_rings() -> void:
	# The ring is segmented into unequal-looking maintenance plates, with dark
	# breaks that keep the silhouette industrial and legible.
	_draw_dashed_arc(108.0, pulse * 0.035, 12, 0.16, _with_alpha(HULL_EDGE, 0.8), 3.0)
	_draw_dashed_arc(115.0, -pulse * 0.022 + 0.18, 16, 0.08, _with_alpha(TEAL_DEEP, 0.82), 1.0)
	draw_arc(Vector2.ZERO, 96.0, 0.0, TAU, 144, _with_alpha(HULL_EDGE, 0.84), 2.0, true)

	for index in range(12):
		var angle := TAU * float(index) / 12.0 + 0.08
		var inner := _polar(78.0, angle)
		var outer := _polar(91.0, angle)
		draw_line(inner, outer, _with_alpha(HULL_EDGE, 0.5), 1.0, true)
		var bolt := _polar(90.5, angle + 0.12)
		draw_circle(bolt, 1.5, _with_alpha(HULL_LIGHT, 0.98))
		draw_circle(bolt, 0.55, _with_alpha(TEAL, 0.55 if index % 3 == 0 else 0.24))


func _draw_hub() -> void:
	# Offset shadow makes the station float above the world without a texture.
	draw_circle(Vector2(4.0, 7.0), 97.0, _with_alpha(HULL_SHADOW, 0.86))
	draw_circle(Vector2.ZERO, 94.0, HULL_DEEP)
	draw_colored_polygon(_regular_polygon(86.0, 12, PI / 12.0), HULL)
	draw_colored_polygon(_regular_polygon(73.0, 12, 0.0), _with_alpha(Color("#172f3b"), 0.94))

	# Long radial seams divide the hub into service panels.
	for index in range(12):
		var angle := TAU * float(index) / 12.0 + PI / 12.0
		draw_line(_polar(43.0, angle), _polar(75.0, angle), _with_alpha(HULL_EDGE, 0.38), 0.9, true)

	# Four dark access plates and their small teal status lamps.
	for angle in [0.0, PI * 0.5, PI, PI * 1.5]:
		var plate_center := _polar(64.0, angle)
		var tangent := Vector2.from_angle(angle + PI * 0.5) * 10.0
		var radial := Vector2.from_angle(angle) * 5.0
		var plate := PackedVector2Array(
			[
				plate_center - tangent - radial,
				plate_center + tangent - radial,
				plate_center + tangent + radial,
				plate_center - tangent + radial,
			]
		)
		draw_colored_polygon(plate, _with_alpha(Color("#0b1b27"), 0.94))
		draw_polyline(plate, _with_alpha(HULL_EDGE, 0.6), 0.8, true)
		draw_circle(plate_center + Vector2.from_angle(angle) * 2.0, 1.4, _with_alpha(TEAL, 0.6))

	# Command core: a cool ring around a single warm reactor eye.
	draw_circle(Vector2.ZERO, 38.0, _with_alpha(Color("#08131e"), 0.98))
	draw_arc(Vector2.ZERO, 38.0, 0.0, TAU, 96, _with_alpha(HULL_EDGE, 0.95), 2.0, true)
	draw_arc(
		Vector2.ZERO,
		31.0,
		pulse * 0.16,
		pulse * 0.16 + 4.75,
		64,
		_with_alpha(TEAL, 0.68),
		1.4,
		true
	)
	draw_colored_polygon(_regular_polygon(21.0, 8, PI / 8.0), _with_alpha(Color("#193845"), 0.98))
	draw_circle(Vector2.ZERO, 9.0, _with_alpha(AMBER, 0.18))
	draw_circle(Vector2.ZERO, 4.2, AMBER_BRIGHT)
	draw_circle(Vector2.ZERO, 1.5, IVORY)

	# Docking pips alternate teal and amber around the main body.
	for index in range(16):
		var angle := TAU * float(index) / 16.0 + PI / 16.0
		var pip_position := _polar(82.5, angle)
		var pip_color := AMBER if index % 4 == 0 else TEAL
		draw_circle(pip_position, 2.2, _with_alpha(pip_color, 0.13))
		draw_circle(pip_position, 0.85, _with_alpha(pip_color, 0.72))


func _draw_antennas() -> void:
	# Antenna arms drift just enough to imply a rotating relay, but remain quiet
	# in the peripheral vision while the player handles salvage.
	var antenna_phase := pulse * 0.12
	for index in range(3):
		var angle := antenna_phase + TAU * float(index) / 3.0 + 0.3
		var root := _polar(103.0, angle)
		var tip := _polar(130.0, angle)
		draw_line(root, tip, _with_alpha(HULL_EDGE, 0.78), 1.2, true)
		draw_line(
			root,
			tip + Vector2.from_angle(angle + PI * 0.5) * 4.0,
			_with_alpha(TEAL_DEEP, 0.6),
			0.7,
			true
		)
		draw_circle(tip, 3.7, _with_alpha(TEAL, 0.14))
		draw_circle(tip, 1.15, _with_alpha(AMBER_BRIGHT if index == 0 else TEAL, 0.88))
		var dish := _polar(116.0, angle + 0.15)
		draw_arc(dish, 7.0, angle - 1.0, angle + 1.0, 18, _with_alpha(TEAL_MID, 0.52), 0.9, true)


func _draw_docking_chevrons() -> void:
	var chevron_color := TEAL if highlighted else _with_alpha(TEAL, 0.72)
	# Four approach indicators sit just inside the delivery radius. They are
	# intentionally made from linework so a docked tug never loses the zone.
	for angle in [0.0, PI * 0.5, PI, PI * 1.5]:
		var radial := Vector2.from_angle(angle)
		var tangent := Vector2.from_angle(angle + PI * 0.5)
		var center := radial * 127.0
		var left := center - radial * 7.0 - tangent * 7.0
		var point := center + radial * 7.0
		var right := center - radial * 7.0 + tangent * 7.0
		draw_polyline(
			PackedVector2Array([left, point, right]), _with_alpha(chevron_color, 0.76), 1.8, true
		)

	# Two little directional marks at the active bay make the warm lane's
	# orientation apparent even when the station is highlighted.
	for index in range(2):
		var y := -111.0 - float(index) * 10.0
		draw_polyline(
			PackedVector2Array([Vector2(-11.0, y), Vector2(0.0, y + 6.0), Vector2(11.0, y)]),
			_with_alpha(AMBER_BRIGHT, 0.64),
			1.1,
			true,
		)


func _draw_nameplate() -> void:
	var plate := PackedVector2Array(
		[
			Vector2(-85.0, -198.0),
			Vector2(73.0, -198.0),
			Vector2(84.0, -187.0),
			Vector2(73.0, -176.0),
			Vector2(-85.0, -176.0),
			Vector2(-95.0, -187.0),
		]
	)
	draw_colored_polygon(plate, _with_alpha(Color("#0a1723"), 0.93))
	draw_polyline(plate, _with_alpha(TEAL_DEEP, 0.72), 1.0, true)
	var font: Font = ThemeDB.fallback_font
	if font != null:
		draw_string(
			font,
			Vector2(-80.0, -184.0),
			"KESTREL // HOME",
			HORIZONTAL_ALIGNMENT_CENTER,
			155.0,
			12,
			IVORY
		)
		draw_string(
			font,
			Vector2(-80.0, -178.0),
			"DOCK 145 M",
			HORIZONTAL_ALIGNMENT_CENTER,
			155.0,
			7,
			_with_alpha(TEAL, 0.76)
		)


func _draw_dashed_arc(
	radius: float, phase: float, count: int, gap: float, color: Color, width: float
) -> void:
	var step := TAU / float(count)
	for index in range(count):
		var start := phase + float(index) * step + gap * 0.5
		var end := phase + float(index + 1) * step - gap * 0.5
		if end > start:
			draw_arc(Vector2.ZERO, radius, start, end, 8, color, width, true)


func _regular_polygon(radius: float, sides: int, rotation: float) -> PackedVector2Array:
	var polygon := PackedVector2Array()
	for index in range(sides):
		polygon.append(Vector2.from_angle(rotation + TAU * float(index) / float(sides)) * radius)
	return polygon


func _polar(radius: float, angle: float) -> Vector2:
	return Vector2.from_angle(angle) * radius


func _with_alpha(color: Color, alpha: float) -> Color:
	var result := color
	result.a = clampf(alpha, 0.0, 1.0)
	return result
