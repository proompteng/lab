import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

const jobs = (value: unknown): unknown[] => {
  if (!value || typeof value !== 'object' || !('jobs' in value)) return []
  if (!value.jobs || typeof value.jobs !== 'object') return []
  return Object.values(value.jobs)
}

export const imageWorkflows = (root: string): string[] => {
  const directory = resolve(root, '.github/workflows')
  const workflows = new Map(
    readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, jobs(YAML.parse(readFileSync(resolve(directory, name), 'utf8')))]),
  )
  const selected = new Set<string>()
  const callers = new Map<string, string[]>()
  for (const [name, entries] of workflows) {
    for (const job of entries) {
      if (!job || typeof job !== 'object') continue
      if ('uses' in job && typeof job.uses === 'string') {
        const called = job.uses.replace('./.github/workflows/', '')
        callers.set(name, [...(callers.get(name) ?? []), called])
      }
      if (!('steps' in job) || !Array.isArray(job.steps)) continue
      for (const entry of job.steps) {
        const step: unknown = entry
        if (!step || typeof step !== 'object') continue
        const uses = 'uses' in step && typeof step.uses === 'string' ? step.uses : ''
        const run = 'run' in step && typeof step.run === 'string' ? step.run : ''
        if (
          /docker\/build-push-action|\.github\/actions\/setup-buildkit/.test(uses) ||
          /\bnix\/(?:oci-push|oci-build|ci-nix-oci-summary)\.sh\b|\bbuildAndPush/.test(run)
        ) {
          selected.add(name)
        }
      }
    }
  }
  let previous = -1
  while (previous !== selected.size) {
    previous = selected.size
    for (const [name, called] of callers) {
      if (called.some((workflow) => selected.has(workflow))) selected.add(name)
    }
  }
  return [...selected].sort()
}

export const imageWorkflowCatalog = (root: string): Record<string, { id: string; prefix: string }[]> => {
  const catalog: Record<string, { id: string; prefix: string }[]> = {}
  for (const name of imageWorkflows(root)) {
    const document: unknown = YAML.parse(readFileSync(resolve(root, '.github/workflows', name), 'utf8'))
    if (!document || typeof document !== 'object' || !('jobs' in document)) continue
    if (!document.jobs || typeof document.jobs !== 'object') continue
    catalog[name] = []
    for (const [id, job] of Object.entries(document.jobs)) {
      if (!job || typeof job !== 'object') continue
      const display = 'name' in job && typeof job.name === 'string' ? job.name : id
      const prefix = display.split(/\s*\(|\s*\$\{\{/)[0]?.trim()
      if (prefix) catalog[name].push({ id, prefix })
    }
  }
  return catalog
}

if (import.meta.main) {
  const target = resolve(repoRoot, 'argocd/applications/observability/ci/workflows.json')
  const output = `${JSON.stringify(imageWorkflowCatalog(repoRoot), null, 2)}\n`
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== output) {
      throw new Error(
        'Regenerate CI enrollment with bun run packages/scripts/src/ci/generate-observability-workflows.ts',
      )
    }
  } else {
    writeFileSync(target, output)
  }
}
