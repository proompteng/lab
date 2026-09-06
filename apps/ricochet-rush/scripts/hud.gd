class_name RushHUD
extends Control

signal start_requested
signal retry_requested
signal resume_requested
signal upgrade_chosen(id: StringName)
signal sound_requested

const DISPLAY_FONT: Font = preload("res://assets/fonts/SpaceGrotesk.ttf")
const MONO_FONT: Font = preload("res://assets/fonts/DMMono.ttf")
const INK := Color("e5e7e3")
const MUTED := Color("989fa2")
const AMBER := Color("d0a253")
const CYAN := Color("66f4e8")
const PANEL := Color("171a1c")
const PANEL_RAISED := Color("202427")
const DEEP_INK := Color("0b0d0e")
const BORDER := Color("3a4245")
const MAX_HEALTH_PIPS: int = 10

var game: RicochetGame
var _title_view: VBoxContainer
var _flight_view: Control
var _pause_view: PanelContainer
var _upgrade_view: PanelContainer
var _result_view: PanelContainer
var _score_card: PanelContainer
var _progress_card: PanelContainer
var _combo_card: PanelContainer
var _health_card: PanelContainer
var _echo_card: PanelContainer
var _sound_button: Button
var _pause_button: Button
var _start_button: Button
var _resume_button: Button
var _retry_button: Button
var _score_label: Label
var _score_delta: Label
var _combo_label: Label
var _combo_copy: Label
var _health_value: Label
var _health_pips: HBoxContainer
var _dash_value: Label
var _dash_bar: ProgressBar
var _echo_status: Label
var _echo_history_value: Label
var _echo_history_bar: ProgressBar
var _echo_charge_value: Label
var _echo_charge_bar: ProgressBar
var _echo_hint: Label
var _wave_label: Label
var _level_label: Label
var _run_time: Label
var _xp_value: Label
var _xp_bar: ProgressBar
var _action_panel: PanelContainer
var _action_key_chip: PanelContainer
var _action_key: Label
var _action_title: Label
var _action_hint: Label
var _controls: Label
var _upgrade_buttons: Array[Button] = []
var _result_title: Label
var _result_copy: Label
var _result_stats: Label
var _storage_notice: Label
var _phase: int = -1
var _last_score: int = -1
var _last_combo: int = -1
var _last_level: int = -1
var _last_echo_active: bool = false
var _last_echo_ready: bool = false
var _score_delta_time: float = 0.0
var _action_signature: String = ""


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
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
	_build_upgrade()
	_build_result()
	resized.connect(_layout)
	_layout()
	set_phase(game.phase)


func _label(text: String, size_px: int = 16, color: Color = INK, mono: bool = false) -> Label:
	var label := Label.new()
	label.text = text
	if mono:
		label.add_theme_font_override("font", MONO_FONT)
	else:
		var font := FontVariation.new()
		font.base_font = DISPLAY_FONT
		font.variation_opentype = {2003265652: 650 if size_px >= 24 else 500}
		label.add_theme_font_override("font", font)
	label.add_theme_font_size_override("font_size", size_px)
	label.add_theme_color_override("font_color", color)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return label


func _box(gap: int = 8) -> VBoxContainer:
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", gap)
	box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return box


func _style(color: Color, stroke: Color, padding: int = 14, radius: int = 6) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = color
	style.border_color = stroke
	style.set_border_width_all(1)
	style.set_corner_radius_all(radius)
	style.content_margin_left = padding
	style.content_margin_right = padding
	style.content_margin_top = padding
	style.content_margin_bottom = padding
	return style


func _button(text: String, primary: bool = false) -> Button:
	var button := Button.new()
	button.text = text
	button.custom_minimum_size.y = 48.0
	button.focus_mode = Control.FOCUS_ALL
	button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	button.add_theme_font_override("font", MONO_FONT)
	button.add_theme_font_size_override("font_size", 13)
	button.alignment = HORIZONTAL_ALIGNMENT_CENTER
	var base: Color = INK if primary else PANEL_RAISED
	var text_color: Color = DEEP_INK if primary else INK
	button.add_theme_stylebox_override("normal", _style(base, INK if primary else BORDER, 10, 4))
	button.add_theme_stylebox_override(
		"hover", _style(base.lightened(0.08), AMBER if primary else INK, 10, 4)
	)
	button.add_theme_stylebox_override("pressed", _style(base.darkened(0.12), AMBER, 10, 4))
	button.add_theme_stylebox_override("focus", _style(Color(0, 0, 0, 0), AMBER, 10, 4))
	button.add_theme_stylebox_override("disabled", _style(Color("151719"), BORDER, 10, 4))
	button.add_theme_color_override("font_color", text_color)
	button.add_theme_color_override("font_hover_color", text_color)
	button.add_theme_color_override("font_pressed_color", text_color)
	button.add_theme_color_override("font_focus_color", text_color)
	button.add_theme_color_override("font_disabled_color", MUTED)
	return button


