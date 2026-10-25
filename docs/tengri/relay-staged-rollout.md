# Relay staged rollout

Stage 1 extracts the compatible authorization, controller and guest support from
[PR #15205](https://github.com/proompteng/lab/pull/15205). It ships dormant support;
it does not activate account connections.

## Stage 1 boundary

- Ofz understands connection ownership commands, separate read and mutation
  permissions, exact operation scopes and proof-bound connector requests.
- The controller understands the additive `ConnectorAgent` RPC. Nanoagent carries
  the private identity/configuration handlers and the credential-free provider
  client. The guest stores only a scoped platform grant and its proof key.
- All new backend entry points require the exact server-side setting
  `TENGRI_CONNECTORS_ENABLED=true`. Missing, false and malformed settings deny
  connector requests before authorization changes, replay writes, guest identity
  files or Codex configuration. This stage sets that flag nowhere in production.
- The BFF has no connector HTTP routes, Connections page or Settings section.
  Workspace listing, resume and conversations gain no Relay calls or dependency.
- Existing observation scopes decode without connector fields and retain their
  original JSON representation when those fields are empty. Existing diagnostic
  connector-read grants keep their prior contract. The new proof-bound gateway
  rejects those unscoped legacy grants; new gateway grants require exact operations.

The protobuf additions keep existing field numbers and RPC contracts. The Ofz
policy changes are additive source definitions. Stage 1 does not install a
SpiceDB schema, rerun bootstrap, provision Relay resources, register providers,
create grants, replace running guests or authorize a production rollout.
Normal image publication and promotion continue through the coordinated
[release contract](../release-automation.md).

## Qualification

Run the existing Ofz policy, bootstrap, control, identity and runtime checks with
connectors disabled. The dormant control fixture verifies that denied connection
creation and agent requests leave policy version, commands, grants, replay and
audit state unchanged. The controller test stops before authentication or
workspace access; the guest test stops before filesystem or app-server effects.

The isolated opt-in control fixture exercises ownership, duplicate creation,
read-versus-write grants, exact operation scope, proof replay, runtime epoch
replacement and revocation:

```sh
TENGRI_CONNECTORS_ENABLED=true bash services/ofz/test-control.sh control
node --test services/nanoagent/relay-client.test.mjs
```

The opt-in setting above belongs only to the disposable fixture. Native guest,
controller, BFF and authorization checks remain required for the coordinated
source change; a unit test or healthy image is not production acceptance.

## Later stages

Stage 2 supplies the private Relay database and runtime role, encryption keyring,
reviewed versioned provider catalog, SPIFFE registration, network policies and
Kargo/Argo enrollment. Resolve queued provider revocation across catalog changes
before activating any account. Install the additive native schema through a
reviewed migration that verifies the existing schema and preserves relationships
and the bootstrap journal.

Stage 3 adds server-enforced account/workspace eligibility, matching UI visibility,
HTTP routes and a dispatch switch that leaves disconnect and cleanup available.
Activate one internal account, one workspace and read-only provider operations.
Prove actual provider login, invocation, expiry, refresh, disconnect and denial
after revocation, including sleeping guests and unavailable dependencies.

Broader cohorts and mutation operations follow separate acceptance. Enabling the
backend flag alone does not implement a canary or authorize any of those stages.
