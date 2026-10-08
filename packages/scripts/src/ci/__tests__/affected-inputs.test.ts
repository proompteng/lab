import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { changedRange, matchesPaths, parseTargets, selectAffectedInputs } from '../affected-inputs'
import { matchesGlob } from '../impact-router'

const before = {
  lockfileVersion: 1,
  configVersion: 1,
  workspaces: {
    '': { name: 'root' },
    'apps/landing': { name: 'landing', dependencies: {} },
    'services/bayn': { name: 'bayn', dependencies: { client: '^1.0.0' } },
  },
  packages: {
    client: ['client@1.0.0', '', { dependencies: { dayjs: '^1.0.0' } }, 'client-integrity'],
    dayjs: ['dayjs@1.0.0', '', {}, 'old-integrity'],
  },
}
const after = {
  ...before,
  workspaces: {
    ...before.workspaces,
    'apps/landing': { name: 'landing', dependencies: { mermaid: '^11.0.0' } },
  },
  packages: {
    ...before.packages,
    mermaid: ['mermaid@11.0.0', '', { dependencies: { dayjs: '^2.0.0' } }, 'mermaid-integrity'],
    dayjs: ['dayjs@2.0.0', '', {}, 'new-integrity'],
    'client/dayjs': before.packages.dayjs,
  },
}
const targets = {
  bayn: { workspaces: ['', 'services/bayn'], paths: ['services/bayn/**', 'bun.lock', '**/package.json'] },
  landing: { workspaces: ['', 'apps/landing'], paths: ['apps/landing/**', 'bun.lock', '**/package.json'] },
}

test('a Landing dependency addition and hoist move do not rebuild Bayn', () => {
  expect(selectAffectedInputs(['bun.lock', 'apps/landing/package.json'], targets, before, after)).toEqual({
    bayn: false,
    landing: true,
  })
})

test('unrelated workspace metadata does not rebuild another service', () => {
  expect(selectAffectedInputs(['apps/landing/package.json'], targets, before, before).bayn).toBe(false)
})

test('native Tengri images do not consume Bun metadata', () => {
  const workflow = Bun.YAML.parse(readFileSync('.github/workflows/tengri-images.yml', 'utf8'))
  for (const event of ['pull_request', 'push']) {
    const paths = property(property(property(workflow, 'on'), event), 'paths')
    if (!Array.isArray(paths)) throw new Error('Missing native image trigger paths')
    for (const file of ['bun.lock', 'packages/scripts/package.json']) {
      expect(paths.some((pattern) => matchesGlob(file, text(pattern)))).toBe(false)
    }
  }
})

test('a changed transitive dependency still runs its consumers', () => {
  const upgraded = { ...before, packages: { ...before.packages, dayjs: after.packages.dayjs } }
  expect(selectAffectedInputs(['bun.lock'], targets, before, upgraded)).toEqual({ bayn: true, landing: false })
})

test('integrity changes and root install configuration still run consumers', () => {
  const repacked = { ...before, packages: { ...before.packages, dayjs: ['dayjs@1.0.0', '', {}, 'new-integrity'] } }
  expect(selectAffectedInputs(['bun.lock'], targets, before, repacked).bayn).toBe(true)
  expect(selectAffectedInputs(['bun.lock'], targets, before, { ...before, configVersion: 0 })).toEqual({
    bayn: true,
    landing: true,
  })
  expect(selectAffectedInputs(['package.json'], targets, before, before)).toEqual({ bayn: true, landing: true })
})

test.each(['optionalDependencies', 'peerDependencies', 'devDependencies'])('tracks installed workspace %s', (field) => {
  const lock = {
    ...before,
    workspaces: { ...before.workspaces, 'services/bayn': { name: 'bayn', [field]: { dayjs: '*' } } },
  }
  const upgraded = { ...lock, packages: { ...lock.packages, dayjs: after.packages.dayjs } }
  expect(selectAffectedInputs(['bun.lock'], targets, lock, upgraded).bayn).toBe(true)
})

