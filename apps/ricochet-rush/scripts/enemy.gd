class_name RushEnemy
extends CharacterBody3D

signal killed(enemy: RushEnemy, by_ricochet: bool)
signal damaged(at: Vector3, amount: int)
signal fired(origin: Vector3, direction: Vector3)

enum Kind {
	CHASER,
	RUNNER,
	BRUTE,
	TURRET,
}

const PLAYER_LAYER: int = 1
const WORLD_LAYER: int = 1 << 1
const ENEMY_LAYER: int = 1 << 2

const MODEL_PATHS: Array[String] = [
	"res://assets/models/enemy_chaser.glb",
	"res://assets/models/enemy_runner.glb",
	"res://assets/models/enemy_brute.glb",
	"res://assets/models/enemy_turret.glb",
]
const BASE_HEALTH: Array[int] = [3, 2, 10, 5]
const HEALTH_PER_LEVEL: Array[int] = [1, 1, 2, 1]
const SCORE_VALUES: Array[int] = [100, 140, 260, 180]
const XP_VALUES: Array[int] = [1, 2, 4, 3]
const MOVE_SPEEDS: Array[float] = [3.9, 4.8, 2.0, 0.0]
const CONTACT_DAMAGE: Array[int] = [1, 1, 2, 0]
const BODY_RADII: Array[float] = [0.45, 0.38, 0.68, 0.5]
const BODY_HEIGHTS: Array[float] = [1.3, 0.95, 1.8, 1.25]

const CONTACT_COOLDOWN: float = 0.65
const SEPARATION_RADIUS_PADDING: float = 0.18
const SEPARATION_STRENGTH: float = 7.0
const RECOIL_DECELERATION: float = 26.0

const RUNNER_TELEGRAPH_DURATION: float = 0.42
const RUNNER_LUNGE_DURATION: float = 0.24
const RUNNER_LUNGE_SPEED: float = 15.0
const RUNNER_LUNGE_RECOVERY: float = 1.2
const RUNNER_ACTION_COOLDOWN: float = 1.4

const TURRET_INITIAL_DELAY: float = 0.85
const TURRET_TELEGRAPH_DURATION: float = 0.4
const TURRET_FIRE_COOLDOWN: float = 1.45
const TELEGRAPH_AMBER := Color("e5a34d")
const SYNC_WINDOW: float = 1.2
const DAMAGE_FLASH_DURATION: float = 0.14
const PLAYER_CENTER_HEIGHT: float = 0.925
const FIRE_ORIGIN_MARGIN: float = 0.12

var target: RushPlayer
var health: int = 3
var score_value: int = 100
var xp_value: int = 1
var kind: int = Kind.CHASER
var sync_kill: bool = false

var _level: int = 1
var _configured: bool = false
var _dead: bool = false
var _collision_shape: CollisionShape3D
var _model_instance: Node
var _visual_driver: RushActorVisual
var _model_kind: int = -1
var _aim_direction: Vector3 = Vector3(0.0, 0.0, -1.0)
var _contact_cooldown: float = 0.0
var _recoil_velocity: Vector3 = Vector3.ZERO
var _simulated_time: float = 0.0
var _last_real_hit_time: float = 0.0
var _last_echo_hit_time: float = 0.0
var _has_real_hit: bool = false
var _has_echo_hit: bool = false

var _runner_telegraph_remaining: float = 0.0
var _runner_lunge_remaining: float = 0.0
var _runner_action_cooldown: float = RUNNER_ACTION_COOLDOWN
var _runner_lunge_direction: Vector3 = Vector3(0.0, 0.0, -1.0)
var _runner_orbit_direction: float = 0.0

var _turret_telegraph_remaining: float = 0.0
var _turret_fire_cooldown: float = TURRET_INITIAL_DELAY
var _damage_flash_remaining: float = 0.0
var _visual_time: float = 0.0
var _telegraph_ring: MeshInstance3D
var _telegraph_ray: MeshInstance3D
var _telegraph_ring_material: StandardMaterial3D
var _telegraph_ray_material: StandardMaterial3D


