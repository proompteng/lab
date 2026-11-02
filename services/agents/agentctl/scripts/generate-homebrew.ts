import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import process from 'node:process'
import { renderHomebrewFormula } from './homebrew/render-homebrew'
import { TARGETS } from './targets'

const DEFAULT_INPUT = 'dist/release'

type Options = {
  inputDir: string
  outputPath: string
  version?: string
}

const usage = () => {
  console.log(`Usage: bun run scripts/generate-homebrew.ts [options]

Options:
  --input <dir>    directory containing release artifacts (default: ${DEFAULT_INPUT})
  --output <path>  output path for agentctl.rb (default: <input>/agentctl.rb)
  --version <ver>  expected version (optional)
`)
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    inputDir: DEFAULT_INPUT,
    outputPath: '',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--input') {
      const value = argv[++i]
      if (!value) throw new Error('--input requires a value')
      options.inputDir = value
      continue
    }

    if (arg === '--output') {
      const value = argv[++i]
      if (!value) throw new Error('--output requires a value')
      options.outputPath = value
      continue
    }

    if (arg === '--version') {
      const value = argv[++i]
      if (!value) throw new Error('--version requires a value')
      options.version = value
      continue
    }

    if (arg === '--help' || arg === '-h') {
      usage()
      throw new Error('help requested')
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!options.outputPath) {
    options.outputPath = resolve(options.inputDir, 'agentctl.rb')
  }

  return options
}

const normalizeVersion = (value: string) => (value.startsWith('v') ? value.slice(1) : value)

const listFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)))
    } else {
      files.push(fullPath)
    }
  }

  return files
}

const parseChecksumFile = (contents: string, expectedName: string) => {
  const trimmed = contents.trim()
  const match = /^([a-f0-9]{64})\s+(.+)$/.exec(trimmed)
  if (!match) {
    throw new Error(`Invalid sha256 file contents for ${expectedName}`)
  }

  const [, hash, filename] = match
  if (filename !== expectedName) {
    throw new Error(`Checksum filename mismatch for ${expectedName}: found ${filename}`)
  }

  return hash
}

const hashFile = async (filePath: string) => {
  const data = await readFile(filePath)
  return createHash('sha256').update(data).digest('hex')
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const inputDir = resolve(options.inputDir)

  const files = await listFiles(inputDir)
  const tarballs = files.filter((file) => file.endsWith('.tar.gz'))
  const checksumFiles = new Map(files.filter((file) => file.endsWith('.sha256')).map((file) => [basename(file), file]))

  if (tarballs.length === 0) {
    throw new Error(`No release tarballs found under ${inputDir}`)
  }

  const checksums = new Map<string, string>()
  const versions = new Set<string>()

  for (const tarball of tarballs) {
    const name = basename(tarball)
    const match = /^agentctl-(.+)-(darwin|linux)-(amd64|arm64)\.tar\.gz$/.exec(name)
    if (!match) {
      continue
    }

    const [, version, platform, arch] = match
    const label = `${platform}-${arch}`
    versions.add(version)

    const checksumName = `${name}.sha256`
    const checksumPath = checksumFiles.get(checksumName)
    if (!checksumPath) {
      throw new Error(`Missing checksum file ${checksumName}`)
    }

    const checksumContents = await readFile(checksumPath, 'utf8')
    const expectedHash = parseChecksumFile(checksumContents, name)
    const actualHash = await hashFile(tarball)

    if (expectedHash !== actualHash) {
      throw new Error(`Checksum mismatch for ${name}`)
    }

    checksums.set(label, expectedHash)
  }

  const requiredLabels = TARGETS.map((target) => target.label)
  const missingLabels = requiredLabels.filter((label) => !checksums.has(label))

  if (missingLabels.length > 0) {
    throw new Error(`Missing artifacts for: ${missingLabels.join(', ')}`)
  }

  if (versions.size > 1) {
    throw new Error(`Multiple versions found in artifacts: ${Array.from(versions).join(', ')}`)
  }

  const resolvedVersion = normalizeVersion(options.version ?? Array.from(versions)[0] ?? '')
  if (!resolvedVersion) {
    throw new Error('Unable to determine release version from artifacts')
  }

  if (options.version && normalizeVersion(options.version) !== resolvedVersion) {
    throw new Error(`Version mismatch: expected ${options.version}, found ${resolvedVersion}`)
  }

  await mkdir(dirname(options.outputPath), { recursive: true })
  await renderHomebrewFormula({
    version: resolvedVersion,
    checksums,
    outputPath: resolve(options.outputPath),
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