func _bar(color: Color, width: float = 250.0, height: float = 6.0) -> ProgressBar:
	var bar := ProgressBar.new()
	bar.show_percentage = false
	bar.max_value = 1.0
	bar.custom_minimum_size = Vector2(width, height)
	bar.add_theme_stylebox_override("background", _style(Color("2a3032"), Color.TRANSPARENT, 0, 3))
	bar.add_theme_stylebox_override("fill", _style(color, Color.TRANSPARENT, 0, 3))
	bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return bar


func _build_header() -> void:
	var header := HBoxContainer.new()
	header.name = "Header"
	add_child(header)
	header.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	header.offset_left = 28.0
	header.offset_top = 22.0
	header.offset_right = -28.0
	header.add_theme_constant_override("separation", 12)
	var mark := ColorRect.new()
	mark.color = AMBER
	mark.custom_minimum_size = Vector2(4.0, 34.0)
	mark.mouse_filter = Control.MOUSE_FILTER_IGNORE
	header.add_child(mark)
	var brand := _box(0)
	brand.add_child(_label("RICOCHET RUSH", 18, INK))
	brand.add_child(_label("TIME ECHOES", 10, MUTED, true))
	header.add_child(brand)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	spacer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	header.add_child(spacer)
	_sound_button = _button("AUDIO ON")
	_sound_button.custom_minimum_size = Vector2(112.0, 40.0)
	_sound_button.pressed.connect(_on_sound_pressed)
	header.add_child(_sound_button)
	_pause_button = _button("PAUSE")
	_pause_button.custom_minimum_size = Vector2(92.0, 40.0)
	_pause_button.pressed.connect(_on_pause_pressed)
	header.add_child(_pause_button)


func _build_title() -> void:
	_title_view = _box(8)
	_title_view.name = "Title"
	_title_view.custom_minimum_size.x = 500.0
	add_child(_title_view)
	_title_view.add_child(_label("A FIGHT ACROSS THREE SECONDS", 11, AMBER, true))
	_title_view.add_child(_spacer(8.0))
	var title := _label("RICOCHET\nRUSH", 72, INK)
	title.add_theme_constant_override("line_spacing", -22)
	_title_view.add_child(title)
	_title_view.add_child(_spacer(14.0))
	_title_view.add_child(_label("FIGHT WITH YOUR PAST SELF.", 19, CYAN))
	_title_view.add_child(_spacer(9.0))
	_title_view.add_child(_label("Move. Shoot. Press E to replay your last 3 seconds.", 15, MUTED))
	_title_view.add_child(_spacer(22.0))
	_start_button = _button("START RUN   /   ENTER", true)
	_start_button.custom_minimum_size = Vector2(360.0, 52.0)
	_start_button.pressed.connect(func() -> void: start_requested.emit())
	_title_view.add_child(_start_button)
	_title_view.add_child(_spacer(8.0))
	_title_view.add_child(
		_label("WASD MOVE   MOUSE AIM   HOLD LMB FIRE   SPACE DASH   E / RMB ECHO", 10, MUTED, true)
	)
	var best := _label("", 11, AMBER, true)
	best.name = "Best"
	_title_view.add_child(best)
	var footer := _label("MOVE WITH INTENT. LEAVE AN ECHO.", 10, MUTED, true)
	footer.name = "TitleFooter"
	add_child(footer)
	footer.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	footer.offset_left = 32.0
	footer.offset_top = -42.0
	footer.offset_bottom = -22.0


