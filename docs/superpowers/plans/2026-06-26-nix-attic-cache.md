# Nix Attic Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a cluster-hosted Nix binary cache for this repo, then wire trusted CI and developer shells to pull from it and trusted main-branch jobs to push to it.

**Architecture:** Use Attic as the primary cache service because it is self-hostable, S3-backed, multi-tenant, deduplicating, and server-signs Nix cache responses. Run Attic in the lab cluster through GitOps, backed by CNPG Postgres and a Rook/Ceph S3 `ObjectBucketClaim`; expose it through the existing private ingress patterns and consume it from ARC runners first.

**Tech Stack:** Nix flakes, Attic, Kubernetes, Argo CD ApplicationSet, Rook/Ceph ObjectBucketClaim, CloudNativePG, External Secrets with 1Password, Traefik/Tailscale ingress, GitHub Actions ARC runners.

---

## Decision Summary

Use **Attic** for the first production rollout.

- Attic is a self-hostable Nix binary cache backed by S3-compatible storage.
- Attic supports cache namespaces, global deduplication, scoped JWT tokens, retention, and server-side signing.
- This repo already has the needed infrastructure primitives: Rook/Ceph buckets, CNPG, External Secrets, Traefik, Tailscale, and ARC runners.

Do not use these as the primary cache:

- **Harmonia:** good for serving one machine's `/nix/store`; not the best fit for shared CI push, cache namespaces, S3 object storage, and deduplication.
- **nix-serve-ng:** useful replacement for `nix-serve`; still local-store serving, not the desired cluster-backed shared cache.
- **Hydra:** too much scheduler/build farm surface for this rollout.
- **Cachix:** good product, but the requested cache must be hosted in this cluster.

## File Structure

- Create `argocd/applications/attic/kustomization.yaml`: owns the Attic application resources.
- Create `argocd/applications/attic/objectbucketclaim.yaml`: creates the `attic-cache` S3-compatible bucket through Rook/Ceph.
- Create `argocd/applications/attic/postgres-cluster.yaml`: creates the `attic-db` CNPG database.
- Create `argocd/applications/attic/externalsecret.yaml`: pulls the Attic JWT signing key and CI token from 1Password.
- Create `argocd/applications/attic/configmap.yaml`: stores non-secret Attic TOML config.
- Create `argocd/applications/attic/deployment.yaml`: runs `atticd --mode api-server`.
- Create `argocd/applications/attic/service.yaml`: exposes the Attic pod in-cluster.
- Create `argocd/applications/attic/ingressroute-attic-k8s-private.yaml`: exposes `attic.k8s.proompteng.ai`.
- Create `argocd/applications/attic/tailscale-ingress.yaml`: exposes `attic.ide-newton.ts.net`.
- Create `argocd/applications/attic/bootstrap-job.yaml`: idempotently creates the `lab` cache and scoped CI token.
- Create `argocd/applications/attic/gc-cronjob.yaml`: runs `atticd --mode garbage-collector-once`.
- Modify `argocd/applicationsets/platform.yaml`: adds the `attic` platform ApplicationSet element.
- Modify `flake.nix`: adds the Attic client to the dev shell and exposes cache helper apps.
- Create `nix/cache-doctor.sh`: validates substituter reachability, cache public key config, and local Nix settings.
- Create `nix/cache-push.sh`: pushes selected build outputs to Attic only when a token is present.
- Modify `.github/workflows/nix-toolchain.yml`: consumes the cache on ARC or Tailscale-enabled jobs and pushes only from trusted branches.
- Create `docs/nix-cache.md`: documents developer setup, trust boundary, token handling, and operations.

### Task 1: Add Attic To The Platform ApplicationSet

**Files:**
- Modify: `argocd/applicationsets/platform.yaml`
- Create: `argocd/applications/attic/kustomization.yaml`

- [ ] **Step 1: Add the `attic` platform element**

Insert the element after `arc` in `argocd/applicationsets/platform.yaml`:

