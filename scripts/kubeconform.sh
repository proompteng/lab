#!/usr/bin/env bash
set -euo pipefail

PATHS=("$@")
if [[ ${#PATHS[@]} -eq 0 ]]; then
  PATHS=("argocd")
fi
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_DIR="${ROOT_DIR}/schemas/custom"
KUBECONFORM_CACHE_DIR="${KUBECONFORM_CACHE_DIR:-${PWD}/.cache/kubeconform}"

if ! command -v kubeconform >/dev/null 2>&1; then
  echo "kubeconform is required but not installed" >&2
  exit 1
fi
if [[ ! -d "$SCHEMA_DIR" ]]; then
  echo "Custom schema directory does not exist: $SCHEMA_DIR" >&2
  exit 1
fi

kustomizations=()
filtered=()
add_manifest_file() {
  local file="$1"
  case "$(basename "$file")" in
    kustomization.yaml | kustomization.yml | kustomizeconfig.yaml | kustomizeconfig.yml)
      kustomizations+=("$file")
      return
      ;;
  esac
  if [[ "$file" == *"/charts/"* ]] || [[ "$file" == *".patch.yaml" ]]; then
    return
  fi
  if grep -Eq '^[[:space:]]*kind:' "$file"; then
    filtered+=("$file")
  fi
}

validate_kustomizations() {
  if [[ ${#kustomizations[@]} -eq 0 ]]; then
    return 0
  fi
  if ! command -v yq >/dev/null 2>&1; then
    echo "yq is required to parse changed kustomization files" >&2
    return 1
  fi
  local file
  for file in "${kustomizations[@]}"; do
    yq eval '.' "$file" >/dev/null
  done
}

for path in "${PATHS[@]}"; do
  if [[ -d "$path" ]]; then
    while IFS= read -r -d '' file; do
      add_manifest_file "$file"
    done < <(find "$path" -type f -name '*.yaml' -print0)
  elif [[ -f "$path" ]]; then
    case "$path" in
      *.yaml | *.yml)
        add_manifest_file "$path"
        ;;
    esac
  else
    echo "kubeconform input path does not exist: $path" >&2
    exit 1
  fi
done

if [[ ${#filtered[@]} -eq 0 ]]; then
  validate_kustomizations
  echo "No Kubernetes manifests with a kind key found in kubeconform inputs" >&2
  exit 0
fi

validate_kustomizations

# Exact GVKs already present in the tree without a schema. Remove an exemption
# when adding its schema; do not silently skip new or accidentally removed schemas.
SKIP_GVKS=(
  apiextensions.k8s.io/v1/CustomResourceDefinition
  argoproj.io/v1alpha1/ClusterAnalysisTemplate
  authzed.com/v1alpha1/SpiceDBCluster
  barmancloud.cnpg.io/v1/ObjectStore
  builtin/NamespaceTransformer
  cdi.kubevirt.io/v1beta1/DataVolume
  ceph.rook.io/v1/CephBlockPool
  ceph.rook.io/v1/CephCluster
  ceph.rook.io/v1/CephFilesystem
  ceph.rook.io/v1/CephObjectStore
  ceph.rook.io/v1/CephObjectStoreAccount
  ceph.rook.io/v1/CephObjectStoreUser
  cert-manager.io/v1/Certificate
  cert-manager.io/v1/ClusterIssuer
  cert-manager.io/v1/Issuer
  csi.ceph.io/v1/Driver
  csi.ceph.io/v1/OperatorConfig
  external-secrets.io/v1/ClusterSecretStore
  external-secrets.io/v1/ExternalSecret
  external-secrets.io/v1/SecretStore
  generators.external-secrets.io/v1alpha1/Password
  generators.external-secrets.io/v1alpha1/SSHKey
  jetstream.nats.io/v1beta2/Stream
  k8s.cni.cncf.io/v1/NetworkAttachmentDefinition
  kafka.strimzi.io/v1/Kafka
  kafka.strimzi.io/v1/KafkaNodePool
  kafka.strimzi.io/v1/KafkaTopic
  kafka.strimzi.io/v1/KafkaUser
  kargo.akuity.io/v1alpha1/Project
  kargo.akuity.io/v1alpha1/ProjectConfig
  kargo.akuity.io/v1alpha1/Stage
  kargo.akuity.io/v1alpha1/Warehouse
  kubevirt.io/v1/VirtualMachine
  metallb.io/v1beta1/IPAddressPool
  metallb.io/v1beta1/L2Advertisement
  minio.min.io/v2/Tenant
  networking.istio.io/v1/Gateway
  objectbucket.io/v1alpha1/ObjectBucketClaim
  operator.knative.dev/v1beta1/KnativeEventing
  operator.knative.dev/v1beta1/KnativeServing
  postgresql.cnpg.io/v1/Backup
  postgresql.cnpg.io/v1/Cluster
  postgresql.cnpg.io/v1/Database
  postgresql.cnpg.io/v1/ScheduledBackup
  rds.valkey.buf.red/v1alpha1/Valkey
  redis.redis.opstreelabs.in/v1beta2/Redis
  restate.dev/v1beta1/RestateDeployment
  security.istio.io/v1/AuthorizationPolicy
  security.istio.io/v1/PeerAuthentication
  serving.knative.dev/v1/Service
  snapshot.storage.k8s.io/v1/VolumeSnapshot
  snapshot.storage.k8s.io/v1/VolumeSnapshotClass
  snapshot.storage.k8s.io/v1/VolumeSnapshotContent
  sources.knative.dev/v1/KafkaSource
  tailscale.com/v1alpha1/Connector
  tailscale.com/v1alpha1/ProxyClass
  tigerbeetle.proompteng.ai/v1alpha1/TigerBeetleCluster
  traefik.io/v1alpha1/IngressRoute
  traefik.io/v1alpha1/Middleware
  traefik.io/v1alpha1/ServersTransport
  valkey.buf.red/v1alpha1/User
)

KUBECONFORM_ARGS=(
  --strict
  --summary
  --cache "${KUBECONFORM_CACHE_DIR}"
  -n "${KUBECONFORM_CONCURRENCY:-2}"
  --skip "$(IFS=,; printf '%s' "${SKIP_GVKS[*]}")"
  --ignore-filename-pattern 'overlays/'
  --ignore-filename-pattern 'charts/'
  --ignore-filename-pattern 'Chart.yaml'
  --ignore-filename-pattern 'values.yaml'
  --schema-location "${SCHEMA_DIR}/{{.Group}}/{{.ResourceAPIVersion}}/{{.ResourceKind}}.json"
  --schema-location default
)

mkdir -p "$KUBECONFORM_CACHE_DIR"

status=0
batch=()
batch_size=100
for file in "${filtered[@]}"; do
  batch+=("$file")
  if [[ ${#batch[@]} -ge $batch_size ]]; then
    kubeconform "${KUBECONFORM_ARGS[@]}" "${batch[@]}" || status=$?
    batch=()
  fi
done

if [[ ${#batch[@]} -gt 0 ]]; then
  kubeconform "${KUBECONFORM_ARGS[@]}" "${batch[@]}" || status=$?
fi

exit "$status"
