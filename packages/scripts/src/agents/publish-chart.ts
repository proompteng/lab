#!/usr/bin/env bun

import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

const rootDir = resolve(import.meta.dir, '..', '..', '..', '..')
const outputDir = resolve(rootDir, '.chart-packages')
const localPackageDir = resolve(outputDir, 'local')
const existingPackageDir = resolve(outputDir, 'existing')
const defaultChartDir = resolve(rootDir, 'charts', 'agents')
const chartPackageRef = 'oci://ghcr.io/proompteng/charts/agents'
const chartPushRef = 'oci://ghcr.io/proompteng/charts'
const decode = (bytes: Uint8Array<ArrayBufferLike>) => new TextDecoder().decode(bytes).trim()
const parseBooleanEnv = (value: string | undefined) => value === '1' || value?.toLowerCase() === 'true'

const parseArgs = () => {
  const args = process.argv.slice(2)
  let chartDir = defaultChartDir
  let dryRun = parseBooleanEnv(process.env.AGENTS_CHART_DRY_RUN)

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--chart-dir') {
      const value = args[index + 1]
      if (!value) {
        throw new Error('Missing value for --chart-dir')
      }
      chartDir = resolve(value)
      index += 1
      continue
    }
    if (arg.startsWith('--chart-dir=')) {
      chartDir = resolve(arg.slice('--chart-dir='.length))
      continue
    }
  }

  return { chartDir, dryRun }
}

const { chartDir, dryRun } = parseArgs()
const signChart = parseBooleanEnv(process.env.AGENTS_CHART_SIGN)
const signingKey = process.env.AGENTS_CHART_SIGN_KEY?.trim()
const signingKeyring = process.env.AGENTS_CHART_SIGN_KEYRING?.trim()
const signingPassphraseFile = process.env.AGENTS_CHART_SIGN_PASSPHRASE_FILE?.trim()

if (signChart && !signingKey) {
  throw new Error('AGENTS_CHART_SIGN_KEY is required when AGENTS_CHART_SIGN=true.')
}

if (!(await Bun.file(resolve(chartDir, 'Chart.yaml')).exists())) {
  throw new Error(`Chart.yaml not found in ${chartDir}`)
}

const chartYaml = await Bun.file(resolve(chartDir, 'Chart.yaml')).text()
const chartName = chartYaml.match(/^name:\s*(.+)$/m)?.[1]?.trim()
const chartVersion = chartYaml.match(/^version:\s*(.+)$/m)?.[1]?.trim()
if (!chartName) {
  throw new Error('Chart.yaml is missing a name')
}
if (!chartVersion) {
  throw new Error('Chart.yaml is missing a version')
}

const artifactHubYamlPath = resolve(chartDir, 'artifacthub-pkg.yml')
const artifactHubYaml = await Bun.file(artifactHubYamlPath).text()
const artifactHubVersion = artifactHubYaml.match(/^version:\s*(.+)$/m)?.[1]?.trim()
if (!artifactHubVersion) {
  throw new Error('artifacthub-pkg.yml is missing a version')
}
if (artifactHubVersion !== chartVersion) {
  throw new Error(`artifacthub-pkg.yml version (${artifactHubVersion}) does not match Chart.yaml (${chartVersion}).`)
}

await mkdir(localPackageDir, { recursive: true })
await mkdir(existingPackageDir, { recursive: true })

