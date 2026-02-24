import { describe, expect, it } from 'vitest'

import {
  appendBranchSuffix,
  applyVcsMetadataToParameters,
  hasBranchConflict,
  hasParameterValue,
  isActiveRun,
  isQueuedRun,
  normalizeBranchName,
  normalizeRepository,
  resolveImplementation,
  resolveParam,
  resolveParameters,
  resolveRepositoryFromParameters,
  resolveRunHeadBranch,
  resolveRunParam,
  resolveRunRepository,
  setMetadataIfMissing,
} from '~/server/agents-controller/run-utils'

describe('agents controller run-utils module', () => {
  it('resolves implementation and parameters from an AgentRun', () => {
    const run = {
      spec: {
        implementation: { inline: { text: 'inline impl' } },
        parameters: {
          keep: 'yes',
          drop: 1,
          empty: '   ',
        },
      },
    }

    expect(resolveImplementation(run)).toEqual({ text: 'inline impl' })
    expect(resolveParameters(run)).toEqual({ keep: 'yes', empty: '   ' })
  })

  it('resolves repository from explicit field or parameter aliases', () => {
    expect(resolveRepositoryFromParameters({ repository: ' owner/repo ' })).toBe('owner/repo')
    expect(resolveRepositoryFromParameters({ repo: 'owner/repo2' })).toBe('owner/repo2')
    expect(resolveRepositoryFromParameters({ issueRepository: 'owner/repo3' })).toBe('owner/repo3')

    expect(
      resolveRunRepository({
        status: { vcs: { repository: ' org/main ' } },
        spec: { parameters: { repository: 'ignored/repo' } },
      }),
    ).toBe('org/main')

    expect(
      resolveRunRepository({
        spec: {
          parameters: { repo: 'org/fallback' },
        },
      }),
    ).toBe('org/fallback')

    expect(resolveRunRepository({ spec: {} })).toBe('')
  })

  it('resolves generic and run-bound parameter aliases', () => {
    expect(resolveParam({ a: '  x  ', b: 'y' }, ['missing', 'a'])).toBe('x')
    expect(resolveParam({ a: '   ' }, ['a'])).toBe('')

    const run = {
      spec: {
        parameters: {
          head_ref: 'feature/one',
        },
      },
    }

    expect(resolveRunParam(run, ['head', 'head_ref'])).toBe('feature/one')
  })

  it('normalizes repo/branch, active phases, and queued phases', () => {
    expect(normalizeRepository(' Owner/Repo ')).toBe('owner/repo')
    expect(normalizeBranchName(' feature/test ')).toBe('feature/test')

    expect(isActiveRun({ status: { phase: 'Running' } })).toBe(true)
    expect(isActiveRun({ status: { phase: 'Succeeded' } })).toBe(false)

    expect(isQueuedRun({ status: { phase: 'Queued' } })).toBe(true)
    expect(isQueuedRun({ status: { phase: 'inProgress' } })).toBe(true)
    expect(isQueuedRun({ status: { phase: 'Running' } })).toBe(false)
  })

  it('resolves run head branch with status-first fallback', () => {
    expect(
      resolveRunHeadBranch({
        status: { vcs: { headBranch: 'feature/head' } },
        spec: { parameters: { branch: 'feature/param' } },
      }),
    ).toBe('feature/head')

    expect(
      resolveRunHeadBranch({
        status: { vcs: { branch: 'feature/status-branch' } },
        spec: { parameters: { branch: 'feature/param' } },
      }),
    ).toBe('feature/status-branch')

    expect(
      resolveRunHeadBranch({
        spec: { parameters: { headRef: 'feature/param' } },
      }),
    ).toBe('feature/param')
  })

  it('detects branch conflicts only for active runs in same repo/branch', () => {
    const runs = [
      {
        metadata: { name: 'run-a' },
        status: { phase: 'Running', vcs: { headBranch: 'feature/a' } },
        spec: { parameters: { repository: 'org/repo' } },
      },
      {
        metadata: { name: 'run-b' },
        status: { phase: 'Succeeded', vcs: { headBranch: 'feature/a' } },
        spec: { parameters: { repository: 'org/repo' } },
      },
      {
        metadata: { name: 'run-c' },
        status: { phase: 'Running', vcs: { headBranch: 'feature/other' } },
        spec: { parameters: { repository: 'org/repo' } },
      },
    ]

    expect(hasBranchConflict(runs, 'run-current', 'org/repo', 'feature/a')).toBe(true)
    expect(hasBranchConflict(runs, 'run-a', 'org/repo', 'feature/a')).toBe(false)
    expect(hasBranchConflict(runs, 'run-current', 'org/repo', 'feature/z')).toBe(false)
    expect(hasBranchConflict(runs, 'run-current', '', 'feature/a')).toBe(false)
  })

  it('applies branch suffixes and vcs metadata when missing', () => {
    expect(appendBranchSuffix('feature/a', '  /retry-1 ')).toBe('feature/a-retry-1')
    expect(appendBranchSuffix('feature/a-', 'suffix')).toBe('feature/a-suffix')
    expect(appendBranchSuffix('feature/a', '   ')).toBe('feature/a')

    const original = { task: 'run' }
    const withMetadata = applyVcsMetadataToParameters(original, {
      baseBranch: 'main',
      headBranch: 'feature/a',
    })
    expect(withMetadata).toEqual({ task: 'run', base: 'main', head: 'feature/a' })

    const preserved = applyVcsMetadataToParameters(
      { base_ref: 'already', branch: 'already-branch' },
      { baseBranch: 'main', headBranch: 'feature/a' },
    )
    expect(preserved).toEqual({ base_ref: 'already', branch: 'already-branch' })
  })

  it('detects present parameter values and sets metadata only when missing', () => {
    expect(hasParameterValue({ base: 'main' }, ['base'])).toBe(true)
    expect(hasParameterValue({ base: '   ' }, ['base'])).toBe(false)

    const metadata: Record<string, string> = { keep: 'value' }
    setMetadataIfMissing(metadata, 'keep', 'other')
    setMetadataIfMissing(metadata, 'set', 'next')
    setMetadataIfMissing(metadata, 'skip-empty', '')

    expect(metadata).toEqual({ keep: 'value', set: 'next' })
  })
})
