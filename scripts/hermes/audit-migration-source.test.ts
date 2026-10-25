import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { auditMigrationSource } from './audit-migration-source'

const temporaryRoots: string[] = []

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hermes-migration-audit-'))
  temporaryRoots.push(root)
  await mkdir(join(root, 'workspace', 'memory'), { recursive: true })
  await mkdir(join(root, 'workspace', 'skills'), { recursive: true })
  await writeFile(join(root, 'workspace', 'USER.md'), 'Safe user profile content.\n')
  await writeFile(join(root, 'workspace', 'MEMORY.md'), 'Safe memory note. API tokens are never stored here.\n')
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenClaw migration source audit', () => {
  test('rejects an empty source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-migration-audit-'))
    temporaryRoots.push(root)
    await mkdir(join(root, 'workspace'))

    expect((await auditMigrationSource(root)).issues).toContainEqual({
      path: '.',
      reason: 'source contains no approved files',
    })
  })

  test('accepts allowlisted UTF-8 user data', async () => {
    const root = await makeFixture()
    await writeFile(join(root, 'workspace', 'skills', 'example.md'), 'A safe skill with no credentials.\n')

    const result = await auditMigrationSource(root)
    expect(result.files).toBe(3)
    expect(result.totalBytes).toBeGreaterThan(0)
    expect(result.issues).toEqual([])
  })

  test('rejects a missing required user profile', async () => {
    const root = await makeFixture()
    await rm(join(root, 'workspace', 'USER.md'))

    expect((await auditMigrationSource(root)).issues).toContainEqual({
      path: 'workspace/USER.md',
      reason: 'required migration path is missing',
    })
  })

  test('rejects GitOps-owned identity and policy files', async () => {
    const root = await makeFixture()
    await writeFile(join(root, 'workspace', 'AGENTS.md'), 'Unsafe source policy.\n')

    expect((await auditMigrationSource(root)).issues).toContainEqual({
      path: 'workspace/AGENTS.md',
      reason: 'path is outside the approved user-data allowlist',
    })
  })

  test('rejects credentials without returning their value', async () => {
    const root = await makeFixture()
    const credential = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'
    await writeFile(join(root, 'workspace', 'memory', 'innocent.md'), `api_key = ${credential}\n`)

    const result = await auditMigrationSource(root)
    expect(result.issues).toContainEqual({ path: 'workspace/memory/innocent.md', reason: 'provider credential' })
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  test('rejects credential-bearing connection URLs without returning them', async () => {
    const root = await makeFixture()
    const credential = 'postgresql://hermes:super-secret-password@database.example/hermes'
    await writeFile(join(root, 'workspace', 'memory', 'database.md'), `${credential}\n`)

    const result = await auditMigrationSource(root)
    expect(result.issues).toContainEqual({
      path: 'workspace/memory/database.md',
      reason: 'credential-bearing connection URL',
    })
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  test('rejects bare high-entropy values without returning them', async () => {
    const root = await makeFixture()
    const credential = '0123456789abcdef'.repeat(4)
    await writeFile(join(root, 'workspace', 'memory', 'key.txt'), `${credential}\n`)

    const result = await auditMigrationSource(root)
    expect(result.issues).toContainEqual({
      path: 'workspace/memory/key.txt',
      reason: 'opaque high-entropy value',
    })
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  test('rejects high-entropy filenames without returning them', async () => {
    const root = await makeFixture()
    const credential = 'fedcba9876543210'.repeat(4)
    await writeFile(join(root, 'workspace', 'memory', credential), 'Benign content.\n')

    const result = await auditMigrationSource(root)
    expect(result.issues).toContainEqual({
      path: 'workspace/memory/[redacted-credential-component]',
      reason: 'credential-like path component is forbidden',
    })
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  test('rejects symlinks without following them', async () => {
    const root = await makeFixture()
    await symlink('/etc/passwd', join(root, 'workspace', 'memory', 'profile.md'))

    expect((await auditMigrationSource(root)).issues).toContainEqual({
      path: 'workspace/memory/profile.md',
      reason: 'symbolic links are forbidden',
    })
  })

  test('rejects paths outside the non-secret allowlist', async () => {
    const root = await makeFixture()
    await mkdir(join(root, 'workspace', '.openclaw'))
    await writeFile(join(root, 'workspace', '.openclaw', 'openclaw.json'), '{}')

    const issues = (await auditMigrationSource(root)).issues
    expect(issues).toContainEqual({
      path: 'workspace/.openclaw',
      reason: 'path is outside the approved user-data allowlist',
    })
    expect(issues).toContainEqual({
      path: 'workspace/.openclaw',
      reason: 'credential, session, or log path is forbidden',
    })
  })

  test('rejects binary files that cannot be content-audited', async () => {
    const root = await makeFixture()
    await writeFile(join(root, 'workspace', 'skills', 'opaque.bin'), new Uint8Array([1, 0, 2]))

    expect((await auditMigrationSource(root)).issues).toContainEqual({
      path: 'workspace/skills/opaque.bin',
      reason: 'binary content is forbidden',
    })
  })
})
