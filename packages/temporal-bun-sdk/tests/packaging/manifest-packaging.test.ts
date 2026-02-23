import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

type TemporalSdkPackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  bin?: Record<string, string>
}

const loadPackageJson = async (): Promise<TemporalSdkPackageJson> => {
  const packageJsonPath = join(import.meta.dir, '../../package.json')
  const packageJsonRaw = await readFile(packageJsonPath, 'utf8')
  return JSON.parse(packageJsonRaw) as TemporalSdkPackageJson
}

describe('temporal-bun-sdk packaging manifest', () => {
  test('avoids workspace protocol dependencies in published runtime deps', async () => {
    const packageJson = await loadPackageJson()
    const dependencies = packageJson.dependencies ?? {}

    for (const [dependencyName, version] of Object.entries(dependencies)) {
      expect(version.startsWith('workspace:')).toBeFalse()
      expect(dependencyName).not.toBe('@proompteng/otel')
    }
  })

  test('keeps typescript as runtime dependency for workflow-lint CLI path', async () => {
    const packageJson = await loadPackageJson()
    const dependencies = packageJson.dependencies ?? {}
    const devDependencies = packageJson.devDependencies ?? {}

    expect(dependencies.typescript).toBeDefined()
    expect(devDependencies.typescript).toBeUndefined()
  })

  test('publishes CLI bins from dist/src output paths', async () => {
    const packageJson = await loadPackageJson()
    const bins = packageJson.bin ?? {}

    expect(bins['temporal-bun']).toBe('./dist/src/bin/temporal-bun.js')
    expect(bins['temporal-bun-skill']).toBe('./dist/src/bin/temporal-bun-skill.js')
    expect(bins['temporal-bun-worker']).toBe('./dist/src/bin/start-worker.js')
  })
})
