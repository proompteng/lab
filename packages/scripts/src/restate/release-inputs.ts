import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import YAML from 'yaml'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const workflowPath = '.github/workflows/restate-images.yml'
const image = 'registry.ide-newton.ts.net/lab/restate'

export function runtimeInputs(revision: string, cwd = process.cwd()): string {
  const workflow = YAML.parse(git(cwd, 'show', `${revision}:${workflowPath}`))
  const steps = workflow.jobs.build.steps
  const inputs = ['Prove metadata writes and cold-peer elections', 'Build runtime'].map((name) => {
    const step = steps.find((entry: { name?: string }) => entry.name === name)
    if (!step?.with) throw new Error(`Missing build inputs for ${name}`)
    const metadata = ['labels', 'tags', 'push', 'outputs', 'cache-from', 'cache-to']
    const withInputs = Object.fromEntries(Object.entries(step.with).filter(([key]) => !metadata.includes(key)))
    return { uses: step.uses, with: withInputs }
  })
  return createHash('sha256')
    .update(git(cwd, 'rev-parse', `${revision}:services/restate`))
    .update(JSON.stringify(inputs))
    .digest('hex')
}

export function releasePlan(cwd = process.cwd()) {
  const message = git(cwd, 'log', '-1', '--format=%B', 'origin/kargo/restate')
  const source = /^Source commit: ([0-9a-f]{40})$/m.exec(message)?.[1]
  const run = /^Build run: ([1-9][0-9]*)$/m.exec(message)?.[1]
  const manifest = YAML.parse(git(cwd, 'show', 'origin/kargo/restate:argocd/applications/restate/kustomization.yaml'))
  const runtime = manifest.images.find((entry: { name: string }) => entry.name === 'restate-runtime')
  if (!source || !run || runtime?.newName !== image || !/^sha256:[0-9a-f]{64}$/.test(runtime.digest)) {
    throw new Error('Kargo does not identify a qualified Restate release')
  }
  git(cwd, 'merge-base', '--is-ancestor', source, 'HEAD')
  const inputs = runtimeInputs('HEAD', cwd)
  return { reuse: inputs === runtimeInputs(source, cwd), source, run, digest: runtime.digest, inputs }
}

if (import.meta.main) {
  const plan = releasePlan()
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(plan)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    )
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
}
