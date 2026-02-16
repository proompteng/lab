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
    expect(normalizeApprovalPolicy('onFailure')).toBe('on-failure')
    expect(normalizeApprovalPolicy('onRequest')).toBe('on-request')
    expect(normalizeApprovalPolicy('unlessTrusted')).toBe('untrusted')
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
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })
  })

  it('builds read-only policy settings', () => {
    expect(toSandboxPolicy('read-only')).toEqual({ type: 'readOnly', access: { type: 'fullAccess' } })
  })

  it('builds danger-full-access policy settings', () => {
    expect(toSandboxPolicy('danger-full-access')).toEqual({ type: 'dangerFullAccess' })
  })
})
