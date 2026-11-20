---------------------------- MODULE EntryRecovery ----------------------------
EXTENDS Integers
CONSTANTS Deadline, NormalDelay, RetryDelay, EligibilityAt
ASSUME /\ Deadline > EligibilityAt /\ EligibilityAt > 1
       /\ NormalDelay > RetryDelay /\ RetryDelay = 1
VARIABLES now, state, snapshotBound, decisionBound, mode, inputReady,
          wake, lastDelay, scheduled, lastShort, decisionAt, sawInput,
          eventPending, admissionOpen, openDelivered
vars == <<now, state, snapshotBound, decisionBound, mode, inputReady,
          wake, lastDelay, scheduled, lastShort, decisionAt, sawInput,
          eventPending, admissionOpen, openDelivered>>
Modes == {"STREAM", "ELIGIBILITY", "AT_EXPIRY", "INFERENCE_EXPIRED", "RISK_EXPIRED"}
States == {"ACTIVE", "COMPLETED", "BLOCKED"}
WithinAdmission == state = "ACTIVE" /\ ~snapshotBound /\ ~decisionBound
                   /\ admissionOpen <= now /\ now < Deadline
ExpiredWork == mode \in {"INFERENCE_EXPIRED", "RISK_EXPIRED"}
KnownBoundary == mode \in {"ELIGIBILITY", "AT_EXPIRY"}
BoundaryAt == IF mode = "ELIGIBILITY" THEN EligibilityAt ELSE Deadline
ContinuationDelay == IF WithinAdmission /\ ExpiredWork THEN RetryDelay
                     ELSE IF WithinAdmission /\ mode = "ELIGIBILITY"
                             /\ now < EligibilityAt /\ EligibilityAt - now < NormalDelay
                          THEN EligibilityAt - now ELSE 0

Init == /\ now = 0 /\ state = "ACTIVE"
        /\ snapshotBound \in BOOLEAN /\ decisionBound \in BOOLEAN /\ mode \in Modes
        /\ inputReady = FALSE /\ wake = 0 /\ lastDelay = 0
        /\ scheduled = FALSE /\ lastShort = FALSE /\ decisionAt = -1 /\ sawInput = FALSE
        /\ eventPending = TRUE /\ admissionOpen \in 0..1 /\ openDelivered = FALSE
Tick == /\ now < Deadline /\ now' = now + 1
        /\ UNCHANGED <<state, snapshotBound, decisionBound, mode, inputReady,
                      wake, lastDelay, scheduled, lastShort, decisionAt, sawInput,
                      eventPending, admissionOpen, openDelivered>>
Arrive == /\ now < Deadline /\ ~inputReady /\ (~KnownBoundary \/ now >= BoundaryAt)
          /\ inputReady' = TRUE /\ eventPending' = TRUE
          /\ UNCHANGED <<now, state, snapshotBound, decisionBound, mode,
                        wake, lastDelay, scheduled, lastShort, decisionAt, sawInput,
                        admissionOpen, openDelivered>>
LoseInput == /\ inputReady /\ inputReady' = FALSE
             /\ UNCHANGED <<now, state, snapshotBound, decisionBound, mode,
                           wake, lastDelay, scheduled, lastShort, decisionAt, sawInput,
                           eventPending, admissionOpen, openDelivered>>
WindowOpens == /\ ~openDelivered /\ admissionOpen <= now /\ now < Deadline
               /\ openDelivered' = TRUE /\ eventPending' = TRUE
               /\ UNCHANGED <<now, state, snapshotBound, decisionBound, mode, inputReady,
                             wake, lastDelay, scheduled, lastShort, decisionAt, sawInput,
                             admissionOpen>>
Wake == /\ scheduled /\ now >= wake /\ state = "ACTIVE"
        /\ scheduled' = FALSE /\ eventPending' = TRUE
        /\ UNCHANGED <<now, state, snapshotBound, decisionBound, mode, inputReady,
                      wake, lastDelay, lastShort, decisionAt, sawInput, admissionOpen, openDelivered>>
