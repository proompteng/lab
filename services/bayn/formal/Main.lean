module
public import Bayn
public import Lean.Data.Json

@[expose] public section

open Lean Bayn

def readInteger (json : Json) (key : String) : Except String Int := do
  let value ← json.getObjValAs? String key
  match value.toInt? with
  | some n => return n
  | none => throw s!"{key} must be an integer string"

def readNatural (json : Json) (key : String) : Except String Nat := do
  let value ← readInteger json key
  if value < 0 then throw s!"{key} must be nonnegative"
  return value.toNat

def readNativeArrivalPosition (json : Json) : Except String NativeArrivalPosition := do
  return {
    capture := ← json.getObjValAs? String "capture",
    epoch := ← json.getObjValAs? String "epoch",
    sequence := ← readNatural json "sequence",
    consumerSequence := ← readNatural json "consumerSequence",
    availableAt := ← readInteger json "availableAt",
    offset := ← readNatural json "offset"
  }

def readProtectionOwner (json : Json) : Except String ProtectionOwner := do
  return {
    account := ← json.getObjValAs? String "account",
    cycle := ← json.getObjValAs? String "cycle",
    decision := ← json.getObjValAs? String "decision",
    policy := ← json.getObjValAs? String "policy",
    strategy := ← json.getObjValAs? String "strategy",
    generation := ← json.getObjValAs? String "generation",
    entry := ← json.getObjValAs? String "entry",
    symbol := ← json.getObjValAs? String "symbol"
  }

def readProtectionEntry (json : Json) : Except String ProtectionEntry := do
  return {
    owner := ← readProtectionOwner (← json.getObjVal? "owner"),
    dispatchable := ← json.getObjValAs? Bool "dispatchable",
    maximumQuantity := ← readInteger json "maximumQuantity",
    stop := ← readInteger json "stop",
    stopLimit := ← readInteger json "stopLimit",
    profit := ← readInteger json "profit",
    createdAt := ← readInteger json "createdAt",
    maximumBrokerAge := ← readInteger json "maximumBrokerAge",
    maximumRiskTtl := ← readInteger json "maximumRiskTtl"
  }

def readProtectionIntentEvidence (json : Json) : Except String ProtectionIntentEvidence := do
  return {
    owner := ← readProtectionOwner (← json.getObjVal? "owner"),
    sourceHash := ← json.getObjValAs? String "sourceHash",
    expectedSourceHash := ← json.getObjValAs? String "expectedSourceHash",
    intent := ← json.getObjValAs? String "intent",
    expectedIntent := ← json.getObjValAs? String "expectedIntent",
    client := ← json.getObjValAs? String "client",
    expectedClient := ← json.getObjValAs? String "expectedClient",
    riskId := ← json.getObjValAs? String "riskId",
    expectedRiskId := ← json.getObjValAs? String "expectedRiskId",
    riskIntent := ← json.getObjValAs? String "riskIntent",
    riskPolicy := ← json.getObjValAs? String "riskPolicy",
    riskOutcome := ← json.getObjValAs? String "riskOutcome",
    reconciliationId := ← json.getObjValAs? String "reconciliationId",
    expectedReconciliationId := ← json.getObjValAs? String "expectedReconciliationId",
    reconciliationHash := ← json.getObjValAs? String "reconciliationHash",
    expectedReconciliationHash := ← json.getObjValAs? String "expectedReconciliationHash",
    reconciliationAccount := ← json.getObjValAs? String "reconciliationAccount",
    reconciliationStatus := ← json.getObjValAs? String "reconciliationStatus",
    replan := ← json.getObjValAs? String "replan",
    expectedReplan := ← json.getObjValAs? String "expectedReplan",
    side := ← json.getObjValAs? String "side",
    kind := ← json.getObjValAs? String "kind",
    orderType := ← json.getObjValAs? String "orderType",
    timeInForce := ← json.getObjValAs? String "timeInForce",
    quantity := ← readInteger json "quantity",
    limitPrice := ← readInteger json "limitPrice",
    stop := ← readInteger json "stop",
    stopLimit := ← readInteger json "stopLimit",
    profit := ← readInteger json "profit",
    createdAt := ← readInteger json "createdAt",
    decidedAt := ← readInteger json "decidedAt",
    expiresAt := ← readInteger json "expiresAt",
    reconciledAt := ← readInteger json "reconciledAt"
  }

def readExpenseIdentity (json : Json) : Except String ExpenseIdentity := do
  return {
    request := ← json.getObjValAs? String "request",
    stage := ← json.getObjValAs? String "stage",
    receipt := ← json.getObjValAs? (Option String) "receipt",
    handoff := ← json.getObjValAs? (Option String) "handoff",
    chartClaim := ← json.getObjValAs? (Option String) "chartClaim",
    chartTerminal := ← json.getObjValAs? (Option String) "chartTerminal",
    stageClaim := ← json.getObjValAs? (Option String) "stageClaim",
    stageTerminal := ← json.getObjValAs? (Option String) "stageTerminal",
    stageSkip := ← json.getObjValAs? (Option String) "stageSkip"
  }

def readHandoffIdentity (json : Json) : Except String HandoffIdentity := do
  return { hash := ← json.getObjValAs? String "hash", payload := ← json.getObjValAs? String "payload" }

def handoffIdentityJson (identity : HandoffIdentity) : Json :=
  Json.mkObj [("hash", toJson identity.hash), ("payload", toJson identity.payload)]

def readFrozenExpense (json : Json) : Except String FrozenExpense := do
  let costJson ← json.getObjVal? "cost"
  let cost : Option Nat ← if costJson == Json.null then pure none else pure (some (← readNatural json "cost"))
  return {
    identity := ← readExpenseIdentity (← json.getObjVal? "identity"),
    verified := ← json.getObjValAs? Bool "verified",
    cost
  }

def readLedgerTransfer (json : Json) : Except String LedgerTransferMetadata := do
  return {
    id := ← readNatural json "id",
    debitAccount := ← readNatural json "debit_account_id",
    creditAccount := ← readNatural json "credit_account_id",
    amount := ← readNatural json "amount",
    pendingId := ← readNatural json "pending_id",
    userData128 := ← readNatural json "user_data_128",
    userData64 := ← readNatural json "user_data_64",
    userData32 := ← readNatural json "user_data_32",
    timeout := ← readNatural json "timeout",
    ledger := ← readNatural json "ledger",
    code := ← readNatural json "code",
    flags := ← readNatural json "flags"
  }

