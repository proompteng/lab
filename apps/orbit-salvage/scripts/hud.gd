class_name SalvageHUD
extends Control

signal start_requested
signal resume_requested
signal home_requested
signal sound_requested
signal upgrade_requested

const DISPLAY_FONT: Font = preload("res://resources/display_font.tres")
const TITLE_FONT: Font = preload("res://resources/title_font.tres")
const MONO_FONT: Font = preload("res://assets/fonts/DMMono-Regular.ttf")
const INK := Color("eee9df")
const MUTED := Color("8d9ba8")
const TEAL := Color("7bdfcd")
const AMBER := Color("edb879")
const BORDER := Color("2b3c48")

var game: OrbitSalvageGame
var _title_view: VBoxContainer
var _pause_view: PanelContainer
var _result_view: PanelContainer
var _flight_view: Control
var _sound_button: Button
var _pause_button: Button
var _launch_button: Button
var _resume_button: Button
var _retry_button: Button
var _upgrade_button: Button
var _contract_value: Label
var _contract_bar: ProgressBar
var _bank: Label
var _cargo_name: Label
var _cargo_detail: Label
var _cargo_status: Label
var _hull_value: Label
var _hull_bar: ProgressBar
var _fuel_value: Label
var _fuel_bar: ProgressBar
var _velocity: Label
var _radio: Label
var _best: Label
var _result_title: Label
var _result_copy: Label
var _result_stats: Label
var _storage_notice: Label
var _clock: Label
var _controls: Label
var _dock_label: Label
var _phase: int = -1


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	var ui_theme := Theme.new()
	ui_theme.default_font = DISPLAY_FONT
	ui_theme.default_font_size = 16
	theme = ui_theme
	_build_header()
	_build_title()
	_build_flight()
	_build_pause()
	_build_result()
	resized.connect(_layout)
	_layout()
	set_phase(game.phase)


func _label(text: String, size_px: int = 16, color: Color = INK, mono: bool = false) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_override("font", MONO_FONT if mono else DISPLAY_FONT)
	label.add_theme_font_size_override("font_size", size_px)
	label.add_theme_color_override("font_color", color)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return label


func _box(gap: int = 8) -> VBoxContainer:
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", gap)
	box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return box


func _style(color: Color, stroke: Color, padding: int = 14) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = color
	style.border_color = stroke
	style.set_border_width_all(1)
	style.set_corner_radius_all(5)
	style.content_margin_left = padding
	style.content_margin_right = padding
	style.content_margin_top = padding
	style.content_margin_bottom = padding
	return style


func _button(text: String, primary: bool = false) -> Button:
	var button := Button.new()
	button.text = text
	button.custom_minimum_size.y = 48.0
	button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	button.add_theme_font_override("font", MONO_FONT)
	button.add_theme_font_size_override("font_size", 13)
	var base: Color = AMBER if primary else Color("111f2a")
	button.add_theme_stylebox_override("normal", _style(base, AMBER if primary else BORDER, 13))
	button.add_theme_stylebox_override("hover", _style(base.lightened(0.12), INK, 13))
	button.add_theme_stylebox_override("pressed", _style(base.darkened(0.12), TEAL, 13))
	button.add_theme_stylebox_override("focus", _style(Color(0, 0, 0, 0), TEAL, 13))
	button.add_theme_stylebox_override("disabled", _style(Color("0d1822"), BORDER, 13))
	button.add_theme_color_override("font_color", Color("10202a") if primary else INK)
	button.add_theme_color_override("font_hover_color", Color("10202a") if primary else INK)
	button.add_theme_color_override("font_pressed_color", Color("10202a") if primary else INK)
	button.add_theme_color_override("font_focus_color", Color("10202a") if primary else INK)
	button.add_theme_color_override("font_disabled_color", MUTED)
	return button


