import { describe, expect, test } from 'bun:test'
import { MAX_CODEX_PROMPT_BYTES, MAX_EDITABLE_FILE_BYTES, tengriActionSchema } from './schemas'

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
      tengriActionSchema.safeParse({ action: 'preview-session', agentId: 'agent-123', port: 8080, path: '/' }).success,
    ).toBe(false)
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
    const exactPreviewPath = `/${'é'.repeat(2047)}x`
    expect(Buffer.byteLength(exactPreviewPath, 'utf8')).toBe(4096)
    expect(
      tengriActionSchema.safeParse({
        action: 'preview-session',
        agentId: 'agent-123',
        port: 4321,
        path: exactPreviewPath,
      }).success,
    ).toBe(true)
    expect(
      tengriActionSchema.safeParse({
        action: 'preview-session',
        agentId: 'agent-123',
        port: 4321,
        path: `${exactPreviewPath}é`,
      }).success,
    ).toBe(false)
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

  test('preserves whitespace in valid paths and bounds files by encoded bytes', () => {
    const spacedPath = '/workspace/report '
    const parsed = tengriActionSchema.safeParse({ action: 'read-file', agentId: 'agent-123', path: spacedPath })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.action === 'read-file') expect(parsed.data.path).toBe(spacedPath)

    const exact = 'é'.repeat(MAX_EDITABLE_FILE_BYTES / 2)
    expect(
      tengriActionSchema.safeParse({ action: 'write-file', agentId: 'agent-123', path: spacedPath, content: exact })
        .success,
    ).toBe(true)
    expect(
      tengriActionSchema.safeParse({
        action: 'write-file',
        agentId: 'agent-123',
        path: spacedPath,
        content: `${exact}é`,
      }).success,
    ).toBe(false)
  })

  test('bounds Codex prompts by UTF-8 bytes', () => {
    const exact = '🙂'.repeat(MAX_CODEX_PROMPT_BYTES / 4)
    expect(
      tengriActionSchema.safeParse({ action: 'send-turn', agentId: 'agent-123', threadId: 'thread-1', text: exact })
        .success,
    ).toBe(true)
    expect(
      tengriActionSchema.safeParse({
        action: 'steer-turn',
        agentId: 'agent-123',
        threadId: 'thread-1',
        turnId: 'turn-1',
        text: `${exact}🙂`,
      }).success,
    ).toBe(false)
  })
})
