import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

const repositoryRoot = resolve(import.meta.dir, '../../../..')
const baynRoot = resolve(repositoryRoot, 'services/bayn')

const sourceFiles = readdirSync(resolve(baynRoot, 'src'), { recursive: true })
  .map(String)
  .filter((path) => path.endsWith('.ts'))

describe('Bayn production surface', () => {
  test('keeps dormant candidate orchestration and scheduled qualification out of the repository', () => {
    expect(sourceFiles.filter((path) => path.includes('candidate-development'))).toEqual([])
    expect(sourceFiles.filter((path) => path.includes('qualification-audit-command'))).toEqual([])
    expect(sourceFiles.filter((path) => path.includes('qualification-collector-command'))).toEqual([])
    const candidateFiles = existsSync(resolve(baynRoot, 'candidates'))
      ? readdirSync(resolve(baynRoot, 'candidates'), { recursive: true })
      : []
    expect(candidateFiles).toEqual([])
    expect(existsSync(resolve(repositoryRoot, '.github/workflows/bayn-qualification.yml'))).toBe(false)
    expect(existsSync(resolve(repositoryRoot, '.github/workflows/bayn-paper-activation.yml'))).toBe(false)
  })

  test('builds and packages only the service and forward-performance entrypoints', () => {
    const packageManifest = JSON.parse(readFileSync(resolve(baynRoot, 'package.json'), 'utf8')) as {
      readonly scripts: Readonly<Record<string, string>>
    }
    const image = readFileSync(resolve(repositoryRoot, 'nix/images/bayn.nix'), 'utf8')

    expect(packageManifest.scripts.build).toBe(
      'bun build src/index.ts src/forward-performance-command.ts --target=node --external tigerbeetle-node --outdir=dist',
    )
    expect(packageManifest.scripts['candidate:development:local']).toBeUndefined()
    expect(packageManifest.scripts['audit:qualification']).toBeUndefined()
    expect(packageManifest.scripts['collect:qualification']).toBeUndefined()
    expect(image).toContain('includeBunRuntime = false;')
    expect(image).not.toContain('qualification-audit-command')
    expect(image).not.toContain('qualification-collector-command')
    expect(image).not.toContain('pkgs.git')
  })
})
