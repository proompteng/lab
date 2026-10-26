import { describe, expect, test } from 'bun:test'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { accessCommandSchema, type AccessCommand } from './access-schemas'
import { ObservationScopeSchema } from './generated/proompteng/authz/v1/authz_pb'

const collaborator = {
  action: 'collaborator',
  operationId: '11111111-1111-4111-8111-111111111111',
  expectedVersion: '1',
  reason: 'Review workspace diagnostics',
  workspaceUid: '22222222-2222-4222-8222-222222222222',
  login: 'diagnostic-viewer',
  role: 'viewer',
  enabled: true,
} satisfies AccessCommand
const scope = {
  fileRoots: ['/workspace/project'],
  threadIds: ['thread-approved'],
  terminalIds: ['terminal-approved'],
  browserScreenshot: false,
  maxBytes: 1024,
  maxItems: 20,
}

describe('workspace collaborator command boundary', () => {
  test('Viewer content is opt-in and preserves the approved scope exactly', () => {
    expect(accessCommandSchema.parse(collaborator)).not.toHaveProperty('scope')
    expect(accessCommandSchema.parse({ ...collaborator, scope })).toEqual({ ...collaborator, scope })
    const literalScope = {
      ...scope,
      fileRoots: ['/workspace/project '],
      threadIds: [' thread-approved '],
      terminalIds: ['terminal-approved '],
    }
    expect(accessCommandSchema.parse({ ...collaborator, scope: literalScope })).toEqual({
      ...collaborator,
      scope: literalScope,
    })
  })

  test('scope cannot be attached to a Developer or disabled collaborator', () => {
    for (const assignment of [
      { role: 'developer', enabled: true },
      { role: 'viewer', enabled: false },
      { role: 'developer', enabled: false },
    ]) {
      expect(accessCommandSchema.safeParse({ ...collaborator, ...assignment }).success).toBe(true)
      expect(accessCommandSchema.safeParse({ ...collaborator, ...assignment, scope }).success).toBe(false)
    }
  })

  test('Viewer observation remains bounded and rejects injected control fields', () => {
    for (const invalid of [
      { ...scope, maxBytes: 0 },
      { ...scope, maxBytes: 1_048_577 },
      { ...scope, maxItems: 201 },
      { ...scope, fileRoots: Array(17).fill('/workspace/project') },
      { ...scope, threadIds: Array(33).fill('thread-approved') },
      { ...scope, terminalIds: Array(17).fill('terminal-approved') },
      { ...scope, allowExecution: true },
      null,
    ]) {
      expect(accessCommandSchema.safeParse({ ...collaborator, scope: invalid }).success).toBe(false)
    }
  })

  test('file roots must be canonical workspace paths without known credentials', () => {
    for (const root of [
      '/workspace',
      '/workspace/',
      '/workspace//src',
      '/workspace/./src',
      '/workspace/src/../private',
      '/workspace/src\\private',
      '/home/nanoagent/project',
      ...[
        '.ssh',
        '.aws',
        '.kube',
        '.codex',
        '.config',
        '.git',
        '.npmrc',
        '.netrc',
        '.pypirc',
        'credentials.json',
        'auth.json',
        '.env',
        '.env.local',
      ].map((name) => `/workspace/project/${name}`),
    ]) {
      expect(accessCommandSchema.safeParse({ ...collaborator, scope: { ...scope, fileRoots: [root] } }).success).toBe(
        false,
      )
    }
    expect(
      accessCommandSchema.safeParse({
        ...collaborator,
        scope: { ...scope, fileRoots: ['/workspace/project', '/workspace/projects/application'] },
      }).success,
    ).toBe(true)
  })

  test('scope targets reject control characters and IDs reject path separators', () => {
    for (const field of ['fileRoots', 'threadIds', 'terminalIds'] as const) {
      for (const control of ['\n', '\r', '\u001b', '\u007f', '\u0085']) {
        const target = field === 'fileRoots' ? `/workspace/project${control}other` : `approved${control}other`
        expect(accessCommandSchema.safeParse({ ...collaborator, scope: { ...scope, [field]: [target] } }).success).toBe(
          false,
        )
      }
    }
    for (const field of ['threadIds', 'terminalIds'] as const) {
      for (const target of ['other/id', 'other\\id']) {
        expect(accessCommandSchema.safeParse({ ...collaborator, scope: { ...scope, [field]: [target] } }).success).toBe(
          false,
        )
      }
    }
  })

  test('scope string limits use UTF-8 bytes to match central authorization', () => {
    const root = `/workspace/${'é'.repeat(2042)}a`
    expect(new TextEncoder().encode(root)).toHaveLength(4096)
    expect(accessCommandSchema.safeParse({ ...collaborator, scope: { ...scope, fileRoots: [root] } }).success).toBe(
      true,
    )
    expect(
      accessCommandSchema.safeParse({ ...collaborator, scope: { ...scope, fileRoots: [root + 'a'] } }).success,
    ).toBe(false)
    for (const field of ['threadIds', 'terminalIds'] as const) {
      const id = '界'.repeat(42) + 'ab'
      expect(new TextEncoder().encode(id)).toHaveLength(128)
      expect(accessCommandSchema.safeParse({ ...collaborator, scope: { ...scope, [field]: [id] } }).success).toBe(true)
      expect(accessCommandSchema.safeParse({ ...collaborator, scope: { ...scope, [field]: [id + 'a'] } }).success).toBe(
        false,
      )
    }
  })

  test('rejects Unicode that the protobuf encoder would replace instead of preserving the target', () => {
    for (const field of ['fileRoots', 'threadIds', 'terminalIds'] as const) {
      for (const code of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
        const target = (field === 'fileRoots' ? '/workspace/' : '') + String.fromCharCode(code)
        expect(accessCommandSchema.safeParse({ ...collaborator, scope: { ...scope, [field]: [target] } }).success).toBe(
          false,
        )
      }
    }
    const unicodeScope = {
      ...scope,
      fileRoots: ['/workspace/界😀 '],
      threadIds: [' 会話😀 '],
      terminalIds: [' 端末😀 '],
    }
    accessCommandSchema.parse({ ...collaborator, scope: unicodeScope })
    const decoded = fromBinary(
      ObservationScopeSchema,
      toBinary(ObservationScopeSchema, create(ObservationScopeSchema, unicodeScope)),
    )
    expect(decoded).toMatchObject(unicodeScope)
  })

  test('aggregate scope must fit the 64 KiB request budget including JSON overhead', () => {
    const root = `/workspace/${'x'.repeat(4096 - '/workspace/'.length)}`
    const command = { ...collaborator, scope: { ...scope, fileRoots: Array(16).fill(root) } }
    expect(new TextEncoder().encode(JSON.stringify(command)).byteLength).toBeGreaterThan(64 * 1024)
    expect(accessCommandSchema.safeParse(command).success).toBe(false)
  })

  test('command budget counts escaped and multibyte targets', () => {
    const root = `/workspace/${'界"'.repeat(1000)}`
    expect(new TextEncoder().encode(root).byteLength).toBeLessThanOrEqual(4096)
    const command = { ...collaborator, scope: { ...scope, fileRoots: Array(16).fill(root) } }
    expect(new TextEncoder().encode(JSON.stringify(command)).byteLength).toBeGreaterThan(64 * 1024)
    expect(accessCommandSchema.safeParse(command).success).toBe(false)
  })

  test('accepts the exact encoded command limit and rejects one byte more', () => {
    const prefix = '/workspace/'
    const root = prefix + 'x'.repeat(4096 - prefix.length)
    const roots = [...Array<string>(15).fill(root), prefix]
    const command = { ...collaborator, scope: { ...scope, fileRoots: roots } }
    const remaining = 64 * 1024 - new TextEncoder().encode(JSON.stringify(command)).byteLength
    const finalRoot = prefix + 'x'.repeat(remaining)
    roots[15] = finalRoot
    expect(new TextEncoder().encode(JSON.stringify(command)).byteLength).toBe(64 * 1024)
    expect(accessCommandSchema.safeParse(command).success).toBe(true)
    roots[15] = finalRoot + 'x'
    expect(accessCommandSchema.safeParse(command).success).toBe(false)
  })
})
