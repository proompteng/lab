import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import YAML from 'yaml'

type Deployment = {
  id: string
  endpoint: string
  sourceRevision: string
  services: string[]
  managedBy: string
  serviceMetadata: string
  status: 'Active' | 'Drained'
  revision: number
  latest: boolean
}

type FakeState = {
  expected: Array<Pick<Deployment, 'id' | 'endpoint'>>
  deployments: Deployment[]
  nonterminalInvocations: number
  removalCount: number
  abortSqlAfterRemovalCount?: number
  abortSqlEnabled?: boolean
  injectInvocationAfterRemovalCount?: number
  failRemoveId?: string
}

const expected = [
  ['dp_13XIXwisR4a4XPwInU61DdD', '204d8a95a510', '204d8a95a5107fdb5061c25b09a801b3589eb936'],
  ['dp_12FbnURmXhz4YDXGMKwBMxH', 'c20d5ebb8bb4', 'c20d5ebb8bb43c04ff93bd8887846133f9d12738'],
  ['dp_11BZh6bYzTynrUC6zv2hxkJ', 'f024ca5775cd', 'f024ca5775cde0310175e8551cdbaf84def2e238'],
  ['dp_178DKWDx7eqEtZlwgKVZmYV', 'b919699d8530', 'b919699d85305f688ebaec12bf17cd4463396505'],
  ['dp_12papCaGWaZ5kTxJ7J78LyV', '2a534018c63d', '2a534018c63dfbf69aec51acc8f1cd50c292dc0f'],
  ['dp_10xLcEOYlB208R6PAKKTC25', '23448de7ce3f', '23448de7ce3f2f3cf5ca8be9728802e2dbb0f60d'],
  ['dp_12nzmurqJv7aVfYOTVXItDH', '9d3d287ef48c', '9d3d287ef48c0ba955bf7bb2f722264b8e0de433'],
  ['dp_10Di1UBU76eATDzMqugXgIN', 'b307fe01a289', 'b307fe01a289db1fd400703fce06bc17cb6925a5'],
  ['dp_13vCdQ6lbjrevjrCLOWQ5H3', '76365fc2b510', '76365fc2b510fb35b6048618b205cb917e1a58b3'],
  ['dp_16oanWtAAdHOuxdxwGKQlBT', '20ddacc519c9', '20ddacc519c962b6de675f461b1136dfb5d14e52'],
  ['dp_12vwwQgU6Y6vnM3cw0VxSUh', 'df500668c6df', 'df500668c6dfe137fde8e47231f39c3e64e47841'],
  ['dp_178ePC80z9ziJceYP31cKOt', '1c19bedfe651', '1c19bedfe651b3cd8c7df219c9d7468be1ec13b0'],
  ['dp_13EX9jelryvC2VBhh4qp43v', '7b4ba9bd0843', '7b4ba9bd084386a21c61dd573652c35074687f7a'],
  ['dp_14Ugdp5Jkw2fSxGJNVxuybf', '6cec88e89559', '6cec88e89559bda203b6b8091f5b7562692e9200'],
  ['dp_16Q7AXpz3Jpq7uif6s31AZ3', 'd63a3156e6a3', 'd63a3156e6a3da21b02edfec706f960f6c5c653c'],
  ['dp_14FawgX6SMmCTV5WNjjNHs5', '75cb3d19ab93', '75cb3d19ab93bed5d35564423423d6f94bcc335d'],
  ['dp_12ofR4iEES29PwwttZZGqsN', 'bf16e466d988', 'bf16e466d98825d889a71675bcc8ba9458ab12b6'],
  ['dp_14g38iazTnn3gWZzr8Ze0i5', '2e6a1cbf1dce', '2e6a1cbf1dce6737f6c96e25c097d214366af48d'],
] as const

const cleanupManifest = readFileSync(
  new URL('../../../../argocd/applications/bayn/restate-registration-cleanup.yaml', import.meta.url),
  'utf8',
)
const cleanupReadme = readFileSync(new URL('../../../../argocd/applications/bayn/README.md', import.meta.url), 'utf8')
const documents = YAML.parseAllDocuments(cleanupManifest).map((document) => document.toJSON() as Record<string, any>)
const networkPolicy = documents.find((document) => document.kind === 'NetworkPolicy')!
const job = documents.find((document) => document.kind === 'Job')!
const container = job.spec.template.spec.containers[0]
const cleanupScript = container.args[0] as string
const temporaryDirectories: string[] = []