test('follows tarball metadata and scoped nested resolutions without confusing package scopes with parents', () => {
  const lock = {
    ...before,
    workspaces: {
      ...before.workspaces,
      'services/bayn': { name: '@scope/bayn', dependencies: { '@lib/client': '*' } },
    },
    packages: {
      ...before.packages,
      '@lib/client': ['@lib/client@https://example.com/client.tgz', { dependencies: { dayjs: '*' } }, 'integrity'],
      '@lib/dayjs': ['wrong-scope@1.0.0', '', {}, 'wrong-integrity'],
      '@lib/client/dayjs': before.packages.dayjs,
    },
  }
  const upgraded = { ...lock, packages: { ...lock.packages, '@lib/client/dayjs': after.packages.dayjs } }
  expect(selectAffectedInputs(['bun.lock'], targets, lock, upgraded).bayn).toBe(true)
  const rehoisted = { ...lock, packages: { ...before.packages, '@lib/client': lock.packages['@lib/client'] } }
  expect(selectAffectedInputs(['bun.lock'], targets, lock, rehoisted).bayn).toBe(false)
})

test('detects changed dependency edges even when the installed version set is unchanged', () => {
  const lock = {
    ...before,
    workspaces: { ...before.workspaces, 'services/bayn': { name: 'bayn', dependencies: { client: '*', other: '*' } } },
    packages: {
      ...before.packages,
      other: ['other@1.0.0', '', { dependencies: { dayjs: '*' } }, 'other-integrity'],
      'other/dayjs': after.packages.dayjs,
    },
  }
  const swapped = {
    ...lock,
    packages: { ...lock.packages, 'client/dayjs': after.packages.dayjs, 'other/dayjs': before.packages.dayjs },
  }
  expect(selectAffectedInputs(['bun.lock'], targets, lock, swapped).bayn).toBe(true)
})

test('tracks linked workspace manifests, handles cycles, and ignores absent peers', () => {
  const lock = {
    ...before,
    workspaces: {
      ...before.workspaces,
      'services/bayn': { name: 'bayn', dependencies: { shared: 'workspace:*' } },
      'packages/shared': { name: 'shared', dependencies: { client: '*' }, peerDependencies: { absent: '*' } },
    },
    packages: {
      ...before.packages,
      shared: ['shared@workspace:packages/shared'],
      client: ['client@1.0.0', '', { dependencies: { shared: 'workspace:*' } }, 'integrity'],
    },
  }
  expect(selectAffectedInputs(['packages/shared/package.json'], targets, lock, lock).bayn).toBe(true)
  expect(selectAffectedInputs(['bun.lock'], targets, lock, lock).bayn).toBe(false)
})

test('new workspaces run validation and invalid metadata cannot silently skip it', () => {
  const added = { ...before, workspaces: { ...before.workspaces, 'services/new': { name: 'new' } } }
  expect(
    selectAffectedInputs(['bun.lock'], { new: { workspaces: ['services/new'], paths: [] } }, before, added).new,
  ).toBe(true)
  expect(() => selectAffectedInputs(['bun.lock'], targets, {}, before)).toThrow('Unsupported Bun lockfile')
  expect(() => selectAffectedInputs(['bun.lock'], targets, before, { ...before, packages: {} })).toThrow(
    'Unresolved dependency',
  )
})

test('preserves ordered path exclusions and native source changes', () => {
  expect(matchesPaths('src/helper.test.ts', ['src/**', '!src/**/*.test.ts'])).toBe(false)
  expect(matchesPaths('src/keep.test.ts', ['src/**', '!src/**/*.test.ts', 'src/keep.test.ts'])).toBe(true)
  expect(selectAffectedInputs(['services/bayn/src/runtime.ts'], targets, before, before).bayn).toBe(true)
  expect(selectAffectedInputs(['services/bayn/fixtures/package.json'], targets, before, before).bayn).toBe(true)
})

const property = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object') throw new Error(`Missing workflow object for ${key}`)
  return Object.entries(value).find(([name]) => name === key)?.[1]
}
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Expected workflow text')
  return value
}