```yaml
              - name: attic
                path: argocd/applications/attic
                namespace: attic
                annotations:
                  argocd.argoproj.io/sync-wave: "4"
                managedNamespaceMetadata:
                  labels:
                    external-secrets.proompteng.ai/enabled: "true"
                  annotations:
                    argocd.argoproj.io/sync-options: Prune=false
                automation: manual
                enabled: "true"
```

- [ ] **Step 2: Create the Attic kustomization**

Create `argocd/applications/attic/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: attic
resources:
  - objectbucketclaim.yaml
  - postgres-cluster.yaml
  - externalsecret.yaml
  - configmap.yaml
  - deployment.yaml
  - service.yaml
  - ingressroute-attic-k8s-private.yaml
  - tailscale-ingress.yaml
  - bootstrap-job.yaml
  - gc-cronjob.yaml
```

- [ ] **Step 3: Validate the new ApplicationSet render**

Run:

```bash
nix run .#lint-argocd
```

Expected: kubeconform accepts the new `attic` Application and resource manifests.

- [ ] **Step 4: Commit**

```bash
git add argocd/applicationsets/platform.yaml argocd/applications/attic/kustomization.yaml
git commit -m "feat(nix): register attic cache application"
```

### Task 2: Add Storage And Database Backing Services

**Files:**
- Create: `argocd/applications/attic/objectbucketclaim.yaml`
- Create: `argocd/applications/attic/postgres-cluster.yaml`

- [ ] **Step 1: Create the object bucket claim**

Create `argocd/applications/attic/objectbucketclaim.yaml`:

```yaml
apiVersion: objectbucket.io/v1alpha1
kind: ObjectBucketClaim
metadata:
  name: attic-cache
  namespace: attic
spec:
  bucketName: attic-cache
  storageClassName: rook-ceph-bucket
```

- [ ] **Step 2: Create the CNPG database**

Create `argocd/applications/attic/postgres-cluster.yaml`:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: attic-db
  namespace: attic
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie
  primaryUpdateStrategy: unsupervised
  storage:
    storageClass: rook-ceph-block
    size: 20Gi
  bootstrap:
    initdb:
      database: attic
      owner: attic
      encoding: "UTF8"
      dataChecksums: true
  inheritedMetadata:
    annotations:
      reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
      reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "pgadmin"
      reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
      reflector.v1.k8s.emberstack.com/reflection-auto-namespaces: "pgadmin"
  monitoring:
    enablePodMonitor: true
```

- [ ] **Step 3: Validate schemas**

Run:

```bash
nix run .#lint-argocd
```

Expected: `ObjectBucketClaim` and CNPG `Cluster` schemas validate with the existing kubeconform path.

- [ ] **Step 4: Commit**

```bash
git add argocd/applications/attic/objectbucketclaim.yaml argocd/applications/attic/postgres-cluster.yaml
git commit -m "feat(nix): add attic storage backends"
```

### Task 3: Add Secrets And Attic Configuration

**Files:**
- Create: `argocd/applications/attic/externalsecret.yaml`
- Create: `argocd/applications/attic/configmap.yaml`

- [ ] **Step 1: Create the 1Password item before merging**

Create 1Password item `infra/attic-cache` with these fields:

```text
token-rs256-secret-base64
ci-token
```

Generate `token-rs256-secret-base64` with:

```bash
nix run nixpkgs#openssl -- genrsa -traditional 4096 | base64 -w0
```

Set `ci-token` after Task 6 bootstrap creates the scoped token. Until then, set it to the literal value `pending-bootstrap-token` so External Secrets can create the target Secret for later CI wiring.

- [ ] **Step 2: Create the ExternalSecret**

Create `argocd/applications/attic/externalsecret.yaml`:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: attic-secrets
  namespace: attic
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: onepassword-infra
  target:
    name: attic-secrets
    creationPolicy: Owner
  data:
    - secretKey: ATTIC_SERVER_TOKEN_RS256_SECRET_BASE64
      remoteRef:
        key: attic-cache
        property: token-rs256-secret-base64
    - secretKey: ATTIC_CI_TOKEN
      remoteRef:
        key: attic-cache
        property: ci-token
```

