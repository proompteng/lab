import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

import {
  assertEnabledAppBuildPolicy,
  classifyEnabledApp,
  type EnabledAppInventoryEntry,
  loadEnabledAppInventory,
} from '../enabled-apps'

const inventory = loadEnabledAppInventory()
const platformApplicationSet = readFileSync('argocd/applicationsets/platform.yaml', 'utf8')
const bootstrapApplicationSet = readFileSync('argocd/applicationsets/bootstrap.yaml', 'utf8')
const applicationSetsReadme = readFileSync('argocd/applicationsets/README.md', 'utf8')
const argoCdKustomization = readFileSync('argocd/applications/argocd/kustomization.yaml', 'utf8')
const argoCdReadme = readFileSync('argocd/applications/argocd/README.md', 'utf8')
const argoCdApplicationSetCrdOverlay = readFileSync(
  'argocd/applications/argocd/overlays/argocd-applicationset-crd.yaml',
  'utf8',
)
const argoCdLovelyPluginOverlay = readFileSync('argocd/applications/argocd/overlays/argocd-lovely-plugin.yaml', 'utf8')
const certManagerKustomization = readFileSync('argocd/applications/cert-manager/kustomization.yaml', 'utf8')
const externalSecretsKustomization = readFileSync('argocd/applications/external-secrets/kustomization.yaml', 'utf8')
const kataKustomization = YAML.parse(readFileSync('argocd/applications/kata/kustomization.yaml', 'utf8')) as {
  resources?: string[]
}
const kataReadme = readFileSync('argocd/applications/kata/README.md', 'utf8')
const kataRuntimeVerifier = readFileSync('devices/galactic/extensions/kata/verify-runtimes.sh', 'utf8')
const talosUpgradeRunbook = readFileSync('docs/runbooks/talos-latest-upgrade-plan.md', 'utf8')
const tengriOperations = readFileSync('docs/tengri/operations.md', 'utf8')
const tengriImagesWorkflow = readFileSync('.github/workflows/tengri-images.yml', 'utf8')
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
  it('classifies Tengri as a Kargo-owned workflow image only with complete ownership evidence', () => {
    const tengri = {
      name: 'tengri',
      path: 'argocd/applications/tengri',
      repoURL: 'https://github.com/proompteng/lab.git',
      sourceFile: 'argocd/applicationsets/platform.yaml',
      sourceKind: 'applicationset-element',
      class: 'deferred',
      enabled: true,
      hasHelmChart: false,
      repoImages: [
        'registry.ide-newton.ts.net/lab/nanoagent@sha256:' + 'b'.repeat(64),
        'registry.ide-newton.ts.net/lab/tengri@sha256:' + 'a'.repeat(64),
      ],
      workflowPaths: ['.github/workflows/tengri-images.yml', 'argocd/applications/kargo'],
    } satisfies EnabledAppInventoryEntry

    expect(classifyEnabledApp(tengri)).toMatchObject({
      class: 'workflow-image',
      deferredReason: expect.stringContaining('promoted automatically by Kargo'),
    })
    for (const repository of tengri.repoImages) {
      expect(
        classifyEnabledApp({ ...tengri, repoImages: tengri.repoImages.filter((value) => value !== repository) }).class,
      ).toBe('deferred')
    }
    for (const workflowPath of tengri.workflowPaths) {
      expect(
        classifyEnabledApp({
          ...tengri,
          workflowPaths: tengri.workflowPaths.filter((value) => value !== workflowPath),
        }).class,
      ).toBe('deferred')
    }
    for (const validReference of tengri.repoImages) {
      const repository = validReference.split('@')[0]
      for (const invalidReference of [
        `${repository}:latest`,
        `${repository}@sha256:bad`,
        `${repository}@sha256:${'0'.repeat(64)}`,
      ]) {
        const repoImages = tengri.repoImages.map((reference) =>
          reference === validReference ? invalidReference : reference,
        )
        expect(classifyEnabledApp({ ...tengri, repoImages }).class).toBe('deferred')
      }
    }
    const expectIncompleteOwnership = (entry: EnabledAppInventoryEntry) => {
      expect(() =>
        assertEnabledAppBuildPolicy({
          entries: [entry],
          applicationSetEntryCount: 1,
          directApplicationCount: 0,
        }),
      ).toThrow('incomplete Kargo ownership')
    }
    expectIncompleteOwnership({ ...tengri, class: 'workflow-image', repoImages: [tengri.repoImages[0]] })
    expectIncompleteOwnership({
      ...tengri,
      class: 'workflow-image',
      repoImages: [tengri.repoImages[0], 'registry.ide-newton.ts.net/lab/tengri@sha256:' + '0'.repeat(64)],
    })
    expectIncompleteOwnership({ ...tengri, class: 'workflow-image', workflowPaths: [tengri.workflowPaths[0]] })
    expectIncompleteOwnership({ ...tengri, class: 'workflow-image', nixImageAttr: 'tengri-image' })
  })

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
    expect(externalSecretsKustomization).toContain('version: 2.10.0')
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

  it('preserves Tengri state and keeps Kata runtime proof bounded', () => {
    const tengriEntry = platformApplicationSet.match(
      /              - name: tengri\n[\s\S]*?(?=\n              - name:)/,
    )?.[0]

    expect(tengriEntry).toContain('argocd.argoproj.io/sync-options: Prune=false,Delete=false')
    expect(kataKustomization.resources).toEqual(['runtime-class.yaml'])
    expect(kataReadme).toContain('must not render a `Namespace` object or permanent runtime canary workloads')
    expect(kataReadme).toContain('bounded acceptance operation')
    expect(kataRuntimeVerifier).toMatch(/readonly NANOAGENT_IMAGE='[^']+@sha256:[a-f0-9]{64}'/)
    expect(kataRuntimeVerifier).toContain('kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" create -f -')
    expect(kataRuntimeVerifier).toContain('runtimeClassName: ${runtime_class}')
    expect(kataRuntimeVerifier).toContain('activeDeadlineSeconds: 900')
    expect(kataRuntimeVerifier).toContain('kubernetes.io/hostname: ${node}')
    expect(kataRuntimeVerifier).toContain('trap cleanup_active_resources EXIT')
    expect(kataRuntimeVerifier).toContain('delete_active_resources >"$node_dir/$vmm-cleanup.txt"')
    expect(kataRuntimeVerifier).not.toContain('daemonset_for_vmm')
    expect(talosUpgradeRunbook).toContain(
      'The bounded verifier Pod supplies the built-in unschedulable-taint toleration',
    )
    expect(talosUpgradeRunbook).not.toContain('The canaries are DaemonSets')
    expect(talosUpgradeRunbook).toContain('It deletes that Pod and its')
    expect(talosUpgradeRunbook).toContain('unique bootstrap Secret on success or failure')
    expect(tengriOperations).toContain('`Tengri images` validates both services and CRDs')
    expect(tengriOperations).toContain('emits the `kargo-sha-<40>` aliases')
    expect(tengriOperations).toContain('argocd app sync kata --prune')
    expect(tengriOperations).toContain('kubectl --context galactic-lan -n kata get daemonset -o name')
    expect(tengriOperations).toContain('verify-runtimes.sh "$PROOF_DIR" talos-192-168-1-194 fc')
    expect(tengriOperations).not.toContain('`Manual OCI Mirror`')
    expect(tengriImagesWorkflow).toContain('TENGRI_IMAGE: registry.ide-newton.ts.net/lab/tengri')
    expect(tengriImagesWorkflow).toContain('runner: arc-amd64')
    expect(tengriImagesWorkflow).toContain('runner: arc-arm64')
    expect(tengriImagesWorkflow).toContain('docker buildx imagetools create')
    expect(tengriImagesWorkflow).toContain('cosign sign --yes "${reference}"')
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
    expect(argoCdKustomization).toContain('argo-cd/v3.5.2/manifests/ha/install.yaml')
    expect(argoCdKustomization).not.toContain('argo-cd/v3.4.6/')
    expect(applicationSetsReadme.split('argo-cd/v3.5.2/manifests/crds/applicationset-crd.yaml')).toHaveLength(3)
    expect(applicationSetsReadme).not.toContain('argo-cd/v3.4.6/')
    expect(argoCdReadme).toContain('## Argo CD v3.5.2 upgrade')
    expect(argoCdReadme).toContain('argocd login argocd.proompteng.ai --username admin --grpc-web')
    expect(argoCdReadme).not.toContain('argocd login argocd.proompteng.ai --sso')
    expect(argoCdReadme).toContain('kargo login https://kargo.ide-newton.ts.net --sso')
    expect(argoCdReadme).toContain('first normal Kargo promotion')
    expect(argoCdKustomization).not.toContain('argocd-image-updater')
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
    expect(cdiKustomization).toContain('containerized-data-importer/releases/download/v1.66.1/')
    expect(knativeKustomization).toContain('knative/operator/releases/download/knative-v1.23.1/operator.yaml')
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
      expect(readFileSync(deploymentPath, 'utf8')).toContain('grafana/alloy:v1.19.2')
    }
    expect(readFileSync('argocd/applications/buzz/alloy-deployment.yaml', 'utf8')).toContain(
      'sha256:b8ec653c44235fbe910879145dac3597d66b0aaecf60bcbbe82580767771a839',
    )
    expect(natsKustomization).toContain('newTag: v1.19.2')
    expect(observabilityKustomization).toContain('version: 8.4.2')
  })

  it('pins the enabled service image upgrade wave', () => {
    expect(featureFlagsKustomization).toContain('version: 2.12.1')
    expect(featureFlagsKustomization).toContain('newTag: v2.12.0')
    expect(featureFlagsKustomization).toContain(
      'digest: sha256:92a091b047658b14f1e3214727c6e3001063226a33cb2fc824a1733a60401e05',
    )
    expect(cloudflaredDeployment).toContain(
      'cloudflare/cloudflared:2026.8.3@sha256:51c9cefcb4569df44e1ad403ab1d3d8065aa8e84339bcfc6aee75502e1140339',
    )
    expect(karapaceManifest).toContain(
      'ghcr.io/aiven-open/karapace:6.2.3@sha256:a67ecdcc7c0d0a9e965d7a0eebea91a46bf6797aad4f3b878a3f6924650f3012',
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

  it('pins the Temporal upgrade wave to immutable multi-architecture images', () => {
    expect(temporalKustomization.helmCharts?.find((chart) => chart.name === 'temporal')).toMatchObject({
      version: '1.6.0',
    })
    expect(temporalKustomization.images).toEqual([
      {
        name: 'docker.elastic.co/elasticsearch/elasticsearch',
        newTag: '8.19.21',
        digest: 'sha256:cbf5cd6cfe5532a9c02d510c66d238bf329cd51fe3d57170a2a880aca7d47419',
      },
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
        newTag: '2.53.3',
        digest: 'sha256:eef301146e60fad34b47adaecfae4149016e34b2d44ba94fca5fd8e5441f182a',
      },
    ])
  })

  it('pins the Open WebUI migration wave to its immutable image', () => {
    expect(jangarKustomization.helmCharts?.find((chart) => chart.name === 'open-webui')).toMatchObject({
      version: '16.5.0',
    })
    expect(jangarKustomization.images?.find((image) => image.name === 'ghcr.io/open-webui/open-webui')).toEqual({
      name: 'ghcr.io/open-webui/open-webui',
      newTag: 'v0.11.3',
      digest: 'sha256:41daa0cf2561a5d4c8d1ff31ee2a98d93ab4d3ac2605cac69366ff6a3374a933',
    })
    expect(openWebUIValues.image?.tag).toBe('v0.11.3')
  })

  it('pins both Saigak Ollama containers to the immutable multi-architecture image', () => {
    const podSpec = saigakStatefulSet.spec?.template?.spec
    const ollamaImages = [...(podSpec?.initContainers ?? []), ...(podSpec?.containers ?? [])]
      .filter((container) => container.name === 'model-init' || container.name === 'ollama')
      .map((container) => container.image)

    expect(ollamaImages).toEqual([
      'ollama/ollama:0.33.3@sha256:32931b46719f673c05fdbaa81ccb26da18ea4a1c57590a754874ab28ba269eb2',
      'ollama/ollama:0.33.3@sha256:32931b46719f673c05fdbaa81ccb26da18ea4a1c57590a754874ab28ba269eb2',
    ])
  })

  it('pins Flamingo vLLM to the immutable Blackwell image', () => {
    const vllm = flamingoDeployment.spec?.template?.spec?.containers?.find((container) => container.name === 'vllm')

    expect(vllm?.image).toBe(
      'vllm/vllm-openai:v0.29.0-cu129@sha256:7ef5a35d1ef8ce2cf9d671dd91eec6e367c5849262e0362b4d3d4a26be0d87d2',
    )
  })

  it('pins Keycloak to the immutable multi-architecture security release', () => {
    expect(keycloakManifest).toContain(
      'quay.io/keycloak/keycloak:26.7.3@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54',
    )
  })

  it('pins Coder to the immutable multi-architecture stable release', () => {
    expect(coderChart).toMatchObject({
      appVersion: '2.36.4',
      version: '2.36.4',
    })
    expect(coderChart.dependencies?.find((dependency) => dependency.name === 'coder')?.version).toBe('2.36.4')
    expect(coderValues.coder?.coder).toMatchObject({
      replicaCount: 1,
      image: {
        tag: 'v2.36.4@sha256:85e6d04d33ed4184ca689d6b736e305cc73eb8588e56657f6457835788092d6d',
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
      'jangar',
      'torghut',
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
    expect(entry('jangar').nixImageAttr).toBe('jangar-image')
    expect(entry('torghut').nixImageAttr).toBe('torghut-image')
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

  it('tracks the Symphony Jangar derivative through the shared Symphony Nix image path', () => {
    expect(entry('symphony-jangar')).toMatchObject({
      class: 'nix-image',
      nixImageAttr: 'symphony-image',
      buildScriptPath: 'packages/scripts/src/symphony/build-image.ts',
      deployScriptPath: 'packages/scripts/src/symphony/deploy-service.ts',
    })
    expect(entry('symphony-jangar').workflowPaths).toContain('.github/workflows/symphony-build-push.yaml')
    expect(entry('symphony-jangar').deferredReason).toBeUndefined()
  })

  it('excludes retired Torghut applications from the enabled inventory', () => {
    for (const name of [
      'symphony-torghut',
      'torghut-options',
      'torghut-hyperliquid-feed',
      'torghut-hyperliquid-runtime',
    ]) {
      expect(inventory.entries.some((candidate) => candidate.name === name)).toBe(false)
    }
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
        'registry.ide-newton.ts.net/lab/hermes-agent@sha256:b3190406963c6b51ac955397ecef45346efaae9563ee305108f8eef0a77e267b',
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
