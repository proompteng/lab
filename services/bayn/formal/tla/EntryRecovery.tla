---------------------------- MODULE EntryRecovery ----------------------------
EXTENDS Integers
CONSTANTS Deadline, NormalDelay, RetryDelay
ASSUME /\ Deadline > 0 /\ NormalDelay > 0 /\ RetryDelay > 0
VARIABLES now, state, snapshotBound, decisionBound, mode, inputReady,
          wake, lastDelay, scheduled, lastShort, decisionAt, sawInput
vars == <<now, state, snapshotBound, decisionBound, mode, inputReady,
          wake, lastDelay, scheduled, lastShort, decisionAt, sawInput>>
Modes == {"INITIAL", "LATER", "CONSUMED", "SOURCE_UNAVAILABLE"}
States == {"ACTIVE", "COMPLETED", "BLOCKED"}
Minimum(a, b) == IF a < b THEN a ELSE b
Pending == mode \in {"INITIAL", "LATER"}
ShortEligible == Pending /\ state = "ACTIVE" /\ ~snapshotBound /\ ~decisionBound /\ now < Deadline
ContinuationDelay == IF ShortEligible
                     THEN Minimum(RetryDelay, Minimum(NormalDelay, Deadline - now)) ELSE 0

Init == /\ now = 0 /\ state = "ACTIVE"
        /\ snapshotBound \in BOOLEAN /\ decisionBound \in BOOLEAN /\ mode \in Modes
        /\ inputReady = FALSE /\ wake = 0 /\ lastDelay = 0
        /\ scheduled = FALSE /\ lastShort = FALSE /\ decisionAt = -1 /\ sawInput = FALSE
Tick == /\ now < Deadline /\ now' = now + 1
        /\ UNCHANGED <<state, snapshotBound, decisionBound, mode, inputReady,
                      wake, lastDelay, scheduled, lastShort, decisionAt, sawInput>>
Arrive == /\ now < Deadline /\ ~inputReady /\ inputReady' = TRUE
          /\ UNCHANGED <<now, state, snapshotBound, decisionBound, mode,
                        wake, lastDelay, scheduled, lastShort, decisionAt, sawInput>>
LoseInput == /\ inputReady /\ inputReady' = FALSE
             /\ UNCHANGED <<now, state, snapshotBound, decisionBound, mode,
                           wake, lastDelay, scheduled, lastShort, decisionAt, sawInput>>
Poll == /\ state = "ACTIVE" /\ ~snapshotBound /\ ~decisionBound
        /\ now >= wake /\ now < Deadline
        /\ IF inputReady
           THEN /\ state' = "COMPLETED" /\ decisionBound' = TRUE
                /\ decisionAt' = now /\ sawInput' = TRUE
                /\ UNCHANGED <<wake, lastDelay, scheduled, lastShort>>
           ELSE /\ lastDelay' = IF Pending THEN ContinuationDelay ELSE NormalDelay
                /\ wake' = now + lastDelay' /\ scheduled' = TRUE /\ lastShort' = Pending
                /\ UNCHANGED <<state, decisionBound, decisionAt, sawInput>>
        /\ UNCHANGED <<now, snapshotBound, mode, inputReady>>
Expire == /\ now = Deadline /\ state = "ACTIVE" /\ ~snapshotBound /\ ~decisionBound
          /\ state' = "BLOCKED"
          /\ UNCHANGED <<now, snapshotBound, decisionBound, mode, inputReady,
                        wake, lastDelay, scheduled, lastShort, decisionAt, sawInput>>
Terminal == /\ now = Deadline /\ (state # "ACTIVE" \/ snapshotBound \/ decisionBound)
            /\ UNCHANGED vars
Next == Tick \/ Arrive \/ LoseInput \/ Poll \/ Expire \/ Terminal
Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ WF_vars(Expire)
TypeOK == /\ now \in 0..Deadline /\ state \in States /\ mode \in Modes
          /\ snapshotBound \in BOOLEAN /\ decisionBound \in BOOLEAN /\ inputReady \in BOOLEAN
          /\ wake \in 0..(Deadline + NormalDelay) /\ lastDelay \in 0..NormalDelay
          /\ scheduled \in BOOLEAN /\ lastShort \in BOOLEAN
          /\ decisionAt \in (-1)..Deadline /\ sawInput \in BOOLEAN
CappedRetries == (scheduled /\ lastShort) =>
                 (wake <= Deadline /\ lastDelay > 0 /\ lastDelay <= RetryDelay)
NoLateDecision == decisionAt < Deadline
DecisionsNeedInputs == (state = "COMPLETED") => sawInput
ClockProgress == <>(now = Deadline)
UnusedEventuallyClosed == (now = Deadline /\ ~snapshotBound /\ ~decisionBound) ~> (state # "ACTIVE")
ConformanceView == [now |-> now, state |-> state, snapshotBound |-> snapshotBound,
  decisionBound |-> decisionBound, mode |-> mode, inputReady |-> inputReady,
  wake |-> wake, lastDelay |-> lastDelay, scheduled |-> scheduled, lastShort |-> lastShort,
  decisionAt |-> decisionAt, sawInput |-> sawInput, continuationDelay |-> ContinuationDelay,
  deadline |-> Deadline, normalDelay |-> NormalDelay, retryDelay |-> RetryDelay]
=============================================================================