- [ ] **Step 3: Create the Attic config**

Create `argocd/applications/attic/configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: attic-config
  namespace: attic
data:
  server.toml: |
    listen = "[::]:8080"
    allowed-hosts = [
      "attic.attic.svc.cluster.local",
      "attic.k8s.proompteng.ai",
      "attic.ide-newton.ts.net"
    ]
    api-endpoint = "https://attic.ide-newton.ts.net/"
    substituter-endpoint = "https://attic.ide-newton.ts.net/"
    soft-delete-caches = true
    require-proof-of-possession = true

    [database]
    heartbeat = true

    [storage]
    type = "s3"
    region = "us-east-1"
    bucket = "attic-cache"
    endpoint = "http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80"

    [chunking]
    nar-size-threshold = 65536
    min-size = 16384
    avg-size = 65536
    max-size = 262144

    [compression]
    type = "zstd"

    [garbage-collection]
    interval = "12 hours"
    default-retention-period = "6 months"

    [jwt]
```

- [ ] **Step 4: Validate manifests**

Run:

```bash
nix run .#lint-argocd
```

Expected: ExternalSecret and ConfigMap render cleanly.

- [ ] **Step 5: Commit**

```bash
git add argocd/applications/attic/externalsecret.yaml argocd/applications/attic/configmap.yaml
git commit -m "feat(nix): configure attic cache secrets"
```

### Task 4: Build A Repo-Owned Attic Container Image

**Files:**
- Modify: `flake.nix`
- Create: `.github/workflows/attic-build-push.yaml`

- [ ] **Step 1: Add an Attic image package to `flake.nix`**

Add a package near the existing package definitions:

```nix
atticdImage = pkgs.dockerTools.buildLayeredImage {
  name = "registry.ide-newton.ts.net/lab/attic";
  tag = "dev";
  contents = [
    pkgs.attic-server
    pkgs.cacert
    pkgs.busybox
  ];
  config = {
    Entrypoint = [ "${pkgs.attic-server}/bin/atticd" ];
    ExposedPorts = {
      "8080/tcp" = { };
    };
    Env = [
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
  };
};
```

Expose it under `packages.${system}.atticd-image`.

- [ ] **Step 2: Add a build-push workflow**

Create `.github/workflows/attic-build-push.yaml`:

```yaml
name: attic-build-push

permissions:
  contents: read

on:
  push:
    branches:
      - main
    paths:
      - flake.nix
      - flake.lock
      - nix/**
      - .github/workflows/attic-build-push.yaml
      - argocd/applications/attic/**
  workflow_dispatch:

jobs:
  build:
    runs-on: arc-arm64
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v5

      - name: Install xz for Nix installer
        run: sudo apt-get update && sudo apt-get install -y xz-utils

      - name: Install Nix
        uses: cachix/install-nix-action@v31
        with:
          github_access_token: ${{ secrets.GITHUB_TOKEN }}
          extra_nix_config: |
            experimental-features = nix-command flakes

      - name: Build Attic image
        run: nix build .#atticd-image --print-build-logs

      - name: Load and push image
        shell: bash
        run: |
          set -euo pipefail
          tag="$(git rev-parse --short=8 HEAD)"
          image="registry.ide-newton.ts.net/lab/attic:${tag}"
          gzip -dc result | docker load
          docker tag registry.ide-newton.ts.net/lab/attic:dev "${image}"
          docker push "${image}"
          docker tag "${image}" registry.ide-newton.ts.net/lab/attic:latest
          docker push registry.ide-newton.ts.net/lab/attic:latest
```

- [ ] **Step 3: Validate the package locally or in CI**

Run:

```bash
nix build .#atticd-image --print-build-logs
```

Expected: `result` is a Docker image tarball containing `atticd`.

- [ ] **Step 4: Commit**

```bash
git add flake.nix .github/workflows/attic-build-push.yaml
git commit -m "feat(nix): build attic cache image"
```

### Task 5: Deploy Attic API, Service, And Ingress

