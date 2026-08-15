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

type ServiceBinding = {
  name: string
  revision: number
  public: boolean
  ty: 'service' | 'virtual_object'
  deploymentId: string
}

type FakeState = {
  expected: Array<Pick<Deployment, 'id' | 'endpoint'>>
  deployments: Deployment[]
  legacyServices: ServiceBinding[]
  nativeServices: ServiceBinding[]
  legacyNonterminalInvocations: number
  nativeCompletedTicks: number
  nativeNonterminalTicks: number
  nativeWrongPinnedNonterminalTicks: number
  removalCount: number
  removalRequested: boolean
  pollCount: number
  deploymentDisappearAfterPolls: number
  serviceDisappearAfterPolls: number
  injectLegacyInvocationAfterRemove?: boolean
  mutateNativeAfterRemove?: boolean
  failRemove?: boolean
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

const finalId = expected[17][0]
const nativeId = 'dp_14MYpEXKeHNXBkzJQMMIHSx'
const nativeEndpoint = 'http://bayn-execution-controller-686554d857.bayn.svc.cluster.local:9080/'

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

const nativeDeployment = (): Deployment => ({
  id: nativeId,
  endpoint: nativeEndpoint,
  sourceRevision: '5f366810884463ee593b417e21bc76bf2176de36',
  services: ['BaynExecutionController', 'BaynExecutionBootstrap'],
  managedBy: 'native',
  serviceMetadata: 'bayn-execution-controller',
  status: 'Active',
  revision: 11,
  latest: true,
})

const greeterDeployment = (): Deployment => ({
  id: 'dp_greeter',
  endpoint: 'http://restate-example.restate-example.svc.cluster.local:9080/',
  sourceRevision: 'example',
  services: ['Greeter'],
  managedBy: 'example',
  serviceMetadata: 'restate-example',
  status: 'Active',
  revision: 3,
  latest: true,
})

const legacyBindings = (deployment: Deployment | undefined): ServiceBinding[] =>
  deployment === undefined
    ? []
    : [
        {
          name: 'BaynLifecycle',
          revision: deployment.revision,
          public: false,
          ty: 'virtual_object',
          deploymentId: deployment.id,
        },
        {
          name: 'BaynLifecycleBootstrap',
          revision: deployment.revision,
          public: true,
          ty: 'service',
          deploymentId: deployment.id,
        },
      ]

const nativeBindings = (): ServiceBinding[] => [
  {
    name: 'BaynExecutionController',
    revision: 11,
    public: false,
    ty: 'virtual_object',
    deploymentId: nativeId,
  },
  {
    name: 'BaynExecutionBootstrap',
    revision: 11,
    public: true,
    ty: 'service',
    deploymentId: nativeId,
  },
]

const makeState = (lifecycleDeployments: Deployment[] = [lifecycleDeployment(expected[17])]): FakeState => ({
  expected: expected.map(([id, version]) => ({
    id,
    endpoint: `http://bayn-lifecycle-${version}.bayn.svc.cluster.local:9080/`,
  })),
  deployments: [...lifecycleDeployments, nativeDeployment(), greeterDeployment()],
  legacyServices: legacyBindings(lifecycleDeployments.at(-1)),
  nativeServices: nativeBindings(),
  legacyNonterminalInvocations: 0,
  nativeCompletedTicks: 8,
  nativeNonterminalTicks: 1,
  nativeWrongPinnedNonterminalTicks: 0,
  removalCount: 0,
  removalRequested: false,
  pollCount: 0,
  deploymentDisappearAfterPolls: 1,
  serviceDisappearAfterPolls: 1,
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

const finalId = '${finalId}'
const nativeId = '${nativeId}'
const nativeEndpoint = '${nativeEndpoint}'

const progressRemoval = (query) => {
  if (
    !state.removalRequested ||
    query.includes('FROM classified d') ||
    !query.includes('JOIN expected e ON d.id = e.id')
  )
    return
  state.pollCount += 1
  if (state.pollCount >= state.deploymentDisappearAfterPolls) {
    state.deployments = state.deployments.filter((deployment) => deployment.id !== finalId)
  }
  if (state.pollCount >= state.serviceDisappearAfterPolls) state.legacyServices = []
  save()
}

if (args[0] === 'sql') {
  const query = args.at(-1) ?? ''
  progressRemoval(query)
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
  } else if (query.includes("target_service_name IN ('BaynLifecycle', 'BaynLifecycleBootstrap')")) {
    count = state.legacyNonterminalInvocations
  } else if (query.includes('JOIN expected e ON d.id = e.id')) {
    count = state.deployments.filter((deployment) => expectedById.has(deployment.id)).length
  } else if (query.includes("OR deployment_id IN ('dp_13XIXwisR4a4XPwInU61DdD'")) {
    count = state.legacyServices.length
  } else if (query.includes("name = 'BaynLifecycle'") && query.includes('revision = 18')) {
    count = state.legacyServices.filter(
      (service) =>
        (service.name === 'BaynLifecycle' &&
          service.revision === 18 &&
          service.public === false &&
          service.ty === 'virtual_object' &&
          service.deploymentId === finalId) ||
        (service.name === 'BaynLifecycleBootstrap' &&
          service.revision === 18 &&
          service.public === true &&
          service.ty === 'service' &&
          service.deploymentId === finalId),
    ).length
  } else if (query.includes("WHERE id = '" + nativeId + "'") && query.includes('AND endpoint =')) {
    count = state.deployments.filter(
      (deployment) =>
        deployment.id === nativeId &&
        deployment.endpoint === nativeEndpoint &&
        deployment.services.length === 2 &&
        deployment.services.includes('BaynExecutionController') &&
        deployment.services.includes('BaynExecutionBootstrap'),
    ).length
  } else if (query.includes("name IN ('BaynExecutionController', 'BaynExecutionBootstrap')")) {
    count = state.nativeServices.length
  } else if (query.includes("name = 'BaynExecutionController'") && query.includes('revision = 11')) {
    count = state.nativeServices.filter(
      (service) =>
        (service.name === 'BaynExecutionController' &&
          service.revision === 11 &&
          service.public === false &&
          service.ty === 'virtual_object' &&
          service.deploymentId === nativeId) ||
        (service.name === 'BaynExecutionBootstrap' &&
          service.revision === 11 &&
          service.public === true &&
          service.ty === 'service' &&
          service.deploymentId === nativeId),
    ).length
  } else if (
    query.includes("target_service_name = 'BaynExecutionController'") &&
    query.includes("status = 'completed'")
  ) {
    count = state.nativeCompletedTicks
  } else if (
    query.includes("target_service_name = 'BaynExecutionController'") &&
    query.includes('pinned_deployment_id IS NOT NULL')
  ) {
    count = state.nativeWrongPinnedNonterminalTicks
  } else if (
    query.includes("target_service_name = 'BaynExecutionController'") &&
    query.includes("status <> 'completed'")
  ) {
    count = state.nativeNonterminalTicks
  } else if (query.includes("FROM sys_deployment WHERE id = '")) {
    const id = query.match(/WHERE id = '([^']+)'/)?.[1]
    count = state.deployments.filter((deployment) => deployment.id === id).length
  } else {
    process.exit(92)
  }

  console.log(JSON.stringify({ count }))
  process.exit(0)
}

if (args[0] === 'deployments' && args[1] === 'describe') {
  const deployment = state.deployments.find((entry) => entry.id === args[2])
  if (!deployment || args.length !== 4 || args[3] !== '--extra') process.exit(93)
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
  if (args.length !== 5 || args[2] !== '--force' || args[3] !== '-y' || args[4] !== finalId) process.exit(94)
  if (state.failRemove) process.exit(95)
  if (!state.deployments.some((deployment) => deployment.id === finalId)) process.exit(96)
  state.removalRequested = true
  state.removalCount += 1
  if (state.injectLegacyInvocationAfterRemove) state.legacyNonterminalInvocations = 1
  if (state.mutateNativeAfterRemove) state.nativeServices[0].revision = 12
  save()
  process.exit(0)
}

process.exit(97)
`

const writeState = (path: string, state: FakeState): void => writeFileSync(path, JSON.stringify(state))
const readState = (path: string): FakeState => JSON.parse(readFileSync(path, 'utf8')) as FakeState

const runCleanup = (initialState: FakeState, pollAttempts = 30) => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-restate-cleanup-'))
  temporaryDirectories.push(directory)
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const restatePath = join(bin, 'restate')
  const sleepPath = join(bin, 'sleep')
  const statePath = join(directory, 'state.json')
  const callsPath = join(directory, 'calls.jsonl')
  writeFileSync(restatePath, fakeRestateSource)
  writeFileSync(sleepPath, '#!/bin/sh\nexit 0\n')
  chmodSync(restatePath, 0o755)
  chmodSync(sleepPath, 0o755)
  writeState(statePath, initialState)
  writeFileSync(callsPath, '')

  const executableScript = cleanupScript.replace('poll_attempts=30', `poll_attempts=${pollAttempts}`)
  const run = () =>
    spawnSync('/bin/sh', ['-eu', '-c', executableScript], {
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

describe('Bayn legacy Restate registration final retirement', () => {
  test('pins the reviewed CLI, network isolation, and one exact force target', () => {
    expect(networkPolicy.metadata.annotations).toEqual({
      'bayn.proompteng.ai/retirement-sync': 'final-legacy-registration-v1',
    })
    expect(job.metadata.name).toBe('bayn-restate-registration-final-retirement')
    expect(job.metadata.annotations).toEqual({
      'argocd.argoproj.io/hook': 'PostSync',
      'argocd.argoproj.io/hook-delete-policy': 'HookSucceeded',
    })
    expect(job.spec.backoffLimit).toBe(0)
    expect(job.spec.ttlSecondsAfterFinished).toBeUndefined()
    expect(job.spec.template.metadata.labels).toMatchObject({
      'app.kubernetes.io/name': 'bayn-lifecycle-register',
      'bayn.proompteng.ai/task': 'restate-registration-cleanup',
    })
    expect(job.spec.template.spec.automountServiceAccountToken).toBeFalse()
    expect(job.spec.template.spec.serviceAccountName).toBeUndefined()
    expect(job.spec.template.spec.restartPolicy).toBe('Never')
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
    expect(networkPolicy.spec.podSelector).toEqual({
      matchLabels: {
        'app.kubernetes.io/name': 'bayn-lifecycle-register',
        'bayn.proompteng.ai/task': 'restate-registration-cleanup',
      },
    })
    expect(networkPolicy.spec.policyTypes).toEqual(['Egress'])
    expect(networkPolicy.spec.egress).toEqual([
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
    ])

    const embeddedAllowlist = [...cleanupScript.matchAll(/^(dp_[^|]+)\|([^|]+)\|([0-9a-f]{40})$/gm)].map((match) => [
      match[1],
      match[2].match(/bayn-lifecycle-([0-9a-f]{12})/)?.[1],
      match[3],
    ])
    expect(embeddedAllowlist).toEqual(expected)
    expect(cleanupScript.match(/restate deployments remove --force -y "\$final_id"/g)).toHaveLength(1)
    expect(cleanupScript).toContain(`final_id='${finalId}'`)
    expect(cleanupScript).toContain(`native_id='${nativeId}'`)
    expect(cleanupScript).toContain(`native_endpoint='${nativeEndpoint}'`)
    expect(cleanupScript).toContain('poll_attempts=30')
    expect(cleanupScript).toContain('poll_interval_seconds=2')
    expect(cleanupScript).not.toMatch(/restate deployments remove (?!--force -y "\$final_id")/)
    expect(cleanupScript).not.toContain('curl')
    expect(cleanupScript).not.toContain('DELETE')
    expect(cleanupScript).not.toMatch(/restate\s+services\s+(delete|remove)/)
    expect(cleanupScript).not.toMatch(/invocations?\s+(kill|cancel|purge)/)
    expect(cleanupReadme).toContain('one exact force removal')
    expect(cleanupReadme).toContain(finalId)
    expect(cleanupReadme).toContain(nativeId)
    expect(cleanupReadme).toContain('already-empty reruns')
    expect(cleanupReadme).toContain('bayn.proompteng.ai/retirement-sync=final-legacy-registration-v1')
    expect(cleanupReadme).toContain('bayn-restate-registration-final-retirement')
    expect(cleanupReadme).toContain('`backoffLimit: 0`')
    expect(cleanupReadme).toContain('`restartPolicy: Never`')
    expect(cleanupReadme).toContain('`HookSucceeded` deletion only')
  })

  test('force-removes only the exact final deployment and reaches the empty retired state', () => {
    const harness = runCleanup(makeState())
    const result = harness.run()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Force-removing the exact final Bayn lifecycle Restate deployment ${finalId}`)
    expect(result.stdout).toContain('retirement completed')
    expect(removalCalls(harness.calls())).toEqual([['deployments', 'remove', '--force', '-y', finalId]])
    const state = readState(harness.statePath)
    expect(state.removalCount).toBe(1)
    expect(state.deployments.map(({ id }) => id)).toEqual([nativeId, 'dp_greeter'])
    expect(state.legacyServices).toEqual([])
    expect(state.nativeServices).toEqual(nativeBindings())
  })

  test('waits through bounded asynchronous deployment and service disappearance', () => {
    const state = makeState()
    state.deploymentDisappearAfterPolls = 2
    state.serviceDisappearAfterPolls = 3
    const harness = runCleanup(state, 3)
    const result = harness.run()

    expect(result.status).toBe(0)
    expect(readState(harness.statePath).pollCount).toBeGreaterThanOrEqual(3)
    expect(removalCalls(harness.calls())).toEqual([['deployments', 'remove', '--force', '-y', finalId]])
  }, 10_000)

  test('times out if the asynchronous deployment deletion never completes', () => {
    const state = makeState()
    state.deploymentDisappearAfterPolls = 999
    state.serviceDisappearAfterPolls = 999
    const harness = runCleanup(state, 1)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('timed out waiting for exact final deployment and lifecycle services to disappear')
    expect(readState(harness.statePath).pollCount).toBe(1)
    expect(removalCalls(harness.calls())).toHaveLength(1)
  })

  test('fails closed on service residue after the deployment disappears', () => {
    const state = makeState()
    state.deploymentDisappearAfterPolls = 1
    state.serviceDisappearAfterPolls = 999
    const harness = runCleanup(state, 1)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('timed out waiting for exact final deployment and lifecycle services to disappear')
    expect(readState(harness.statePath).legacyServices).toHaveLength(2)
  })

  test('fails immediately on the unexpected inverse partial deletion state', () => {
    const state = makeState()
    state.deploymentDisappearAfterPolls = 999
    state.serviceDisappearAfterPolls = 1
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'unexpected asynchronous retirement state: 1 deployment(s), 0 lifecycle service row(s)',
    )
  })

  test('fails closed if a legacy or final-pinned invocation exists before mutation', () => {
    const state = makeState()
    state.legacyNonterminalInvocations = 1
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('lifecycle or pinned nonterminal invocations exist (1)')
    expect(removalCalls(harness.calls())).toEqual([])
  })

  test('fails closed on a zombie legacy invocation injected after force acceptance', () => {
    const state = makeState()
    state.injectLegacyInvocationAfterRemove = true
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('lifecycle or pinned nonterminal invocations exist (1)')
    expect(removalCalls(harness.calls())).toEqual([['deployments', 'remove', '--force', '-y', finalId]])
  })

  test('rejects lifecycle metadata drift before force removal', () => {
    const state = makeState()
    state.deployments[0]!.sourceRevision = '0'.repeat(40)
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('changed source_revision metadata')
    expect(removalCalls(harness.calls())).toEqual([])
  })

  test('rejects changed final service revision or Latest status before force removal', () => {
    const state = makeState()
    state.legacyServices[0]!.revision = 19
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('final lifecycle service bindings changed')
    expect(removalCalls(harness.calls())).toEqual([])

    const latestState = makeState()
    latestState.deployments[0]!.latest = false
    const latestHarness = runCleanup(latestState)
    const latestResult = latestHarness.run()
    expect(latestResult.status).not.toBe(0)
    expect(latestResult.stderr).toContain('both lifecycle services to remain revision 18 [Latest]')
    expect(removalCalls(latestHarness.calls())).toEqual([])
  })

  test('rejects a wrong allowlisted singleton ID and any larger remaining subset', () => {
    const wrongSingleton = lifecycleDeployment(expected[16])
    wrongSingleton.status = 'Active'
    wrongSingleton.latest = true
    const wrongHarness = runCleanup(makeState([wrongSingleton]))
    const wrongResult = wrongHarness.run()
    expect(wrongResult.status).not.toBe(0)
    expect(wrongResult.stderr).toContain('final retirement requires the exact final allowlisted deployment')
    expect(removalCalls(wrongHarness.calls())).toEqual([])

    const partialHarness = runCleanup(makeState([lifecycleDeployment(expected[16]), lifecycleDeployment(expected[17])]))
    const partialResult = partialHarness.run()
    expect(partialResult.status).not.toBe(0)
    expect(partialResult.stderr).toContain('unexpected non-final remaining subset (2 of 18); refusing final retirement')
    expect(removalCalls(partialHarness.calls())).toEqual([])
  })

  test('rejects an unknown lifecycle classifier member before mutation', () => {
    const state = makeState()
    state.deployments.unshift({
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

  test('rejects native deployment, service, tick, or pin drift before mutation', () => {
    const cases: Array<[string, (state: FakeState) => void, string]> = [
      [
        'deployment',
        (state) => {
          state.deployments.find(({ id }) => id === nativeId)!.endpoint =
            'http://wrong-native.bayn.svc.cluster.local:9080/'
        },
        'current native execution deployment binding changed',
      ],
      [
        'service',
        (state) => {
          state.nativeServices[0]!.revision = 12
        },
        'native execution service bindings changed',
      ],
      [
        'completed ticks',
        (state) => {
          state.nativeCompletedTicks = 1
        },
        'native execution tick continuity is stale',
      ],
      [
        'nonterminal ticks',
        (state) => {
          state.nativeNonterminalTicks = 0
        },
        'native execution tick continuity is unexpected',
      ],
      [
        'wrong pin',
        (state) => {
          state.nativeWrongPinnedNonterminalTicks = 1
        },
        'native execution has nonterminal ticks pinned to another deployment',
      ],
    ]

    for (const [, mutate, message] of cases) {
      const state = makeState()
      mutate(state)
      const harness = runCleanup(state)
      const result = harness.run()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(message)
      expect(removalCalls(harness.calls())).toEqual([])
    }
  })

  test('detects native collateral immediately after the exact force removal', () => {
    const state = makeState()
    state.mutateNativeAfterRemove = true
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('native execution service bindings changed')
    expect(removalCalls(harness.calls())).toEqual([['deployments', 'remove', '--force', '-y', finalId]])
  })

  test('fails closed when the exact force command itself is refused', () => {
    const state = makeState()
    state.failRemove = true
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`force removal refused for exact final deployment ${finalId}`)
    expect(removalCalls(harness.calls())).toEqual([['deployments', 'remove', '--force', '-y', finalId]])
    expect(readState(harness.statePath).removalCount).toBe(0)
  })

  test('treats the fully retired empty set as an idempotent no-op without force calls', () => {
    const harness = runCleanup(makeState([]))
    const first = harness.run()
    const second = harness.run()

    expect(first.status).toBe(0)
    expect(second.status).toBe(0)
    expect(first.stdout).toContain('retirement already complete; empty-set rerun is safe')
    expect(second.stdout).toContain('retirement already complete; empty-set rerun is safe')
    expect(removalCalls(harness.calls())).toEqual([])
    expect(readState(harness.statePath).deployments.map(({ id }) => id)).toEqual([nativeId, 'dp_greeter'])
  })

  test('keeps already-empty reruns independent of later legitimate native rollouts', () => {
    const state = makeState([])
    const native = state.deployments.find(({ id }) => id === nativeId)!
    native.id = 'dp_native_next'
    native.endpoint = 'http://bayn-execution-controller-next.bayn.svc.cluster.local:9080/'
    state.nativeServices = state.nativeServices.map((service) => ({
      ...service,
      revision: 12,
      deploymentId: 'dp_native_next',
    }))
    state.nativeCompletedTicks = 0
    state.nativeNonterminalTicks = 0
    state.nativeWrongPinnedNonterminalTicks = 1
    const harness = runCleanup(state)
    const result = harness.run()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('retirement already complete; empty-set rerun is safe')
    expect(removalCalls(harness.calls())).toEqual([])
    expect(readState(harness.statePath).deployments.map(({ id }) => id)).toEqual(['dp_native_next', 'dp_greeter'])
  })
})
