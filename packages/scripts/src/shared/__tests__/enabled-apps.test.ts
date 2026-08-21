import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

import { assertEnabledAppBuildPolicy, loadEnabledAppInventory } from '../enabled-apps'

const inventory = loadEnabledAppInventory()
const platformApplicationSet = readFileSync('argocd/applicationsets/platform.yaml', 'utf8')
const bootstrapApplicationSet = readFileSync('argocd/applicationsets/bootstrap.yaml', 'utf8')
const argoCdKustomization = readFileSync('argocd/applications/argocd/kustomization.yaml', 'utf8')
const argoCdApplicationSetCrdOverlay = readFileSync(
  'argocd/applications/argocd/overlays/argocd-applicationset-crd.yaml',
  'utf8',
)
const argoCdLovelyPluginOverlay = readFileSync('argocd/applications/argocd/overlays/argocd-lovely-plugin.yaml', 'utf8')
const certManagerKustomization = readFileSync('argocd/applications/cert-manager/kustomization.yaml', 'utf8')
const externalSecretsKustomization = readFileSync('argocd/applications/external-secrets/kustomization.yaml', 'utf8')
const kubeVirtKustomization = readFileSync('argocd/applications/kubevirt/kustomization.yaml', 'utf8')
const cdiKustomization = readFileSync('argocd/applications/cdi/kustomization.yaml', 'utf8')
const knativeKustomization = readFileSync('argocd/applications/knative/kustomization.yaml', 'utf8')
const knativeServingManifest = readFileSync('argocd/applications/knative-serving/knative-serving.yaml', 'utf8')
const knativeEventingKustomization = readFileSync('argocd/applications/knative-eventing/kustomization.yaml', 'utf8')
const knativeEventingManifest = readFileSync('argocd/applications/knative-eventing/knative-eventing.yaml', 'utf8')
const enabledAlloyDeploymentPaths = [
  'argocd/applications/agents/alloy-deployment.yaml',
  'argocd/applications/argo-workflows/alloy-deployment.yaml',
  'argocd/applications/argocd/alloy-deployment.yaml',
  'argocd/applications/bilig/alloy-deployment.yaml',
  'argocd/applications/buzz/alloy-deployment.yaml',
  'argocd/applications/jangar/alloy-deployment.yaml',
  'argocd/applications/nats/alloy-deployment.yaml',
  'argocd/applications/observability/cluster-metrics-alloy-deployment.yaml',
  'argocd/applications/oirat/alloy-deployment.yaml',
  'argocd/applications/torghut/alloy-deployment.yaml',
]
const natsKustomization = readFileSync('argocd/applications/nats/kustomization.yaml', 'utf8')
const observabilityKustomization = readFileSync('argocd/applications/observability/kustomization.yaml', 'utf8')
const featureFlagsKustomization = readFileSync('argocd/applications/feature-flags/kustomization.yaml', 'utf8')
const cloudflaredDeployment = readFileSync('argocd/applications/cloudflare/deployment.yaml', 'utf8')
const karapaceManifest = readFileSync('argocd/applications/kafka/karapace.yaml', 'utf8')
const keycloakManifest = readFileSync('argocd/applications/keycloak/keycloak.yaml', 'utf8')
const localPathKustomization = YAML.parse(
  readFileSync('argocd/applications/local-path/kustomization.yaml', 'utf8'),
) as {
  resources?: string[]
  images?: Array<{ name?: string; newName?: string; newTag?: string; digest?: string }>
}
const localPathConfigPatch = readFileSync('argocd/applications/local-path/patches/local-path-config.patch.yaml', 'utf8')
const metallbKustomizationSource = readFileSync('argocd/applications/metallb-system/kustomization.yaml', 'utf8')
const metallbKustomization = YAML.parse(metallbKustomizationSource) as {
  resources?: string[]
  images?: Array<{ name?: string; newName?: string; newTag?: string; digest?: string }>
  patches?: Array<{ target?: { kind?: string; name?: string }; patch?: string }>
}
const nvidiaDevicePluginManifests = [
  readFileSync('argocd/applications/nvidia-gpu-operator/altra-nvidia-device-plugin.yaml', 'utf8'),
  readFileSync('argocd/applications/nvidia-gpu-operator/turin-nvidia-device-plugin.yaml', 'utf8'),
]
const coderChart = YAML.parse(readFileSync('argocd/applications/coder/Chart.yaml', 'utf8')) as {
  appVersion?: string
  version?: string
  dependencies?: Array<{ name?: string; version?: string }>
}
const coderValues = YAML.parse(readFileSync('argocd/applications/coder/values.yaml', 'utf8')) as {
  coder?: {
    coder?: {
      replicaCount?: number
      image?: { tag?: string }
    }
  }
}
const temporalKustomization = YAML.parse(readFileSync('argocd/applications/temporal/kustomization.yaml', 'utf8')) as {
  helmCharts?: Array<{ name?: string; version?: string }>
  images?: Array<{ name?: string; newName?: string; newTag?: string; digest?: string }>
}
const jangarKustomization = YAML.parse(readFileSync('argocd/applications/jangar/kustomization.yaml', 'utf8')) as {
  helmCharts?: Array<{ name?: string; version?: string }>
  images?: Array<{ name?: string; newTag?: string; digest?: string }>
}
const openWebUIValues = YAML.parse(readFileSync('argocd/applications/jangar/openwebui-values.yaml', 'utf8')) as {
  image?: { tag?: string }
}
const saigakStatefulSet = YAML.parse(readFileSync('argocd/applications/saigak/statefulset.yaml', 'utf8')) as {
  spec?: {
    template?: {
      spec?: {
        initContainers?: Array<{ name?: string; image?: string }>
        containers?: Array<{ name?: string; image?: string }>
      }
    }
  }
}
const flamingoDeployment = YAML.parse(readFileSync('argocd/applications/flamingo/deployment.yaml', 'utf8')) as {
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{ name?: string; image?: string }>
      }
    }
  }
}
const karapaceResources = YAML.parseAllDocuments(karapaceManifest).map((document) => document.toJSON()) as Array<{
  apiVersion?: string
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
    annotations?: Record<string, string>
    labels?: Record<string, string>
  }
  spec?: {
    topicName?: string
    partitions?: number
    replicas?: number
    config?: Record<string, string | number>
  }
}>
const productApplicationSet = YAML.parse(readFileSync('argocd/applicationsets/product.yaml', 'utf8')) as {
  spec?: {
    syncPolicy?: { preserveResourcesOnDeletion?: boolean }
    generators?: Array<{
      matrix?: {
        generators?: Array<{
          list?: {
            elements?: Array<{ name?: string; cascadeResourcesOnDeletion?: boolean }>
          }
        }>
      }
    }>
    templatePatch?: string
  }
}
const flannelConfigMap = YAML.parse(readFileSync('argocd/applications/flannel-cni/kube-flannel-cfg.yaml', 'utf8')) as {
  metadata?: { annotations?: Record<string, string> }
  data?: Record<string, string>
}

