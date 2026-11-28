import { describe, expect, it } from 'vitest'

import { AgentRunIndex, resolveRepoConcurrencyLimit } from './queue-state'

const run = (phase: string, repository: string, head = '') => ({
  status: { phase },
  spec: { agentRef: { name: 'codex' }, parameters: { repository, head } },
})

describe('AgentRun admission index', () => {
  it('resolves normalized repository overrides and disabled limits', () => {
    const config = { enabled: true, defaultLimit: 2, overrides: new Map([['org/repo', 5]]) }
    expect(resolveRepoConcurrencyLimit(' Org/Repo ', config)).toBe(5)
    expect(resolveRepoConcurrencyLimit('other/repo', config)).toBe(2)
    expect(resolveRepoConcurrencyLimit('  ', config)).toBeNull()
    expect(resolveRepoConcurrencyLimit('Org/Repo', { ...config, enabled: false })).toBeNull()
    expect(resolveRepoConcurrencyLimit('Org/Repo', { ...config, defaultLimit: 0, overrides: new Map() })).toBeNull()
  })

  it('tracks updates and relists across all scopes, excluding only the queued run itself', () => {
    const index = new AgentRunIndex()
    index.update('a', 'self', run('Pending', 'Org/Repo'))
    index.update('b', 'self', run('Progressing', 'org/repo'))
    index.update('a', 'first', run('Running', 'Org/Repo'))
    index.update('b', 'second', run('Running', 'org/repo'))
    index.update('b', 'other', run('Running', 'org/other'))
    index.update('a', 'template', run('Template', 'org/repo'))
    expect(index.admission('a', 'self', 'codex', 'org/repo')).toEqual({
      runningNamespace: 1,
      runningAgent: 1,
      runningCluster: 3,
      runningRepo: 2,
      queuedNamespace: 0,
      queuedCluster: 1,
      queuedRepo: 1,
    })

    index.update('a', 'first', run('Succeeded', 'org/repo'))
    index.update('b', 'self', null)
    index.replaceNamespace('b', new Map([['second', run('Queued', 'org/third')]]))
    expect(index.admission('a', 'self', 'codex', 'org/repo')).toEqual({
      runningNamespace: 0,
      runningAgent: 0,
      runningCluster: 0,
      runningRepo: 0,
      queuedNamespace: 0,
      queuedCluster: 1,
      queuedRepo: 0,
    })
    expect(index.admission('b', 'absent', 'codex', 'org/third').queuedRepo).toBe(1)
  })

  it('detects branch conflicts only for other active runs in the same namespace, repo, and branch', () => {
    const index = new AgentRunIndex()
    index.update('a', 'self', run('Running', 'Org/Repo', 'feature/a'))
    index.update('a', 'done', run('Succeeded', 'org/repo', 'feature/a'))
    index.update('b', 'same-branch', run('Running', 'org/repo', 'feature/a'))
    expect(index.hasBranchConflict('a', 'self', 'org/repo', 'feature/a')).toBe(false)
    expect(index.hasBranchConflict('a', 'new', 'org/repo', ' feature/a ')).toBe(true)
    expect(index.hasBranchConflict('a', 'new', 'org/repo', 'feature/A')).toBe(false)

    index.update('a', 'pending', run('Pending', 'Org/Repo', 'feature/a'))
    expect(index.hasBranchConflict('a', 'self', 'org/repo', 'feature/a')).toBe(true)
    index.update('a', 'pending', run('Running', 'org/repo', 'feature/b'))
    expect(index.hasBranchConflict('a', 'self', 'org/repo', 'feature/a')).toBe(false)
    expect(index.hasBranchConflict('a', 'self', 'org/repo', 'feature/b')).toBe(true)
  })

  it('does not revisit any resource while checking 200 admissions and branch conflicts', () => {
    const index = new AgentRunIndex()
    let statusReads = 0
    for (let i = 0; i < 200; i++) {
      const resource = run('Pending', 'Org/Repo', `feature/${i}`)
      index.update('a', `run-${i}`, {
        spec: resource.spec,
        get status() {
          statusReads += 1
          return resource.status
        },
      })
    }
    expect(statusReads).toBeGreaterThan(0)
    statusReads = 0
    for (let i = 0; i < 200; i++) {
      expect(index.admission('a', `run-${i}`, 'codex', 'org/repo').queuedRepo).toBe(199)
      expect(index.hasBranchConflict('a', `run-${i}`, 'org/repo', `feature/${i}`)).toBe(false)
    }
    expect(statusReads).toBe(0)
  })
})
