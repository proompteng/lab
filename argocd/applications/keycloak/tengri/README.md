# Dedicated Tengri identity realm

This prepared directory is excluded from the active Keycloak kustomization until the coordinated Ofz migration.
It creates a separate realm and preserves the master realm, Headlamp and Agents Shell clients.

`bootstrap.py` imports only a new, initially disabled realm. It locks managed profile attributes, verifies the GitHub
provider, exact client callbacks, protocol mappers, required actions and authentication flows before enabling it.
Repeat runs verify configuration and fail on drift. They never replace users, passkeys or broker links.

GitHub's numeric profile ID is copied by its built-in broker mapper into an administrator-only `github_id` attribute.
The username derives from that ID. Email does not link accounts or grant authority. The broker session's provider note
is included in the ID token. The account clients, direct grants, implicit flow and refresh tokens are disabled.
The BFF requires PKCE S256; the realm and client both require authentication level two. The post-broker flow requires
a new user-verified passkey authentication, with passkey enrollment required on first login.

Before activation, seal the existing GitHub OAuth client's ID/secret into `keycloak-tengri-broker`, register the exact
broker callback `https://auth.proompteng.ai/realms/tengri/broker/github/endpoint`, and seal the same newly generated
confidential BFF client secret into the Keycloak and BFF mounts. The issuer must have a valid HTTPS certificate.
The hard cutover removes the direct GitHub/Better Auth path; there is no fallback login mode.

The client includes Keycloak's `basic` scope for the signed authentication time and `acr` scope for achieved assurance.
Ofz independently requires both. The configuration was checked against Keycloak 26.7.3 source and tested through its
real administrator API, including repeat verification. The isolated Chromium fixture completed GitHub brokerage,
passkey enrollment, fresh verification, numeric identity separation, admission/assurance denial and Ofz session revocation.
Real custodian enrollment, HA and deployed identity readback remain separate migration gates.
Fixture providers may substitute an isolated GitHub HTTP service;
the production verifier rejects provider endpoint overrides.
