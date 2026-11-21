--------------------------- MODULE ActivityCursor ---------------------------
EXTENDS Naturals

VARIABLES cursor, caughtUp, coverage, complete, session, fresh, mode,
          eventCursor, retained, hashMatches, supported, eventSession,
          boundaryCursor, boundaryCoverage, heartbeatCursor, heartbeatSession,
          revisionMatches, regressed, badReplayAccepted, boundaryConflictAccepted,
          prematureHeartbeat, recoveredCompleteness, staleSessionLive

vars == <<cursor, caughtUp, coverage, complete, session, fresh, mode,
          eventCursor, retained, hashMatches, supported, eventSession,
          boundaryCursor, boundaryCoverage, heartbeatCursor, heartbeatSession,
          revisionMatches, regressed, badReplayAccepted, boundaryConflictAccepted,
          prematureHeartbeat, recoveredCompleteness, staleSessionLive>>
durable == <<cursor, caughtUp, coverage, complete, session, fresh,
             regressed, badReplayAccepted, boundaryConflictAccepted,
             prematureHeartbeat, recoveredCompleteness, staleSessionLive>>

EventDecision ==
  IF eventCursor <= cursor
  THEN IF retained /\ hashMatches THEN "REPLAY" ELSE "REJECT"
  ELSE "APPEND"
CanCatchup == boundaryCursor = cursor /\ (~caughtUp \/ coverage = boundaryCoverage)
CanHeartbeat == caughtUp /\ heartbeatCursor = cursor
PreserveSession == session = eventSession
Ready == revisionMatches /\ caughtUp /\ complete /\ session # 0 /\ fresh

Init == /\ cursor = 0 /\ caughtUp = FALSE /\ coverage = 0 /\ complete = TRUE
        /\ session = 0 /\ fresh = FALSE /\ mode = "NONE"
        /\ eventCursor = 1 /\ retained = FALSE /\ hashMatches = FALSE
        /\ supported = FALSE /\ eventSession = 1
        /\ boundaryCursor = 0 /\ boundaryCoverage = 1
        /\ heartbeatCursor = 0 /\ heartbeatSession = 1
        /\ revisionMatches = TRUE
        /\ regressed = FALSE /\ badReplayAccepted = FALSE
        /\ boundaryConflictAccepted = FALSE /\ prematureHeartbeat = FALSE
        /\ recoveredCompleteness = FALSE /\ staleSessionLive = FALSE

ChooseEvent ==
  /\ mode' = "EVENT"
  /\ eventCursor' \in 1..2 /\ retained' \in BOOLEAN /\ hashMatches' \in BOOLEAN
  /\ supported' \in BOOLEAN /\ eventSession' \in 1..2
  /\ boundaryCursor' = 0 /\ boundaryCoverage' = 1
  /\ heartbeatCursor' = 0 /\ heartbeatSession' = 1
  /\ revisionMatches' \in BOOLEAN
  /\ UNCHANGED durable

ChooseCatchup ==
  /\ mode' = "CATCHUP"
  /\ eventCursor' = 1 /\ retained' = FALSE /\ hashMatches' = FALSE
  /\ supported' = FALSE /\ eventSession' = 1
  /\ boundaryCursor' \in 0..2 /\ boundaryCoverage' \in 1..2
  /\ heartbeatCursor' = 0 /\ heartbeatSession' = 1
  /\ revisionMatches' \in BOOLEAN
  /\ UNCHANGED durable

ChooseHeartbeat ==
  /\ mode' = "HEARTBEAT"
  /\ eventCursor' = 1 /\ retained' = FALSE /\ hashMatches' = FALSE
  /\ supported' = FALSE /\ eventSession' = 1
  /\ boundaryCursor' = 0 /\ boundaryCoverage' = 1
  /\ heartbeatCursor' \in 0..2 /\ heartbeatSession' \in 1..2
  /\ revisionMatches' \in BOOLEAN
  /\ UNCHANGED durable