func setup(kind: int, level: int = 1) -> void:
	self.kind = clampi(kind, Kind.CHASER, Kind.TURRET)
	_level = maxi(level, 1)
	health = maxi(BASE_HEALTH[self.kind] + HEALTH_PER_LEVEL[self.kind] * (_level - 1), 1)
	score_value = SCORE_VALUES[self.kind]
	xp_value = XP_VALUES[self.kind]
	sync_kill = false
	_configured = true
	_dead = false
	_contact_cooldown = 0.0
	_recoil_velocity = Vector3.ZERO
	_aim_direction = Vector3(0.0, 0.0, -1.0)
	_simulated_time = 0.0
	_last_real_hit_time = 0.0
	_last_echo_hit_time = 0.0
	_has_real_hit = false
	_has_echo_hit = false
	_runner_telegraph_remaining = 0.0
	_runner_lunge_remaining = 0.0
	_runner_action_cooldown = RUNNER_ACTION_COOLDOWN
	if is_zero_approx(_runner_orbit_direction):
		_runner_orbit_direction = -1.0 if posmod(get_instance_id(), 2) == 0 else 1.0
	_turret_telegraph_remaining = 0.0
	_turret_fire_cooldown = TURRET_INITIAL_DELAY
	_damage_flash_remaining = 0.0
	if is_instance_valid(_visual_driver):
		_visual_driver.reset_motion()
	if is_inside_tree():
		collision_layer = ENEMY_LAYER
		collision_mask = WORLD_LAYER | ENEMY_LAYER | PLAYER_LAYER
		_configure_body_for_kind()
		if is_instance_valid(_collision_shape):
			_collision_shape.set_deferred("disabled", false)
		_ensure_model()


func _ready() -> void:
	motion_mode = CharacterBody3D.MOTION_MODE_FLOATING
	collision_layer = ENEMY_LAYER
	collision_mask = WORLD_LAYER | ENEMY_LAYER | PLAYER_LAYER
	safe_margin = 0.02
	add_to_group("rush_enemies")
	if not _configured:
		setup(kind, _level)
	_configure_body_for_kind()
	_ensure_model()
	_ensure_telegraph_visuals()


func _process(delta: float) -> void:
	var step: float = clampf(delta, 0.0, 0.1)
	_visual_time += step
	_damage_flash_remaining = maxf(_damage_flash_remaining - step, 0.0)
	_update_telegraph_visuals()
	if is_instance_valid(_visual_driver):
		var flash_amount: float = _damage_flash_remaining / DAMAGE_FLASH_DURATION
		_visual_driver.set_flash(flash_amount)


func _physics_process(delta: float) -> void:
	var step: float = clampf(delta, 0.0, 0.1)
	_simulated_time += step
	_contact_cooldown = maxf(_contact_cooldown - step, 0.0)
	_recoil_velocity = _recoil_velocity.move_toward(Vector3.ZERO, RECOIL_DECELERATION * step)
	if _dead:
		return

	if kind == Kind.TURRET:
		_update_turret(step)
		_update_visual(step)
		return
	if not _has_live_target():
		_aim_direction = Vector3.ZERO
		_move_character(Vector3.ZERO, 0.0, step)
		_update_visual(step)
		return

	match kind:
		Kind.RUNNER:
			_update_runner(step)
		Kind.BRUTE:
			_update_chaser(step, MOVE_SPEEDS[Kind.BRUTE])
		_:
			_update_chaser(step, MOVE_SPEEDS[Kind.CHASER])

	_apply_contact_damage()
	_aim_direction = _direction_to_target()
	_update_visual(step)


