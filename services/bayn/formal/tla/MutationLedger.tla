---------------------------- MODULE MutationLedger ----------------------------
EXTENDS Naturals
VARIABLES operation, closeOnly, maximum, effective, killed, generationExecution,
          accountBound, phase, starts, authorizedStart, filled, postedA, postedB,
          corrupt, duplicate, accounted, worker, pendingA1, pendingA2, pendingB1, pendingB2
vars == <<operation, closeOnly, maximum, effective, killed, generationExecution,
          accountBound, phase, starts, authorizedStart, filled, postedA, postedB,
          corrupt, duplicate, accounted, worker, pendingA1, pendingA2, pendingB1, pendingB2>>
RecoveryEvents == {"RECOVERY_FOUND", "RECOVERY_NOT_FOUND", "RECOVERY_UNKNOWN"}
Events == {"SUBMIT_STARTED", "SUBMIT_ACCEPTED", "SUBMIT_REJECTED", "SUBMIT_DENIED",
           "SUBMIT_UNKNOWN", "CANCEL_STARTED", "CANCEL_ACCEPTED", "CANCEL_UNKNOWN"} \cup RecoveryEvents
Allows(previous, next) ==
  CASE previous = "SUBMIT_STARTED" -> next \in {"SUBMIT_ACCEPTED", "SUBMIT_REJECTED", "SUBMIT_DENIED", "SUBMIT_UNKNOWN"}
    [] previous = "CANCEL_STARTED" -> next \in {"CANCEL_ACCEPTED", "CANCEL_UNKNOWN"}
    [] previous \in {"SUBMIT_ACCEPTED", "SUBMIT_UNKNOWN", "CANCEL_ACCEPTED", "CANCEL_UNKNOWN"} \cup RecoveryEvents -> next \in RecoveryEvents
    [] OTHER -> FALSE
AuthorityAllowed == maximum /\ generationExecution /\ accountBound /\
  (IF operation = "SUBMIT" THEN ((effective /\ ~killed) \/ closeOnly) ELSE (effective \/ killed))
MayStart == phase = "NONE" /\ AuthorityAllowed
PreflightValid == ~corrupt /\ ~duplicate
MissingA == PreflightValid /\ postedA = 0
MissingB == PreflightValid /\ postedB = 0
Exact == PreflightValid /\ postedA = 1 /\ postedB = 1

Init == /\ operation \in {"SUBMIT", "CANCEL"} /\ closeOnly \in BOOLEAN
        /\ maximum \in BOOLEAN /\ effective \in BOOLEAN /\ killed \in BOOLEAN
        /\ generationExecution \in BOOLEAN /\ accountBound \in BOOLEAN
        /\ phase = "NONE" /\ starts = 0 /\ authorizedStart = TRUE
        /\ filled = FALSE /\ postedA = 0 /\ postedB = 0
        /\ corrupt = FALSE /\ duplicate = FALSE /\ accounted = FALSE /\ worker = 1
        /\ pendingA1 = FALSE /\ pendingA2 = FALSE /\ pendingB1 = FALSE /\ pendingB2 = FALSE
Start == /\ MayStart
         /\ phase' = IF operation = "SUBMIT" THEN "SUBMIT_STARTED" ELSE "CANCEL_STARTED"
         /\ starts' = starts + 1 /\ authorizedStart' = AuthorityAllowed
         /\ UNCHANGED <<operation, closeOnly, maximum, effective, killed, generationExecution,
                       accountBound, filled, postedA, postedB, corrupt, duplicate, accounted, worker,
                       pendingA1, pendingA2, pendingB1, pendingB2>>
Outcome == /\ \E event \in Events: /\ Allows(phase, event) /\ phase' = event
           /\ UNCHANGED <<operation, closeOnly, maximum, effective, killed, generationExecution,
                         accountBound, starts, authorizedStart, filled, postedA, postedB,
                         corrupt, duplicate, accounted, worker, pendingA1, pendingA2, pendingB1, pendingB2>>