func _build_flight() -> void:
	_flight_view = Control.new()
	_flight_view.name = "Flight"
	_flight_view.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_flight_view.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(_flight_view)

	_score_card = _card(Vector2(210.0, 100.0))
	_score_card.name = "ScoreCard"
	_flight_view.add_child(_score_card)
	var score_content := _box(3)
	_score_card.add_child(score_content)
	score_content.add_child(_label("SCORE", 10, MUTED, true))
	_score_label = _label("000000", 32, INK, true)
	score_content.add_child(_score_label)
	_score_delta = _label("", 12, AMBER, true)
	_score_delta.visible = false
	score_content.add_child(_score_delta)
	var xp_row := HBoxContainer.new()
	xp_row.add_theme_constant_override("separation", 8)
	_xp_value = _label("XP 000 / 000", 10, MUTED, true)
	xp_row.add_child(_xp_value)
	var xp_spacer := Control.new()
	xp_spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	xp_spacer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	xp_row.add_child(xp_spacer)
	score_content.add_child(xp_row)
	_xp_bar = _bar(INK, 210.0, 3.0)
	score_content.add_child(_xp_bar)

	_progress_card = _card(Vector2(270.0, 42.0))
	_progress_card.name = "ProgressCard"
	_flight_view.add_child(_progress_card)
	var progress_content := _box(6)
	_progress_card.add_child(progress_content)
	var progress_row := HBoxContainer.new()
	progress_row.add_theme_constant_override("separation", 18)
	_wave_label = _label("WAVE 01", 16, INK, true)
	progress_row.add_child(_wave_label)
	_level_label = _label("LV 01", 16, AMBER, true)
	progress_row.add_child(_level_label)
	var progress_spacer := Control.new()
	progress_spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	progress_spacer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	progress_row.add_child(progress_spacer)
	_run_time = _label("00:00", 12, MUTED, true)
	progress_row.add_child(_run_time)
	progress_content.add_child(progress_row)

	_combo_card = _card(Vector2(240.0, 70.0))
	_combo_card.name = "ComboCard"
	_flight_view.add_child(_combo_card)
	var combo_content := _box(3)
	_combo_card.add_child(combo_content)
	_combo_label = _label("CHAIN x0", 24, AMBER, true)
	combo_content.add_child(_combo_label)
	_combo_copy = _label("Land another hit to keep it alive.", 10, MUTED)
	_combo_copy.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	combo_content.add_child(_combo_copy)

	_health_card = _card(Vector2(230.0, 94.0))
	_health_card.name = "HealthCard"
	_flight_view.add_child(_health_card)
	var health_content := _box(7)
	_health_card.add_child(health_content)
	_health_value = _label("HEALTH 00 / 00", 11, INK, true)
	health_content.add_child(_health_value)
	_health_pips = HBoxContainer.new()
	_health_pips.add_theme_constant_override("separation", 5)
	_health_pips.mouse_filter = Control.MOUSE_FILTER_IGNORE
	for _index: int in MAX_HEALTH_PIPS:
		var pip := ColorRect.new()
		pip.custom_minimum_size = Vector2(18.0, 5.0)
		pip.color = Color(BORDER, 0.62)
		pip.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_health_pips.add_child(pip)
	health_content.add_child(_health_pips)
	_dash_value = _label("DASH RECHARGE 000%", 10, MUTED, true)
	health_content.add_child(_dash_value)
	_dash_bar = _bar(AMBER, 220.0, 3.0)
	health_content.add_child(_dash_bar)

	_build_echo_card()
	_build_action_prompt()
	_controls = _label(
		"WASD MOVE    MOUSE AIM / FIRE    SPACE DASH    E / RMB ECHO", 10, MUTED, true
	)
	_controls.name = "Controls"
	_controls.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_flight_view.add_child(_controls)


func _build_echo_card() -> void:
	_echo_card = _card(Vector2(268.0, 112.0))
	_echo_card.name = "EchoCard"
	_flight_view.add_child(_echo_card)
	var content := _box(3)
	_echo_card.add_child(content)
	_echo_status = _label("RECORDING / BUILD HISTORY", 14, CYAN, true)
	content.add_child(_echo_status)
	_echo_hint = _label("MOVE + FIRE TO REACH 0.65S", 9, MUTED, true)
	content.add_child(_echo_hint)
	var history_row := HBoxContainer.new()
	history_row.add_theme_constant_override("separation", 8)
	_echo_history_value = _label("HISTORY 0.0S / 3.0S", 9, MUTED, true)
	history_row.add_child(_echo_history_value)
	content.add_child(history_row)
	_echo_history_bar = _bar(CYAN, 236.0, 5.0)
	_echo_history_bar.max_value = 3.0
	content.add_child(_echo_history_bar)
	var charge_row := HBoxContainer.new()
	charge_row.add_theme_constant_override("separation", 8)
	_echo_charge_value = _label("CHARGE 000%", 9, MUTED, true)
	charge_row.add_child(_echo_charge_value)
	content.add_child(charge_row)
	_echo_charge_bar = _bar(CYAN, 236.0, 5.0)
	_echo_charge_bar.max_value = 1.0
	content.add_child(_echo_charge_bar)


