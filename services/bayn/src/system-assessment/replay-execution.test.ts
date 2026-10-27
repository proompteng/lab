import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { ReplayContainerInspectionSchema, verifyReplayContainer } from './replay-execution'
import { testHash, supportedAssessmentFixture } from './fixtures.test-support'
import { evaluateSystemAssessment, QualificationVerdict } from './assessment'

const fixture = () => {
  const expected = {
    containerId: testHash('container'),
    repository: 'registry.example.com/bayn',
    manifestDigest: `sha256:${testHash('manifest')}`,
    imageDigest: `sha256:${testHash('index')}`,
    configDigest: `sha256:${testHash('config')}`,
    captureFileHash: testHash('capture'),
    capturedAt: '2026-10-26T12:10:00.000Z',
  }
  const image = {
    Id: expected.manifestDigest,
    Descriptor: { digest: expected.manifestDigest },
    Config: { Env: ['PATH=/bin', 'NODE_ENV=production'] },
  }
  const container = Schema.decodeUnknownSync(ReplayContainerInspectionSchema)({
    Id: expected.containerId,
    Image: expected.imageDigest,
    ImageManifestDescriptor: { digest: expected.manifestDigest },
    Created: '2026-10-26T12:00:00.000000000Z',
    RestartCount: 0,
    State: {
      Status: 'exited',
      Running: false,
      Paused: false,
      Restarting: false,
      Dead: false,
      OOMKilled: false,
      ExitCode: 0,
      Error: '',
      StartedAt: '2026-10-26T12:01:00.000000001Z',
      FinishedAt: '2026-10-26T12:09:00.000000002Z',
    },
    Config: {
      Image: `${expected.repository}@${expected.manifestDigest}`,
      Entrypoint: ['node'],
      Cmd: [
        '/app/services/bayn/dist/backtest-command.js',
        '--input',
        '/evidence/input.json',
        '--arrivals',
        '/evidence/arrivals.ndjson.gz',
        '--source-receipt',
        '/evidence/source-receipt.json',
        '--source-receipt-sha256',
        expected.captureFileHash,
        '--output',
        '/result/run',
      ],
      Env: [
        ...image.Config.Env,
        'BAYN_BACKTEST_POSTGRES_URL=postgresql://test:test@127.0.0.1/bayn_replay',
        'BAYN_BACKTEST_TIGERBEETLE_ADDRESS=127.0.0.1:3000',
        'BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID=42',
        'BAYN_BACKTEST_TIGERBEETLE_LEDGER=42',
      ],
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: null,
      SecurityOpt: ['no-new-privileges=true'],
      RestartPolicy: { Name: 'no' },
    },
    Mounts: [
      { Type: 'bind', Destination: '/evidence', RW: false },
      { Type: 'bind', Destination: '/result', RW: true },
    ],
  })
  return { expected, image, container }
}

test('a completed exact-image command exposes only its isolated database targets for validation', () => {
  const f = fixture()
  expect(Result.getOrThrow(verifyReplayContainer(f.container, f.image, f.expected))).toEqual({
    postgresUrl: 'postgresql://test:test@127.0.0.1/bayn_replay',
    tigerBeetleAddress: '127.0.0.1:3000',
    clusterId: '42',
    ledger: '42',
  })
  expect(
    Result.isSuccess(
      verifyReplayContainer(
        { ...f.container, Config: { ...f.container.Config, Image: f.expected.imageDigest } },
        f.image,
        f.expected,
      ),
    ),
  ).toBe(true)
})

test('foreign images, changed commands, incomplete exits, writable code and injected environments cannot attest a replay', () => {
  const { container: c, image, expected } = fixture()
  const changes = [
    { ...c, Id: testHash('foreign') },
    { ...c, Image: `sha256:${testHash('other config')}` },
    { ...c, ImageManifestDescriptor: { digest: `sha256:${testHash('other platform')}` } },
    { ...c, RestartCount: 1 },
    { ...c, Created: '2026-10-26T12:02:00.000Z' },
    ...[
      { Status: 'running' },
      { Running: true },
      { Paused: true },
      { Restarting: true },
      { Dead: true },
      { OOMKilled: true },
      { ExitCode: 1 },
      { Error: 'runtime error' },
      { StartedAt: '2026-10-26T12:09:00.000000003Z' },
      { FinishedAt: '2026-10-26T12:11:00.000Z' },
    ].map((change) => ({ ...c, State: { ...c.State, ...change } })),
    ...[
      { ReadonlyRootfs: false },
      { Privileged: true },
      { CapDrop: null },
      { CapAdd: ['SYS_ADMIN'] },
      { SecurityOpt: [] },
      { RestartPolicy: { Name: 'always' } },
      { Tmpfs: { '/app': 'rw' } },
    ].map((change) => ({ ...c, HostConfig: { ...c.HostConfig, ...change } })),
    ...[
      { Image: 'registry.example.com/bayn:latest' },
      { Entrypoint: ['sh', '-c'] },
      { Cmd: ['/alternative.js'] },
      { User: '1000' },
      { WorkingDir: '/evidence' },
      { Healthcheck: { Test: ['CMD-SHELL', 'touch /result/modified'] } },
      { Env: [...(c.Config.Env ?? []), 'NODE_OPTIONS=--require=/evidence/inject.js'] },
      { Env: [...(c.Config.Env ?? []), 'BAYN_JEV_API_KEY=not-allowed'] },
      { Env: [...(c.Config.Env ?? []), 'PATH=/evidence'] },
      { Env: (c.Config.Env ?? []).filter((entry) => !entry.startsWith('BAYN_BACKTEST_TIGERBEETLE_LEDGER=')) },
    ].map((change) => ({ ...c, Config: { ...c.Config, ...change } })),
    { ...c, Mounts: [...c.Mounts, { Type: 'bind', Destination: '/app', RW: false }] },
    { ...c, Mounts: c.Mounts.map((mount) => ({ ...mount, RW: true })) },
    { ...c, Mounts: c.Mounts.map((mount) => ({ ...mount, Destination: '/result' })) },
  ]
  for (const changed of changes) expect(Result.isFailure(verifyReplayContainer(changed, image, expected))).toBe(true)
  expect(Result.isFailure(verifyReplayContainer(c, { ...image, Id: `sha256:${testHash('wrong')}` }, expected))).toBe(
    true,
  )
})

test('qualification requires independently retained execution receipts and exposes the observer trust assumptions', () => {
  const { input, verifiedSources } = supportedAssessmentFixture()
  const original = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
  expect(original.verdict).toBe(QualificationVerdict.Qualified)
  expect(original.executionProvenance.assumptions).toHaveLength(3)
  const missing = new Set(verifiedSources)
  for (const hash of original.executionProvenance.receiptHashes) missing.delete(hash)
  const result = Result.getOrThrow(evaluateSystemAssessment(input, missing))
  expect(result.verdict).not.toBe(QualificationVerdict.Qualified)
  expect(result.missing.some((reason) => reason.includes('UNVERIFIED_SOURCE'))).toBe(true)
})
