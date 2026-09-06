class_name SalvageTug
extends RigidBody2D

signal hull_changed(value: float)
signal destroyed

const HULL_MAX: float = 100.0
const FUEL_MAX: float = 100.0
const MASS: float = 3.2
const MAX_THRUST_FORCE: float = 275.0
const BOOST_MULTIPLIER: float = 1.55
const BOOST_FUEL_PER_SECOND: float = 14.0
const MAX_CRUISE_SPEED: float = 420.0
const CRUISE_SPEED_BAND: float = 90.0
const TURN_TORQUE: float = 700.0
const BRAKE_ACCELERATION: float = 2.8
const ANGULAR_BRAKE_TORQUE: float = 160.0
const IMPACT_SPEED_THRESHOLD: float = 72.0
const IMPACT_DAMAGE_PER_SPEED: float = 0.105
const MAX_IMPACT_DAMAGE: float = 28.0
const IMPACT_COOLDOWN: float = 0.22
const IMPACT_ARM_DELAY_FRAMES: int = 3

var hull: float = HULL_MAX
var fuel: float = FUEL_MAX
var controls_enabled: bool = false
var engine_power: float = 1.0
var input_thrust: float = 0.0
var input_turn: float = 0.0
var input_brake: bool = false
var input_boost: bool = false

var forward: Vector2:
	get:
		return Vector2.RIGHT.rotated(rotation)

var _visual_time: float = 0.0
var _impact_cooldown: float = 0.0
var _spawn_frame: int = 0
var _impact_monitor_armed: bool = false
var _destroyed: bool = false
var _hull_collision: CollisionShape2D


func _ready() -> void:
	mass = MASS
	gravity_scale = 0.0
	linear_damp = 0.08
	angular_damp = 0.6
	collision_layer = 1
	collision_mask = 6
	continuous_cd = RigidBody2D.CCD_MODE_CAST_SHAPE
	contact_monitor = true
	max_contacts_reported = 8
	_hull_collision = _find_or_create_collision_shape()
	var rectangle: RectangleShape2D = RectangleShape2D.new()
	rectangle.size = Vector2(46.0, 30.0)
	_hull_collision.shape = rectangle
	_spawn_frame = Engine.get_physics_frames()
	body_entered.connect(_on_body_entered)
	queue_redraw()


func _process(delta: float) -> void:
	_visual_time = fmod(_visual_time + maxf(delta, 0.0), TAU)
	queue_redraw()


func _physics_process(delta: float) -> void:
	_impact_cooldown = maxf(_impact_cooldown - maxf(delta, 0.0), 0.0)
	if not _impact_monitor_armed:
		_impact_monitor_armed = (
			Engine.get_physics_frames() >= _spawn_frame + IMPACT_ARM_DELAY_FRAMES
		)

	if _destroyed or not controls_enabled:
		return

	var thrust: float = clampf(input_thrust, -1.0, 1.0)
	var turn: float = clampf(input_turn, -1.0, 1.0)
	var power: float = maxf(engine_power, 0.0)
	var boost_active: bool = input_boost and thrust > 0.0 and fuel > 0.0
	var thrust_multiplier: float = BOOST_MULTIPLIER if boost_active else 1.0
	if boost_active:
		fuel = maxf(fuel - BOOST_FUEL_PER_SECOND * maxf(delta, 0.0), 0.0)

	var thrust_scale: float = 1.0
	var forward_speed: float = linear_velocity.dot(forward)
	if thrust > 0.0 and forward_speed > MAX_CRUISE_SPEED:
		thrust_scale = clampf(
			1.0 - (forward_speed - MAX_CRUISE_SPEED) / CRUISE_SPEED_BAND, 0.0, 1.0
		)

	var drive_force: Vector2 = (
		forward * MAX_THRUST_FORCE * thrust * power * thrust_multiplier * thrust_scale
	)
	if _finite_vector(drive_force):
		apply_central_force(drive_force)

	if absf(turn) > 0.001:
		apply_torque(turn * TURN_TORQUE * power)

	if input_brake:
		var velocity: Vector2 = linear_velocity
		if _finite_vector(velocity) and velocity.length_squared() > 0.01:
			apply_central_force(-velocity * mass * BRAKE_ACCELERATION)
		if is_finite(angular_velocity) and absf(angular_velocity) > 0.001:
			apply_torque(-angular_velocity * ANGULAR_BRAKE_TORQUE * mass)


