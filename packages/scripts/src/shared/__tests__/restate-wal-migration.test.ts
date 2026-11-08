import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

const script = new URL('../../../../../argocd/applications/restate/prepare-wal.sh', import.meta.url).pathname

test.each(['retained', 'fresh'] as const)(
  'Restate WAL seeding preserves %s storage through restart',
  (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'restate-wal-'))
    const store = join(root, 'store')
    const wal = join(root, 'wal')
    try {
      mkdirSync(store)
      if (kind === 'retained') {
        writeFileSync(join(store, 'IDENTITY'), 'original-db')
        writeFileSync(join(store, '000100.log'), 'acknowledged records')
        writeFileSync(join(store, '000099.sst'), 'table data')
      }
      const run = () => Bun.spawnSync(['/bin/sh', script, store, wal], { stdout: 'pipe', stderr: 'pipe' })
      expect(run().exitCode).toBe(0)
      if (kind === 'retained') {
        expect(readFileSync(join(wal, '000100.log'), 'utf8')).toBe('acknowledged records')
        expect(Bun.file(join(wal, '000099.sst')).size).toBe(0)
        expect(readFileSync(join(store, '000100.log'), 'utf8')).toBe('acknowledged records')
      } else {
        writeFileSync(join(store, 'IDENTITY'), 'new-db')
      }
      writeFileSync(join(wal, '000100.log'), 'new acknowledged records')
      expect(run().exitCode).toBe(0)
      expect(readFileSync(join(wal, '000100.log'), 'utf8')).toBe('new acknowledged records')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  30_000,
)

test('Restate WAL seeding resumes an interrupted copy and refuses another database identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'restate-wal-'))
  const store = join(root, 'store')
  const wal = join(root, 'wal')
  try {
    mkdirSync(store)
    mkdirSync(wal)
    writeFileSync(join(store, 'IDENTITY'), 'original-db')
    writeFileSync(join(store, '000100.log'), 'complete records')
    writeFileSync(join(wal, '.initializing'), 'original-db')
    writeFileSync(join(wal, '000100.log'), 'partial')
    const run = () => Bun.spawnSync(['/bin/sh', script, store, wal], { stdout: 'pipe', stderr: 'pipe' })
    expect(run().exitCode).toBe(0)
    expect(readFileSync(join(wal, '000100.log'), 'utf8')).toBe('complete records')
    writeFileSync(join(store, 'IDENTITY'), 'another-db')
    expect(run().exitCode).not.toBe(0)
    expect(readFileSync(join(wal, '000100.log'), 'utf8')).toBe('complete records')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test.each(['retained', 'fresh'] as const)(
  'Restate WAL seeding retries a partial %s identity receipt',
  (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'restate-wal-'))
    const store = join(root, 'store')
    const wal = join(root, 'wal')
    try {
      mkdirSync(store)
      mkdirSync(wal)
      writeFileSync(join(wal, '.identity.tmp'), 'partial identity')
      if (kind === 'retained') {
        writeFileSync(join(store, 'IDENTITY'), 'original-db')
        writeFileSync(join(store, '000100.log'), 'acknowledged records')
      }
      const result = Bun.spawnSync(['/bin/sh', script, store, wal], { stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode).toBe(0)
      expect(readFileSync(join(wal, '.restate-source-identity'), 'utf8')).toBe(kind === 'retained' ? 'original-db' : '')
      if (kind === 'retained') {
        expect(readFileSync(join(wal, '000100.log'), 'utf8')).toBe('acknowledged records')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  30_000,
)

test('Restate WAL seeding refuses unrecognized target files and incomplete retained storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'restate-wal-'))
  const store = join(root, 'store')
  const wal = join(root, 'wal')
  try {
    mkdirSync(store)
    mkdirSync(wal)
    writeFileSync(join(store, 'IDENTITY'), 'original-db')
    writeFileSync(join(wal, '000100.log'), 'foreign records')
    const run = () => Bun.spawnSync(['/bin/sh', script, store, wal], { stdout: 'pipe', stderr: 'pipe' })
    expect(run().exitCode).not.toBe(0)
    expect(readFileSync(join(wal, '000100.log'), 'utf8')).toBe('foreign records')
    rmSync(wal, { recursive: true })
    rmSync(join(store, 'IDENTITY'))
    writeFileSync(join(store, '000100.log'), 'retained records')
    expect(run().exitCode).not.toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