def readIntegerArray (json : Json) : Except String (Array Int) := do
  let values ← json.getArr?
  values.mapM fun value => do
    let text ← value.getStr?
    match text.toInt? with
    | some n => return n
    | none => throw "expected an integer string"

def readMutationKind (json : Json) : Except String MutationEventKind := do
  match ← json.getStr? with
  | "SUBMIT_STARTED" => return .submitStarted
  | "SUBMIT_ACCEPTED" => return .submitAccepted
  | "SUBMIT_REJECTED" => return .submitRejected
  | "SUBMIT_DENIED" => return .submitDenied
  | "SUBMIT_UNKNOWN" => return .submitUnknown
  | "RECOVERY_FOUND" => return .recoveryFound
  | "RECOVERY_NOT_FOUND" => return .recoveryNotFound
  | "RECOVERY_UNKNOWN" => return .recoveryUnknown
  | "CANCEL_STARTED" => return .cancelStarted
  | "CANCEL_ACCEPTED" => return .cancelAccepted
  | "CANCEL_UNKNOWN" => return .cancelUnknown
  | _ => throw "unknown mutation event"

def readOptionalField (json : Json) (key : String) (decode : Json → Except String α) : Except String (Option α) := do
  match ← json.getObjVal? key with
  | .null => return none
  | value => return some (← decode value)

def readMutationRouting (json : Json) : Except String MutationRouting := do
  return {
    startedAt := ← readInteger json "startedAt",
    requestDispatchedAt := ← readOptionalField json "requestDispatchedAt" (fun value => do
      let text ← value.getStr?
      match text.toInt? with
      | some n => return n
      | none => throw "dispatch must be an integer string"),
    completedAt := ← readInteger json "completedAt"
  }

def readMutationOutcome (json : Json) : Except String MutationOutcomeEvidence := do
  return {
    kind := ← readMutationKind (← json.getObjVal? "eventType"),
    requestId := ← readOptionalField json "requestId" Json.getStr?,
    responseStatus := ← readOptionalField json "responseStatus" Json.getNat?,
    responseContentHash := ← readOptionalField json "responseContentHash" Json.getStr?,
    routing := ← readOptionalField json "routing" readMutationRouting,
    denialReason := ← readOptionalField json "denialReason" Json.getStr?,
    brokerOrderId := ← readOptionalField json "brokerOrderId" Json.getStr?
  }

def readAuthorityLevel (json : Json) : Except String AuthorityLevel := do
  match ← json.getStr? with
  | "OBSERVE" => return .observe
  | "PAPER" => return .execution
  | _ => throw "unknown authority level"

def readMutationAuthority (json : Json) : Except String MutationAuthoritySnapshot := do
  let kill ← match ← json.getObjValAs? String "killState" with
    | "CLEAR" => pure AuthorityKill.clear
    | "ACTIVE" => pure AuthorityKill.active
    | _ => throw "unknown kill state"
  return {
    maximum := ← readAuthorityLevel (← json.getObjVal? "maximum"),
    effective := ← readAuthorityLevel (← json.getObjVal? "effective"),
    kill,
    generationHash := ← json.getObjValAs? String "generationHash",
    generationMaximum := ← readOptionalField json "generationMaximum" readAuthorityLevel,
    generationAccountId := ← readOptionalField json "generationAccountId" Json.getStr?
  }

def readExecutionStrategy (json : Json) : Except String ExecutionStrategyIdentity := do
  return {
    name := ← json.getObjValAs? String "name",
    behaviorHash := ← json.getObjValAs? String "behaviorHash",
    parameterHash := ← json.getObjValAs? String "parameterHash",
    parameterSchemaVersion := ← json.getObjValAs? String "parameterSchemaVersion"
  }

def readPersistedAuthorityGrant (json : Json) : Except String PersistedAuthorityGrant := do
  return {
    generationHash := ← json.getObjValAs? String "generationHash",
    brokerIdentityHash := ← json.getObjValAs? String "brokerIdentityHash",
    strategy := ← readExecutionStrategy (← json.getObjVal? "strategy"),
    validFrom := ← readInteger json "validFrom",
    validUntil := ← readInteger json "validUntil",
    revoked := ← json.getObjValAs? Bool "revoked"
  }

def readCycleState (json : Json) : Except String CycleState := do
  match ← json.getStr? with
  | "PENDING" => return .pending
  | "ACTIVE" => return .active
  | "COMPLETED" => return .completed
  | "NO_TRADE" => return .noTrade
  | "BLOCKED" => return .blocked
  | _ => throw "unknown cycle state"

def readCycleIdentity (json : Json) : Except String CycleIdentity := do
  return {
    cycleId := ← json.getObjValAs? String "cycleId",
    strategyName := ← json.getObjValAs? String "strategyName",
    strategyProtocolHash := ← json.getObjValAs? String "strategyProtocolHash",
    qualificationRunId := ← json.getObjValAs? String "qualificationRunId",
    accountId := ← json.getObjValAs? String "accountId"
  }

def readCycleEvidence (json : Json) : Except String CycleEvidence := do
  return {
    identity := ← readCycleIdentity (← json.getObjVal? "identity"),
    state := ← readCycleState (← json.getObjVal? "state"),
    createdAt := ← readInteger json "createdAt",
    updatedAt := ← readInteger json "updatedAt",
    submissionOpenAt := ← readInteger json "submissionOpenAt",
    submissionCutoffAt := ← readInteger json "submissionCutoffAt",
    snapshotId := ← readOptionalField json "snapshotId" Json.getStr?,
    decisionHash := ← readOptionalField json "decisionHash" Json.getStr?
  }

def readCycleSnapshot (json : Json) : Except String CycleSnapshotIdentity := do
  return {
    snapshotId := ← json.getObjValAs? String "snapshotId",
    contentHash := ← json.getObjValAs? String "contentHash",
    observedAt := ← readInteger json "observedAt"
  }

