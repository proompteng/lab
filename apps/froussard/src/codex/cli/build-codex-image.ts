#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { $, which } from 'bun'
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

const parseScopes = (scopesHeader: string | null) =>
  scopesHeader
    ?.split(',')
    .map((scope) => scope.trim())
    .filter(Boolean) ?? []

const ensureWorkflowScope = async (token: string) => {
  if (process.env.CODEX_SKIP_GH_SCOPE_CHECK === '1' || process.env.SKIP_GH_SCOPE_CHECK === '1') {
    return
  }

  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `token ${token}`,
      'User-Agent': 'codex-build-codex-image',
    },
  })

  if (!response.ok) {
    throw new Error(
      `Failed to validate GitHub token scopes (status ${response.status}); supply GH_TOKEN with workflow scope.`,
    )
  }

  const scopes = parseScopes(response.headers.get('x-oauth-scopes'))
  if (!scopes.includes('workflow')) {
    const scopeList = scopes.length > 0 ? scopes.join(', ') : 'none'
    throw new Error(
      `GitHub token is missing required scope "workflow" (current scopes: ${scopeList}). Provide a token with workflow scope or set CODEX_SKIP_GH_SCOPE_CHECK=1 to bypass.`,
    )
  }
}

const loadGitHubToken = async (): Promise<string> => {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (token) {
    return token
  }

  try {
    const ghCli = await which('gh')
    if (!ghCli) {
      throw new Error('gh CLI not found; please install gh or export GH_TOKEN')
    }
    const ghUser = process.env.GH_TOKEN_USER ?? process.env.GH_AUTH_USER ?? 'tuslagch'
    const output = ghUser ? await $`${ghCli} auth token --user ${ghUser}`.text() : await $`${ghCli} auth token`.text()
    const trimmed = output.trim()
    if (trimmed) {
      return trimmed
    }
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message ? error.message : 'Set GH_TOKEN environment variable or login with gh',
    )
  }

  throw new Error('Set GH_TOKEN environment variable or login with gh')
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

  const githubToken = await loadGitHubToken()
  await ensureWorkflowScope(githubToken)
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

export const __private = { parseScopes, ensureWorkflowScope, loadGitHubToken }
