# NATS

The three-server JetStream StatefulSet retains its Ceph claims and requires
`network.proompteng.ai/100g=true` on Turin or Altra. The Ryzen compute-local toleration must not be added.

Move one server through the existing disruption budget at a time. Before advancing, require three Ready servers,
an elected metadata leader, zero pending metadata operations, and every stream replica current through native
`/jsz?streams=true&raft=true` readback. Preserve authentication, stream definitions, message counts and claim identities.