func _bar(color: Color, width: float = 250.0) -> ProgressBar:
	var bar := ProgressBar.new()
	bar.show_percentage = false
	bar.custom_minimum_size = Vector2(width, 4.0)
	bar.add_theme_stylebox_override("background", _style(Color("20303c"), Color.TRANSPARENT, 0))
	bar.add_theme_stylebox_override("fill", _style(color, Color.TRANSPARENT, 0))
	bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return bar


func _spacer(height: float) -> Control:
	var spacer := Control.new()
	spacer.custom_minimum_size.y = height
	spacer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return spacer


func _build_header() -> void:
	var header := HBoxContainer.new()
	header.name = "Header"
	add_child(header)
	header.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	header.offset_left = 32.0
	header.offset_top = 25.0
	header.offset_right = -32.0
	header.add_theme_constant_override("separation", 14)
	var mark := TextureRect.new()
	mark.texture = preload("res://assets/icon.svg")
	mark.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	mark.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	mark.custom_minimum_size = Vector2(36, 36)
	header.add_child(mark)
	var brand := _box(1)
	brand.add_child(_label("KESTREL", 18))
	brand.add_child(_label("INDEPENDENT SALVAGE CO.", 9, MUTED, true))
	header.add_child(brand)
	var space := Control.new()
	space.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(space)
	var sector := _label("SECTOR 07  /  THE DRIFT", 11, MUTED, true)
	sector.name = "Sector"
	header.add_child(sector)
	_sound_button = _button("SOUND ON")
	_sound_button.custom_minimum_size = Vector2(114.0, 38.0)
	_sound_button.pressed.connect(_toggle_sound)
	header.add_child(_sound_button)
	_pause_button = _button("PAUSE")
	_pause_button.custom_minimum_size = Vector2(84.0, 38.0)
	_pause_button.pressed.connect(func() -> void: resume_requested.emit())
	header.add_child(_pause_button)


func _build_title() -> void:
	_title_view = _box(8)
	_title_view.name = "Title"
	_title_view.custom_minimum_size.x = 430.0
	add_child(_title_view)
	_title_view.add_child(_label("A WORKING LIFE AT THE EDGE OF SPACE", 11, AMBER, true))
	_title_view.add_child(_spacer(7.0))
	var title := _label("ORBIT\nSALVAGE", 86)
	title.add_theme_font_override("font", TITLE_FONT)
	title.add_theme_constant_override("line_spacing", -24)
	_title_view.add_child(title)
	_title_view.add_child(_spacer(8.0))
	_title_view.add_child(_label("A small tug. A heavy haul.\nOne more trip home.", 23, MUTED))
	_title_view.add_child(_spacer(22.0))
	_launch_button = _button("TAKE THE HELM   /   ENTER", true)
	_launch_button.custom_minimum_size = Vector2(360.0, 55.0)
	_launch_button.pressed.connect(func() -> void: start_requested.emit())
	_title_view.add_child(_launch_button)
	_title_view.add_child(_spacer(5.0))
	_title_view.add_child(_label("FLY. TETHER. HAUL. GET PAID.", 11, MUTED, true))
	_best = _label("", 11, TEAL, true)
	_title_view.add_child(_best)
	var footer := _label(
		"01 / A SALVAGE FLIGHT                 MADE FOR THE LONG WAY HOME", 10, MUTED, true
	)
	footer.name = "TitleFooter"
	add_child(footer)
	footer.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	footer.offset_left = 40.0
	footer.offset_top = -40.0
	footer.offset_bottom = -20.0


