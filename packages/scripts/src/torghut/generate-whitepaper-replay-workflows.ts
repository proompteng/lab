#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot } from '../shared/cli'

const defaultRepo = 'proompteng/lab'
const defaultLimit = 500
const defaultOutputDir = 'docs/whitepapers/replay-workflows'
const defaultBaseUrl = process.env.TORGHUT_BASE_URL ?? 'http://localhost:8181'
const syntheticIssueBase = 900000000
const issueMarkerStart = '<!-- TORGHUT_WHITEPAPER:START -->'
const issueMarkerEnd = '<!-- TORGHUT_WHITEPAPER:END -->'

type Options = {
  repo: string
  limit: number
  outputDir: string
  post: boolean
  syntheticIssueNumber?: number
  baseUrl: string
  authToken?: string
}

type RawIssue = {
  number?: number
  title?: string
  body?: string
  url?: string
  closedAt?: string | null
}

type IssueRecord = {
  number: number
  title: string
  body: string
  url: string
  closedAt?: string
  attachmentUrl: string
  paperTitle: string
}

type ManifestItem = {
  syntheticIssueNumber: number
  paperTitle: string
  attachmentUrl: string
  canonicalSourceIssue: {
    number: number
    title: string
    url: string
    closedAt?: string
  }
  sourceIssues: Array<{
    number: number
    title: string
    url: string
    closedAt?: string
  }>
  payloadPath: string
}

type Manifest = {
  repository: string
  workflow: 'whitepaper-analysis-v1'
  generatedBy: string
  syntheticIssueBase: number
  uniqueWhitepaperCount: number
  items: ManifestItem[]
}

type ReplayPayload = {
  event: 'issues'
  action: 'opened'
  repository: {
    full_name: string
  }
  issue: {
    number: number
    title: string
    body: string
    html_url: string
  }
  sender: {
    login: string
  }
}

