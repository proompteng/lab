#!/usr/bin/env bun
import { appendFile, readFile } from 'node:fs/promises'

const packagePath = 'packages/temporal-bun-sdk/package.json'
const component = 'packages/temporal-bun-sdk'
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export const assertPublishTag = (version: string, currentVersion?: string) => {
  if (currentVersion && Bun.semver.order(version, currentVersion) < 0) {
    throw new Error(`Refusing to move an npm dist-tag backward from ${currentVersion} to ${version}`)
  }
}

export const planRelease = (input: {
  eventName: string
  ref: string
  mode?: string
  version: string
  manifestVersion: string
  previousVersion?: string
  npmTag?: string
  dryRun?: string
}) => {
  const npmTag = input.npmTag || 'latest'
  const dryRun = input.dryRun || 'false'
  if (!versionPattern.test(input.version) || !Bun.semver.satisfies(input.version, input.version)) {
    throw new Error('The SDK package version must be a valid semantic version')
  }
  if (input.manifestVersion !== input.version) {
    throw new Error('The SDK package version and release-please manifest must match')
  }
  if (!/^[a-z][a-z0-9-]*$/.test(npmTag) || /^v\d/.test(npmTag)) {
    throw new Error('npm_tag must be a lowercase dist-tag such as latest, beta, or next')
  }
  if (dryRun !== 'true' && dryRun !== 'false') {
    throw new Error('dry_run must be true or false')
  }
  const manual = input.eventName === 'workflow_dispatch' && input.mode === 'publish'
  const bumped = input.eventName === 'push' && input.previousVersion !== input.version
  if (bumped && (!input.previousVersion || Bun.semver.order(input.version, input.previousVersion) !== 1)) {
    throw new Error('Automatic publication requires a version increase')
  }
  if ((bumped || manual) && input.version.includes('-') && npmTag === 'latest') {
    throw new Error('Publish prereleases manually with npm_tag set to beta or next')
  }
  return {
    publish: input.ref === 'refs/heads/main' && (manual || bumped),
    version: input.version,
    npm_tag: npmTag,
    dry_run: dryRun,
  }
}

if (import.meta.main) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as {
    before?: string
    inputs?: { release_mode?: string; npm_tag?: string; dry_run?: string }
  }
  const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string }
  const manifest = JSON.parse(await readFile('.release-please-manifest.json', 'utf8')) as Record<string, string>
  let previousVersion: string | undefined
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    if (!event.before || !/^[a-f0-9]{40}$/.test(event.before)) throw new Error('Missing push base commit')
    const previous = Bun.spawnSync(['git', 'show', `${event.before}:${packagePath}`])
    if (previous.exitCode !== 0) throw new Error('Cannot read the SDK version at the push base commit')
    previousVersion = (JSON.parse(previous.stdout.toString()) as { version: string }).version
  }
  const plan = planRelease({
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    ref: process.env.GITHUB_REF ?? '',
    mode: event.inputs?.release_mode,
    version: pkg.version,
    manifestVersion: manifest[component] ?? '',
    previousVersion,
    npmTag: event.inputs?.npm_tag,
    dryRun: event.inputs?.dry_run,
  })
  if (plan.publish) {
    const sha = process.env.GITHUB_SHA
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Missing publication commit')
    const message = Bun.spawnSync(['git', 'show', '-s', '--format=%B', sha])
    const parents = Bun.spawnSync(['git', 'show', '-s', '--format=%P', sha])
    if (message.exitCode !== 0 || parents.exitCode !== 0) throw new Error('Cannot read the publication commit')
    const prefix = 'Temporal-Bun-Release-Base:'
    const [recordedBase, ...otherBases] = message.stdout
      .toString()
      .split('\n')
      .filter((line) => line.startsWith(prefix))
    if (
      recordedBase &&
      (otherBases.length > 0 ||
        !/^Temporal-Bun-Release-Base: [a-f0-9]{40}$/.test(recordedBase) ||
        recordedBase.slice(prefix.length).trim() !== parents.stdout.toString().trim())
    ) {
      throw new Error(
        'Refusing publication: main changed during the release merge. Prepare a new release from current main.',
      )
    }
  }
  console.log(JSON.stringify(plan))
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(plan)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    )
  }
}
