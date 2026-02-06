#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { runCli } from './lib/cli'
import { pushCodexEventsToLoki, runCodexSession } from './lib/codex-runner'
import { createCodexLogger } from './lib/logger'

type MetadataRecord = Record<string, unknown>

const pickString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed !== 'null' ? trimmed : undefined
}

const parseMetadata = async (path?: string): Promise<MetadataRecord> => {
  if (!path) {
    return {}
  }
  try {
    const raw = await readFile(path, 'utf8')
    const trimmed = raw.trim()
    if (!trimmed) {
      return {}
    }
    return JSON.parse(trimmed) as MetadataRecord
  } catch (error) {
    console.warn(`Failed to parse metadata file ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

const getMetadataString = (metadata: MetadataRecord, key: string) => pickString(metadata[key])

const describeMetadata = (metadata: MetadataRecord) => {
  const keys = Object.keys(metadata)
  if (keys.length === 0) {
    return 'none'
  }
  return keys
    .slice(0, 10)
    .map((key) => `${key}=${String(metadata[key])}`)
    .join(', ')
}

export const runCodexResearch = async () => {
  const [promptPathArg, metadataPathArg] = process.argv.slice(2)
  const promptPath = promptPathArg ?? process.env.AUTO_RESEARCH_PROMPT_PATH
  if (!promptPath) {
    throw new Error('codex-research requires a prompt file path argument')
  }

  const prompt = (await readFile(promptPath, 'utf8')).trim()
  if (!prompt) {
    throw new Error('AutoResearch prompt is empty')
  }

  const metadataPath = metadataPathArg ?? process.env.AUTO_RESEARCH_METADATA_PATH
  const metadata = await parseMetadata(metadataPath)

  const worktree = process.env.WORKTREE ?? '/workspace/lab'
  const artifactPath = process.env.AUTO_RESEARCH_ARTIFACT_PATH ?? `${worktree}/codex-artifact.json`
  const jsonOutputPath = process.env.AUTO_RESEARCH_JSON_LOG ?? `${worktree}/.codex-research-events.jsonl`
  const agentOutputPath = process.env.AUTO_RESEARCH_AGENT_LOG ?? `${worktree}/.codex-research-agent.log`
  const runtimeLogPath = process.env.AUTO_RESEARCH_RUNTIME_LOG ?? `${worktree}/.codex-research-runtime.log`
  const lokiEndpoint =
    process.env.LGTM_LOKI_ENDPOINT ??
    'http://observability-loki-loki-distributed-gateway.observability.svc.cluster.local/loki/api/v1/push'
  const lokiTenant = process.env.LGTM_LOKI_TENANT
  const lokiBasicAuth = process.env.LGTM_LOKI_BASIC_AUTH

  process.env.CODEX_STAGE = process.env.CODEX_STAGE ?? 'research'
  process.env.RUST_LOG = process.env.RUST_LOG ?? 'codex_core=info,codex_exec=info'
  process.env.RUST_BACKTRACE = process.env.RUST_BACKTRACE ?? '1'

  const workflowName = process.env.ARGO_WORKFLOW_NAME ?? undefined
  const workflowNamespace = process.env.ARGO_WORKFLOW_NAMESPACE ?? undefined
  const streamLabel = getMetadataString(metadata, 'streamId') ?? getMetadataString(metadata, 'autoResearch.streamId')
  const argoWorkflowLabel =
    getMetadataString(metadata, 'autoResearch.argoWorkflow') ?? getMetadataString(metadata, 'argoWorkflow')

  const logger = await createCodexLogger({
    logPath: runtimeLogPath,
    context: {
      stage: 'research',
      workflow: workflowName,
      namespace: workflowNamespace,
      argo_workflow: argoWorkflowLabel,
      stream: streamLabel,
    },
  })

  logger.info('Starting Codex research run', {
    promptBytes: prompt.length,
    artifactPath,
    metadataSummary: describeMetadata(metadata),
  })

  try {
    const sessionResult = await runCodexSession({
      stage: 'research',
      prompt,
      outputPath: artifactPath,
      jsonOutputPath,
      agentOutputPath,
      logger,
    })

    await pushCodexEventsToLoki({
      stage: 'research',
      endpoint: lokiEndpoint,
      jsonPath: jsonOutputPath,
      agentLogPath: agentOutputPath,
      runtimeLogPath,
      labels: {
        workflow: workflowName,
        namespace: workflowNamespace,
        argo_workflow: argoWorkflowLabel,
        stream: streamLabel,
      },
      tenant: lokiTenant,
      basicAuth: lokiBasicAuth,
      logger,
    })

    logger.info('Codex research completed', {
      artifactPath,
      sessionId: sessionResult.sessionId,
    })

    console.log(`Codex artifact stored at ${artifactPath}`)
    if (sessionResult.sessionId) {
      console.log(`Codex session ID: ${sessionResult.sessionId}`)
    }
  } finally {
    await logger.flush()
  }
}

runCli(import.meta, runCodexResearch)