const usage = () =>
  `Usage: bun run packages/scripts/src/torghut/generate-whitepaper-replay-workflows.ts [options]

Options:
  --repo <owner/repo>      Repository to inspect (default: ${defaultRepo})
  --limit <n>              Maximum closed issues to fetch (default: ${defaultLimit})
  --output-dir <path>      Output directory relative to repo root (default: ${defaultOutputDir})
  --post                   POST generated payloads to Torghut after writing files
  --synthetic-issue-number <n>
                           Restrict output and posting to one generated synthetic issue number
  --base-url <url>         Torghut base URL for --post (default: ${defaultBaseUrl})
  --auth-token <token>     Optional bearer token override for --post
  -h, --help               Show this help message

Environment:
  TORGHUT_BASE_URL, WHITEPAPER_WORKFLOW_API_TOKEN, JANGAR_API_KEY

Examples:
  bun run packages/scripts/src/torghut/generate-whitepaper-replay-workflows.ts
  bun run packages/scripts/src/torghut/generate-whitepaper-replay-workflows.ts --synthetic-issue-number 900000001
  bun run packages/scripts/src/torghut/generate-whitepaper-replay-workflows.ts --post --base-url http://localhost:8181
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`${arg} requires a value`)
  }
  return value
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    repo: defaultRepo,
    limit: defaultLimit,
    outputDir: defaultOutputDir,
    post: false,
    baseUrl: defaultBaseUrl,
    authToken: process.env.WHITEPAPER_WORKFLOW_API_TOKEN ?? process.env.JANGAR_API_KEY,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }

    if (arg === '--post') {
      options.post = true
      continue
    }

    if (arg === '--synthetic-issue-number') {
      options.syntheticIssueNumber = Number.parseInt(readValue(arg, argv, i), 10)
      i += 1
      continue
    }

    if (arg.startsWith('--synthetic-issue-number=')) {
      options.syntheticIssueNumber = Number.parseInt(arg.slice('--synthetic-issue-number='.length), 10)
      continue
    }

    if (arg === '--repo') {
      options.repo = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--repo=')) {
      options.repo = arg.slice('--repo='.length)
      continue
    }

    if (arg === '--limit') {
      options.limit = Number.parseInt(readValue(arg, argv, i), 10)
      i += 1
      continue
    }

    if (arg.startsWith('--limit=')) {
      options.limit = Number.parseInt(arg.slice('--limit='.length), 10)
      continue
    }

    if (arg === '--output-dir') {
      options.outputDir = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--output-dir=')) {
      options.outputDir = arg.slice('--output-dir='.length)
      continue
    }

    if (arg === '--base-url') {
      options.baseUrl = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length)
      continue
    }

    if (arg === '--auth-token') {
      options.authToken = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--auth-token=')) {
      options.authToken = arg.slice('--auth-token='.length)
      continue
    }

    throw new Error(`Unknown option: ${arg}`)
  }

  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    throw new Error('--limit must be a positive integer')
  }

  if (!options.repo.trim()) {
    throw new Error('--repo cannot be empty')
  }

  if (!options.outputDir.trim()) {
    throw new Error('--output-dir cannot be empty')
  }

  if (!options.baseUrl.trim()) {
    throw new Error('--base-url cannot be empty')
  }

  if (
    options.syntheticIssueNumber !== undefined &&
    (!Number.isFinite(options.syntheticIssueNumber) || options.syntheticIssueNumber <= 0)
  ) {
    throw new Error('--synthetic-issue-number must be a positive integer')
  }

  return options
}

const normalizeAttachmentUrl = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    url.hash = ''
    return url.toString()
  } catch {
    return trimmed
  }
}

const parseMarkerBlock = (issueBody: string) => {
  const startIndex = issueBody.indexOf(issueMarkerStart)
  if (startIndex < 0) return undefined
  const endIndex = issueBody.indexOf(issueMarkerEnd, startIndex + issueMarkerStart.length)
  if (endIndex < 0) return undefined

  const markerBlock = issueBody.slice(startIndex + issueMarkerStart.length, endIndex)
  const parsed: Record<string, string> = {}
  for (const rawLine of markerBlock.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes(':')) continue
    const [key, ...rest] = line.split(':')
    parsed[key.trim().toLowerCase()] = rest.join(':').trim()
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

const looksLikePdfUrl = (value: string) => {
  const lowered = value.toLowerCase()
  return lowered.includes('.pdf') || lowered.includes('/pdf/')
}

const extractPdfUrls = (text: string) => {
  const urls: string[] = []
  const seen = new Set<string>()
  const append = (candidate: string) => {
    const normalized = candidate.trim().replace(/[.,]+$/u, '')
    if (!normalized || !looksLikePdfUrl(normalized) || seen.has(normalized)) return
    seen.add(normalized)
    urls.push(normalized)
  }

  const markdownMatches = text.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/giu)
  for (const match of markdownMatches) {
    if (match[1]) append(match[1])
  }

  const plainMatches = text.matchAll(/(https?:\/\/[^\s)]+)/giu)
  for (const match of plainMatches) {
    if (match[1]) append(match[1])
  }

  return urls
}

const extractAttachmentUrl = (issueBody: string) => {
  const marker = parseMarkerBlock(issueBody) ?? {}
  const fromMarker = normalizeAttachmentUrl(marker.attachment_url ?? '')
  if (fromMarker) return fromMarker
  const attachments = extractPdfUrls(issueBody)
  return attachments[0] ? normalizeAttachmentUrl(attachments[0]) : ''
}

const extractBodyTitle = (issueBody: string) => {
  const patterns = [/^-?\s*Title:\s*(.+)$/im, /^Paper:\s*(.+)$/im]
  for (const pattern of patterns) {
    const match = pattern.exec(issueBody)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

const titleFromIssue = (issueTitle: string, issueBody: string, attachmentUrl: string) => {
  const bodyTitle = extractBodyTitle(issueBody)
  if (bodyTitle) return bodyTitle

  const trimmedTitle = issueTitle.trim()
  if (trimmedTitle.toLowerCase().startsWith('analyze whitepaper:')) {
    return trimmedTitle.split(':', 2)[1]?.trim() || trimmedTitle
  }

  if (trimmedTitle.startsWith('[Whitepaper E2E]')) {
    return trimmedTitle.split(']', 2)[1]?.split('(', 2)[0]?.trim() || trimmedTitle
  }

  if (trimmedTitle.startsWith('[smoke]')) {
    try {
      const url = new URL(attachmentUrl)
      return url.pathname.split('/').filter(Boolean).at(-1) || trimmedTitle
    } catch {
      return trimmedTitle
    }
  }

  return trimmedTitle || attachmentUrl
}

const issueRank = (title: string) => {
  const lowered = title.toLowerCase()
  if (lowered.startsWith('analyze whitepaper:')) return 0
  if (lowered.startsWith('[whitepaper e2e]')) return 1
  if (lowered.startsWith('[smoke]')) return 2
  return 3
}

const slugify = (value: string) => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return slug || 'whitepaper'
}

const capture = async (command: string, args: string[]) => {
  const subprocess = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = subprocess.stdout ? await new Response(subprocess.stdout).text() : ''
  const stderr = subprocess.stderr ? await new Response(subprocess.stderr).text() : ''
  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Command failed (${exitCode}): ${command} ${args.join(' ')}`)
  }
  return stdout
}