**Files:**
- Create: `argocd/applications/attic/deployment.yaml`
- Create: `argocd/applications/attic/service.yaml`
- Create: `argocd/applications/attic/ingressroute-attic-k8s-private.yaml`
- Create: `argocd/applications/attic/tailscale-ingress.yaml`

- [ ] **Step 1: Create the deployment**

Create `argocd/applications/attic/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: attic
  namespace: attic
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: attic
  template:
    metadata:
      labels:
        app.kubernetes.io/name: attic
    spec:
      containers:
        - name: attic
          image: registry.ide-newton.ts.net/lab/attic:latest
          imagePullPolicy: Always
          args:
            - -f
            - /etc/attic/server.toml
            - --mode
            - api-server
          env:
            - name: ATTIC_SERVER_TOKEN_RS256_SECRET_BASE64
              valueFrom:
                secretKeyRef:
                  name: attic-secrets
                  key: ATTIC_SERVER_TOKEN_RS256_SECRET_BASE64
            - name: ATTIC_SERVER_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: attic-db-app
                  key: uri
            - name: AWS_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: attic-cache
                  key: AWS_ACCESS_KEY_ID
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: attic-cache
                  key: AWS_SECRET_ACCESS_KEY
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 30
            periodSeconds: 30
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 2Gi
          volumeMounts:
            - name: attic-config
              mountPath: /etc/attic
              readOnly: true
      volumes:
        - name: attic-config
          configMap:
            name: attic-config
```

- [ ] **Step 2: Create the service**

Create `argocd/applications/attic/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: attic
  namespace: attic
spec:
  selector:
    app.kubernetes.io/name: attic
  ports:
    - name: http
      port: 80
      targetPort: http
```

- [ ] **Step 3: Create the private Traefik route**

Create `argocd/applications/attic/ingressroute-attic-k8s-private.yaml`:

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: attic-private
  namespace: attic
spec:
  entryPoints:
    - websecure
  routes:
    - kind: Rule
      match: Host(`attic.k8s.proompteng.ai`)
      services:
        - name: attic
          port: 80
  tls:
    secretName: wildcard-k8s-proompteng-ai-tls
```

- [ ] **Step 4: Create the Tailscale ingress**

Create `argocd/applications/attic/tailscale-ingress.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: attic-tailscale
  namespace: attic
  annotations:
    tailscale.com/tags: tag:k8s
spec:
  ingressClassName: tailscale
  tls:
    - hosts:
        - attic.ide-newton.ts.net
  rules:
    - host: attic.ide-newton.ts.net
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: attic
                port:
                  number: 80
```

- [ ] **Step 5: Validate manifests**

Run:

```bash
nix run .#lint-argocd
```

Expected: deployment, service, Traefik route, and Tailscale ingress validate.

- [ ] **Step 6: Commit**

```bash
git add argocd/applications/attic/deployment.yaml argocd/applications/attic/service.yaml argocd/applications/attic/ingressroute-attic-k8s-private.yaml argocd/applications/attic/tailscale-ingress.yaml
git commit -m "feat(nix): deploy attic cache service"
```

### Task 6: Add Bootstrap And Garbage Collection Jobs

**Files:**
- Create: `argocd/applications/attic/bootstrap-job.yaml`
- Create: `argocd/applications/attic/gc-cronjob.yaml`

- [ ] **Step 1: Create bootstrap job**

Create `argocd/applications/attic/bootstrap-job.yaml`:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: attic-bootstrap
  namespace: attic
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  backoffLimit: 6
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: bootstrap
          image: registry.ide-newton.ts.net/lab/attic:latest
          command:
            - /bin/sh
            - -ec
          args:
            - |
              until wget -q -O /dev/null http://attic.attic.svc.cluster.local/; do
                sleep 5
              done

              bootstrap_token="$(
                atticadm -f /etc/attic/server.toml make-token \
                  --sub bootstrap \
                  --validity '1 day' \
                  --pull lab \
                  --push lab \
                  --create-cache lab \
                  --configure-cache lab \
                  --configure-cache-retention lab
              )"

              attic login lab http://attic.attic.svc.cluster.local "${bootstrap_token}"
              attic cache create lab || true
              attic cache configure lab --public --retention-period '6 months'
              atticadm -f /etc/attic/server.toml make-token --sub github-actions --validity '12 months' --pull lab --push lab > /tmp/attic-ci-token
              echo "Copy the token from this job log into 1Password infra/attic-cache field ci-token, then delete this Job."
              cat /tmp/attic-ci-token
          env:
            - name: ATTIC_SERVER_TOKEN_RS256_SECRET_BASE64
              valueFrom:
                secretKeyRef:
                  name: attic-secrets
                  key: ATTIC_SERVER_TOKEN_RS256_SECRET_BASE64
            - name: ATTIC_SERVER_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: attic-db-app
                  key: uri
            - name: AWS_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: attic-cache
                  key: AWS_ACCESS_KEY_ID
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: attic-cache
                  key: AWS_SECRET_ACCESS_KEY
          volumeMounts:
            - name: attic-config
              mountPath: /etc/attic
              readOnly: true
      volumes:
        - name: attic-config
          configMap:
            name: attic-config
```

