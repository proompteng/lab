#!/usr/bin/env bun

const chart = 'charts/agents/Chart.yaml'
const releaseInputs = ['charts/agents/templates/', 'charts/agents/crds/', 'charts/agents/values.yaml']

const git = (...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim())
  return result.stdout.toString().trim()
}

const chartVersion = (revision: string) => {
  const metadata: unknown = Bun.YAML.parse(git('show', `${revision}:${chart}`))
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || typeof metadata.version !== 'string') {
    throw new Error(`${chart} at ${revision} must contain a chart version.`)
  }
  return metadata.version
}

const main = (args: string[]) => {
  const [baseRef, headRef = 'HEAD'] = args
  if (!baseRef || args.length > 2) throw new Error('Usage: check-chart-version-bump.ts <base-ref> [head-ref]')

  const base = git('rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`)
  const head = git('rev-parse', '--verify', '--end-of-options', `${headRef}^{commit}`)
  const changes = git(
    'diff',
    '--name-only',
    '--no-renames',
    base,
    head,
    '--',
    ...releaseInputs.map((path) => `:(top)${path}`),
  )
  if (!changes) return

  const previousVersion = chartVersion(base)
  const proposedVersion = chartVersion(head)
  if (Bun.semver.order(proposedVersion, previousVersion) <= 0) {
    throw new Error(
      `Agents chart inputs changed. Increase ${chart} version above ${previousVersion} (found ${proposedVersion}).`,
    )
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