func _build_action_prompt() -> void:
	_action_panel = _card(Vector2(360.0, 62.0))
	_action_panel.name = "ActionPrompt"
	_flight_view.add_child(_action_panel)
	var content := _box(3)
	_action_panel.add_child(content)
	var action_row := HBoxContainer.new()
	action_row.add_theme_constant_override("separation", 10)
	action_row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_action_key_chip = PanelContainer.new()
	_action_key_chip.custom_minimum_size = Vector2(42.0, 30.0)
	_action_key_chip.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_action_key_chip.add_theme_stylebox_override("panel", _style(INK, INK, 6, 4))
	_action_key = _label("LMB", 13, DEEP_INK, true)
	_action_key.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_action_key.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_action_key_chip.add_child(_action_key)
	action_row.add_child(_action_key_chip)
	var action_copy := _box(1)
	action_copy.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_action_title = _label("FIND THE ANGLE", 14, INK, true)
	action_copy.add_child(_action_title)
	_action_hint = _label("Hold fire and use the walls.", 11, MUTED)
	_action_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	action_copy.add_child(_action_hint)
	action_row.add_child(action_copy)
	content.add_child(action_row)


func _build_pause() -> void:
	_pause_view = _modal(Vector2(500.0, 300.0))
	var content := _box(14)
	_pause_view.add_child(content)
	content.add_child(_label("RICOCHET RUSH / PAUSED", 10, AMBER, true))
	content.add_child(_label("RUN PAUSED", 32, INK))
	content.add_child(_label("Echo history and charge hold until you resume.", 16, MUTED))
	content.add_child(_spacer(8.0))
	var resume := _button("RESUME RUN", true)
	resume.pressed.connect(_on_resume_pressed)
	content.add_child(resume)
	# Keep this reference separate from the header pause button for focus restoration.
	_resume_button = resume


func _build_upgrade() -> void:
	_upgrade_view = _modal(Vector2(680.0, 500.0))
	var content := _box(12)
	_upgrade_view.add_child(content)
	content.add_child(_label("BETWEEN WAVES / SELECT MODIFICATION", 10, AMBER, true))
	content.add_child(_label("LOADOUT MODIFICATION", 30, INK))
	content.add_child(
		_label(
			"Each modification changes the next wave. Review its effect before committing.",
			14,
			MUTED
		)
	)
	content.add_child(_spacer(4.0))
	for index: int in 3:
		var choice := _button("", false)
		choice.name = "UpgradeChoice%d" % (index + 1)
		choice.custom_minimum_size = Vector2(0.0, 68.0)
		choice.alignment = HORIZONTAL_ALIGNMENT_LEFT
		choice.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		choice.pressed.connect(_on_upgrade_pressed.bind(index))
		content.add_child(choice)
		_upgrade_buttons.append(choice)


func _build_result() -> void:
	_result_view = _modal(Vector2(560.0, 360.0))
	var content := _box(12)
	_result_view.add_child(content)
	content.add_child(_label("RICOCHET RUSH / RUN REPORT", 10, AMBER, true))
	_result_title = _label("RUN COMPLETE", 32, INK)
	content.add_child(_result_title)
	_result_copy = _label("", 15, MUTED)
	content.add_child(_result_copy)
	_result_stats = _label("", 14, INK, true)
	content.add_child(_result_stats)
	_storage_notice = _label("", 12, AMBER)
	_storage_notice.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_storage_notice)
	_storage_notice.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	_storage_notice.offset_left = 28.0
	_storage_notice.offset_right = -28.0
	_storage_notice.offset_top = 72.0
	_storage_notice.offset_bottom = 96.0
	content.add_child(_spacer(4.0))
	_retry_button = _button("RETRY RUN   /   ENTER", true)
	_retry_button.pressed.connect(func() -> void: retry_requested.emit())
	content.add_child(_retry_button)


