import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = '1'.repeat(40)
const timestamp = '2026-11-21T10:00:00+00:00'
const names = ['bayn', 'bayn-research', 'bayn-broker-feed'] as const
const architectures = ['amd64', 'arm64'] as const
const image = (name: string) => `registry.ide-newton.ts.net/lab/${name}`
const childDigest = (member: number, architecture: number) =>
  `sha256:${String(member * 2 + architecture + 1).repeat(64)}`
const indexDigest = (member: number) => `sha256:${['a', 'b', 'c'][member].repeat(64)}`
const config = (architecture: string, revision = source, created = timestamp) => ({
  os: 'linux',
  architecture,
  config: { Labels: { 'org.opencontainers.image.revision': revision, 'org.opencontainers.image.created': created } },
})
type Registry = {
  tags: Record<string, string>
  configs: Record<string, unknown>
  indexDigests: Record<string, string>
  indexes: Record<string, unknown>
  checkout: string
  failIndex?: string
  corruptPinnedIndex?: string
  pinnedDescriptorMutation?: { image: string; kind: 'extra' | 'missing' | 'duplicate' }
}

// Exercise the real CLI, shared index helper, output-file boundary and command ordering without a registry.
const fakeCommand = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const statePath = process.env.COHORT_REGISTRY_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(process.env.COHORT_COMMAND_LOG, JSON.stringify([command, ...args]) + '\\n');
const emit = value => { if (value === undefined) throw new Error('Missing fixture proof'); console.log(typeof value === 'string' ? value : JSON.stringify(value)); };
if (command === 'git') {
  if (args[0] === 'rev-parse') emit(state.checkout);
  else if (args[0] === 'show') emit('${timestamp}');
  else throw new Error('Unexpected git command');
} else if (command === 'regctl' && args[0] === 'index' && args[1] === 'create') {
  const reference = args[2];
  const image = reference.slice(0, reference.lastIndexOf(':'));
  if (state.failIndex === image) throw new Error('Simulated index write failure');
  const manifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [], annotations: {} };
  for (let i = 3; i < args.length; i += 2) {
    if (args[i] === '--digest') {
      const digest = args[i + 1];
      const config = state.configs[image + '@' + digest];
      manifest.manifests.push({ digest, platform: { os: config.os, architecture: config.architecture } });
    } else if (args[i] === '--annotation') {
      const position = args[i + 1].indexOf('=');
      manifest.annotations[args[i + 1].slice(0, position)] = args[i + 1].slice(position + 1);
    } else throw new Error('Unexpected index option');
  }
  state.tags[reference] = state.indexDigests[image];
  state.indexes[reference] = manifest;
  const pinned = structuredClone(manifest);
  if (state.corruptPinnedIndex === image) pinned.manifests[0].digest = 'sha256:' + 'f'.repeat(64);
  if (state.pinnedDescriptorMutation?.image === image) {
    if (state.pinnedDescriptorMutation.kind === 'extra') pinned.manifests.push({ digest: 'sha256:' + 'f'.repeat(64) });
    if (state.pinnedDescriptorMutation.kind === 'missing') pinned.manifests.pop();
    if (state.pinnedDescriptorMutation.kind === 'duplicate') pinned.manifests[1] = pinned.manifests[0];
  }
  state.indexes[image + '@' + state.indexDigests[image]] = pinned;
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (command === 'crane') {
  if (args[0] === 'digest') emit(state.tags[args[1]]);
  else if (args[0] === 'config') emit(state.configs[args[1]]);
  else if (args[0] === 'manifest') emit(state.indexes[args[1]]);
  else throw new Error('Unexpected registry mutation or inspection');
} else throw new Error('Unexpected registry mutation or command');
`

const run = (mutate: (registry: Registry) => void = () => {}, overrides: Record<string, string> = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-cohort-preparation-'))
  try {
    const registry: Registry = { tags: {}, configs: {}, indexDigests: {}, indexes: {}, checkout: source }
    for (const [member, name] of names.entries()) {
      registry.indexDigests[image(name)] = indexDigest(member)
      for (const [arch, architecture] of architectures.entries()) {
        registry.tags[`${image(name)}:sha-${source}-${architecture}`] = childDigest(member, arch)
        registry.configs[`${image(name)}@${childDigest(member, arch)}`] = config(architecture)
      }
    }
    mutate(registry)
    const statePath = join(directory, 'registry.json')
    const outputPath = join(directory, 'outputs')
    const commandsPath = join(directory, 'commands')
    writeFileSync(statePath, JSON.stringify(registry))
    writeFileSync(outputPath, 'existing_output=retained\n')
    writeFileSync(commandsPath, '')
    for (const command of ['git', 'crane', 'regctl'])
      writeFileSync(join(directory, command), fakeCommand, { mode: 0o755 })
    const result = Bun.spawnSync([process.execPath, new URL('./prepare-image-cohort.ts', import.meta.url).pathname], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'proompteng/lab',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_SHA: source,
        GITHUB_RUN_ID: '123456',
        GITHUB_OUTPUT: outputPath,
        BAYN_BUILD_RESULT: 'success',
        RESEARCH_BUILD_RESULT: 'success',
        BROKER_FEED_BUILD_RESULT: 'success',
        COHORT_REGISTRY_STATE: statePath,
        COHORT_COMMAND_LOG: commandsPath,
        ...overrides,
      },
    })
    const commands: string[][] = readFileSync(commandsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      commands,
      output: readFileSync(outputPath, 'utf8'),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test.each(['push', 'workflow_dispatch'])(
  'preflights all six images and emits the three deferred indexes for %s',
  (event) => {
    const result = run(undefined, { GITHUB_EVENT_NAME: event })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.output).toBe(
      `existing_output=retained\nbayn_digest=${indexDigest(0)}\nresearch_digest=${indexDigest(1)}\nbroker_feed_digest=${indexDigest(2)}\n`,
    )
    const firstWrite = result.commands.findIndex(([command]) => command === 'regctl')
    expect(
      result.commands
        .slice(0, firstWrite)
        .filter(([command, operation]) => command === 'crane' && operation === 'config'),
    ).toHaveLength(6)
    const writes = result.commands.filter(([command]) => command === 'regctl')
    expect(writes).toHaveLength(3)
    for (const [member, name] of names.entries()) {
      expect(writes[member]).toEqual([
        'regctl',
        'index',
        'create',
        `${image(name)}:sha-${source}`,
        '--digest',
        childDigest(member, 0),
        '--digest',
        childDigest(member, 1),
        '--annotation',
        'ai.proompteng.github-actions-build-conclusion=success',
        '--annotation',
        'ai.proompteng.github-actions-run-id=123456',
        '--annotation',
        `org.opencontainers.image.revision=${source}`,
        '--annotation',
        'org.opencontainers.image.source=https://github.com/proompteng/lab',
      ])
      for (const [arch, architecture] of architectures.entries()) {
        expect(
          result.commands.filter(
            (command) => command.join(' ') === `crane digest ${image(name)}:sha-${source}-${architecture}`,
          ),
        ).toHaveLength(1)
        expect(result.commands).toContainEqual(['crane', 'config', `${image(name)}@${childDigest(member, arch)}`])
      }
      expect(result.commands).toContainEqual(['crane', 'manifest', `${image(name)}@${indexDigest(member)}`])
    }
    expect(
      result.commands.some(
        (command) =>
          command.includes('tag') || command.some((part) => part.includes('kargo-sha-') || part === 'latest'),
      ),
    ).toBe(false)
  },
)

const rejectedBuilds = ['BAYN_BUILD_RESULT', 'RESEARCH_BUILD_RESULT', 'BROKER_FEED_BUILD_RESULT'].flatMap((key) =>
  ['failure', 'cancelled', 'skipped', ''].map((result) => [key, result] as const),
)
test.each(rejectedBuilds)('rejects terminal build proof %s=%s before any registry access', (key, value) => {
  const result = run(undefined, { [key]: value })
  expect(result.exitCode).not.toBe(0)
  expect(result.commands).toEqual([])
  expect(result.output).toBe('existing_output=retained\n')
})

test.each([
  ['GITHUB_REPOSITORY', 'other/lab'],
  ['GITHUB_REF', 'refs/heads/feature'],
  ['GITHUB_EVENT_NAME', 'pull_request'],
  ['GITHUB_EVENT_NAME', 'pull_request_target'],
  ['GITHUB_SHA', '1234'],
  ['GITHUB_RUN_ID', '0'],
  ['GITHUB_RUN_ID', ''],
] as const)('rejects publication identity %s=%s', (key, value) => {
  const result = run(undefined, { [key]: value })
  expect(result.exitCode).not.toBe(0)
  expect(result.commands).toEqual([])
  expect(result.output).toBe('existing_output=retained\n')
})

test('rejects a checkout different from the admitted source', () => {
  const result = run((state) => {
    state.checkout = '2'.repeat(40)
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.commands).toEqual([['git', 'rev-parse', 'HEAD']])
  expect(result.output).toBe('existing_output=retained\n')
})

const invalidPlatforms = names.flatMap((name, member) =>
  architectures.flatMap((architecture, arch) =>
    [
      'missing-tag',
      'invalid-digest',
      'missing-config',
      'invalid-json',
      'missing-labels',
      'wrong-source',
      'wrong-time',
      'wrong-os',
      'wrong-arch',
    ].map((problem) => ({ name, member, architecture, arch, problem })),
  ),
)
test.each(invalidPlatforms)(
  'rejects $name/$architecture $problem before preparing any index',
  ({ name, member, architecture, arch, problem }) => {
    const result = run((state) => {
      const tag = `${image(name)}:sha-${source}-${architecture}`
      const reference = `${image(name)}@${childDigest(member, arch)}`
      switch (problem) {
        case 'missing-tag':
          delete state.tags[tag]
          break
        case 'invalid-digest':
          state.tags[tag] = 'sha256:invalid'
          break
        case 'missing-config':
          delete state.configs[reference]
          break
        case 'invalid-json':
          state.configs[reference] = '{'
          break
        case 'missing-labels':
          state.configs[reference] = { os: 'linux', architecture, config: {} }
          break
        case 'wrong-source':
          state.configs[reference] = config(architecture, '2'.repeat(40))
          break
        case 'wrong-time':
          state.configs[reference] = config(architecture, source, '2026-11-20T10:00:00+00:00')
          break
        case 'wrong-os':
          state.configs[reference] = { ...config(architecture), os: 'windows' }
          break
        case 'wrong-arch':
          state.configs[reference] = config(architecture === 'arm64' ? 'amd64' : 'arm64')
          break
      }
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.commands.filter(([command]) => command === 'regctl')).toEqual([])
    expect(result.output).toBe('existing_output=retained\n')
  },
)

test.each([...names])('index write failure for %s emits no partial outputs or discoverable tag', (name) => {
  const result = run((state) => {
    state.failIndex = image(name)
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.output).toBe('existing_output=retained\n')
  expect(result.commands.every((command) => !command.includes('tag') && !command.includes('copy'))).toBe(true)
})

test.each([...names])('binds %s child proof to the immutable returned index instead of its mutable tag', (name) => {
  const result = run((state) => {
    state.corruptPinnedIndex = image(name)
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('Prepared index does not contain the verified platform digests')
  expect(result.output).toBe('existing_output=retained\n')
  expect(result.commands.every((command) => !command.includes('tag') && !command.includes('copy'))).toBe(true)
})

test('rejects an invalid returned index digest without emitting cohort outputs', () => {
  const result = run((state) => {
    state.indexDigests[image('bayn-broker-feed')] = 'sha256:invalid'
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('Missing or invalid OCI digest')
  expect(result.output).toBe('existing_output=retained\n')
})

test.each(names.flatMap((name) => (['extra', 'missing', 'duplicate'] as const).map((kind) => ({ name, kind }))))(
  'rejects a $kind descriptor in the complete immutable $name index',
  ({ name, kind }) => {
    const result = run((state) => {
      state.pinnedDescriptorMutation = { image: image(name), kind }
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('Prepared index does not contain the verified platform digests')
    expect(result.output).toBe('existing_output=retained\n')
    expect(result.commands.every((command) => !command.includes('tag') && !command.includes('copy'))).toBe(true)
  },
)