test('Tengri runtime repairs publish the desktop from the same source', () => {
  const workflow: unknown = Bun.YAML.parse(readFileSync('.github/workflows/product-nix-images.yml', 'utf8'))
  const steps = property(property(property(workflow, 'jobs'), 'changes'), 'steps')
  if (!Array.isArray(steps)) throw new Error('Missing planner steps')
  const inputs = property(
    steps.find((step) => property(step, 'id') === 'filter'),
    'with',
  )
  const configured = parseTargets(
    text(property(inputs, 'workspaces')),
    text(property(inputs, 'filters')),
    '',
    'pull_request',
  )
  const workspaces = Object.fromEntries(
    Object.values(configured)
      .flatMap((target) => target.workspaces)
      .map((path) => [path, { name: path || 'root' }]),
  )
  const lock = { ...before, workspaces: { ...workspaces, ...before.workspaces } }
  for (const source of ['services/tengri/src/slot/vmm.rs', 'services/tengri/network.sh']) {
    for (const event of ['pull_request', 'push']) {
      const paths = property(property(property(workflow, 'on'), event), 'paths')
      if (!Array.isArray(paths)) throw new Error('Missing image trigger paths')
      expect(paths.some((pattern) => matchesGlob(source, text(pattern)))).toBe(true)
    }
    expect(selectAffectedInputs([source], configured, lock, lock)).toEqual({
      proompteng: true,
      app: false,
      synthesis: false,
      docs: false,
    })
  }
})

test.each([
  'bayn-ci.yml',
  'bumba-ci.yml',
  'froussard-ci.yml',
  'oirat-ci.yml',
  'signal-publisher-build-push.yml',
  'restate-images.yml',
  'product-nix-images.yml',
])('%s uses dependency-aware PR selection for the Landing-only regression', (filename) => {
  const workflow: unknown = Bun.YAML.parse(readFileSync(`.github/workflows/${filename}`, 'utf8'))
  const steps = property(property(property(workflow, 'jobs'), 'changes'), 'steps')
  if (!Array.isArray(steps)) throw new Error('Missing planner steps')
  const filter = steps.find((step) => property(step, 'id') === 'filter')
  expect(property(filter, 'uses')).toBe('./.github/actions/affected-inputs')
  const inputs = property(filter, 'with')
  const configured = parseTargets(
    text(property(inputs, 'workspaces')),
    text(property(inputs, 'filters') ?? '{}'),
    text(property(inputs, 'workflow') ?? ''),
    'pull_request',
  )
  const workspaces = Object.fromEntries(
    Object.values(configured)
      .flatMap((target) => target.workspaces)
      .map((path) => [path, { name: path || 'root' }]),
  )
  const base = { ...before, workspaces: { ...workspaces, ...before.workspaces } }
  const head = { ...after, workspaces: { ...workspaces, ...after.workspaces } }
  const plan = selectAffectedInputs(['bun.lock', 'apps/landing/package.json'], configured, base, head)
  expect(plan).toEqual(Object.fromEntries(Object.keys(configured).map((name) => [name, name === 'proompteng'])))
  expect(selectAffectedInputs(['.github/actions/affected-inputs/action.yml'], configured, base, base)).toEqual(
    Object.fromEntries(Object.keys(configured).map((name) => [name, true])),
  )
  expect(selectAffectedInputs(['packages/scripts/src/bumba/deploy-service.ts'], configured, base, base)).toEqual(
    Object.fromEntries(Object.keys(configured).map((name) => [name, false])),
  )
})

test('CLI compares a PR against the merge base, retains push publication, and writes manual outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-inputs-'))
  const script = resolve('packages/scripts/src/ci/affected-inputs.ts')
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (lock: unknown) => {
    writeFileSync(join(dir, 'bun.lock'), JSON.stringify(lock))
    git('add', '.')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    )
    return git('rev-parse', 'HEAD')
  }
  try {
    git('init', '-b', 'main')
    const initial = commit(before)
    const head = commit(after)
    git('checkout', '-b', 'base', initial)
    const base = commit({ ...before, configVersion: 0 })
    const run = (event: string, baseSha: string) => {
      const output = join(dir, 'output')
      writeFileSync(output, '')
      execFileSync(process.execPath, [script], {
        cwd: dir,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: event,
          BASE_SHA: baseSha,
          HEAD_SHA: head,
          INPUT_WORKSPACES: 'bayn: ["", "services/bayn"]\nlanding: ["", "apps/landing"]',
          INPUT_FILTERS: 'bayn: ["bun.lock"]\nlanding: ["bun.lock"]',
          INPUT_WORKFLOW: '',
          GITHUB_OUTPUT: output,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return JSON.parse(readFileSync(output, 'utf8').trim().slice('affected='.length))
    }
    expect(run('pull_request', base)).toEqual({ bayn: false, landing: true })
    expect(run('push', base)).toEqual({ bayn: true, landing: true })
    expect(run('workflow_dispatch', '')).toEqual({ bayn: true, landing: true })
    expect(() => changedRange('pull_request', '', head)).toThrow('valid nonzero')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