After first bootstrap, replace `ATTIC_CI_TOKEN` in 1Password with the generated scoped token and remove this Job from `kustomization.yaml` in the same PR or a follow-up commit.

- [ ] **Step 2: Create the garbage collection CronJob**

Create `argocd/applications/attic/gc-cronjob.yaml`:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: attic-gc
  namespace: attic
spec:
  schedule: "23 */6 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 3
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: attic-gc
              image: registry.ide-newton.ts.net/lab/attic:latest
              args:
                - -f
                - /etc/attic/server.toml
                - --mode
                - garbage-collector-once
              env:
                - name: ATTIC_SERVER_TOKEN_RS256_SECRET_BASE64
                  valueFrom:
                    secretKeyRef:
                      name: attic-secrets
                      key: ATTIC_SERVER_TOKEN_RS256_SECRET_BASE64
                - name: ATTIC_SERVER_DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: attic-db-app
                      key: uri
                - name: AWS_ACCESS_KEY_ID
                  valueFrom:
                    secretKeyRef:
                      name: attic-cache
                      key: AWS_ACCESS_KEY_ID
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: attic-cache
                      key: AWS_SECRET_ACCESS_KEY
              volumeMounts:
                - name: attic-config
                  mountPath: /etc/attic
                  readOnly: true
          volumes:
            - name: attic-config
              configMap:
                name: attic-config
```

- [ ] **Step 3: Validate manifests**

Run:

```bash
nix run .#lint-argocd
```

Expected: Job and CronJob validate.

- [ ] **Step 4: Commit**

```bash
git add argocd/applications/attic/bootstrap-job.yaml argocd/applications/attic/gc-cronjob.yaml
git commit -m "feat(nix): bootstrap attic cache lifecycle"
```

### Task 7: Add Client Tooling And Doctor Commands

**Files:**
- Modify: `flake.nix`
- Create: `nix/cache-doctor.sh`
- Create: `nix/cache-push.sh`
- Create: `docs/nix-cache.md`

- [ ] **Step 1: Add Attic client tooling to the dev shell**

Add `pkgs.attic-client` to the existing dev shell package list in `flake.nix`. If the current nixpkgs pin does not expose `pkgs.attic-client`, stop and update this task to import `github:zhaofengli/attic` as a flake input before changing any manifests.

- [ ] **Step 2: Add `nix/cache-doctor.sh`**

Create `nix/cache-doctor.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

cache_url="${NIX_CACHE_URL:-https://attic.ide-newton.ts.net/lab}"

echo "cache_url=${cache_url}"
curl -fsSL "${cache_url}/nix-cache-info" >/tmp/nix-cache-info
cat /tmp/nix-cache-info

if ! command -v nix >/dev/null 2>&1; then
  echo "nix is not installed"
  exit 1
fi

nix show-config | grep -E '^(substituters|trusted-public-keys) = ' || true
echo "nix cache doctor completed"
```

- [ ] **Step 3: Add `nix/cache-push.sh`**

Create `nix/cache-push.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${ATTIC_TOKEN:-}" ]]; then
  echo "ATTIC_TOKEN is not set; skipping cache push"
  exit 0