ChangeAuthority == /\ effective' \in BOOLEAN /\ killed' \in BOOLEAN
                   /\ UNCHANGED <<operation, closeOnly, maximum, generationExecution, accountBound,
                                 phase, starts, authorizedStart, filled, postedA, postedB,
                                 corrupt, duplicate, accounted, worker, pendingA1, pendingA2, pendingB1, pendingB2>>
Fill == /\ operation = "SUBMIT" /\ phase \in {"SUBMIT_ACCEPTED", "RECOVERY_FOUND"} /\ ~filled
        /\ filled' = TRUE
        /\ UNCHANGED <<operation, closeOnly, maximum, effective, killed, generationExecution,
                      accountBound, phase, starts, authorizedStart, postedA, postedB,
                      corrupt, duplicate, accounted, worker, pendingA1, pendingA2, pendingB1, pendingB2>>
Preflight == /\ filled /\ PreflightValid
             /\ IF worker = 1
                THEN /\ pendingA1' = MissingA /\ pendingB1' = MissingB /\ UNCHANGED <<pendingA2, pendingB2>>
                ELSE /\ pendingA2' = MissingA /\ pendingB2' = MissingB /\ UNCHANGED <<pendingA1, pendingB1>>
             /\ UNCHANGED <<operation, closeOnly, maximum, effective, killed, generationExecution,
                           accountBound, phase, starts, authorizedStart, filled, postedA, postedB,
                           corrupt, duplicate, accounted, worker>>
PostA == /\ filled /\ (IF worker = 1 THEN pendingA1 ELSE pendingA2)
         /\ postedA' = IF postedA = 0 THEN 1 ELSE postedA
         /\ IF worker = 1 THEN /\ pendingA1' = FALSE /\ UNCHANGED pendingA2
                           ELSE /\ pendingA2' = FALSE /\ UNCHANGED pendingA1
         /\ UNCHANGED <<operation, closeOnly, maximum, effective, killed, generationExecution,
                       accountBound, phase, starts, authorizedStart, filled, postedB,
                       corrupt, duplicate, accounted, worker, pendingB1, pendingB2>>
PostB == /\ filled /\ (IF worker = 1 THEN pendingB1 ELSE pendingB2)
         /\ postedB' = IF postedB = 0 THEN 1 ELSE postedB
         /\ IF worker = 1 THEN /\ pendingB1' = FALSE /\ UNCHANGED pendingB2
                           ELSE /\ pendingB2' = FALSE /\ UNCHANGED pendingB1
         /\ UNCHANGED <<operation, closeOnly, maximum, effective, killed, generationExecution,
                       accountBound, phase, starts, authorizedStart, filled, postedA,
                       corrupt, duplicate, accounted, worker, pendingA1, pendingA2>>
IntegrityFault == /\ ~accounted /\ (postedA = 1 \/ postedB = 1)
                  /\ corrupt' \in BOOLEAN /\ duplicate' \in BOOLEAN /\ (corrupt' \/ duplicate')
                  /\ UNCHANGED <<operation, closeOnly, maximum, effective, killed, generationExecution,
                                accountBound, phase, starts, authorizedStart, filled, postedA, postedB, accounted,
                                worker, pendingA1, pendingA2, pendingB1, pendingB2>>
Verify == /\ filled /\ Exact /\ ~accounted /\ accounted' = TRUE
          /\ UNCHANGED <<operation, closeOnly, maximum, effective, killed, generationExecution,
                        accountBound, phase, starts, authorizedStart, filled, postedA, postedB,
                        corrupt, duplicate, worker, pendingA1, pendingA2, pendingB1, pendingB2>>
SwitchWorker == /\ worker' = 3 - worker
           /\ UNCHANGED <<operation, closeOnly, maximum, effective, killed, generationExecution,
                         accountBound, phase, starts, authorizedStart, filled, postedA, postedB,
                         corrupt, duplicate, accounted, pendingA1, pendingA2, pendingB1, pendingB2>>
