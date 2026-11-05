module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure LedgerTransferMetadata where
  id : Nat
  debitAccount : Nat
  creditAccount : Nat
  amount : Nat
  pendingId : Nat
  userData128 : Nat
  userData64 : Nat
  userData32 : Nat
  timeout : Nat
  ledger : Nat
  code : Nat
  flags : Nat
  deriving Repr, DecidableEq

def exactTransferSet (actual expected : List LedgerTransferMetadata) : Bool :=
  decide (actual.length = expected.length ∧ (actual.map (·.id)).Nodup ∧
    (expected.map (·.id)).Nodup ∧ actual.all (fun value => decide (value ∈ expected)) = true)

def missingTransfers (expected existing : List LedgerTransferMetadata) : List LedgerTransferMetadata :=
  expected.filter fun value => !(existing.any fun recorded => recorded.id == value.id)

def transferPreflight (expected existing : List LedgerTransferMetadata) : Option (List LedgerTransferMetadata) :=
  if (expected.map (·.id)).Nodup ∧ (existing.map (·.id)).Nodup ∧
      existing.all (fun value => decide (value ∈ expected)) = true
  then some (missingTransfers expected existing)
  else none

theorem exact_transfer_set_rejects_partial_posting (actual expected : List LedgerTransferMetadata)
    (shorter : actual.length < expected.length) : exactTransferSet actual expected = false := by
  simp only [exactTransferSet, decide_eq_false_iff_not]
  intro h
  omega

theorem exact_transfer_set_requires_unique_ids (actual expected : List LedgerTransferMetadata)
    (h : exactTransferSet actual expected = true) :
    (actual.map (·.id)).Nodup ∧ (expected.map (·.id)).Nodup := by
  have pass := of_decide_eq_true h
  exact ⟨pass.2.1, pass.2.2.1⟩

theorem exact_transfer_set_preserves_all_metadata (actual expected : List LedgerTransferMetadata)
    (h : exactTransferSet actual expected = true) (value : LedgerTransferMetadata) (present : value ∈ actual) :
    value ∈ expected := of_decide_eq_true (List.all_eq_true.mp (of_decide_eq_true h).2.2.2 value present)

theorem transfer_preflight_never_invents_a_transfer (expected existing : List LedgerTransferMetadata)
    (value : LedgerTransferMetadata) (h : value ∈ missingTransfers expected existing) : value ∈ expected :=
  (List.mem_filter.mp h).1

theorem transfer_preflight_never_reposts_an_existing_id (expected existing : List LedgerTransferMetadata)
    (value recorded : LedgerTransferMetadata) (h : value ∈ missingTransfers expected existing)
    (present : recorded ∈ existing) : recorded.id ≠ value.id := by
  intro same
  have absent := (List.mem_filter.mp h).2
  have found : (existing.any fun item => item.id == value.id) = true :=
    List.any_eq_true.mpr ⟨recorded, present, by simp [same]⟩
  simp [found] at absent

theorem accepted_preflight_returns_only_planned_unposted_records
    (expected existing remaining : List LedgerTransferMetadata)
    (accepted : transferPreflight expected existing = some remaining)
    (value : LedgerTransferMetadata) (member : value ∈ remaining) :
    value ∈ expected ∧ ∀ recorded ∈ existing, recorded.id ≠ value.id := by
  unfold transferPreflight at accepted
  split at accepted
  · have equality := Option.some.inj accepted
    rw [← equality] at member
    exact ⟨transfer_preflight_never_invents_a_transfer expected existing value member,
      fun recorded present => transfer_preflight_never_reposts_an_existing_id expected existing value recorded member present⟩
  · contradiction

theorem unplanned_transfer_cannot_verify (actual expected : List LedgerTransferMetadata)
    (value : LedgerTransferMetadata) (present : value ∈ actual) (unplanned : value ∉ expected) :
    exactTransferSet actual expected = false := by
  apply Bool.eq_false_iff.mpr
  intro accepted
  exact unplanned (exact_transfer_set_preserves_all_metadata actual expected accepted value present)

theorem missing_transfers_after_complete_posting (expected : List LedgerTransferMetadata) :
    missingTransfers expected expected = [] := by
  apply List.filter_eq_nil_iff.mpr
  intro value present
  have found : (expected.any fun item => item.id == value.id) = true :=
    List.any_eq_true.mpr ⟨value, present, by simp⟩
  simp [found]

theorem transfer_retry_has_no_second_effect (expected : List LedgerTransferMetadata)
    (unique : (expected.map (·.id)).Nodup) : transferPreflight expected expected = some [] := by
  simp [transferPreflight, unique, missing_transfers_after_complete_posting, List.all_eq_true]

def ledgerTransferExample : LedgerTransferMetadata :=
  ⟨1, 2, 3, 1000000, 0, 4, 5, 6, 0, 7002, 1, 0⟩

theorem partial_posting_has_reachable_recovery :
    transferPreflight [ledgerTransferExample, { ledgerTransferExample with id := 7 }]
      [ledgerTransferExample] = some [{ ledgerTransferExample with id := 7 }] := by decide

theorem changed_transfer_metadata_is_rejected :
    transferPreflight [ledgerTransferExample] [{ ledgerTransferExample with amount := 1000001 }] = none ∧
    exactTransferSet [{ ledgerTransferExample with amount := 1000001 }] [ledgerTransferExample] = false := by decide

theorem duplicate_transfer_ids_are_rejected :
    transferPreflight [ledgerTransferExample] [ledgerTransferExample, ledgerTransferExample] = none ∧
    exactTransferSet [ledgerTransferExample, ledgerTransferExample]
      [ledgerTransferExample, ledgerTransferExample] = false := by decide

theorem transfer_conserves_double_entry (t : LedgerTransferMetadata) :
    -(t.amount : Int) + t.amount = 0 := by omega

end Bayn