def readCycleDecision (json : Json) : Except String CycleDecisionEvidence := do
  return {
    identity := ← readCycleIdentity (← json.getObjVal? "identity"),
    contentHash := ← json.getObjValAs? String "contentHash",
    executionMode := ← json.getObjValAs? Bool "executionMode",
    snapshot := ← readCycleSnapshot (← json.getObjVal? "snapshot"),
    executionMarketData := ← readOptionalField json "executionMarketData" readCycleSnapshot,
    decisionMarketData := ← readOptionalField json "decisionMarketData" readCycleSnapshot,
    createdAt := ← readInteger json "createdAt",
    submissionCutoffAt := ← readInteger json "submissionCutoffAt"
  }

def readCycleCompletionDocument (json : Json) : Except String CycleCompletionDocument := do
  return {
    contentHash := ← json.getObjValAs? String "contentHash",
    planned := ← json.getObjValAs? Bool "planned",
    noTrade := ← json.getObjValAs? Bool "noTrade",
    executionMode := ← json.getObjValAs? Bool "executionMode",
    riskBlocked := ← json.getObjValAs? Bool "riskBlocked",
    completionEvidence := ← json.getObjValAs? Bool "completionEvidence"
  }

def readMomentumPrices (json : Json) : Except String MomentumPrices := do
  return {
    symbol := ← json.getObjValAs? String "symbol",
    reference := ← readInteger json "reference",
    bid := ← readInteger json "bid",
    ask := ← readInteger json "ask",
    benchmarkReference := ← readInteger json "benchmarkReference",
    benchmarkBid := ← readInteger json "benchmarkBid",
    benchmarkAsk := ← readInteger json "benchmarkAsk",
    quoteAllowed := ← json.getObjValAs? Bool "quoteAllowed"
  }

def readNativeControlCommitments (json : Json) : Except String NativeControlCommitments := do
  return {
    strategyHash := ← json.getObjValAs? String "strategyHash",
    parametersHash := ← json.getObjValAs? String "parametersHash",
    protocolHash := ← json.getObjValAs? String "protocolHash",
    promptsHash := ← json.getObjValAs? String "promptsHash",
    executionModelHash := ← json.getObjValAs? String "executionModelHash"
  }

def readNativeOrderOwner (json : Json) : Except String NativeOrderOwner := do
  return {
    intent := ← json.getObjValAs? String "intent", decision := ← json.getObjValAs? String "decision",
    generation := ← json.getObjValAs? String "generation", account := ← json.getObjValAs? String "account",
    symbol := ← json.getObjValAs? String "symbol" }

def readOptionalInteger (json : Json) (key : String) : Except String (Option Int) :=
  readOptionalField json key fun value => do
    let text ← value.getStr?
    match text.toInt? with
    | some n => return n
    | none => throw s!"{key} must be an integer string or null"

def readNativeOrderReceipt (json : Json) : Except String NativeOrderReceipt := do
  return {
    owner := ← readNativeOrderOwner (← json.getObjVal? "owner"),
    orderIntent := ← json.getObjValAs? (Option String) "orderIntent",
    brokerId := ← json.getObjValAs? String "brokerId", clientId := ← json.getObjValAs? String "clientId",
    parentId := ← json.getObjValAs? (Option String) "parentId", side := ← json.getObjValAs? String "side",
    orderType := ← json.getObjValAs? String "orderType", timeInForce := ← json.getObjValAs? String "timeInForce",
    quantity := ← readOptionalInteger json "quantity", notional := ← readOptionalInteger json "notional",
    limitPrice := ← readOptionalInteger json "limitPrice", stopPrice := ← readOptionalInteger json "stopPrice" }

def readNativeOrderTarget (json : Json) : Except String NativeOrderTarget := do
  let p ← json.getObjVal? "protection"
  let protection : NativeProtectionTerms ← match ← p.getObjValAs? String "kind" with
    | "NONE" => pure .none
    | "StopLimit" => pure (.stopLimit (← readInteger p "trigger"))
    | "Bracket" => pure (.bracket (← readInteger p "trigger") (← readInteger p "limit") (← readInteger p "profit"))
    | "Oco" => pure (.oco (← readInteger p "trigger") (← readInteger p "limit") (← readInteger p "profit"))
    | _ => throw "unsupported native protection kind"
  return {
    owner := ← readNativeOrderOwner (← json.getObjVal? "owner"),
    side := ← json.getObjValAs? String "side", orderType := ← json.getObjValAs? String "orderType",
    timeInForce := ← json.getObjValAs? String "timeInForce", quantity := ← readInteger json "quantity",
    limitPrice := ← readInteger json "limitPrice", protection }

def nativeOrderBindingJson (binding : NativeOrderBinding) : Json :=
  match binding with
  | .invalid => Json.mkObj [("status", toJson "INVALID")]
  | .missing => Json.mkObj [("status", toJson "MISSING")]
  | .bound quantity price protection => Json.mkObj [
      ("status", toJson "BOUND"), ("quantity", toJson (toString quantity)),
      ("limitPrice", toJson (toString price)),
      ("protection", if protection == "NONE" then Json.null else toJson protection)]

