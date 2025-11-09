#!/usr/bin/env bun
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

interface PromptInputSpec {
  name: string
  description: string
  required: boolean
  example?: string
}

interface PromptEntityExpectation {
  label: string
  description: string
  requiredProperties?: string[]
}

interface PromptRelationshipExpectation {
  type: string
  description: string
  fromLabel: string
  toLabel: string
  requiredProperties?: string[]
}

interface PromptCitations {
  required: string[]
  preferredSources: string[]
  notes?: string
  minimumCount?: number
}

interface PromptScoring {
  metric: string
  target: string
  notes?: string
}

export interface PromptDefinition {
  promptId: string
  streamId: string
  objective: string
  schemaVersion: number
  prompt: string
  inputs: PromptInputSpec[]
  expectedArtifact: {
    entities: PromptEntityExpectation[]
    relationships: PromptRelationshipExpectation[]
  }
  citations: PromptCitations
  scoringHeuristics: PromptScoring[]
  metadata?: Record<string, string>
}

interface SchemaDefinition {
  properties?: Record<string, unknown>
  additionalProperties?: boolean
  required?: string[]
}

const usage = () => {
  console.log('Usage: bun packages/scripts/src/graf/run-prompts.ts [--prompt-id <id>] [--dry-run]')
  console.log(`
Environment:
  GRAF_BASE_URL (default: http://localhost:8080)
  GRAF_TOKEN (required unless --dry-run)
`)
}

const parseArgs = (argv: string[]) => {
  const opts = {
    promptId: undefined as string | undefined,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--prompt-id':
        opts.promptId = argv[++i]
        break
      case '--dry-run':
        opts.dryRun = true
        break
      case '-h':
      case '--help':
        usage()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown option ${arg}`)
    }
  }

  return opts
}

const ensureArray = (value: unknown, name: string) => {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`)
  }
  if (value.length === 0) {
    throw new Error(`${name} cannot be empty`)
  }
}

const ensureString = (value: unknown, name: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

const validatePrompt = (definition: PromptDefinition, source: string, schema: SchemaDefinition) => {
  const missing: string[] = []
  if (!definition.promptId) missing.push('promptId')
  if (!definition.streamId) missing.push('streamId')
  if (!definition.objective) missing.push('objective')
  if (!definition.prompt) missing.push('prompt')
  if (!definition.schemaVersion) missing.push('schemaVersion')
  if (missing.length) {
    throw new Error(`${source} is missing required fields: ${missing.join(', ')}`)
  }

  ensureArray(definition.inputs, 'inputs')
  definition.inputs.forEach((input, index) => {
    ensureString(input.name, `${source}.inputs[${index}].name`)
    ensureString(input.description, `${source}.inputs[${index}].description`)
  })

  const artifact = definition.expectedArtifact
  if (!artifact) {
    throw new Error(`${source} missing expectedArtifact definition`)
  }
  ensureArray(artifact.entities, `${source}.expectedArtifact.entities`)
  ensureArray(artifact.relationships, `${source}.expectedArtifact.relationships`)

  artifact.entities.forEach((entity, index) => {
    ensureString(entity.label, `${source}.expectedArtifact.entities[${index}].label`)
    ensureString(entity.description, `${source}.expectedArtifact.entities[${index}].description`)
  })

  artifact.relationships.forEach((rel, index) => {
    ensureString(rel.type, `${source}.expectedArtifact.relationships[${index}].type`)
    ensureString(rel.description, `${source}.expectedArtifact.relationships[${index}].description`)
    ensureString(rel.fromLabel, `${source}.expectedArtifact.relationships[${index}].fromLabel`)
    ensureString(rel.toLabel, `${source}.expectedArtifact.relationships[${index}].toLabel`)
  })

  ensureArray(definition.scoringHeuristics, `${source}.scoringHeuristics`)
  definition.scoringHeuristics.forEach((score, index) => {
    ensureString(score.metric, `${source}.scoringHeuristics[${index}].metric`)
    ensureString(score.target, `${source}.scoringHeuristics[${index}].target`)
  })

  const citations = definition.citations
  if (!citations) {
    throw new Error(`${source} missing citations section`)
  }
  ensureArray(citations.required, `${source}.citations.required`)
  ensureArray(citations.preferredSources, `${source}.citations.preferredSources`)
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties))
    for (const key of Object.keys(definition)) {
      if (!allowed.has(key)) {
        throw new Error(`${source} contains unexpected property ${key}`)
      }
    }
  }
}

