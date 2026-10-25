# Forgejo release publisher

`forgejo-image-publish` runs only for commits merged to `main`. Its reviewed
input is `argocd/applications/forgejo/upstream-image.json`. The publisher keeps
the complete upstream index and attestations in the registry, then packages
amd64 and arm64 images with the source commit and upstream digest metadata.
It verifies that every filesystem layer and runtime configuration field is
unchanged before assembling the release index.

The workflow uploads its verification evidence before creating the immutable
`kargo-sha-<commit>` discovery tag. Registry errors and conflicting existing
tags fail the publication. Prepared images are excluded from Kargo discovery.
Do not run the publisher locally or create discovery tags manually.

Run the focused checks with:

```sh
python3 -m unittest discover -s scripts/forgejo -p '*_test.py'
shellcheck scripts/forgejo/publish-image.sh
ruff check scripts/forgejo
```

Publishing an image does not deploy Forgejo. The Warehouse and Stage must
select a matching source commit and immutable image, update the chart values
on the authorized Kargo branch, and complete the documented migration and
live acceptance in `docs/runbooks/forgejo-16-upgrade.md`.
