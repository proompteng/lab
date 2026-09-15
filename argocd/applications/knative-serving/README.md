# Knative Serving

## Configuration

### cert-manager Integration

Knative Serving is configured to use cert-manager for TLS certificate provisioning through the `letsencrypt-prod` ClusterIssuer. This enables automatic HTTPS for Knative services.

The integration uses the Let's Encrypt production issuer with HTTP01 challenges terminated by the Istio ingress gateway that Knative is pinned to.

**Important settings:**

- External Domain TLS: `Enabled` - Automatically provisions certificates for external domains via cert-manager
- HTTP-01 Challenges: `httpProtocol` stays `Enabled` so Let's Encrypt can complete callbacks before Knative enforces HTTPS
- Ingress: `Istio` - net-istio is explicitly enabled via `spec.ingress.istio.enabled`
- ClusterIssuer: `letsencrypt-prod` - Uses Let's Encrypt production with DNS01 challenges via Cloudflare
- Domain Template: `{{.Name}}.{{.Domain}}` - Routes render as single-level subdomains (e.g., `froussard.proompteng.ai`)

**Reference:** [Knative cert-manager integration](https://knative.dev/docs/serving/encryption/configure-certmanager-integration/)