func _build_flight() -> void:
	_flight_view = Control.new()
	_flight_view.name = "Flight"
	_flight_view.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_flight_view)
	_flight_view.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var contract := _box(7)
	contract.position = Vector2(34, 104)
	contract.custom_minimum_size.x = 276.0
	contract.add_child(_label("OPEN CONTRACT / RECOVERY", 10, MUTED, true))
	_contract_value = _label("0 / 1,200 CR", 29)
	contract.add_child(_contract_value)
	_contract_bar = _bar(TEAL, 276.0)
	_contract_bar.max_value = float(OrbitSalvageGame.CONTRACT_GOAL)
	contract.add_child(_contract_bar)
	_bank = _label("", 11, MUTED, true)
	contract.add_child(_bank)
	_flight_view.add_child(contract)
	var target_box := _box(5)
	target_box.name = "Target"
	target_box.custom_minimum_size.x = 245.0
	target_box.add_child(_label("SALVAGE SCANNER", 10, MUTED, true))
	_cargo_name = _label("", 21, AMBER)
	_cargo_detail = _label("", 11, MUTED, true)
	_cargo_status = _label("", 11, TEAL, true)
	target_box.add_child(_cargo_name)
	target_box.add_child(_cargo_detail)
	target_box.add_child(_spacer(6.0))
	target_box.add_child(_cargo_status)
	_flight_view.add_child(target_box)
	var instruments := _box(6)
	instruments.name = "Instruments"
	instruments.custom_minimum_size.x = 215.0
	_velocity = _label("000", 37)
	instruments.add_child(_velocity)
	_hull_value = _label("HULL INTEGRITY / 100%", 10, MUTED, true)
	instruments.add_child(_hull_value)
	_hull_bar = _bar(TEAL, 215.0)
	instruments.add_child(_hull_bar)
	instruments.add_child(_spacer(4.0))
	_fuel_value = _label("BOOST RESERVE / 100%", 10, MUTED, true)
	instruments.add_child(_fuel_value)
	_fuel_bar = _bar(AMBER, 215.0)
	instruments.add_child(_fuel_bar)
	_flight_view.add_child(instruments)
	_radio = _label("", 14, INK)
	_radio.name = "Radio"
	_radio.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_radio.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_flight_view.add_child(_radio)
	_dock_label = _label("DOCK SECURE / REPAIRING & REFUELING", 11, TEAL, true)
	_dock_label.name = "Dock"
	_dock_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_flight_view.add_child(_dock_label)
	_upgrade_button = _button("UPGRADE THRUSTERS / 300 CR")
	_upgrade_button.name = "Upgrade"
	_upgrade_button.pressed.connect(_purchase_upgrade)
	_flight_view.add_child(_upgrade_button)
	_controls = _label(
		"W S  THRUST    A D  TURN    SPACE  BRAKE    E  CABLE    SHIFT  BOOST", 10, MUTED, true
	)
	_controls.name = "Controls"
	_flight_view.add_child(_controls)
	_clock = _label("00:00", 10, MUTED, true)
	_clock.name = "Clock"
	_flight_view.add_child(_clock)


func _modal() -> PanelContainer:
	var panel := PanelContainer.new()
	panel.custom_minimum_size = Vector2(470.0, 350.0)
	panel.add_theme_stylebox_override("panel", _style(Color("0d1924"), BORDER, 34))
	add_child(panel)
	return panel


func _build_pause() -> void:
	_pause_view = _modal()
	var content := _box(15)
	_pause_view.add_child(content)
	content.add_child(_label("KESTREL / FLIGHT HOLD", 11, AMBER, true))
	content.add_child(_label("Take a breath.", 38))
	content.add_child(
		_label(
			"Your ship and cargo will wait.\nReturn slowly to the teal ring to sell salvage.",
			16,
			MUTED
		)
	)
	content.add_child(_spacer(8.0))
	_resume_button = _button("RESUME FLIGHT", true)
	_resume_button.pressed.connect(func() -> void: resume_requested.emit())
	content.add_child(_resume_button)
	var home := _button("ABANDON FLIGHT / RETURN TO TITLE")
	home.pressed.connect(func() -> void: home_requested.emit())
	content.add_child(home)


