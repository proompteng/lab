#!/usr/bin/env bun
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { $, which } from 'bun'
import { runCli } from './lib/cli'
import { ensureFileDirectory } from './lib/fs'

interface Options {
  bodyFile?: string
  repo?: string
  issue?: string
  marker?: string
  dryRun: boolean
}

interface IssueComment {
  id: number
  body?: string
  html_url?: string
}

interface RunOptions {
  args?: string[]
  body?: string
  stdin?: NodeJS.ReadableStream
}

const DEFAULT_MARKER = '<!-- codex:progress -->'

const usage = () => {
  console.log(`Usage: codex-progress-comment [options]

Creates or updates the Codex implementation progress comment using the GitHub CLI.

Options:
  --body-file <path>  Read the comment body from the provided file instead of stdin.
  --repo <owner/name> Override ISSUE_REPO environment variable.
  --issue <number>    Override ISSUE_NUMBER environment variable.
  --marker <marker>   Override CODEX_PROGRESS_COMMENT_MARKER (default: <!-- codex:progress -->).
  --dry-run           Resolve the target comment and print the body without mutating GitHub.
  -h, --help          Show this help message.

Environment:
  ISSUE_REPO                       Repository in owner/name form (required unless --repo is provided).
  ISSUE_NUMBER                     Issue number (required unless --issue is provided).
  CODEX_PROGRESS_COMMENT_MARKER    Marker string inserted into the progress comment (default: <!-- codex:progress -->).
  CODEX_PROGRESS_COMMENT_LOG_PATH  Optional file to append helper output (falls back to OUTPUT_PATH).
  OUTPUT_PATH                      Optional log file (e.g., .codex-implementation.log).
`)
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = { dryRun: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) {
      continue
    }
    switch (arg) {
      case '--body-file':
        options.bodyFile = argv[++i]
        break
      case '--repo':
        options.repo = argv[++i]
        break
      case '--issue':
        options.issue = argv[++i]
        break
      case '--marker':
        options.marker = argv[++i]
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '-h':
      case '--help':
        usage()
        throw new Error('help requested')
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`)
        } else {
          throw new Error(`Unexpected argument: ${arg}`)
        }
    }
  }

  return options
}

const readFromStdin = async (stdin: NodeJS.ReadableStream): Promise<string> => {
  const tty = (stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY
  if (tty) {
    throw new Error('Comment body must be provided via stdin or --body-file')
  }
  let content = ''
  for await (const chunk of stdin) {
    content += chunk
  }
  return content
}

const sanitizeBody = (body: string): string => body.replace(/\r/g, '')

const appendLog = async (message: string) => {
  const logPath = process.env.CODEX_PROGRESS_COMMENT_LOG_PATH ?? process.env.OUTPUT_PATH
  if (!logPath) {
    return
  }
  await ensureFileDirectory(logPath)
  const timestamp = new Date().toISOString()
  await appendFile(logPath, `${timestamp} ${message}\n`, { encoding: 'utf8' })
}

const ensureGhCli = async () => {
  const ghPath = await which('gh')
  if (!ghPath) {
    throw new Error('Missing required command: gh')
  }
}

const loadToken = async (): Promise<string> => {
  const directToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (directToken) {
    return directToken
  }

  try {
    const token = (await $`gh auth token`.text()).trim()
    if (token) {
      return token
    }
  } catch {
    // ignore
  }

  throw new Error('Set GH_TOKEN, GITHUB_TOKEN, or login with gh auth login')
}

const fetchIssueComments = async (repo: string, issue: string, token: string): Promise<IssueComment[]> => {
  const comments: IssueComment[] = []
  let page = 1
  const headers = {
    Authorization: `token ${token}`,
    'User-Agent': 'codex-progress-comment',
    Accept: 'application/vnd.github+json',
  }

  while (true) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`,
      { headers },
    )

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`GitHub request failed: ${response.status} ${response.statusText} - ${text}`)
    }

    const batch = (await response.json()) as IssueComment[]
    if (batch.length === 0) {
      break
    }

    comments.push(...batch)

    if (batch.length < 100) {
      break
    }

    page += 1
  }

  return comments
}

