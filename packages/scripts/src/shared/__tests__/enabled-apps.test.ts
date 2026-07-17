import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

import { assertEnabledAppBuildPolicy, loadEnabledAppInventory } from '../enabled-apps'

const inventory = loadEnabledAppInventory()
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
    expect(inventory.applicationSetEntryCount).toBe(68)
    expect(inventory.directApplicationCount).toBe(1)
    expect(inventory.entries).toHaveLength(69)
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
    expect(entry('metrics-server')).toMatchObject({
      class: 'external-source',
      repoURL: 'https://github.com/kubernetes-sigs/metrics-server.git',
      repoImages: [],
      hasHelmChart: false,
    })
    expect(entry('home-root')).toMatchObject({
      class: 'external-source',
      repoURL: 'git@github.com:gregkonush/home.git',
      sourceKind: 'direct-application',
      repoImages: [],
      hasHelmChart: false,
    })
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
    for (const name of ['analysis', 'bilig', 'tigresse']) {
      expect(entry(name).class).toBe('vendor-manifest')
      expect(entry(name).repoImages.length).toBeGreaterThan(0)
      expect(entry(name).buildScriptPath).toBeUndefined()
      expect(entry(name).deployScriptPath).toBeUndefined()
      expect(entry(name).nixImageAttr).toBeUndefined()
      expect(entry(name).deferredReason).toBeTruthy()
    }
  })

  it('tracks Tigresse as a vendored external-operator chart, not an in-repo image build gap', () => {
    expect(entry('tigresse')).toMatchObject({
      class: 'vendor-manifest',
      hasHelmChart: true,
      repoImages: [
        'registry.ide-newton.ts.net/lab/tigresse@sha256:a357c07d629f9561f04b3452c1d9c41b81b9d816d29de415bd0141e859e92e39',
      ],
    })
    expect(entry('tigresse').deferredReason).toContain('proompteng/tigresse')
  })

  it('passes the no-build-for-chart-and-vendor guardrail', () => {
    expect(() => assertEnabledAppBuildPolicy(inventory)).not.toThrow()
  })
})