def evaluate (json : Json) : Except String Json := do
  let op ← json.getObjValAs? String "operation"
  match op with
  | "nativeControlAdmission" =>
    return toJson (nativeControlAdmitted (← readNativeControlCommitments (← json.getObjVal? "expected"))
      (← readNativeControlCommitments (← json.getObjVal? "actual")))
  | "momentumSelection" =>
    let prices ← (← (← json.getObjVal? "prices").getArr?).toList.mapM readMomentumPrices
    let funded ← json.getObjValAs? Bool "funded"
    return toJson (fundedMomentumSelection prices funded)
  | "momentumScore" =>
    let prices ← readMomentumPrices (← json.getObjVal? "prices")
    let score := momentumScore prices
    return Json.mkObj [("numerator", toJson (toString score.numerator)),
      ("denominator", toJson (toString score.denominator)), ("eligible", toJson (momentumEligible prices))]
  | "momentumRequiredTarget" =>
    return toJson (toString (momentumRequiredTargetNet (← readNatural json "acquisition")))
  | "momentumPayoffs" =>
    return toJson (momentumFundedPayoffs (← readInteger json "acquisition") (← readInteger json "stopNet")
      (← readInteger json "targetNet"))
  | "cashProjection" =>
    let rows ← (← json.getObjVal? "marks").getArr?
    let marks ← rows.toList.mapM fun row => do
      let cash ← match ← row.getObjVal? "cash" with
        | .null => pure none
        | _ => some <$> readInteger row "cash"
      pure ({ time := ← readInteger row "at", cash } : CashObservation)
    let history ← match ← json.getObjVal? "history" with
      | .null => pure none
      | value => do
        let rows ← (← value.getObjVal? "changes").getArr?
        let changes ← rows.toList.mapM fun row => do
          let movement : CashMovement := {
            source := ← row.getObjValAs? String "source",
            earliest := ← readInteger row "earliest",
            latest := ← readInteger row "latest",
            amount := ← readInteger row "amount"
          }
          pure movement
        pure (some ({ completeFrom := ← readInteger value "completeFrom", completeThrough := ← readInteger value "completeThrough", changes } : CashHistory))
    let flows ← match ← json.getObjVal? "flows" with
      | .null => pure none
      | value => do
        let rows ← value.getArr?
        some <$> rows.toList.mapM (fun row => do
          pure ({ time := ← readInteger row "at", amount := ← readInteger row "amount" } : CashAdjustment))
    let result := projectCash marks history flows (← readInteger json "closeAt")
    return toJson (result.map (fun mark => mark.cash.map toString))
  | "bidMarkedValue" =>
    let positions ← match ← json.getObjVal? "positions" with
      | .null => pure none
      | value => do
        let rows ← value.getArr?
        let positions ← rows.toList.mapM fun row => do
          let position : BidPosition := {
            symbol := ← row.getObjValAs? String "symbol",
            quantity := ← readNatural row "quantityAtoms",
            bidMicros := ← readNatural row "bidPriceMicros",
            costBasisMicros := ← readNatural row "costBasisMicros"
          }
          pure position
        pure (some positions)
    let cash ← match ← json.getObjVal? "cashMicros" with
      | .null => pure none
      | _ => some <$> readInteger json "cashMicros"
    match bidMarkedValue cash positions with
    | none => return Json.null
    | some value => return Json.mkObj [
        ("equityMicros", toJson (toString value.equity)),
        ("unrealizedPnlMicros", toJson (toString value.unrealized)),
        ("positionCount", toJson value.positionCount)]
  | "registeredRisk" =>
    let binding : RegisteredRiskBinding := {
      declaredPolicyHash := ← json.getObjValAs? String "declaredPolicyHash",
      materialPolicyHash := ← json.getObjValAs? String "materialPolicyHash",
      declaredAccountHash := ← json.getObjValAs? String "declaredAccountHash",
      materialAccountHash := ← json.getObjValAs? String "materialAccountHash",
      approvedPolicyHashes := ← json.getObjValAs? (List String) "approvedPolicyHashes"
    }
    return toJson (decide (registeredRiskPreserved binding))
  | "frozenQuantity" =>
    let quantity ← readNatural json "quantityMicros"
    let price ← readNatural json "priceMicros"
    return Json.mkObj [
      ("quantityAtoms", toJson (toString (frozenQuantityAtoms quantity))),
      ("notionalMicros", toJson (toString (frozenNotionalMicros quantity price)))
    ]
  | "deployedControl" =>
    let actual : ControlIdentity := {
      strategyHash := ← json.getObjValAs? String "strategyHash",
      parametersHash := ← json.getObjValAs? String "parametersHash",
      protocolHash := ← json.getObjValAs? String "protocolHash",
      executionModelHash := ← json.getObjValAs? String "executionModelHash",
      promptsHash := ← json.getObjValAs? String "promptsHash",
      continuationAndExitsHash := ← json.getObjValAs? String "continuationAndExitsHash"
    }
    return toJson (decide (deployedControlPreserved actual))
  | "entryCompletionPolicy" =>
    let outcome ← match ← json.getObjValAs? String "outcome" with
      | "RECEIVED" => pure EntryProviderOutcome.received
      | "FAILED" => pure EntryProviderOutcome.failed
      | "NOT_REQUESTED" => pure EntryProviderOutcome.notRequested
      | "NOT_DISPATCHED" => pure EntryProviderOutcome.notDispatched
      | "OMITTED_BY_POLICY" => pure EntryProviderOutcome.omittedByPolicy
      | _ => throw "unknown entry provider outcome"
    return toJson (entryCompletionAdmitted
      (← json.getObjValAs? Bool "ablation") (← json.getObjValAs? Bool "ready") outcome
      (← readInteger json "recordedAt") (← readInteger json "completedAt") (← readInteger json "expiresAt"))
  | "inferenceHandoff" =>
    let stateJson ← json.getObjVal? "state"
    let storedJson ← stateJson.getObjVal? "stored"
    let stored : Option HandoffIdentity ←
      if storedJson == Json.null then pure none else pure (some (← readHandoffIdentity storedJson))
    let state : HandoffState := { stored, resolved := ← stateJson.getObjValAs? Bool "resolved" }
    let input ← readHandoffIdentity (← json.getObjVal? "input")
    match commitInferenceHandoff (← json.getObjValAs? Bool "ambientTransaction") state input with
    | none => return Json.null
    | some result => return Json.mkObj [
        ("dispatchAllowed", toJson result.dispatch),
        ("state", Json.mkObj [
          ("stored", result.state.stored.elim Json.null handoffIdentityJson),
          ("resolved", toJson result.state.resolved)
        ])
      ]
  | "visualClaim" =>
    let stateJson ← json.getObjVal? "state"
    let storedJson ← stateJson.getObjVal? "stored"
    let stored : Option HandoffIdentity ←
      if storedJson == Json.null then pure none else pure (some (← readHandoffIdentity storedJson))
    let state : VisualClaimState := {
      stored,
      resolved := ← stateJson.getObjValAs? Bool "resolved",
      handedOff := ← stateJson.getObjValAs? Bool "handedOff",
      stageQuoted := ← stateJson.getObjValAs? Bool "stageQuoted"
    }
    let input ← readHandoffIdentity (← json.getObjVal? "input")
    match commitVisualClaim (← json.getObjValAs? Bool "ambientTransaction") state input
        (← readInteger json "observedAt") (← readInteger json "claimedAt")
        (← readInteger json "commitAt") (← readInteger json "expiresAt") with
    | none => return Json.null
    | some result => return Json.mkObj [
        ("dispatchAllowed", toJson result.dispatch),
        ("state", Json.mkObj [
          ("stored", result.state.stored.elim Json.null handoffIdentityJson),
          ("resolved", toJson result.state.resolved),
          ("handedOff", toJson result.state.handedOff),
          ("stageQuoted", toJson result.state.stageQuoted)
        ])
      ]
  | "inferenceExpenseCoverage" =>
    let lines ← (← (← json.getObjVal? "lines").getArr?).mapM readExpenseIdentity
    let frozen ← (← (← json.getObjVal? "frozen").getArr?).mapM readFrozenExpense
    match expenseCoverage lines.toList frozen.toList with
    | none => return Json.null
    | some coverage => return Json.mkObj [
        ("missingQuoteCount", toJson coverage.missing),
        ("unverifiedRequestCount", toJson coverage.unverified),
        ("gapRequestCount", toJson coverage.gap),
        ("completeMeteredCoverage", toJson (decide coverage.complete))
      ]
  | "inferenceResolution" =>
    let request ← json.getObjValAs? String "request"
    let expiresAt ← readInteger json "expiresAt"
    let receipt : Option InferenceReceiptIdentity ← match ← json.getObjVal? "receipt" with
      | .null => pure none
      | value => do
        let requestId ← value.getObjValAs? String "request"
        let receiptHash ← value.getObjValAs? String "receipt"
        pure (some { request := requestId, receipt := receiptHash })
    let resolutionJson ← json.getObjVal? "resolution"
    let requestId ← resolutionJson.getObjValAs? String "request"
    let resolution ← match ← resolutionJson.getObjValAs? String "status" with
      | "RECORDED" => pure (InferenceResolutionInput.recorded requestId (← resolutionJson.getObjValAs? String "receipt"))
      | "ABANDONED" => pure (InferenceResolutionInput.abandoned requestId (← readInteger resolutionJson "abandonedAt"))
      | _ => throw "Unsupported inference resolution"
    return toJson (decide (inferenceResolutionAllowed request expiresAt receipt resolution))
  | "nativeArrivalProgress" =>
    let scopeJson ← json.getObjVal? "scope"
    let scope : NativeArrivalScope := {
      capture := ← scopeJson.getObjValAs? String "capture",
      epoch := ← scopeJson.getObjValAs? String "epoch",
      finalConsumerSequence := ← readNatural scopeJson "finalConsumerSequence"
    }
    let previous ← match ← json.getObjVal? "previous" with
      | .null => pure none
      | value => some <$> readNativeArrivalPosition value
    let offset ← match ← json.getObjVal? "previousPartitionOffset" with
      | .null => pure none
      | value => do
        let text ← value.getStr?
        match text.toNat? with
        | some n => pure (some n)
        | none => throw "Expected natural partition offset"
    let next ← match ← json.getObjVal? "next" with
      | .null => pure none
      | value => some <$> readNativeArrivalPosition value
    return toJson (nativeArrivalAdmission scope previous offset next)
  | "allocateCostByWeights" =>
    let weights ← (← json.getObjValAs? (Array String) "weights").toList.mapM fun value =>
      match value.toInt? with
      | some weight => pure weight
      | none => throw "Expected integer weight"
    match allocateCostByWeights (← readInteger json "amount") weights with
    | some values => return toJson (values.map toString)
    | none => return Json.null
  | "retainedFinancialMarks" =>
    let marks : List FinancialMark ← (← (← json.getObjVal? "marks").getArr?).toList.mapM fun mark => do
      return {
        account := ← mark.getObjValAs? String "account",
        source := ← mark.getObjValAs? String "source",
        occurredAt := ← readInteger mark "at",
        availableAt := ← readInteger mark "availableAt"
      }
    let retained := retainedFinancialMarks marks (← json.getObjValAs? String "account")
      (← readInteger json "opening") (← readInteger json "closing") (← readInteger json "asOf")
    return toJson (retained.map (·.source))
  | "costWindow" =>
    let documents : List CostWindowDocument ← (← (← json.getObjVal? "documents").getArr?).toList.mapM fun document => do
      let identity ← document.getObjValAs? String "identity"
      let fingerprint ← document.getObjValAs? String "fingerprint"
      let scope ← document.getObjValAs? String "scope"
      let requiredScopes ← document.getObjValAs? (Array String) "requiredScopes"
      return { identity, fingerprint, scope, requiredScopes := requiredScopes.toList }
    return toJson (costWindowConsistent documents)
  | "proportionalCost" =>
    match proportionalCost (← readInteger json "amount") (← readInteger json "weight")
        (← readInteger json "total") with
    | some value => return toJson (toString value)
    | none => return Json.null
  | "tariffCoversWindow" =>
    let rates ← (← (← json.getObjVal? "rates").getArr?).toList.mapM fun rate => do
      return { starts := ← readInteger rate "starts", ends := ← readInteger rate "ends" : TariffInterval }
    return toJson (tariffCoversWindow (← readInteger json "opening") (← readInteger json "closing") rates)
  | "recognizedOperatingCosts" =>
    let requests ← (← (← json.getObjVal? "requests").getArr?).toList.mapM fun request => do
      let startedAt ← if (← request.getObjVal? "startedAt") == Json.null then pure none
        else pure (some (← readInteger request "startedAt"))
      return { startedAt, weight := ← readNatural request "weight" : EvidencedCostRequest }
    match recognizeEvidencedCosts (← readNatural json "fixed") (← readNatural json "invoice")
        (← readNatural json "premium") (← readInteger json "opening") (← readInteger json "closing")
        (← readInteger json "time") requests with
    | some value => return Json.mkObj [
        ("operatingCostMicros", toJson (toString value.operating)),
        ("qualificationPremiumMicros", toJson (toString value.premium))]
    | none => return Json.null
  | "cycleTransition" =>
    return toJson (cycleTransitionAllowed (← readCycleState (← json.getObjVal? "from"))
      (← readCycleState (← json.getObjVal? "to")))
  | "cycleLifecycle" =>
    let cycle ← readCycleEvidence (← json.getObjVal? "cycle")
    let now ← readInteger json "now"
    return Json.mkObj [
      ("unusedEntryExpiresAt", toJson (toString (unusedEntryExpiry cycle))),
      ("expiredUnusedEntry", toJson (expiredUnusedEntry cycle now)),
      ("activation", toJson (cycleActivation cycle now)),
      ("completion", toJson (cycleCompletion cycle (← json.getObjValAs? Bool "completed") now))
    ]
  | "cycleDecisionBinding" =>
    return toJson (cycleDecisionBinding (← readCycleEvidence (← json.getObjVal? "cycle"))
      (← readCycleDecision (← json.getObjVal? "document")) (← readInteger json "now")
      (← json.getObjValAs? Nat "storedCount") (← json.getObjValAs? Bool "storedEquivalent"))
  | "cycleCompletionDocument" =>
    let documents ← (← (← json.getObjVal? "documents").getArr?).toList.mapM readCycleCompletionDocument
    return toJson (cycleCompletionDocumentPass (← json.getObjValAs? Bool "completed")
      (← json.getObjValAs? String "decisionHash") documents)
  | "executionAuthority" =>
    let capitalJson ← json.getObjVal? "capital"
    let capital ← match ← capitalJson.getObjValAs? String "kind" with
      | "none" => pure CapitalAuthority.none
      | "granted-capital" => do
        let generation ← capitalJson.getObjValAs? String "generationHash"
        let persisted ← readOptionalField capitalJson "persisted" readPersistedAuthorityGrant
        pure (CapitalAuthority.granted generation persisted)
      | _ => throw "unknown capital authority"
    return toJson (constructExecutionAuthority (← json.getObjValAs? Bool "readOnly") capital
      (← json.getObjValAs? String "brokerIdentityHash")
      (← readExecutionStrategy (← json.getObjVal? "strategy")) (← readInteger json "now"))
  | "ledgerTransferVerification" =>
    let expected ← (← (← json.getObjVal? "expected").getArr?).toList.mapM readLedgerTransfer
    let actual ← (← (← json.getObjVal? "actual").getArr?).toList.mapM readLedgerTransfer
    return Json.mkObj [
      ("exact", toJson (exactTransferSet actual expected)),
      ("missing", match transferPreflight expected actual with
        | none => Json.null
        | some values => toJson (values.map fun value => toString value.id))
    ]
  | "replaySessionComplete" =>
    let evidence : ReplaySessionEvidence := {
      finalWindow := ← json.getObjValAs? Bool "finalWindow",
      failedPassCount := ← readNatural json "failedPassCount",
      unavailableDecisionPassCount := ← readNatural json "unavailableDecisionPassCount",
      valuationFailureCount := ← readNatural json "valuationFailureCount",
      reconciliationExact := ← json.getObjValAs? Bool "reconciliationExact",
      accountingExact := ← json.getObjValAs? Bool "accountingExact",
      discrepancyCount := ← readNatural json "discrepancyCount",
      cashDifference := ← readInteger json "cashDifference",
      positionDifference := ← readInteger json "positionDifference",
      equityDifference := ← readInteger json "equityDifference",
      unknownOrderCount := ← readNatural json "unknownOrderCount",
      unknownMutationCount := ← readNatural json "unknownMutationCount",
      remainingPositionCount := ← readNatural json "remainingPositionCount",
      remainingOpenOrderCount := ← readNatural json "remainingOpenOrderCount"
    }
    return toJson (decide (replaySessionPass evidence))
  | "registeredMarketWindow" =>
    return toJson (registeredMarketWindow (← readInteger json "openAt") (← readInteger json "closeAt")
      (← readInteger json "observedAt"))
  | "mutationAuthority" =>
    let operation ← match ← json.getObjValAs? String "mutationOperation" with
      | "SUBMIT" => pure MutationOperationKind.submit
      | "CANCEL" => pure MutationOperationKind.cancel
      | _ => throw "unknown mutation operation"
    match mutationAuthority (← readOptionalField json "authority" readMutationAuthority) operation
        (← json.getObjValAs? Bool "closeOnly") with
    | none => return Json.null
    | some (account, generation) => return Json.mkObj [("accountId", toJson account), ("generationHash", toJson generation)]
  | "boundAuthority" =>
    let readBinding (key : String) : Except String AuthorityBinding := do
      let value ← json.getObjVal? key
      return ⟨← value.getObjValAs? String "account", ← value.getObjValAs? String "strategy", ← value.getObjValAs? String "generation"⟩
    return toJson (boundAuthority (← readBinding "expected") (← readBinding "observed"))
  | "tariffMeetsFloor" =>
    return toJson (tariffMeetsFloor (← readNatural json "inputRate") (← readNatural json "outputRate")
      (← readNatural json "inputFloor") (← readNatural json "outputFloor"))
  | "accountProtection" =>
    return toJson (accountProtectionReasons (← readInteger json "equity") (← readInteger json "dayStart")
      (← readInteger json "peak") (← readInteger json "dailyLimit") (← readInteger json "drawdownLimit"))
  | "controllerDurations" =>
    let clock : ControllerClock := {
      issuedAt := ← readInteger json "issuedAt", observedAt := ← readInteger json "observedAt",
      completedAt := ← readInteger json "completedAt", witnessedAt := ← readInteger json "witnessedAt"
    }
    match controllerDurations clock with
    | none => return Json.null
    | some (completed, witnessed) => return Json.mkObj [
        ("commandThroughCompletionMs", toJson (toString completed)),
        ("commandThroughDurableVisibilityMs", toJson (toString witnessed))]
  | "fullBatchDuration" =>
    match fullBatchDuration (← readInteger json "issuedAt") (← readInteger json "observedAt")
        (← readInteger json "batchCompletedAt") (← readIntegerArray (← json.getObjVal? "completions")).toList with
    | none => return Json.null
    | some value => return toJson (toString value)
  | "replayDecisionReleaseAt" =>
    match replayDecisionReleaseAt (← readInteger json "issuedAt") (← readInteger json "completedAt")
        (← readInteger json "p95Ms") with
    | none => return Json.null
    | some value => return toJson (toString value)
  | "nearestRank95" =>
    match nearestRank95Value (← readIntegerArray (← json.getObjVal? "values")).toList with
    | none => return Json.null
    | some value => return toJson (toString value)
  | "signalWindow" =>
    return toJson (toString (signalWindowEnd (← readInteger json "observedAt") (← readInteger json "delay")))
  | "decisionSchedule" =>
    return toJson ((decisionWindows (← readInteger json "open") (← readInteger json "close")
      (← readInteger json "delay") (← readInteger json "deadline")).map fun (due, deadline) =>
        Json.mkObj [("dueAt", toJson (toString due)), ("deadlineAt", toJson (toString deadline))])
  | "holdCompletion" =>
    let e : HoldCompletion := {
      observedAt := ← readInteger json "observedAt", passObservedAt := ← readInteger json "passObservedAt",
      completedAt := ← readInteger json "completedAt", witnessedAt := ← readInteger json "witnessedAt",
      validUntil := ← readInteger json "validUntil"
    }
    return toJson (decide (supportedHoldCompletion e))
  | "mutationTransition" =>
    return toJson (allowsMutationOutcome (← readMutationKind (← json.getObjVal? "previous"))
      (← readMutationKind (← json.getObjVal? "next")))
  | "mutationReplay" =>
    return toJson (sameMutationOutcome (← readMutationOutcome (← json.getObjVal? "previous"))
      (← readMutationOutcome (← json.getObjVal? "next")))
  | "decisionAdmissionEligible" =>
    return toJson (decisionAdmissionEligible (← json.getObjValAs? Bool "sourceCommitted")
      (← json.getObjValAs? Bool "sourceMatches"))
  | "mutationAdmissionIndependent" =>
    return toJson (mutationAdmissionIndependent (← json.getObjValAs? Bool "ambient"))
  | "decisionCommitmentUpperBound" =>
    let bound := decisionCommitmentUpperBound (← json.getObjValAs? Bool "receiptValid")
      (← json.getObjValAs? Bool "independent") (← json.getObjValAs? Bool "routed")
      (← readInteger json "created") (← readInteger json "admitted") (← readInteger json "routing")
      (← readInteger json "observed") (← readInteger json "asOf")
    return toJson (bound.map toString)
  | "persistenceObservation" =>
    return toJson (persistenceObservation (← readInteger json "created") (← readInteger json "knownBy")
      (← readInteger json "routing"))
  | "executionTiming" =>
    let source ← json.getObjVal? "pricing"
    let hash ← source.getObjValAs? String "source"
    let available ← readInteger source "availableAt"
    let pricing ← match ← source.getObjValAs? String "kind" with
      | "SpotQuote" => do pure (ExecutionPricingBasis.spotQuote hash available (← readInteger source "freshUntil"))
      | "NativeProtection" => pure (ExecutionPricingBasis.nativeProtection hash available)
      | "ReconciledLiquidation" => pure (ExecutionPricingBasis.reconciledLiquidation hash available)
      | _ => throw "Unknown execution pricing kind"
    let t : ExecutionTiming := {
      decisionAt := ← readInteger json "decisionAt", persistedAt := ← readInteger json "persistedAt",
      routingStartedAt := ← readInteger json "routingStartedAt", requestDispatchedAt := ← readInteger json "requestDispatchedAt",
      pricing, evidenceKind := ← json.getObjValAs? String "evidenceKind", side := ← json.getObjValAs? String "side",
      verifiedSources := ← json.getObjValAs? (List String) "verifiedSources",
      submissionDeadlineAt := ← readInteger json "submissionDeadlineAt", filledAt := ← readInteger json "filledAt",
      expiresAt := ← readInteger json "expiresAt"
    }
    return toJson (decide (supportedExecutionTiming t))
  | "protectionIntent" =>
    return toJson (decide (supportedProtectionIntent (← readProtectionEntry (← json.getObjVal? "entry"))
      (← readProtectionIntentEvidence (← json.getObjVal? "evidence"))))
  | "protectionAdmission" =>
    return toJson (decide (supportedProtectionAdmission
      (← json.getObjValAs? Bool "sourceCommitted") (← json.getObjValAs? Bool "riskCommitted")
      (← json.getObjValAs? Bool "sourceMatches") (← json.getObjValAs? String "outcome")
      (← readInteger json "decided") (← readInteger json "admitted") (← readInteger json "expires")))
  | "nativeOrderGroup" =>
    return nativeOrderBindingJson (resolveNativeOrderGroup (← json.getObjValAs? String "id")
      (← readNativeOrderReceipt (← json.getObjVal? "root"))
      (← (← (← json.getObjVal? "children").getArr?).toList.mapM readNativeOrderReceipt)
      (← readNativeOrderTarget (← json.getObjVal? "target")))
  | "protectiveDisposalBudget" =>
    return toJson (protectiveDisposalBudget (← readInteger json "available")
      (← readInteger json "disposed") (← readInteger json "quantity"))
  | "orderTerms" =>
    return toJson (limitTimeInForce (← json.getObjValAs? Bool "equity"))
  | "sizing" =>
    let equity ← readNatural json "equity"
    let weight ← readNatural json "weight"
    let price ← readNatural json "price"
    let increment ← readNatural json "increment"
    if weight > 1000000000000 ∨ price = 0 ∨ increment = 0 then throw "invalid sizing domain"
    return toJson (toString (desiredQuantity equity weight price increment))
  | "ceiling" =>
    let value ← readNatural json "value"
    let divisor ← readNatural json "divisor"
    if divisor = 0 then throw "invalid divisor"
    return toJson (toString (ceilingDivide value divisor))
  | "cashInventory" =>
    return toJson (toString (cashInventoryProfit (← readInteger json "openingEquityMicros")
      (← readInteger json "closingEquityMicros") (← readInteger json "netExternalFlowsMicros")
      (← readInteger json "passiveCashYieldMicros") (← readNatural json "operatingCostsPaidFromAccountMicros")))
  | "datedEquityTafRate" =>
    let rate := datedEquityTafRate (← json.getObjValAs? Bool "retained")
      (← readNatural json "sessionDate") (← readNatural json "baseRate")
    return match rate with
      | some value => toJson (toString value)
      | none => Json.null
  | "qualification" =>
    let reliability ← (← (← json.getObjVal? "reliability").getArr?).mapM fun row => do
      return (← readNatural row "good", ← readNatural row "scheduled")
    let evidence : QualificationEvidence := {
      sessionCount := ← readNatural json "sessionCount",
      controlCount := ← readNatural json "controlCount",
      blockLength := ← readNatural json "blockLengthSessions",
      bootstrapReplicates := ← readNatural json "replicates",
      attemptIndex := ← readNatural json "attemptIndex",
      netProfit := ← readInteger json "netProfit",
      profitLowerBoundTotal := ← readInteger json "profitLowerBoundTotal",
      pairedLowerBoundTotals := (← readIntegerArray (← json.getObjVal? "pairedLowerBoundTotals")).toList,
      maximumSessionLoss := ← readNatural json "maximumSessionLoss",
      maximumDrawdown := ← readNatural json "maximumDrawdown",
      maximumSessionLossLimit := ← readNatural json "maximumSessionLossLimit",
      maximumDrawdownLimit := ← readNatural json "maximumDrawdownLimit",
      reliability := reliability.toList,
      safetyViolations := ← readNatural json "safetyViolations",
      completeEvidence := ← json.getObjValAs? Bool "completeEvidence",
      supportedRealism := ← json.getObjValAs? Bool "supportedRealism"
    }
    return toJson (decide (qualificationPass evidence))
  | "reportedCash" =>
    let amount ← readInteger json "amount"
    let quantum ← readNatural json "quantum"
    if quantum = 0 then throw "cash quantum must be positive"
    return toJson (toString (reportedCash amount quantum))
  | "controllerTick" =>
    let present ← json.getObjValAs? Bool "present"
    let controller : Controller := {
      active := ← json.getObjValAs? Bool "active", epoch := ← readNatural json "epoch",
      sequence := ← readNatural json "sequence", source := ← json.getObjValAs? String "source"
    }
    return toJson (controllerTick (if present then some controller else none)
      (← readNatural json "tickEpoch") (← readNatural json "tickSequence") (← json.getObjValAs? String "workerSource"))
  | "bootstrap" =>
    let candidate ← readIntegerArray (← json.getObjVal? "candidate")
    let controls ← (← (← json.getObjVal? "controls").getArr?).mapM readIntegerArray
    let attempt ← readNatural json "attemptIndex"
    if candidate.size == 0 || controls.size == 0 || controls.any (fun c => c.size != candidate.size) then
      throw "bootstrap requires a nonempty matched window and selected controls"
    let blockLength ← readNatural json "blockLengthSessions"
    let replicates ← readNatural json "replicates"
    let seed ← readNatural json "seed"
    if blockLength == 0 || candidate.size < blockLength || seed == 0 || 4294967295 < seed then throw "invalid registered bootstrap plan"
    if ¬ tailResolutionSupported attempt controls.size replicates then throw "unsupported bootstrap tail resolution"
    let result := registeredBootstrap candidate controls attempt blockLength replicates seed
    return Json.mkObj [
      ("lowerProfitTotalMicros", toJson (toString result.lowerProfitTotal)),
      ("lowerIncrementalTotalsMicros", toJson (result.lowerIncrementalTotals.map toString))]
  | "economics" =>
    let trading := tradingProfit (← readInteger json "grossRealizedPnlMicros")
      (← readInteger json "openingUnrealizedPnlMicros") (← readInteger json "closingUnrealizedPnlMicros")
      (← readInteger json "executionCostMicros") (← readInteger json "cashSettlementRoundingMicros")
    let costs : OperatingCosts := {
      invoice := ← readNatural json "inferenceInvoiceMicros", tariff := ← readNatural json "inferenceTariffMicros",
      data := ← readNatural json "dataCostMicros", infrastructure := ← readNatural json "infrastructureCostMicros",
      research := ← readNatural json "researchCostMicros"
    }
    return Json.mkObj [
      ("netTradingPnlMicros", toJson (toString trading)),
      ("totalOperatingCostMicros", toJson (toString (operatingCost costs))),
      ("netEconomicPnlMicros", toJson (toString (economicProfit trading costs))),
      ("qualificationInferenceCostMicros", toJson (toString (max costs.invoice costs.tariff))),
      ("qualificationPnlMicros", toJson (toString (qualificationProfit trading costs)))]
  | "qualificationEquity" =>
    let decode := fun value => do
      let text ← value.getStr?
      match text.toInt? with
      | some n => return n
      | none => throw "equity and profit must be integer strings or null"
    let opening ← readOptionalField json "opening" decode
    let profit ← readOptionalField json "profit" decode
    match advanceQualificationEquity opening profit with
    | some balance => return toJson (toString balance)
    | none => return Json.null
  | "reliability" =>
    let good ← readNatural json "good"
    let scheduled ← readNatural json "scheduled"
    return toJson (if scheduled = 0 ∨ good > scheduled then "UNDETERMINED"
      else if reliabilityPass good scheduled then "MEETS_TARGET" else "MISSES_TARGET")
  | "binaryEdge" =>
    let gain ← readNatural json "gainMicros"
    let loss ← readNatural json "lossMicros"
    let cost ← readNatural json "costMicros"
    let p ← readNatural json "winProbabilityNumerator"
    let d ← readNatural json "winProbabilityDenominator"
    if d = 0 ∨ d < p ∨ gain + loss = 0 then throw "invalid binary edge domain"
    let numerator := binaryEdgeNumerator gain loss cost p d
    return Json.mkObj [
      ("expectedNetMicros", Json.mkObj [("numerator", toJson (toString numerator)), ("denominator", toJson (toString d))]),
      ("breakEvenWinProbability", Json.mkObj [("numerator", toJson (toString (loss + cost))), ("denominator", toJson (toString (gain + loss)))]),
      ("positive", toJson (decide (0 < numerator)))]
  | _ => throw "unsupported model operation"

def main : IO Unit := do
  let stdin ← IO.getStdin
  let stdout ← IO.getStdout
  repeat
    let line ← stdin.getLine
    if line.isEmpty then break
    let result := Json.parse line >>= evaluate
    let output := match result with
      | .ok value => Json.mkObj [("result", value)]
      | .error message => Json.mkObj [("error", toJson message)]
    stdout.putStrLn output.compress
