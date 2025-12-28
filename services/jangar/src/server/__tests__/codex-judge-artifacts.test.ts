import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractImplementationManifestFromArchive } from '~/server/codex-judge-artifacts'

const createArchive = async (bundleDir: string, archivePath: string) => {
  await new Promise<void>((resolve, reject) => {
    const tarProcess = spawn('tar', ['-czf', archivePath, '-C', bundleDir, '.'])
    tarProcess.on('error', reject)
    tarProcess.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`tar exited with status ${code}`))
      }
    })
  })
  return archivePath
}

describe('extractImplementationManifestFromArchive', () => {
  it('parses manifest metadata from implementation-changes archive', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-judge-manifest-'))
    try {
      const bundleDir = join(tempDir, 'bundle')
      const metadataDir = join(bundleDir, 'metadata')
      await mkdir(metadataDir, { recursive: true })
      const manifest = {
        repository: 'owner/repo',
        issueNumber: '42',
        prompt: 'Ship it',
        sessionId: 'session-abc',
        commitSha: 'abc1234',
      }
      await writeFile(join(metadataDir, 'manifest.json'), JSON.stringify(manifest), 'utf8')

      const archivePath = join(tempDir, 'implementation-changes.tgz')
      await createArchive(bundleDir, archivePath)
      const archiveBuffer = await readFile(archivePath)

      const parsed = await extractImplementationManifestFromArchive(archiveBuffer)

      expect(parsed).toEqual({
        repository: 'owner/repo',
        issueNumber: 42,
        prompt: 'Ship it',
        sessionId: 'session-abc',
        commitSha: 'abc1234',
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
