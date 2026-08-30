# khoshut secrets

`INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are reflected from `inngest/inngest` using kubernetes-reflector.

`Deployment/khoshut` reads keys from `Secret/inngest` in namespace `khoshut`:

- `INNGEST_EVENT_KEY`
- `INNGEST_SIGNING_KEY`
