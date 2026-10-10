# Ofz implementation status

The goal is the complete migration and deployed acceptance described in
[the authorization plan](ofz-enterprise-authorization-plan.md). Work proceeds on one branch, without subagents.
Production keeps its current authority until the coordinated hard cutover. New code has no legacy authorization fallback.

- [x] Read repository instructions and Poteto principles; refresh source and runtime baseline.
- [x] Verify the requested administrator: `gregkonush`, GitHub numeric ID `12027037`.
- [x] Identify the requested independent recovery host: `nuc.ide-newton.ts.net`.
- [x] P1: final schema, typed API, action inventory, real SpiceDB role/expiry/revocation tests.
- [ ] P2: Ofz service, durable commands, quotas, audit and database migrations.
- [ ] P3: Keycloak identity, shared sessions and Access UI.
- [ ] P4: shared tickets, leadership and failover.
- [ ] P5: enforce every runtime channel and add pure observers.
- [ ] P6: proof-bound diagnostic grants, Kubernetes and connector brokers.
- [ ] P7: offboarding, independent archive/backups and isolated restore.
- [ ] P8: migration rehearsals, reviewed release, hard cutover and full product acceptance.

Two custodians are required by the release plan; only one has been named. NUC has approximately 63 GiB free at the
initial readback, below the 192 GiB uncompressed home-storage ceiling. Database recovery and home recovery must each
be qualified against actual retained data and available space. Neither open input blocks local contract implementation.

Evidence and decisions are recorded in [the implementation trail](ofz-implementation-decisions.tsv).

P1 local evidence: 486 permission assertions against pinned SpiceDB and PostgreSQL; five Rust contract tests; three
inventory tests including deliberately unclassified RPC and HTTP changes; Buf lint; Clippy; Rust/Python/shell checks.
The catalog covers 146 current operations across eleven surfaces. This is contract proof, with runtime enforcement
and production qualification still pending. Native dispatch caching failed the expiration probe and remains disabled
in the qualification fixture; the release must preserve that setting.
