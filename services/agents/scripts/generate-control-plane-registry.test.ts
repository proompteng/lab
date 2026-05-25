import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { controlPlanePrimitiveKinds } from '../src/control-plane/primitive-registry.generated'
import { listPrimitiveKinds } from '../src/server/control-plane-primitive-kinds'
import { loadPrimitiveRegistryEntries, resolvePrimitiveRegistryEntries } from './generate-control-plane-registry'

describe('control-plane primitive registry generation', () => {
  it('extracts every chart CRD and matches control-plane primitive kinds', async () => {
    const entries = await loadPrimitiveRegistryEntries()
    const kinds = entries.map((entry) => entry.kind).sort()
    const expectedKinds = listPrimitiveKinds({ includeSwarm: true }).sort()

    expect(kinds).toEqual(expectedKinds)
    expect(controlPlanePrimitiveKinds.slice().sort()).toEqual(expectedKinds)
  })

  it('allows pruned Docker contexts to use the committed generated registry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-control-plane-registry-'))
    const generatedFile = join(directory, 'primitive-registry.generated.ts')
    await writeFile(generatedFile, 'export const controlPlanePrimitiveRegistry = []\n')

    try {
      await expect(resolvePrimitiveRegistryEntries(join(directory, 'missing-crds'), generatedFile)).resolves.toBeNull()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