func _card(minimum: Vector2) -> PanelContainer:
	var card := PanelContainer.new()
	card.custom_minimum_size = minimum
	card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	card.add_theme_stylebox_override("panel", _style(Color.TRANSPARENT, Color.TRANSPARENT, 0, 0))
	return card


func _modal(minimum: Vector2) -> PanelContainer:
	var panel := PanelContainer.new()
	panel.custom_minimum_size = minimum
	panel.mouse_filter = Control.MOUSE_FILTER_STOP
	panel.add_theme_stylebox_override("panel", _style(Color("111416", 0.98), AMBER, 22, 6))
	add_child(panel)
	return panel


func _spacer(height: float) -> Control:
	var spacer := Control.new()
	spacer.custom_minimum_size.y = height
	spacer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return spacer


func _layout() -> void:
	if not is_instance_valid(_title_view):
		return
	_title_view.position = Vector2(maxf(36.0, size.x * 0.075), maxf(116.0, (size.y - 520.0) * 0.5))
	var modal_size := Vector2(500.0, 300.0)
	_pause_view.position = (size - modal_size) * 0.5
	_pause_view.size = modal_size
	var upgrade_size := Vector2(680.0, 500.0)
	_upgrade_view.position = (size - upgrade_size) * 0.5
	_upgrade_view.size = upgrade_size
	var result_size := Vector2(560.0, 360.0)
	_result_view.position = (size - result_size) * 0.5
	_result_view.size = result_size
	if not is_instance_valid(_flight_view):
		return
	_score_card.position = Vector2(28.0, 102.0)
	_score_card.size = Vector2(210.0, 100.0)
	_progress_card.position = Vector2((size.x - 270.0) * 0.5, 102.0)
	_progress_card.size = Vector2(270.0, 42.0)
	_combo_card.position = Vector2(size.x - 268.0, 102.0)
	_combo_card.size = Vector2(240.0, 70.0)
	_health_card.position = Vector2(28.0, size.y - 135.0)
	_health_card.size = Vector2(230.0, 94.0)
	_echo_card.position = Vector2(size.x - 296.0, size.y - 146.0)
	_echo_card.size = Vector2(268.0, 112.0)
	var action_width: float = minf(440.0, size.x - 600.0)
	_action_panel.position = Vector2((size.x - action_width) * 0.5, size.y - 119.0)
	_action_panel.size = Vector2(action_width, 62.0)
	_controls.position = Vector2(28.0, size.y - 34.0)
	_controls.size = Vector2(maxf(300.0, size.x - 56.0), 20.0)
	get_node("TitleFooter").visible = _title_view.visible and size.y >= 700.0


func set_phase(value: int) -> void:
	if _phase == value:
		if value == RicochetGame.Phase.UPGRADING:
			_refresh_upgrade_choices()
		return
	_phase = value
	_title_view.visible = value == RicochetGame.Phase.TITLE
	get_node("TitleFooter").visible = _title_view.visible
	_flight_view.visible = value == RicochetGame.Phase.PLAYING
	_pause_view.visible = value == RicochetGame.Phase.PAUSED
	_upgrade_view.visible = value == RicochetGame.Phase.UPGRADING
	_result_view.visible = value == RicochetGame.Phase.OVER
	_pause_button.text = "RESUME" if value == RicochetGame.Phase.PAUSED else "PAUSE"
	_pause_button.visible = (
		value == RicochetGame.Phase.PLAYING or value == RicochetGame.Phase.PAUSED
	)
	if _title_view.visible:
		_update_title_copy()
		_start_button.grab_focus()
	elif value == RicochetGame.Phase.PLAYING:
		_reset_snapshots()
		_release_gui_focus()
	elif _pause_view.visible:
		_resume_button.grab_focus()
	elif _upgrade_view.visible:
		_refresh_upgrade_choices()
		_focus_first_upgrade()
	elif _result_view.visible:
		_update_result_copy()
		_retry_button.grab_focus()
	_fade_active_view()
	_layout.call_deferred()
	queue_redraw()


