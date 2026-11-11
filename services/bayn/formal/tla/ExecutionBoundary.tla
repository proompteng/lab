-------------------------- MODULE ExecutionBoundary --------------------------
EXTENDS Naturals

VARIABLES phase, receipt, transaction, owner, worker, admissionWorker, revoked,
          revokePending, sent, broker, visible, response, terminal,
          secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache
vars == <<phase, receipt, transaction, owner, worker, admissionWorker, revoked,
          revokePending, sent, broker, visible, response, terminal,
          secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>

Relations == {"Before", "At", "After"}
Recoverable == {"SUBMIT_ACCEPTED", "SUBMIT_UNKNOWN", "RECOVERY_NOT_FOUND", "RECOVERY_FOUND"}
Unresolved == ~terminal /\ phase \in {"SUBMIT_STARTED", "SUBMIT_UNKNOWN", "RECOVERY_NOT_FOUND"}
AllowsSecond == ~Unresolved

Init == /\ phase = "NONE" /\ receipt = "None" /\ transaction = "None"
        /\ owner = 0 /\ worker = 1 /\ admissionWorker = 0
        /\ revoked = FALSE /\ revokePending = FALSE /\ sent = 0
        /\ broker = "None" /\ visible = FALSE /\ response = "None"
        /\ terminal = FALSE /\ secondStarted = FALSE /\ secondSent = 0
        /\ badSecondStart = FALSE /\ badSend = FALSE
        /\ cacheA = "Empty" /\ cacheB = "Empty" /\ eventRelation = "Before" /\ badCache = FALSE

BeginAdmission == /\ transaction = "None" /\ phase = "NONE" /\ ~revoked
                  /\ transaction' = "Admission" /\ owner' = worker
                  /\ UNCHANGED <<phase, receipt, worker, admissionWorker, revoked,
                       revokePending, sent, broker, visible, response, terminal,
                       secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>
CommitAdmission == /\ transaction = "Admission" /\ owner = worker
                   /\ phase' = "SUBMIT_STARTED" /\ receipt' = "Pending"
                   /\ admissionWorker' = owner /\ transaction' = "None" /\ owner' = 0
                   /\ cacheB' = "Stale"
                   /\ UNCHANGED <<worker, revoked, revokePending, sent, broker,
                        visible, response, terminal, secondStarted, secondSent, badSecondStart, badSend, cacheA, eventRelation, badCache>>
DeliverAdmission == /\ receipt = "Pending" /\ worker = admissionWorker
                    /\ receipt' = "Granted"
                    /\ UNCHANGED <<phase, transaction, owner, worker, admissionWorker,
                         revoked, revokePending, sent, broker, visible, response,
                         terminal, secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>
LoseAdmission == /\ receipt = "Pending" /\ receipt' = "Lost"
                 /\ UNCHANGED <<phase, transaction, owner, worker, admissionWorker,
                      revoked, revokePending, sent, broker, visible, response,
                      terminal, secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>

BeginFinal == /\ transaction = "None" /\ phase = "SUBMIT_STARTED"
              /\ receipt = "Granted" /\ worker = admissionWorker /\ ~revoked /\ cacheA = "Current"
              /\ transaction' = "Final" /\ owner' = worker
              /\ cacheA' = "Reserved"
              /\ UNCHANGED <<phase, receipt, worker, admissionWorker, revoked,
                   revokePending, sent, broker, visible, response, terminal,
                   secondStarted, secondSent, badSecondStart, badSend, cacheB, eventRelation, badCache>>
Send == /\ transaction = "Final" /\ owner = worker /\ receipt = "Granted" /\ sent = 0
        /\ cacheA = "Reserved"
        /\ sent' = sent + 1 /\ receipt' = "Consumed"
        /\ badSend' = (badSend \/ revoked \/ phase = "NONE" \/ cacheA # "Reserved")
        /\ UNCHANGED <<phase, transaction, owner, worker, admissionWorker, revoked,
             revokePending, broker, visible, response, terminal,
             secondStarted, secondSent, badSecondStart, cacheA, cacheB, eventRelation, badCache>>
