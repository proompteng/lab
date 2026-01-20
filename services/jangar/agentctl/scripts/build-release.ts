import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBinaries } from './build-binaries'
import { resolveTargets, TARGETS } from './targets'

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
  const binaryName = `agentctl-${label}`
  const archiveName = `agentctl-${version}-${label}.tar.gz`
  const archivePath = resolve(releaseDir, archiveName)
  const tempDir = await mkdtemp(resolve(tmpdir(), 'agentctl-release-'))
  const stagedBinary = resolve(tempDir, 'agentctl')
  const sourceBinary = resolve(distDir, binaryName)

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
      throw new Error(`tar failed for ${binaryName} with exit code ${exitCode}`)
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

const renderHomebrewFormula = async (version: string, checksums: Map<string, string>) => {
  const templatePath = resolve(root, 'scripts/homebrew/agentctl.rb')
  const outputPath = resolve(releaseDir, 'agentctl.rb')

  const replacements = new Map<string, string>([
    ['__VERSION__', version],
    ['__SHA256_DARWIN_ARM64__', checksums.get('darwin-arm64') ?? ''],
    ['__SHA256_DARWIN_AMD64__', checksums.get('darwin-amd64') ?? ''],
    ['__SHA256_LINUX_ARM64__', checksums.get('linux-arm64') ?? ''],
    ['__SHA256_LINUX_AMD64__', checksums.get('linux-amd64') ?? ''],
  ])

  let template = await readFile(templatePath, 'utf8')

  for (const [token, value] of replacements) {
    if (!value) {
      throw new Error(`Missing checksum for ${token}`)
    }
    template = template.replaceAll(token, value)
  }

  if (template.includes('__VERSION__') || template.includes('__SHA256_')) {
    throw new Error('Homebrew formula template contains unreplaced tokens')
  }

  await writeFile(outputPath, template, 'utf8')
  console.log(`Wrote Homebrew formula to ${outputPath}`)
}

const main = async () => {
  const argv = Bun.argv.slice(2)
  const targets = resolveTargets(argv, process.env.AGENTCTL_TARGETS)

  await buildBinaries(argv)
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
    await renderHomebrewFormula(resolvedVersion, checksums)
  } else {
    const missing = requiredLabels.filter((label) => !checksums.has(label))
    console.log(`Skipping Homebrew formula generation; missing checksums for: ${missing.join(', ')}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
