#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const rootDir = resolve(import.meta.dir, '..', '..', '..', '..')
const outputDir = resolve(rootDir, '.chart-packages')
const chartRepoUrl = 'https://github.com/proompteng/agents.git'

const chartWorkDir = await Bun.makeTempDir({ dir: tmpdir() })
const chartDir = join(chartWorkDir, 'agents')

const cloneResult = Bun.spawnSync(['git', 'clone', '--depth', '1', chartRepoUrl, chartDir])
if (cloneResult.exitCode !== 0) {
  const stderr = new TextDecoder().decode(cloneResult.stderr)
  throw new Error(`git clone failed: ${stderr || 'unknown error'}`)
}

const chartYaml = await Bun.file(resolve(chartDir, 'Chart.yaml')).text()
const chartVersion = chartYaml.match(/^version:\s*(.+)$/m)?.[1]?.trim()
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

await mkdir(outputDir, { recursive: true })

const packageResult = Bun.spawnSync(['helm', 'package', chartDir, '--destination', outputDir])

if (packageResult.exitCode !== 0) {
  const stderr = new TextDecoder().decode(packageResult.stderr)
  throw new Error(`helm package failed: ${stderr || 'unknown error'}`)
}

const stdout = new TextDecoder().decode(packageResult.stdout)
const packagePathMatch = stdout.match(/saved it to:\s*(.+)$/m)
const packagePath = packagePathMatch?.[1]?.trim()

if (!packagePath) {
  throw new Error(`Unable to detect packaged chart path from helm output: ${stdout}`)
}

if (!packagePath.endsWith(`-${chartVersion}.tgz`)) {
  throw new Error(`Packaged chart version does not match Chart.yaml (${chartVersion}).`)
}

const pushResult = Bun.spawnSync(['helm', 'push', packagePath, 'oci://ghcr.io/proompteng/agents'])

if (pushResult.exitCode !== 0) {
  const stderr = new TextDecoder().decode(pushResult.stderr)
  throw new Error(`helm push failed: ${stderr || 'unknown error'}`)
}

console.log(`Published ${packagePath} to ghcr.io/proompteng/agents`)
