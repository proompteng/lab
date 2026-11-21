--------------------------- MODULE ActivityCursor ---------------------------
EXTENDS Naturals

VARIABLES cursor, caughtUp, replayFrom, replayUntil, complete, session, fresh, mode,
          eventCursor, retained, hashMatches, supported, eventSession,
          boundaryCursor, boundaryReplayFrom, boundaryReplayUntil, boundaryEvidenceMatches,
          heartbeatCursor, heartbeatSession,
          revisionMatches, regressed, badReplayAccepted, boundaryConflictAccepted,
          unprovedCatchupAccepted, catchupEstablishedLiveness, prematureHeartbeat,
          recoveredCompleteness, staleSessionLive, latePublicationStayedCovered,
          projectionReadAccepted, unsafeProjectionRead

vars == <<cursor, caughtUp, replayFrom, replayUntil, complete, session, fresh, mode,
          eventCursor, retained, hashMatches, supported, eventSession,
          boundaryCursor, boundaryReplayFrom, boundaryReplayUntil, boundaryEvidenceMatches,
          heartbeatCursor, heartbeatSession,
          revisionMatches, regressed, badReplayAccepted, boundaryConflictAccepted,
          unprovedCatchupAccepted, catchupEstablishedLiveness, prematureHeartbeat,
          recoveredCompleteness, staleSessionLive, latePublicationStayedCovered,
          projectionReadAccepted, unsafeProjectionRead>>
durable == <<cursor, caughtUp, replayFrom, replayUntil, complete, session, fresh,
             regressed, badReplayAccepted, boundaryConflictAccepted,
             unprovedCatchupAccepted, catchupEstablishedLiveness, prematureHeartbeat,
             recoveredCompleteness, staleSessionLive, latePublicationStayedCovered,
             projectionReadAccepted, unsafeProjectionRead>>

EventDecision ==
  IF eventCursor <= cursor
  THEN IF retained /\ hashMatches THEN "REPLAY" ELSE "REJECT"
  ELSE "APPEND"
CatchupRangeIsValid ==
  /\ boundaryReplayFrom <= boundaryReplayUntil
  /\ cursor = 0 \/ (boundaryReplayFrom <= cursor /\ cursor <= boundaryReplayUntil)
CatchupProofIsValid == boundaryEvidenceMatches /\ CatchupRangeIsValid
CatchupBoundaryMatches ==
  ~caughtUp \/ (replayFrom = boundaryReplayFrom /\ replayUntil = boundaryReplayUntil)
CanCatchup == boundaryCursor = cursor /\ CatchupProofIsValid /\ CatchupBoundaryMatches
CanHeartbeat == caughtUp /\ heartbeatCursor = cursor
InvalidatesCoverage ==
  EventDecision = "APPEND" /\ caughtUp /\ replayFrom <= eventCursor /\ eventCursor <= replayUntil
PreserveSession == session = eventSession /\ ~InvalidatesCoverage
Ready == revisionMatches /\ caughtUp /\ complete /\ session # 0 /\ fresh

Init == /\ cursor = 0 /\ caughtUp = FALSE /\ replayFrom = 0 /\ replayUntil = 0 /\ complete = TRUE
        /\ session = 0 /\ fresh = FALSE /\ mode = "NONE"
        /\ eventCursor = 1 /\ retained = FALSE /\ hashMatches = FALSE
        /\ supported = FALSE /\ eventSession = 1
        /\ boundaryCursor = 0 /\ boundaryReplayFrom = 1 /\ boundaryReplayUntil = 1
        /\ boundaryEvidenceMatches = TRUE
        /\ heartbeatCursor = 0 /\ heartbeatSession = 1
        /\ revisionMatches = TRUE
        /\ regressed = FALSE /\ badReplayAccepted = FALSE
        /\ boundaryConflictAccepted = FALSE /\ prematureHeartbeat = FALSE
        /\ unprovedCatchupAccepted = FALSE /\ catchupEstablishedLiveness = FALSE
        /\ recoveredCompleteness = FALSE /\ staleSessionLive = FALSE
        /\ latePublicationStayedCovered = FALSE
        /\ projectionReadAccepted = FALSE /\ unsafeProjectionRead = FALSE

