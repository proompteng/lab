module
public import Bayn.Economics
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure ExecutionStrategyIdentity where
  name : String
  behaviorHash : String
  parameterHash : String
  parameterSchemaVersion : String
  deriving Repr, DecidableEq

structure PersistedAuthorityGrant where
  generationHash : String
  brokerIdentityHash : String
  strategy : ExecutionStrategyIdentity
  validFrom : Int
  validUntil : Int
  revoked : Bool
  deriving Repr, DecidableEq

inductive CapitalAuthority where
  | none
  | granted (generationHash : String) (persisted : Option PersistedAuthorityGrant)
  deriving Repr, DecidableEq

def checkPersistedAuthorityGrant (generation identity : String) (strategy : ExecutionStrategyIdentity)
    (now : Int) (grant : PersistedAuthorityGrant) : String :=
  if generation ≠ grant.generationHash then "PersistedGrantAuthorityGenerationMismatch"
  else if identity ≠ grant.brokerIdentityHash then "PersistedGrantBrokerIdentityMismatch"
  else if strategy ≠ grant.strategy then "PersistedGrantStrategyMismatch"
  else if grant.revoked then "PersistedGrantRevoked"
  else if now < grant.validFrom then "PersistedGrantNotYetValid"
  else if now ≥ grant.validUntil then "PersistedGrantExpired"
  else "mutation"

def constructExecutionAuthority (readOnly : Bool) (capital : CapitalAuthority) (identity : String)
    (strategy : ExecutionStrategyIdentity) (now : Int) : String :=
  match readOnly, capital with
  | true, .none => "read-only"
  | true, .granted _ _ => "ReadOnlyBrokerRequiresNoCapital"
  | false, .none => "MutationBrokerRequiresCapitalAuthority"
  | false, .granted _ none => "mutation"
  | false, .granted generation (some grant) => checkPersistedAuthorityGrant generation identity strategy now grant

theorem persisted_authority_accepts_exact_unrevoked_current_grant
    (generation identity : String) (strategy : ExecutionStrategyIdentity) (now : Int)
    (grant : PersistedAuthorityGrant) :
    checkPersistedAuthorityGrant generation identity strategy now grant = "mutation" ↔
      generation = grant.generationHash ∧ identity = grant.brokerIdentityHash ∧ strategy = grant.strategy ∧
      grant.revoked = false ∧ grant.validFrom ≤ now ∧ now < grant.validUntil := by
  by_cases generationMatches : generation = grant.generationHash <;>
    by_cases identityMatches : identity = grant.brokerIdentityHash <;>
    by_cases strategyMatches : strategy = grant.strategy <;>
    cases revoked : grant.revoked <;>
    by_cases early : now < grant.validFrom <;>
    by_cases expired : now ≥ grant.validUntil <;>
    simp [checkPersistedAuthorityGrant, generationMatches, identityMatches, strategyMatches, revoked, early,
      expired] <;> omega

theorem read_only_broker_cannot_construct_mutation_authority (capital : CapitalAuthority)
    (identity : String) (strategy : ExecutionStrategyIdentity) (now : Int) :
    constructExecutionAuthority true capital identity strategy now ≠ "mutation" := by
  cases capital <;> simp [constructExecutionAuthority]

theorem mutation_authority_requires_granted_capital (readOnly : Bool) (capital : CapitalAuthority)
    (identity : String) (strategy : ExecutionStrategyIdentity) (now : Int)
    (accepted : constructExecutionAuthority readOnly capital identity strategy now = "mutation") :
    readOnly = false ∧ ∃ generation persisted, capital = .granted generation persisted := by
  cases readOnly <;> cases capital <;> simp_all [constructExecutionAuthority]

theorem persisted_authority_rejects_expiry (generation identity : String)
    (strategy : ExecutionStrategyIdentity) (now : Int) (grant : PersistedAuthorityGrant)
    (expired : grant.validUntil ≤ now) :
    constructExecutionAuthority false (.granted generation (some grant)) identity strategy now ≠ "mutation" := by
  intro accepted
  have valid := (persisted_authority_accepts_exact_unrevoked_current_grant generation identity strategy now grant).mp
    accepted
  omega

theorem persisted_authority_rejects_revocation (generation identity : String)
    (strategy : ExecutionStrategyIdentity) (now : Int) (grant : PersistedAuthorityGrant)
    (revoked : grant.revoked = true) :
    constructExecutionAuthority false (.granted generation (some grant)) identity strategy now ≠ "mutation" := by
  simp [constructExecutionAuthority, persisted_authority_accepts_exact_unrevoked_current_grant, revoked]

theorem local_generation_authority_is_distinct_from_persisted_grant_validation
    (generation identity : String) (strategy : ExecutionStrategyIdentity) (now : Int) :
    constructExecutionAuthority false (.granted generation none) identity strategy now = "mutation" := rfl

theorem persisted_authority_has_reachable_success :
    constructExecutionAuthority false
      (.granted "generation" (some ⟨"generation", "identity", ⟨"jev", "behavior", "parameters", "v1"⟩,
        0, 10, false⟩)) "identity" ⟨"jev", "behavior", "parameters", "v1"⟩ 0 = "mutation" := by decide

end Bayn