func reset_at(position: Vector2) -> void:
	if not _finite_vector(position):
		return
	global_position = position
	rotation = 0.0
	linear_velocity = Vector2.ZERO
	angular_velocity = 0.0
	sleeping = false
	hull = HULL_MAX
	fuel = FUEL_MAX
	controls_enabled = false
	input_thrust = 0.0
	input_turn = 0.0
	input_brake = false
	input_boost = false
	_destroyed = false
	_impact_cooldown = 0.0
	emit_signal("hull_changed", hull)
	queue_redraw()


func repair_and_refuel() -> void:
	hull = HULL_MAX
	fuel = FUEL_MAX
	_destroyed = false
	sleeping = false
	emit_signal("hull_changed", hull)
	queue_redraw()


func take_damage(amount: float) -> void:
	if _destroyed or not is_finite(amount) or amount <= 0.0:
		return
	hull = clampf(hull - amount, 0.0, HULL_MAX)
	emit_signal("hull_changed", hull)
	if hull <= 0.0:
		_destroyed = true
		controls_enabled = false
		input_thrust = 0.0
		input_turn = 0.0
		input_brake = false
		input_boost = false
		emit_signal("destroyed")
	queue_redraw()


func _find_or_create_collision_shape() -> CollisionShape2D:
	for child: Node in get_children():
		if child is CollisionShape2D:
			return child as CollisionShape2D
	var collision: CollisionShape2D = CollisionShape2D.new()
	collision.name = "HullCollision"
	add_child(collision)
	return collision


func _on_body_entered(body: Node) -> void:
	if not _impact_monitor_armed or _destroyed or _impact_cooldown > 0.0:
		return
	var other_velocity: Vector2 = Vector2.ZERO
	if body is RigidBody2D:
		other_velocity = (body as RigidBody2D).linear_velocity
	if not _finite_vector(linear_velocity) or not _finite_vector(other_velocity):
		return
	var relative_speed: float = (linear_velocity - other_velocity).length()
	if not is_finite(relative_speed) or relative_speed <= IMPACT_SPEED_THRESHOLD:
		return
	var damage: float = clampf(
		(relative_speed - IMPACT_SPEED_THRESHOLD) * IMPACT_DAMAGE_PER_SPEED, 0.5, MAX_IMPACT_DAMAGE
	)
	_impact_cooldown = IMPACT_COOLDOWN
	take_damage(damage)


func _finite_vector(value: Vector2) -> bool:
	return is_finite(value.x) and is_finite(value.y)


