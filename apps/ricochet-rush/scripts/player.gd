class_name RushPlayer
extends CharacterBody3D

signal health_changed(current: int)
signal died
signal dashed

const PLAYER_LAYER: int = 1
const WORLD_LAYER: int = 1 << 1
const ENEMY_LAYER: int = 1 << 2

const DEFAULT_SPEED: float = 9.0
const ACCELERATION: float = 68.0
const DECELERATION: float = 92.0
const DASH_SPEED: float = 24.0
const DASH_DURATION: float = 0.15
const DASH_COOLDOWN: float = 0.85
const HIT_INVULNERABILITY: float = 0.55
const MODEL_PATH: String = "res://assets/models/player.glb"

var move_input: Vector2 = Vector2.ZERO
var aim_direction: Vector3 = Vector3(0.0, 0.0, -1.0)
var active: bool = true
var speed: float = DEFAULT_SPEED
var max_health: int = 5
var health: int = 5

var dash_charge: float:
	get:
		if DASH_COOLDOWN <= 0.0:
			return 1.0
		return clampf(1.0 - _dash_cooldown_remaining / DASH_COOLDOWN, 0.0, 1.0)

var _collision_shape: CollisionShape3D
var _model_instance: Node
var _dash_remaining: float = 0.0
var _dash_cooldown_remaining: float = 0.0
var _hit_invulnerability_remaining: float = 0.0
var _dash_velocity: Vector3 = Vector3.ZERO
var _dead: bool = false


func _ready() -> void:
	motion_mode = CharacterBody3D.MOTION_MODE_FLOATING
	collision_layer = PLAYER_LAYER
	collision_mask = WORLD_LAYER | ENEMY_LAYER
	safe_margin = 0.02
	max_health = maxi(max_health, 1)
	health = clampi(health, 0, max_health)
	_ensure_collision_shape()
	_ensure_model()
	if health <= 0:
		_dead = true
		active = false
		_disable_body()


func _physics_process(delta: float) -> void:
	var step: float = clampf(delta, 0.0, 0.1)
	_dash_cooldown_remaining = maxf(_dash_cooldown_remaining - step, 0.0)
	_hit_invulnerability_remaining = maxf(_hit_invulnerability_remaining - step, 0.0)
	_face_aim_direction(step)

	if _dash_remaining > 0.0:
		_dash_remaining = maxf(_dash_remaining - step, 0.0)
		collision_mask = WORLD_LAYER
		velocity = _dash_velocity
		move_and_slide()
		velocity.y = 0.0
		if _dash_remaining <= 0.0:
			collision_mask = WORLD_LAYER | ENEMY_LAYER
			velocity = Vector3.ZERO
		return

	collision_mask = WORLD_LAYER | ENEMY_LAYER
	if not active or _dead:
		velocity = Vector3.ZERO
		return

	var input_vector: Vector3 = Vector3(move_input.x, 0.0, move_input.y)
	var input_length: float = input_vector.length()
	if input_length > 1.0:
		input_vector /= input_length
		input_length = 1.0
	var target_velocity: Vector3 = input_vector * maxf(speed, 0.0)
	var response: float = ACCELERATION if input_length > 0.001 else DECELERATION
	velocity.x = move_toward(velocity.x, target_velocity.x, response * step)
	velocity.z = move_toward(velocity.z, target_velocity.z, response * step)
	velocity.y = 0.0
	move_and_slide()
	velocity.y = 0.0


func try_dash() -> bool:
	if not active or _dead or health <= 0:
		return false
	if _dash_remaining > 0.0 or _dash_cooldown_remaining > 0.0001:
		return false
	var direction: Vector3 = _get_dash_direction()
	if direction.length_squared() < 0.0001:
		return false
	_dash_velocity = direction * DASH_SPEED
	_dash_remaining = DASH_DURATION
	_dash_cooldown_remaining = DASH_COOLDOWN
	collision_mask = WORLD_LAYER
	velocity = _dash_velocity
	emit_signal("dashed")
	return true


func take_damage(amount: int = 1) -> bool:
	if amount <= 0 or not active or _dead or health <= 0:
		return false
	if _dash_remaining > 0.0 or _hit_invulnerability_remaining > 0.0:
		return false
	var applied: int = mini(amount, health)
	if applied <= 0:
		return false
	health -= applied
	_hit_invulnerability_remaining = HIT_INVULNERABILITY
	emit_signal("health_changed", health)
	if health <= 0:
		_dead = true
		active = false
		velocity = Vector3.ZERO
		_dash_remaining = 0.0
		_disable_body()
		emit_signal("died")
	return true


func reset_at(point: Vector3) -> void:
	if not _finite_vector(point):
		return
	global_position = point
	velocity = Vector3.ZERO
	move_input = Vector2.ZERO
	health = maxi(max_health, 1)
	active = true
	_dead = false
	_dash_remaining = 0.0
	_dash_cooldown_remaining = 0.0
	_hit_invulnerability_remaining = 0.0
	_dash_velocity = Vector3.ZERO
	collision_layer = PLAYER_LAYER
	collision_mask = WORLD_LAYER | ENEMY_LAYER
	if is_instance_valid(_collision_shape):
		_collision_shape.set_deferred("disabled", false)
	emit_signal("health_changed", health)


func _get_dash_direction() -> Vector3:
	var movement: Vector3 = Vector3(move_input.x, 0.0, move_input.y)
	if _finite_vector(movement) and movement.length_squared() > 0.0001:
		return movement.normalized()
	var facing: Vector3 = Vector3(aim_direction.x, 0.0, aim_direction.z)
	if facing.length_squared() > 0.0001 and _finite_vector(facing):
		return facing.normalized()
	return Vector3(0.0, 0.0, -1.0)


func _face_aim_direction(step: float) -> void:
	var facing: Vector3 = Vector3(aim_direction.x, 0.0, aim_direction.z)
	if not _finite_vector(facing) or facing.length_squared() < 0.0001:
		return
	var yaw: float = atan2(-facing.x, -facing.z)
	rotation.y = lerp_angle(rotation.y, yaw, clampf(step * 18.0, 0.0, 1.0))


func _ensure_collision_shape() -> void:
	for child: Node in get_children():
		if child is CollisionShape3D:
			_collision_shape = child as CollisionShape3D
			break
	if not is_instance_valid(_collision_shape):
		_collision_shape = CollisionShape3D.new()
		_collision_shape.name = "BodyCollision"
		add_child(_collision_shape)
	if _collision_shape.shape == null:
		var capsule: CapsuleShape3D = CapsuleShape3D.new()
		capsule.radius = 0.45
		capsule.height = 1.1
		_collision_shape.shape = capsule
		_collision_shape.position = Vector3(0.0, capsule.height * 0.5, 0.0)


func _ensure_model() -> void:
	if is_instance_valid(_model_instance):
		return
	var existing: Node = get_node_or_null("ModelAsset")
	if is_instance_valid(existing):
		_model_instance = existing
		return
	var packed_model: PackedScene = load(MODEL_PATH) as PackedScene
	if packed_model == null:
		push_error("RushPlayer model is missing or not a PackedScene: %s" % MODEL_PATH)
		return
	_model_instance = packed_model.instantiate()
	_model_instance.name = "ModelAsset"
	add_child(_model_instance)


func _disable_body() -> void:
	collision_layer = 0
	collision_mask = 0
	if is_instance_valid(_collision_shape):
		_collision_shape.set_deferred("disabled", true)


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)
