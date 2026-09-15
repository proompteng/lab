import { expect, test, vi } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFiles } from './fs'
import { createSigintHandler } from './index'
import type { GeneratedFile } from './templates/tanstack/types'

const tmp = () => mkdtempSync('/tmp/schematic-')

test('writeFiles writes contents and respects force flag', async () => {
  const dir = tmp()
  const files: GeneratedFile[] = [{ path: 'foo/bar.txt', contents: 'hello' }]

  await writeFiles(files, { root: dir })
  expect(readFileSync(join(dir, 'foo/bar.txt'), 'utf8')).toBe('hello')

  await expect(writeFiles(files, { root: dir })).rejects.toThrow(/Refusing to overwrite/)
  await writeFiles(files, { root: dir, force: true })

  await rm(dir, { recursive: true, force: true })
})

test('writeFiles dry-run does not create files', async () => {
  const dir = tmp()
  const files: GeneratedFile[] = [{ path: 'noop.txt', contents: 'noop' }]

  await writeFiles(files, { root: dir, dryRun: true })
  expect(() => readFileSync(join(dir, 'noop.txt'), 'utf8')).toThrow()

  await rm(dir, { recursive: true, force: true })
})

test('createSigintHandler cancels and exits on SIGINT', () => {
  const cancelMock = vi.fn()
  const exitMock = vi.fn()

  const detach = createSigintHandler(cancelMock, exitMock as unknown as (code?: number) => never)

  process.emit('SIGINT')

  expect(cancelMock).toHaveBeenCalledWith('Aborted')
  expect(exitMock).toHaveBeenCalledWith(1)

  detach()
})
