# Knative deployment best practices

## Visibility

- Prefer the `networking.knative.dev/visibility` **label** on the Service metadata to scope a service to `cluster-local`; do **not** set it as a revision template annotation because the serving webhook rejects it and blocks SKS creation.

## Revision health & rollouts

- Keep only required annotations on `spec.template.metadata.annotations`; unknown keys can block revisions from becoming Ready.
- If you use `autoscaling.knative.dev/minScale`, ensure new revisions reach Ready (check `kubectl get ksvc -n <ns>`) to avoid multiple always-on deployments accumulating.
- Verify traffic targets after deploys (`kubectl get ksvc -n <ns> -o wide`) and clean stale revisions if they remain NotReady.

## Configuration hygiene

- Set rollout timestamps (`deploy.knative.dev/rollout`) and image digests via automation scripts; avoid manual edits that desynchronize Argo CD and Knative state.
- Keep readiness probes lightweight; failing probes stall promotion and leave old revisions serving traffic.

## Troubleshooting checklist

- Look at the PodAutoscaler (`kubectl describe kpa <rev> -n <ns>`) for admission or SKS errors.
- Check Route/Service events for validation errors, especially after manifest changes.
- Confirm only the Service-level label defines visibility; absence of SKS usually points to webhook validation failures.