ChooseEvent ==
  /\ mode' = "EVENT"
  /\ eventCursor' \in 1..2 /\ retained' \in BOOLEAN /\ hashMatches' \in BOOLEAN
  /\ supported' \in BOOLEAN /\ eventSession' \in 1..2
  /\ boundaryCursor' = 0 /\ boundaryReplayFrom' = 1 /\ boundaryReplayUntil' = 1
  /\ boundaryEvidenceMatches' = TRUE
  /\ heartbeatCursor' = 0 /\ heartbeatSession' = 1
  /\ revisionMatches' \in BOOLEAN
  /\ UNCHANGED durable

ChooseCatchup ==
  /\ mode' = "CATCHUP"
  /\ eventCursor' = 1 /\ retained' = FALSE /\ hashMatches' = FALSE
  /\ supported' = FALSE /\ eventSession' = 1
  /\ boundaryCursor' \in 0..2 /\ boundaryReplayFrom' \in 1..2
  /\ boundaryReplayUntil' \in 1..2 /\ boundaryEvidenceMatches' \in BOOLEAN
  /\ heartbeatCursor' = 0 /\ heartbeatSession' = 1
  /\ revisionMatches' \in BOOLEAN
  /\ UNCHANGED durable

ChooseHeartbeat ==
  /\ mode' = "HEARTBEAT"
  /\ eventCursor' = 1 /\ retained' = FALSE /\ hashMatches' = FALSE
  /\ supported' = FALSE /\ eventSession' = 1
  /\ boundaryCursor' = 0 /\ boundaryReplayFrom' = 1 /\ boundaryReplayUntil' = 1
  /\ boundaryEvidenceMatches' = TRUE
  /\ heartbeatCursor' \in 0..2 /\ heartbeatSession' \in 1..2
  /\ revisionMatches' \in BOOLEAN
  /\ UNCHANGED durable