Finish == /\ transaction \in {"Admission", "Final", "SecondFinal"} /\ owner = worker
          /\ transaction' = "None" /\ owner' = 0
          /\ cacheA' = (IF owner = worker /\ transaction = "Final" THEN "Stale" ELSE cacheA)
          /\ cacheB' = (IF owner = worker /\ transaction = "SecondFinal" THEN "Stale" ELSE cacheB)
          /\ UNCHANGED <<phase, receipt, worker, admissionWorker, revoked,
               revokePending, sent, broker, visible, response, terminal,
               secondStarted, secondSent, badSecondStart, badSend, eventRelation, badCache>>

Accept == /\ sent > 0 /\ broker = "None" /\ broker' = "Accepted"
          /\ UNCHANGED <<phase, receipt, transaction, owner, worker, admissionWorker,
               revoked, revokePending, sent, visible, response, terminal,
               secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>
Fill == /\ broker = "Accepted" /\ broker' = "Filled"
        /\ UNCHANGED <<phase, receipt, transaction, owner, worker, admissionWorker,
             revoked, revokePending, sent, visible, response, terminal,
             secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>
Reveal == /\ broker # "None" /\ ~visible /\ visible' = TRUE
          /\ UNCHANGED <<phase, receipt, transaction, owner, worker, admissionWorker,
               revoked, revokePending, sent, broker, response, terminal,
               secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>
Reply == /\ broker # "None" /\ response = "None" /\ response' = "Accepted"
         /\ UNCHANGED <<phase, receipt, transaction, owner, worker, admissionWorker,
              revoked, revokePending, sent, broker, visible, terminal,
              secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>
LoseReply == /\ sent > 0 /\ response = "None" /\ response' = "Lost"
             /\ UNCHANGED <<phase, receipt, transaction, owner, worker, admissionWorker,
                  revoked, revokePending, sent, broker, visible, terminal,
                  secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>
RecordReply == \E relation \in Relations:
  /\ transaction = "None" /\ phase = "SUBMIT_STARTED"
  /\ response \in {"Accepted", "Lost"}
  /\ phase' = (IF response = "Accepted" THEN "SUBMIT_ACCEPTED" ELSE "SUBMIT_UNKNOWN")
  /\ eventRelation' = relation
  /\ cacheA' = (IF relation = "Before" THEN cacheA ELSE "Stale")
  /\ cacheB' = (IF relation = "Before" THEN cacheB ELSE "Stale")
  /\ UNCHANGED <<receipt, transaction, owner, worker, admissionWorker,
       revoked, revokePending, sent, broker, visible, response, terminal,
       secondStarted, secondSent, badSecondStart, badSend, badCache>>

RecordUncertainStart == \E relation \in Relations:
  /\ transaction = "None" /\ phase = "SUBMIT_STARTED"
  /\ receipt = "Lost" /\ phase' = "SUBMIT_UNKNOWN"
  /\ eventRelation' = relation
  /\ cacheA' = (IF relation = "Before" THEN cacheA ELSE "Stale")
  /\ cacheB' = (IF relation = "Before" THEN cacheB ELSE "Stale")
  /\ UNCHANGED <<receipt, transaction, owner, worker, admissionWorker,
       revoked, revokePending, sent, broker, visible, response, terminal,
       secondStarted, secondSent, badSecondStart, badSend, badCache>>

NotFound == \E relation \in Relations:
  /\ transaction = "None" /\ phase \in Recoverable /\ ~visible /\ ~terminal
  /\ phase' = "RECOVERY_NOT_FOUND"
  /\ eventRelation' = relation
  /\ cacheA' = (IF relation = "Before" THEN cacheA ELSE "Stale")
  /\ cacheB' = (IF relation = "Before" THEN cacheB ELSE "Stale")
  /\ UNCHANGED <<receipt, transaction, owner, worker, admissionWorker,
       revoked, revokePending, sent, broker, visible, response, terminal,
       secondStarted, secondSent, badSecondStart, badSend, badCache>>

