module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure InferenceReceiptIdentity where
  request : String
  receipt : String
  deriving Repr, DecidableEq

inductive InferenceResolutionInput where
  | recorded (request receipt : String)
  | abandoned (request : String) (abandonedAt : Int)
  deriving Repr, DecidableEq

def inferenceResolutionAllowed (request : String) (expiresAt : Int)
    (receipt : Option InferenceReceiptIdentity) (resolution : InferenceResolutionInput) : Prop :=
  match resolution with
  | .recorded requestId receiptHash =>
    requestId = request ∧ receipt = some ⟨request, receiptHash⟩
  | .abandoned requestId abandonedAt => requestId = request ∧ expiresAt ≤ abandonedAt

instance (request : String) (expiresAt : Int) (receipt : Option InferenceReceiptIdentity)
    (resolution : InferenceResolutionInput) :
    Decidable (inferenceResolutionAllowed request expiresAt receipt resolution) := by
  cases resolution <;> unfold inferenceResolutionAllowed <;> infer_instance

theorem recorded_resolution_has_exact_request_and_receipt (request requestId receiptHash : String)
    (expiresAt : Int) (receipt : Option InferenceReceiptIdentity)
    (accepted : inferenceResolutionAllowed request expiresAt receipt (.recorded requestId receiptHash)) :
    requestId = request ∧ receipt = some ⟨request, receiptHash⟩ := accepted

theorem missing_receipt_cannot_be_recorded (request requestId receiptHash : String) (expiresAt : Int) :
    ¬ inferenceResolutionAllowed request expiresAt none (.recorded requestId receiptHash) := by
  simp [inferenceResolutionAllowed]

theorem abandoned_resolution_keeps_original_expiry (request requestId : String)
    (expiresAt abandonedAt : Int) (receipt : Option InferenceReceiptIdentity)
    (accepted : inferenceResolutionAllowed request expiresAt receipt (.abandoned requestId abandonedAt)) :
    expiresAt ≤ abandonedAt := accepted.2

theorem early_recovery_cannot_abandon (request requestId : String) (expiresAt abandonedAt : Int)
    (receipt : Option InferenceReceiptIdentity) (early : abandonedAt < expiresAt) :
    ¬ inferenceResolutionAllowed request expiresAt receipt (.abandoned requestId abandonedAt) := by
  unfold inferenceResolutionAllowed
  omega

theorem late_receipt_does_not_change_abandonment (request requestId : String) (expiresAt abandonedAt : Int)
    (first later : Option InferenceReceiptIdentity) :
    inferenceResolutionAllowed request expiresAt first (.abandoned requestId abandonedAt) ↔
      inferenceResolutionAllowed request expiresAt later (.abandoned requestId abandonedAt) := Iff.rfl

theorem recorded_resolution_reachable :
    inferenceResolutionAllowed "request" 100 (some ⟨"request", "receipt"⟩) (.recorded "request" "receipt") := by decide

theorem abandonment_at_original_deadline_reachable :
    inferenceResolutionAllowed "request" 100 none (.abandoned "request" 100) := by decide

end Bayn
