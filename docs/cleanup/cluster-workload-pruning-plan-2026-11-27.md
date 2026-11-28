# Galactic workload pruning plan — Wave 19X

**Decision:** Retire only the Restate Greeter demo in this PR. Everything else is an approval proposal or a hold.
No cluster or Restate state was changed for this audit.

## Evidence and ranking

Read-only Galactic snapshot, **2026-11-28, 04:08–04:22 UTC**, against lab
[`aa0a2d91f1f2`](https://github.com/proompteng/lab/tree/aa0a2d91f1f20dca27e59634655311676f26d102).
The 27th is the plan date, not the observation date. Git had **129** immediate application directories and **92**
enabled lab inventory entries (including two direct Applications, excluding Helm charts without a lab path).
The API had **99** Applications, all in `argocd`: those 92 plus `root`, `kargo`, the two Restate operator chart
Applications, `arc-controller`, and the two home children. An application directory is not a deployment.

| Node                  | Non-terminal pods | Assigned pod IPs | Node pod allocatable |
| --------------------- | ----------------: | ---------------: | -------------------: |
| `turin`               |               372 |              357 |                  500 |
| `talos-192-168-1-85`  |               172 |              157 |                  500 |
| `talos-192-168-1-194` |                66 |               51 |                  500 |
| **Total**             |           **610** |          **565** |            **1,500** |

The snapshot includes two Pending pods and 44 host-network pods. It excludes 85 Succeeded/Failed Pod objects:
their old status addresses do not establish a current IP lease. IPs are distinct `status.podIPs` on
non-terminal, non-host-network pods. This counts the primary pod network, not secondary Multus/VM networks;
it does not measure CNI leaks or available addresses. A missing IP or an unrequested CPU/RAM resource is not
proof that the workload has no cost.

**Rank** by IPs on Turin + node 85, then all node IPs, pods, requested CPU, requested RAM, bound GiB, and name.
T/85/194 gives the per-node IP split. CPU is millicores; RAM is MiB. Requests are effective Pod spec requests
(including ordered init/sidecar requests, pod-level overrides and overhead), not observed use.
[Calculation reference](https://kubernetes.io/docs/concepts/resource-management/effective-pod-requests-limits/).
Usage is the independent `kubectl top pods` sample, rounded to m/MiB, with missing pod samples marked partial
(607 of 610 pods matched). PVC capacity is bound claim capacity, not used disk or reclaimable bytes. All **226**
claims in the snapshot were Bound. A retained or off-cluster volume is not capacity recovered by removal.
A core hold means platform, delivery, shared data plane, or protected production dependency; it is not a
retirement proposal even if its rank is high.

For example, [Tigresse](../../argocd/applications/tigresse/README.md) has only one pod, but owns the
live `bayn/ledger` TigerBeetleCluster. Do not remove it while that ledger depends on the operator.

### Ranked live Applications

|   # | Application                                | Pods | IPs T/85/194 | CPU/RAM requested | CPU/RAM used           | PVCs / GiB  | Decision  |
| --: | ------------------------------------------ | ---: | ------------ | ----------------- | ---------------------- | ----------- | --------- |
|   1 | `tailscale`                                |   54 | 54/0/0       | 53 / 53           | 659 / 4,446            | 0 / 0       | Core hold |
|   2 | `observability`                            |   51 | 30/18/2      | 7,420 / 32,867    | 481 / 6,644 (50/51)    | 15 / 222    | Core hold |
|   3 | `knative-serving`                          |   35 | 17/9/9       | 3,400 / 2,300     | 73 / 863               | 0 / 0       | Core hold |
|   4 | `arc-controller` (arc)                     |   31 | 11/13/7      | 96,000 / 196,608  | 5,248 / 43,966 (29/31) | 14 / 896    | Core hold |
|   5 | `torghut`                                  |   21 | 10/8/3       | 28,000 / 41,600   | 695 / 23,359           | 4 / 402     | T1        |
|   6 | `rook-ceph`                                |   37 | 10/7/7       | 22,810 / 87,394   | 1,677 / 50,237         | 0 / 0       | Core hold |
|   7 | `home-media` (media)                       |   18 | 16/1/0       | 7,975 / 16,704    | 399 / 6,888            | 18 / 46,617 | H1        |
|   8 | `bayn`                                     |   15 | 9/6/0        | 8,150 / 32,576    | 533 / 13,027           | 8 / 1,366   | Core hold |
|   9 | `argocd`                                   |   15 | 6/7/2        | 3,600 / 54,144    | 171 / 4,168            | 0 / 0       | Core hold |
|  10 | `kubevirt`                                 |   13 | 7/5/1        | 110 / 3,853       | 129 / 2,547            | 0 / 0       | Core hold |
|  11 | `tengri`                                   |   12 | 9/3/0        | 25,300 / 75,264   | 44 / 1,524             | 6 / 192     | K1        |
|  12 | `temporal`                                 |   12 | 10/2/0       | 3,000 / 6,144     | 1,180 / 30,708         | 25 / 447    | Core hold |
|  13 | `knative-eventing`                         |   12 | 12/0/0       | 1,825 / 1,570     | 46 / 1,451             | 0 / 0       | Core hold |
|  14 | `ofz`                                      |   12 | 4/6/2        | 1,650 / 3,200     | 161 / 928              | 3 / 90      | K2        |
|  15 | `nvidia-gpu-operator` (gpu-operator)       |   11 | 8/2/1        | 325 / 548         | 38 / 577               | 0 / 0       | Core hold |
|  16 | `agents`                                   |    9 | 6/3/0        | 1,150 / 2,496     | 226 / 1,049            | 3 / 80      | Core hold |
|  17 | `kafka`                                    |   10 | 4/4/2        | 12,200 / 24,960   | 281 / 34,199           | 6 / 690     | Core hold |
|  18 | `penpot`                                   |    8 | 7/1/0        | 300 / 1,152       | 54 / 2,137             | 3 / 60      | P1        |
|  19 | `buzz`                                     |    7 | 4/2/1        | 2,300 / 3,392     | 68 / 441               | 5 / 70      | K3        |
|  20 | `jangar`                                   |    6 | 5/1/0        | 6,450 / 14,976    | 78 / 1,967             | 6 / 659     | Core hold |
|  21 | `coder`                                    |    6 | 2/4/0        | 2,500 / 5,120     | 49 / 1,675             | 4 / 80      | P8        |
|  22 | `paperless`                                |    6 | 5/1/0        | 1,750 / 4,224     | 53 / 3,307             | 6 / 137     | P2        |
|  23 | `nats`                                     |    6 | 5/1/0        | 750 / 1,728       | 10 / 135               | 3 / 60      | Core hold |
|  24 | `spire-server`                             |    6 | 3/3/0        | 750 / 1,344       | 93 / 763               | 6 / 33      | Core hold |
|  25 | `auto-ontology`                            |    5 | 5/0/0        | 500 / 1,152       | 84 / 1,237             | 1 / 5       | P5        |
|  26 | `external-secrets`                         |    5 | 3/2/0        | 50 / 320          | 9 / 367                | 0 / 0       | Core hold |
|  27 | `spire-system`                             |    8 | 2/2/1        | 310 / 1,024       | 14 / 436               | 0 / 0       | Core hold |
|  28 | `keycloak`                                 |    5 | 2/2/1        | 2,050 / 5,320     | 168 / 1,708            | 3 / 60      | Core hold |
|  29 | `bilig`                                    |    5 | 2/2/1        | 750 / 1,152       | 31 / 1,021             | 2 / 50      | K4        |
|  30 | `home-stash` (stash)                       |    4 | 1/3/0        | 950 / 4,864       | 17 / 354               | 3 / 6,147   | H2        |
|  31 | `cdi`                                      |    4 | 0/4/0        | 400 / 600         | 27 / 634               | 0 / 0       | Core hold |
|  32 | `kargo`                                    |    4 | 4/0/0        | 0 / 40,960        | 85 / 1,853             | 0 / 0       | Core hold |
|  33 | `istio-system`                             |    5 | 2/1/2        | 900 / 2,476       | 9 / 501                | 0 / 0       | Core hold |
|  34 | `proompteng`                               |    4 | 1/2/1        | 1,000 / 1,280     | 52 / 1,083             | 0 / 0       | Core hold |
|  35 | `glitchtip`                                |    4 | 2/1/1        | 200 / 768         | 92 / 750               | 2 / 40      | P3        |
|  36 | `argo-workflows`                           |    3 | 3/0/0        | 100 / 128         | 7 / 170                | 0 / 0       | Core hold |
|  37 | `cert-manager`                             |    3 | 3/0/0        | 0 / 0             | 12 / 271               | 0 / 0       | Core hold |
|  38 | `restate`                                  |    3 | 1/1/1        | 1,500 / 6,144     | 267 / 3,304            | 3 / 48      | Core hold |
|  39 | `tengri-devices` (kube-system)             |    3 | 1/1/1        | 30 / 48           | 3 / 27                 | 0 / 0       | Core hold |
|  40 | `forgejo-runners`                          |    2 | 1/1/0        | 2,000 / 4,096     | 41 / 164               | 3 / 60      | P9        |
|  41 | `pelican`                                  |    2 | 2/0/0        | 1,105 / 6,990.38  | 317 / 6,073            | 2 / 53      | P4        |
|  42 | `opencode`                                 |    2 | 2/0/0        | 1,100 / 2,304     | 4 / 186                | 2 / 54      | K5        |
|  43 | `hermes`                                   |    2 | 1/1/0        | 775 / 2,624       | 25 / 720               | 2 / 150     | K6        |
|  44 | `attic`                                    |    2 | 2/0/0        | 500 / 1,024       | 76 / 862               | 1 / 20      | K7        |
|  45 | `bayn-valkey` (bayn)                       |    2 | 1/1/0        | 400 / 2,176       | 59 / 98                | 2 / 20      | Core hold |
|  46 | `metrics-server` (kube-system)             |    2 | 1/1/0        | 200 / 400         | 19 / 152               | 0 / 0       | Core hold |
|  47 | `app`                                      |    2 | 1/1/0        | 200 / 256         | 5 / 183                | 1 / 5       | K8        |
|  48 | `synthesis`                                |    2 | 1/1/0        | 200 / 256         | 16 / 186               | 1 / 5       | K9        |
|  49 | `relay`                                    |    2 | 1/1/0        | 200 / 256         | 2 / 6                  | 0 / 0       | K10       |
|  50 | `knative`                                  |    2 | 2/0/0        | 200 / 200         | 3 / 231                | 0 / 0       | Core hold |
|  51 | `valkey-operator` (valkey-system)          |    2 | 1/1/0        | 200 / 128         | 3 / 75                 | 0 / 0       | Core hold |
|  52 | `oirat`                                    |    2 | 1/1/0        | 150 / 256         | 4 / 118                | 0 / 0       | K11       |
|  53 | `froussard`                                |    2 | 1/1/0        | 125 / 128         | 56 / 195               | 0 / 0       | K12       |
|  54 | `forgejo`                                  |    2 | 2/0/0        | 100 / 128         | 28 / 655               | 13 / 370    | K13       |
|  55 | `cloudnative-pg`                           |    2 | 2/0/0        | 100 / 128         | 7 / 181                | 0 / 0       | Core hold |
|  56 | `headlamp`                                 |    2 | 0/2/0        | 25 / 32           | 19 / 62                | 0 / 0       | K14       |
|  57 | `argo-rollouts`                            |    2 | 1/1/0        | 0 / 0             | 34 / 144               | 0 / 0       | Core hold |
|  58 | `traefik`                                  |    2 | 1/1/0        | 0 / 0             | 35 / 242               | 0 / 0       | Core hold |
|  59 | `volume-snapshot-controller` (kube-system) |    2 | 1/1/0        | 0 / 0             | 5 / 69                 | 0 / 0       | Core hold |
|  60 | `sealed-secrets`                           |    2 | 1/0/1        | 50 / 64           | 2 / 72                 | 0 / 0       | Core hold |
|  61 | `multus` (kube-system)                     |    7 | 0/1/0        | 700 / 1,118       | 26 / 1,038             | 0 / 0       | Core hold |
|  62 | `metallb-system`                           |    4 | 1/0/0        | 0 / 0             | 35 / 360               | 0 / 0       | Core hold |
|  63 | `devbox` (codex-devbox)                    |    1 | 1/0/0        | 8,250 / 65,666    | 2 / 2,242              | 1 / 500     | K15       |
|  64 | `nemotron-rerank`                          |    1 | 0/1/0        | 8,000 / 24,576    | 1 / 1,063              | 1 / 32      | P10       |
|  65 | `flamingo`                                 |    1 | 1/0/0        | 4,000 / 40,960    | 6 / 5,347              | 1 / 256     | P11       |
|  66 | `symphony` (jangar)                        |    1 | 0/1/0        | 500 / 1,024       | 32 / 88                | 1 / 50      | K16       |
|  67 | `symphony-jangar` (jangar)                 |    1 | 0/1/0        | 500 / 1,024       | 35 / 86                | 1 / 20      | K17       |
|  68 | `cloudflare`                               |    1 | 1/0/0        | 500 / 512         | 2 / 27                 | 0 / 0       | Core hold |
|  69 | `redis-operator`                           |    1 | 1/0/0        | 500 / 500         | 2 / 20                 | 0 / 0       | Core hold |
|  70 | `registry`                                 |    1 | 1/0/0        | 455 / 592         | 6 / 755                | 1 / 2,048   | Core hold |
|  71 | `clickhouse-operator`                      |    1 | 0/1/0        | 350 / 768         | 2 / 28                 | 0 / 0       | Core hold |
|  72 | `torghut-webull-feed` (torghut)            |    1 | 1/0/0        | 250 / 512         | 9 / 296                | 0 / 0       | T2        |
|  73 | `bumba` (jangar)                           |    1 | 0/1/0        | 200 / 512         | 9 / 282                | 1 / 50      | K18       |
|  74 | `docs`                                     |    1 | 0/1/0        | 200 / 256         | 0 / 180                | 0 / 0       | K19       |
|  75 | `restate-example`                          |    1 | 1/0/0        | 100 / 256         | 1 / 30                 | 0 / 0       | This PR   |
|  76 | `istio-ingress`                            |    1 | 1/0/0        | 100 / 128         | 13 / 117               | 0 / 0       | Core hold |
|  77 | `tigresse` (tigresse-system)               |    1 | 0/1/0        | 50 / 128          | 4 / 89                 | 0 / 0       | Core hold |
|  78 | `restate-operator`                         |    1 | 1/0/0        | 50 / 100          | 1 / 7                  | 0 / 0       | Core hold |
|  79 | `analysis`                                 |    1 | 0/1/0        | 50 / 64           | 1 / 90                 | 0 / 0       | K20       |
|  80 | `spicedb-operator`                         |    1 | 0/1/0        | 20 / 64           | 2 / 81                 | 0 / 0       | Core hold |
|  81 | `cockroach-operator-system`                |    1 | 1/0/0        | 10 / 32           | 1 / 39                 | 0 / 0       | Core hold |
|  82 | `pgadmin`                                  |    1 | 1/0/0        | 0 / 0             | 1 / 265                | 1 / 10      | P6        |
|  83 | `feature-flags`                            |    1 | 1/0/0        | 0 / 0             | 1 / 44                 | 1 / 5       | P7        |
|  84 | `flink`                                    |    1 | 1/0/0        | 0 / 0             | 3 / 5,636              | 0 / 0       | Core hold |
|  85 | `kubernetes-reflector`                     |    1 | 1/0/0        | 0 / 0             | 1 / 164                | 0 / 0       | Core hold |
|  86 | `local-path` (local-path-storage)          |    1 | 0/1/0        | 0 / 0             | 2 / 76                 | 0 / 0       | Core hold |
|  87 | `nack`                                     |    1 | 1/0/0        | 0 / 0             | 1 / 44                 | 0 / 0       | Core hold |
|  88 | `ryzen-amdgpu` (kube-system)               |    2 | 0/0/2        | 0 / 0             | 1 / 32                 | 0 / 0       | Core hold |
|  89 | `saigak`                                   |    1 | 0/0/1        | 4,100 / 12,416    | 10 / 1,122             | 3 / 432     | P12       |
|  90 | `kube-router` (kube-system)                |    3 | 0/0/0        | 300 / 384         | 120 / 321              | 0 / 0       | Core hold |
|  91 | `agents-workspace` (agents)                |    0 | 0/0/0        | 0 / 0             | —                      | 1 / 256     | Core hold |
|  92 | `agents-ci`                                |    0 | 0/0/0        | 0 / 0             | —                      | 0 / 0       | Core hold |
|  93 | `arc`                                      |    0 | 0/0/0        | 0 / 0             | —                      | 0 / 0       | Core hold |
|  94 | `flannel-cni` (kube-system)                |    0 | 0/0/0        | 0 / 0             | —                      | 0 / 0       | Core hold |
|  95 | `home-root` (argocd)                       |    0 | 0/0/0        | 0 / 0             | —                      | 0 / 0       | Core hold |
|  96 | `kargo-delivery` (kargo)                   |    0 | 0/0/0        | 0 / 0             | —                      | 0 / 0       | Core hold |
|  97 | `kata`                                     |    0 | 0/0/0        | 0 / 0             | —                      | 0 / 0       | Core hold |
|  98 | `restate-operator-crds` (restate-operator) |    0 | 0/0/0        | 0 / 0             | —                      | 0 / 0       | Core hold |
|  99 | `root` (argocd)                            |    0 | 0/0/0        | 0 / 0             | —                      | 0 / 0       | Core hold |

### Costs outside those Applications

These rows are not included in the ranked Application totals. The namespace is not itself proof of ownership.
Tailscale-managed proxy pods remain in the Tailscale row rather than being charged a second time to individual
services. Ceph raw devices, VM guest RAM and external service quotas are not a separate line item.

| Scope                                              | Pods | IPs T/85/194 | CPU/RAM requested | CPU/RAM used    | PVCs / GiB | Decision                       |
| -------------------------------------------------- | ---: | ------------ | ----------------- | --------------- | ---------- | ------------------------------ |
| `agents` jobs/claims outside watched app manifests |   29 | 29/0/0       | 29,000 / 118,784  | 8,010 / 185,102 | 28 / 525   | Preserve; no removal inference |
| Two untracked `headlamp` deployments               |    2 | 0/2/0        | 0 / 0             | 0 / 88          | 0 / 0      | S4                             |
| CoreDNS, kube-proxy and Flannel                    |    8 | 0/1/1        | 800 / 440         | 65 / 471        | 0 / 0      | Preserve; no removal inference |
| Talos control-plane mirror Pods                    |    9 | 0/0/0        | 780 / 2,496       | 594 / 15,070    | 0 / 0      | Preserve; no removal inference |
| `arc` scratch claims without a matched pod mount   |    0 | 0/0/0        | 0 / 0             | —               | 4 / 256    | Preserve; no removal inference |
| Unattached `torghut` claims                        |    0 | 0/0/0        | 0 / 0             | —               | 2 / 150    | Preserve; no removal inference |
| `openclaw` retained VM disk                        |    0 | 0/0/0        | 0 / 0             | —               | 1 / 85     | S3                             |
| Unattached `jangar` claim                          |    0 | 0/0/0        | 0 / 0             | —               | 1 / 5      | Preserve; no removal inference |
| `bayn` evidence claim                              |    0 | 0/0/0        | 0 / 0             | —               | 1 / 4      | Preserve; no removal inference |

### How to refresh the evidence

Use the [Galactic access runbook](../runbooks/galactic-kubernetes-access.md) and confirm the context/identity.
Take the following lists once, close together in time; list only the metadata, ownership, resource quantities,
and status needed for this comparison. Keep raw object bodies, credentials, and individual pod IPs out of the PR.

- In `argocd`, inventory Applications and ApplicationSets: name, generator owner or parent Application, source
  path/revision, destination, finalizers, and `status.resources`. Compare to
  [ApplicationSet inputs](../../argocd/applicationsets/) and the
  [enabled inventory loader](../../packages/scripts/src/shared/enabled-apps.ts); distinguish disabled elements
  from overlays, fixture directories, Helm chart Applications, and external child Apps.
- Cluster-wide, list pods, Deployments, ReplicaSets, StatefulSets, DaemonSets, Jobs, CronJobs, and, where needed,
  their owning custom resources. Attribute pods and claims by exact Argo tracking annotation or
  `status.resources` match, then follow owner references. Use a single Application's dedicated namespace for
  its generated dependents only where there is no competing owner (e.g. Coder workspace pods in `coder`).
  Count ARC listeners and ephemeral runners against the App that tracks the runner sets (`arc-controller`);
  `arc` owns the child Application, not those pods. Leave unrelated/unmatched rows separate.
- Use `kubectl --context "$CONTEXT" -n kube-system top pods -A --no-headers` for the usage join on
  namespace and pod name. Sum admission-time effective requests from the non-terminal Pod specs, independent
  of whether a metrics sample is present. Compare namespace, node, phase, host networking, and IP status
  before attributing capacity; repeat the comparison at the eventual retirement revision.
- List PVCs and PVs, joining an owned or uniquely mounted PVC to its Application and the bound PV to the
  claim's `spec.volumeName`. Include retained/unmounted claims, StatefulSet claim templates, and operator-created
  claims. Verify `persistentVolumeReclaimPolicy`, resource-level retention, and owner references before any
  prune. An untracked claim or missing mount is not permission to remove it.

## This PR: Retire Restate Greeter

- [The remaining sample](../../services/restate-example/README.md) exposes only `Greeter/greet`.
  The old registration and smoke Jobs were one-off GitOps checks, both Succeeded; there is no CronJob.
  Repository references outside the sample were its generator entry and kube-router's inventory of its
  NetworkPolicy, not callers of Greeter. Production Restate and its existing smoke checks remain enabled.
- Live Restate deployment metadata identified one Greeter-only registration
  (`dp_13GFxISRC9h4omWq5dVmcCt`, tagged `app=restate-example`), no Kafka subscriptions, and no retained
  Greeter invocations (a grouped read of `sys_invocation` filtered on `target_service_name = 'Greeter'`).
  The live Application's `resources-finalizer.argocd.argoproj.io` covers three bundle ConfigMaps, a
  Deployment, Service, two Jobs and one NetworkPolicy. No PVC, Role, RoleBinding or tracked Namespace was found.
- Delete the `platform` generator entry and only the demo GitOps source. Drop the exact demo policy row
  from kube-router preflight, production validation, coverage probe, and CI path routing. Retain strict
  namespace equality and all other fingerprints. The capacity gain after reconciliation is **1 pod and 1 IP
  on Turin, 100m CPU and 256 MiB requested, no storage**. Removing the two terminal Pod records does not
  recover two more IPs.
- For an authorized rollout after review: recheck Greeter registration/subscriptions/invocations, the exact
  main revision, and `root`/ApplicationSet live diff. The live root was manual in this snapshot. Reconcile
  only the `platform` ApplicationSet through root; verify the demo Application, Deployment, Service, Jobs,
  pods and NetworkPolicy are gone. Recheck the `restate` Application and the owner's non-demo smoke/health
  checks. Do **not** sync manual `kube-router` before the demo NetworkPolicy has pruned. Then run
  `scripts/kube-router/verify-safety-coverage.sh` in the verified context before the next kube-router sync.
  If the policy is still present, the new hook must fail closed; resolve the Application deletion rather
  than bypassing the gate.
- The namespace and Restate's external-to-Argo registration are not pruned by removing the Application.
  Do not delete the namespace. Have the Restate owner remove only the stale Greeter registration through
  the supported admin procedure after reconfirming it has no callers or pending invocations; do not force
  deletion if the safe operation refuses it. Have the namespace owner revoke the now-unused
  `restate.proompteng.ai/admin-access` label from the retained empty demo namespace under an approved
  cleanup. Neither operation is part of this PR. To roll back the GitOps removal, revert the retirement
  commit, reconcile the platform entry and let its registration/smoke Jobs recreate and verify Greeter
  before syncing the restored kube-router contract.

## Approval-only retirement PRs

Request approval **per row**, with its measured footprint from the ranking. Nothing below is authorized
by this PR. First record the owner and maintenance window, the exact resources and consumers, and an
off-cluster backup plus a restore check for every data store. Check all traffic, clients and scheduled jobs
before stopping writers. The first PR removes compute/routing intent while retaining or migrating state;
deleting data or namespaces is never implicit.
For a user app with no remaining consumers, the owner can approve shutdown instead of a successor after
verifying inactivity and a tested recovery path. Shared or safety-critical services still require a cutover.

| PR family                       | Exact GitOps change after approval                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P** — platform on `main`      | Edit the active Kustomize or Helm inputs in `argocd/applications/<app>` to quiesce and then remove the named workload, jobs and routes. Keep claim manifests/retention and required policies until compute is gone. Once replay/rollback data is protected, remove that exact element from `argocd/applicationsets/platform.yaml`. This set can cascade: before detaching, verify retained objects are not in its deletion set.                                                                                                                                                                                                                                                                                                                           |
| **K** and **T** — Kargo-managed | Edit the app source under `argocd/applications/<app>` on `main`. Cut over consumers before removing or scaling down the old source. Deliver changes through the recorded Stage and promoted `kargo/<stage>` revision, not a manual retarget or image bump. Remove the named element from its owning set only after workload retirement is proven. For `product.yaml`, preservation is the default: detaching the Application alone commonly leaves all pods running. Stop new publications/auto-promotions for the retired target in its owning delivery config only after the final safe desired state is promoted, and only if no surviving Application shares that Stage or build. Keep the last known-good Freight and backup available for rollback. |
| **H** — home repository         | Make the PR in [`gregkonush/home`](https://github.com/gregkonush/home), not in lab. Prune compute through the child Application's overlay while the child still reconciles; remove only its specific Application file and kustomization entry after cleanup is proven. The sampled children have no resource finalizer. Keep `home-root`, the other child, and lab's repository credential/delegation.                                                                                                                                                                                                                                                                                                                                                    |

For any approval PR, render the exact source before and after, run `bun run lint:argocd` and affected
component/contract tests, and inspect prune/retain kinds and names. For Helm render with Helm 3. At rollout,
record the reconciled revision and compare pods, primary IPs, requests and bound claims against a new baseline;
exercise the named survivor/replacement checks below. On a regression, revert the PR and reconcile through the
same owning path (or restore/re-promote the verified prior Freight for Kargo); restore data from the tested
backup before restarting writers. If an app is listed by kube-router, update its exact namespace/hash contract
with the same discipline as the Greeter change and keep the manual gate closed until the policy transition settles.

### Home, platform and operator tooling

| ID  | App and PR scope                                                                                                                                   | Required before prune / proof of replacement or retirement                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `home-media`: `apps/media/overlays/galactic-downloads` then `argocd/media-application.yaml`.                                                       | Stop download and library writers; migrate scheduled downloads and verify Plex/library playback and imports at the replacement. Preserve the static 40 TiB `media-data-kernel` (Retain) and all 17 Ceph claims (Delete), including media-server config and the Stash download claim. Validate the shared mounts in both apps. |
| H2  | `home-stash`: `apps/media/overlays/galactic-stash` then `argocd/stash-application.yaml`.                                                           | Stop scans and publisher/fetch jobs; back up the Stash catalog, media, cache and publisher state. The three RBD claims (6,147 GiB) are Delete-backed. Verify restored catalog and media playback with the owner; keep `home-media` working.                                                                                   |
| P1  | `penpot`: render the chart in `argocd/applications/penpot`; remove frontend/backend/exporter/MCP, Valkey, routes and DB compute only after export. | Test a design export/restore and MCP access on the successor. Preserve `penpot-db` and `penpot-data-assets` data and the signing key; all three PVs have Delete policy.                                                                                                                                                       |
| P2  | `paperless`: retire `paperless.yaml`, the converters, cache, database compute, ingestion, backup schedule and access routes in dependency order.   | Pause ingest, verify document/media/index restoration, and move Flamingo-assisted and Agent Shell clients. Retain database backups and media/consume/data/Valkey claims (six Delete-backed PVs).                                                                                                                              |
| P3  | `glitchtip`: move all DSN users and alert routes, then retire web/worker services and DB compute.                                                  | Deliver a test event and alert in the successor first. Preserve event data and both `glitchtip-pg` claims (Delete).                                                                                                                                                                                                           |
| P4  | `pelican`: quiesce the games and Wings VM, then retire the Panel, routes and compute.                                                              | Restore a game save and validate Panel-to-Wings authentication on the successor. Preserve `pelican-data`, `pelican-wings-rootdisk` and bootstrap/key material. The DataVolume owns the guest disk; keep it and its Delete-backed PVC unless an independent data-retirement approval says otherwise.                           |
| P5  | `auto-ontology`: disable graph ingestion and retire frontend/API/worker/migrations.                                                                | Preserve graph DB, confirm scheduled ingest is stopped, verify audit consumers have migrated and retain the Agents audit projections. Disconnect the reader using its owner, never expand its grants.                                                                                                                         |
| P6  | `pgadmin`: retire the deployment and ingress, leaving the settings claim.                                                                          | Export saved server definitions securely, migrate user access, and verify DB administration still works. The Application is manual.                                                                                                                                                                                           |
| P7  | `feature-flags`: migrate SDK clients and Git-cache publishing, then remove runtime and routes.                                                     | Verify representative flag evaluations/fallbacks in the replacement, and preserve the Git-backed flag state and cache claim.                                                                                                                                                                                                  |
| P8  | `coder`: migrate workspace templates, users and workspaces, then remove the control plane after all workspaces are drained.                        | Back up the Coder database plus user workspace volumes. Start and connect to a replacement workspace; ensure migrations do not affect the separate Agents workspace claim.                                                                                                                                                    |
| P9  | `forgejo-runners`: drain the runner StatefulSets and deregister only their retired runner seats.                                                   | Prove amd64 and arm64 jobs succeed on approved replacement runners; retain state and leave Forgejo and ARC running. Coordinate with K13 if the Git server moves too.                                                                                                                                                          |
| P10 | `nemotron-rerank`: migrate callers before removing deployment and service.                                                                         | Validate ranking on representative Jangar/retrieval requests; keep the model-cache claim until a rollback is no longer required. The one pod has an 8,000m/24,576 MiB reservation.                                                                                                                                            |
| P11 | `flamingo`: retire the serving deployment only after endpoint cutover.                                                                             | Prove inference from Agents/Pi and Paperless on the successor; keep the model cache and previous model ID. The service is a production GPU endpoint, not an OpenClaw orphan.                                                                                                                                                  |
| P12 | `saigak`: retire the serving StatefulSet after migrating embedding callers.                                                                        | Verify dimensions and retrieval quality on existing indexes before cutover; keep all three node/model claims. Its one pod is on node 194, not a Turin or node 85 win.                                                                                                                                                         |

### Promoted product, research and shared services

K rows use the Application name as their source directory. The live branches were `kargo/<app>` except
`hermes` (`kargo/hermes-toolchain`) and `symphony-jangar` (shared `kargo/symphony`). Edit only the
app's element in the **set** below after its final desired state has settled. None of the measured ranks justify removing a caller or provider without a cutover.

| ID  | App / set                       | Required cutover and PR target                                                                                                                                                                                                                                                                              |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | `tengri` / platform             | Fence new VM allocations; drain slot workers and hand off persistent VM/lease state before removing the allocator, controller and helpers. Verify clients can create, resume and dispose of a replacement VM. Do not remove `tengri-devices` or node setup as a side effect.                                |
| K2  | `ofz` / platform                | Migrate organizations, authorization and site/workspace clients; prove login, isolated access and recovery on the successor. Retain service DB and preserve identity boundaries while detaching control-plane/runtime inputs.                                                                               |
| K3  | `buzz` / platform               | Cut users and callbacks over to the successor; drain service/worker inputs and restore its DB and cache state. Verify sign-in and a representative workflow.                                                                                                                                                |
| K4  | `bilig` / product               | Export/restore workbooks and move user/API clients before retiring service, worker and data-plane pods. Prove save/reopen on the replacement; preserve its external image-delivery exception.                                                                                                               |
| K5  | `opencode` / platform           | Move the server and research clients, then remove both deployment inputs (`server.yaml`, `research.yaml`). Preserve workspace/research claims, and prove a representative session resumes.                                                                                                                  |
| K6  | `hermes` / platform             | Stop gateway/session intake and backup only after the final verified backup; retain the 50 GiB state and 100 GiB backup claims and toolchain. Restore and verify an existing session per the [Hermes runbook](../runbooks/hermes-production-rollout.md).                                                    |
| K7  | `attic` / platform              | Move Nix substituter clients to the authorized replacement; prove a cold substitution and signing trust. Preserve cache metadata/claim and do not touch the OCI registry.                                                                                                                                   |
| K8  | `app` / product                 | Move public app routes and stateful clients; verify authenticated reads/writes with the restored DB, then retire the active overlay.                                                                                                                                                                        |
| K9  | `synthesis` / product           | Stop work intake and drain in-flight writes before retiring the service overlay; preserve its DB and verify a representative synthesis result after cutover.                                                                                                                                                |
| K10 | `relay` / platform              | Redirect upstream subscriptions and downstream consumers, drain relay traffic, then remove the relay runtime and routes; deliver one end-to-end test event to the replacement.                                                                                                                              |
| K11 | `oirat` / product               | Move user/API access and verify a representative request at the replacement before pruning Oirat's serving inputs, routes and telemetry attachments.                                                                                                                                                        |
| K12 | `froussard` / product           | For whole-app retirement, move webhook deliveries and approvals, drain, then remove Knative Service and approvals deployment; prove delivery and an approval end to end. See S2 for zero-pod historical revisions; no change to the current route in this wave.                                             |
| K13 | `forgejo` / product             | Migrate repositories, identities, LFS/packages, webhooks and runners; verify a clone, push and CI run at the successor before pruning server compute. Keep DB/data and existing Git service credentials recoverable.                                                                                        |
| K14 | `headlamp` / platform           | Replace dashboard and auth bridge for operators before removing ingress and deployments; verify authorized Kubernetes access and rejection of unauthorized writes at the successor. The two untracked proofs in S4 are not part of the application.                                                         |
| K15 | `devbox` / platform             | Move active devbox users, stop the StatefulSet and restore a workspace from backup before retiring the app. Keep the 500 GiB workspace claim independent of the Agents workspace; this saves only one IP on Turin.                                                                                          |
| K16 | `symphony` / product            | Stop task intake, transfer in-flight runs and state, and prove a task completes elsewhere before removing the `symphony` overlay in `jangar`. Preserve the sibling `symphony-jangar` app unless K17 is separately approved.                                                                                 |
| K17 | `symphony-jangar` / product     | Migrate only the Jangar derivative's queues/callers and DB/workspace state; prove the successor completes a queued run before detaching the separate `symphony-jangar` overlay.                                                                                                                             |
| K18 | `bumba` / product               | Move scheduled work and memory consumers, drain writes, and verify a new job and state lookup on the replacement before removing the Bumba overlay in `jangar`.                                                                                                                                             |
| K19 | `docs` / product                | Move publishing, hostname and redirects, then retire the serving deployment. Verify current deep links and newly published docs at the successor before cutting DNS.                                                                                                                                        |
| K20 | `analysis` / product            | Migrate notebooks/consumers and verify representative analysis results before removing the app workload; preserve the external image-delivery exception and any upstream-owned artifacts.                                                                                                                   |
| T1  | `torghut` / product             | Not a standalone capacity change: require the trading/data owners' approved migration of feeds, signals, archive and research storage. Protect retained claims and prove freshness, completeness, rollback and downstream readers before any retirement. This plan grants no Bayn capital or policy change. |
| T2  | `torghut-webull-feed` / product | Move subscribers to an approved feed, prove freshness, symbol coverage and gap/reconnect behavior, then remove only the Webull feed source and its Stage enrollment. Verify the product entry's explicit resource finalizer/diff before detach. Keep Torghut and other feeds running.                       |

### Zero-capacity and non-Application findings

| ID  | Scope                                                                | Evidence and next PR, if approved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `discourse`, `backstage`, `fission`, `dagster`, `airbyte`, `inngest` | Disabled in `product.yaml` (Discourse) or `platform.yaml` (the others). No live Application, pod or PVC in their dedicated namespaces. Keep the prepared manifests. A separate source-only retirement may remove the named disabled element and its unreferenced input tree after owner and caller checks; it releases no compute/storage.                                                                                                                                                                                                                                        |
| S2  | Old `froussard` revisions                                            | Knative routed 100% to `froussard-00136`. `00134` and `00135` had zero desired/current pods; two old approvals ReplicaSets were at zero too. They release no IPs. Keep the [Knative retention policy](../../argocd/applications/knative-serving/knative-serving.yaml) and current workloads. Do not change global GC to delete a single service's rollback history.                                                                                                                                                                                                               |
| S3  | `openclaw`                                                           | Disabled in `platform.yaml`, no Application, VM, VMI or pods. `DataVolume/openclaw-rootdisk-rbd` owns its one 85 GiB Bound PVC on a Delete PV. The original disk is gone; the retained disk is the recovery copy. Follow the [owning README](../../argocd/applications/openclaw/README.md). Retire disabled source only after explicit disk retention/restore sign-off; with the app already absent, a Git edit won't delete this disk. Any separately approved disk retirement needs a tested export and a targeted storage operation, not a namespace deletion or a VM restart. |
| S4  | Headlamp websocket proofs                                            | `headlamp/a-ws-proof-1773535482` and `headlamp/ws-proof-1773538732` each have one pod on node 85, with no Argo tracking or matching lab manifest. Confirm original owner, service selectors, and no dependencies; this needs separate approval for targeted cleanup, not a change to the Headlamp Application.                                                                                                                                                                                                                                                                    |
| S5  | `torghut-ws-sip`                                                     | A Deployment within Torghut, not an Application. Both live and [source](../../argocd/applications/torghut/ws/sip-deployment.yaml) specify zero replicas. It is a staged [SIP shadow lane](../bayn/consolidated-sip-shadow-rollout.md), not a demo. If market-data owners cancel that lane, a T1-scoped PR removes only the SIP Deployment/Service/ConfigMap and their `ws/kustomization.yaml` entries after auditing archive and replay consumers; no IP or compute capacity to gain now.                                                                                         |

Other disabled inputs were checked for live Applications, not treated as deployments: product `cms`, `olden`,
`homepage`, `kitty-krew`, `reviseur`, `prt`, `ecran`, `eclair`, `symphony-torghut`, `khoshut`,
`galette`, `facteur`, `golink`, `sag`, `torghut-options`, `torghut-hyperliquid-feed`,
`torghut-hyperliquid-runtime`, `miel`, `dernier`, and `reestr`; platform `torghut-cuda-ranker`, `workers`,
`external-dns`, `minio`, `milvus`, `verdaccio`, `spark`, `graf`, and `convex`. A disabled input
in a shared namespace is not evidence that every old claim there can be deleted. The remaining unlisted directories
are the shared `symphony-base`, dedicated `agents-workspace` source, the prepared `longhorn` tree and the
`storage-upgrade-acceptance`, `postgres-upgrade-acceptance`, and `clickhouse-upgrade-acceptance` operation inputs.
Do not delete fixtures or re-enable prepared workloads to gain capacity.

**First approvals to consider:** Outside coordinated trading and platform migrations, H1 has the largest
standalone user-app reduction: 17 IPs on Turin/node 85. It also has the largest data footprint. P1 and P2 are next among the requested
user-facing candidates (8 and 6 IPs). If minimizing user impact comes first, establish the owners of S4 and
ask about just those two untracked proofs, not the dashboard. The old Froussard revisions, staged SIP lane
and disabled apps will not relieve current pod-IP pressure.
