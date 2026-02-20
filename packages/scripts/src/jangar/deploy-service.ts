#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'
import { updateJangarManifests } from './update-manifests'

type DeployOptions = {
  registry?: string
  repository?: string
  tag?: string
  kustomizePath?: string
  serviceManifest?: string
  workerManifest?: string
}

const capture = async (cmd: string[], env?: Record<string, string | undefined>): Promise<string> => {
  const subprocess = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: buildEnv(env),
  })

  void subprocess.stdin?.end()

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])

  if (exitCode !== 0) {
    fatal(`Command failed (${exitCode}): ${cmd.join(' ')}`, stderr)
  }

  return stdout.trim()
}

const fetchHelmV3 = (): { binary: string; tempDir: string } => {
  const version = process.env.HELM_V3_VERSION ?? 'v3.15.4'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  const url = `https://get.helm.sh/helm-${version}-${os}-${arch}.tar.gz`

  const tmpDir = mkdtempSync(join(tmpdir(), 'helm-v3-'))
  const archivePath = join(tmpDir, 'helm.tgz')
  const download = spawnSync('curl', ['-fsSL', url, '-o', archivePath])
  if (download.status !== 0) {
    fatal(`Failed to download helm ${version} from ${url}`, download.stderr?.toString())
  }

  const extract = spawnSync('tar', ['-xzf', archivePath, '-C', tmpDir])
  if (extract.status !== 0) {
    fatal(`Failed to extract helm archive ${archivePath}`, extract.stderr?.toString())
  }

  const binaryPath = join(tmpDir, `${os}-${arch}`, 'helm')
  return { binary: binaryPath, tempDir: tmpDir }
}

const resolveHelmBinary = (): { binary: string; tempDir?: string; shim?: string } => {
  const envBin = process.env.HELM_BIN
  if (envBin) return { binary: envBin }

  const helmPath = Bun.which('helm')
  if (helmPath) {
    const version = spawnSync(helmPath, ['version', '--short'], { encoding: 'utf8' })
    const output = typeof version.stdout === 'string' ? version.stdout.trim() : ''
    if (output.startsWith('v3.')) {
      return { binary: helmPath }
    }
  }

  const misePath = Bun.which('mise')
  if (misePath) {
    const version = (process.env.HELM_V3_VERSION ?? 'v3.15.4').replace(/^v/, '')
    const helmDir = mkdtempSync(join(tmpdir(), 'helm-mise-shim-'))
    const shimPath = join(helmDir, 'helm')
    const script = `#!/usr/bin/env bash\nset -euo pipefail\nexec ${misePath} x helm@${version} -- helm "$@"\n`
    writeFileSync(shimPath, script, { mode: 0o755 })
    return { binary: shimPath, tempDir: helmDir, shim: 'mise' }
  }

  const download = fetchHelmV3()
  return download
}

const writeHelmShim = (): { helmDir: string; helmBinary: string; cleanup: () => void } => {
  const helmResolved = resolveHelmBinary()
  if (helmResolved.shim === 'mise') {
    return {
      helmDir: helmResolved.tempDir ?? tmpdir(),
      helmBinary: helmResolved.binary,
      cleanup: () => helmResolved.tempDir && rmSync(helmResolved.tempDir, { recursive: true, force: true }),
    }
  }

  const helmBinary = helmResolved.binary
  const helmDir = mkdtempSync(join(tmpdir(), 'helm-shim-'))
  const shimPath = join(helmDir, 'helm')
  const script = `#!/usr/bin/env bash
set -euo pipefail
args=()
for a in "$@"; do
  if [[ "$a" == "-c" ]]; then
    continue
  fi
  args+=("$a")
done
exec ${helmBinary} "${'${'}args[@]}"
`
  writeFileSync(shimPath, script, { mode: 0o755 })
  const cleanup = () => {
    rmSync(helmDir, { recursive: true, force: true })
    if (helmResolved.tempDir) {
      rmSync(helmResolved.tempDir, { recursive: true, force: true })
    }
  }
  return { helmDir, helmBinary: shimPath, cleanup }
}

