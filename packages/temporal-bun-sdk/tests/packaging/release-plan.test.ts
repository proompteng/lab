import { expect, test } from 'bun:test'

import { planRelease } from '../../scripts/release-plan'

const release = {
  eventName: 'push',
  ref: 'refs/heads/main',
  version: '0.11.4',
  manifestVersion: '0.11.4',
  previousVersion: '0.11.3',
}

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
