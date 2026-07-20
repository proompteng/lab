import { readFileSync } from 'node:fs'

import { expect, it } from 'bun:test'
import YAML from 'yaml'

import { loadEnabledAppInventory } from '../enabled-apps'

const baselineFiles = [
  'packages/scripts/src/shared/__tests__/fixtures/enabled-apps/bootstrap.yaml',
  'packages/scripts/src/shared/__tests__/fixtures/enabled-apps/helm-apps.yaml',
  'packages/scripts/src/shared/__tests__/fixtures/enabled-apps/platform.yaml',
  'packages/scripts/src/shared/__tests__/fixtures/enabled-apps/product.yaml',
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const collectEnabledNames = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(collectEnabledNames)
  if (!isRecord(value)) return []

  const elementNames = Array.isArray(value.elements)
    ? value.elements.flatMap((element) =>
        isRecord(element) && element.enabled === 'true' && typeof element.name === 'string' ? [element.name] : [],
      )
    : []
  return [...elementNames, ...Object.values(value).flatMap(collectEnabledNames)]
}

const baselineNames = new Set(
  baselineFiles.flatMap((path) =>
    YAML.parseAllDocuments(readFileSync(path, 'utf8')).flatMap((document) => collectEnabledNames(document.toJSON())),
  ),
)

it('preserves every established enabled ApplicationSet entry', () => {
  const currentNames = new Set(
    loadEnabledAppInventory()
      .entries.filter((entry) => entry.sourceKind === 'applicationset-element')
      .map((entry) => entry.name),
  )

  expect(baselineNames.size).toBeGreaterThanOrEqual(68)
  for (const name of baselineNames) expect(currentNames).toContain(name)
})