const upsertComment = async (
  repo: string,
  issue: string,
  body: string,
  existingComment?: IssueComment,
): Promise<IssueComment> => {
  await ensureGhCli()
  const payload = JSON.stringify({ body })

  const tmpDir = await mkdtemp(join(tmpdir(), 'codex-progress-'))
  const payloadPath = join(tmpDir, 'payload.json')
  await writeFile(payloadPath, payload, 'utf8')

  try {
    if (existingComment) {
      const response =
        await $`gh api repos/${repo}/issues/comments/${existingComment.id} --method PATCH --input ${payloadPath}`.text()
      return JSON.parse(response) as IssueComment
    }

    const response = await $`gh api repos/${repo}/issues/${issue}/comments --method POST --input ${payloadPath}`.text()
    return JSON.parse(response) as IssueComment
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

const markerPresence = (body: string, marker: string) => (body.includes(marker) ? 1 : 0)

export const runCodexProgressComment = async ({ args, body, stdin }: RunOptions = {}) => {
  const argv = args ?? process.argv.slice(2)
  const input = stdin ?? process.stdin

  let options: Options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof Error && error.message === 'help requested') {
      return {
        action: 'help',
        commentId: '',
        commentUrl: '',
        markerPresent: 0,
      }
    }
    throw error
  }

  const marker = options.marker ?? process.env.CODEX_PROGRESS_COMMENT_MARKER ?? DEFAULT_MARKER
  if (!marker) {
    throw new Error('Marker cannot be empty')
  }

  let commentBody: string

  if (body !== undefined) {
    commentBody = body
  } else if (options.bodyFile) {
    try {
      commentBody = await readFile(options.bodyFile, 'utf8')
    } catch {
      throw new Error(`Body file not found: ${options.bodyFile}`)
    }
  } else {
    commentBody = await readFromStdin(input)
  }

  commentBody = sanitizeBody(commentBody)

  if (commentBody.length === 0) {
    throw new Error('Comment body cannot be empty')
  }

  if (!commentBody.includes(marker)) {
    throw new Error(`Comment body must include the marker '${marker}'`)
  }

  const repo = options.repo ?? process.env.ISSUE_REPO ?? ''
  const issue = options.issue ?? process.env.ISSUE_NUMBER ?? ''

  if (!repo || !issue) {
    throw new Error('ISSUE_REPO and ISSUE_NUMBER must be provided via flags or environment variables')
  }

  await appendLog(`codex-progress-comment start repo=${repo} issue=${issue} marker=${marker} dry_run=${options.dryRun}`)

  const token = await loadToken()
  const comments = await fetchIssueComments(repo, issue, token)

  let existingComment: IssueComment | undefined
  for (const comment of comments) {
    if ((comment.body ?? '').includes(marker)) {
      existingComment = comment
    }
  }

  const action = existingComment ? 'update' : 'create'
  let commentId = existingComment?.id ?? ''
  let commentUrl = existingComment?.html_url ?? ''
  let markerFlag = markerPresence(commentBody, marker)

  if (options.dryRun) {
    await appendLog(`codex-progress-comment dry-run action=${action} comment_id=${commentId || '(new)'}`)
  } else {
    const result = await upsertComment(repo, issue, commentBody, existingComment)
    commentId = result.id ?? commentId
    commentUrl = result.html_url ?? commentUrl
    markerFlag = markerPresence(result.body ?? '', marker)
    await appendLog(
      `codex-progress-comment action=${action} comment_id=${commentId} comment_url=${commentUrl} marker_present=${markerFlag}`,
    )
  }

  const output = {
    action,
    commentId,
    commentUrl,
    markerPresent: markerFlag,
  }

  console.log(`action=${output.action}`)
  console.log(`comment_id=${output.commentId}`)
  console.log(`comment_url=${output.commentUrl}`)
  console.log(`marker_present=${output.markerPresent}`)

  return output
}

await runCli(import.meta, async () => {
  await runCodexProgressComment()
})