func _draw() -> void:
	var damage_alpha: float = clampf(hull / HULL_MAX, 0.35, 1.0)
	var shadow: PackedVector2Array = PackedVector2Array(
		[
			Vector2(-25.0, -10.0),
			Vector2(9.0, -16.0),
			Vector2(24.0, -8.0),
			Vector2(27.0, 0.0),
			Vector2(24.0, 8.0),
			Vector2(9.0, 16.0),
			Vector2(-25.0, 12.0),
			Vector2(-28.0, 4.0),
			Vector2(-28.0, -5.0),
		]
	)
	draw_colored_polygon(_offset_polygon(shadow, Vector2(-1.0, 3.0)), Color(0.02, 0.03, 0.04, 0.6))

	var hull_shape: PackedVector2Array = PackedVector2Array(
		[
			Vector2(-24.0, -12.0),
			Vector2(7.0, -15.0),
			Vector2(21.0, -9.0),
			Vector2(26.0, -3.0),
			Vector2(26.0, 4.0),
			Vector2(18.0, 10.0),
			Vector2(7.0, 14.0),
			Vector2(-24.0, 11.0),
			Vector2(-27.0, 4.0),
			Vector2(-27.0, -5.0),
		]
	)
	var hull_color: Color = Color(0.84, 0.82, 0.74, damage_alpha)
	draw_colored_polygon(hull_shape, hull_color)
	draw_polyline(_closed_polygon(hull_shape), Color(0.16, 0.18, 0.2, damage_alpha), 1.8, true)

	# Orange service spine and reinforced nose make the direction of travel obvious.
	var orange: Color = Color(0.95, 0.38, 0.08, damage_alpha)
	var orange_dark: Color = Color(0.63, 0.18, 0.04, damage_alpha)
	draw_colored_polygon(
		PackedVector2Array(
			[
				Vector2(8.0, -14.0),
				Vector2(20.0, -8.0),
				Vector2(24.0, -3.0),
				Vector2(11.0, -4.0),
				Vector2(3.0, -8.0),
			]
		),
		orange
	)
	draw_colored_polygon(
		PackedVector2Array(
			[
				Vector2(11.0, 4.0),
				Vector2(25.0, 4.0),
				Vector2(18.0, 10.0),
				Vector2(7.0, 13.0),
			]
		),
		orange_dark
	)
	draw_line(
		Vector2(20.0, -7.0), Vector2(25.0, -2.0), Color(1.0, 0.68, 0.23, damage_alpha), 1.4, true
	)
	draw_line(
		Vector2(22.0, 0.0), Vector2(26.0, 0.0), Color(1.0, 0.78, 0.38, damage_alpha), 1.6, true
	)

	# Armored cockpit glazing, with a small reflected highlight.
	draw_colored_polygon(
		PackedVector2Array(
			[
				Vector2(4.0, -10.0),
				Vector2(12.0, -8.0),
				Vector2(17.0, -3.0),
				Vector2(4.0, -4.0),
				Vector2(-1.0, -7.0),
			]
		),
		Color(0.06, 0.16, 0.2, damage_alpha)
	)
	draw_polyline(
		PackedVector2Array(
			[
				Vector2(4.0, -10.0),
				Vector2(12.0, -8.0),
				Vector2(17.0, -3.0),
			]
		),
		Color(0.43, 0.78, 0.81, damage_alpha),
		1.0,
		true
	)
	draw_line(
		Vector2(5.0, -8.0), Vector2(10.0, -7.0), Color(0.8, 0.95, 0.91, damage_alpha), 1.0, true
	)

	# Utility pods, panel seams, and hazard markings.
	draw_rect(Rect2(-18.0, -7.0, 13.0, 14.0), Color(0.4, 0.43, 0.43, damage_alpha), true)
	draw_rect(Rect2(-17.0, -5.5, 9.0, 11.0), Color(0.63, 0.63, 0.57, damage_alpha), true)
	draw_line(
		Vector2(-3.0, -13.0), Vector2(-3.0, 12.0), Color(0.22, 0.24, 0.25, damage_alpha), 1.0, true
	)
	draw_line(
		Vector2(-1.0, 0.0), Vector2(8.0, 0.0), Color(0.22, 0.24, 0.25, damage_alpha), 1.0, true
	)
	for index: int in range(3):
		var x: float = -14.0 + float(index) * 3.0
		draw_line(Vector2(x, -7.0), Vector2(x + 4.0, 7.0), orange, 1.5, true)
	draw_circle(Vector2(-19.0, -9.0), 1.6, Color(0.98, 0.69, 0.28, damage_alpha))
	draw_circle(Vector2(-19.0, 9.0), 1.6, Color(0.98, 0.69, 0.28, damage_alpha))

	# Animated rear thruster. It stays behind the hull so the silhouette reads in motion.
	var thrust_level: float = (
		clampf(absf(input_thrust), 0.0, 1.0) if controls_enabled and not _destroyed else 0.0
	)
	var pulse: float = 0.5 + 0.5 * sin(_visual_time * 18.0)
	var flame_length: float = 5.0 + (9.0 + 5.0 * pulse) * thrust_level
	if flame_length > 5.2:
		draw_colored_polygon(
			PackedVector2Array(
				[
					Vector2(-22.0, -5.0),
					Vector2(-22.0, 5.0),
					Vector2(-22.0 - flame_length, 0.0),
				]
			),
			Color(1.0, 0.48, 0.09, 0.28)
		)
		draw_colored_polygon(
			PackedVector2Array(
				[
					Vector2(-23.0, -3.0),
					Vector2(-23.0, 3.0),
					Vector2(-22.0 - flame_length * 0.72, 0.0),
				]
			),
			Color(1.0, 0.85, 0.35, 0.9)
		)
	draw_circle(Vector2(-23.0, 0.0), 3.5, Color(1.0, 0.48, 0.08, 0.4 + 0.2 * pulse))
	draw_circle(Vector2(-23.0, 0.0), 1.8, Color(1.0, 0.9, 0.54, 0.95))

	# Hull status indicator remains visible in the body itself for low-HUD play.
	var status_color: Color = Color(0.35, 0.9, 0.55, damage_alpha)
	if hull < 40.0:
		status_color = Color(1.0, 0.27, 0.12, damage_alpha)
	draw_circle(Vector2(1.0, 9.0), 1.8, status_color)


func _offset_polygon(polygon: PackedVector2Array, offset: Vector2) -> PackedVector2Array:
	var shifted: PackedVector2Array = PackedVector2Array()
	for point: Vector2 in polygon:
		shifted.append(point + offset)
	return shifted


func _closed_polygon(polygon: PackedVector2Array) -> PackedVector2Array:
	var closed: PackedVector2Array = PackedVector2Array(polygon)
	if not polygon.is_empty():
		closed.append(polygon[0])
	return closed
