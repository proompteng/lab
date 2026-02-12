import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const IMPLEMENTATION_SPECS_PATH = fileURLToPath(
  new URL('../../../../../docs/torghut/design-system/v3/full-loop/templates/implementationspecs.yaml', import.meta.url),
)
const AGENT_RUNS_PATH = fileURLToPath(
  new URL('../../../../../docs/torghut/design-system/v3/full-loop/templates/agentruns.yaml', import.meta.url),
)

const REQUIRED_KEYS_BY_SPEC = new Map<string, string[]>([
  ['torghut-v3-research-intake-v1', ['researchPrompt', 'universe', 'featureSchemaVersion', 'outputPath']],
  ['torghut-v3-candidate-build-v1', ['repository', 'base', 'head', 'candidateSpecPath', 'strategyCatalogPath']],
  [
    'torghut-v3-backtest-robustness-v1',
    ['datasetSnapshotId', 'strategyId', 'strategyVersion', 'costModelVersion', 'artifactPath'],
  ],
  ['torghut-v3-gate-evaluation-v1', ['gateConfigPath', 'metricsBundlePath', 'artifactPath']],
  ['torghut-v3-shadow-paper-run-v1', ['torghutNamespace', 'gitopsPath', 'strategyConfigPatchPath', 'evaluationWindow']],
  ['torghut-v3-live-ramp-v1', ['torghutNamespace', 'gitopsPath', 'rampStage', 'confirm']],
  ['torghut-v3-incident-recovery-v1', ['torghutNamespace', 'incidentId', 'rollbackTarget', 'confirm']],
  ['torghut-v3-audit-pack-v1', ['runId', 'artifactRefs', 'complianceProfile', 'outputPath']],
])

const CATALOG_OPS_SPEC = 'torghut-v3-implspec-catalog-ops-v1'
const CATALOG_OPS_REQUIRED_KEYS = ['repository', 'base', 'head', 'catalogPath']

const splitYamlDocs = (content: string) =>
  content
    .split(/^---\s*$/m)
    .map((doc) => doc.trim())
    .filter((doc) => doc.length > 0)

const countIndent = (line: string): number => {
  const match = line.match(/^ */)
  return match ? match[0].length : 0
}

const getMappingValue = (lines: string[], path: string[]): string | null => {
  let start = 0
  let end = lines.length
  let indent = 0

  for (let index = 0; index < path.length; index += 1) {
    const key = path[index]
    let keyLineIndex = -1
    for (let i = start; i < end; i += 1) {
      const line = lines[i]
      if (!line) continue
      if (countIndent(line) !== indent) continue
      if (line.trim() === `${key}:`) {
        keyLineIndex = i
        break
      }
      if (line.trim().startsWith(`${key}: `)) {
        return line.trim().slice(`${key}: `.length).trim()
      }
    }
    if (keyLineIndex === -1) return null

    start = keyLineIndex + 1
    end = lines.length
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line) continue
      if (countIndent(line) <= indent) {
        end = i
        break
      }
    }
    indent += 2
  }

  return null
}

const getListValues = (lines: string[], path: string[]): string[] => {
  let start = 0
  let end = lines.length
  let indent = 0

  for (const key of path) {
    let keyLineIndex = -1
    for (let i = start; i < end; i += 1) {
      const line = lines[i]
      if (!line) continue
      if (countIndent(line) !== indent) continue
      if (line.trim() === `${key}:`) {
        keyLineIndex = i
        break
      }
    }
    if (keyLineIndex === -1) return []

    start = keyLineIndex + 1
    end = lines.length
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line) continue
      if (countIndent(line) <= indent) {
        end = i
        break
      }
    }
    indent += 2
  }

  const values: string[] = []
  for (let i = start; i < end; i += 1) {
    const line = lines[i]
    if (!line) continue
    if (countIndent(line) !== indent) continue
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      values.push(trimmed.slice(2).trim())
    }
  }
  return values
}