func refresh(delta: float) -> void:
	if not is_instance_valid(game):
		return
	_storage_notice.text = game.storage_notice
	_storage_notice.visible = not game.storage_notice.is_empty()
	_sound_button.text = "AUDIO OFF" if game.muted else "AUDIO ON"
	_pause_button.text = "RESUME" if _phase == RicochetGame.Phase.PAUSED else "PAUSE"
	_score_delta_time = maxf(_score_delta_time - maxf(delta, 0.0), 0.0)
	_score_delta.visible = _score_delta_time > 0.0
	_score_delta.modulate.a = clampf(_score_delta_time / 0.75, 0.0, 1.0)
	if _phase == RicochetGame.Phase.UPGRADING:
		_refresh_upgrade_choices()
	if _phase != RicochetGame.Phase.PLAYING:
		return
	var score_delta: int = game.score - _last_score if _last_score >= 0 else 0
	_score_label.text = _number(game.score)
	if score_delta > 0:
		_score_delta.text = "+%s" % _number(score_delta)
		_score_delta_time = 0.75
		_score_delta.visible = true
		_pulse(_score_label)
	_last_score = game.score
	if game.combo != _last_combo:
		if _last_combo >= 0 and game.combo > _last_combo:
			_pulse(_combo_label)
		_last_combo = game.combo
	_combo_card.visible = game.combo_time > 0.0 and game.combo > 0
	if _combo_card.visible:
		_combo_label.text = "CHAIN x%d" % game.combo
		_combo_copy.text = "Window %.1fs  /  finish another target" % game.combo_time
		_combo_label.modulate = AMBER
	else:
		_combo_label.text = "CHAIN STANDBY"
		_combo_copy.text = "Finish a target to start the chain."
		_combo_label.modulate = MUTED
	_wave_label.text = "WAVE %02d" % game.wave
	_level_label.text = "LV %02d" % game.level
	_run_time.text = _time(game.elapsed)
	_xp_value.text = "XP %s / %s" % [_number(game.xp), _number(game.xp_goal)]
	_xp_bar.max_value = maxf(float(game.xp_goal), 1.0)
	_xp_bar.value = clampf(float(game.xp), 0.0, _xp_bar.max_value)
	_update_health()
	_update_dash()
	_update_echo()
	_update_action_prompt()
	_update_title_copy()
	if game.level != _last_level:
		_last_level = game.level
		_pulse(_level_label)
	queue_redraw()


func _update_health() -> void:
	var max_health: int = maxi(game.player.max_health, 1)
	var health: int = clampi(game.player.health, 0, max_health)
	var health_ratio: float = float(health) / float(max_health)
	_health_value.text = "HEALTH %02d / %02d" % [health, max_health]
	var active_color: Color = AMBER if health_ratio <= 0.3 else INK
	for index: int in _health_pips.get_child_count():
		var pip := _health_pips.get_child(index) as ColorRect
		pip.visible = index < max_health
		pip.color = active_color if index < health else Color(BORDER, 0.62)
	_health_value.modulate = AMBER if health_ratio <= 0.3 else INK


func _update_dash() -> void:
	var charge: float = clampf(game.player.dash_charge, 0.0, 1.0)
	_dash_bar.value = charge
	_dash_value.text = (
		"DASH READY / SPACE"
		if is_equal_approx(charge, 1.0)
		else "DASH RECHARGE %02d%%" % roundi(charge * 100.0)
	)
	_dash_value.modulate = AMBER if charge < 1.0 else INK