const loadSynthesisTitleOverrides = () => {
  const overrides = new Map<string, string>()
  const whitepapersDir = resolve(repoRoot, 'docs/whitepapers')
  if (!existsSync(whitepapersDir)) return overrides

  for (const entry of readdirSync(whitepapersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const synthesisPath = resolve(whitepapersDir, entry.name, 'synthesis.json')
    if (!existsSync(synthesisPath)) continue

    try {
      const synthesis = JSON.parse(readFileSync(synthesisPath, 'utf8')) as {
        paper?: { title?: string; pdf_url?: string }
      }
      const attachmentUrl = normalizeAttachmentUrl(synthesis.paper?.pdf_url ?? '')
      const paperTitle = synthesis.paper?.title?.trim() ?? ''
      if (!attachmentUrl || !paperTitle) continue
      overrides.set(attachmentUrl, paperTitle)
    } catch {
      continue
    }
  }

  return overrides
}

const loadIssueRecords = async (repo: string, limit: number): Promise<IssueRecord[]> => {
  ensureCli('gh')
  const output = await capture('gh', [
    'issue',
    'list',
    '-R',
    repo,
    '--state',
    'closed',
    '--limit',
    String(limit),
    '--json',
    'number,title,closedAt,url,body',
  ])
  const issues = JSON.parse(output) as RawIssue[]
  const titleOverrides = loadSynthesisTitleOverrides()

  return issues
    .map((issue) => {
      const body = issue.body ?? ''
      const attachmentUrl = extractAttachmentUrl(body)
      const fallbackTitle = titleFromIssue(issue.title?.trim() ?? '', body, attachmentUrl)
      return {
        number: Number(issue.number ?? 0),
        title: issue.title?.trim() ?? '',
        body,
        url: issue.url?.trim() ?? '',
        closedAt: issue.closedAt ?? undefined,
        attachmentUrl,
        paperTitle: titleOverrides.get(attachmentUrl) ?? fallbackTitle,
      } satisfies IssueRecord
    })
    .filter((issue) => issue.body.includes(issueMarkerStart) && issue.number > 0 && issue.attachmentUrl.length > 0)
}

const buildIssueBody = (paperTitle: string, attachmentUrl: string, sourceIssues: IssueRecord[]) => {
  const sourceLines = sourceIssues.map((issue) => `- #${issue.number}: ${issue.url}`).join('\n')
  return `${issueMarkerStart}
workflow: whitepaper-analysis-v1
base_branch: main
attachment_url: ${attachmentUrl}
${issueMarkerEnd}

Paper: ${paperTitle}
PDF: ${attachmentUrl}
Context: Deduplicated direct-intake replay payload generated from closed whitepaper issues.

Source issues:
${sourceLines}
`
}

const renderPayload = (
  repo: string,
  syntheticIssueNumber: number,
  paperTitle: string,
  issueBody: string,
  canonicalIssueUrl: string,
): ReplayPayload => ({
  event: 'issues',
  action: 'opened',
  repository: {
    full_name: repo,
  },
  issue: {
    number: syntheticIssueNumber,
    title: `Analyze whitepaper: ${paperTitle}`,
    body: issueBody,
    html_url: canonicalIssueUrl,
  },
  sender: {
    login: 'codex-whitepaper-replay',
  },
})

const buildManifest = (repo: string, records: IssueRecord[], outputDir: string) => {
  const grouped = new Map<string, IssueRecord[]>()
  for (const record of records) {
    const existing = grouped.get(record.attachmentUrl)
    if (existing) {
      existing.push(record)
    } else {
      grouped.set(record.attachmentUrl, [record])
    }
  }

  const items: ManifestItem[] = []
  const payloads: Array<{ path: string; payload: ReplayPayload }> = []

  const sortedAttachmentUrls = [...grouped.keys()].sort((left, right) => left.localeCompare(right))
  for (const [index, attachmentUrl] of sortedAttachmentUrls.entries()) {
    const sourceIssues = [...(grouped.get(attachmentUrl) ?? [])].sort((left, right) => {
      const rankDelta = issueRank(left.title) - issueRank(right.title)
      if (rankDelta !== 0) return rankDelta
      return left.number - right.number
    })
    const canonicalIssue = sourceIssues[0]
    if (!canonicalIssue) continue

    const syntheticIssueNumber = syntheticIssueBase + index + 1
    const issueBody = buildIssueBody(canonicalIssue.paperTitle, attachmentUrl, sourceIssues)
    const fileName = `${syntheticIssueNumber}-${slugify(canonicalIssue.paperTitle)}.json`
    const relativePayloadPath = `payloads/${fileName}`
    payloads.push({
      path: resolve(outputDir, relativePayloadPath),
      payload: renderPayload(repo, syntheticIssueNumber, canonicalIssue.paperTitle, issueBody, canonicalIssue.url),
    })
    items.push({
      syntheticIssueNumber,
      paperTitle: canonicalIssue.paperTitle,
      attachmentUrl,
      canonicalSourceIssue: {
        number: canonicalIssue.number,
        title: canonicalIssue.title,
        url: canonicalIssue.url,
        closedAt: canonicalIssue.closedAt,
      },
      sourceIssues: sourceIssues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        closedAt: issue.closedAt,
      })),
      payloadPath: relativePayloadPath,
    })
  }

  const manifest: Manifest = {
    repository: repo,
    workflow: 'whitepaper-analysis-v1',
    generatedBy: 'packages/scripts/src/torghut/generate-whitepaper-replay-workflows.ts',
    syntheticIssueBase,
    uniqueWhitepaperCount: items.length,
    items,
  }

  return { manifest, payloads }
}