fi

cache_name="${ATTIC_CACHE_NAME:-lab}"
cache_endpoint="${ATTIC_CACHE_ENDPOINT:-https://attic.ide-newton.ts.net}"

attic login "${cache_name}" "${cache_endpoint}" "${ATTIC_TOKEN}"

paths=("$@")
if [[ "${#paths[@]}" -eq 0 ]]; then
  mapfile -t paths < <(nix path-info .#checks.x86_64-linux.toolchain 2>/dev/null || true)
fi

if [[ "${#paths[@]}" -eq 0 ]]; then
  echo "No store paths supplied or discovered; skipping cache push"
  exit 0
fi

attic push "${cache_name}" "${paths[@]}"
```

- [ ] **Step 4: Expose flake apps**

Expose these apps in `flake.nix`:

```nix
cache-doctor = {
  type = "app";
  program = "${pkgs.writeShellApplication {
    name = "cache-doctor";
    runtimeInputs = [ pkgs.curl pkgs.nix ];
    text = builtins.readFile ./nix/cache-doctor.sh;
  }}/bin/cache-doctor";
};

cache-push = {
  type = "app";
  program = "${pkgs.writeShellApplication {
    name = "cache-push";
    runtimeInputs = [ pkgs.attic-client pkgs.nix ];
    text = builtins.readFile ./nix/cache-push.sh;
  }}/bin/cache-push";
};
```

- [ ] **Step 5: Add docs**

Create `docs/nix-cache.md`:

```markdown
# Nix Cache

The lab Nix binary cache is hosted by Attic inside the cluster.

Default substituter:

```text
https://attic.ide-newton.ts.net/lab
```

Set `ATTIC_PUBLIC_KEY` to the exact public key printed by `attic cache info lab`, then use the cache:

```bash
export ATTIC_PUBLIC_KEY="$(attic cache info lab | awk -F': ' '/Public Key/ {print $2}')"
nix develop --option substituters "https://attic.ide-newton.ts.net/lab https://cache.nixos.org/" --option trusted-public-keys "${ATTIC_PUBLIC_KEY}"
```

Validate connectivity:

```bash
nix run .#cache-doctor
```

Push policy:

- Pulls are allowed for developers and pull requests.
- Pushes require `ATTIC_TOKEN`.
- GitHub Actions push only runs on trusted `main` branch workflows.
- Pull request workflows must never receive `ATTIC_TOKEN`.
```

- [ ] **Step 6: Validate shell scripts**

Run:

```bash
shellcheck nix/cache-doctor.sh nix/cache-push.sh
```

Expected: no shellcheck errors.

- [ ] **Step 7: Commit**

```bash
git add flake.nix nix/cache-doctor.sh nix/cache-push.sh docs/nix-cache.md
git commit -m "feat(nix): add attic cache client tooling"
```

### Task 8: Wire Trusted CI Cache Consumption And Push

**Files:**
- Modify: `.github/workflows/nix-toolchain.yml`
- Modify: `.github/workflows/oci-native-build-common.yml`

- [ ] **Step 1: Add pull-only cache settings to Nix installs**

For jobs running on ARC or after Tailscale is configured, update `cachix/install-nix-action@v31`:

```yaml
      - name: Install Nix
        uses: cachix/install-nix-action@v31
        with:
          github_access_token: ${{ secrets.GITHUB_TOKEN }}
          extra_nix_config: |
            experimental-features = nix-command flakes
            substituters = https://attic.ide-newton.ts.net/lab https://cache.nixos.org/
            trusted-public-keys = ${{ vars.ATTIC_PUBLIC_KEY }}