const lifecycleDeployment = ([id, version, sourceRevision]: (typeof expected)[number]): Deployment => {
  const revision = expected.findIndex(([expectedId]) => expectedId === id) + 1
  return {
    id,
    endpoint: `http://bayn-lifecycle-${version}.bayn.svc.cluster.local:9080/`,
    sourceRevision,
    services: ['BaynLifecycle', 'BaynLifecycleBootstrap'],
    managedBy: 'argocd',
    serviceMetadata: 'bayn-lifecycle',
    status: revision === 18 ? 'Active' : 'Drained',
    revision,
    latest: revision === 18,
  }
}

const unrelatedDeployments = (): Deployment[] => [
  {
    id: 'dp_native',
    endpoint: 'http://bayn-execution-controller-current.bayn.svc.cluster.local:9080/',
    sourceRevision: 'native',
    services: ['BaynExecutionController', 'BaynExecutionBootstrap'],
    managedBy: 'restate-operator',
    serviceMetadata: 'bayn-execution-controller',
    status: 'Active',
    revision: 10,
    latest: true,
  },
  {
    id: 'dp_greeter',
    endpoint: 'http://restate-example.restate-example.svc.cluster.local:9080/',
    sourceRevision: 'example',
    services: ['Greeter'],
    managedBy: 'example',
    serviceMetadata: 'restate-example',
    status: 'Active',
    revision: 3,
    latest: true,
  },
]

const makeState = (deployments = expected.map(lifecycleDeployment)): FakeState => ({
  expected: expected.map(([id, version]) => ({
    id,
    endpoint: `http://bayn-lifecycle-${version}.bayn.svc.cluster.local:9080/`,
  })),
  deployments: [...deployments, ...unrelatedDeployments()],
  nonterminalInvocations: 0,
  removalCount: 0,
})

const fakeRestateSource = String.raw`#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const statePath = process.env.FAKE_RESTATE_STATE
const callsPath = process.env.FAKE_RESTATE_CALLS
if (!statePath || !callsPath) process.exit(90)
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const save = () => writeFileSync(statePath, JSON.stringify(state))
appendFileSync(callsPath, JSON.stringify(args) + '\n')

if (args[0] === 'sql') {
  if (
    state.abortSqlEnabled &&
    state.abortSqlAfterRemovalCount !== undefined &&
    state.removalCount >= state.abortSqlAfterRemovalCount
  ) {
    process.exit(91)
  }
  const query = args.at(-1) ?? ''
  const expectedById = new Map(state.expected.map((entry) => [entry.id, entry]))
  let count
  if (query.includes('FROM classified d')) {
    const lifecycleNames = new Set(['BaynLifecycle', 'BaynLifecycleBootstrap'])
    const classified = state.deployments.filter(
      (deployment) =>
        expectedById.has(deployment.id) ||
        deployment.endpoint.startsWith('http://bayn-lifecycle-') ||
        deployment.services.some((service) => lifecycleNames.has(service)),
    )
    count = classified.filter((deployment) => {
      const expectedDeployment = expectedById.get(deployment.id)
      return (
        expectedDeployment === undefined ||
        deployment.endpoint !== expectedDeployment.endpoint ||
        deployment.services.length !== 2 ||
        !deployment.services.includes('BaynLifecycle') ||
        !deployment.services.includes('BaynLifecycleBootstrap')
      )
    }).length
  } else if (query.includes('FROM sys_invocation')) {
    count = state.nonterminalInvocations
  } else if (query.includes("FROM sys_deployment WHERE id = '")) {
    const id = query.match(/WHERE id = '([^']+)'/)?.[1]
    count = state.deployments.filter((deployment) => deployment.id === id).length
  } else if (query.includes('JOIN expected e ON d.id = e.id')) {
    count = state.deployments.filter((deployment) => expectedById.has(deployment.id)).length
  } else {
    process.exit(92)
  }
  console.log(JSON.stringify({ count }))
  process.exit(0)
}

if (args[0] === 'deployments' && args[1] === 'describe') {
  const deployment = state.deployments.find((entry) => entry.id === args[2])
  if (!deployment) process.exit(93)
  console.log(
    [
      ' ID: ' + deployment.id,
      ' Endpoint: ' + deployment.endpoint,
      ' managed_by: ' + deployment.managedBy,
      ' source_revision: ' + deployment.sourceRevision,
      ' service: ' + deployment.serviceMetadata,
      ' Status: ' + deployment.status,
      ' Services:',
      ...deployment.services.flatMap((service) => [
        '  - ' + service,
        '    Revision: ' + deployment.revision + (deployment.latest ? ' [Latest]' : ''),
      ]),
    ].join('\n'),
  )
  process.exit(0)
}

if (args[0] === 'deployments' && args[1] === 'remove') {
  if (args.length !== 4 || args[2] !== '-y') process.exit(94)
  const id = args[3]
  if (state.failRemoveId === id) process.exit(95)
  const index = state.deployments.findIndex((deployment) => deployment.id === id)
  if (index < 0) process.exit(96)
  if (state.deployments[index].status === 'Active') process.exit(98)
  state.deployments.splice(index, 1)
  state.removalCount += 1
  if (
    state.injectInvocationAfterRemovalCount !== undefined &&
    state.removalCount >= state.injectInvocationAfterRemovalCount
  ) {
    state.nonterminalInvocations = 1
  }
  save()
  process.exit(0)
}

process.exit(97)
`

