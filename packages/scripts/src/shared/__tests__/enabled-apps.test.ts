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
    expect(entry('sag').nixImageAttr).toBe('sag-image')
    expect(entry('symphony').nixImageAttr).toBe('symphony-image')
  })

  it('defers complex or unhealthy repo-image apps instead of counting them as rollout proof', () => {
    for (const name of ['agents', 'jangar', 'symphony-jangar', 'symphony-torghut', 'torghut', 'torghut-options']) {
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

  it('requires every root-enabled repo image to have a rollout disposition', () => {
    for (const candidate of inventory.entries.filter((entry) => entry.repoImages.length > 0)) {
      expect(['nix-image', 'deferred', 'vendor-manifest']).toContain(candidate.class)
      if (candidate.class === 'nix-image') {
        expect(candidate.nixImageAttr).toBeTruthy()
      } else {
        expect(candidate.deferredReason).toBeTruthy()
      }
    }
  })

  it('passes the no-build-for-chart-and-vendor guardrail', () => {
    expect(() => assertEnabledAppBuildPolicy(inventory)).not.toThrow()
  })
})
