import { describe, expect, test } from 'bun:test'
import {
  MAX_CODEX_PROMPT_BYTES,
  MAX_EDITABLE_FILE_BYTES,
  MAX_FILE_SEARCH_QUERY_BYTES,
  tengriActionSchema,
} from './schemas'

function accepts(input: unknown) {
  expect(tengriActionSchema.safeParse(input).success).toBe(true)
}

function rejects(input: unknown) {
  expect(tengriActionSchema.safeParse(input).success).toBe(false)
}

describe('Tengri BFF action schema', () => {
  test('scopes active-run reads to a validated conversation without changing workspace reads', () => {
    const action = { action: 'active-codex-runs', agentId: 'agent-test' } as const
    expect(tengriActionSchema.parse(action)).toEqual(action)
    expect(tengriActionSchema.parse({ ...action, threadId: 'thread-selected' })).toEqual({
      ...action,
      threadId: 'thread-selected',
    })
    for (const threadId of ['', ' ', '../other', 'x'.repeat(161), null]) {
      rejects({ ...action, threadId })
    }
    rejects({ ...action, ownerHash: 'other' })
  })

  test('power settings enforce integer idle limits and reject modes that retain RAM', () => {
    const action = { action: 'update-power-settings', agentId: 'agent-test' }
    for (const idleTimeoutMinutes of [0, 5, 60, 1440]) {
      accepts({ ...action, power: { idleTimeoutMinutes } })
    }
    for (const idleTimeoutMinutes of [-1, 0.5, 1441, '60', null]) {
      rejects({ ...action, power: { idleTimeoutMinutes } })
    }
    rejects({ ...action, power: { sleepMode: 'hibernate', idleTimeoutMinutes: 60 } })
    rejects({
      ...action,
      power: { idleTimeoutMinutes: 60, ownerHash: 'other' },
    })
  })
  test('accepts model options when creating threads or sending turns and rejects invalid choices', () => {
    for (const action of [
      { action: 'create-thread', agentId: 'agent-test' },
      {
        action: 'send-turn',
        operationId: '11111111-1111-4111-8111-111111111111',
        agentId: 'agent-test',
        threadId: 'thread-test',
        text: 'Read the workspace',
      },
    ]) {
      accepts({ ...action, model: 'gpt-6.2-sol', reasoningEffort: 'high' })
      rejects({ ...action, model: 'gpt-6.2-sol\n' })
      rejects({ ...action, reasoningEffort: 'unbounded' })
    }
  })

  test('history reads accept only the conversation identity', () => {
    const action = { action: 'resume-thread', agentId: 'agent-test', threadId: 'thread-test' }
    accepts(action)
    rejects({ ...action, model: 'gpt-6.2-sol' })
    rejects({ ...action, reasoningEffort: 'high' })
  })

  test('editor logout revocation cannot select another owner', () => {
    accepts({ action: 'revoke-editor-sessions' })
    rejects({ action: 'revoke-editor-sessions', ownerId: 'someone-else' })
  })

  test('validates editor window identity and rejects editor ports in ordinary previews', () => {
    rejects({ action: 'browser-session', agentId: 'agent-test' })
    accepts({
      action: 'browser-session',
      agentId: 'agent-test',
      windowId: 'desktop-stable-chrome-window',
      renewal: false,
    })
    const editor = {
      action: 'editor-session',
      agentId: 'agent-test',
      windowId: 'desktop-stable-code-window',
      renewal: false,
    }
    accepts(editor)
    for (const windowId of ['short', '../arbitrary-window-path', 'a'.repeat(129)]) {
      rejects({ ...editor, windowId })
    }
    for (const port of [13337, 13338, 13339]) {
      rejects({
        action: 'preview-session',
        agentId: 'agent-test',
        port,
        path: '/',
        fragment: '',
      })
    }
  })

  test('CreateAgent requires a stable operation ID, accepts a display name and rejects resource escalation fields', () => {
    const creation = {
      action: 'create-agent',
      operationId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Tengri',
    }
    accepts(creation)
    rejects({ ...creation, operationId: undefined })
    rejects({ ...creation, resources: { cpuMillis: 64_000, memoryMib: 262_144 } })
    accepts({ ...creation, displayName: 'a'.repeat(64) })
    rejects({ ...creation, displayName: 'a'.repeat(65) })
  })

  test('constrains terminal geometry, approval decisions, and preview ports', () => {
    const terminal = {
      action: 'create-terminal',
      agentId: 'agent-123',
      creationId: 'terminal-creation-123',
      cwd: '/workspace',
      columns: 120,
      rows: 32,
    }
    accepts(terminal)
    rejects({ ...terminal, columns: 10_000, rows: 24 })
    rejects({ ...terminal, creationId: 'bad creation id' })

    const approval = {
      action: 'resolve-approval',
      runId: '11111111-1111-4111-8111-111111111111',
      operationId: '22222222-2222-4222-8222-222222222222',
      agentId: 'agent-123',
      approvalId: 'approval-1',
    }
    for (const decision of ['approve-exec-policy-amendment', 'approve-network-policy-amendment']) {
      accepts({ ...approval, decision })
    }
    rejects({ ...approval, decision: 'always-approve' })

    const preview = { action: 'preview-session', agentId: 'agent-123', port: 4321, path: '/', fragment: '' }
    const exact = 'é'.repeat(2047) + 'x'
    accepts({ ...preview, path: '/app?mode=dev', fragment: '#editor' })
    rejects({ action: 'preview-session', agentId: preview.agentId, port: 22 })
    rejects({ ...preview, port: 8080, fragment: undefined })
    for (const path of ['https://example.test/app', '/app#ticket', '/app\u0000private', `/${exact}é`]) {
      rejects({ ...preview, path })
    }
    for (const fragment of ['editor', '#editor\nprivate', `#${'é'.repeat(2048)}`]) {
      rejects({ ...preview, fragment })
    }
    accepts({ ...preview, path: `/${exact}` })
    accepts({ ...preview, fragment: `#${exact}` })

    const revoke = {
      action: 'revoke-preview-session',
      agentId: 'agent-123',
      sessionId: 'abc123abc123abc123abc123',
      revocationToken: 'a'.repeat(43),
    }
    accepts(revoke)
    rejects({ ...revoke, sessionId: 'not-a-session-id' })
    rejects({ ...revoke, revocationToken: undefined })
  })

  test('requires absolute clean file paths and rejects undeclared action fields', () => {
    for (const path of [
      'workspace/file.ts',
      '/',
      '/lab/README.md',
      '/workspace-other/report.txt',
      '/workspace/',
      '/workspace//report.txt',
      '/workspace/../report.txt',
      '/workspace/./report.txt',
      '/workspace/file.ts\u0000secret',
      '/workspace/file.ts\nnext',
    ]) {
      rejects({ action: 'read-file', agentId: 'agent-123', path })
    }
    rejects({
      action: 'read-file',
      agentId: 'agent-123',
      path: '/workspace/file.ts',
      impersonateSubject: 'github:999',
    })
  })

  test('preserves whitespace in valid paths and bounds files by encoded bytes', () => {
    const spacedPath = '/workspace/report '
    const parsed = tengriActionSchema.safeParse({ action: 'read-file', agentId: 'agent-123', path: spacedPath })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.action === 'read-file') expect(parsed.data.path).toBe(spacedPath)

    const exact = 'é'.repeat(MAX_EDITABLE_FILE_BYTES / 2)
    accepts({
      action: 'write-file',
      agentId: 'agent-123',
      path: spacedPath,
      content: exact,
      expectedRevision: 'missing',
    })
    rejects({
      action: 'write-file',
      agentId: 'agent-123',
      path: spacedPath,
      content: `${exact}é`,
      expectedRevision: 'missing',
    })
  })

  test('requires a precise file revision or create-only precondition for saves', () => {
    const save = { action: 'write-file', agentId: 'agent-123', path: '/workspace/main.ts', content: '' }
    rejects(save)
    for (const expectedRevision of ['', '*', 'A'.repeat(64), 'f'.repeat(63), 'missing ']) {
      rejects({ ...save, expectedRevision })
    }
    for (const expectedRevision of ['missing', 'a'.repeat(64)]) {
      accepts({ ...save, expectedRevision })
    }
  })

  test('bounds Codex prompts by UTF-8 bytes', () => {
    const exact = '🙂'.repeat(MAX_CODEX_PROMPT_BYTES / 4)
    accepts({
      action: 'send-turn',
      operationId: '11111111-1111-4111-8111-111111111111',
      agentId: 'agent-123',
      threadId: 'thread-1',
      text: exact,
    })
    rejects({
      action: 'steer-turn',
      runId: '11111111-1111-4111-8111-111111111111',
      operationId: '11111111-1111-4111-8111-111111111111',
      agentId: 'agent-123',
      threadId: 'thread-1',
      turnId: 'turn-1',
      text: `${exact}🙂`,
    })
  })

  test('bounds file-search queries by UTF-8 bytes', () => {
    const exact = 'é'.repeat(MAX_FILE_SEARCH_QUERY_BYTES / 2)
    accepts({ action: 'search-files', agentId: 'agent-123', path: '/workspace', query: exact })
    rejects({
      action: 'search-files',
      agentId: 'agent-123',
      path: '/workspace',
      query: `${exact}é`,
    })
  })
})

