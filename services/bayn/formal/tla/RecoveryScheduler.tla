-------------------------- MODULE RecoveryScheduler --------------------------
EXTENDS Naturals

CONSTANT MaximumRecoveryWindow
VARIABLES active, scheduled, due, dependencyReady, recovered, recoveryWindow, deliveryParity

vars == <<active, scheduled, due, dependencyReady, recovered, recoveryWindow, deliveryParity>>
NextRecoveryWindow == IF recoveryWindow < MaximumRecoveryWindow
                      THEN recoveryWindow + 1 ELSE MaximumRecoveryWindow
CanDeliver == active /\ scheduled /\ due /\ ~recovered

Init == /\ active = TRUE /\ scheduled = TRUE /\ due = TRUE
        /\ dependencyReady = FALSE /\ recovered = FALSE
        /\ recoveryWindow = 0 /\ deliveryParity = 0

\* One delivery represents its already bounded attempts. Its failed successor
\* waits one recovery interval; no transition grants trading authority.
Deliver == /\ CanDeliver
           /\ recovered' = dependencyReady
           /\ scheduled' = IF dependencyReady THEN FALSE ELSE TRUE
           /\ due' = FALSE
           /\ recoveryWindow' = IF dependencyReady THEN recoveryWindow ELSE NextRecoveryWindow
           /\ deliveryParity' = 1 - deliveryParity
           /\ UNCHANGED <<active, dependencyReady>>
Tick == /\ active /\ scheduled /\ ~due
        /\ due' = TRUE
        /\ UNCHANGED <<active, scheduled, dependencyReady, recovered, recoveryWindow, deliveryParity>>
Repair == /\ ~dependencyReady /\ dependencyReady' = TRUE
          /\ UNCHANGED <<active, scheduled, due, recovered, recoveryWindow, deliveryParity>>
Deactivate == /\ active /\ active' = FALSE
              /\ scheduled' = FALSE /\ due' = FALSE
              /\ UNCHANGED <<dependencyReady, recovered, recoveryWindow, deliveryParity>>
Idle == /\ (~active \/ recovered) /\ UNCHANGED vars

Next == Deliver \/ Tick \/ Repair \/ Deactivate \/ Idle
Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ WF_vars(Deliver)
TypeOK == /\ active \in BOOLEAN /\ scheduled \in BOOLEAN /\ due \in BOOLEAN
          /\ dependencyReady \in BOOLEAN /\ recovered \in BOOLEAN
          /\ recoveryWindow \in 0..MaximumRecoveryWindow /\ deliveryParity \in 0..1
RecoveryScheduled == (active /\ ~recovered) => scheduled
NoFakeSuccess == recovered => dependencyReady
RecoveryProgress == /\ (active /\ ~recovered /\ deliveryParity = 0) ~> (~active \/ recovered \/ deliveryParity = 1)
                    /\ (active /\ ~recovered /\ deliveryParity = 1) ~> (~active \/ recovered \/ deliveryParity = 0)
EventualRecovery == (active /\ dependencyReady) ~> (~active \/ recovered)
ConformanceView == [active |-> active, scheduled |-> scheduled, due |-> due,
  dependencyReady |-> dependencyReady, recovered |-> recovered,
  recoveryWindow |-> recoveryWindow, deliveryParity |-> deliveryParity,
  nextRecoveryWindow |-> NextRecoveryWindow, maximumRecoveryWindow |-> MaximumRecoveryWindow,
  canDeliver |-> CanDeliver]
=============================================================================