const buildEnv = (env?: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(env ? { ...process.env, ...env } : process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>

const resolveKustomizeNamespace = (kustomizePath: string) => {
  const envNamespace = process.env.JANGAR_K8S_NAMESPACE?.trim()
  if (envNamespace) {
    return envNamespace
  }
  try {
    const kustomizationPath = resolve(kustomizePath, 'kustomization.yaml')
    const kustomization = readFileSync(kustomizationPath, 'utf8')
    const match = kustomization.match(/^namespace:\s*([^\s#]+)/m)
    if (match?.[1]) {
      return match[1]
    }
  } catch {
    // fall back to default below
  }
  return 'jangar'
}

const resolveDeploymentNames = () => {
  const raw = process.env.JANGAR_K8S_DEPLOYMENTS?.trim()
  if (!raw) {
    return ['jangar', 'jangar-worker']
  }
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)

  return names.length > 0 ? names : ['jangar', 'jangar-worker']
}

export const main = async (options: DeployOptions = {}) => {
  ensureCli('kubectl')
  ensureCli('curl')
  ensureCli('tar')
  const registry = options.registry ?? process.env.JANGAR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.JANGAR_IMAGE_REPOSITORY ?? 'lab/jangar'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = options.tag ?? process.env.JANGAR_IMAGE_TAG ?? defaultTag
  const imageName = `${registry}/${repository}`
  const image = `${registry}/${repository}:${tag}`

  await buildImage({ registry, repository, tag })

  const repoDigest = inspectImageDigest(image)
  const digest = repoDigest.includes('@') ? repoDigest.split('@')[1] : repoDigest
  console.log(`Image digest: ${repoDigest}`)

  const kustomizePath = resolve(
    repoRoot,
    options.kustomizePath ?? process.env.JANGAR_KUSTOMIZE_PATH ?? 'argocd/applications/jangar',
  )
  const serviceManifest = resolve(
    repoRoot,
    options.serviceManifest ?? process.env.JANGAR_SERVICE_MANIFEST ?? 'argocd/applications/jangar/deployment.yaml',
  )
  const workerManifest = resolve(
    repoRoot,
    options.workerManifest ??
      process.env.JANGAR_WORKER_MANIFEST ??
      'argocd/applications/jangar/jangar-worker-deployment.yaml',
  )

  // Persist image tag and rollout marker in Git before applying
  updateJangarManifests({
    imageName,
    tag,
    digest,
    rolloutTimestamp: new Date().toISOString(),
    kustomizationPath: `${kustomizePath}/kustomization.yaml`,
    serviceManifestPath: serviceManifest,
    workerManifestPath: workerManifest,
  })

  const { helmDir, helmBinary, cleanup } = writeHelmShim()
  const kubectl = Bun.which('kubectl')
  if (!kubectl) {
    fatal('Missing kubectl: install kubectl to render kustomize manifests')
  }
  const renderEnv = { PATH: `${helmDir}:${process.env.PATH ?? ''}`, HELM_BIN: helmBinary }
  const rendered = await capture([kubectl, 'kustomize', kustomizePath, '--enable-helm'], renderEnv)
  const tmpDir = mkdtempSync(`${tmpdir()}/jangar-render-`)
  const tmpPath = resolve(tmpDir, 'manifests.yaml')
  try {
    writeFileSync(tmpPath, rendered)
    await run('kubectl', ['apply', '-f', tmpPath])
    const namespace = resolveKustomizeNamespace(kustomizePath)
    for (const deploymentName of resolveDeploymentNames()) {
      await run('kubectl', ['rollout', 'status', `deployment/${deploymentName}`, '-n', namespace])
    }
  } finally {
    cleanup()
    try {
      rmSync(tmpPath, { force: true })
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy jangar', error))
}

export const __private = { capture, execGit }