const buildMetadata = (definition: PromptDefinition) => ({
  promptId: definition.promptId,
  streamId: definition.streamId,
  ...definition.metadata,
})

type ArtifactReferenceRecord = Record<string, unknown>

const hasKeyProperty = (value: unknown): value is ArtifactReferenceRecord & { key?: unknown } =>
  typeof value === 'object' && value !== null && 'key' in value

const describeArtifactRefs = (refs: ArtifactReferenceRecord[]) => {
  if (!Array.isArray(refs) || refs.length === 0) {
    return 'none'
  }
  return refs
    .map((ref) => {
      if (hasKeyProperty(ref) && ref.key !== undefined) {
        return `${ref.key}`
      }
      return JSON.stringify(ref)
    })
    .join(', ')
}

const run = async () => {
  const { promptId, dryRun } = parseArgs(process.argv.slice(2))
  const baseDir = process.cwd()
  const schemaPath = join(baseDir, 'docs/codex/nvidia-prompt-schema.json')
  const promptsDir = join(baseDir, 'docs/codex/nvidia-prompts')

  const schemaDefinition = JSON.parse(await readFile(schemaPath, 'utf8')) as SchemaDefinition
  const promptFiles = (await readdir(promptsDir)).filter((name) => name.endsWith('.json'))
  const definitions = [] as PromptDefinition[]

  for (const file of promptFiles) {
    const body = await readFile(join(promptsDir, file), 'utf8')
    const definition = JSON.parse(body) as PromptDefinition
    validatePrompt(definition, file, schemaDefinition)
    definitions.push(definition)
  }

  const selection = promptId ? definitions.filter((def) => def.promptId === promptId) : definitions
  if (selection.length === 0) {
    throw new Error(promptId ? `Prompt ${promptId} not found` : 'No prompts to run')
  }

  const baseUrl = process.env.GRAF_BASE_URL ?? 'http://localhost:8080'
  const token = process.env.GRAF_TOKEN
  if (!dryRun && !token) {
    throw new Error('GRAF_TOKEN is required when --dry-run is not passed')
  }

  for (const definition of selection) {
    const payload = {
      prompt: definition.prompt,
      metadata: buildMetadata(definition),
      catalog: definition,
    }

    console.log(`\n[run-prompts] ${dryRun ? 'dry-run' : 'submitting'} promptId=${definition.promptId}`)

    if (dryRun) {
      console.log(`[run-prompts] → ${definition.promptId} would post to ${baseUrl}/v1/codex-research`)
      console.log(`[run-prompts] Artifact metadata preview: ${JSON.stringify(payload.metadata)}`)
      console.log(
        `[run-prompts] Guidance: capture workflowId/runId pairs for Temporal dashboards and Temporal artifact cleanup.`,
      )
      continue
    }

    const response = await fetch(`${baseUrl}/v1/codex-research`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} when running ${definition.promptId}: ${await response.text()}`)
    }

    const body = (await response.json()) as {
      workflowId: string
      runId: string
      artifactReferences: ArtifactReferenceRecord[]
    }

    console.log(`[run-prompts] promptId=${definition.promptId} workflowId=${body.workflowId} runId=${body.runId}`)
    console.log(`[run-prompts] artifactReferences=${describeArtifactRefs(body.artifactReferences ?? [])}`)
    console.log(
      `[run-prompts] Capture workflowId/runId pairs for Temporal monitoring and anchor the artifact reference list for Neo4j ingestion.`,
    )
  }
  console.log(`[run-prompts] Completed ${selection.length} prompts (${dryRun ? 'dry-run' : 'live'}).`)
}

run().catch((error) => {
  console.error(`[run-prompts]`, error)
  process.exit(1)
})