const writeState = (path: string, state: FakeState): void => writeFileSync(path, JSON.stringify(state))
const readState = (path: string): FakeState => JSON.parse(readFileSync(path, 'utf8')) as FakeState

const runCleanup = (initialState: FakeState) => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-restate-cleanup-'))
  temporaryDirectories.push(directory)
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const restatePath = join(bin, 'restate')
  const statePath = join(directory, 'state.json')
  const callsPath = join(directory, 'calls.jsonl')
  writeFileSync(restatePath, fakeRestateSource)
  chmodSync(restatePath, 0o755)
  writeState(statePath, initialState)
  writeFileSync(callsPath, '')

  const run = () =>
    spawnSync('/bin/sh', ['-eu', '-c', cleanupScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: directory,
        RESTATE_CLI_CONFIG_HOME: join(directory, 'restate-cli'),
        RESTATE_ADMIN_URL: 'http://restate.restate.svc.cluster.local:9070',
        FAKE_RESTATE_STATE: statePath,
        FAKE_RESTATE_CALLS: callsPath,
      },
    })

  const calls = () =>
    readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])

  return { calls, run, statePath }
}

const removalCalls = (calls: string[][]): string[][] =>
  calls.filter(([group, command]) => group === 'deployments' && command === 'remove')

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('Bayn legacy Restate registration cleanup', () => {
  test('pins the reviewed CLI and exact one-shot isolation contract', () => {
    expect(job.metadata.annotations).toEqual({
      'argocd.argoproj.io/hook': 'PostSync',
      'argocd.argoproj.io/hook-delete-policy': 'BeforeHookCreation',
    })
    expect(job.spec.template.metadata.labels).toMatchObject({
      'app.kubernetes.io/name': 'bayn-lifecycle-register',
      'bayn.proompteng.ai/task': 'restate-registration-cleanup',
    })
    expect(job.spec.template.spec.automountServiceAccountToken).toBeFalse()
    expect(job.spec.template.spec.serviceAccountName).toBeUndefined()
    expect(job.spec.template.spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 65532,
      runAsGroup: 65532,
      seccompProfile: { type: 'RuntimeDefault' },
    })
    expect(container.image).toBe(
      'docker.restate.dev/restatedev/restate-cli:1.7.2@sha256:6905cd107840658f8ef0338c95e3c691dba3da450e9e0fb12066d00fd57e69f9',
    )
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    })
    expect(container.env).toEqual([
      { name: 'RESTATE_ADMIN_URL', value: 'http://restate.restate.svc.cluster.local:9070' },
      { name: 'HOME', value: '/tmp' },
      { name: 'RESTATE_CLI_CONFIG_HOME', value: '/tmp/restate-cli' },
    ])
    expect(networkPolicy.spec).toEqual({
      podSelector: {
        matchLabels: {
          'app.kubernetes.io/name': 'bayn-lifecycle-register',
          'bayn.proompteng.ai/task': 'restate-registration-cleanup',
        },
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            },
          ],
          ports: [
            { port: 53, protocol: 'UDP' },
            { port: 53, protocol: 'TCP' },
          ],
        },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'restate' } },
              podSelector: { matchLabels: { app: 'restate' } },
            },
          ],
          ports: [{ port: 9070, protocol: 'TCP' }],
        },
      ],
    })

    const embeddedAllowlist = [...cleanupScript.matchAll(/^(dp_[^|]+)\|([^|]+)\|([0-9a-f]{40})$/gm)].map((match) => [
      match[1],
      match[2].match(/bayn-lifecycle-([0-9a-f]{12})/)?.[1],
      match[3],
    ])
    expect(embeddedAllowlist).toEqual(expected)
    expect(cleanupScript.match(/restate deployments remove -y "\$id"/g)).toHaveLength(1)
    expect(cleanupScript).not.toContain('--force')
    expect(cleanupScript).not.toContain('curl')
    expect(cleanupScript).not.toContain('DELETE')
    expect(cleanupScript).not.toMatch(/restate\s+services\s+(delete|remove)/)
    expect(cleanupScript).not.toMatch(/restate\s+deployments\s+delete/)
    expect(cleanupScript).not.toMatch(/invocations?\s+(kill|cancel|purge)/)
    expect(cleanupScript).not.toContain('BaynExecution')
    expect(cleanupScript).not.toContain('Greeter')
    expect(cleanupScript).not.toContain('restate-example')
    expect(cleanupReadme).toContain('final deployment `dp_14g38iazTnn3gWZzr8Ze0i5`')
    expect(cleanupReadme).toContain('terminal `HOLD`')
    expect(cleanupReadme).toContain('Any other nonzero partial subset')
    expect(cleanupReadme).toContain('submit a narrowly reviewed\nGitOps correction')
    expect(cleanupReadme).toContain('Never use `--force`')
  })

  test('removes the 17 drained revisions oldest to newest and holds the final active revision', () => {
    const harness = runCleanup(makeState())
    const result = harness.run()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`HOLD: final Bayn lifecycle deployment ${expected[17][0]}`)
    expect(removalCalls(harness.calls())).toEqual(
      expected.slice(0, -1).map(([id]) => ['deployments', 'remove', '-y', id]),
    )
    expect(readState(harness.statePath).deployments).toEqual([
      lifecycleDeployment(expected[17]),
      ...unrelatedDeployments(),
    ])
  }, 15_000)

  test('fails closed on a non-final strict subset instead of resuming mutation', () => {
    const state = makeState()
    state.abortSqlAfterRemovalCount = 5
    state.abortSqlEnabled = true
    const harness = runCleanup(state)

    const firstRun = harness.run()
    expect(firstRun.status).not.toBe(0)
    expect(readState(harness.statePath).deployments.filter(({ id }) => id.startsWith('dp_1'))).toHaveLength(13)

    const retryState = readState(harness.statePath)
    retryState.abortSqlEnabled = false
    writeState(harness.statePath, retryState)
    const retry = harness.run()

    expect(retry.status).not.toBe(0)
    expect(retry.stderr).toContain('unexpected non-final remaining subset (13 of 18); refusing mutation')
    expect(removalCalls(harness.calls())).toEqual(
      expected.slice(0, 5).map(([id]) => ['deployments', 'remove', '-y', id]),
    )
    expect(readState(harness.statePath).removalCount).toBe(5)
  }, 15_000)

  test('holds the exact live 17-removed final active revision without mutation', () => {
    const harness = runCleanup(makeState([lifecycleDeployment(expected[17])]))
    const result = harness.run()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`HOLD: final Bayn lifecycle deployment ${expected[17][0]}`)
    expect(result.stdout).toContain('non-force removal is intentionally not attempted')
    expect(removalCalls(harness.calls())).toEqual([])
    expect(readState(harness.statePath).deployments).toEqual([
      lifecycleDeployment(expected[17]),
      ...unrelatedDeployments(),
    ])
  })

  test('replays the exact terminal HOLD idempotently', () => {
    const harness = runCleanup(makeState([lifecycleDeployment(expected[17])]))

    const first = harness.run()
    const second = harness.run()

    expect(first.status).toBe(0)
    expect(second.status).toBe(0)
    expect(first.stdout).toContain('HOLD: final Bayn lifecycle deployment')
    expect(second.stdout).toContain('HOLD: final Bayn lifecycle deployment')
    expect(removalCalls(harness.calls())).toEqual([])
    expect(readState(harness.statePath).removalCount).toBe(0)
  })

  test('fails closed when the final deployment is no longer Active', () => {
    const finalDeployment = lifecycleDeployment(expected[17])
    finalDeployment.status = 'Drained'
    const harness = runCleanup(makeState([finalDeployment]))
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('terminal HOLD requires the final deployment to remain Active')
    expect(removalCalls(harness.calls())).toEqual([])
  })

  test('fails closed when the final deployment is no longer the latest revision', () => {
    const finalDeployment = lifecycleDeployment(expected[17])
    finalDeployment.latest = false
    const harness = runCleanup(makeState([finalDeployment]))
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('terminal HOLD requires both lifecycle services to remain revision 18 [Latest]')
    expect(removalCalls(harness.calls())).toEqual([])
  })

  test('fails closed on final-state lifecycle or pinned invocations', () => {
    const state = makeState([lifecycleDeployment(expected[17])])
    state.nonterminalInvocations = 1
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('lifecycle or pinned nonterminal invocations exist (1)')
    expect(removalCalls(harness.calls())).toEqual([])
  })

  test('fails closed on an allowlisted singleton that is not the final deployment', () => {
    const singleton = lifecycleDeployment(expected[16])
    singleton.status = 'Active'
    singleton.latest = true
    const harness = runCleanup(makeState([singleton]))
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('terminal HOLD requires the exact final allowlisted deployment')
    expect(removalCalls(harness.calls())).toEqual([])
  })

  test('treats zero remaining deployments as a successful no-op', () => {
    const harness = runCleanup(makeState([]))
    const result = harness.run()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('already absent; nothing to remove')
    expect(removalCalls(harness.calls())).toEqual([])
    expect(readState(harness.statePath).deployments).toEqual(unrelatedDeployments())
  })

  test('rejects an unknown lifecycle deployment before mutation', () => {
    const state = makeState()
    state.deployments.push({
      ...lifecycleDeployment(expected[0]),
      id: 'dp_unknown',
      endpoint: 'http://bayn-lifecycle-unknown.bayn.svc.cluster.local:9080/',
    })
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unexpected lifecycle deployment classifier state')
    expect(removalCalls(harness.calls())).toEqual([])
  })

  test('rejects wrong lifecycle service membership before mutation', () => {
    const state = makeState()
    state.deployments[0]!.services = ['BaynLifecycle', 'Greeter']
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unexpected lifecycle deployment classifier state')
    expect(removalCalls(harness.calls())).toEqual([])
  })

  test('rejects lifecycle metadata drift before mutation', () => {
    const state = makeState()
    state.deployments[0]!.managedBy = 'manual'
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('changed managed_by metadata')
    expect(removalCalls(harness.calls())).toEqual([])
  })

  test('rejects lifecycle or pinned invocation drift before mutation', () => {
    const state = makeState()
    state.nonterminalInvocations = 1
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('lifecycle or pinned nonterminal invocations exist (1)')
    expect(removalCalls(harness.calls())).toEqual([])
  })

  test('rechecks invocation drift during the removal loop', () => {
    const state = makeState()
    state.injectInvocationAfterRemovalCount = 1
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('lifecycle or pinned nonterminal invocations exist (1)')
    expect(removalCalls(harness.calls())).toEqual([['deployments', 'remove', '-y', expected[0][0]]])
    expect(readState(harness.statePath).removalCount).toBe(1)
  })

  test('fails closed when non-force deployment removal refuses', () => {
    const state = makeState()
    state.failRemoveId = expected[0][0]
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`non-force removal refused for ${expected[0][0]}`)
    expect(removalCalls(harness.calls())).toEqual([['deployments', 'remove', '-y', expected[0][0]]])
    expect(readState(harness.statePath).removalCount).toBe(0)
  })
})
