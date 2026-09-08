import { describe, expect, it } from 'vitest'

import {
  type ControllerState,
  createNamespaceState,
  ensureNamespaceState,
  listItems,
  resolveMemory,
  snapshotNamespace,
  updateStateMap,
} from '~/server/agents-controller/namespace-state'

describe('agents controller namespace-state module', () => {
  it('creates and ensures namespace state instances', () => {
    const state: ControllerState = { namespaces: new Map() }
    const first = ensureNamespaceState(state, 'agents')
    const second = ensureNamespaceState(state, 'agents')

    expect(first).toBe(second)
    expect(state.namespaces.get('agents')).toBe(first)
    expect(createNamespaceState()).toEqual({
      agents: new Map(),
      providers: new Map(),
      specs: new Map(),
      sources: new Map(),
      vcsProviders: new Map(),
      memories: new Map(),
      runs: new Map(),
    })
  })

  it('updates resource maps by event type', () => {
    const map = new Map<string, Record<string, unknown>>()
    const resource = { metadata: { name: 'run-1' }, status: { phase: 'Pending' } }

    updateStateMap(map, 'ADDED', resource)
    expect(map.get('run-1')).toEqual(resource)

    updateStateMap(map, 'MODIFIED', { metadata: { name: 'run-1' }, status: { phase: 'Running' } })
    expect(map.get('run-1')).toEqual({ metadata: { name: 'run-1' }, status: { phase: 'Running' } })

    updateStateMap(map, 'DELETED', resource)
    expect(map.has('run-1')).toBe(false)

    updateStateMap(map, 'ADDED', { metadata: {} })
    expect(map.size).toBe(0)
  })

  it('snapshots namespace map values to arrays', () => {
    const ns = createNamespaceState()
    ns.agents.set('agent-1', { metadata: { name: 'agent-1' } })
    ns.providers.set('provider-1', { metadata: { name: 'provider-1' } })

    const snapshot = snapshotNamespace(ns)

    expect(snapshot.agents).toEqual([{ metadata: { name: 'agent-1' } }])
    expect(snapshot.providers).toEqual([{ metadata: { name: 'provider-1' } }])
    expect(snapshot.specs).toEqual([])
    expect(snapshot.sources).toEqual([])
    expect(snapshot.vcsProviders).toEqual([])
    expect(snapshot.memories).toEqual([])
    expect(snapshot.runs).toEqual([])
  })

  it('lists items safely from list responses', () => {
    expect(listItems({ items: [{ a: 1 }, { b: 2 }] })).toEqual([{ a: 1 }, { b: 2 }])
    expect(listItems({ items: 'bad' })).toEqual([])
    expect(listItems({})).toEqual([])
  })

  it('resolves memory precedence: run ref, agent ref, then default', () => {
    const memories = [
      { metadata: { name: 'default' }, spec: { default: true } },
      { metadata: { name: 'agent-mem' }, spec: {} },
      { metadata: { name: 'run-mem' }, spec: {} },
    ]

    expect(
      resolveMemory(
        { spec: { memoryRef: { name: 'run-mem' } } },
        { spec: { memoryRef: { name: 'agent-mem' } } },
        memories,
      ),
    ).toEqual({ metadata: { name: 'run-mem' }, spec: {} })

    expect(resolveMemory({}, { spec: { memoryRef: { name: 'agent-mem' } } }, memories)).toEqual({
      metadata: { name: 'agent-mem' },
      spec: {},
    })

    expect(resolveMemory({}, {}, memories)).toEqual({ metadata: { name: 'default' }, spec: { default: true } })
    expect(resolveMemory({}, {}, [{ metadata: { name: 'no-default' }, spec: {} }])).toBeNull()
  })
})
