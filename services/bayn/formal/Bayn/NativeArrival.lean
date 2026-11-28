module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure NativeArrivalScope where
  capture : String
  epoch : String
  finalConsumerSequence : Nat
  deriving Repr

structure NativeArrivalPosition where
  capture : String
  epoch : String
  sequence : Nat
  consumerSequence : Nat
  availableAt : Int
  offset : Nat
  deriving Repr

def nativeArrivalProgress (scope : NativeArrivalScope) (previous : Option NativeArrivalPosition)
    (previousPartitionOffset : Option Nat) (next : NativeArrivalPosition) : Prop :=
  next.capture = scope.capture ∧ next.epoch = scope.epoch ∧
  next.consumerSequence ≤ scope.finalConsumerSequence ∧
  (match previous with
   | none => next.consumerSequence = 1
   | some prior => next.capture = prior.capture ∧ next.epoch = prior.epoch ∧
       prior.sequence < next.sequence ∧ next.consumerSequence = prior.consumerSequence + 1 ∧
       prior.availableAt ≤ next.availableAt) ∧
  (match previousPartitionOffset with
   | none => True
   | some offset => offset ≤ next.offset)

instance (scope : NativeArrivalScope) (previous : Option NativeArrivalPosition)
    (previousPartitionOffset : Option Nat) (next : NativeArrivalPosition) :
    Decidable (nativeArrivalProgress scope previous previousPartitionOffset next) := by
  unfold nativeArrivalProgress
  cases previous <;> cases previousPartitionOffset <;> infer_instance

def nativeArrivalAdmission (scope : NativeArrivalScope) (previous : Option NativeArrivalPosition)
    (offset : Option Nat) (next : Option NativeArrivalPosition) : Bool :=
  match next with
  | none => false
  | some position => decide (nativeArrivalProgress scope previous offset position)

theorem supplied_times_cannot_replace_original_receipts (scope : NativeArrivalScope)
    (previous : Option NativeArrivalPosition) (offset : Option Nat) :
    nativeArrivalAdmission scope previous offset none = false := rfl

theorem accepted_native_arrival_retains_scope (scope : NativeArrivalScope)
    (previous : Option NativeArrivalPosition) (offset : Option Nat) (next : NativeArrivalPosition)
    (accepted : nativeArrivalProgress scope previous offset next) :
    next.capture = scope.capture ∧ next.epoch = scope.epoch := ⟨accepted.1, accepted.2.1⟩

theorem native_capture_cannot_extend_its_registered_prefix (scope : NativeArrivalScope)
    (previous : Option NativeArrivalPosition) (offset : Option Nat) (next : NativeArrivalPosition)
    (accepted : nativeArrivalProgress scope previous offset next) :
    next.consumerSequence ≤ scope.finalConsumerSequence := accepted.2.2.1

theorem native_first_delivery_is_one (scope : NativeArrivalScope) (offset : Option Nat)
    (next : NativeArrivalPosition) (accepted : nativeArrivalProgress scope none offset next) :
    next.consumerSequence = 1 := accepted.2.2.2.1

theorem native_deliveries_are_consecutive (scope : NativeArrivalScope) (prior next : NativeArrivalPosition)
    (offset : Option Nat) (accepted : nativeArrivalProgress scope (some prior) offset next) :
    next.consumerSequence = prior.consumerSequence + 1 := accepted.2.2.2.1.2.2.2.1

theorem native_receipt_sequence_strictly_increases (scope : NativeArrivalScope)
    (prior next : NativeArrivalPosition) (offset : Option Nat)
    (accepted : nativeArrivalProgress scope (some prior) offset next) :
    prior.sequence < next.sequence := accepted.2.2.2.1.2.2.1

theorem native_availability_cannot_run_backwards (scope : NativeArrivalScope)
    (prior next : NativeArrivalPosition) (offset : Option Nat)
    (accepted : nativeArrivalProgress scope (some prior) offset next) :
    prior.availableAt ≤ next.availableAt := accepted.2.2.2.1.2.2.2.2

theorem native_partition_offset_cannot_run_backwards (scope : NativeArrivalScope)
    (previous : Option NativeArrivalPosition) (offset : Nat) (next : NativeArrivalPosition)
    (accepted : nativeArrivalProgress scope previous (some offset) next) :
    offset ≤ next.offset := accepted.2.2.2.2

theorem no_native_delivery_can_be_skipped (scope : NativeArrivalScope) (prior next : NativeArrivalPosition)
    (offset : Option Nat) (gap : prior.consumerSequence + 1 < next.consumerSequence) :
    ¬ nativeArrivalProgress scope (some prior) offset next := by
  intro accepted
  have consecutive := native_deliveries_are_consecutive scope prior next offset accepted
  omega

theorem repeated_native_delivery_is_rejected (scope : NativeArrivalScope) (prior : NativeArrivalPosition)
    (offset : Option Nat) : ¬ nativeArrivalProgress scope (some prior) offset prior := by
  intro accepted
  have consecutive := native_deliveries_are_consecutive scope prior prior offset accepted
  omega

theorem native_clock_tie_is_reachable :
    nativeArrivalProgress ⟨"capture", "epoch", 3⟩
      (some ⟨"capture", "epoch", 1, 1, 1000, 100⟩) (some 2)
      ⟨"capture", "epoch", 2, 2, 1000, 2⟩ := by decide

theorem native_new_partition_is_reachable :
    nativeArrivalProgress ⟨"capture", "epoch", 3⟩
      (some ⟨"capture", "epoch", 2, 2, 1000, 100⟩) none
      ⟨"capture", "epoch", 3, 3, 1001, 0⟩ := by decide

end Bayn
