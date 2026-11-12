----------------------------- MODULE Controller -----------------------------
EXTENDS Naturals

VARIABLES active, epoch, source, sequence, deliveryEpoch, deliverySource,
          deliverySequence, inFlight, proposalEpoch, proposalSource,
          proposalSequence, staleCommit

vars == <<active, epoch, source, sequence, deliveryEpoch, deliverySource,
          deliverySequence, inFlight, proposalEpoch, proposalSource,
          proposalSequence, staleCommit>>

Init == /\ active = TRUE
        /\ epoch = 1 /\ source = 1 /\ sequence = 0
        /\ deliveryEpoch \in 1..2 /\ deliverySource \in 1..2
        /\ deliverySequence \in 0..2
        /\ inFlight = FALSE
        /\ proposalEpoch = 1 /\ proposalSource = 1 /\ proposalSequence = 0
        /\ staleCommit = FALSE

CanAdvance == active /\ deliveryEpoch = epoch /\ deliverySource = source
                     /\ deliverySequence = sequence
CanComplete == active /\ proposalEpoch = epoch /\ proposalSource = source
                      /\ proposalSequence = sequence

Deliver == /\ deliveryEpoch' \in 1..2 /\ deliverySource' \in 1..2
           /\ deliverySequence' \in 0..2
           /\ UNCHANGED <<active, epoch, source, sequence, inFlight,
                         proposalEpoch, proposalSource, proposalSequence, staleCommit>>
Begin == /\ CanAdvance /\ ~inFlight /\ sequence < 2
         /\ inFlight' = TRUE
         /\ proposalEpoch' = deliveryEpoch /\ proposalSource' = deliverySource
         /\ proposalSequence' = deliverySequence
         /\ UNCHANGED <<active, epoch, source, sequence, deliveryEpoch,
                       deliverySource, deliverySequence, staleCommit>>
Rotate == /\ epoch = 1 /\ epoch' = 2 /\ source' \in 1..2
          /\ sequence' = 0
          /\ UNCHANGED <<active, deliveryEpoch, deliverySource, deliverySequence,
                        inFlight, proposalEpoch, proposalSource, proposalSequence, staleCommit>>
Deactivate == /\ active /\ active' = FALSE
              /\ UNCHANGED <<epoch, source, sequence, deliveryEpoch, deliverySource,
                            deliverySequence, inFlight, proposalEpoch, proposalSource,
                            proposalSequence, staleCommit>>
Complete == /\ inFlight /\ CanComplete /\ sequence < 2
            /\ sequence' = sequence + 1 /\ inFlight' = FALSE
            /\ staleCommit' = ~CanComplete
            /\ UNCHANGED <<active, epoch, source, deliveryEpoch, deliverySource,
                          deliverySequence, proposalEpoch, proposalSource, proposalSequence>>
Crash == /\ inFlight /\ inFlight' = FALSE
         /\ UNCHANGED <<active, epoch, source, sequence, deliveryEpoch, deliverySource,
                       deliverySequence, proposalEpoch, proposalSource, proposalSequence, staleCommit>>

Next == Deliver \/ Begin \/ Rotate \/ Deactivate \/ Complete \/ Crash
Spec == Init /\ [][Next]_vars
TypeOK == /\ active \in BOOLEAN /\ epoch \in 1..2 /\ source \in 1..2
          /\ sequence \in 0..2 /\ deliveryEpoch \in 1..2 /\ deliverySource \in 1..2
          /\ deliverySequence \in 0..2 /\ inFlight \in BOOLEAN
          /\ proposalEpoch \in 1..2 /\ proposalSource \in 1..2 /\ proposalSequence \in 0..2
          /\ staleCommit \in BOOLEAN
NoStaleCommit == ~staleCommit
ConformanceView == [active |-> active, epoch |-> epoch, source |-> source,
  sequence |-> sequence, deliveryEpoch |-> deliveryEpoch, deliverySource |-> deliverySource,
  deliverySequence |-> deliverySequence, inFlight |-> inFlight, proposalEpoch |-> proposalEpoch,
  proposalSource |-> proposalSource, proposalSequence |-> proposalSequence,
  staleCommit |-> staleCommit, canAdvance |-> CanAdvance, canComplete |-> CanComplete]
=============================================================================
