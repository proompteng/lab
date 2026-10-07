import { describe, expect, test } from 'bun:test'
import {
  MAX_CODEX_PROMPT_BYTES,
  MAX_EDITABLE_FILE_BYTES,
  MAX_FILE_SEARCH_QUERY_BYTES,
  tengriActionSchema,
} from './schemas'

describe('Tengri BFF action schema', () => {
  test('power settings enforce integer idle limits and reject modes that retain RAM', () => {
    const action = { action: 'update-power-settings', agentId: 'agent-test' }
    for (const idleTimeoutMinutes of [0, 5, 60, 1440]) {
      expect(tengriActionSchema.safeParse({ ...action, power: { idleTimeoutMinutes } }).success).toBe(true)
    }
    for (const idleTimeoutMinutes of [-1, 0.5, 1441, '60', null]) {
      expect(tengriActionSchema.safeParse({ ...action, power: { idleTimeoutMinutes } }).success).toBe(false)
    }
    expect(
      tengriActionSchema.safeParse({ ...action, power: { sleepMode: 'hibernate', idleTimeoutMinutes: 60 } }).success,
    ).toBe(false)
    expect(
      tengriActionSchema.safeParse({
        ...action,
        power: { idleTimeoutMinutes: 60, ownerHash: 'other' },
      }).success,
    ).toBe(false)
  })
  test('accepts model options on conversation operations and rejects invalid choices', () => {
    for (const action of [
      { action: 'create-thread', agentId: 'agent-test' },
      { action: 'resume-thread', agentId: 'agent-test', threadId: 'thread-test' },
      { action: 'send-turn', agentId: 'agent-test', threadId: 'thread-test', text: 'Read the workspace' },
    ]) {
      expect(tengriActionSchema.safeParse({ ...action, model: 'gpt-6.1-sol', reasoningEffort: 'high' }).success).toBe(
        true,
      )
      expect(tengriActionSchema.safeParse({ ...action, model: 'gpt-6.1-sol\n' }).success).toBe(false)
      expect(tengriActionSchema.safeParse({ ...action, reasoningEffort: 'unbounded' }).success).toBe(false)
    }
  })

  test('editor logout revocation cannot select another owner', () => {
    expect(tengriActionSchema.safeParse({ action: 'revoke-desktop-previews' }).success).toBe(true)
    expect(tengriActionSchema.safeParse({ action: 'revoke-desktop-previews', ownerId: 'someone-else' }).success).toBe(
      false,
    )
  })

  test('validates editor window identity and rejects editor ports in ordinary previews', () => {
    expect(tengriActionSchema.safeParse({ action: 'browser-session', agentId: 'agent-test' }).success).toBe(true)
    const editor = { action: 'editor-session', agentId: 'agent-test', windowId: 'desktop-stable-code-window' }
    expect(tengriActionSchema.safeParse(editor).success).toBe(true)
    for (const windowId of ['short', '../arbitrary-window-path', 'a'.repeat(129)]) {
      expect(tengriActionSchema.safeParse({ ...editor, windowId }).success).toBe(false)
    }
    for (const port of [13337, 13338, 13339]) {
      expect(
        tengriActionSchema.safeParse({
          action: 'preview-session',
          agentId: 'agent-test',
          port,
          path: '/',
          fragment: '',
        }).success,
      ).toBe(false)
    }
  })

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
        creationId: 'terminal-creation-123',
        cwd: '/',
        columns: 10_000,
        rows: 24,
      }).success,
    ).toBe(false)
    expect(
      tengriActionSchema.safeParse({
        action: 'create-terminal',
        agentId: 'agent-123',
        creationId: 'terminal-creation-123',
        cwd: '/workspace',
        columns: 120,
        rows: 32,
      }).success,
    ).toBe(true)
    expect(
      tengriActionSchema.safeParse({
        action: 'create-terminal',
        agentId: 'agent-123',
        creationId: 'bad creation id',
        cwd: '/workspace',
        columns: 120,
        rows: 32,
      }).success,
    ).toBe(false)
    for (const decision of ['approve-exec-policy-amendment', 'approve-network-policy-amendment']) {
      expect(
        tengriActionSchema.safeParse({
          action: 'resolve-approval',
          agentId: 'agent-123',
          approvalId: 'approval-1',
          decision,
        }).success,
      ).toBe(true)
    }
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
        fragment: '#editor',
      }).success,
    ).toBe(true)
    for (const path of ['https://example.test/app', '/app#ticket', '/app\u0000private']) {
      expect(
        tengriActionSchema.safeParse({
          action: 'preview-session',
          agentId: 'agent-123',
          port: 4321,
          path,
          fragment: '',
        }).success,
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
        fragment: '',
      }).success,
    ).toBe(true)
    expect(
      tengriActionSchema.safeParse({
        action: 'preview-session',
        agentId: 'agent-123',
        port: 4321,
        path: `${exactPreviewPath}é`,
        fragment: '',
      }).success,
    ).toBe(false)
    const exactPreviewFragment = `#${'é'.repeat(2047)}x`
    expect(Buffer.byteLength(exactPreviewFragment, 'utf8')).toBe(4096)
    expect(
      tengriActionSchema.safeParse({
        action: 'preview-session',
        agentId: 'agent-123',
        port: 4321,
        path: '/',
        fragment: exactPreviewFragment,
      }).success,
    ).toBe(true)
    for (const fragment of ['editor', '#editor\nprivate', `#${'é'.repeat(2048)}`]) {
      expect(
        tengriActionSchema.safeParse({
          action: 'preview-session',
          agentId: 'agent-123',
          port: 4321,
          path: '/',
          fragment,
        }).success,
      ).toBe(false)
    }
    expect(
      tengriActionSchema.safeParse({
        action: 'revoke-preview-session',
        agentId: 'agent-123',
        sessionId: 'abc123abc123abc123abc123',
      }).success,
    ).toBe(true)
    expect(
      tengriActionSchema.safeParse({
        action: 'revoke-preview-session',
        agentId: 'agent-123',
        sessionId: 'not-a-session-id',
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
      tengriActionSchema.safeParse({
        action: 'write-file',
        agentId: 'agent-123',
        path: spacedPath,
        content: exact,
        expectedRevision: 'missing',
      }).success,
    ).toBe(true)
    expect(
      tengriActionSchema.safeParse({
        action: 'write-file',
        agentId: 'agent-123',
        path: spacedPath,
        content: `${exact}é`,
        expectedRevision: 'missing',
      }).success,
    ).toBe(false)
  })

  test('requires a precise file revision or create-only precondition for saves', () => {
    const save = { action: 'write-file', agentId: 'agent-123', path: '/workspace/main.ts', content: '' }
    expect(tengriActionSchema.safeParse(save).success).toBe(false)
    for (const expectedRevision of ['', '*', 'A'.repeat(64), 'f'.repeat(63), 'missing ']) {
      expect(tengriActionSchema.safeParse({ ...save, expectedRevision }).success).toBe(false)
    }
    for (const expectedRevision of ['missing', 'a'.repeat(64)]) {
      expect(tengriActionSchema.safeParse({ ...save, expectedRevision }).success).toBe(true)
    }
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

  test('bounds file-search queries by UTF-8 bytes', () => {
    const exact = 'é'.repeat(MAX_FILE_SEARCH_QUERY_BYTES / 2)
    expect(
      tengriActionSchema.safeParse({ action: 'search-files', agentId: 'agent-123', path: '/workspace', query: exact })
        .success,
    ).toBe(true)
    expect(
      tengriActionSchema.safeParse({
        action: 'search-files',
        agentId: 'agent-123',
        path: '/workspace',
        query: `${exact}é`,
      }).success,
    ).toBe(false)
  })
})

