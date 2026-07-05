import { describe, expect, it } from 'bun:test'

import { assertEnabledAppBuildPolicy, loadEnabledAppInventory } from '../enabled-apps'

const inventory = loadEnabledAppInventory()

const entry = (name: string) => {
  const found = inventory.entries.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Missing enabled app inventory entry for ${name}`)
  return found
}

describe('enabled app inventory', () => {
  it('loads only root-enabled ApplicationSet entries plus direct root-managed Applications', () => {
    expect(inventory.applicationSetEntryCount).toBe(71)
    expect(inventory.directApplicationCount).toBe(1)
    expect(inventory.entries).toHaveLength(72)
    expect(inventory.entries.some((candidate) => candidate.name === 'facteur')).toBe(false)
    expect(inventory.entries.some((candidate) => candidate.name === 'bonjour')).toBe(false)
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
    for (const name of [
      'headlamp',
      'temporal',
      'observability',
      'nats',
      'kafka',
      'traefik',
      'tailscale',
      'cert-manager',
    ]) {
      expect(entry(name)).toMatchObject({
        class: 'helm-chart',
        hasHelmChart: true,
        repoImages: [],
      })
      expect(entry(name).nixImageAttr).toBeUndefined()
      expect(entry(name).buildScriptPath).toBeUndefined()
    }
  })

  it('marks only approved early build-owning apps as Nix image candidates', () => {
    for (const name of [
      'oirat',
      'agents',
      'bumba',
      'froussard',
      'docs',
      'app',
      'proompteng',
      'olden',
      'synthesis',
      'attic',
      'sag',
      'symphony',
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
    expect(entry('docs').nixImageAttr).toBe('docs-image')
    expect(entry('app').nixImageAttr).toBe('app-image')
    expect(entry('proompteng').nixImageAttr).toBe('proompteng-image')
    expect(entry('olden').nixImageAttr).toBe('olden-image')
    expect(entry('synthesis').nixImageAttr).toBe('synthesis-image')
    expect(entry('agents').nixImageAttr).toBe('agents-codex-runner-image')
    expect(entry('sag').nixImageAttr).toBe('sag-image')
    expect(entry('symphony').nixImageAttr).toBe('symphony-image')
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

  it('tracks Froussard through both GitHub Actions and manual Nix image paths', () => {
    expect(entry('froussard')).toMatchObject({
      class: 'nix-image',
      nixImageAttr: 'froussard-image',
      buildScriptPath: 'packages/scripts/src/froussard/build-image.ts',
      deployScriptPath: 'packages/scripts/src/froussard/deploy-service.ts',
    })
    expect(entry('froussard').workflowPaths).toContain('.github/workflows/froussard-ci.yml')
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

  it('defers complex or unhealthy repo-image apps instead of counting them as rollout proof', () => {
    for (const name of ['jangar', 'symphony-jangar', 'symphony-torghut']) {
      expect(entry(name).class).toBe('deferred')
      expect(entry(name).repoImages.length).toBeGreaterThan(0)
      expect(entry(name).deferredReason).toBeTruthy()
    }
  })

  it('keeps repo-image apps without local build ownership out of Nix migration state', () => {
    for (const name of ['analysis', 'bilig']) {
      expect(entry(name).class).toBe('vendor-manifest')
      expect(entry(name).repoImages.length).toBeGreaterThan(0)
      expect(entry(name).buildScriptPath).toBeUndefined()
      expect(entry(name).deployScriptPath).toBeUndefined()
      expect(entry(name).nixImageAttr).toBeUndefined()
      expect(entry(name).deferredReason).toBeTruthy()
    }
  })

  it('passes the no-build-for-chart-and-vendor guardrail', () => {
    expect(() => assertEnabledAppBuildPolicy(inventory)).not.toThrow()
  })
})
