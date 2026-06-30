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
    for (const name of ['oirat', 'bumba', 'froussard', 'docs', 'app', 'proompteng', 'olden', 'synthesis', 'attic']) {
      expect(entry(name).class).toBe('nix-image')
      expect(entry(name).repoImages.length).toBeGreaterThan(0)
    }
  })

  it('defers complex or unhealthy repo-image apps instead of counting them as rollout proof', () => {
    for (const name of ['agents', 'jangar', 'sag', 'symphony', 'bilig', 'analysis', 'torghut', 'torghut-options']) {
      expect(entry(name).class).toBe('deferred')
      expect(entry(name).repoImages.length).toBeGreaterThan(0)
      expect(entry(name).deferredReason).toBeTruthy()
    }
  })

  it('passes the no-build-for-chart-and-vendor guardrail', () => {
    expect(() => assertEnabledAppBuildPolicy(inventory)).not.toThrow()
  })
})