const getMapKeys = (lines: string[], path: string[]): string[] => {
  let start = 0
  let end = lines.length
  let indent = 0

  for (const key of path) {
    let keyLineIndex = -1
    for (let i = start; i < end; i += 1) {
      const line = lines[i]
      if (!line) continue
      if (countIndent(line) !== indent) continue
      if (line.trim() === `${key}:`) {
        keyLineIndex = i
        break
      }
    }
    if (keyLineIndex === -1) return []

    start = keyLineIndex + 1
    end = lines.length
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line) continue
      if (countIndent(line) <= indent) {
        end = i
        break
      }
    }
    indent += 2
  }

  const keys: string[] = []
  for (let i = start; i < end; i += 1) {
    const line = lines[i]
    if (!line) continue
    if (countIndent(line) !== indent) continue
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) continue
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex <= 0) continue
    keys.push(trimmed.slice(0, colonIndex))
  }
  return keys
}

describe('Torghut v3 full-loop catalog templates', () => {
  it('keeps canonical ImplementationSpec names and required keys aligned', () => {
    const docs = splitYamlDocs(readFileSync(IMPLEMENTATION_SPECS_PATH, 'utf8'))
    const requiredKeysBySpec = new Map<string, string[]>()

    for (const doc of docs) {
      const lines = doc.split('\n')
      const kind = getMappingValue(lines, ['kind'])
      if (kind !== 'ImplementationSpec') continue
      const name = getMappingValue(lines, ['metadata', 'name'])
      if (!name) continue
      const requiredKeys = getListValues(lines, ['spec', 'contract', 'requiredKeys'])
      requiredKeysBySpec.set(name, requiredKeys)
    }

    for (const [name, requiredKeys] of REQUIRED_KEYS_BY_SPEC) {
      expect(requiredKeysBySpec.has(name), `missing ImplementationSpec ${name}`).toBe(true)
      expect(requiredKeysBySpec.get(name)).toEqual(requiredKeys)
    }

    expect(requiredKeysBySpec.get(CATALOG_OPS_SPEC)).toEqual(CATALOG_OPS_REQUIRED_KEYS)
  })

  it('provides AgentRun coverage and required-key parameters for each catalog spec', () => {
    const docs = splitYamlDocs(readFileSync(AGENT_RUNS_PATH, 'utf8'))
    const seenSpecs = new Set<string>()
    const seenRunNames = new Set<string>()

    for (const doc of docs) {
      const lines = doc.split('\n')
      const kind = getMappingValue(lines, ['kind'])
      if (kind !== 'AgentRun') continue

      const runName = getMappingValue(lines, ['metadata', 'name'])
      if (runName) {
        expect(seenRunNames.has(runName), `duplicate AgentRun metadata.name ${runName}`).toBe(false)
        seenRunNames.add(runName)
      }

      const specName = getMappingValue(lines, ['spec', 'implementationSpecRef', 'name'])
      if (!specName) continue
      const parameterKeys = new Set(getMapKeys(lines, ['spec', 'parameters']))

      const expectedKeys =
        REQUIRED_KEYS_BY_SPEC.get(specName) ?? (specName === CATALOG_OPS_SPEC ? CATALOG_OPS_REQUIRED_KEYS : null)
      if (!expectedKeys) continue

      seenSpecs.add(specName)
      expect(
        expectedKeys.every((key) => parameterKeys.has(key)),
        `AgentRun template for ${specName} is missing required parameters`,
      ).toBe(true)
    }

    for (const name of REQUIRED_KEYS_BY_SPEC.keys()) {
      expect(seenSpecs.has(name), `missing AgentRun template mapping for ${name}`).toBe(true)
    }
    expect(seenSpecs.has(CATALOG_OPS_SPEC), `missing AgentRun template mapping for ${CATALOG_OPS_SPEC}`).toBe(true)
  })
})
