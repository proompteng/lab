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

describe('ls-remote executable and transport boundaries', () => {
  it.each([
    ['ls-remote', '--upload-pack=touch /tmp/should-not-run', 'origin'],
    ['ls-remote', '--upload-pack', 'touch /tmp/should-not-run', 'origin'],
    ['ls-remote', 'origin', '--upload-p=touch /tmp/should-not-run'],
    ['ls-remote', 'ext::sh -c touch /tmp/should-not-run'],
    ['ls-remote', 'custom::repository'],
  ])('rejects git %j', (...args) => {
    expect(() => requireReadOnlyGitArgs(args)).toThrow()
  })
  it.each([
    ['ls-remote', '--heads', '--tags', 'origin', 'refs/heads/main'],
    ['--no-pager', 'ls-remote', '--symref', '--sort=version:refname', 'https://github.com/example/repo.git'],
    ['ls-remote', '--sort', '-version:refname', '--refs', 'git@example.test:repo.git'],
  ])('retains git %j', (...args) => {
    expect(() => requireReadOnlyGitArgs(args)).not.toThrow()
  })
})

describe('Git object inspection execution boundaries', () => {
  it.each([
    ['cat-file', '--filters', 'HEAD:file.txt'],
    ['cat-file', '--textconv', 'HEAD:file.txt'],
    ['cat-file', '--fil', 'HEAD:file.txt'],
    ['cat-file', '--text', 'HEAD:file.txt'],
    ['cat-file', '--batch', '--filters'],
    ['cat-file', 'blob', 'HEAD:file.txt', '--textconv'],
  ])('rejects git %j', (...args) => {
    expect(() => requireReadOnlyGitArgs(args)).toThrow()
  })
  it.each([
    ['cat-file', '-p', 'HEAD:file.txt'],
    ['cat-file', 'blob', 'HEAD:file.txt'],
    ['cat-file', '--batch-check=%(objectname) %(objecttype)', '--batch-all-objects', '--buffer', '-Z'],
    ['cat-file', '--batch-command', '--no-buffer'],
    ['cat-file', '-p', '--', 'HEAD:file.txt'],
  ])('retains git %j', (...args) => {
    expect(() => requireReadOnlyGitArgs(args)).not.toThrow()
  })
})
