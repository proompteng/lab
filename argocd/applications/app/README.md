# App

Control-plane UI for proompteng.

## Notes

- Exposed at `https://app.proompteng.ai`.
- Production delivery is Kargo-managed: merge app source to `main`, let the passing build publish its eligible image,
  and let the `app` Warehouse/Stage promote the exact Freight to `kargo/app`. Kargo updates the source files consumed by
  the configured renderer; Argo tracks that branch and syncs it. Do not edit image tags or digests, create a release or
  deployment PR, use Image Updater, or run a manual Argo sync for an image release. See
  [`docs/release-automation.md`](../../../docs/release-automation.md) for the common contract and evidence commands.
