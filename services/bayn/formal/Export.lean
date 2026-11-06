import LeanExport.Basic

open Lean

/-- Select by defining module, including private and internal declarations, never by namespace. -/
def main (args : List String) : IO Unit := do
  let manifest :: modules := args | throw <| IO.userError "expected scope manifest and owned modules"
  if modules.isEmpty then throw <| IO.userError "no owned model modules"
  initSearchPath (← findSysroot)
  let owned := modules.toArray.map String.toName
  let env ← importModules (owned.map fun module => { module }) {}
  let declarations := env.constants.toList.filterMap fun (name, _) => do
    let index ← env.getModuleIdxFor? name
    let module ← env.header.moduleNames[index.toNat]?
    if owned.contains module then some (name, module) else none
  let declarations := declarations.mergeSort fun a b => a.1.toString ≤ b.1.toString
  if declarations.isEmpty then throw <| IO.userError "owned modules have no declarations"
  let scope := Json.mkObj [
    ("modules", toJson modules),
    ("declarations", toJson <| declarations.map fun (name, module) =>
      Json.mkObj [("name", toJson name.toString), ("module", toJson module.toString)])
  ]
  IO.FS.writeFile manifest scope.compress
  IO.eprintln s!"Exporting every declaration from {owned.size} owned modules ({declarations.length} roots), with their full dependencies"
  -- The pinned exporter recursively includes types, values, inductives and every referenced declaration.
  LeanExport.dumpEnv env (some <| declarations.map Prod.fst)
