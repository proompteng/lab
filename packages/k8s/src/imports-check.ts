import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { repoRoot } from './synth'

const packageDirectory = resolve(repoRoot, 'packages/k8s')
const trackedImports = join(packageDirectory, 'src/imports')
const cdk8sBinary = join(packageDirectory, 'node_modules/.bin/cdk8s')

const runImport = (outputDirectory: string, specification: string) => {
  const result = Bun.spawnSync(
    [
      cdk8sBinary,
      'import',
      specification,
      '--language',
      'typescript',
      '--output',
      outputDirectory,
      '--no-save',
      '--no-check-upgrade',
    ],
    { cwd: packageDirectory, stdout: 'inherit', stderr: 'inherit' },
  )
  if (result.exitCode !== 0) throw new Error(`cdk8s import ${specification} failed with exit code ${result.exitCode}`)
}

export const checkImports = () => {
  if (!existsSync(cdk8sBinary)) throw new Error(`Pinned cdk8s CLI not found at ${cdk8sBinary}; run bun install first`)

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cdk8s-imports-'))
  try {
    runImport(temporaryDirectory, 'k8s@1.35.0')
    runImport(temporaryDirectory, 'crds/traefik-41.0.1.yaml')

    const expectedFiles = ['k8s.ts', 'traefik.io.ts']
    const actualFiles = readdirSync(temporaryDirectory).sort()
    const trackedFiles = readdirSync(trackedImports).sort()
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Unexpected generated import files: ${actualFiles.join(', ')}`)
    }
    if (JSON.stringify(trackedFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Tracked import file set is stale: ${trackedFiles.join(', ')}`)
    }

    for (const file of expectedFiles) {
      const generated = readFileSync(join(temporaryDirectory, file), 'utf8').replace(/\n+$/, '\n')
      const tracked = readFileSync(join(trackedImports, file))
      if (!Buffer.from(generated).equals(tracked)) {
        throw new Error(`Imported API definition is stale: src/imports/${file}`)
      }
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