Restart == /\ IF worker = 1
              THEN /\ pendingA1' = FALSE /\ pendingB1' = FALSE /\ UNCHANGED <<pendingA2, pendingB2>>
              ELSE /\ pendingA2' = FALSE /\ pendingB2' = FALSE /\ UNCHANGED <<pendingA1, pendingB1>>
           /\ UNCHANGED <<operation, closeOnly, maximum, effective, killed, generationExecution,
                         accountBound, phase, starts, authorizedStart, filled, postedA, postedB,
                         corrupt, duplicate, accounted, worker>>
Next == Start \/ Outcome \/ ChangeAuthority \/ Fill \/ Preflight \/ PostA \/ PostB \/ IntegrityFault \/ Verify \/ SwitchWorker \/ Restart
Spec == Init /\ [][Next]_vars /\ WF_vars(Preflight) /\ SF_vars(PostA) /\ SF_vars(PostB) /\ WF_vars(Verify)
TypeOK == /\ operation \in {"SUBMIT", "CANCEL"} /\ phase \in Events \cup {"NONE"}
          /\ closeOnly \in BOOLEAN /\ maximum \in BOOLEAN /\ effective \in BOOLEAN /\ killed \in BOOLEAN
          /\ generationExecution \in BOOLEAN /\ accountBound \in BOOLEAN
          /\ starts \in 0..2 /\ authorizedStart \in BOOLEAN /\ filled \in BOOLEAN
          /\ postedA \in 0..2 /\ postedB \in 0..2 /\ corrupt \in BOOLEAN /\ duplicate \in BOOLEAN
          /\ accounted \in BOOLEAN /\ worker \in 1..2
          /\ pendingA1 \in BOOLEAN /\ pendingA2 \in BOOLEAN /\ pendingB1 \in BOOLEAN /\ pendingB2 \in BOOLEAN
NoDuplicateDispatch == starts <= 1
NoUnauthorizedStart == authorizedStart
NoDuplicatePosting == postedA <= 1 /\ postedB <= 1
AccountedExactly == accounted => (filled /\ Exact)
LedgerProgress == filled ~> (accounted \/ corrupt \/ duplicate)
ConformanceView == [operation |-> operation, closeOnly |-> closeOnly, maximum |-> maximum,
  effective |-> effective, killed |-> killed, generationExecution |-> generationExecution,
  accountBound |-> accountBound, phase |-> phase, starts |-> starts, authorizedStart |-> authorizedStart,
  filled |-> filled, postedA |-> postedA, postedB |-> postedB, corrupt |-> corrupt,
  duplicate |-> duplicate, accounted |-> accounted, worker |-> worker,
  pendingA1 |-> pendingA1, pendingA2 |-> pendingA2, pendingB1 |-> pendingB1, pendingB2 |-> pendingB2,
  authorityAllowed |-> AuthorityAllowed, mayStart |-> MayStart, preflightValid |-> PreflightValid,
  missingA |-> MissingA, missingB |-> MissingB, exact |-> Exact,
  submitAccepted |-> Allows(phase, "SUBMIT_ACCEPTED"), submitRejected |-> Allows(phase, "SUBMIT_REJECTED"),
  submitDenied |-> Allows(phase, "SUBMIT_DENIED"), submitUnknown |-> Allows(phase, "SUBMIT_UNKNOWN"),
  cancelAccepted |-> Allows(phase, "CANCEL_ACCEPTED"), cancelUnknown |-> Allows(phase, "CANCEL_UNKNOWN"),
  recoveryFound |-> Allows(phase, "RECOVERY_FOUND"), recoveryNotFound |-> Allows(phase, "RECOVERY_NOT_FOUND"),
  recoveryUnknown |-> Allows(phase, "RECOVERY_UNKNOWN")]
=============================================================================