func _build_result() -> void:
	_result_view = _modal()
	var content := _box(14)
	_result_view.add_child(content)
	content.add_child(_label("KESTREL / FLIGHT REPORT", 11, AMBER, true))
	_result_title = _label("A good day's work.", 36)
	content.add_child(_result_title)
	_result_copy = _label("", 16, MUTED)
	content.add_child(_result_copy)
	_result_stats = _label("", 13, TEAL, true)
	content.add_child(_result_stats)
	_storage_notice = _label("", 12, AMBER)
	_storage_notice.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	content.add_child(_storage_notice)
	content.add_child(_spacer(4.0))
	_retry_button = _button("FLY ANOTHER CONTRACT", true)
	_retry_button.pressed.connect(func() -> void: start_requested.emit())
	content.add_child(_retry_button)
	var home := _button("RETURN TO TITLE")
	home.pressed.connect(func() -> void: home_requested.emit())
	content.add_child(home)


func _layout() -> void:
	if not is_instance_valid(_title_view):
		return
	_title_view.position = Vector2(maxf(40.0, size.x * 0.071), maxf(106.0, (size.y - 495.0) * 0.5))
	_pause_view.position = (size - _pause_view.size) * 0.5
	_result_view.position = (size - _result_view.size) * 0.5
	_flight_view.get_node("Target").position = Vector2(size.x - 282.0, 106.0)
	_flight_view.get_node("Instruments").position = Vector2(34.0, size.y - 206.0)
	_radio.position = Vector2(size.x * 0.24, size.y - 215.0)
	_radio.size = Vector2(size.x * 0.52, 62.0)
	_dock_label.position = Vector2(size.x * 0.25, size.y - 145.0)
	_dock_label.size.x = size.x * 0.5
	_upgrade_button.position = Vector2(size.x * 0.5 - 165.0, size.y - 111.0)
	_upgrade_button.size.x = 330.0
	_controls.position = Vector2(34.0, size.y - 35.0)
	_clock.position = Vector2(size.x - 84.0, size.y - 35.0)
	get_node("Header/Sector").visible = size.x > 1060.0


func set_phase(value: int) -> void:
	if _phase == value:
		return
	_phase = value
	_title_view.visible = value == OrbitSalvageGame.Phase.TITLE
	get_node("TitleFooter").visible = _title_view.visible
	_flight_view.visible = value == OrbitSalvageGame.Phase.PLAYING
	_pause_view.visible = value == OrbitSalvageGame.Phase.PAUSED
	_result_view.visible = (
		value == OrbitSalvageGame.Phase.WON or value == OrbitSalvageGame.Phase.LOST
	)
	_pause_button.visible = (
		value == OrbitSalvageGame.Phase.PLAYING or value == OrbitSalvageGame.Phase.PAUSED
	)
	if _title_view.visible:
		_launch_button.grab_focus()
	elif value == OrbitSalvageGame.Phase.PLAYING:
		get_viewport().gui_release_focus()
	elif _pause_view.visible:
		_resume_button.grab_focus()
	elif _result_view.visible:
		_result_title.text = (
			"A good day's work." if value == OrbitSalvageGame.Phase.WON else "Lost in the drift."
		)
		_result_copy.text = (
			"Contract fulfilled. Kestrel kept a light on for you."
			if value == OrbitSalvageGame.Phase.WON
			else "Your next tug is waiting.\nBrake before turns. Watch the cable strain."
		)
		_result_stats.text = (
			"%d CR RECOVERED   /   %d PIECES\nFLIGHT TIME %s   /   BEST %d CR"
			% [game.earned, game.recovered, _time(game.elapsed), game.profile.best_haul]
		)
		_retry_button.grab_focus()
	_layout.call_deferred()
	queue_redraw()


