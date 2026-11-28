# Turin Tailscale proxy IP consolidation

**Status:** Wave 20C audit and proposed cutover; no routing or tailnet policy changes are in this wave.

## Live baseline

Read-only Galactic snapshot on 2026-11-28, reconciled against `lab` main at `aa0a2d91f1f2`:

| On `turin` in `tailscale`                        |   Pods | Distinct pod IPs |
| ------------------------------------------------ | -----: | ---------------: |
| Standalone layer-7 Ingress proxies               |     27 |               27 |
| Standalone Service proxies                       |     25 |               25 |
| `kubernetes-subnet-router` Connector             |      1 |                1 |
| Tailscale operator                               |      1 |                1 |
| **Total (all Running, none using host network)** | **54** |           **54** |

That is **10.6%** of the wave's 509-address usable `/23` budget. The operator (`v1.104.7`) had no ProxyGroups. Each of
the 52 endpoint proxies had one live parent and one ready replica. All 27 Ingresses had different advertised
hostnames. The 25 Services used `loadBalancerClass: tailscale`; three also set `tailscale.com/expose: "true"` and
count only once. There were **zero orphaned proxies and zero confirmed unused or redundant exposures**. This is an
ownership snapshot, not a traffic or client-dependency audit. For example, `buzz/buzz` and `buzz/buzz-admin` share a
backend but serve different hosts, and `stash/stash-lan` is an existing LAN route, not a replacement for the tailnet
authorization on `stash/stash`.

### Endpoint inventory

Source inputs below are relative to [`argocd/applications/`](../../argocd/applications/) unless noted. The inventory
matches both direct resources and Helm values (`ingressClassName` or `className`), and includes the live parents
rendered outside that directory so all 52 proxies are accounted for: 35 from these application paths, one from the
Kargo ApplicationSet, and 16 from external GitOps sources.

| Namespace       | Live Ingress parents                                     | Live Service parents                                                                                                                                                   | Source inputs                                                                          |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `agents`        | —                                                        | `agents-tailscale`                                                                                                                                                     | `agents/tailscale-service.yaml`                                                        |
| `analysis`      | —                                                        | `analysis-tailscale`                                                                                                                                                   | `analysis/generated/service-analysis-tailscale.yaml`                                   |
| `attic`         | `attic-tailscale`                                        | —                                                                                                                                                                      | `attic/tailscale-ingress.yaml`                                                         |
| `auto-ontology` | `auto-ontology-tailscale`, `auto-ontology-mcp-tailscale` | —                                                                                                                                                                      | `auto-ontology/tailscale-ingress.yaml`                                                 |
| `buzz`          | `buzz`, `buzz-admin`                                     | —                                                                                                                                                                      | `buzz/values.yaml`, `buzz/admin-ingress.yaml`                                          |
| `feature-flags` | —                                                        | `feature-flags-tailscale`                                                                                                                                              | `feature-flags/tailscale-service.yaml`                                                 |
| `flamingo`      | —                                                        | `flamingo-tailscale`                                                                                                                                                   | `flamingo/tailscale-service.yaml`                                                      |
| `glitchtip`     | `glitchtip-tailscale`                                    | —                                                                                                                                                                      | `glitchtip/tailscale-ingress.yaml`                                                     |
| `headlamp`      | `headlamp`                                               | —                                                                                                                                                                      | `headlamp/values.yaml`                                                                 |
| `hermes`        | `hermes-tailscale`                                       | —                                                                                                                                                                      | `hermes/tailscale-ingress.yaml`                                                        |
| `jangar`        | —                                                        | `jangar-tailscale`, `jangar-vscode-tailscale`, `openwebui-tailscale`                                                                                                   | `jangar/{app-,vscode-,}tailscale-service.yaml`                                         |
| `kafka`         | `kafka-ui-tailscale`                                     | —                                                                                                                                                                      | `kafka/load-balancer.yaml`                                                             |
| `kargo`         | `kargo-tailscale`                                        | —                                                                                                                                                                      | [`argocd/applicationsets/helm-apps.yaml`](../../argocd/applicationsets/helm-apps.yaml) |
| `media`         | `qui`                                                    | `audiobookshelf`, `bazarr`, `homepage`, `lidarr`, `plex`, `prowlarr`, `qbittorrent`, `radarr`, `sabnzbd`, `seerr`, `shelfarr`, `sonarr`, `tautulli` (all `-tailscale`) | External Argo Application `home-media`                                                 |
| `observability` | `observability-{grafana,loki,mimir,tempo}-tailscale`     | —                                                                                                                                                                      | `observability/tailscale-ingresses.yaml`                                               |
| `ofz`           | `ofz-playground`                                         | —                                                                                                                                                                      | `ofz/ingress.yaml`                                                                     |
| `opencode`      | `opencode`                                               | —                                                                                                                                                                      | `opencode/tailscale-ingress.yaml`                                                      |
| `paperless`     | `paperless`                                              | —                                                                                                                                                                      | `paperless/network.yaml`                                                               |
| `pelican`       | `pelican`, `pelican-wings`                               | `pelican-games`                                                                                                                                                        | `pelican/networking.yaml`                                                              |
| `penpot`        | `penpot`                                                 | —                                                                                                                                                                      | `penpot/values.yaml`                                                                   |
| `pgadmin`       | `pgadmin`                                                | —                                                                                                                                                                      | `pgadmin/values.yaml`                                                                  |
| `registry`      | `registry-tailscale`                                     | —                                                                                                                                                                      | `registry/tailscale-ingress.yaml`                                                      |
| `restate`       | `restate-admin-tailscale`                                | —                                                                                                                                                                      | `restate/admin-tailscale-ingress.yaml`                                                 |
| `rook-ceph`     | —                                                        | `ceph-dashboard-tailscale`                                                                                                                                             | `rook-ceph/tailscale-service-dashboard.yaml`                                           |
| `stash`         | `appropriate`, `stash`                                   | —                                                                                                                                                                      | External Argo Application `home-stash`                                                 |
| `synthesis`     | —                                                        | `synthesis-tailscale`                                                                                                                                                  | `synthesis/tailscale-service.yaml`                                                     |
| `temporal`      | —                                                        | `temporal-frontend-lb`, `temporal-web-lb`                                                                                                                              | `temporal/load-balancer{,-frontend}.yaml`                                              |
| `torghut`       | `torghut-notebooks`                                      | —                                                                                                                                                                      | `torghut/notebooks/values.yaml`                                                        |

