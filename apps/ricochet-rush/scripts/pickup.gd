class_name RushPickup
extends Node3D

signal collected(pickup: RushPickup)

var value: int = 1
var target: RushPlayer
var magnet_radius: float = 3.4
var _age: float = 0.0
var _collected: bool = false
var _visual: MeshInstance3D


func _ready() -> void:
	_visual = MeshInstance3D.new()
	var shape := BoxMesh.new()
	shape.size = Vector3(0.12, 0.24, 0.12)
	_visual.mesh = shape
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.albedo_color = Color("c8b596")
	_visual.material_override = material
	add_child(_visual)


func _physics_process(delta: float) -> void:
	if _collected or not is_instance_valid(target) or not target.active:
		return
	_age += delta
	var destination: Vector3 = target.global_position + Vector3.UP * 0.4
	var offset: Vector3 = destination - global_position
	if offset.length() < magnet_radius:
		global_position = global_position.move_toward(destination, delta * (7.0 + _age * 3.0))
	if _age > 0.1 and global_position.distance_to(destination) < 0.65:
		_collected = true
		collected.emit(self)
		queue_free()


func _process(delta: float) -> void:
	_visual.rotate_y(delta * 1.2)
	_visual.position.y = sin(_age * 3.0) * 0.04
