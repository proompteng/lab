#!/usr/bin/env bun

import { fatal } from '../shared/cli'

interface Params {
  repository: string
  issueNumber: number
  head: string
  base: string
  prompt: string
  issueTitle?: string
  issueUrl?: string
  issueBody?: string
  namespace: string
  agentName: string
  agentsBaseUrl: string
  dryRun: boolean
}

const parseArgs = (): Params => {
  const args = process.argv.slice(2)
  const params: Partial<Params> = {
    base: 'main',
    prompt: 'Docker smoke: run hello-world and sample build',
    namespace: process.env.AGENTS_NAMESPACE || 'agents',
    agentName: process.env.AGENTS_CODEX_AGENT || 'codex-agent',
    agentsBaseUrl: process.env.AGENTS_BASE_URL || 'http://agents.agents.svc.cluster.local',
    dryRun: false,
  }

  const takeValue = (flag: string) => {
    const index = args.indexOf(flag)
    if (index === -1 || index === args.length - 1) return undefined
    const value = args[index + 1]
    args.splice(index, 2)
    return value
  }

  const flags = [
    ['--repository', 'repository'],
    ['--repo', 'repository'],
    ['--issue', 'issueNumber'],
    ['--head', 'head'],
    ['--base', 'base'],
    ['--prompt', 'prompt'],
    ['--title', 'issueTitle'],
    ['--issue-url', 'issueUrl'],
    ['--body', 'issueBody'],
    ['--namespace', 'namespace'],
    ['--agent', 'agentName'],
    ['--agents-base-url', 'agentsBaseUrl'],
  ] as const

  for (const [flag, key] of flags) {
    const value = takeValue(flag)
    if (value !== undefined) {
      // @ts-expect-error dynamic assignment
      params[key] = key === 'issueNumber' ? Number.parseInt(value, 10) : value
    }
  }

  if (args.includes('--dry-run')) {
    params.dryRun = true
  }

  if (!params.repository) {
    fatal('Missing required --repository (e.g., proompteng/lab)')
  }
  if (!params.issueNumber || Number.isNaN(params.issueNumber)) {
    fatal('Missing or invalid --issue (number)')
  }
  if (!params.head) {
    fatal('Missing required --head branch (e.g., codex/issue-1645-409ffe30)')
  }

  return params as Params
}

const buildAgentRunPayload = (params: Params) => ({
  namespace: params.namespace,
  agentRef: { name: params.agentName },
  implementation: {
    summary: params.issueTitle ?? `Implement ${params.repository}#${params.issueNumber}`,
    text: params.prompt,
    source: {
      provider: 'github',
      externalId: `${params.repository}#${params.issueNumber}`,
      ...(params.issueUrl ? { url: params.issueUrl } : {}),
    },
    contract: {
      requiredKeys: ['repository', 'issueNumber', 'base', 'head', 'stage'],
    },
    metadata: {
      stage: 'implementation',
    },
  },
  goal: {
    objective: params.prompt,
    tokenBudget: 250000,
  },
  runtime: {
    type: 'job',
    config: {
      serviceAccountName: 'agents-sa',
    },
  },
  parameters: {
    repository: params.repository,
    issueNumber: String(params.issueNumber),
    issue_number: String(params.issueNumber),
    base: params.base,
    head: params.head,
    stage: 'implementation',
    codexPrompt: params.prompt,
    codex_prompt: params.prompt,
    ...(params.issueTitle ? { issueTitle: params.issueTitle } : {}),
    ...(params.issueUrl ? { issueUrl: params.issueUrl } : {}),
    ...(params.issueBody ? { issueBody: params.issueBody } : {}),
  },
  secrets: ['github-token', 'codex-auth'],
  policy: { secretBindingRef: 'codex-github-token' },
  vcsRef: { name: 'github' },
  vcsPolicy: { required: true, mode: 'read-write' },
  ttlSecondsAfterFinished: 86400,
})

const buildIdempotencyKey = (params: Params) =>
  `codex-implementation-${params.repository.replace(/[^a-zA-Z0-9]+/g, '-')}-${params.issueNumber}-${params.head.replace(/[^a-zA-Z0-9]+/g, '-')}`

const main = async () => {
  const params = parseArgs()
  const payload = buildAgentRunPayload(params)
  const idempotencyKey = buildIdempotencyKey(params)
  const targetUrl = new URL('/v1/agent-runs', `${params.agentsBaseUrl.replace(/\/+$/, '')}/`)

  if (params.dryRun) {
    console.log(JSON.stringify({ url: targetUrl.toString(), idempotencyKey, payload }, null, 2))
    return
  }

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  })
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : response.statusText
    fatal(`Agents AgentRun submission failed (${response.status}): ${message}`)
  }
  console.log(JSON.stringify(body, null, 2))
}

await main()
