#!/usr/bin/env bun

import { ensureCli, repoRoot } from '../shared/cli'
import { buildAndPushDockerImage } from '../shared/docker'

const DEFAULT_REGISTRY = 'registry.ide-newton.ts.net'
const DEFAULT_REPOSITORY = 'reestr'

export const main = async () => {
  ensureCli('docker')

  const registry = process.env.REGISTRY ?? DEFAULT_REGISTRY
  const repository = process.env.IMAGE_NAME ?? DEFAULT_REPOSITORY
  const tag = process.env.TAG ?? (await gitShortSha())
  const context = repoRoot
  const dockerfile = 'apps/reestr/Dockerfile'

  const result = await buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    cwd: repoRoot,
  })

  console.log(`Built and pushed ${result.image}`)
}

const gitShortSha = async (): Promise<string> => {
  ensureCli('git')
  const proc = Bun.spawn(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repoRoot, stdout: 'pipe', stderr: 'inherit' })
  const exit = await proc.exited
  if (exit !== 0) {
    throw new Error('Failed to determine git SHA')
  }
  const stdout = await new Response(proc.stdout).text()
  return stdout.trim()
}

await main().catch((err) => {
  console.error(err)
  process.exit(1)
})
