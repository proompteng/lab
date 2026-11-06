import LeanExport.Basic

open Lean

/-- Select logical roots by defining module; record compiler implementations separately. -/
def main (args : List String) : IO Unit := do
  let manifest :: modules := args | throw <| IO.userError "expected scope manifest and owned modules"
  if modules.isEmpty then throw <| IO.userError "no owned model modules"
  initSearchPath (← findSysroot)
  let owned := modules.toArray.map String.toName
  let env ← importModules (owned.map fun module => { module }) {}
  let ownedDeclarations := env.constants.toList.filterMap fun (name, info) => do
    let index ← env.getModuleIdxFor? name
    let module ← env.header.moduleNames[index.toNat]?
    if owned.contains module then some (name, module, info) else none
  let mut declarations : Array (Name × Name) := #[]
  let mut runtimeImplementations : Array (Name × Name × String) := #[]
  for (name, module, info) in ownedDeclarations do
    let safety := match info with
      | .defnInfo value => if value.safety == .partial then some "partial" else if info.isUnsafe then some "unsafe" else none
      | _ => if info.isUnsafe then some "unsafe" else none
    if let some safety := safety then
      unless name.isInternal do
        throw <| IO.userError s!"Non-logical model declaration: {name}; formal definitions must be total and safe"
      runtimeImplementations := runtimeImplementations.push (name, module, safety)
    else
      declarations := declarations.push (name, module)
  let logicalDeclarations := declarations.toList.mergeSort fun a b => a.1.toString ≤ b.1.toString
  let compiledImplementations := runtimeImplementations.toList.mergeSort fun a b => a.1.toString ≤ b.1.toString
  if logicalDeclarations.isEmpty then throw <| IO.userError "owned modules have no logical declarations"
  let scope := Json.mkObj [
    ("modules", toJson modules),
    ("declarations", toJson <| logicalDeclarations.map fun (name, module) =>
      Json.mkObj [("name", toJson name.toString), ("module", toJson module.toString)]),
    ("runtimeImplementations", toJson <| compiledImplementations.map fun (name, module, safety) =>
      Json.mkObj [("name", toJson name.toString), ("module", toJson module.toString), ("safety", toJson safety)])
  ]
  IO.FS.writeFile manifest scope.compress
  IO.eprintln s!"Exporting all logical declarations from {owned.size} owned modules ({logicalDeclarations.length} roots), with their full dependencies; recording {compiledImplementations.length} compiler implementations separately"
  -- The pinned exporter recursively includes types, values, inductives and every referenced declaration.
  LeanExport.dumpEnv env (some <| logicalDeclarations.map Prod.fst)