func take_hit(damage: int, direction: Vector3, ricochet: bool, by_echo: bool = false) -> bool:
	if damage <= 0 or _dead or health <= 0:
		return false
	var applied: int = mini(damage, health)
	if applied <= 0:
		return false
	var synchronized: bool = _record_hit_source(by_echo)
	health -= applied
	_damage_flash_remaining = DAMAGE_FLASH_DURATION
	var knockback_direction: Vector3 = Vector3(direction.x, 0.0, direction.z)
	if _finite_vector(knockback_direction) and knockback_direction.length_squared() > 0.0001:
		_recoil_velocity += knockback_direction.normalized() * minf(8.0, 1.5 + float(applied))
	emit_signal("damaged", global_position + Vector3.UP * BODY_HEIGHTS[kind] * 0.65, applied)
	if health <= 0:
		sync_kill = synchronized
		_kill(ricochet)
	return true


func get_collision_radius() -> float:
	return BODY_RADII[clampi(kind, Kind.CHASER, Kind.TURRET)]


func _update_chaser(step: float, move_speed: float) -> void:
	var direction: Vector3 = _direction_to_target()
	_move_character(direction, move_speed, step)


func _update_runner(step: float) -> void:
	if _runner_lunge_remaining > 0.0:
		_runner_lunge_remaining = maxf(_runner_lunge_remaining - step, 0.0)
		_move_character(_runner_lunge_direction, RUNNER_LUNGE_SPEED, step)
		if _runner_lunge_remaining <= 0.0:
			_runner_action_cooldown = RUNNER_LUNGE_RECOVERY
		return

	if _runner_telegraph_remaining > 0.0:
		_runner_telegraph_remaining = maxf(_runner_telegraph_remaining - step, 0.0)
		var retreat_direction: Vector3 = -_direction_to_target()
		_move_character(retreat_direction, MOVE_SPEEDS[Kind.RUNNER] * 0.3, step)
		if _runner_telegraph_remaining <= 0.0:
			_runner_lunge_direction = _direction_to_target()
			if _runner_lunge_direction.length_squared() > 0.0001:
				_runner_lunge_remaining = RUNNER_LUNGE_DURATION
		return

	_runner_action_cooldown = maxf(_runner_action_cooldown - step, 0.0)
	var target_offset: Vector3 = _flat_target_offset()
	var distance: float = target_offset.length()
	var desired_direction: Vector3 = _direction_to_target()
	if distance < 4.3:
		desired_direction = -desired_direction
	elif distance <= 6.6:
		var tangent: Vector3 = Vector3(-desired_direction.z, 0.0, desired_direction.x)
		desired_direction = tangent * _runner_orbit_direction
	_move_character(desired_direction, MOVE_SPEEDS[Kind.RUNNER], step)
	if _runner_action_cooldown <= 0.0 and distance > 0.5:
		_runner_telegraph_remaining = RUNNER_TELEGRAPH_DURATION
		_runner_action_cooldown = RUNNER_ACTION_COOLDOWN


func _update_turret(step: float) -> void:
	velocity = Vector3.ZERO
	if not _has_live_target():
		_aim_direction = Vector3.ZERO
		_turret_telegraph_remaining = 0.0
		return
	var target_point: Vector3 = target.global_position + Vector3.UP * PLAYER_CENTER_HEIGHT
	var direction: Vector3 = _direction_to_target()
	var origin: Vector3 = _muzzle_origin(direction)
	var to_target: Vector3 = target_point - origin
	if _finite_vector(to_target) and to_target.length_squared() > 0.0001:
		direction = to_target.normalized()
	_aim_direction = direction
	_face_direction(Vector3(direction.x, 0.0, direction.z), step)
	_muzzle_origin(_aim_direction)
	if _turret_telegraph_remaining > 0.0:
		_turret_telegraph_remaining = maxf(_turret_telegraph_remaining - step, 0.0)
		if _turret_telegraph_remaining <= 0.0:
			var fire_origin: Vector3 = _muzzle_origin(_aim_direction)
			var fire_direction: Vector3 = target_point - fire_origin
			if _finite_vector(fire_direction) and fire_direction.length_squared() > 0.0001:
				fire_direction = fire_direction.normalized()
				_aim_direction = fire_direction
				fire_origin = _muzzle_origin(fire_direction)
				fire_direction = target_point - fire_origin
				if _finite_vector(fire_direction) and fire_direction.length_squared() > 0.0001:
					emit_signal("fired", fire_origin, fire_direction.normalized())
			_turret_fire_cooldown = TURRET_FIRE_COOLDOWN
		return

	_turret_fire_cooldown = maxf(_turret_fire_cooldown - step, 0.0)
	if _turret_fire_cooldown <= 0.0:
		_turret_telegraph_remaining = TURRET_TELEGRAPH_DURATION