ApplyEvent ==
  /\ mode = "EVENT" /\ EventDecision # "REJECT"
  /\ cursor' = IF EventDecision = "APPEND" THEN eventCursor ELSE cursor
  /\ complete' = IF EventDecision = "APPEND" THEN complete /\ supported ELSE complete
  /\ session' = IF EventDecision = "APPEND" /\ ~PreserveSession THEN 0 ELSE session
  /\ fresh' = IF EventDecision = "APPEND" /\ ~PreserveSession THEN FALSE ELSE fresh
  /\ regressed' = (regressed \/ (cursor' < cursor))
  /\ badReplayAccepted' = (badReplayAccepted \/
       (EventDecision = "REPLAY" /\ ~(retained /\ hashMatches)))
  /\ recoveredCompleteness' = (recoveredCompleteness \/ (~complete /\ complete'))
  /\ staleSessionLive' = (staleSessionLive \/
       (EventDecision = "APPEND" /\ session # 0 /\ session # eventSession /\ session' # 0 /\ fresh'))
  /\ UNCHANGED <<caughtUp, coverage, eventCursor, retained, hashMatches, supported,
                  eventSession, boundaryCursor, boundaryCoverage, heartbeatCursor,
                  heartbeatSession, revisionMatches, mode, boundaryConflictAccepted,
                  prematureHeartbeat>>

ApplyCatchup ==
  /\ mode = "CATCHUP" /\ CanCatchup
  /\ caughtUp' = TRUE
  /\ coverage' = IF caughtUp THEN coverage ELSE boundaryCoverage
  /\ boundaryConflictAccepted' = (boundaryConflictAccepted \/
       (caughtUp /\ coverage # boundaryCoverage))
  /\ UNCHANGED <<cursor, complete, session, fresh, eventCursor, retained, hashMatches,
                  supported, eventSession, boundaryCursor, boundaryCoverage, mode,
                  heartbeatCursor, heartbeatSession, revisionMatches, regressed,
                  badReplayAccepted, prematureHeartbeat, recoveredCompleteness,
                  staleSessionLive>>

ApplyHeartbeat ==
  /\ mode = "HEARTBEAT" /\ CanHeartbeat
  /\ session' = heartbeatSession /\ fresh' = TRUE
  /\ prematureHeartbeat' = (prematureHeartbeat \/ ~caughtUp)
  /\ UNCHANGED <<cursor, caughtUp, coverage, complete, eventCursor, retained,
                  hashMatches, supported, eventSession, boundaryCursor,
                  boundaryCoverage, heartbeatCursor, heartbeatSession, mode,
                  revisionMatches, regressed, badReplayAccepted,
                  boundaryConflictAccepted, recoveredCompleteness, staleSessionLive>>

AgeHeartbeat ==
  /\ fresh /\ fresh' = FALSE
  /\ UNCHANGED <<cursor, caughtUp, coverage, complete, session, eventCursor,
                  retained, hashMatches, supported, eventSession, boundaryCursor, mode,
                  boundaryCoverage, heartbeatCursor, heartbeatSession,
                  revisionMatches, regressed, badReplayAccepted,
                  boundaryConflictAccepted, prematureHeartbeat,
                  recoveredCompleteness, staleSessionLive>>

Next == ChooseEvent \/ ChooseCatchup \/ ChooseHeartbeat \/ ApplyEvent \/ ApplyCatchup \/ ApplyHeartbeat \/ AgeHeartbeat
Spec == Init /\ [][Next]_vars

TypeOK == /\ cursor \in 0..2 /\ caughtUp \in BOOLEAN /\ coverage \in 0..2
          /\ complete \in BOOLEAN /\ session \in 0..2 /\ fresh \in BOOLEAN
          /\ mode \in {"NONE", "EVENT", "CATCHUP", "HEARTBEAT"}
          /\ eventCursor \in 1..2 /\ retained \in BOOLEAN /\ hashMatches \in BOOLEAN
          /\ supported \in BOOLEAN /\ eventSession \in 1..2
          /\ boundaryCursor \in 0..2 /\ boundaryCoverage \in 1..2
          /\ heartbeatCursor \in 0..2 /\ heartbeatSession \in 1..2
          /\ revisionMatches \in BOOLEAN /\ regressed \in BOOLEAN
          /\ badReplayAccepted \in BOOLEAN /\ boundaryConflictAccepted \in BOOLEAN
          /\ prematureHeartbeat \in BOOLEAN /\ recoveredCompleteness \in BOOLEAN
          /\ staleSessionLive \in BOOLEAN
StateShape == caughtUp = (coverage # 0) /\ (fresh => session # 0)
CursorNeverRegresses == ~regressed
ReplayRequiresExactRetainedSource == ~badReplayAccepted
CatchupBoundaryIsImmutable == ~boundaryConflictAccepted
HeartbeatRequiresCatchup == ~prematureHeartbeat
IncompleteProjectionStaysIncomplete == ~recoveredCompleteness
ChangedSessionIsNotLive == ~staleSessionLive
ReadyIsSound == Ready =>
  (revisionMatches /\ caughtUp /\ complete /\ session # 0 /\ fresh)

ConformanceView == [cursor |-> cursor, caughtUp |-> caughtUp, coverage |-> coverage,
  complete |-> complete, session |-> session, fresh |-> fresh, mode |-> mode,
  eventCursor |-> eventCursor, retained |-> retained, hashMatches |-> hashMatches,
  supported |-> supported, eventSession |-> eventSession,
  boundaryCursor |-> boundaryCursor, boundaryCoverage |-> boundaryCoverage,
  heartbeatCursor |-> heartbeatCursor, heartbeatSession |-> heartbeatSession,
  revisionMatches |-> revisionMatches, eventDecision |-> EventDecision,
  canCatchup |-> CanCatchup, canHeartbeat |-> CanHeartbeat,
  preserveSession |-> PreserveSession, ready |-> Ready,
  regressed |-> regressed, badReplayAccepted |-> badReplayAccepted,
  boundaryConflictAccepted |-> boundaryConflictAccepted,
  prematureHeartbeat |-> prematureHeartbeat,
  recoveredCompleteness |-> recoveredCompleteness,
  staleSessionLive |-> staleSessionLive]
=============================================================================
