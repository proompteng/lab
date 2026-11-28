------------------------ MODULE CancellationAdmission ------------------------
EXTENDS Naturals

VARIABLES phase, authority, identity, clock, starts, admittedEligible
vars == <<phase, authority, identity, clock, starts, admittedEligible>>

\* A captured lookup token is fixed. Authority and identity enumerate valid
\* snapshots and one representative for each rejected production field.
\* clock: 0 = before observation, 1 = fresh, 2 = expiry, 3 = after expiry.
Eligible == authority \in {0, 1} /\ identity = 0 /\ clock = 1
CanAdmit == phase = "Read" /\ Eligible
Init == /\ phase = "Read" /\ authority \in 0..8 /\ identity \in 0..7
        /\ clock \in 0..3 /\ starts = 0 /\ admittedEligible = FALSE

\* Changes may occur before admission. Authority/time may also change after
\* the independently committed start; that does not revoke an admitted I/O.
AuthorityChange == /\ authority' \in 0..8
                   /\ UNCHANGED <<phase, identity, clock, starts, admittedEligible>>
IdentityChange == /\ phase = "Read" /\ identity' \in 0..7
                  /\ UNCHANGED <<phase, authority, clock, starts, admittedEligible>>
ClockChange == /\ clock' \in 0..3
               /\ UNCHANGED <<phase, authority, identity, starts, admittedEligible>>
Admit == /\ CanAdmit
         /\ phase' = "Admitted" /\ starts' = 1 /\ admittedEligible' = Eligible
         /\ UNCHANGED <<authority, identity, clock>>
Reject == /\ phase = "Read" /\ ~Eligible /\ phase' = "Rejected"
          /\ UNCHANGED <<authority, identity, clock, starts, admittedEligible>>
Replay == /\ phase # "Read" /\ UNCHANGED vars

Next == AuthorityChange \/ IdentityChange \/ ClockChange \/ Admit \/ Reject \/ Replay
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"Read", "Admitted", "Rejected"}
          /\ authority \in 0..8 /\ identity \in 0..7 /\ clock \in 0..3
          /\ starts \in 0..2 /\ admittedEligible \in BOOLEAN
NoUnauthorizedStart == starts > 0 => admittedEligible
NoDuplicateStart == starts <= 1
NoRejectedStart == phase = "Rejected" => starts = 0
ConformanceView == [phase |-> phase, authority |-> authority, identity |-> identity,
  clock |-> clock, starts |-> starts, admittedEligible |-> admittedEligible,
  eligible |-> Eligible, canAdmit |-> CanAdmit]
=============================================================================
