import { expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertPublishTag, planRelease } from '../../scripts/release-plan'

const release = {
  eventName: 'push',
  ref: 'refs/heads/main',
  version: '0.11.4',
  manifestVersion: '0.11.4',
  previousVersion: '0.11.3',
}

test('publication allows new tags, newer versions, and verification retries', () => {
  expect(() => assertPublishTag('0.11.4')).not.toThrow()
  expect(() => assertPublishTag('0.11.4', '0.11.3')).not.toThrow()
  expect(() => assertPublishTag('0.11.4', '0.11.4')).not.toThrow()
})

test('out-of-order publication cannot move a dist-tag backward', () => {
  expect(() => assertPublishTag('0.11.4', '0.11.5')).toThrow('backward')
  expect(() => assertPublishTag('0.12.0-beta.1', '0.12.0-beta.2')).toThrow('backward')
})

test('publishes a merged version increase with matching metadata', () => {
  expect(planRelease(release)).toEqual({ publish: true, version: '0.11.4', npm_tag: 'latest', dry_run: 'false' })
})

test('ordinary source pushes, pull requests, and preparation cannot publish', () => {
  expect(planRelease({ ...release, previousVersion: '0.11.4' }).publish).toBeFalse()
  expect(planRelease({ ...release, eventName: 'pull_request' }).publish).toBeFalse()
  expect(planRelease({ ...release, eventName: 'workflow_dispatch', mode: 'prepare' }).publish).toBeFalse()
  expect(planRelease({ ...release, ref: 'refs/heads/topic' }).publish).toBeFalse()
  expect(
    planRelease({ ...release, eventName: 'workflow_dispatch', mode: 'publish', ref: 'refs/heads/topic' }).publish,
  ).toBeFalse()
})

test('manual publish supports retries and dry runs', () => {
  expect(planRelease({ ...release, eventName: 'workflow_dispatch', mode: 'publish', dryRun: 'true' })).toEqual({
    publish: true,
    version: '0.11.4',
    npm_tag: 'latest',
    dry_run: 'true',
  })
})

test('rejects mismatched manifests, rollbacks, and missing push history', () => {
  expect(() => planRelease({ ...release, manifestVersion: '0.11.3' })).toThrow('must match')
  expect(() => planRelease({ ...release, previousVersion: '0.12.0' })).toThrow('version increase')
  expect(() => planRelease({ ...release, previousVersion: undefined })).toThrow('version increase')
})

test('prereleases require an explicit non-latest tag', () => {
  const prerelease = { ...release, version: '0.12.0-beta.1', manifestVersion: '0.12.0-beta.1' }
  expect(() => planRelease(prerelease)).toThrow('prereleases manually')
  expect(
    planRelease({ ...prerelease, eventName: 'workflow_dispatch', mode: 'publish', npmTag: 'beta' }).publish,
  ).toBeTrue()
})

test('rejects malformed versions and workflow inputs before emitting outputs', () => {
  expect(() => planRelease({ ...release, version: '0.11.4\npublish=true' })).toThrow('semantic version')
  for (const npmTag of ['latest\npublish=true', '$(echo injected)', 'v1', 'Latest']) {
    expect(() => planRelease({ ...release, npmTag })).toThrow('dist-tag')
  }
  expect(() => planRelease({ ...release, dryRun: 'maybe' })).toThrow('dry_run')
})

test.each([false, true])('publication checks the recorded merge base before emitting outputs (changed=%s)', async (changed) => {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-release-base-'))
  try {
    const base = 'd'.repeat(40)
    const actualBase = (changed ? 'e' : 'd').repeat(40)
    await Bun.write(join(directory, 'packages/temporal-bun-sdk/package.json'), JSON.stringify({ version: release.version }))
    await writeFile(join(directory, '.release-please-manifest.json'), JSON.stringify({ 'packages/temporal-bun-sdk': release.version }))
    await writeFile(join(directory, 'event.json'), JSON.stringify({ before: actualBase }))
    const git = join(directory, 'git')
    await writeFile(git, `#!${process.execPath}
const args = process.argv.slice(2)
if (args.at(-1).includes(':packages/')) console.log(JSON.stringify({ version: '0.11.3' }))
else if (args.includes('--format=%B')) console.log('Release SDK\\n\\nTemporal-Bun-Release-Base: ${base}')
else if (args.includes('--format=%P')) console.log('${actualBase}')
else process.exit(2)
`)
    await chmod(git, 0o755)
    const output = join(directory, 'output')
    await writeFile(output, '')
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../../scripts/release-plan.ts')], {
      cwd: directory,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_EVENT_PATH: join(directory, 'event.json'), GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_OUTPUT: output },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
    expect(code).toBe(changed ? 1 : 0)
    const emitted = await readFile(output, 'utf8')
    if (changed) {
      expect(stderr).toContain('main changed during the release merge')
      expect(emitted).toBe('')
    } else expect(emitted).toContain('publish=true')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
