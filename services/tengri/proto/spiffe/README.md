# SPIFFE Workload API

`workloadapi.proto` is the SPIFFE standard schema, copied without wire changes from
[`spiffe/spiffe` at `f97c46dfd0ff0d4e412cce5c73846a9ca32a99a2`](https://github.com/spiffe/spiffe/blob/f97c46dfd0ff0d4e412cce5c73846a9ca32a99a2/standards/workloadapi.proto).
The API intentionally has no protobuf package. Changing its service path would break SPIRE interoperability.
Buf exempts only the standard schema's fixed package and service names from the repository's naming rules.

Proompteng loads this schema for the local Unix Workload API. Rust and Go use their SPIFFE SDKs, which provide the
same standard contract. This schema is independent of Tengri's application protobuf services.
