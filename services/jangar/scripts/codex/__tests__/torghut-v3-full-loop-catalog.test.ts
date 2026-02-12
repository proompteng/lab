import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)))
const implementationSpecsPath = resolve(
  repoRoot,
  'docs/torghut/design-system/v3/full-loop/templates/implementationspecs.yaml',
)
const agentRunsPath = resolve(repoRoot, 'docs/torghut/design-system/v3/full-loop/templates/agentruns.yaml')

const CATALOG_REQUIRED_KEYS: Record<string, string[]> = {
  'torghut-v3-research-intake-v1': ['researchPrompt', 'universe', 'featureSchemaVersion', 'outputPath'],
  'torghut-v3-candidate-build-v1': ['repository', 'base', 'head', 'candidateSpecPath', 'strategyCatalogPath'],
  'torghut-v3-backtest-robustness-v1': [
    'datasetSnapshotId',
    'strategyId',
    'strategyVersion',
    'costModelVersion',
    'artifactPath',
  ],
  'torghut-v3-gate-evaluation-v1': ['gateConfigPath', 'metricsBundlePath', 'artifactPath'],
  'torghut-v3-shadow-paper-run-v1': ['torghutNamespace', 'gitopsPath', 'strategyConfigPatchPath', 'evaluationWindow'],
  'torghut-v3-live-ramp-v1': ['torghutNamespace', 'gitopsPath', 'rampStage', 'confirm'],
  'torghut-v3-incident-recovery-v1': ['torghutNamespace', 'incidentId', 'rollbackTarget', 'confirm'],
  'torghut-v3-audit-pack-v1': ['runId', 'artifactRefs', 'complianceProfile', 'outputPath'],
}

const splitYamlDocuments = (raw: string): string[] =>
  raw
    .split(/^---\s*$/m)
    .map((document) => document.trim())
    .filter((document) => document.length > 0)

const parseMetadataName = (document: string): string | null => {
  const metadataBlock = document.match(/metadata:\n([\s\S]*?)\nspec:/)
  if (!metadataBlock) return null
  const nameMatch = metadataBlock[1]?.match(/^\s*name:\s*([^\s]+)\s*$/m)
  return nameMatch?.[1] ?? null
}

const parseRequiredKeys = (document: string): string[] => {
  const blockMatch = document.match(/requiredKeys:\n((?:\s*-\s[^\n]+\n?)+)/)
  if (!blockMatch) return []
  return [...blockMatch[1].matchAll(/-\s*([^\n#]+)/g)].map((match) => match[1]?.trim() ?? '').filter(Boolean)
}

const parseAgentRunImplementationSpecRef = (document: string): string | null => {
  const specRefMatch = document.match(/implementationSpecRef:\n\s*name:\s*([^\s]+)/)
  return specRefMatch?.[1] ?? null
}

const parseParameterKeys = (document: string): Set<string> => {
  const parametersMatch = document.match(/parameters:\n([\s\S]*?)\n\s*workflow:/)
  if (!parametersMatch) return new Set()
  return new Set(
    [...parametersMatch[1].matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*):/gm)]
      .map((match) => match[1]?.trim() ?? '')
      .filter(Boolean),
  )
}

describe('Torghut v3 full-loop catalog templates', () => {
  it('keeps canonical requiredKeys aligned in ImplementationSpec manifests', async () => {
    const raw = await readFile(implementationSpecsPath, 'utf8')
    const documents = splitYamlDocuments(raw).filter((document) => document.includes('kind: ImplementationSpec'))
    const requiredKeysBySpec = new Map<string, string[]>()

    for (const document of documents) {
      const name = parseMetadataName(document)
      if (!name) continue
      requiredKeysBySpec.set(name, parseRequiredKeys(document))
    }

    for (const [specName, expectedRequiredKeys] of Object.entries(CATALOG_REQUIRED_KEYS)) {
      expect(requiredKeysBySpec.get(specName)).toEqual(expectedRequiredKeys)
    }
  })

  it('maps every canonical catalog spec to an AgentRun template with matching parameters', async () => {
    const raw = await readFile(agentRunsPath, 'utf8')
    const documents = splitYamlDocuments(raw).filter((document) => document.includes('kind: AgentRun'))
    const specsWithRuns = new Set<string>()

    for (const document of documents) {
      const runName = parseMetadataName(document)
      const implementationSpecRef = parseAgentRunImplementationSpecRef(document)
      if (!implementationSpecRef || !runName || !(implementationSpecRef in CATALOG_REQUIRED_KEYS)) {
        continue
      }

      specsWithRuns.add(implementationSpecRef)
      const parameterKeys = parseParameterKeys(document)
      for (const requiredKey of CATALOG_REQUIRED_KEYS[implementationSpecRef]) {
        expect(parameterKeys.has(requiredKey), `run ${runName} missing required key ${requiredKey}`).toBe(true)
      }
    }

    expect(new Set(Object.keys(CATALOG_REQUIRED_KEYS))).toEqual(specsWithRuns)
  })
})
