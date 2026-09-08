class_name RushProjectile
extends Node3D

signal bounced(at: Vector3)
signal struck(at: Vector3)

const PLAYER_LAYER: int = 1
const WORLD_LAYER: int = 1 << 1
const ENEMY_LAYER: int = 1 << 2

const MAX_RAY_STEPS_PER_FRAME: int = 4
const MAX_LIFETIME: float = 4.0
const SURFACE_SKIN: float = 0.012
const MIN_REMAINING_TRAVEL: float = 0.0001
const MAX_SURFACE_REHITS: int = 2

var direction: Vector3 = Vector3(0.0, 0.0, -1.0)
var damage: int = 1
var bounces: int = 0
var hostile: bool = false
var speed: float = 24.0
var has_bounced: bool = false
var from_echo: bool = false

var _exclude_rids: Array[RID] = []
var _remaining_lifetime: float = MAX_LIFETIME
var _finished: bool = false
var _model_instance: MeshInstance3D
var _last_surface_rid: RID
var _last_surface_point: Vector3 = Vector3.ZERO
var _surface_rehits: int = 0
var _visual_from_echo: bool = false


func setup(
	direction: Vector3,
	damage: int,
	bounces: int,
	hostile: bool = false,
	speed: float = 24.0,
	exclude: Array[RID] = []
) -> void:
	self.direction = _normalised_direction(direction)
	self.damage = maxi(damage, 1)
	self.bounces = maxi(bounces, 0)
	self.hostile = hostile
	self.speed = maxf(speed, 0.0)
	has_bounced = false
	_remaining_lifetime = MAX_LIFETIME
	_finished = false
	_exclude_rids.clear()
	for rid: RID in exclude:
		if rid.is_valid() and not _exclude_rids.has(rid):
			_exclude_rids.append(rid)
	if is_instance_valid(_model_instance):
		_update_visual_material()


func _ready() -> void:
	_ensure_visual()
	_orient_tracer()


func _physics_process(delta: float) -> void:
	if _finished:
		return
	if is_instance_valid(_model_instance) and _visual_from_echo != from_echo:
		_update_visual_material()
	var step: float = clampf(delta, 0.0, 0.1)
	_remaining_lifetime -= step
	if _remaining_lifetime <= 0.0:
		_finish()
	elif speed > 0.0:
		if _finite_vector(direction):
			_advance_projectile(speed * step)
			_orient_tracer()
		else:
			_finish()


func _advance_projectile(total_travel: float) -> void:
	var remaining_travel: float = total_travel
	var origin: Vector3 = global_position
	var movement_complete: bool = false
	for _iteration: int in range(MAX_RAY_STEPS_PER_FRAME):
		if movement_complete or _finished:
			break
		if remaining_travel <= MIN_REMAINING_TRAVEL:
			global_position = origin
			movement_complete = true
			continue

		var end: Vector3 = origin + direction * remaining_travel
		var hit: Dictionary = _cast_segment(origin, end)
		if hit.is_empty():
			global_position = end
			movement_complete = true
			continue

		var hit_position: Vector3 = hit["position"]
		var hit_normal: Vector3 = hit["normal"]
		if not _finite_vector(hit_position) or not _finite_vector(hit_normal):
			_finish()
			continue
		var collider: Object = hit.get("collider") as Object
		if _is_damageable(collider):
			global_position = hit_position
			emit_signal("struck", hit_position)
			_finish()
			continue

		if hit_normal.length_squared() < 0.0001:
			_finish()
			continue
		hit_normal = hit_normal.normalized()
		var hit_rid: RID = hit.get("rid", RID())
		if _is_repeated_surface(hit_rid, hit_position):
			global_position = hit_position + hit_normal * SURFACE_SKIN * 2.0
			_finish()
			continue
		_last_surface_rid = hit_rid
		_last_surface_point = hit_position

		var travel_to_hit: float = origin.distance_to(hit_position)
		remaining_travel = maxf(remaining_travel - travel_to_hit, 0.0)
		if bounces <= 0:
			global_position = hit_position
			_finish()
			continue

		bounces -= 1
		has_bounced = true
		direction = direction.bounce(hit_normal).normalized()
		origin = hit_position + hit_normal * SURFACE_SKIN
		global_position = origin
		remaining_travel = maxf(remaining_travel - SURFACE_SKIN, 0.0)
		emit_signal("bounced", hit_position)
		if not _finite_vector(direction):
			_finish()

	if not movement_complete and not _finished:
		global_position = origin


func _cast_segment(from: Vector3, to: Vector3) -> Dictionary:
	var world: World3D = get_world_3d()
	if world == null:
		return {}
	var query: PhysicsRayQueryParameters3D = PhysicsRayQueryParameters3D.create(from, to)
	query.collision_mask = WORLD_LAYER | (PLAYER_LAYER if hostile else ENEMY_LAYER)
	query.exclude = _exclude_rids
	query.collide_with_bodies = true
	query.collide_with_areas = false
	return world.direct_space_state.intersect_ray(query)


func _is_damageable(collider: Object) -> bool:
	if hostile:
		if collider is RushPlayer:
			var player: RushPlayer = collider as RushPlayer
			player.take_damage(damage)
			return true
		return false
	if collider is RushEnemy:
		var enemy: RushEnemy = collider as RushEnemy
		enemy.take_hit(damage, direction, has_bounced, from_echo)
		return true
	return false


func _is_repeated_surface(hit_rid: RID, hit_position: Vector3) -> bool:
	if not hit_rid.is_valid() or not _last_surface_rid.is_valid():
		_surface_rehits = 0
		return false
	if (
		hit_rid != _last_surface_rid
		or hit_position.distance_to(_last_surface_point) > SURFACE_SKIN * 8.0
	):
		_surface_rehits = 0
		return false
	_surface_rehits += 1
	return _surface_rehits >= MAX_SURFACE_REHITS


func _normalised_direction(value: Vector3) -> Vector3:
	if _finite_vector(value) and value.length_squared() > 0.0001:
		return value.normalized()
	return Vector3(0.0, 0.0, -1.0)


func _orient_tracer() -> void:
	var up: Vector3 = Vector3.RIGHT if absf(direction.dot(Vector3.UP)) > 0.99 else Vector3.UP
	_model_instance.basis = Basis.looking_at(direction, up)


func _ensure_visual() -> void:
	if is_instance_valid(_model_instance):
		return
	_model_instance = MeshInstance3D.new()
	_model_instance.name = "GlowProjectile"
	var tracer := BoxMesh.new()
	tracer.size = Vector3(0.055, 0.055, 0.42)
	_model_instance.mesh = tracer
	add_child(_model_instance)
	_update_visual_material()


func _update_visual_material() -> void:
	if not is_instance_valid(_model_instance):
		return
	var material: StandardMaterial3D = StandardMaterial3D.new()
	var color: Color = Color("f2e4c9")
	if hostile:
		color = Color("f18b58")
	if from_echo:
		color = Color("63f4ff")
	material.albedo_color = color
	material.emission_enabled = true
	material.emission = color
	material.emission_energy_multiplier = 0.8
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_model_instance.material_override = material
	_visual_from_echo = from_echo


func _finish() -> void:
	if _finished:
		return
	_finished = true
	queue_free()


func _finite_vector(value: Vector3) -> bool:
	return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)
