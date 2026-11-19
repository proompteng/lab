# Tengri desktop BFF

The active application runs two BFF replicas on separate hosts. It uses the central Ofz API, the dedicated Keycloak
Tengri realm. Ofz owns sign-in attempts and session storage. The prepared overlay and old Better Auth/GitHub Secret are
removed. Kargo owns the immutable image and complete reviewed configuration.

The namespace-scoped credentials contain only the shared BFF request key and reviewed
confidential OIDC client secret. The request key matches the controller's separate namespace-local Secret. The OIDC
secret matches Keycloak's Tengri client. The BFF holds no native SpiceDB credential or guest signing seed.

The BFF has no database connection, password, or database network permission. The pinned identity ingress IP retains
TLS verification of `auth.proompteng.ai` and the exact issuer `https://auth.proompteng.ai/realms/tengri`.

Keep the application release coordinated with the reviewed Ofz and controller configuration. Verify real GitHub broker
sign-in, passkey enrollment and fresh workspace creation through `https://proompteng.ai/`; HTTP readiness is insufficient.

The same Kargo image also runs two independent `platform-admin` replicas for `admin.proompteng.ai`. They use service
account `platform-admin`, a separately enrolled SPIFFE identity and the `platform-admin` OIDC client. The namespace-local
`platform-admin-oidc-client` Secret matches Keycloak's `keycloak-platform-admin` Secret. They contain one dedicated
client credential; existing broker and Tengri client credentials are unchanged. The portal mounts no controller HMAC,
Tengri endpoint, native key or database credential. Its network policy permits Ofz, identity/public HTTPS, DNS and existing
observability paths. SPIRE registration and the realm/client bootstrap must reconcile before live portal qualification.
