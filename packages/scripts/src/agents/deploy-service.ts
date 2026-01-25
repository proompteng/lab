#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import YAML from 'yaml'
import { buildImage } from '../jangar/build-image'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

type Options = {
  kustomizePath: string
  valuesPath: string
  registry: string
  repository: string
  tag: string
  apply: boolean
}

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

const parseArgs = (argv: string[]): Partial<Options> => {
  const options: Partial<Options> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--kustomize-path') {
      options.kustomizePath = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--kustomize-path=')) {
      options.kustomizePath = arg.slice('--kustomize-path='.length)
      continue
    }
    if (arg === '--values') {
      options.valuesPath = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--values=')) {
      options.valuesPath = arg.slice('--values='.length)
      continue
    }
    if (arg === '--registry') {
      options.registry = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--registry=')) {
      options.registry = arg.slice('--registry='.length)
      continue
    }
    if (arg === '--repository') {
      options.repository = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }
    if (arg === '--tag') {
      options.tag = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }
    if (arg === '--no-apply') {
      options.apply = false
    }
  }
  return options
}

const resolveOptions = (): Options => {
  const args = parseArgs(process.argv.slice(2))
  const registry = args.registry ?? process.env.JANGAR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = args.repository ?? process.env.JANGAR_IMAGE_REPOSITORY ?? 'lab/jangar'
  const tag = args.tag ?? process.env.JANGAR_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])

  return {
    kustomizePath: resolve(
      repoRoot,
      args.kustomizePath ?? process.env.AGENTS_KUSTOMIZE_PATH ?? 'argocd/applications/agents',
    ),
    valuesPath: resolve(
      repoRoot,
      args.valuesPath ?? process.env.AGENTS_VALUES_PATH ?? 'argocd/applications/agents/values.yaml',
    ),
    registry,
    repository,
    tag,
    apply: args.apply ?? parseBoolean(process.env.AGENTS_APPLY, true),
  }
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

const buildEnv = (env?: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(env ? { ...process.env, ...env } : process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>

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

  return fetchHelmV3()
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

const updateValuesFile = (valuesPath: string, imageRepository: string, tag: string, digest: string) => {
  const raw = readFileSync(valuesPath, 'utf8')
  const doc = YAML.parse(raw) ?? {}

  doc.image ??= {}
  doc.image.repository = imageRepository
  doc.image.tag = tag
  doc.image.digest = digest

  writeFileSync(valuesPath, YAML.stringify(doc, { lineWidth: 120 }))
  console.log(`Updated ${valuesPath} with ${imageRepository}:${tag}@${digest}`)
}

const renderAndApply = async (kustomizePath: string) => {
  ensureCli('kubectl')
  const { helmDir, helmBinary, cleanup } = writeHelmShim()
  const kubectl = Bun.which('kubectl')
  if (!kubectl) {
    fatal('Missing kubectl: install kubectl to render kustomize manifests')
  }
  const renderEnv = { PATH: `${helmDir}:${process.env.PATH ?? ''}`, HELM_BIN: helmBinary }
  const rendered = await capture([kubectl, 'kustomize', kustomizePath, '--enable-helm'], renderEnv)
  const tmpDir = mkdtempSync(`${tmpdir()}/agents-render-`)
  const tmpPath = resolve(tmpDir, 'manifests.yaml')
  try {
    writeFileSync(tmpPath, rendered)
    await run('kubectl', ['apply', '-f', tmpPath])
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

const main = async () => {
  const options = resolveOptions()
  ensureCli('docker')
  ensureCli('curl')
  ensureCli('tar')

  const imageName = `${options.registry}/${options.repository}`
  const image = `${imageName}:${options.tag}`

  await buildImage({ registry: options.registry, repository: options.repository, tag: options.tag })

  const repoDigest = inspectImageDigest(image)
  const digest = repoDigest.includes('@') ? repoDigest.split('@')[1] : repoDigest

  updateValuesFile(options.valuesPath, imageName, options.tag, digest)

  if (options.apply) {
    await renderAndApply(options.kustomizePath)
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy agents', error))
}

export const __private = {
  parseArgs,
  parseBoolean,
  resolveOptions,
  updateValuesFile,
}