```

Set GitHub Actions variable `ATTIC_PUBLIC_KEY` to the public key printed by `attic cache info lab`. This value is public and should also be recorded in `docs/nix-cache.md`.

- [ ] **Step 2: Add trusted push after successful Nix checks**

Add this step only to `push` on `main` jobs after `nix flake check` passes:

```yaml
      - name: Push Nix closure to Attic
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        env:
          ATTIC_TOKEN: ${{ secrets.ATTIC_TOKEN }}
          ATTIC_CACHE_NAME: lab
          ATTIC_CACHE_ENDPOINT: https://attic.ide-newton.ts.net
        run: |
          set -euo pipefail
          nix build .#checks.x86_64-linux.toolchain --print-build-logs
          nix run .#cache-push -- "$(readlink -f result)"
```

- [ ] **Step 3: Keep PR workflows pull-only**

Search the workflows:

```bash
rg -n "ATTIC_TOKEN|cache-push|trusted-public-keys|substituters" .github/workflows
```

Expected: `ATTIC_TOKEN` appears only in `push` on `main` guarded steps.

- [ ] **Step 4: Validate CI YAML**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
import yaml
for path in Path('.github/workflows').glob('*.y*ml'):
    with path.open() as handle:
        yaml.safe_load(handle)
print('workflow yaml ok')
PY
```

Expected: `workflow yaml ok`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/nix-toolchain.yml .github/workflows/oci-native-build-common.yml
git commit -m "ci(nix): use attic cache on trusted jobs"
```

### Task 9: Rollout And Proof

**Files:**
- No new files. This task verifies live state and CI behavior.

- [ ] **Step 1: Merge the manifest branch and let Argo create `attic`**

After PR merge, watch Argo:

```bash
argocd app get attic
kubectl -n attic get deploy,po,svc,ingress,externalsecret,objectbucketclaim,cluster
```

Expected: `attic` is Synced/Healthy; deployment has one ready pod; OBC and CNPG resources are ready.

- [ ] **Step 2: Verify cache endpoint**

Run:

```bash
curl -fsSL https://attic.ide-newton.ts.net/lab/nix-cache-info
```

Expected: response includes Nix cache metadata for the `lab` cache.

- [ ] **Step 3: Verify CI pull performance**

Run the Nix toolchain workflow twice on the same commit:

```bash
gh workflow run nix-toolchain.yml --ref main
gh run list --workflow nix-toolchain.yml --limit 5
```

Expected: second run spends less time realizing the Nix toolchain closure than the first run and shows successful substituter hits in Nix logs.

- [ ] **Step 4: Verify trusted push policy**

Run:

```bash
PR_NUMBER="$(gh pr view --json number --jq .number)"
gh pr checks "${PR_NUMBER}" -R proompteng/lab
rg -n "ATTIC_TOKEN" .github/workflows
```

Expected: PR jobs pass without `ATTIC_TOKEN`; push jobs on `main` have the only cache push step.

- [ ] **Step 5: Record rollout memory**

Run:

```bash
bun run --filter memories save-memory --task-name "lab nix attic cache rollout" --summary "Cluster-hosted Attic cache deployed and wired to trusted Nix jobs" --content "Attic app, endpoint, CI runs, public key, and timing evidence" --tags lab,nix,attic,cache,ci
```

Expected: memory save succeeds. If it returns a service error, create an ad-hoc note under `/Users/gregkonush/.codex/memories/extensions/ad_hoc/notes/`.

## Regression Gates

- Pull requests must never receive an Attic push token.
- The cache service must stay private to cluster/Tailscale/private ingress unless a separate access review approves public exposure.
- `trusted-public-keys` must contain only public cache keys.
- Attic JWT signing key and CI push token must live in 1Password/ExternalSecret, not repo files.
- Nix cache rollout must not change Docker layer cache policy; OCI Buildx cache refs remain separate.
- Failing cache should degrade to `cache.nixos.org`, not block all development shell usage.

## Source Notes

- Attic: self-hostable Nix binary cache with S3-compatible storage, deduplication, scoped tokens, managed signing, and production PostgreSQL/S3 guidance.
- Harmonia: binary cache that serves the local `/nix/store` over HTTP; useful but not the best cluster object-store-backed push cache.
- nix-serve-ng: faster drop-in replacement for `nix-serve`; useful local-store serving, not the primary shared cache design.