func refresh() -> void:
	_sound_button.text = "SOUND OFF" if game.profile.muted else "SOUND ON"
	_pause_button.text = "RESUME" if _phase == OrbitSalvageGame.Phase.PAUSED else "PAUSE"
	_best.text = (
		"PERSONAL BEST / %d CR" % game.profile.best_haul
		if game.profile.completed_runs > 0
		else "YOUR FIRST CONTRACT IS WAITING."
	)
	if not game.storage_notice.is_empty():
		_best.text = game.storage_notice
	_storage_notice.text = game.storage_notice
	_storage_notice.visible = not game.storage_notice.is_empty()
	if _phase != OrbitSalvageGame.Phase.PLAYING:
		return
	_contract_value.text = "%s / 1,200 CR" % _number(game.earned)
	_contract_bar.value = float(game.earned)
	_bank.text = "BANK %d CR   /   %d RECOVERED" % [game.credits, game.recovered]
	_hull_value.text = "HULL INTEGRITY / %d%%" % roundi(game.tug.hull)
	_hull_bar.value = game.tug.hull
	_fuel_value.text = "BOOST RESERVE / %d%%" % roundi(game.tug.fuel)
	_fuel_bar.value = game.tug.fuel
	_velocity.text = "%03d  m/s" % roundi(game.tug.linear_velocity.length())
	_clock.text = _time(game.elapsed)
	_radio.visible = game.message_time > 0.0
	_radio.text = "[COMMS]  " + game.message
	_dock_label.visible = game.docked
	_upgrade_button.visible = game.docked and game.upgrade_level < 3
	_upgrade_button.text = "U / UPGRADE THRUSTERS  %d CR" % game.upgrade_cost()
	_upgrade_button.disabled = game.credits < game.upgrade_cost()
	var cargo: SalvageCargo = game.tether.cargo if game.tether.is_attached() else game.target
	if is_instance_valid(cargo):
		_cargo_name.text = cargo.label
		_cargo_detail.text = (
			"%d CR   /   %.1f t   /   %d m"
			% [cargo.credits, cargo.mass, roundi(game.tug.position.distance_to(cargo.position))]
		)
		if game.tether.is_attached():
			_cargo_status.text = (
				"CABLE STRAIN %d%%  /  E RELEASE" % roundi(game.tether.tension * 100.0)
			)
			_cargo_status.modulate = AMBER if game.tether.tension > 0.7 else TEAL
		elif game.tug.position.distance_to(cargo.position) <= SalvageTether.MAX_ATTACH_DISTANCE:
			_cargo_status.text = "IN RANGE  /  E TO TETHER"
			_cargo_status.modulate = TEAL
		else:
			_cargo_status.text = "APPROACH TO 190 m"
			_cargo_status.modulate = MUTED
	else:
		_cargo_name.text = "SECTOR CLEAR"
		_cargo_detail.text = "Return to Kestrel"
		_cargo_status.text = ""
	if not Input.get_connected_joypads().is_empty():
		_controls.text = "LEFT STICK  FLY    A  BRAKE    X  CABLE    RB  BOOST    START  PAUSE"
	queue_redraw()


func _toggle_sound() -> void:
	sound_requested.emit()
	if game.phase == OrbitSalvageGame.Phase.PLAYING:
		get_viewport().gui_release_focus()
	elif game.phase == OrbitSalvageGame.Phase.TITLE:
		_launch_button.grab_focus()


func _purchase_upgrade() -> void:
	upgrade_requested.emit()
	get_viewport().gui_release_focus()


func _time(seconds: float) -> String:
	return "%02d:%02d" % [int(seconds) / 60, int(seconds) % 60]


func _number(value: int) -> String:
	if value < 1000:
		return str(value)
	return "%d,%03d" % [value / 1000, value % 1000]


func _draw() -> void:
	if _phase == OrbitSalvageGame.Phase.TITLE:
		for strip: int in 80:
			var opacity: float = 0.90 * (1.0 - smoothstep(0.25, 1.0, float(strip) / 80.0))
			draw_rect(
				Rect2(float(strip) * 10.0, 84.0, 10.0, size.y - 84.0),
				Color(0.025, 0.043, 0.075, opacity)
			)
	draw_rect(Rect2(0, 0, size.x, 84), Color(0.025, 0.043, 0.075, 0.96))
	draw_line(Vector2(32, 84), Vector2(size.x - 32, 84), Color(BORDER, 0.7), 1.0)
	if (
		_phase == OrbitSalvageGame.Phase.PAUSED
		or _phase == OrbitSalvageGame.Phase.LOST
		or _phase == OrbitSalvageGame.Phase.WON
	):
		draw_rect(Rect2(Vector2.ZERO, size), Color(0.02, 0.04, 0.07, 0.70))
	if _phase != OrbitSalvageGame.Phase.PLAYING:
		return
	_draw_radar()
	var destination: Vector2 = Vector2.ZERO
	var tint: Color = TEAL
	var caption: String = "KESTREL"
	if not game.tether.is_attached() and is_instance_valid(game.target):
		destination = game.target.position
		tint = AMBER
		caption = "SALVAGE"
	_draw_waypoint(destination, tint, caption)
	if game.tug.hull < 30.0:
		draw_rect(Rect2(Vector2.ZERO, size), Color(0.8, 0.18, 0.11, 0.5), false, 3.0)


