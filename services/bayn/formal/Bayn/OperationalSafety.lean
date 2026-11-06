module
import Lean.Elab.Tactic.Omega

@[expose] public section
namespace Bayn

def nativeSafetyJournalInsertAllowed (triggerDepth : Nat) : Bool := triggerDepth > 1

theorem direct_safety_insert_cannot_manufacture_evidence :
    nativeSafetyJournalInsertAllowed 1 = false := by decide

theorem native_safety_insert_requires_original_trigger (depth : Nat)
    (allowed : nativeSafetyJournalInsertAllowed depth = true) : 1 < depth := by
  simpa [nativeSafetyJournalInsertAllowed] using allowed

def safetyKinds : List String := ["UNAUTHORIZED_ACTION", "DUPLICATE_ECONOMIC_EFFECT",
  "INVALID_LEDGER_ADMISSION", "INVALID_OWNERSHIP", "RISK_LIMIT_VIOLATION", "IDENTITY_MISMATCH"]

structure SafetyCheck where
  kind : String
  status : String
  deriving Repr

def nativeSafetyComplete (checks : List SafetyCheck) : Bool :=
  safetyKinds.all (fun kind => checks.any (fun check => check.kind == kind)) &&
  checks.all (fun check => check.status != "INCOMPLETE")

def nativeSafetyPass (checks : List SafetyCheck) : Bool :=
  nativeSafetyComplete checks && checks.all (fun check => check.status != "VIOLATION")

theorem native_safety_requires_every_class (checks : List SafetyCheck)
    (complete : nativeSafetyComplete checks = true) (kind : String) (required : kind ∈ safetyKinds) :
    ∃ check ∈ checks, check.kind = kind := by
  have h := (Bool.and_eq_true_iff.mp complete).1
  have found := List.all_eq_true.mp h kind required
  simpa only [List.any_eq_true, beq_iff_eq] using found

theorem native_safety_missing_evidence_cannot_pass (checks : List SafetyCheck) (check : SafetyCheck)
    (present : check ∈ checks) (missing : check.status = "INCOMPLETE") :
    nativeSafetyPass checks = false := by
  cases h : nativeSafetyPass checks with
  | false => rfl
  | true =>
    have complete := (Bool.and_eq_true_iff.mp h).1
    have covered := List.all_eq_true.mp (Bool.and_eq_true_iff.mp complete).2 check present
    simp [missing] at covered

theorem native_safety_known_violation_cannot_pass (checks : List SafetyCheck) (check : SafetyCheck)
    (present : check ∈ checks) (violated : check.status = "VIOLATION") :
    nativeSafetyPass checks = false := by
  cases h : nativeSafetyPass checks with
  | false => rfl
  | true =>
    have clean := List.all_eq_true.mp (Bool.and_eq_true_iff.mp h).2 check present
    simp [violated] at clean

example : nativeSafetyPass [] = false ∧
    nativeSafetyPass (safetyKinds.map (fun kind => ⟨kind, "PASS"⟩)) = true := by decide

def nativeAuditSubmitTiming (approved : Bool) (decided started expires cutoff : Int) : Bool :=
  approved && decide (decided ≤ started ∧ started < expires ∧ started < cutoff)

def nativeAuditRouteTiming (started routeStarted dispatched cutoff : Int) : Bool :=
  decide (started ≤ routeStarted ∧ routeStarted ≤ dispatched ∧ dispatched < cutoff)

theorem native_audit_detects_expired_admission (approved : Bool) (d s e c : Int)
    (expired : e ≤ s ∨ c ≤ s) : nativeAuditSubmitTiming approved d s e c = false := by
  simp [nativeAuditSubmitTiming]
  omega

theorem native_audit_detects_late_transmission (s r d c : Int) (late : c ≤ d) :
    nativeAuditRouteTiming s r d c = false := by
  simp [nativeAuditRouteTiming]
  omega

end Bayn