func _update_echo() -> void:
	var history: float = clampf(game.echo_history, 0.0, 3.0)
	var charge: float = clampf(game.echo_charge, 0.0, 1.0)
	var active: bool = game.active_echoes > 0
	_echo_history_bar.value = history
	_echo_history_value.text = "HISTORY %.1fS / 3.0S" % history
	_echo_charge_bar.value = charge
	_echo_charge_value.text = "CHARGE %03d%%" % roundi(charge * 100.0)
	var status_color := MUTED
	var hint_color := MUTED
	if active:
		_echo_status.text = "REPLAY ACTIVE / %.1fS" % maxf(game.echo_remaining, 0.0)
		_echo_hint.text = "FLANK ITS FIRING LINE FOR SYNC KILLS"
		status_color = CYAN
		hint_color = CYAN
	elif game.echo_ready:
		_echo_status.text = "ECHO READY / E OR RMB"
		_echo_hint.text = "PRESS E OR RMB TO REPLAY 3.0S"
		status_color = CYAN
		hint_color = CYAN
	elif history < 0.65:
		_echo_status.text = "BUILD HISTORY / %.1fS" % history
		_echo_hint.text = "MOVE + FIRE TO REACH 0.65S"
	elif charge < 1.0:
		_echo_status.text = "ECHO RECHARGING / %03d%%" % roundi(charge * 100.0)
		_echo_hint.text = "KEEP MOVING UNTIL ECHO CHARGE RETURNS"
		status_color = CYAN
	else:
		_echo_status.text = "ECHO STANDBY"
		_echo_hint.text = "REPLAY WINDOW UNAVAILABLE"
		status_color = AMBER
	_echo_status.modulate = status_color
	_echo_hint.modulate = hint_color
	_echo_charge_value.modulate = CYAN
	_echo_history_value.modulate = CYAN if history >= 0.65 else MUTED
	if active and not _last_echo_active:
		_pulse(_echo_status)
	if game.echo_ready and not _last_echo_ready:
		_pulse(_echo_status)
	_last_echo_active = active
	_last_echo_ready = game.echo_ready


func _update_action_prompt() -> void:
	var action_key := "LMB"
	var action_title := "FIND THE ANGLE"
	var action_hint := "Hold fire and use the walls."
	var action_color := INK
	if game.active_echoes > 0:
		action_title = "FLANK THE ECHO"
		action_hint = ("Hit the same target from another angle for a SYNC kill.")
		action_color = CYAN
	elif game.echo_ready:
		action_key = "E"
		action_title = "SUMMON YOUR ECHO"
		action_hint = "Move and shoot first; press E to replay your last 3 seconds."
		action_color = CYAN
	elif game.echo_history < 0.65:
		action_key = "E"
		action_title = "BUILD ECHO HISTORY"
		action_hint = (
			"Move and fire for %.1fs before summoning." % maxf(0.65 - game.echo_history, 0.0)
		)
		action_color = CYAN
	elif game.combo_time > 0.0 and game.combo > 0:
		action_title = "MAINTAIN THE CHAIN"
		action_hint = "Finish another target before the %.1fs window closes." % game.combo_time
		action_color = AMBER
	elif game.echo_charge < 1.0:
		action_key = "E"
		action_title = "ECHO RECHARGING"
		action_hint = (
			"Charge %d%%; keep moving until your past self returns."
			% roundi(game.echo_charge * 100.0)
		)
		action_color = AMBER
	elif is_equal_approx(clampf(game.player.dash_charge, 0.0, 1.0), 1.0):
		action_key = "SPACE"
		action_title = "DASH READY"
		action_hint = "Break through danger or reposition before the next shot."
		action_color = AMBER
	_action_hint.text = action_hint
	var signature := "%s|%s" % [action_key, action_title]
	if signature == _action_signature:
		return
	_action_signature = signature
	_action_key.text = action_key
	_action_title.text = action_title
	_action_key_chip.add_theme_stylebox_override("panel", _style(action_color, action_color, 6, 4))
	_action_title.modulate = action_color
	_action_panel.modulate = Color(1.0, 1.0, 1.0, 0.68)
	var tween := create_tween()
	tween.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
	tween.tween_property(_action_panel, "modulate", Color.WHITE, 0.22)


func _update_title_copy() -> void:
	if not is_instance_valid(game) or not is_instance_valid(_title_view):
		return
	var best := get_node_or_null("Title/Best") as Label
	if not is_instance_valid(best):
		return
	best.text = "BEST SCORE / %s" % _number(game.best_score)


func _update_result_copy() -> void:
	if not is_instance_valid(game):
		return
	_result_title.text = "NEW BEST RUN" if game.last_run_new_best else "RUN COMPLETE"
	_result_copy.text = (
		"Record updated. Retry to refine the run."
		if game.last_run_new_best
		else "Run complete. Retry to refine the next angle."
	)
	_result_stats.text = (
		"SCORE %s   /   %d KILLS\nWAVE %02d   /   RUN TIME %s\nECHOES %d   /   SYNC KILLS %d"
		% [
			_number(game.score),
			game.kills,
			game.wave,
			_time(game.elapsed),
			game.echoes_created,
			game.sync_kills,
		]
	)