func _draw_radar() -> void:
	var center := Vector2(size.x - 123.0, size.y - 145.0)
	var radius: float = 77.0
	draw_circle(center, radius + 7.0, Color(0.035, 0.065, 0.09, 0.92))
	draw_arc(center, radius, 0.0, TAU, 80, BORDER, 1.0, true)
	draw_arc(center, radius * 0.5, 0.0, TAU, 56, Color(BORDER, 0.7), 1.0, true)
	draw_line(center + Vector2(-radius, 0), center + Vector2(radius, 0), Color(BORDER, 0.45))
	draw_line(center + Vector2(0, -radius), center + Vector2(0, radius), Color(BORDER, 0.45))
	draw_circle(center, 3.5, TEAL)
	var map_scale: float = radius / OrbitSalvageGame.SECTOR_RADIUS
	for cargo: SalvageCargo in game.cargoes:
		if is_instance_valid(cargo) and not cargo.delivered:
			draw_circle(center + (cargo.position * map_scale).limit_length(radius), 2.1, AMBER)
	var pilot: Vector2 = center + (game.tug.position * map_scale).limit_length(radius)
	var heading: Vector2 = Vector2.RIGHT.rotated(game.tug.rotation)
	var points := PackedVector2Array(
		[
			pilot + heading * 6.0,
			pilot + heading.rotated(2.5) * 4.5,
			pilot + heading.rotated(-2.5) * 4.5,
		]
	)
	draw_colored_polygon(points, INK)
	draw_string(
		MONO_FONT,
		center + Vector2(-77, -98),
		"SECTOR SCANNER",
		HORIZONTAL_ALIGNMENT_LEFT,
		-1.0,
		10,
		MUTED
	)
	draw_string(
		MONO_FONT,
		center + Vector2(-67, 101),
		"HOME %04d m" % roundi(game.tug.position.length()),
		HORIZONTAL_ALIGNMENT_LEFT,
		-1.0,
		10,
		TEAL
	)


func _draw_waypoint(destination: Vector2, tint: Color, caption: String) -> void:
	var point: Vector2 = get_viewport().get_canvas_transform() * destination
	var safe := Rect2(Vector2(80, 215), size - Vector2(160, 450))
	if safe.has_point(point):
		return
	var center: Vector2 = size * 0.5
	var direction: Vector2 = (point - center).normalized()
	if direction.is_zero_approx():
		return
	var reach_x: float = (size.x * 0.5 - 100.0) / maxf(absf(direction.x), 0.001)
	var reach_y: float = (size.y * 0.5 - 220.0) / maxf(absf(direction.y), 0.001)
	var marker: Vector2 = center + direction * minf(reach_x, reach_y)
	var arrow := PackedVector2Array(
		[
			marker + direction * 10.0,
			marker + direction.rotated(2.5) * 7.0,
			marker + direction.rotated(-2.5) * 7.0,
		]
	)
	draw_colored_polygon(arrow, tint)
	var distance: int = roundi(game.tug.position.distance_to(destination))
	draw_string(
		MONO_FONT,
		marker + Vector2(-52, 29),
		"%s %d m" % [caption, distance],
		HORIZONTAL_ALIGNMENT_LEFT,
		-1.0,
		10,
		tint
	)