const selectPayloads = (
  manifest: Manifest,
  payloads: Array<{ path: string; payload: ReplayPayload }>,
  syntheticIssueNumber?: number,
) => {
  if (syntheticIssueNumber === undefined) {
    return { manifest, payloads }
  }

  const selectedItem = manifest.items.find((item) => item.syntheticIssueNumber === syntheticIssueNumber)
  const selectedPayload = payloads.find((item) => item.payload.issue.number === syntheticIssueNumber)
  if (!selectedItem || !selectedPayload) {
    throw new Error(`No generated payload matched synthetic issue number ${syntheticIssueNumber}`)
  }

  return {
    manifest: {
      ...manifest,
      uniqueWhitepaperCount: 1,
      items: [selectedItem],
    } satisfies Manifest,
    payloads: [selectedPayload],
  }
}

const writeBundle = (
  manifest: Manifest,
  payloads: Array<{ path: string; payload: ReplayPayload }>,
  outputDir: string,
) => {
  mkdirSync(outputDir, { recursive: true })
  mkdirSync(resolve(outputDir, 'payloads'), { recursive: true })
  for (const entry of readdirSync(resolve(outputDir, 'payloads'))) {
    if (entry.endsWith('.json')) {
      rmSync(resolve(outputDir, 'payloads', entry))
    }
  }

  writeFileSync(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  for (const payload of payloads) {
    writeFileSync(payload.path, `${JSON.stringify(payload.payload, null, 2)}\n`, 'utf8')
  }

  writeFileSync(
    resolve(outputDir, 'README.md'),
    `# Whitepaper Replay Workflows

This directory contains ${manifest.uniqueWhitepaperCount} deduplicated direct-intake payloads for the Torghut \`whitepaper-analysis-v1\` workflow.

- Each payload uses a synthetic issue number so the intake path creates a fresh run instead of colliding with the historical issue idempotency key.
- Each payload preserves the real source issue URL in \`issue.html_url\` and lists all source issues in the body for provenance.

Generate or refresh the bundle:

\`\`\`bash
bun run whitepapers:replay
\`\`\`

Generate and post the payloads:

\`\`\`bash
WHITEPAPER_WORKFLOW_API_TOKEN=<token> \\
TORGHUT_BASE_URL=http://localhost:8181 \\
bun run whitepapers:replay --post
\`\`\`
`,
    'utf8',
  )
}

const postPayloads = async (
  baseUrl: string,
  payloads: Array<{ path: string; payload: ReplayPayload }>,
  authToken?: string,
) => {
  for (const payload of payloads) {
    console.log(`POST ${payload.path}`)
    const response = await fetch(new URL('/whitepapers/events/github-issue', baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(payload.payload),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`POST failed (${response.status} ${response.statusText})\n${text}`)
    }
    console.log(text)
  }
}

const main = async (cliOptions?: Options) => {
  const options = cliOptions ?? parseArgs(Bun.argv.slice(2))
  const outputDir = resolve(repoRoot, options.outputDir)
  const records = await loadIssueRecords(options.repo, options.limit)
  if (records.length === 0) {
    throw new Error('No closed whitepaper issues found with the TORGHUT_WHITEPAPER marker')
  }

  const generated = buildManifest(options.repo, records, outputDir)
  const { manifest, payloads } = selectPayloads(generated.manifest, generated.payloads, options.syntheticIssueNumber)
  writeBundle(manifest, payloads, outputDir)

  if (options.post) {
    await postPayloads(options.baseUrl, payloads, options.authToken)
  }

  console.log(
    JSON.stringify(
      {
        outputDir,
        uniqueWhitepaperCount: manifest.uniqueWhitepaperCount,
        syntheticIssueNumber: options.syntheticIssueNumber ?? null,
        posted: options.post,
      },
      null,
      2,
    ),
  )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    fatal('Failed to generate whitepaper replay workflows', error)
  }
}

export const __private = {
  buildIssueBody,
  buildManifest,
  extractAttachmentUrl,
  extractBodyTitle,
  extractPdfUrls,
  issueRank,
  looksLikePdfUrl,
  normalizeAttachmentUrl,
  parseArgs,
  parseMarkerBlock,
  renderPayload,
  selectPayloads,
  slugify,
  titleFromIssue,
}
