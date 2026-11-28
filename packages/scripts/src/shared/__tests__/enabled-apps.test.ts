import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  it('excludes unreferenced prepared directories and includes declared Kustomize inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'enabled-app-inputs-'))
    const app = join(root, 'argocd/applications/example')
    try {
      mkdirSync(join(root, 'argocd/applicationsets'), { recursive: true })
      for (const name of ['active', 'prepared', 'patches', 'values']) mkdirSync(join(app, name), { recursive: true })
      writeFileSync(
        join(root, 'argocd/applicationsets/test.yaml'),
        YAML.stringify({
          spec: { generators: [{ list: { elements: [{ name: 'example', path: 'argocd/applications/example' }] } }] },
        }),
      )
      const manifest = (name: string) => YAML.stringify({ image: `registry.ide-newton.ts.net/lab/${name}` })
      writeFileSync(join(app, 'active/deployment.yaml'), manifest('active'))
      writeFileSync(join(app, 'prepared/deployment.yaml'), manifest('prepared'))
      writeFileSync(join(app, 'patches/image.yaml'), manifest('patch'))
      writeFileSync(join(app, 'values/chart.yaml'), manifest('chart'))
      const input = {
        resources: ['active'],
        patches: [{ path: 'patches/image.yaml' }],
        helmCharts: [{ valuesFile: 'values/chart.yaml' }],
      }
      writeFileSync(join(app, 'kustomization.yaml'), YAML.stringify(input))
      expect(loadEnabledAppInventory(root).entries[0]?.repoImages).toEqual([
        'registry.ide-newton.ts.net/lab/active',
        'registry.ide-newton.ts.net/lab/chart',
        'registry.ide-newton.ts.net/lab/patch',
      ])
      writeFileSync(join(app, 'kustomization.yaml'), YAML.stringify({ ...input, resources: ['active', 'prepared'] }))
      expect(loadEnabledAppInventory(root).entries[0]?.repoImages).toContain('registry.ide-newton.ts.net/lab/prepared')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['devbox', 'codex-devbox', 'unpublished', '.github/workflows/codex-devbox.yml'],
    ['ofz', 'ofz', 'unpromoted', '.github/workflows/ofz.yaml'],
  ])(
    'recognizes the inert %s promotion template without accepting arbitrary mutable images',
    (name, image, tag, workflow) => {
      const repository = `registry.ide-newton.ts.net/lab/${image}`
      const template = {
        name,
        path: `argocd/applications/${name}`,
        repoURL: 'https://github.com/proompteng/lab.git',
        sourceFile: 'argocd/applicationsets/platform.yaml',
        sourceKind: 'applicationset-element',
        class: 'deferred',
        enabled: true,
        hasHelmChart: false,
        repoImages: [`${repository}:${tag}`],
        workflowPaths: [workflow, 'argocd/applications/kargo'],
      } satisfies EnabledAppInventoryEntry
      expect(classifyEnabledApp(template).class).toBe('workflow-image')
      expect(classifyEnabledApp({ ...template, workflowPaths: [] }).class).toBe('deferred')
      for (const reference of [
        `${repository}:latest`,
        `${repository}:unreviewed`,
        `${repository}@sha256:${'0'.repeat(64)}`,
      ]) {
        expect(
          classifyEnabledApp({
            ...template,
            repoImages: [reference],
          }).class,
        ).toBe('deferred')
      }
    },
  )

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
    expect(inventory.directApplicationCount).toBe(2)
    expect(
      inventory.entries
        .filter((candidate) => candidate.sourceKind === 'direct-application')
        .map((candidate) => candidate.name)
        .sort(),
    ).toEqual(['agents-workspace', 'home-root'])
    expect(entry('agents-workspace')).toMatchObject({
      class: 'vendor-manifest',
      sourceKind: 'direct-application',
      sourceFile: 'argocd/applicationsets/agents-workspace.yaml',
      path: 'argocd/applications/agents-workspace',
      repoImages: [],
      hasHelmChart: false,
      workflowPaths: [],
    })
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
    expect(metricsServerEntry).toContain('targetRevision: v0.9.1')
    expect(entry('home-root')).toMatchObject({
      class: 'external-source',
      repoURL: 'git@github.com:gregkonush/home.git',
      sourceKind: 'direct-application',
      repoImages: [],
      hasHelmChart: false,
    })
  })

  it('pins the identity and metrics controller upgrade wave', () => {
    expect(certManagerKustomization).toContain('version: v1.21.3')
    expect(externalSecretsKustomization).toContain('version: 2.15.0')
    expect(platformApplicationSet).toContain('targetRevision: v0.9.1')
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

  it('preserves Tengri state and keeps runtime validation isolated', () => {
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
    expect(tengriOperations).toContain('The paired publisher must withhold discoverable aliases')
    expect(tengriOperations).toContain('and KVM acceptance pass')
    expect(tengriOperations).toContain(
      'Never drain, cordon, reboot, relabel, change scheduling on, or reconfigure shared nodes',
    )
    expect(tengriOperations).toContain('private container and volumes')
    expect(tengriOperations).toContain('Measure at least 50 fresh prepared creations and 50 cold-cache resumes')
    expect(tengriOperations).not.toContain('`Manual OCI Mirror`')
    expect(tengriImagesWorkflow).toContain('TENGRI_IMAGE: registry.ide-newton.ts.net/lab/tengri')
    expect(tengriImagesWorkflow).toContain('docker buildx imagetools create')
    expect(tengriImagesWorkflow).toContain('cosign sign --yes "${reference}"')
  })

  it('pins MetalLB to immutable 0.16.1 images without rendering its Namespace', () => {
    expect(metallbKustomization.resources).toContain('github.com/metallb/metallb//config/native?ref=v0.16.2')
    expect(metallbKustomization.images).toEqual([
      {
        name: 'quay.io/metallb/controller',
        newName: 'quay.io/metallb/controller',
        newTag: 'v0.16.2',
        digest: 'sha256:34a6f107f29c4fc6e9d084a7f3bdb781aae7b5ee2b534195a2775ab68c09c503',
      },
      {
        name: 'quay.io/metallb/speaker',
        newName: 'quay.io/metallb/speaker',
        newTag: 'v0.16.2',
        digest: 'sha256:01666518b091a6651d68891c802db84b2219495d7e0e41c2e61c46f9976be231',
      },
    ])
    expect(
      metallbKustomization.patches?.find(
        (patch) => patch.target?.kind === 'Namespace' && patch.target.name === 'metallb-system',
      )?.patch,
    ).toContain('$patch: delete')
  })

  it('pins the Argo control-plane upgrade wave and applies its large CRD server-side', () => {
    expect(argoCdKustomization).toContain('argo-cd/v3.6.3/manifests/ha/install.yaml')
    expect(argoCdKustomization).not.toContain('argo-cd/v3.4.6/')
    expect(applicationSetsReadme.split('argo-cd/v3.6.3/manifests/crds/applicationset-crd.yaml')).toHaveLength(3)
    expect(applicationSetsReadme).not.toContain('argo-cd/v3.4.6/')
    expect(argoCdReadme).toContain('## Argo CD v3.6.3 upgrade')
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

    expect(kubeVirtKustomization).toContain('kubevirt/releases/download/v1.10.0/')
    expect(kubeVirtKustomization).not.toContain('MultiArchitecture')
    expect(cdiKustomization).toContain('containerized-data-importer/releases/download/v1.66.1/')
    expect(knativeKustomization).toContain('knative/operator/releases/download/knative-v1.24.1/operator.yaml')
    expect(knativeKustomization).toContain('$patch: delete')
    expect(knativeKustomization).not.toContain('argocd.argoproj.io/sync-options: Prune=false')
    expect(knativeServingManifest).toContain('version: 1.24.0')
    expect(knativeEventingManifest).toContain('version: 1.24.0')
    expect(knativeEventingKustomization).toContain('eventing-kafka-controller.yaml')
    expect(knativeEventingKustomization).toContain('eventing-kafka-source.yaml')
    expect(knativeEventingKustomization).toContain('knative-v1.24.0')
    expect(knativeEventingKustomization).not.toContain('patchesStrategicMerge')
    expect(knativeEntry).toContain('app.kubernetes.io/managed-by: argocd')
    expect(knativeEntry).not.toContain('argocd.argoproj.io/sync-options: Prune=false')
    expect(knativeEntry).not.toContain('argocd.argoproj.io/tracking-id')
  })

  it('pins the enabled observability collector upgrade wave', () => {
    for (const deploymentPath of enabledAlloyDeploymentPaths) {
      expect(readFileSync(deploymentPath, 'utf8')).toContain('grafana/alloy:v1.22.0')
    }
    expect(readFileSync('argocd/applications/buzz/alloy-deployment.yaml', 'utf8')).toContain(
      'sha256:9acc2529bc1edb7f5b2bd801dd8334ebc80c158e3a9e5526ecd7c9a273d43189',
    )
    expect(natsKustomization).toContain('newTag: v1.22.0')
    expect(observabilityKustomization).toContain('version: 9.1.0')
  })

  it('pins the enabled service image upgrade wave', () => {
    expect(featureFlagsKustomization).toContain('version: 2.14.2')
    expect(featureFlagsKustomization).toContain('newTag: v2.14.2')
    expect(featureFlagsKustomization).toContain(
      'digest: sha256:121830e237c3a0d2b875f73905944d6ff301fdd7881c5abdec5f24f5549537e8',
    )
    expect(cloudflaredDeployment).toContain(
      'cloudflare/cloudflared:2026.11.2@sha256:55c7e3e8d89d5e8d20b75a82f3602cbf98e06db406e73e282073cfdc5a9a3af6',
    )
    expect(karapaceManifest).toContain(
      'ghcr.io/aiven-open/karapace:6.2.4@sha256:005eda40272a09f34e60605ae40b1c205c0a5119164b8a090a51ad7f939f79f3',
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
      version: '1.8.0',
    })
    expect(temporalKustomization.images).toEqual([
      {
        name: 'temporal-worker-runtime',
        newName: 'mirror.gcr.io/temporalio/server',
        newTag: '1.32.2',
        digest: 'sha256:7bf69188a6232fea14869b9cef3d94aa82a1601d99517f7e86c71f22da4e0670',
      },
      {
        name: 'docker.elastic.co/elasticsearch/elasticsearch',
        newTag: '8.19.21',
        digest: 'sha256:cbf5cd6cfe5532a9c02d510c66d238bf329cd51fe3d57170a2a880aca7d47419',
      },
      {
        name: 'mirror.gcr.io/temporalio/server',
        newName: 'mirror.gcr.io/temporalio/server',
        newTag: '1.32.2',
        digest: 'sha256:7bf69188a6232fea14869b9cef3d94aa82a1601d99517f7e86c71f22da4e0670',
      },
      {
        name: 'mirror.gcr.io/temporalio/admin-tools',
        newName: 'mirror.gcr.io/temporalio/admin-tools',
        newTag: '1.32.2',
        digest: 'sha256:4a95866efba29d7e17ab012df5232795e8b0ad0f7d5f9d1ec4df321f7792a754',
      },
      {
        name: 'mirror.gcr.io/temporalio/ui',
        newName: 'mirror.gcr.io/temporalio/ui',
        newTag: '2.58.1',
        digest: 'sha256:ac3c13eddb4547d830991bb5eee93a5d97140134522b7297fdb2be1fe25ef925',
      },
    ])
  })

  it('pins the Open WebUI migration wave to its immutable image', () => {
    expect(jangarKustomization.helmCharts?.find((chart) => chart.name === 'open-webui')).toMatchObject({
      version: '18.4.0',
    })
    expect(jangarKustomization.images?.find((image) => image.name === 'ghcr.io/open-webui/open-webui')).toEqual({
      name: 'ghcr.io/open-webui/open-webui',
      newTag: 'v0.13.4',
      digest: 'sha256:d5168bfbc28609eff5bea1b438dd864cf64d185cf6582c02244865e18385b901',
    })
    expect(openWebUIValues.image?.tag).toBe('v0.13.4')
  })

  it('pins both Saigak Ollama containers to the immutable ROCm image', () => {
    const podSpec = saigakStatefulSet.spec?.template?.spec
    const ollamaImages = [...(podSpec?.initContainers ?? []), ...(podSpec?.containers ?? [])]
      .filter((container) => container.name === 'model-init' || container.name === 'ollama')
      .map((container) => container.image)

    expect(ollamaImages).toEqual([
      'ollama/ollama:0.40.19-rocm@sha256:4f73cdd3226204f3778e1c81f87c0b10ed92fd33270ccfcc815ffffc0b2600cd',
      'ollama/ollama:0.40.19-rocm@sha256:4f73cdd3226204f3778e1c81f87c0b10ed92fd33270ccfcc815ffffc0b2600cd',
    ])
  })

  it('pins Flamingo vLLM to the immutable Blackwell image', () => {
    const vllm = flamingoDeployment.spec?.template?.spec?.containers?.find((container) => container.name === 'vllm')

    expect(vllm?.image).toBe(
      'vllm/vllm-openai:v0.34.0@sha256:20fdb089454afbb324efa4110a2c025ff7b27cc1a086e07aa580b18df8ad1ce1',
    )
  })

  it('pins Keycloak to the immutable multi-architecture security release', () => {
    expect(keycloakManifest).toContain(
      'quay.io/keycloak/keycloak:26.8.2@sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3',
    )
  })

  it('pins Coder to the immutable multi-architecture stable release', () => {
    expect(coderChart).toMatchObject({
      appVersion: '2.38.10',
      version: '2.38.10',
    })
    expect(coderChart.dependencies?.find((dependency) => dependency.name === 'coder')?.version).toBe('2.38.10')
    expect(coderValues.coder?.coder).toMatchObject({
      replicaCount: 1,
      image: {
        tag: 'v2.38.10@sha256:f94f80a3bcc002b9a4e32b551d18e5331a0b9c936e0663412e8a9894339e94cf',
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
        'nvcr.io/nvidia/k8s-device-plugin:v0.20.2@sha256:7673383d44a84bece724d9ca8feeadf4eee69cd46475fdff614cbbca6732d463',
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

  it('tracks ARC runner images through the single GitHub Actions and Kargo path', () => {
    expect(entry('arc')).toMatchObject({
      class: 'nix-image',
      nixImageAttr: 'arc-runner-image',
    })
    expect(entry('arc').workflowPaths).toContain('.github/workflows/arc-runner-build-push.yml')
    expect(entry('arc').buildScriptPath).toBeUndefined()
    expect(entry('arc').deployScriptPath).toBeUndefined()
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
      workflowPaths: ['.github/workflows/buzz-relay-build-push.yml', '.github/workflows/buzz-relay-cache.yml'],
    })
    expect(entry('buzz').deferredReason).toContain('block/buzz')
  })

  it('tracks Hermes as a reviewed upstream mirror, not an in-repo image build gap', () => {
    expect(entry('hermes')).toMatchObject({
      class: 'vendor-manifest',
      hasHelmChart: false,
      repoImages: [
        'registry.ide-newton.ts.net/lab/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283',
      ],
    })
    expect(entry('hermes').deferredReason).toContain('NousResearch/hermes-agent')
  })

  it('tracks Tigresse as a vendored external-operator chart, not an in-repo image build gap', () => {
    expect(entry('tigresse')).toMatchObject({
      class: 'vendor-manifest',
      hasHelmChart: true,
      repoImages: [
        'registry.ide-newton.ts.net/lab/tigresse@sha256:e5174fe7f584ac12d4c50ef372b346cbffe4b0f377b552e795f046fca1e85172',
      ],
    })
    expect(entry('tigresse').deferredReason).toContain('proompteng/tigresse')
  })

  it('passes the no-build-for-chart-and-vendor guardrail', () => {
    expect(() => assertEnabledAppBuildPolicy(inventory)).not.toThrow()
  })
})
