import { appendFileSync } from 'node:fs'
import { parseTargets, selectAffectedRange } from '../ci/affected-inputs'

const workflow = '.github/workflows/bayn-build-push.yml'
const pageSize = 100
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const isCommit = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value)

const apiRows = (endpoint: string, query: string): Record<string, unknown>[] => {
  const result = Bun.spawnSync(['gh', 'api', endpoint, '--jq', query])
  if (result.exitCode !== 0) throw new Error(`Could not read ${endpoint}: ${result.stderr.toString().trim()}`)
  const rows: unknown = JSON.parse(result.stdout.toString())
  if (!Array.isArray(rows) || !rows.every(isRecord)) throw new Error(`Invalid Bayn publication history at ${endpoint}`)
  return rows
}

const commonAncestor = (head: string, source: string): string | undefined => {
  // A retained run can reference a commit no longer reachable in this checkout.
  if (Bun.spawnSync(['git', 'cat-file', '-e', `${source}^{commit}`]).exitCode !== 0) return undefined
  const result = Bun.spawnSync(['git', 'merge-base', head, source])
  if (result.exitCode === 1) return undefined
  if (result.exitCode !== 0) throw new Error(`Could not compare ${head} and ${source}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

const planPublication = (env: NodeJS.ProcessEnv): boolean => {
  // The workflow's source guard admits explicit recovery before reaching this planner.
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') return true
  const head = env.GITHUB_SHA
  const repository = env.GITHUB_REPOSITORY
  if (env.GITHUB_EVENT_NAME !== 'push' || !isCommit(head) || !repository)
    throw new Error('Bayn publication planning requires the exact main push revision and repository')

  const actions = `repos/${repository}/actions`
  // The Actions search endpoint serves at most 1,000 results. Stop as soon as a release is proven.
  for (let page = 1; page <= 1000 / pageSize; page++) {
    const runs = apiRows(
      `${actions}/workflows/bayn-build-push.yml/runs?branch=main&status=success&per_page=${pageSize}&page=${page}`,
      '.workflow_runs | map({id, run_attempt, head_sha, head_branch, event, conclusion})',
    )
    for (const run of runs) {
      if (
        run.head_branch !== 'main' ||
        run.conclusion !== 'success' ||
        (run.event !== 'push' && run.event !== 'workflow_dispatch')
      )
        continue
      const { id, run_attempt: attempt, head_sha: source } = run
      if (!isPositiveInteger(id) || !isPositiveInteger(attempt) || !isCommit(source))
        throw new Error('Invalid Bayn publication run ID, attempt or revision')
      const ancestor = commonAncestor(head, source)
      if (ancestor !== head && ancestor !== source) continue

      // A dependency-only skip can succeed as a workflow without publishing any images.
      const publishers = apiRows(
        `${actions}/runs/${id}/attempts/${attempt}/jobs?per_page=100`,
        '.jobs | map(select(.name == "publish-cohort") | {status, conclusion, head_sha})',
      )
      if (
        !publishers.some((job) => job.status === 'completed' && job.conclusion === 'success' && job.head_sha === source)
      )
        continue

      console.log(`Verified Bayn publication base: ${source} (run ${id}, attempt ${attempt})`)
      if (ancestor === head) return false // Already published or superseded by a published descendant.
      const targets = parseTargets("image: ['', 'services/bayn']", '', workflow, 'push')
      return selectAffectedRange('push', source, head, targets, true).affected.image === true
    }
    if (runs.length < pageSize) break
  }

  // Never use the previous push as a substitute: coalescing may have dropped that run.
  console.warn('::warning::No verified Bayn cohort in available main history; building the full cohort.')
  return true
}

const output = process.env.GITHUB_OUTPUT
if (!output) throw new Error('Bayn publication planning requires GITHUB_OUTPUT')
const image = planPublication(process.env)
console.log(`Bayn cohort affected: ${image}`)
appendFileSync(output, `image=${image}\n`)
