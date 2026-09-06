class_name RushArena
extends Node3D

## Shared combat arena presentation and physical boundary.
##
## The meshes are authored in Blender and imported as one portable scene. This
## script owns only the collision contract and the fixed Compatibility-friendly
## lighting used by the game.

const ARENA_ART_SCENE: PackedScene = preload("res://assets/models/arena.glb")
const COLLISION_LAYER: int = 2
const INNER_HALF_EXTENTS := Vector2(12.0, 8.0)
const WALL_HEIGHT: float = 1.5
const WALL_THICKNESS: float = 0.56
const FLOOR_THICKNESS: float = 0.2

var arena_art: Node3D


func _ready() -> void:
	_load_arena_art()
	_build_collision()
	_build_environment()
	_build_lighting()


func _load_arena_art() -> void:
	arena_art = ARENA_ART_SCENE.instantiate() as Node3D
	if arena_art == null:
		push_error("RICOCHET arena.glb did not instantiate as a Node3D")
		return
	arena_art.name = "ArenaArt"
	add_child(arena_art)


func _build_collision() -> void:
	_add_static_box(
		"ArenaFloorCollision",
		Vector3(0.0, -FLOOR_THICKNESS * 0.5, 0.0),
		Vector3(INNER_HALF_EXTENTS.x * 2.0, FLOOR_THICKNESS, INNER_HALF_EXTENTS.y * 2.0),
	)
	_add_static_box(
		"ArenaNorthWallCollision",
		Vector3(0.0, WALL_HEIGHT * 0.5, -INNER_HALF_EXTENTS.y - WALL_THICKNESS * 0.5),
		Vector3(INNER_HALF_EXTENTS.x * 2.0 + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS),
	)
	_add_static_box(
		"ArenaSouthWallCollision",
		Vector3(0.0, WALL_HEIGHT * 0.5, INNER_HALF_EXTENTS.y + WALL_THICKNESS * 0.5),
		Vector3(INNER_HALF_EXTENTS.x * 2.0 + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS),
	)
	_add_static_box(
		"ArenaWestWallCollision",
		Vector3(-INNER_HALF_EXTENTS.x - WALL_THICKNESS * 0.5, WALL_HEIGHT * 0.5, 0.0),
		Vector3(WALL_THICKNESS, WALL_HEIGHT, INNER_HALF_EXTENTS.y * 2.0),
	)
	_add_static_box(
		"ArenaEastWallCollision",
		Vector3(INNER_HALF_EXTENTS.x + WALL_THICKNESS * 0.5, WALL_HEIGHT * 0.5, 0.0),
		Vector3(WALL_THICKNESS, WALL_HEIGHT, INNER_HALF_EXTENTS.y * 2.0),
	)


func _add_static_box(node_name: String, center: Vector3, size: Vector3) -> void:
	var body := StaticBody3D.new()
	body.name = node_name
	body.collision_layer = COLLISION_LAYER
	body.collision_mask = 0
	body.position = center
	var collision := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = size
	collision.shape = shape
	body.add_child(collision)
	add_child(body)


func _build_environment() -> void:
	var world_environment := WorldEnvironment.new()
	world_environment.name = "ArenaWorldEnvironment"
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("080909")
	environment.background_energy_multiplier = 0.28
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color("B5AA94")
	environment.ambient_light_energy = 0.46
	environment.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	world_environment.environment = environment
	add_child(world_environment)


func _build_lighting() -> void:
	var key := DirectionalLight3D.new()
	key.name = "ArenaKeyLight"
	key.rotation_degrees = Vector3(-54.0, -28.0, 0.0)
	key.light_color = Color("F2EBDD")
	key.light_energy = 0.92
	key.shadow_enabled = true
	key.directional_shadow_max_distance = 55.0
	add_child(key)

	var warm_fill := OmniLight3D.new()
	warm_fill.name = "ArenaWarmFill"
	warm_fill.position = Vector3(-7.0, 5.0, 5.0)
	warm_fill.light_color = Color("CDBD9E")
	warm_fill.light_energy = 0.18
	warm_fill.omni_range = 26.0
	warm_fill.shadow_enabled = false
	add_child(warm_fill)

	var steel_fill := OmniLight3D.new()
	steel_fill.name = "ArenaSteelFill"
	steel_fill.position = Vector3(7.0, 4.0, -5.0)
	steel_fill.light_color = Color("A8B0AC")
	steel_fill.light_energy = 0.14
	steel_fill.omni_range = 24.0
	steel_fill.shadow_enabled = false
	add_child(steel_fill)


func is_inside_play_area(position: Vector3, margin: float = 0.0) -> bool:
	return (
		absf(position.x) <= INNER_HALF_EXTENTS.x - margin
		and absf(position.z) <= INNER_HALF_EXTENTS.y - margin
	)