const entry = (name: string) => {
  const found = inventory.entries.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Missing enabled app inventory entry for ${name}`)
  return found
}

describe('enabled app inventory', () => {
  it('loads only root-enabled ApplicationSet entries plus direct root-managed Applications', () => {
    expect(inventory.applicationSetEntryCount).toBeGreaterThan(0)
    expect(inventory.directApplicationCount).toBe(1)
    expect(inventory.entries).toHaveLength(inventory.applicationSetEntryCount + inventory.directApplicationCount)
    expect(inventory.entries.some((candidate) => candidate.name === 'facteur')).toBe(false)
    expect(inventory.entries.some((candidate) => candidate.name === 'bonjour')).toBe(false)
    expect(inventory.entries.some((candidate) => candidate.name === 'olden')).toBe(false)
    expect(inventory.entries.some((candidate) => candidate.name === 'posthog')).toBe(false)
    expect(inventory.entries.some((candidate) => candidate.name === 'sag')).toBe(false)
    expect(entry('flannel-cni')).toMatchObject({
      class: 'vendor-manifest',
      path: 'argocd/applications/flannel-cni',
    })
  })

  it('records preservation intent when a product app is disabled', () => {
    expect(productApplicationSet.spec?.syncPolicy?.preserveResourcesOnDeletion).toBe(true)
    const productElements = productApplicationSet.spec?.generators?.[0]?.matrix?.generators?.[1]?.list?.elements ?? []
    expect(productElements.find((candidate) => candidate.name === 'sag')?.cascadeResourcesOnDeletion).not.toBe(true)
  })

  it('guards the required pod MTU without changing the Talos VXLAN backend', () => {
    const cni = JSON.parse(flannelConfigMap.data?.['cni-conf.json'] ?? '{}') as {
      plugins?: Array<{ delegate?: { mtu?: number } }>
    }
    const network = JSON.parse(flannelConfigMap.data?.['net-conf.json'] ?? '{}') as {
      Backend?: { Type?: string; Port?: number }
    }

    expect(flannelConfigMap.metadata?.annotations?.['argocd.argoproj.io/sync-options']).toBe('Delete=false')
    expect(cni.plugins?.[0]?.delegate?.mtu).toBe(1400)
    expect(network.Backend).toEqual({ Type: 'vxlan', Port: 4789 })
  })

  it('cascades resources for generated Applications that are disabled destructively', () => {
    const productElements = productApplicationSet.spec?.generators?.[0]?.matrix?.generators?.[1]?.list?.elements ?? []
    expect(productElements.find((candidate) => candidate.name === 'olden')?.cascadeResourcesOnDeletion).toBe(true)
    expect(productApplicationSet.spec?.templatePatch).toContain('resources-finalizer.argocd.argoproj.io')
  })

  it('does not inspect local lab manifests for external source applications', () => {
    const metricsServerEntry = platformApplicationSet.match(
      /              - name: metrics-server[\s\S]*?(?=\n              - name:)/,
    )?.[0]

    expect(entry('metrics-server')).toMatchObject({
      class: 'external-source',
      repoURL: 'https://github.com/kubernetes-sigs/metrics-server.git',
      repoImages: [],
      hasHelmChart: false,
    })
    expect(metricsServerEntry).toContain('targetRevision: v0.9.0')
    expect(entry('home-root')).toMatchObject({
      class: 'external-source',
      repoURL: 'git@github.com:gregkonush/home.git',
      sourceKind: 'direct-application',
      repoImages: [],
      hasHelmChart: false,
    })
  })

  it('pins the identity and metrics controller upgrade wave', () => {
    expect(certManagerKustomization).toContain('version: v1.21.1')
    expect(externalSecretsKustomization).toContain('version: 2.8.0')
    expect(platformApplicationSet).toContain('targetRevision: v0.9.0')
  })

  it('keeps database-critical Barman Cloud reconciliation manual', () => {
    const cloudNativePgEntry = platformApplicationSet.match(
      /              - name: cloudnative-pg\n[\s\S]*?(?=\n              - name:)/,
    )?.[0]

    expect(cloudNativePgEntry).toContain('automation: manual')
    expect(cloudNativePgEntry).not.toContain('automation: auto')
  })

  it('keeps network-critical MetalLB reconciliation manual', () => {
    const metallbEntry = bootstrapApplicationSet.match(
      /                - name: metallb-system\n[\s\S]*?(?=\n                - name:)/,
    )?.[0]

    expect(metallbEntry).toContain('automation: manual')
    expect(metallbEntry).not.toContain('automation: auto')
    expect(metallbEntry).toContain('argocd.argoproj.io/sync-options: Prune=false')
  })

  it('pins MetalLB to immutable 0.16.1 images without rendering its Namespace', () => {
    expect(metallbKustomization.resources).toContain('github.com/metallb/metallb//config/native?ref=v0.16.1')
    expect(metallbKustomization.images).toEqual([
      {
        name: 'quay.io/metallb/controller',
        newName: 'quay.io/metallb/controller',
        newTag: 'v0.16.1',
        digest: 'sha256:f51ab515de9ccd20dc3dccb093e48df8adddac019326c456f449e55ba91b6420',
      },
      {
        name: 'quay.io/metallb/speaker',
        newName: 'quay.io/metallb/speaker',
        newTag: 'v0.16.1',
        digest: 'sha256:16561e96531e1852d5c229ad7fae6e994dcfa983ff7f4de6b6208b34a4e2ddbc',
      },
    ])
    expect(
      metallbKustomization.patches?.find(
        (patch) => patch.target?.kind === 'Namespace' && patch.target.name === 'metallb-system',
      )?.patch,
    ).toContain('$patch: delete')
  })

  it('pins the Argo control-plane upgrade wave and applies its large CRD server-side', () => {
    expect(argoCdKustomization).toContain('argo-cd/v3.4.6/manifests/ha/install.yaml')
    expect(argoCdKustomization).toContain('argocd-image-updater/v1.2.2/config/install.yaml')
    expect(argoCdLovelyPluginOverlay).toContain('ghcr.io/crumbhole/lovely:1.2.5')
    expect(argoCdApplicationSetCrdOverlay).toContain(
      'argocd.argoproj.io/sync-options: ServerSideApply=true,Prune=false',
    )
    expect(argoCdApplicationSetCrdOverlay).not.toContain('Replace=true')
    expect(bootstrapApplicationSet).toContain('ServerSideApply=true')
    expect(bootstrapApplicationSet).not.toContain('ClientSideApplyMigration=false')
  })

  it('pins the virtualization controllers and Knative operator upgrade wave', () => {
    const knativeEntry = platformApplicationSet.match(
      /              - name: knative\n[\s\S]*?(?=\n              - name:)/,
    )?.[0]

    expect(kubeVirtKustomization).toContain('kubevirt/releases/download/v1.9.0/')
    expect(kubeVirtKustomization).not.toContain('MultiArchitecture')
    expect(cdiKustomization).toContain('containerized-data-importer/releases/download/v1.66.0/')
    expect(knativeKustomization).toContain('knative/operator/releases/download/knative-v1.23.0/operator.yaml')
    expect(knativeKustomization).toContain('$patch: delete')
    expect(knativeKustomization).not.toContain('argocd.argoproj.io/sync-options: Prune=false')
    expect(knativeServingManifest).toContain('version: 1.23.0')
    expect(knativeEventingManifest).toContain('version: 1.23.0')
    expect(knativeEventingKustomization).toContain('eventing-kafka-controller.yaml')
    expect(knativeEventingKustomization).toContain('eventing-kafka-source.yaml')
    expect(knativeEventingKustomization).toContain('knative-v1.23.0')
    expect(knativeEventingKustomization).not.toContain('patchesStrategicMerge')
    expect(knativeEntry).toContain('app.kubernetes.io/managed-by: argocd')
    expect(knativeEntry).not.toContain('argocd.argoproj.io/sync-options: Prune=false')
    expect(knativeEntry).not.toContain('argocd.argoproj.io/tracking-id')
  })

  it('pins the enabled observability collector upgrade wave', () => {
    for (const deploymentPath of enabledAlloyDeploymentPaths) {
      expect(readFileSync(deploymentPath, 'utf8')).toContain('grafana/alloy:v1.18.1')
    }
    expect(readFileSync('argocd/applications/buzz/alloy-deployment.yaml', 'utf8')).toContain(
      'sha256:0f4434c92b3e6cdac38bb129b344e1790c246f7b6e2eaffcc16a5fa363240e33',
    )
    expect(natsKustomization).toContain('newTag: v1.18.1')
    expect(observabilityKustomization).toContain('version: 8.2.0')
  })

  it('pins the enabled service image upgrade wave', () => {
    expect(featureFlagsKustomization).toContain('version: 2.11.0')
    expect(featureFlagsKustomization).toContain('newTag: v2.11.0')
    expect(featureFlagsKustomization).toContain(
      'digest: sha256:d20384874048ef6ac326f4937cee64f1db175a1878a87db32916cc8db46c740e',
    )
    expect(cloudflaredDeployment).toContain(
      'cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf',
    )
    expect(karapaceManifest).toContain(
      'ghcr.io/aiven-open/karapace:6.2.2@sha256:3c202789067f1bc3aa68d9dbb22d6298d254380a9e69c2705120c7434277238c',
    )
    expect(karapaceManifest).toContain('app.proompteng.ai/schema-storage-generation: compact-v1')
  })

  it('retains Karapace schemas in a managed compacted topic', () => {
    const schemasTopic = karapaceResources.find(
      (resource) => resource.apiVersion === 'kafka.strimzi.io/v1' && resource.kind === 'KafkaTopic',
    )

    expect(schemasTopic).toMatchObject({
      metadata: {
        name: 'karapace-schemas',
        namespace: 'kafka',
        annotations: { 'argocd.argoproj.io/sync-options': 'Prune=false,Delete=false' },
        labels: { 'strimzi.io/cluster': 'kafka' },
      },
      spec: {
        topicName: '_schemas',
        partitions: 1,
        replicas: 3,
        config: { 'cleanup.policy': 'compact' },
      },
    })
  })

  it('pins the Temporal patch wave to immutable multi-architecture images', () => {
    expect(temporalKustomization.helmCharts?.find((chart) => chart.name === 'temporal')).toMatchObject({
      version: '1.6.0',
    })
    expect(temporalKustomization.images).toEqual([
      {
        name: 'mirror.gcr.io/temporalio/server',
        newName: 'mirror.gcr.io/temporalio/server',
        newTag: '1.31.2',
        digest: 'sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da',
      },
      {
        name: 'mirror.gcr.io/temporalio/admin-tools',
        newName: 'mirror.gcr.io/temporalio/admin-tools',
        newTag: '1.31.2',
        digest: 'sha256:dbc5fcd6ee8f0f4d808bf765af9a87dea9d8a283abfdcfbd2fc148496ba66107',
      },
      {
        name: 'mirror.gcr.io/temporalio/ui',
        newName: 'mirror.gcr.io/temporalio/ui',
        newTag: '2.52.0',
        digest: 'sha256:fc47cd8202c98ed868745fd9f2f011585232676d08da621b9a6d7bc4653c17aa',
      },
    ])
  })

  it('pins the Open WebUI migration wave to its immutable image', () => {
    expect(jangarKustomization.helmCharts?.find((chart) => chart.name === 'open-webui')).toMatchObject({
      version: '16.0.0',
    })
    expect(jangarKustomization.images?.find((image) => image.name === 'ghcr.io/open-webui/open-webui')).toEqual({
      name: 'ghcr.io/open-webui/open-webui',
      newTag: 'v0.11.0',
      digest: 'sha256:72c0ba641ba75e7aa52655cb242570906ececd09b1140fb736483038a22b3228',
    })
    expect(openWebUIValues.image?.tag).toBe('v0.11.0')
  })

  it('pins both Saigak Ollama containers to the immutable multi-architecture image', () => {
    const podSpec = saigakStatefulSet.spec?.template?.spec
    const ollamaImages = [...(podSpec?.initContainers ?? []), ...(podSpec?.containers ?? [])]
      .filter((container) => container.name === 'model-init' || container.name === 'ollama')
      .map((container) => container.image)

    expect(ollamaImages).toEqual([
      'ollama/ollama:0.32.6@sha256:b88c73ace3e115f8ec53dc8761ae1c0aabfa675406e3681786b98757ce050f42',
      'ollama/ollama:0.32.6@sha256:b88c73ace3e115f8ec53dc8761ae1c0aabfa675406e3681786b98757ce050f42',
    ])
  })

  it('pins Flamingo vLLM to the immutable Blackwell image', () => {
    const vllm = flamingoDeployment.spec?.template?.spec?.containers?.find((container) => container.name === 'vllm')

    expect(vllm?.image).toBe(
      'vllm/vllm-openai:v0.26.0-x86_64-cu129@sha256:3c5c53248febaa72823a4b7e51aafa1cd2b65d860392e3930414da4d3864f541',
    )
  })

  it('pins Keycloak to the immutable multi-architecture security release', () => {
    expect(keycloakManifest).toContain(
      'quay.io/keycloak/keycloak:26.7.1@sha256:f1f1f01e472c8a78df40d8f2a49a925274eda4d3d80d5f6edbb5c880ee3c01c6',
    )
  })

  it('pins Coder to the immutable multi-architecture stable release', () => {
    expect(coderChart).toMatchObject({
      appVersion: '2.35.3',
      version: '2.35.3',
    })
    expect(coderChart.dependencies?.find((dependency) => dependency.name === 'coder')?.version).toBe('2.35.3')
    expect(coderValues.coder?.coder).toMatchObject({
      replicaCount: 1,
      image: {
        tag: 'v2.35.3@sha256:8e34e774ebde1813f03294498374cd955264eee6cd2b61a72baf7634a0ca7de4',
      },
    })
  })

  it('pins Local Path Provisioner and its helper to immutable security releases', () => {
    expect(localPathKustomization.resources).toContain('github.com/rancher/local-path-provisioner/deploy?ref=v0.0.37')
    expect(localPathKustomization.images?.find((image) => image.name === 'rancher/local-path-provisioner')).toEqual({
      name: 'rancher/local-path-provisioner',
      newName: 'docker.io/rancher/local-path-provisioner',
      newTag: 'v0.0.37',
      digest: 'sha256:e757967a5ec338f6a9b371c5a9688bedaa8c3578ea3dd4db329ea0084be0a86f',
    })
    expect(localPathConfigPatch).toContain(
      'docker.io/library/busybox:1.38.0@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616',
    )
  })

  it('pins both custom NVIDIA device plugins to the immutable security release', () => {
    for (const manifest of nvidiaDevicePluginManifests) {
      expect(manifest).toContain(
        'nvcr.io/nvidia/k8s-device-plugin:v0.19.3@sha256:25cc340fe6fd53c101e16fc452f503e7a92c219c64a80ed5381784b522dbbf77',
      )
      expect(manifest).not.toContain('nvcr.io/nvidia/k8s-device-plugin:v0.19.0')
    }
  })

  it('keeps chart-only apps out of Nix image migration state', () => {
    for (const name of ['temporal', 'observability', 'nats', 'kafka', 'traefik', 'tailscale', 'cert-manager']) {
      expect(entry(name)).toMatchObject({
        class: 'helm-chart',
        hasHelmChart: true,
        repoImages: [],
      })
      expect(entry(name).nixImageAttr).toBeUndefined()
      expect(entry(name).buildScriptPath).toBeUndefined()
    }
  })

  it('does not hide repo-owned Helm image overrides as chart-only apps', () => {
    expect(entry('headlamp')).toMatchObject({
      class: 'nix-image',
      hasHelmChart: true,
      repoImages: [expect.stringMatching(/^registry\.ide-newton\.ts\.net\/lab\/headlamp@sha256:[0-9a-f]{64}$/)],
      nixImageAttr: 'headlamp-image',
      buildScriptPath: 'packages/scripts/src/headlamp/build-image.ts',
      deployScriptPath: 'packages/scripts/src/headlamp/deploy-service.ts',
    })
    expect(entry('headlamp').workflowPaths).toContain('.github/workflows/headlamp-ci.yml')
  })

  it('preserves sibling digest pins for Helm values and Kustomize images', () => {
    expect(entry('app').repoImages).toEqual([
      expect.stringMatching(/^registry\.ide-newton\.ts\.net\/lab\/app@sha256:[0-9a-f]{64}$/),
    ])
    expect(entry('agents').repoImages).toEqual([
      expect.stringMatching(/^registry\.ide-newton\.ts\.net\/lab\/agents-codex-runner@sha256:[0-9a-f]{64}$/),
      expect.stringMatching(/^registry\.ide-newton\.ts\.net\/lab\/agents-control-plane@sha256:[0-9a-f]{64}$/),
      expect.stringMatching(/^registry\.ide-newton\.ts\.net\/lab\/agents-controller@sha256:[0-9a-f]{64}$/),
      expect.stringMatching(/^registry\.ide-newton\.ts\.net\/lab\/agents-shell@sha256:[0-9a-f]{64}$/),
      expect.stringMatching(/^registry\.ide-newton\.ts\.net\/lab\/anypi:[^@]+@sha256:[0-9a-f]{64}$/),
    ])
  })

  it('marks only approved early build-owning apps as Nix image candidates', () => {
    for (const name of [
      'oirat',
      'agents',
      'arc',
      'bumba',
      'froussard',
      'headlamp',
      'docs',
      'app',
      'proompteng',
      'synthesis',
      'attic',
      'symphony',
      'symphony-jangar',
      'symphony-torghut',
      'jangar',
      'torghut',
      'torghut-hyperliquid-feed',
      'torghut-hyperliquid-runtime',
      'torghut-options',
    ]) {
      expect(entry(name).class).toBe('nix-image')
      expect(entry(name).repoImages.length).toBeGreaterThan(0)
    }
  })

  it('marks migrated enabled app waves with concrete Nix attrs', () => {
    expect(entry('oirat').nixImageAttr).toBe('oirat-image')
    expect(entry('bumba').nixImageAttr).toBe('bumba-image')
    expect(entry('froussard').nixImageAttr).toBe('froussard-image')
    expect(entry('headlamp').nixImageAttr).toBe('headlamp-image')
    expect(entry('docs').nixImageAttr).toBe('docs-image')
    expect(entry('app').nixImageAttr).toBe('app-image')
    expect(entry('proompteng').nixImageAttr).toBe('proompteng-image')
    expect(entry('synthesis').nixImageAttr).toBe('synthesis-image')
    expect(entry('agents').nixImageAttr).toBe('agents-codex-runner-image')
    expect(entry('arc').nixImageAttr).toBe('arc-runner-image')
    expect(entry('symphony').nixImageAttr).toBe('symphony-image')
    expect(entry('symphony-jangar').nixImageAttr).toBe('symphony-image')
    expect(entry('symphony-torghut').nixImageAttr).toBe('symphony-image')
    expect(entry('jangar').nixImageAttr).toBe('jangar-image')
    expect(entry('torghut').nixImageAttr).toBe('torghut-image')
    expect(entry('torghut-hyperliquid-feed').nixImageAttr).toBe('torghut-hyperliquid-feed-image')
    expect(entry('torghut-hyperliquid-runtime').nixImageAttr).toBe('torghut-image')
    expect(entry('torghut-options').nixImageAttr).toBe('torghut-image')
  })

  it('tracks the live Attic image through both GitHub Actions and manual deploy paths', () => {
    expect(entry('attic')).toMatchObject({
      class: 'nix-image',
      nixImageAttr: 'atticd-image',
      buildScriptPath: 'packages/scripts/src/attic/build-image.ts',
      deployScriptPath: 'packages/scripts/src/attic/deploy-service.ts',
    })
    expect(entry('attic').workflowPaths).toContain('.github/workflows/attic-build-push.yaml')
  })

  it('tracks ARC runner images through both GitHub Actions and manual Nix image paths', () => {
    expect(entry('arc')).toMatchObject({
      class: 'nix-image',
      nixImageAttr: 'arc-runner-image',
      buildScriptPath: 'packages/scripts/src/arc-runner/build-image.ts',
      deployScriptPath: 'packages/scripts/src/arc-runner/deploy-service.ts',
    })
    expect(entry('arc').workflowPaths).toContain('.github/workflows/arc-runner-build-push.yml')
  })

  it('tracks Froussard through both GitHub Actions and manual Nix image paths', () => {
    expect(entry('froussard')).toMatchObject({
      class: 'nix-image',
      nixImageAttr: 'froussard-image',
      buildScriptPath: 'packages/scripts/src/froussard/build-image.ts',
      deployScriptPath: 'packages/scripts/src/froussard/deploy-service.ts',
    })
    expect(entry('froussard').workflowPaths).toContain('.github/workflows/froussard-ci.yml')
  })

  it('tracks Jangar through both GitHub Actions and manual Nix image paths', () => {
    expect(entry('jangar')).toMatchObject({
      class: 'nix-image',
      nixImageAttr: 'jangar-image',
      buildScriptPath: 'packages/scripts/src/jangar/build-image.ts',
      deployScriptPath: 'packages/scripts/src/jangar/deploy-service.ts',
    })
    expect(entry('jangar').workflowPaths).toContain('.github/workflows/jangar-build-push.yaml')
  })

  it('tracks Symphony derivative apps through the shared Symphony Nix image path', () => {
    for (const name of ['symphony-jangar', 'symphony-torghut']) {
      expect(entry(name)).toMatchObject({
        class: 'nix-image',
        nixImageAttr: 'symphony-image',
        buildScriptPath: 'packages/scripts/src/symphony/build-image.ts',
        deployScriptPath: 'packages/scripts/src/symphony/deploy-service.ts',
      })
      expect(entry(name).workflowPaths).toContain('.github/workflows/symphony-build-push.yaml')
      expect(entry(name).deferredReason).toBeUndefined()
    }
  })

  it('tracks Torghut-family enabled apps through explicit Nix image ownership paths', () => {
    expect(entry('torghut-hyperliquid-feed')).toMatchObject({
      class: 'nix-image',
      nixImageAttr: 'torghut-hyperliquid-feed-image',
      buildScriptPath: 'packages/scripts/src/torghut/build-hyperliquid-feed-image.ts',
      deployScriptPath: 'packages/scripts/src/torghut/update-hyperliquid-feed-manifest.ts',
    })
    expect(entry('torghut-hyperliquid-feed').workflowPaths).toContain(
      '.github/workflows/torghut-hyperliquid-feed-build-push.yaml',
    )

    expect(entry('torghut-hyperliquid-runtime')).toMatchObject({
      class: 'nix-image',
      nixImageAttr: 'torghut-image',
      buildScriptPath: 'packages/scripts/src/torghut/build-image.ts',
      deployScriptPath: 'packages/scripts/src/torghut/update-manifests.ts',
    })
    expect(entry('torghut-hyperliquid-runtime').workflowPaths).toContain('.github/workflows/torghut-build-push.yaml')

    expect(entry('torghut-options')).toMatchObject({
      class: 'nix-image',
      nixImageAttr: 'torghut-image',
      buildScriptPath: 'packages/scripts/src/torghut/build-image.ts',
      deployScriptPath: 'packages/scripts/src/torghut/update-manifests.ts',
    })
    expect(entry('torghut-options').workflowPaths).toContain('.github/workflows/torghut-build-push.yaml')
    expect(entry('torghut-options').workflowPaths).toContain('.github/workflows/torghut-ws-build-push.yaml')
    expect(entry('torghut-options').workflowPaths).toContain('.github/workflows/torghut-ta-build-push.yaml')
  })

  it('keeps repo-image apps without local build ownership out of Nix migration state', () => {
    for (const name of ['analysis', 'bilig', 'buzz', 'hermes', 'tigresse']) {
      expect(entry(name).class).toBe('vendor-manifest')
      expect(entry(name).repoImages.length).toBeGreaterThan(0)
      expect(entry(name).buildScriptPath).toBeUndefined()
      expect(entry(name).deployScriptPath).toBeUndefined()
      expect(entry(name).nixImageAttr).toBeUndefined()
      expect(entry(name).deferredReason).toBeTruthy()
    }
  })

  it('tracks Buzz as a reviewed upstream derivative, not an in-repo Nix image gap', () => {
    expect(entry('buzz')).toMatchObject({
      class: 'vendor-manifest',
      hasHelmChart: true,
      repoImages: [
        'registry.ide-newton.ts.net/lab/buzz@sha256:16d08bf8e2772a93924de1a49746a034d3410387d6095b214ed2e798aa7d6cfb',
      ],
      workflowPaths: ['.github/workflows/buzz-relay-build-push.yml'],
    })
    expect(entry('buzz').deferredReason).toContain('block/buzz')
  })

  it('tracks Hermes as a reviewed upstream mirror, not an in-repo image build gap', () => {
    expect(entry('hermes')).toMatchObject({
      class: 'vendor-manifest',
      hasHelmChart: false,
      repoImages: [
        'registry.ide-newton.ts.net/lab/hermes-agent@sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a',
      ],
    })
    expect(entry('hermes').deferredReason).toContain('NousResearch/hermes-agent')
  })

  it('tracks Tigresse as a vendored external-operator chart, not an in-repo image build gap', () => {
    expect(entry('tigresse')).toMatchObject({
      class: 'vendor-manifest',
      hasHelmChart: true,
      repoImages: [
        'registry.ide-newton.ts.net/lab/tigresse@sha256:b04308528a46291e2c65562d04c2ac7644c4e7f25f2c247dae282b70f8856e2c',
      ],
    })
    expect(entry('tigresse').deferredReason).toContain('proompteng/tigresse')
  })

  it('passes the no-build-for-chart-and-vendor guardrail', () => {
    expect(() => assertEnabledAppBuildPolicy(inventory)).not.toThrow()
  })
})