ApplyEvent ==
  /\ mode = "EVENT" /\ EventDecision # "REJECT"
  /\ cursor' = IF EventDecision = "APPEND" THEN eventCursor ELSE cursor
  /\ caughtUp' = IF InvalidatesCoverage THEN FALSE ELSE caughtUp
  /\ replayFrom' = IF InvalidatesCoverage THEN 0 ELSE replayFrom
  /\ replayUntil' = IF InvalidatesCoverage THEN 0 ELSE replayUntil
  /\ complete' = IF EventDecision = "APPEND" THEN complete /\ supported ELSE complete
  /\ session' = IF EventDecision = "APPEND" /\ ~PreserveSession THEN 0 ELSE session
  /\ fresh' = IF EventDecision = "APPEND" /\ ~PreserveSession THEN FALSE ELSE fresh
  /\ regressed' = (regressed \/ (cursor' < cursor))
  /\ badReplayAccepted' = (badReplayAccepted \/
       (EventDecision = "REPLAY" /\ ~(retained /\ hashMatches)))
  /\ recoveredCompleteness' = (recoveredCompleteness \/ (~complete /\ complete'))
  /\ staleSessionLive' = (staleSessionLive \/
       (EventDecision = "APPEND" /\ session # 0 /\ session # eventSession /\ session' # 0 /\ fresh'))
  /\ latePublicationStayedCovered' =
       (latePublicationStayedCovered \/ (InvalidatesCoverage /\ caughtUp'))
  /\ UNCHANGED <<eventCursor, retained, hashMatches, supported,
                  eventSession, boundaryCursor, boundaryReplayFrom, boundaryReplayUntil,
                  boundaryEvidenceMatches, heartbeatCursor,
                  heartbeatSession, revisionMatches, mode, boundaryConflictAccepted,
                  unprovedCatchupAccepted, catchupEstablishedLiveness, prematureHeartbeat,
                  projectionReadAccepted, unsafeProjectionRead>>

ApplyCatchup ==
  /\ mode = "CATCHUP" /\ CanCatchup
  /\ caughtUp' = TRUE
  /\ replayFrom' = IF caughtUp THEN replayFrom ELSE boundaryReplayFrom
  /\ replayUntil' = IF caughtUp THEN replayUntil ELSE boundaryReplayUntil
  /\ session' = 0 /\ fresh' = FALSE
  /\ boundaryConflictAccepted' = (boundaryConflictAccepted \/
       (caughtUp /\ (replayFrom # boundaryReplayFrom \/ replayUntil # boundaryReplayUntil)))
  /\ unprovedCatchupAccepted' = (unprovedCatchupAccepted \/
       ~boundaryEvidenceMatches \/ ~CatchupRangeIsValid)
  /\ catchupEstablishedLiveness' = (catchupEstablishedLiveness \/ session' # 0 \/ fresh')
  /\ UNCHANGED <<cursor, complete, eventCursor, retained, hashMatches,
                  supported, eventSession, boundaryCursor, boundaryReplayFrom, boundaryReplayUntil,
                  boundaryEvidenceMatches, mode,
                  heartbeatCursor, heartbeatSession, revisionMatches, regressed,
                  badReplayAccepted, prematureHeartbeat, recoveredCompleteness,
                  staleSessionLive, latePublicationStayedCovered,
                  projectionReadAccepted, unsafeProjectionRead>>

ApplyHeartbeat ==
  /\ mode = "HEARTBEAT" /\ CanHeartbeat
  /\ session' = heartbeatSession /\ fresh' = TRUE
  /\ prematureHeartbeat' = (prematureHeartbeat \/ ~caughtUp)
  /\ UNCHANGED <<cursor, caughtUp, replayFrom, replayUntil, complete, eventCursor, retained,
                  hashMatches, supported, eventSession, boundaryCursor,
                  boundaryReplayFrom, boundaryReplayUntil, boundaryEvidenceMatches,
                  heartbeatCursor, heartbeatSession, mode,
                  revisionMatches, regressed, badReplayAccepted,
                  boundaryConflictAccepted, unprovedCatchupAccepted,
                  catchupEstablishedLiveness, recoveredCompleteness, staleSessionLive,
                  latePublicationStayedCovered,
                  projectionReadAccepted, unsafeProjectionRead>>

AgeHeartbeat ==
  /\ fresh /\ fresh' = FALSE
  /\ UNCHANGED <<cursor, caughtUp, replayFrom, replayUntil, complete, session, eventCursor,
                  retained, hashMatches, supported, eventSession, boundaryCursor, mode,
                  boundaryReplayFrom, boundaryReplayUntil, boundaryEvidenceMatches,
                  heartbeatCursor, heartbeatSession,
                  revisionMatches, regressed, badReplayAccepted,
                  boundaryConflictAccepted, unprovedCatchupAccepted,
                  catchupEstablishedLiveness, prematureHeartbeat,
                  recoveredCompleteness, staleSessionLive,
                  latePublicationStayedCovered,
                  projectionReadAccepted, unsafeProjectionRead>>

ReadProjection ==
  /\ Ready
  /\ projectionReadAccepted' = TRUE
  /\ unsafeProjectionRead' = (unsafeProjectionRead \/ ~Ready)
  /\ UNCHANGED <<cursor, caughtUp, replayFrom, replayUntil, complete, session, fresh, mode,
                  eventCursor, retained, hashMatches, supported, eventSession,
                  boundaryCursor, boundaryReplayFrom, boundaryReplayUntil, boundaryEvidenceMatches,
                  heartbeatCursor, heartbeatSession,
                  revisionMatches, regressed, badReplayAccepted, boundaryConflictAccepted,
                  unprovedCatchupAccepted, catchupEstablishedLiveness, prematureHeartbeat,
                  recoveredCompleteness, staleSessionLive, latePublicationStayedCovered>>

Next == ChooseEvent \/ ChooseCatchup \/ ChooseHeartbeat \/ ApplyEvent \/ ApplyCatchup \/ ApplyHeartbeat \/ AgeHeartbeat \/ ReadProjection
Spec == Init /\ [][Next]_vars

TypeOK == /\ cursor \in 0..2 /\ caughtUp \in BOOLEAN /\ replayFrom \in 0..2
          /\ replayUntil \in 0..2
          /\ complete \in BOOLEAN /\ session \in 0..2 /\ fresh \in BOOLEAN
          /\ mode \in {"NONE", "EVENT", "CATCHUP", "HEARTBEAT"}
          /\ eventCursor \in 1..2 /\ retained \in BOOLEAN /\ hashMatches \in BOOLEAN
          /\ supported \in BOOLEAN /\ eventSession \in 1..2
          /\ boundaryCursor \in 0..2 /\ boundaryReplayFrom \in 1..2
          /\ boundaryReplayUntil \in 1..2 /\ boundaryEvidenceMatches \in BOOLEAN
          /\ heartbeatCursor \in 0..2 /\ heartbeatSession \in 1..2
          /\ revisionMatches \in BOOLEAN /\ regressed \in BOOLEAN
          /\ badReplayAccepted \in BOOLEAN /\ boundaryConflictAccepted \in BOOLEAN
          /\ unprovedCatchupAccepted \in BOOLEAN /\ catchupEstablishedLiveness \in BOOLEAN
          /\ prematureHeartbeat \in BOOLEAN /\ recoveredCompleteness \in BOOLEAN
          /\ staleSessionLive \in BOOLEAN /\ projectionReadAccepted \in BOOLEAN
          /\ latePublicationStayedCovered \in BOOLEAN
          /\ unsafeProjectionRead \in BOOLEAN
StateShape == caughtUp = (replayFrom # 0 /\ replayUntil # 0) /\ (fresh => caughtUp /\ session # 0)
CursorNeverRegresses == ~regressed
ReplayRequiresExactRetainedSource == ~badReplayAccepted
CatchupBoundaryIsImmutable == ~boundaryConflictAccepted
CatchupRequiresMatchingEvidence == ~unprovedCatchupAccepted
CatchupDoesNotEstablishLiveness == ~catchupEstablishedLiveness
HeartbeatRequiresCatchup == ~prematureHeartbeat
IncompleteProjectionStaysIncomplete == ~recoveredCompleteness
ChangedSessionIsNotLive == ~staleSessionLive
LatePublicationInvalidatesCoverage == ~latePublicationStayedCovered
ProjectionReadsRequireReady == ~unsafeProjectionRead

ConformanceView == [cursor |-> cursor, caughtUp |-> caughtUp, replayFrom |-> replayFrom,
  replayUntil |-> replayUntil,
  complete |-> complete, session |-> session, fresh |-> fresh, mode |-> mode,
  eventCursor |-> eventCursor, retained |-> retained, hashMatches |-> hashMatches,
  supported |-> supported, eventSession |-> eventSession,
  boundaryCursor |-> boundaryCursor, boundaryReplayFrom |-> boundaryReplayFrom,
  boundaryReplayUntil |-> boundaryReplayUntil, boundaryEvidenceMatches |-> boundaryEvidenceMatches,
  heartbeatCursor |-> heartbeatCursor, heartbeatSession |-> heartbeatSession,
  revisionMatches |-> revisionMatches, eventDecision |-> EventDecision,
  canCatchup |-> CanCatchup, canHeartbeat |-> CanHeartbeat,
  invalidatesCoverage |-> InvalidatesCoverage,
  preserveSession |-> PreserveSession, ready |-> Ready,
  regressed |-> regressed, badReplayAccepted |-> badReplayAccepted,
  boundaryConflictAccepted |-> boundaryConflictAccepted,
  unprovedCatchupAccepted |-> unprovedCatchupAccepted,
  catchupEstablishedLiveness |-> catchupEstablishedLiveness,
  prematureHeartbeat |-> prematureHeartbeat,
  recoveredCompleteness |-> recoveredCompleteness,
  staleSessionLive |-> staleSessionLive,
  latePublicationStayedCovered |-> latePublicationStayedCovered,
  projectionReadAccepted |-> projectionReadAccepted,
  unsafeProjectionRead |-> unsafeProjectionRead]
=============================================================================