func _record_hit_source(by_echo: bool) -> bool:
	if by_echo:
		_last_echo_hit_time = _simulated_time
		_has_echo_hit = true
	else:
		_last_real_hit_time = _simulated_time
		_has_real_hit = true
	return (
		_has_real_hit
		and _has_echo_hit
		and absf(_last_real_hit_time - _last_echo_hit_time) <= SYNC_WINDOW
	)


func _muzzle_origin(direction: Vector3) -> Vector3:
	var safe_direction: Vector3 = direction
	if not _finite_vector(safe_direction) or safe_direction.length_squared() < 0.0001:
		safe_direction = Vector3(0.0, 0.0, -1.0)
	else:
		safe_direction = safe_direction.normalized()
	if (
		is_instance_valid(_visual_driver)
		and _visual_driver.marker_contract_valid
		and _visual_driver.has_muzzle()
	):
		_visual_driver.set_weapon_aim(safe_direction)
		return _clamp_fire_origin(_visual_driver.muzzle_global_position())
	return Vector3.INF


func _clamp_fire_origin(value: Vector3) -> Vector3:
	if not _finite_vector(value):
		return Vector3.INF
	var half_extents: Vector2 = RushArena.INNER_HALF_EXTENTS
	return Vector3(
		clampf(value.x, -half_extents.x + FIRE_ORIGIN_MARGIN, half_extents.x - FIRE_ORIGIN_MARGIN),
		maxf(value.y, 0.05),
		clampf(value.z, -half_extents.y + FIRE_ORIGIN_MARGIN, half_extents.y - FIRE_ORIGIN_MARGIN)
	)


func _ensure_telegraph_visuals() -> void:
	if is_instance_valid(_telegraph_ring):
		return
	_telegraph_ring = MeshInstance3D.new()
	_telegraph_ring.name = "AttackTelegraphRing"
	var ring_mesh := TorusMesh.new()
	ring_mesh.inner_radius = 0.46
	ring_mesh.outer_radius = 0.5
	ring_mesh.rings = 18
	ring_mesh.ring_segments = 8
	_telegraph_ring.mesh = ring_mesh
	_telegraph_ring.position = Vector3(0.0, 0.04, 0.0)
	_telegraph_ring_material = _unshaded_alpha_material(TELEGRAPH_AMBER, 0.0)
	_telegraph_ring.material_override = _telegraph_ring_material
	_telegraph_ring.visible = false
	add_child(_telegraph_ring)

	_telegraph_ray = MeshInstance3D.new()
	_telegraph_ray.name = "AttackTelegraphRay"
	var ray_mesh := BoxMesh.new()
	ray_mesh.size = Vector3(0.06, 0.045, 1.0)
	_telegraph_ray.mesh = ray_mesh
	_telegraph_ray_material = _unshaded_alpha_material(TELEGRAPH_AMBER, 0.0)
	_telegraph_ray.material_override = _telegraph_ray_material
	_telegraph_ray.visible = false
	add_child(_telegraph_ray)


