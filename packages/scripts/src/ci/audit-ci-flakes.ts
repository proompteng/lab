#!/usr/bin/env bun

import { parseArgs } from 'node:util'
import { z } from 'zod'

import {
  type AuditRun,
  auditCIFlakes,
  fixtureSchema,
  formatMarkdown,
  jobSchema,
  needsFailureLog,
  runSchema,
  withFailureLog,
} from './audit-ci-flakes-core'

const usage = `Usage: bun run packages/scripts/src/ci/audit-ci-flakes.ts [options]
  --repo <owner/name>       GitHub repository (default: proompteng/lab)
  --branch <name>           Branch to sample (default: main)
  --workflow <file-or-id>   Restrict to one workflow filename or numeric ID
  --limit <1-100>           Number of completed runs to sample (default: 25)
  --fixture <path>          Read an offline fixture instead of querying GitHub
  --format <json|markdown>  Report format (default: markdown)
  --help                    Show this usage
`

class AuditError extends Error {}

const options = () => {
  try {
    return parseArgs({
      options: {
        repo: { type: 'string' },
        branch: { type: 'string' },
        workflow: { type: 'string' },
        limit: { type: 'string' },
        fixture: { type: 'string' },
        format: { type: 'string' },
        help: { type: 'boolean' },
      },
    }).values
  } catch {
    throw new AuditError('Invalid arguments. See --help.')
  }
}

const readJSON = <T>(schema: z.ZodType<T>, text: string, source: string): T => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new AuditError(`${source} is not valid JSON.`)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const field = parsed.error.issues[0].path.join('.') || 'root'
    throw new AuditError(`${source} has invalid data at ${field}.`)
  }
  return parsed.data
}

const get = async (endpoint: string, source: string, paginate = false): Promise<string> => {
  try {
    const child = Bun.spawn(
      [
        'gh',
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        ...(paginate ? ['--paginate', '--slurp'] : []),
        endpoint,
      ],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        env: { ...process.env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
        signal: AbortSignal.timeout(30_000),
      },
    )
    const [exitCode, body] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (exitCode !== 0) {
      throw new AuditError(
        `GitHub query for ${source} failed (gh exit ${exitCode}). Verify connectivity and Actions read access.`,
      )
    }
    return body
  } catch (error) {
    if (error instanceof AuditError) throw error
    throw new AuditError(`Could not run gh for ${source}. Verify gh is installed and authenticated.`)
  }
}

const runList = z.object({ workflow_runs: z.array(runSchema) })
const jobPages = z.array(z.object({ jobs: z.array(jobSchema) }))

const loadLive = async (values: ReturnType<typeof options>): Promise<AuditRun[]> => {
  const { repo = 'proompteng/lab', branch = 'main', limit = '25', workflow } = values
  if (!/^[\w-]+\/[\w.-]+$/.test(repo) || /\/\.{1,2}$/.test(repo)) {
    throw new AuditError('--repo must be an owner/name pair.')
  }
  if (!branch.trim()) throw new AuditError('--branch must not be empty.')
  if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) throw new AuditError('--limit must be 1 to 100.')
  if (workflow !== undefined && !/^(?:[1-9]\d*|[\w-][\w.-]*\.ya?ml)$/.test(workflow)) {
    throw new AuditError('--workflow must be a workflow filename or numeric ID.')
  }
  const actions = `repos/${repo}/actions`
  const path = workflow ? `workflows/${workflow}/runs` : 'runs'
  const query = new URLSearchParams({ branch, status: 'completed', per_page: limit })
  const listing = readJSON(runList, await get(`${actions}/${path}?${query}`, 'completed runs'), 'Run list')
  const runs: AuditRun[] = []
  for (const run of listing.workflow_runs) {
    const source = `jobs for run ${run.id}`
    const endpoint = `${actions}/runs/${run.id}/jobs?filter=all&per_page=100`
    const pages = readJSON(jobPages, await get(endpoint, source, true), source)
    const jobs: AuditRun['jobs'] = []
    for (const job of pages.flatMap((page) => page.jobs)) {
      if (job.status !== 'completed' || job.run_attempt > run.run_attempt) continue
      let log: string | undefined
      if (needsFailureLog(job)) {
        // Retention or permissions can make individual logs unavailable even when the job metadata is readable.
        log = await get(`${actions}/jobs/${job.id}/logs`, 'job log').catch(() => undefined)
      }
      jobs.push(withFailureLog(job, log))
    }
    runs.push({ ...run, jobs })
  }
  return runs
}

const loadFixture = async (path: string): Promise<AuditRun[]> => {
  const text = await Bun.file(path)
    .text()
    .catch(() => {
      throw new AuditError('Could not read the fixture file.')
    })
  const { runs } = readJSON(fixtureSchema, text, 'Fixture')
  return runs.map((run) => ({
    ...run,
    jobs: run.jobs.map(({ log, ...job }) => withFailureLog(job, log)),
  }))
}

const main = async () => {
  const values = options()
  if (values.help) {
    process.stdout.write(usage)
    return
  }
  const { format = 'markdown', fixture } = values
  if (format !== 'json' && format !== 'markdown') throw new AuditError('--format must be json or markdown.')
  if (
    fixture !== undefined &&
    [values.repo, values.branch, values.limit, values.workflow].some((v) => v !== undefined)
  ) {
    throw new AuditError('--fixture cannot be combined with live query options.')
  }
  const report = auditCIFlakes(fixture === undefined ? await loadLive(values) : await loadFixture(fixture))
  process.stdout.write(format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : formatMarkdown(report))
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(`CI audit: ${error instanceof AuditError ? error.message : 'Unexpected audit failure.'}\n`)
    process.exitCode = 1
  })
}
