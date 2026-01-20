import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBinaries } from './build-binaries'
import { resolveTargets } from './targets'

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

  const proc = Bun.spawn(['tar', '-C', distDir, '-czf', archivePath, binaryName], {
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

  for (const target of targets) {
    await buildArchive(resolvedVersion, target.label)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