func _update_telegraph_visuals() -> void:
	if not is_instance_valid(_telegraph_ring) or not is_instance_valid(_telegraph_ray):
		return
	if _dead:
		_telegraph_ring.visible = false
		_telegraph_ray.visible = false
		return
	var runner_active: bool = kind == Kind.RUNNER and _runner_telegraph_remaining > 0.0
	var turret_active: bool = kind == Kind.TURRET and _turret_telegraph_remaining > 0.0
	var active: bool = runner_active or turret_active
	_telegraph_ring.visible = active
	_telegraph_ray.visible = active
	if not active:
		return
	var duration: float = RUNNER_TELEGRAPH_DURATION if runner_active else TURRET_TELEGRAPH_DURATION
	var remaining: float = (
		_runner_telegraph_remaining if runner_active else _turret_telegraph_remaining
	)
	var progress: float = clampf(remaining / duration, 0.0, 1.0)
	var pulse: float = 0.5 + 0.5 * sin(_visual_time * 24.0)
	var alpha: float = 0.22 + pulse * 0.35 + (1.0 - progress) * 0.16
	var color := TELEGRAPH_AMBER
	_telegraph_ring_material.albedo_color = _with_alpha(color, alpha)
	_telegraph_ring.global_position = global_position + Vector3.UP * 0.04
	var ring_scale: float = 1.0 + pulse * 0.08 + (1.0 - progress) * 0.16
	_telegraph_ring.scale = Vector3.ONE * ring_scale
	_telegraph_ray_material.albedo_color = _with_alpha(color, alpha * 0.75)
	var direction: Vector3 = _aim_direction if turret_active else _direction_to_target()
	direction.y = 0.0
	if not _finite_vector(direction) or direction.length_squared() < 0.0001:
		_telegraph_ray.visible = false
		return
	direction = direction.normalized()
	var ray_length: float = 3.6 if turret_active else 1.35
	var origin_height: float = 0.82 if turret_active else 0.14
	var origin := global_position + Vector3.UP * origin_height
	_telegraph_ray.global_position = origin + direction * (ray_length * 0.5)
	_telegraph_ray.global_rotation = Vector3(0.0, atan2(-direction.x, -direction.z), 0.0)
	_telegraph_ray.scale = Vector3(1.0, 1.0, ray_length)


func _unshaded_alpha_material(color: Color, alpha: float) -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.albedo_color = _with_alpha(color, alpha)
	return material


func _with_alpha(color: Color, alpha: float) -> Color:
	return Color(color.r, color.g, color.b, clampf(alpha, 0.0, 1.0))


func _move_character(direction: Vector3, move_speed: float, step: float) -> void:
	var desired_direction: Vector3 = direction
	if not _finite_vector(desired_direction):
		desired_direction = Vector3.ZERO
	if desired_direction.length_squared() > 0.0001:
		desired_direction = desired_direction.normalized()
		_face_direction(desired_direction, step)
	var separation: Vector3 = _separation_vector()
	var desired_velocity: Vector3 = desired_direction * maxf(move_speed, 0.0)
	desired_velocity += separation * SEPARATION_STRENGTH
	desired_velocity += _recoil_velocity
	desired_velocity.y = 0.0
	velocity = desired_velocity
	move_and_slide()
	velocity.y = 0.0


func _apply_contact_damage() -> void:
	if CONTACT_DAMAGE[kind] <= 0 or not _has_live_target() or _contact_cooldown > 0.0:
		return
	var offset: Vector3 = _flat_target_offset()
	var contact_distance: float = BODY_RADII[kind] + 0.45 + 0.08
	if offset.length_squared() > contact_distance * contact_distance:
		return
	var applied: bool = target.take_damage(CONTACT_DAMAGE[kind])
	_contact_cooldown = CONTACT_COOLDOWN if applied else 0.12


func _separation_vector() -> Vector3:
	var result: Vector3 = Vector3.ZERO
	var own_radius: float = BODY_RADII[kind]
	for peer_variant: Variant in get_tree().get_nodes_in_group("rush_enemies"):
		if not peer_variant is RushEnemy:
			continue
		var peer: RushEnemy = peer_variant as RushEnemy
		if not is_instance_valid(peer) or peer == self or peer._dead:
			continue
		var offset: Vector3 = global_position - peer.global_position
		offset.y = 0.0
		var distance: float = offset.length()
		var minimum_distance: float = (
			own_radius + peer.get_collision_radius() + SEPARATION_RADIUS_PADDING
		)
		if distance <= 0.001:
			result += Vector3.RIGHT
		elif distance < minimum_distance:
			result += offset.normalized() * ((minimum_distance - distance) / minimum_distance)
	return result.limit_length(1.0)