func _refresh_upgrade_choices() -> void:
	if not is_instance_valid(game):
		return
	for index: int in _upgrade_buttons.size():
		var button := _upgrade_buttons[index]
		var available := index < game.upgrade_choices.size()
		button.visible = available
		if not available:
			continue
		var choice: Dictionary = game.upgrade_choices[index]
		var title := str(choice.get("title", "MODIFICATION"))
		var description := str(choice.get("description", "Select this modification."))
		button.text = "%d   %s\n     %s" % [index + 1, title.to_upper(), description]
		button.disabled = str(choice.get("id", "")).is_empty()


func _on_upgrade_pressed(index: int) -> void:
	if index < 0 or index >= game.upgrade_choices.size():
		return
	var choice: Dictionary = game.upgrade_choices[index]
	var choice_id := StringName(str(choice.get("id", "")))
	if choice_id.is_empty():
		return
	upgrade_chosen.emit(choice_id)
	_restore_phase_focus()


func _on_pause_pressed() -> void:
	resume_requested.emit()


func _on_resume_pressed() -> void:
	resume_requested.emit()


func _on_sound_pressed() -> void:
	sound_requested.emit()
	_restore_phase_focus()


func _release_gui_focus() -> void:
	get_viewport().gui_release_focus()


func _restore_phase_focus() -> void:
	if game.phase == RicochetGame.Phase.TITLE:
		_start_button.grab_focus()
	elif game.phase == RicochetGame.Phase.PLAYING:
		_release_gui_focus()
	elif game.phase == RicochetGame.Phase.PAUSED:
		_resume_button.grab_focus()
	elif game.phase == RicochetGame.Phase.UPGRADING:
		_focus_first_upgrade()
	elif game.phase == RicochetGame.Phase.OVER:
		_retry_button.grab_focus()


func _reset_snapshots() -> void:
	_last_score = game.score
	_last_combo = game.combo
	_last_level = game.level
	_last_echo_active = game.active_echoes > 0
	_last_echo_ready = game.echo_ready
	_score_delta_time = 0.0
	_score_delta.visible = false
	_action_signature = ""


func _focus_first_upgrade() -> void:
	for button: Button in _upgrade_buttons:
		if button.visible and not button.disabled:
			button.grab_focus()
			return


func _pulse(control: Control) -> void:
	var tween := create_tween()
	tween.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	tween.tween_property(control, "scale", Vector2(1.08, 1.08), 0.06)
	tween.tween_property(control, "scale", Vector2.ONE, 0.22)


func _fade_active_view() -> void:
	var active: Control
	if _title_view.visible:
		active = _title_view
	elif _flight_view.visible:
		active = _flight_view
	elif _pause_view.visible:
		active = _pause_view
	elif _upgrade_view.visible:
		active = _upgrade_view
	elif _result_view.visible:
		active = _result_view
	else:
		return
	active.modulate = Color(1.0, 1.0, 1.0, 0.0)
	var tween := create_tween()
	tween.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
	tween.tween_property(active, "modulate", Color.WHITE, 0.24)


func _time(seconds: float) -> String:
	var whole_seconds: int = maxi(0, int(seconds))
	return "%02d:%02d" % [whole_seconds / 60, whole_seconds % 60]


func _number(value: int) -> String:
	if value < 1000:
		return str(value)
	return "%d,%03d" % [value / 1000, value % 1000]


func _draw() -> void:
	if _phase == RicochetGame.Phase.TITLE:
		for index: int in 40:
			var alpha: float = pow(1.0 - float(index) / 40.0, 1.3) * 0.96
			var width: float = size.x * 0.68 / 40.0
			draw_rect(
				Rect2(float(index) * width, 78.0, width + 1.0, size.y - 78.0),
				Color(0.015, 0.018, 0.02, alpha)
			)
	draw_rect(Rect2(0.0, 0.0, size.x, 78.0), Color(DEEP_INK, 0.96))
	draw_line(Vector2(28.0, 78.0), Vector2(size.x - 28.0, 78.0), Color(BORDER, 0.8), 1.0)
	if _phase == RicochetGame.Phase.PAUSED or _phase == RicochetGame.Phase.UPGRADING:
		draw_rect(Rect2(Vector2.ZERO, size), Color(0.01, 0.012, 0.013, 0.74))
	elif _phase == RicochetGame.Phase.OVER:
		draw_rect(Rect2(Vector2.ZERO, size), Color(0.01, 0.012, 0.013, 0.78))
