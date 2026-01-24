import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHomebrewFormula } from './homebrew/render-homebrew'
import { parseTargetsArgs, resolveTargets, TARGETS } from './targets'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')
const distDir = resolve(root, 'dist')
const releaseDir = resolve(distDir, 'release')

const loadPackageVersion = async () => {
  const packagePath = resolve(root, 'package.json')
  const data = await readFile(packagePath, 'utf8')
  const pkg = JSON.parse(data) as { version?: string }
  if (!pkg.version) {
    throw new Error('package.json missing version')
  }
  return pkg.version
}

const normalizeVersion = (value: string) => (value.startsWith('v') ? value.slice(1) : value)

const buildArchive = async (version: string, label: string) => {
  const archiveName = `agentctl-${version}-${label}.tar.gz`
  const archivePath = resolve(releaseDir, archiveName)
  const tempDir = await mkdtemp(resolve(tmpdir(), 'agentctl-release-'))
  const stagedBinary = resolve(tempDir, 'agentctl')
  const sourceBinary = resolve(distDir, 'agentctl.js')

  try {
    await copyFile(sourceBinary, stagedBinary)
    await chmod(stagedBinary, 0o755)

    const proc = Bun.spawn(['tar', '-C', tempDir, '-czf', archivePath, 'agentctl'], {
      cwd: root,
      stderr: 'inherit',
      stdout: 'inherit',
    })

    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(`tar failed for ${archiveName} with exit code ${exitCode}`)
    }

    const data = await readFile(archivePath)
    const sha256 = createHash('sha256').update(data).digest('hex')
    const checksumPath = `${archivePath}.sha256`
    await writeFile(checksumPath, `${sha256}  ${archiveName}\n`, 'utf8')

    console.log(`Wrote ${archiveName} and ${archiveName}.sha256`)

    return sha256
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

const main = async () => {
  const argv = Bun.argv.slice(2)
  const envTargets = process.env.AGENTCTL_TARGETS?.trim()
  const parsed = parseTargetsArgs(argv)
  const hasExplicitTargets = parsed.all || parsed.targets.length > 0 || Boolean(envTargets)
  const argvForTargets = hasExplicitTargets ? argv : ['--all', ...argv]
  const targets = resolveTargets(argvForTargets, envTargets)

  const buildProc = Bun.spawn(['bun', 'run', 'build'], {
    cwd: root,
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const buildExit = await buildProc.exited
  if (buildExit !== 0) {
    throw new Error(`bun run build failed with exit code ${buildExit}`)
  }
  await mkdir(releaseDir, { recursive: true })

  const packageVersion = await loadPackageVersion()
  const envVersion = process.env.AGENTCTL_VERSION
  const resolvedVersion = normalizeVersion(envVersion ?? packageVersion)

  if (envVersion && normalizeVersion(envVersion) !== packageVersion) {
    throw new Error(`AGENTCTL_VERSION (${envVersion}) does not match package.json (${packageVersion})`)
  }

  const checksums = new Map<string, string>()

  for (const target of targets) {
    const sha256 = await buildArchive(resolvedVersion, target.label)
    checksums.set(target.label, sha256)
  }

  const requiredLabels = TARGETS.map((target) => target.label)
  const hasAllChecksums = requiredLabels.every((label) => checksums.has(label))

  if (hasAllChecksums) {
    await renderHomebrewFormula({
      version: resolvedVersion,
      checksums,
      outputPath: resolve(releaseDir, 'agentctl.rb'),
    })
  } else {
    const missing = requiredLabels.filter((label) => !checksums.has(label))
    console.log(`Skipping Homebrew formula generation; missing checksums for: ${missing.join(', ')}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