Found == \E relation \in Relations:
  /\ transaction = "None" /\ phase \in Recoverable /\ visible /\ ~terminal
  /\ phase' = "RECOVERY_FOUND" /\ terminal' = (broker = "Filled")
  /\ eventRelation' = relation
  /\ cacheA' = (IF relation = "Before" THEN cacheA ELSE "Stale")
  /\ cacheB' = (IF relation = "Before" THEN cacheB ELSE "Stale")
  /\ UNCHANGED <<receipt, transaction, owner, worker, admissionWorker,
       revoked, revokePending, sent, broker, visible, response,
       secondStarted, secondSent, badSecondStart, badSend, badCache>>

\* This is the second intent's committed admission, not its eventual send time.
AdmitSecond == /\ transaction = "None" /\ phase # "NONE" /\ ~secondStarted
               /\ ~revoked /\ AllowsSecond
               /\ secondStarted' = TRUE /\ badSecondStart' = Unresolved
               /\ cacheA' = "Stale"
                   /\ UNCHANGED <<phase, receipt, transaction, owner, worker, admissionWorker,
                    revoked, revokePending, sent, broker, visible, response, terminal,
                    secondSent, badSend, cacheB, eventRelation, badCache>>
BeginSecondFinal == /\ transaction = "None" /\ secondStarted /\ secondSent = 0 /\ ~revoked
                    /\ cacheB = "Current"
                    /\ transaction' = "SecondFinal" /\ owner' = worker
                    /\ cacheB' = "Reserved"
              /\ UNCHANGED <<phase, receipt, worker, admissionWorker, revoked,
                         revokePending, sent, broker, visible, response, terminal,
                         secondStarted, secondSent, badSecondStart, badSend, cacheA, eventRelation, badCache>>
SendSecond == /\ transaction = "SecondFinal" /\ owner = worker /\ secondSent = 0
              /\ cacheB = "Reserved"
              /\ secondSent' = secondSent + 1 /\ badSend' = (badSend \/ revoked \/ ~secondStarted \/ cacheB # "Reserved")
              /\ UNCHANGED <<phase, receipt, transaction, owner, worker, admissionWorker,
                   revoked, revokePending, sent, broker, visible, response, terminal,
                   secondStarted, badSecondStart, cacheA, cacheB, eventRelation, badCache>>

\* Match the SQL cutoff: a late durable event before the broker cut does not invalidate it.
\* Exact, complete broker evidence at the cut remains an environment obligation.
RefreshCache == \E relation \in Relations:
                /\ transaction = "None" /\ ~Unresolved /\ ~secondStarted
                /\ badCache' = (badCache \/ Unresolved \/ secondStarted)
                /\ eventRelation' = relation
                /\ cacheA' = (IF phase = "NONE" \/ relation = "Before" THEN "Current" ELSE "Stale")
                /\ cacheB' = (IF phase = "NONE" \/ relation = "Before" THEN "Current" ELSE "Stale")
                /\ UNCHANGED <<phase, receipt, transaction, owner, worker, admissionWorker,
                     revoked, revokePending, sent, broker, visible, response, terminal,
                     secondStarted, secondSent, badSecondStart, badSend>>

RequestRevocation == /\ ~revokePending /\ revokePending' = TRUE
                     /\ UNCHANGED <<phase, receipt, transaction, owner, worker, admissionWorker,
                          revoked, sent, broker, visible, response, terminal,
                          secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>
CommitRevocation == /\ transaction = "None" /\ revokePending
                    /\ revoked' = TRUE /\ revokePending' = FALSE
                    /\ UNCHANGED <<phase, receipt, transaction, owner, worker, admissionWorker,
                         sent, broker, visible, response, terminal,
                         secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>
SwitchWorker == /\ worker' = 3 - worker
                /\ UNCHANGED <<phase, receipt, transaction, owner, admissionWorker,
                     revoked, revokePending, sent, broker, visible, response, terminal,
                     secondStarted, secondSent, badSecondStart, badSend, cacheA, cacheB, eventRelation, badCache>>
Crash == /\ receipt' = IF worker = admissionWorker /\ receipt \in {"Pending", "Granted"}
                       THEN "Lost" ELSE receipt
         /\ IF owner = worker
               THEN /\ transaction' = "None" /\ owner' = 0
               ELSE UNCHANGED <<transaction, owner>>
         /\ cacheA' = (IF owner = worker /\ transaction = "Final" THEN "Stale" ELSE cacheA)
          /\ cacheB' = (IF owner = worker /\ transaction = "SecondFinal" THEN "Stale" ELSE cacheB)
          /\ response' = (IF worker = admissionWorker /\ phase = "SUBMIT_STARTED" /\ sent > 0
                          THEN "Lost" ELSE response)
          /\ UNCHANGED <<phase, worker, admissionWorker, revoked, revokePending,
              sent, broker, visible, terminal,
              secondStarted, secondSent, badSecondStart, badSend, eventRelation, badCache>>

