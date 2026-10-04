import { describe, expect, it } from 'vitest'

import { normalizeCliArgs, requireReadOnlyGitArgs, requireReadOnlyKubectlArgs } from './cli-policy'

describe('read-only CLI inspection', () => {
  it.each([
    ['ls-tree', '-r', 'HEAD'],
    ['rev-list', '--parents', 'HEAD'],
    ['cat-file', '-t', 'HEAD'],
    ['remote', '-v'],
    ['worktree', 'list'],
    ['ls-remote', 'origin'],
    ['--no-pager', 'diff'],
  ])('accepts git %j', (...args) => {
    expect(() => requireReadOnlyGitArgs(args)).not.toThrow()
  })

  it.each([
    ['-n', 'agents', 'get', 'pods'],
    ['--namespace=agents', 'get', 'pods'],
    ['--context', 'galactic', '-n', 'agents', 'get', 'pods'],
    ['config', 'current-context'],
    ['-n', 'agents', 'rollout', 'status', 'deployment/example'],
  ])('accepts kubectl %j', (...args) => {
    expect(() => requireReadOnlyKubectlArgs(args)).not.toThrow()
  })

  it.each([
    ['commit', '-m', 'change'],
    ['remote', 'add', 'origin', '/tmp/repo'],
    ['worktree', 'remove', '/tmp/repo'],
    ['--no-pager', 'reset', '--hard'],
  ])('denies git %j', (...args) => {
    expect(() => requireReadOnlyGitArgs(args)).toThrow()
  })

  it.each([
    ['-n', 'agents', 'delete', 'pod/example'],
    ['--namespace=agents', 'exec', 'pod/example', '--', 'true'],
    ['config', 'use-context', 'other'],
    ['--context', 'galactic', 'rollout', 'restart', 'deployment/example'],
    ['--unsupported-option', 'get', 'pods'],
  ])('denies kubectl %j', (...args) => {
    expect(() => requireReadOnlyKubectlArgs(args)).toThrow()
  })

  it('preserves literal argument whitespace and empty argument values', () => {
    expect(normalizeCliArgs('git', ['grep', ' padded ', ''])).toEqual(['grep', ' padded ', ''])
  })
})