const comparePackagesByContents = async (newPackagePath: string, existingPackagePath: string) => {
  const compareDir = await mkdtemp(join(tmpdir(), 'agents-chart-compare-'))
  const newExtractDir = resolve(compareDir, 'new')
  const existingExtractDir = resolve(compareDir, 'existing')
  await mkdir(newExtractDir, { recursive: true })
  await mkdir(existingExtractDir, { recursive: true })

  const extractNewResult = Bun.spawnSync(['tar', '-xzf', newPackagePath, '-C', newExtractDir])
  if (extractNewResult.exitCode !== 0) {
    throw new Error(`failed to unpack ${newPackagePath}: ${decode(extractNewResult.stderr) || 'unknown error'}`)
  }

  const extractExistingResult = Bun.spawnSync(['tar', '-xzf', existingPackagePath, '-C', existingExtractDir])
  if (extractExistingResult.exitCode !== 0) {
    throw new Error(
      `failed to unpack ${existingPackagePath}: ${decode(extractExistingResult.stderr) || 'unknown error'}`,
    )
  }

  const diffResult = Bun.spawnSync(['diff', '-qr', newExtractDir, existingExtractDir])
  if (diffResult.exitCode === 0) {
    return true
  }
  if (diffResult.exitCode === 1) {
    return false
  }

  throw new Error(`failed to compare unpacked charts: ${decode(diffResult.stderr) || 'unknown error'}`)
}

const packageArgs = ['helm', 'package', chartDir, '--destination', localPackageDir]
if (signChart) {
  packageArgs.push('--sign', '--key', signingKey as string)
  if (signingKeyring) {
    packageArgs.push('--keyring', signingKeyring)
  }
  if (signingPassphraseFile) {
    packageArgs.push('--passphrase-file', signingPassphraseFile)
  }
}

const packageResult = Bun.spawnSync(packageArgs)
if (packageResult.exitCode !== 0) {
  throw new Error(`helm package failed: ${decode(packageResult.stderr) || 'unknown error'}`)
}

const packageOutput = decode(packageResult.stdout)
const packagePathMatch = packageOutput.match(/saved it to:\s*(.+)$/m)
const rawPackagePath = packagePathMatch?.[1]?.trim()
if (!rawPackagePath) {
  throw new Error(`Unable to detect packaged chart path from helm output: ${packageOutput}`)
}

const packagePath = isAbsolute(rawPackagePath) ? rawPackagePath : resolve(rawPackagePath)
if (!packagePath.endsWith(`-${chartVersion}.tgz`)) {
  throw new Error(`Packaged chart version does not match Chart.yaml (${chartVersion}).`)
}
if (basename(packagePath) !== `${chartName}-${chartVersion}.tgz`) {
  throw new Error(`Packaged chart name does not match Chart.yaml (${chartName}).`)
}

const provenancePath = `${packagePath}.prov`
if (signChart && !(await Bun.file(provenancePath).exists())) {
  throw new Error(`helm package --sign completed but provenance file was not created at ${provenancePath}.`)
}

if (dryRun) {
  console.log(`Dry run packaged ${packagePath}; skipping pull and push.`)
  if (signChart) {
    console.log(`Dry run generated provenance ${provenancePath}.`)
  }
  process.exit(0)
}

const pullResult = Bun.spawnSync([
  'helm',
  'pull',
  chartPackageRef,
  '--version',
  chartVersion,
  '--destination',
  existingPackageDir,
])
if (pullResult.exitCode === 0) {
  const existingPackagePath = resolve(existingPackageDir, `${chartName}-${chartVersion}.tgz`)
  if (!(await Bun.file(existingPackagePath).exists())) {
    throw new Error(`helm pull succeeded but package not found at ${existingPackagePath}`)
  }

  if (await comparePackagesByContents(packagePath, existingPackagePath)) {
    console.log(`Chart ${chartVersion} is already published with matching contents; skipping push.`)
    process.exit(0)
  }

  throw new Error(
    `Chart ${chartVersion} already exists in ghcr.io/proompteng/charts/${chartName} with different contents. Bump Chart.yaml version before publishing.`,
  )
}

const pushResult = Bun.spawnSync(['helm', 'push', packagePath, chartPushRef])
if (pushResult.exitCode !== 0) {
  throw new Error(`helm push failed: ${decode(pushResult.stderr) || 'unknown error'}`)
}

console.log(`Published ${packagePath} to ${chartPushRef}`)
if (signChart) {
  console.log(`Published provenance ${provenancePath} with the chart package.`)
}
