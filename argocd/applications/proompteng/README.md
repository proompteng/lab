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
