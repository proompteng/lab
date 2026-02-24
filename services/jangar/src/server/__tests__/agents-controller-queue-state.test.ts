import { describe, expect, it } from 'vitest'

import {
  buildInFlightCounts,
  buildQueueCounts,
  type ControllerState,
  normalizeRepositoryKey,
  type RepoConcurrencyConfig,
  resolveRepoConcurrencyLimit,
} from '~/server/agents-controller/queue-state'

const createRunningRun = (name: string, namespace: string, repository: string, agentName: string) => ({
  metadata: { name, namespace },
  status: {
    phase: 'Running',
    vcs: { repository },
  },
  spec: {
    agentRef: { name: agentName },
  },
})

describe('agents controller queue-state module', () => {
  it('normalizes repository keys and resolves repo concurrency limits', () => {
    expect(normalizeRepositoryKey(' Org/Repo ')).toBe('org/repo')

    const config: RepoConcurrencyConfig = {
      enabled: true,
      defaultLimit: 2,
      overrides: new Map([['org/repo', 5]]),
    }

    expect(resolveRepoConcurrencyLimit('Org/Repo', config)).toBe(5)
    expect(resolveRepoConcurrencyLimit('other/repo', config)).toBe(2)
    expect(resolveRepoConcurrencyLimit('   ', config)).toBeNull()
    expect(resolveRepoConcurrencyLimit('Org/Repo', { ...config, enabled: false })).toBeNull()
    expect(resolveRepoConcurrencyLimit('Org/Repo', { ...config, defaultLimit: 0, overrides: new Map() })).toBeNull()
  })

  it('builds in-flight counts for namespace and cluster', () => {
    const state: ControllerState = {
      namespaces: new Map([
        [
          'agents-a',
          {
            agents: new Map(),
            providers: new Map(),
            specs: new Map(),
            sources: new Map(),
            vcsProviders: new Map(),
            memories: new Map(),
            runs: new Map([
              ['run-a', createRunningRun('run-a', 'agents-a', 'Org/Repo', 'agent-a')],
              [
                'run-b',
                {
                  metadata: { name: 'run-b', namespace: 'agents-a' },
                  status: { phase: 'Pending', vcs: { repository: 'org/repo' } },
                  spec: { agentRef: { name: 'agent-a' } },
                },
              ],
              ['run-c', createRunningRun('run-c', 'agents-a', 'org/repo', 'agent-b')],
            ]),
          },
        ],
        [
          'agents-b',
          {
            agents: new Map(),
            providers: new Map(),
            specs: new Map(),
            sources: new Map(),
            vcsProviders: new Map(),
            memories: new Map(),
            runs: new Map([['run-d', createRunningRun('run-d', 'agents-b', 'other/repo', 'agent-c')]]),
          },
        ],
      ]),
    }

    const counts = buildInFlightCounts(state, 'agents-a')
    expect(counts.total).toBe(2)
    expect(counts.cluster).toBe(3)
    expect(Array.from(counts.perAgent.entries())).toEqual([
      ['agent-a', 1],
      ['agent-b', 1],
    ])
    expect(Array.from(counts.perRepository.entries())).toEqual([
      ['org/repo', 2],
      ['other/repo', 1],
    ])
  })

  it('builds queue counts from snapshot when available and falls back to namespace runs', () => {
    const snapshot: ControllerState = {
      namespaces: new Map([
        [
          'agents-a',
          {
            agents: new Map(),
            providers: new Map(),
            specs: new Map(),
            sources: new Map(),
            vcsProviders: new Map(),
            memories: new Map(),
            runs: new Map([
              [
                'self',
                { metadata: { name: 'self' }, status: { phase: 'Queued', vcs: { repository: 'org/repo' } }, spec: {} },
              ],
              [
                'q1',
                { metadata: { name: 'q1' }, status: { phase: 'Queued', vcs: { repository: 'org/repo' } }, spec: {} },
              ],
              [
                'q2',
                {
                  metadata: { name: 'q2' },
                  status: { phase: 'Progressing', vcs: { repository: 'org/repo' } },
                  spec: {},
                },
              ],
              [
                'nq',
                { metadata: { name: 'nq' }, status: { phase: 'Running', vcs: { repository: 'org/repo' } }, spec: {} },
              ],
            ]),
          },
        ],
        [
          'agents-b',
          {
            agents: new Map(),
            providers: new Map(),
            specs: new Map(),
            sources: new Map(),
            vcsProviders: new Map(),
            memories: new Map(),
            runs: new Map([
              [
                'q3',
                { metadata: { name: 'q3' }, status: { phase: 'Queued', vcs: { repository: 'org/repo' } }, spec: {} },
              ],
            ]),
          },
        ],
      ]),
    }

    const fromSnapshot = buildQueueCounts({
      namespace: 'agents-a',
      runName: 'self',
      normalizedRepo: 'org/repo',
      namespaceRuns: [],
      controllerSnapshot: snapshot,
    })

    expect(fromSnapshot).toEqual({
      queuedNamespace: 2,
      queuedCluster: 3,
      queuedRepo: 3,
    })

    const fromFallback = buildQueueCounts({
      namespace: 'agents-a',
      runName: 'self',
      normalizedRepo: 'org/repo',
      namespaceRuns: [
        { metadata: { name: 'self' }, status: { phase: 'Queued', vcs: { repository: 'org/repo' } }, spec: {} },
        { metadata: { name: 'q1' }, status: { phase: 'Queued', vcs: { repository: 'org/repo' } }, spec: {} },
      ],
      controllerSnapshot: null,
    })

    expect(fromFallback).toEqual({
      queuedNamespace: 1,
      queuedCluster: 1,
      queuedRepo: 1,
    })
  })
})