The other **11 Service definitions** in `lab` had no matching live proxy by namespace and name: `convex/dashboard-service.yaml`,
`dagster/load-balancer.yaml`, `facteur/overlays/cluster/facteur-tailscale-service.yaml`, `golink/tailscale-service.yaml`,
`graf/neo4j-browser-service.yaml`, `graf/tailscale-service.yaml`, `homepage/tailscale-service.yaml`,
`inngest/tailscale-service.yaml`, `minio/observability-object-browser-service.yaml`, `reestr/reestr-tailscale-service.yaml`,
and `torghut/tailscale-service.yaml`. In particular, `homepage/homepage-tailscale` is not the live `media/homepage-tailscale`,
and the Torghut API Service is an unused recovery input, not the notebooks Ingress. None yields a Turin IP in this snapshot.

## Candidate savings

Use one private Traefik gateway rather than an operator pod per HTTP endpoint. The estimated range assumes a single
[layer-3 tailnet entry Service](https://tailscale.com/docs/kubernetes-operator/ingress/expose-workload-to-tailnet-l3) on a two-replica ingress ProxyGroup,
forwarding HTTPS over TCP to a dedicated Traefik entrypoint; backend routing and TLS stay with Traefik. Both added pods
are charged to `turin` in the estimate, even if the replicas are spread. Do not count reclaim before removing the old
exposures.

| Scenario                                            | Ingress proxies moved | HTTP Service proxies moved | New proxy pods | Net Turin IPs freed |
| --------------------------------------------------- | --------------------: | -------------------------: | -------------: | ------------------: |
| Initial candidates, subject to per-route acceptance |                    21 |                         18 |              2 |              **37** |
| Including the eight gated endpoints below           |                    26 |                         21 |              2 |              **45** |

- **Keep dedicated in both scenarios:** `restate/restate-admin-tailscale` has an explicit admin network-policy
  boundary. `agents/agents-tailscale` (HTTP plus gRPC `50051`), `temporal/temporal-frontend-lb` (gRPC `7233`),
  `pelican/pelican-games` (SFTP `2022` and UDP `10999`/`11000`), and `media/plex-tailscale` (native clients on
  `32400`) are not part of the shared HTTPS cutover. Keep the operator and subnet Connector as well.
- **Gated Ingresses (5):** Headlamp and Hermes need login, redirects and authenticated API checks; `pelican-wings`
  needs panel-to-node connectivity; the registry needs real client pull/push and uninterrupted upload behavior;
  Torghut notebooks need login, callback and kernel WebSocket checks. Keep each standalone if those gates fail.
- **Gated Services (3):** `media/seerr-tailscale` has a distinct tailnet tag, `media/qbittorrent-tailscale` needs
  Web UI host and reverse proxy validation, and `temporal/temporal-web-lb` needs UI auth and callback validation.
  The initial cohort is all remaining HTTP parents, not permission to remove them without validation.

If equivalent access control needs separate two-replica private and `tag:k8s` tailnet entry paths on the same Traefik
gateway, charge four new pods instead: **35–43** net. Subtract one for every additional dedicated endpoint that cannot
move. Namespace counts alone do not establish that sharing a gateway is safe or that it can handle aggregate traffic.

## Cutover and rollback gates

1. Use the existing [Traefik deployment](../../argocd/applications/traefik/values.yaml) with a dedicated entrypoint
   not exposed on the MetalLB Service. Target only that listener with a new Tailscale `LoadBalancer` Service without
   NodePorts. Verify the operator's [permissions for HA ingress](https://tailscale.com/docs/kubernetes-operator/reference/rbac)
   before the pilot. No Funnel or public Ingress. The operator's [standalone L7 ingress](https://tailscale.com/docs/kubernetes-operator/ingress)
   terminates HTTPS for its own MagicDNS name. Do not assume it can alias arbitrary old `*.ts.net` hostnames to a new
   gateway. Pilot new names in approved private DNS with valid per-host TLS; the existing `*.k8s.proompteng.ai`
   certificate does not cover `*.ts.net`. Update client URLs, callbacks, and host allowlists before retirement.
2. Inventory tailnet grants, callers and actual traffic over at least one full workload cycle before declaring anything
   unused. Check the different `tag:private`, `tag:k8s`, `tag:seerr` and default-tag boundaries. A grant to a shared
   tailnet device/port does not grant access per HTTP host. Enforce equivalent authorization on each route or leave it
   dedicated. Restrict access to the entrypoint and the backends with NetworkPolicy as needed; do not broaden existing
   access. Check authorized and denied requests from the affected tailnet groups, ordinary cluster pods, and outside
   the tailnet.
3. Pilot under new hostnames with the old parents intact. Exercise each migrated application, including redirects,
   streaming or WebSocket traffic where used, and measure gateway errors and latency against baseline. Coordinate
   the `home-media` and `home-stash` batches in their owning repository. After acceptance, remove the dedicated
   Service exposure or Ingress through its owning GitOps source and verify that the operator deletes its pod. In a
   rollback, restore the previous parent and client DNS/URLs through the same sources; verify hostname and TLS before
   moving clients back. Do not delete generated StatefulSets as the cutover or rollback mechanism.
4. Repeat the on-node count and match each old parent to its removed proxy, each migrated endpoint to its working route,
   and each new proxy to its node. Verify the change in free pod addresses with the node's CNI, not just the cluster-wide
   number of pods.

For a read-only inventory, use the verified Galactic context (commands below use its `in-cluster` context):

```sh
kubectl --context in-cluster -n tailscale get pods --field-selector spec.nodeName=turin \
  -o 'custom-columns=NAME:.metadata.name,PHASE:.status.phase,IP:.status.podIP,OWNER:.metadata.ownerReferences[0].name'
kubectl --context in-cluster -n tailscale get statefulsets \
  -o 'custom-columns=NAME:.metadata.name,NS:.metadata.labels.tailscale\.com/parent-resource-ns,KIND:.metadata.labels.tailscale\.com/parent-resource-type,PARENT:.metadata.labels.tailscale\.com/parent-resource'
kubectl --context in-cluster -n tailscale get ingress -A -o json |
  jq -r '.items[] | select(.spec.ingressClassName == "tailscale") | [.metadata.namespace,.metadata.name] | @tsv'
kubectl --context in-cluster -n tailscale get service -A -o json |
  jq -r '.items[] | select(.spec.loadBalancerClass == "tailscale" or .metadata.annotations["tailscale.com/expose"] == "true") | [.metadata.namespace,.metadata.name] | @tsv'
```

## CronJob retention boundary

Wave 20C caps the seven active `lab` CronJobs in scope at one successful and at most two failed Jobs. The default here
is a 30-minute TTL after completion or failure. Hermes backup and registry cleanup keep four hours and the Restate drill
keeps twelve hours so pod logs remain available when their freshness alerts fire. Kargo uses its chart's
`garbageCollector` settings. These changes do not affect schedules, cleanup payloads, or stored backups. The three
inactive Torghut recovery CronJobs are not rendered and keep their same-day diagnostic retention; `agents/` and `bayn/`
were excluded from the CronJob audit.

- `media/request-flow-reconcile` (1 success / 3 failures / 24h TTL) and `media/media-sab-uhd-rss-select` (1 / 3 / 1h)
  belong to `home-media` (`apps/media/overlays/galactic-downloads`). `stash/stash-importer` (2 / 3 / 24h) and
  `stash/stash-bluesky` (3 / 3 / 24h) belong to `home-stash` (`apps/media/overlays/galactic-stash`). Tighten these in
  the owning GitOps sources, not with duplicate manifests in `lab`.
- Keycloak had no live CronJobs or terminal Jobs on this readback, and no CronJob manifest. Its CNPG backups and Argo
  hook Jobs are not CronJobs and were left unchanged.
- The snapshot joined ten terminal pods on `turin` to CronJob-owned Jobs in the audited namespaces. A terminal Pod's
  recorded IP is not proof the CNI still holds its allocation. A new TTL applies to newly created Jobs; tighter history
  limits can prune excess old Jobs, but do not rewrite existing Job TTLs. Use the
  [Kubernetes cleanup contract](https://kubernetes.io/docs/concepts/workloads/controllers/ttlafterfinished/) to verify
  Job and dependent Pod removal after new runs without touching active Jobs.