describe('Codex image inputs', () => {
  const png = { mediaType: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64') }
  const request = { action: 'send-turn', agentId: 'agent-123', threadId: 'thread-1', text: '' }
  test('accepts image-only and mixed text/image messages', () => {
    expect(tengriActionSchema.safeParse({ ...request, images: [png] }).success).toBe(true)
    expect(tengriActionSchema.safeParse({ ...request, text: 'Inspect this', images: [png] }).success).toBe(true)
    expect(
      tengriActionSchema.safeParse({ ...request, action: 'steer-turn', turnId: 'turn-1', images: [png] }).success,
    ).toBe(true)
    expect(tengriActionSchema.safeParse(request).success).toBe(false)
  })
  test('rejects spoofed formats, malformed base64, remote URLs, and excessive images', () => {
    for (const image of [
      { ...png, mediaType: 'image/jpeg' },
      { ...png, data: 'https://example.test/image.png' },
      { ...png, data: 'not base64' },
      { ...png, mediaType: 'image/svg+xml' },
    ])
      expect(tengriActionSchema.safeParse({ ...request, images: [image] }).success).toBe(false)
    expect(tengriActionSchema.safeParse({ ...request, images: Array(5).fill(png) }).success).toBe(false)
  })
  test('bounds each image and total decoded size', () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024)
    Buffer.from(png.data, 'base64').copy(bytes)
    const exact = { ...png, data: bytes.toString('base64') }
    expect(tengriActionSchema.safeParse({ ...request, images: [exact, exact] }).success).toBe(true)
    expect(tengriActionSchema.safeParse({ ...request, images: [exact, exact, png] }).success).toBe(false)
    expect(
      tengriActionSchema.safeParse({
        ...request,
        images: [{ ...png, data: Buffer.concat([bytes, Buffer.from([0])]).toString('base64') }],
      }).success,
    ).toBe(false)
  })
})