describe('Codex image inputs', () => {
  const png = { mediaType: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64') }
  const request = {
    action: 'send-turn',
    operationId: '11111111-1111-4111-8111-111111111111',
    agentId: 'agent-123',
    threadId: 'thread-1',
    text: '',
  }
  test('accepts image-only and mixed text/image messages', () => {
    accepts({ ...request, images: [png] })
    accepts({ ...request, text: 'Inspect this', images: [png] })
    accepts({
      ...request,
      action: 'steer-turn',
      runId: '11111111-1111-4111-8111-111111111111',
      operationId: '11111111-1111-4111-8111-111111111111',
      turnId: 'turn-1',
      images: [png],
    })
    rejects(request)
  })
  test('rejects spoofed formats, malformed base64, remote URLs, and excessive images', () => {
    for (const image of [
      { ...png, mediaType: 'image/jpeg' },
      { ...png, data: 'https://example.test/image.png' },
      { ...png, data: 'not base64' },
      { ...png, mediaType: 'image/svg+xml' },
    ])
      rejects({ ...request, images: [image] })
    rejects({ ...request, images: Array(5).fill(png) })
  })
  test('bounds each image and total decoded size', () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024)
    Buffer.from(png.data, 'base64').copy(bytes)
    const exact = { ...png, data: bytes.toString('base64') }
    accepts({ ...request, images: [exact, exact] })
    rejects({ ...request, images: [exact, exact, png] })
    rejects({
      ...request,
      images: [{ ...png, data: Buffer.concat([bytes, Buffer.from([0])]).toString('base64') }],
    })
  })
})

test('run recovery binds an explicit run and stable control identity', () => {
  const action = {
    action: 'recover-run',
    agentId: 'agent-test',
    runId: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222',
  }
  accepts(action)
  rejects({ ...action, operationId: undefined })
  rejects({ ...action, runId: 'other' })
  rejects({ ...action, sessionId: 'caller-session' })
})
