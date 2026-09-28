import { describe, expect, it } from 'vitest'

import { normalizeApprovalPolicy, normalizeSandboxMode, toSandboxPolicy } from './app-server-client'

describe('normalizeSandboxMode', () => {
  it('maps legacy sandbox strings to hyphenated variants', () => {
    expect(normalizeSandboxMode('dangerFullAccess')).toBe('danger-full-access')
    expect(normalizeSandboxMode('workspaceWrite')).toBe('workspace-write')
    expect(normalizeSandboxMode('readOnly')).toBe('read-only')
  })

  it('passes through already-normalized sandbox values', () => {
    expect(normalizeSandboxMode('workspace-write')).toBe('workspace-write')
  })
})

describe('normalizeApprovalPolicy', () => {
  it('maps legacy approval strings to the new enum', () => {
    expect(normalizeApprovalPolicy('onRequest')).toBe('on-request')
    expect(normalizeApprovalPolicy('unlessTrusted')).toBe('untrusted')
  })

  it('rejects legacy on-failure instead of escalating it to on-request', () => {
    expect(() => normalizeApprovalPolicy('onFailure')).toThrow(
      'Legacy approval policy on-failure is unsupported by the current Codex app-server protocol',
    )
    expect(() => normalizeApprovalPolicy('on-failure')).toThrow(
      'Legacy approval policy on-failure is unsupported by the current Codex app-server protocol',
    )
  })

  it('passes through already-normalized approval values', () => {
    expect(normalizeApprovalPolicy('never')).toBe('never')
  })
})

describe('toSandboxPolicy', () => {
  it('builds workspace-write policy settings', () => {
    expect(toSandboxPolicy('workspace-write')).toEqual({
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })
  })

  it('builds read-only policy settings', () => {
    expect(toSandboxPolicy('read-only')).toEqual({
      type: 'readOnly',
      networkAccess: true,
    })
  })

  it('builds danger-full-access policy settings', () => {
    expect(toSandboxPolicy('danger-full-access')).toEqual({ type: 'dangerFullAccess' })
  })
})
