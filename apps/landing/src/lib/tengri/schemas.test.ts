import { describe, expect, test } from 'bun:test'
import { tengriActionSchema } from './schemas'

describe('Tengri BFF action schema', () => {
  test('CreateAgent accepts only a display name and rejects resource escalation fields', () => {
    expect(tengriActionSchema.safeParse({ action: 'create-agent', displayName: 'Tengri' }).success).toBe(true)
    expect(
      tengriActionSchema.safeParse({
        action: 'create-agent',
        displayName: 'Tengri',
        resources: { cpuMillis: 64_000, memoryMib: 262_144 },
      }).success,
    ).toBe(false)
    expect(tengriActionSchema.safeParse({ action: 'create-agent', displayName: 'a'.repeat(64) }).success).toBe(true)
    expect(tengriActionSchema.safeParse({ action: 'create-agent', displayName: 'a'.repeat(65) }).success).toBe(false)
  })

  test('constrains terminal geometry, approval decisions, and preview ports', () => {
    expect(
      tengriActionSchema.safeParse({
        action: 'create-terminal',
        agentId: 'agent-123',
        cwd: '/',
        columns: 10_000,
        rows: 24,
      }).success,
    ).toBe(false)
    expect(
      tengriActionSchema.safeParse({
        action: 'resolve-approval',
        agentId: 'agent-123',
        approvalId: 'approval-1',
        decision: 'always-approve',
      }).success,
    ).toBe(false)
    expect(tengriActionSchema.safeParse({ action: 'preview-session', agentId: 'agent-123', port: 22 }).success).toBe(
      false,
    )
    expect(
      tengriActionSchema.safeParse({
        action: 'preview-session',
        agentId: 'agent-123',
        port: 4321,
        path: '/app?mode=dev',
      }).success,
    ).toBe(true)
    for (const path of ['https://example.test/app', '/app#ticket', '/app\u0000private']) {
      expect(
        tengriActionSchema.safeParse({ action: 'preview-session', agentId: 'agent-123', port: 4321, path }).success,
      ).toBe(false)
    }
  })

  test('requires absolute clean file paths and rejects undeclared action fields', () => {
    for (const path of ['workspace/file.ts', '/workspace/file.ts\u0000secret', '/workspace/file.ts\nnext']) {
      expect(tengriActionSchema.safeParse({ action: 'read-file', agentId: 'agent-123', path }).success).toBe(false)
    }
    expect(
      tengriActionSchema.safeParse({
        action: 'read-file',
        agentId: 'agent-123',
        path: '/workspace/file.ts',
        impersonateSubject: 'github:999',
      }).success,
    ).toBe(false)
  })
})