func _direction_to_target() -> Vector3:
	if not _has_live_target():
		return Vector3.ZERO
	var offset: Vector3 = _flat_target_offset()
	if offset.length_squared() < 0.0001:
		return Vector3.ZERO
	return offset.normalized()


func _flat_target_offset() -> Vector3:
	if not is_instance_valid(target):
		return Vector3.ZERO
	var offset: Vector3 = target.global_position - global_position
	offset.y = 0.0
	return offset


func _has_live_target() -> bool:
	return is_instance_valid(target) and target.active and target.health > 0


func _face_direction(direction: Vector3, step: float) -> void:
	if direction.length_squared() < 0.0001 or not _finite_vector(direction):
		return
	var yaw: float = atan2(-direction.x, -direction.z)
	rotation.y = lerp_angle(rotation.y, yaw, clampf(step * 14.0, 0.0, 1.0))


func _configure_body_for_kind() -> void:
	if not is_instance_valid(_collision_shape):
		for child: Node in get_children():
			if child is CollisionShape3D:
				_collision_shape = child as CollisionShape3D
				break
	if not is_instance_valid(_collision_shape):
		_collision_shape = CollisionShape3D.new()
		_collision_shape.name = "BodyCollision"
		add_child(_collision_shape)
	var capsule: CapsuleShape3D = _collision_shape.shape as CapsuleShape3D
	if capsule == null:
		capsule = CapsuleShape3D.new()
		_collision_shape.shape = capsule
	capsule.radius = BODY_RADII[kind]
	capsule.height = BODY_HEIGHTS[kind]
	_collision_shape.position = Vector3(0.0, capsule.height * 0.5, 0.0)


func _ensure_model() -> void:
	if _model_kind == kind and is_instance_valid(_model_instance):
		_ensure_visual_driver()
		return
	if is_instance_valid(_model_instance):
		if _model_instance.get_parent() == self:
			remove_child(_model_instance)
		_model_instance.free()
		_model_instance = null
		_model_kind = -1
	var existing: Node = get_node_or_null("ModelAsset")
	if is_instance_valid(existing):
		_model_instance = existing
		_model_kind = kind
		_ensure_visual_driver()
		return
	var model_path: String = MODEL_PATHS[kind]
	var packed_model: PackedScene = load(model_path) as PackedScene
	if packed_model == null:
		push_error("RushEnemy model is missing or not a PackedScene: %s" % model_path)
		return
	_model_instance = packed_model.instantiate()
	_model_instance.name = "ModelAsset"
	_model_kind = kind
	add_child(_model_instance)
	_ensure_visual_driver()


func _ensure_visual_driver() -> void:
	if not is_instance_valid(_model_instance):
		return
	if not is_instance_valid(_visual_driver):
		_visual_driver = RushActorVisual.new()
		_visual_driver.name = "ActorVisual"
		_visual_driver.process_mode = Node.PROCESS_MODE_DISABLED
		add_child(_visual_driver)
	_visual_driver.bind_model(_model_instance)


func _update_visual(step: float) -> void:
	if not is_instance_valid(_visual_driver):
		return
	_visual_driver.step(step, velocity, _aim_direction)


func _kill(by_ricochet: bool) -> void:
	if _dead:
		return
	_dead = true
	health = 0
	velocity = Vector3.ZERO
	collision_layer = 0
	collision_mask = 0
	if is_instance_valid(_collision_shape):
		_collision_shape.set_deferred("disabled", true)
	emit_signal("killed", self, by_ricochet)
	queue_free()


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)