Next == BeginAdmission \/ CommitAdmission \/ DeliverAdmission \/ LoseAdmission \/ BeginFinal \/ Send \/ Finish
        \/ Accept \/ Fill \/ Reveal \/ Reply \/ LoseReply \/ RecordReply \/ RecordUncertainStart \/ NotFound \/ Found
        \/ AdmitSecond \/ BeginSecondFinal \/ SendSecond \/ RefreshCache \/ RequestRevocation \/ CommitRevocation \/ SwitchWorker \/ Crash
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"NONE", "SUBMIT_STARTED", "SUBMIT_ACCEPTED", "SUBMIT_UNKNOWN", "RECOVERY_NOT_FOUND", "RECOVERY_FOUND"}
          /\ receipt \in {"None", "Pending", "Granted", "Consumed", "Lost"}
          /\ transaction \in {"None", "Admission", "Final", "SecondFinal"}
          /\ owner \in 0..2 /\ worker \in 1..2 /\ admissionWorker \in 0..2
          /\ revoked \in BOOLEAN /\ revokePending \in BOOLEAN /\ sent \in 0..2
          /\ broker \in {"None", "Accepted", "Filled"} /\ visible \in BOOLEAN
          /\ response \in {"None", "Accepted", "Lost"} /\ terminal \in BOOLEAN
          /\ secondStarted \in BOOLEAN /\ secondSent \in 0..2
          /\ badSecondStart \in BOOLEAN /\ badSend \in BOOLEAN
          /\ cacheA \in {"Empty", "Current", "Reserved", "Stale"} /\ cacheB \in {"Empty", "Current", "Reserved", "Stale"}
          /\ eventRelation \in Relations /\ badCache \in BOOLEAN
NoUnknownCachePublication == ~badCache
NoUnknownAdmission == ~badSecondStart
NoDuplicateInvocation == sent <= 1 /\ secondSent <= 1
CommittedBeforeInvocation == (sent > 0 => phase # "NONE") /\ (secondSent > 0 => secondStarted)
AuthorizedInvocation == ~badSend
NotFoundPreservesUncertainty == phase = "RECOVERY_NOT_FOUND" => ~terminal
ConformanceView == [phase |-> phase, receipt |-> receipt, transaction |-> transaction,
  owner |-> owner, worker |-> worker, admissionWorker |-> admissionWorker,
  revoked |-> revoked, revokePending |-> revokePending, sent |-> sent,
  broker |-> broker, visible |-> visible, response |-> response, terminal |-> terminal,
  secondStarted |-> secondStarted, secondSent |-> secondSent,
  badSecondStart |-> badSecondStart, badSend |-> badSend,
  cacheA |-> cacheA, cacheB |-> cacheB, eventRelation |-> eventRelation, badCache |-> badCache,
  cacheMayRecord |-> (~Unresolved /\ ~secondStarted),
  unresolved |-> Unresolved, allowsSecond |-> AllowsSecond,
  newStart |-> phase = "NONE", recoveryNotFound |-> phase \in Recoverable]
=============================================================================