React == /\ state = "ACTIVE" /\ ~snapshotBound /\ ~decisionBound
         /\ eventPending /\ now < Deadline
         /\ eventPending' = FALSE
         /\ IF inputReady /\ admissionOpen <= now
            THEN /\ state' = "COMPLETED" /\ decisionBound' = TRUE
                 /\ decisionAt' = now /\ sawInput' = TRUE
                 /\ wake' = 0 /\ lastDelay' = 0 /\ scheduled' = FALSE /\ lastShort' = FALSE
            ELSE /\ lastDelay' = ContinuationDelay
                 /\ wake' = IF ContinuationDelay > 0 THEN now + ContinuationDelay ELSE 0
                 /\ scheduled' = (ContinuationDelay > 0) /\ lastShort' = (ExpiredWork /\ ContinuationDelay > 0)
                 /\ UNCHANGED <<state, decisionBound, decisionAt, sawInput>>
         /\ UNCHANGED <<now, snapshotBound, mode, inputReady, admissionOpen, openDelivered>>
Expire == /\ now = Deadline /\ state = "ACTIVE" /\ ~snapshotBound /\ ~decisionBound
          /\ state' = "BLOCKED" /\ eventPending' = FALSE /\ scheduled' = FALSE
          /\ wake' = 0 /\ lastDelay' = 0 /\ lastShort' = FALSE
          /\ UNCHANGED <<now, snapshotBound, decisionBound, mode, inputReady,
                        decisionAt, sawInput, admissionOpen, openDelivered>>
Terminal == /\ now = Deadline /\ (state # "ACTIVE" \/ snapshotBound \/ decisionBound)
            /\ UNCHANGED vars
Next == Tick \/ Arrive \/ LoseInput \/ WindowOpens \/ Wake \/ React \/ Expire \/ Terminal
Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ WF_vars(Expire)
             /\ WF_vars(WindowOpens) /\ WF_vars(Wake) /\ WF_vars(React)
TypeOK == /\ now \in 0..Deadline /\ state \in States /\ mode \in Modes
          /\ snapshotBound \in BOOLEAN /\ decisionBound \in BOOLEAN /\ inputReady \in BOOLEAN
          /\ wake \in 0..(Deadline + NormalDelay) /\ lastDelay \in 0..NormalDelay
          /\ scheduled \in BOOLEAN /\ lastShort \in BOOLEAN
          /\ decisionAt \in (-1)..Deadline /\ sawInput \in BOOLEAN
          /\ eventPending \in BOOLEAN /\ admissionOpen \in 0..1 /\ openDelivered \in BOOLEAN
CappedRetries == (scheduled /\ lastShort) =>
                 (wake <= Deadline /\ lastDelay > 0 /\ lastDelay <= RetryDelay)
TimersRespectAdmission == scheduled => (wake <= Deadline /\ lastDelay > 0 /\ lastDelay < NormalDelay)
EligibilityDeadlineIsOriginal == (scheduled /\ mode = "ELIGIBILITY") => wake = EligibilityAt
UnknownSourcesDoNotPoll == (mode \in {"STREAM", "AT_EXPIRY"}) => ~scheduled
NoLateDecision == decisionAt < Deadline
DecisionsNeedInputs == (state = "COMPLETED") => sawInput
DecisionsAfterOpen == (state = "COMPLETED") => decisionAt >= admissionOpen
ClockProgress == <>(now = Deadline)
UnusedEventuallyClosed == (now = Deadline /\ ~snapshotBound /\ ~decisionBound) ~> (state # "ACTIVE")
ConformanceView == [now |-> now, state |-> state, snapshotBound |-> snapshotBound,
  decisionBound |-> decisionBound, mode |-> mode, inputReady |-> inputReady,
  wake |-> wake, lastDelay |-> lastDelay, scheduled |-> scheduled, lastShort |-> lastShort,
  decisionAt |-> decisionAt, sawInput |-> sawInput, continuationDelay |-> ContinuationDelay,
  deadline |-> Deadline, normalDelay |-> NormalDelay, retryDelay |-> RetryDelay,
  eventPending |-> eventPending, admissionOpen |-> admissionOpen, openDelivered |-> openDelivered,
  eligibilityAt |-> EligibilityAt]
=============================================================================
