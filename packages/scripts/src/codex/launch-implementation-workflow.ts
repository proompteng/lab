#!/usr/bin/env bun

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

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
  template: string
  dryRun: boolean
}

const parseArgs = (): Params => {
  const args = process.argv.slice(2)
  const params: Partial<Params> = {
    base: 'main',
    prompt: 'Docker smoke: run hello-world and sample build',
    namespace: process.env.ARGO_NAMESPACE || 'argo-workflows',
    template: 'github-codex-implementation',
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
    ['--template', 'template'],
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

const encodeBase64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')

const buildEventBody = (params: Params) => {
  return {
    stage: 'implementation',
    prompt: params.prompt,
    repository: params.repository,
    issueNumber: params.issueNumber,
    base: params.base,
    head: params.head,
    issueUrl: params.issueUrl,
    issueTitle: params.issueTitle,
    issueBody: params.issueBody,
  }
}

const main = async () => {
  ensureCli('argo')

  const params = parseArgs()
  const eventBody = buildEventBody(params)
  const rawEvent = encodeBase64('{}')
  const eventBodyB64 = encodeBase64(JSON.stringify(eventBody))

  const args = [
    'submit',
    '--from',
    `workflowtemplate/${params.template}`,
    '-n',
    params.namespace,
    '-p',
    `rawEvent=${rawEvent}`,
    '-p',
    `eventBody=${eventBodyB64}`,
  ]

  if (params.dryRun) {
    args.push('--dry-run')
  }

  await run('argo', args, { cwd: repoRoot })
}

await main()
