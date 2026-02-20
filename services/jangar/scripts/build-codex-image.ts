#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { $ } from 'bun'
import { runCli } from './codex/lib/cli'

const pathExists = async (path: string) => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

const ensureFile = async (path: string, description: string) => {
  if (!(await pathExists(path))) {
    throw new Error(`${description} not found: ${path}`)
  }
}

const computeChecksum = async (path: string) => {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

export const runBuildCodexImage = async () => {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const appDir = resolve(scriptDir, '..')
  const repoDir = resolve(appDir, '..', '..')
  const dockerfile = process.env.DOCKERFILE ?? resolve(appDir, 'Dockerfile.codex')
  const imageTag = process.env.IMAGE_TAG ?? 'registry.ide-newton.ts.net/lab/codex-universal:20260219-234214-2a44dd59-dl'
  const contextDir = process.env.CONTEXT_DIR ?? '.'
  const codexAuthPath = process.env.CODEX_AUTH ?? `${process.env.HOME ?? ''}/.codex/auth.json`
  const codexConfigPath = process.env.CODEX_CONFIG ?? `${process.env.HOME ?? ''}/.codex/config.toml`

  await ensureFile(dockerfile, 'Dockerfile')
  await ensureFile(codexAuthPath, 'Codex auth file')
  await ensureFile(codexConfigPath, 'Codex config file')

  const checksum = await computeChecksum(codexAuthPath)

  process.env.DOCKER_BUILDKIT = process.env.DOCKER_BUILDKIT ?? '1'

  const previousCwd = process.cwd()
  try {
    console.log(`Building ${imageTag} from ${dockerfile}`)
    process.chdir(repoDir)
    await $`docker build -f ${dockerfile} --build-arg CODEX_AUTH_CHECKSUM=${checksum} --secret id=codex_auth,src=${codexAuthPath} --secret id=codex_config,src=${codexConfigPath} -t ${imageTag} ${contextDir}`

    console.log(`Pushing ${imageTag}`)
    await $`docker push ${imageTag}`
  } finally {
    process.chdir(previousCwd)
  }

  return { imageTag }
}

await runCli(import.meta, async () => {
  await runBuildCodexImage()
})
