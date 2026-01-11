#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { $ } from 'bun'
import { runCli } from './lib/cli'

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
  const appDir = resolve(scriptDir, '../../..')
  const repoDir = resolve(appDir, '..', '..')
  const dockerfile = process.env.DOCKERFILE ?? resolve(appDir, 'Dockerfile.codex')
  const imageTag = process.env.IMAGE_TAG ?? 'registry.ide-newton.ts.net/lab/codex-universal:latest'
  const contextDir = process.env.CONTEXT_DIR ?? '.'
  const codexAuthPath = process.env.CODEX_AUTH ?? `${process.env.HOME ?? ''}/.codex/auth.json`
  const codexConfigPath = process.env.CODEX_CONFIG ?? `${process.env.HOME ?? ''}/.codex/config.toml`

  await ensureFile(dockerfile, 'Dockerfile')
  await ensureFile(codexAuthPath, 'Codex auth file')
  await ensureFile(codexConfigPath, 'Codex config file')

  const checksum = await computeChecksum(codexAuthPath)

  const githubToken = process.env.GITHUB_TOKEN
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is required to build the codex image.')
  }
  const tempDir = await mkdtemp(join(tmpdir(), 'codex-build-'))
  const ghTokenFile = join(tempDir, 'gh_token')
  await writeFile(ghTokenFile, githubToken, { encoding: 'utf8', mode: 0o600 })

  process.env.DOCKER_BUILDKIT = process.env.DOCKER_BUILDKIT ?? '1'

  const dockerfilePath = join('apps/froussard', 'Dockerfile.codex')
  const previousCwd = process.cwd()
  try {
    console.log(`Building ${imageTag} from ${dockerfile}`)
    process.chdir(repoDir)
    await $`docker build -f ${dockerfilePath} --build-arg CODEX_AUTH_CHECKSUM=${checksum} --secret id=codex_auth,src=${codexAuthPath} --secret id=codex_config,src=${codexConfigPath} --secret id=github_token,src=${ghTokenFile} -t ${imageTag} ${contextDir}`

    console.log(`Pushing ${imageTag}`)
    await $`docker push ${imageTag}`
  } finally {
    process.chdir(previousCwd)
    await rm(tempDir, { recursive: true, force: true })
  }

  return { imageTag }
}

await runCli(import.meta, async () => {
  await runBuildCodexImage()
})
