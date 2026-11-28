import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { changedRange, matchesOnlyPaths, matchesPaths, parseTargets, selectAffectedInputs } from '../affected-inputs'
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
const tengriPublisherPath = '.github/workflows/tengri-images.yml'
const baynPostgresTestHelpers = [
  'services/bayn/src/testing/postgres-template.test-support.ts',
  'services/bayn/tools/postgres-file-preload.ts',
  'services/bayn/tools/postgres-test-databases.ts',
] as const

const publicationWorkflows = readdirSync('.github/workflows').filter((filename) => {
  if (!/\.ya?ml$/.test(filename)) return false
  return (
    ['tengri-images.yml', 'restate-images.yml', 'temporal-worker-images.yml'].includes(filename) ||
    readFileSync(`.github/workflows/${filename}`, 'utf8').includes('uses: ./.github/workflows/nix-oci-build-common.yml')
  )
})

test.each(publicationWorkflows)('%s keeps native work scoped to runtime inputs', (filename) => {
  const workflow: unknown = Bun.YAML.parse(readFileSync(`.github/workflows/${filename}`, 'utf8'))
  for (const event of ['push', 'pull_request']) {
    const input = property(property(workflow, 'on'), event)
    if (input === undefined || input === null) continue
    const paths = property(input, 'paths')
    if (paths === undefined) continue
    if (!Array.isArray(paths)) throw new Error(`Missing publication input boundaries: ${filename}`)
    const patterns = paths.map(text)
    for (const file of [
      `.github/workflows/${filename}`,
      '.github/workflows/nix-oci-build-common.yml',
      '.github/actions/setup-nix-toolchain/action.yml',
      'packages/scripts/src/shared/oci.ts',
      'packages/scripts/src/shared/cli.ts',
      'nix/ci-nix-oci-summary.sh',
      'nix/ci-run-timed.sh',
      'argocd/applications/kargo/warehouses.yaml',
      'packages/scripts/src/tengri/release-workflows.test.ts',
      'packages/scripts/src/tengri/__tests__/schema.test.ts',
      'packages/scripts/src/shared/__tests__/restate-resilience-contract.test.ts',
    ])
      expect(matchesPaths(file, patterns)).toBe(
        (filename === 'restate-images.yml' && file === '.github/workflows/restate-images.yml') ||
          (event === 'push' && filename === 'tengri-images.yml' && file === tengriPublisherPath) ||
          (event === 'pull_request' &&
            ['attic-build-push.yaml', 'ofz.yaml', 'relay.yml'].includes(filename) &&
            file === `.github/workflows/${filename}`) ||
          (event === 'pull_request' &&
            filename === 'opencode-ci.yml' &&
            ['.github/workflows/opencode-ci.yml', '.github/workflows/nix-oci-build-common.yml'].includes(file)),
      )
    for (const file of [
      'nix/cache-push.sh',
      'nix/oci-push.sh',
      'nix/oci-inspect-archive.sh',
      'nix/oci-release-contract.sh',
    ]) {
      expect(matchesPaths(file, patterns)).toBe(
        event === 'push' && ['arc-runner-build-push.yml', 'opencode-build-push.yml'].includes(filename),
      )
    }
  }
})

test('native PR validation preserves image publication and cache warming boundaries', () => {
  const workflow: unknown = Bun.YAML.parse(readFileSync('.github/workflows/nix-oci-build-common.yml', 'utf8'))
  const indexInput = property(property(property(workflow, 'on'), 'workflow_call'), 'inputs')
  expect(property(indexInput, 'publish_index')).toEqual({
    description: 'Publish the index here; disable only when the caller prepares a verified image cohort',
    required: false,
    type: 'boolean',
    default: true,
  })
  const jobs = property(workflow, 'jobs')
  const steps = property(property(jobs, 'build-platform'), 'steps')
  if (!Array.isArray(steps)) throw new Error('Missing native build steps')
  const stepCondition = (name: string) =>
    property(
      steps.find((step) => property(step, 'name') === name),
      'if',
    )
  const conditions = [
    [stepCondition('Push platform image without Docker'), 'publish'],
    [property(property(jobs, 'publish-index'), 'if'), 'index'],
    [stepCondition('Warm Nix build outputs in Attic'), 'warm'],
  ] as const
  for (const [event, ref, publishOnDispatch, publish, warm] of [
    ['pull_request', 'refs/pull/1/merge', false, false, false],
    ['pull_request', 'refs/heads/main', true, false, false],
    ['push', 'refs/heads/main', false, true, true],
    ['push', 'refs/heads/feature', true, false, false],
    ['workflow_dispatch', 'refs/heads/main', false, true, true],
    ['workflow_dispatch', 'refs/heads/feature', false, false, false],
    ['workflow_dispatch', 'refs/heads/feature', true, true, false],
  ] as const) {
    for (const publishIndex of [true, false]) {
      for (const [condition, boundary] of conditions) {
        const expression = text(condition).replace(/^\s*\$\{\{|\}\}\s*$/g, '')
        expect(
          runInNewContext(expression, {
            github: { event_name: event, ref },
            inputs: { publish_on_dispatch: publishOnDispatch, publish_index: publishIndex },
          }),
        ).toBe(boundary === 'warm' ? warm : publish && (boundary !== 'index' || publishIndex))
      }
    }
  }
})

test('Attic PR validation receives no cache credential and pins its reviewed source', () => {
  const workflow: unknown = Bun.YAML.parse(readFileSync('.github/workflows/attic-build-push.yaml', 'utf8'))
  const jobs = property(workflow, 'jobs')
  const validation = property(jobs, 'validate')
  const publication = property(jobs, 'build-and-push')
  expect(property(validation, 'secrets')).toBeUndefined()
  expect(property(property(validation, 'with'), 'source_revision')).toBe('${{ github.event.pull_request.head.sha }}')
  const credentials = property(publication, 'secrets')
  expect(Object.keys(credentials as Record<string, unknown>)).toEqual(['ATTIC_TOKEN'])
  const tokenExpression = text(property(credentials, 'ATTIC_TOKEN')).replace(/^\s*\$\{\{|\}\}\s*$/g, '')
  for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
    for (const ref of ['refs/pull/1/merge', 'refs/heads/feature', 'refs/heads/main']) {
      const context = { github: { event_name: event, ref }, secrets: { ATTIC_TOKEN: 'synthetic-upload-token' } }
      expect(runInNewContext(text(property(validation, 'if')), context)).toBe(event === 'pull_request')
      const publishes = runInNewContext(text(property(publication, 'if')), context)
      expect(publishes).toBe(event !== 'pull_request')
      const forwardedToken = publishes ? runInNewContext(tokenExpression, context) : ''
      expect(forwardedToken).toBe(event !== 'pull_request' && ref === 'refs/heads/main' ? 'synthetic-upload-token' : '')
    }
  }
})

test('OpenCode CLI changes publish only the owning image', () => {
  for (const [filename, expected] of [
    ['bayn-build-push.yml', false],
    ['opencode-build-push.yml', true],
  ] as const) {
    const workflow: unknown = Bun.YAML.parse(readFileSync(`.github/workflows/${filename}`, 'utf8'))
    const paths = property(property(property(workflow, 'on'), 'push'), 'paths')
    if (!Array.isArray(paths)) throw new Error(`Missing publication inputs: ${filename}`)
    expect(matchesPaths('nix/images/opencode-cli.nix', paths.map(text))).toBe(expected)
  }
})

test.each(['bayn-build-push.yml', 'opencode-build-push.yml'])(
  '%s excludes only the PostgreSQL test helpers from main publication',
  (filename) => {
    const workflow: unknown = Bun.YAML.parse(readFileSync(`.github/workflows/${filename}`, 'utf8'))
    const paths = property(property(property(workflow, 'on'), 'push'), 'paths')
    if (!Array.isArray(paths)) throw new Error(`Missing publication inputs: ${filename}`)
    const patterns = paths.map(text)
    const selected = (files: readonly string[]) => files.some((file) => matchesPaths(file, patterns))
    const helpers = baynPostgresTestHelpers
    expect(selected(helpers)).toBe(false)
    for (const helper of helpers) {
      expect(patterns).toContain(`!${helper}`)
      expect(selected([helper])).toBe(false)
      expect(selected([helper.replace(/\.ts$/, '.runtime.ts')])).toBe(true)
    }
    for (const runtime of [
      'services/bayn/src/execution/controller.ts',
      'services/bayn/tools/compile-frozen-control.ts',
      'services/bayn/package.json',
      'nix/images/bayn-runtime-root.nix',
      'patches/effect@4.1.4.patch',
      ...(filename === 'opencode-build-push.yml'
        ? ['services/opencode/start.sh', 'nix/images/opencode.nix', 'nix/oci-push.sh']
        : ['nix/images/bayn.nix', 'argocd/applications/bayn/configmap.yaml']),
    ]) {
      expect(selected([runtime])).toBe(true)
      expect(selected([...helpers, runtime])).toBe(true)
      expect(selected([runtime, ...helpers])).toBe(true)
    }
    for (const orchestration of [`.github/workflows/${filename}`, '.github/workflows/nix-oci-build-common.yml'])
      expect(selected([...helpers, orchestration])).toBe(false)
  },
)

test('OpenCode PR validation selects the PR head without publication secrets', () => {
  const validation: unknown = Bun.YAML.parse(readFileSync('.github/workflows/opencode-ci.yml', 'utf8'))
  const publication: unknown = Bun.YAML.parse(readFileSync('.github/workflows/opencode-build-push.yml', 'utf8'))
  const image = property(property(validation, 'jobs'), 'image')
  expect(property(image, 'secrets')).toBeUndefined()
  expect(property(image, 'if')).toBeUndefined()
  expect(property(property(property(publication, 'jobs'), 'image'), 'if')).toBeUndefined()
  expect(property(property(validation, 'permissions'), 'contents')).toBe('read')
  const source = text(property(property(image, 'with'), 'source_revision')).replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  expect(
    runInNewContext(source, {
      github: { sha: 'merge-commit', event: { pull_request: { head: { sha: 'reviewed-pr-head' } } } },
    }),
  ).toBe('reviewed-pr-head')

  const selected = (workflow: unknown, event: string, ref: string, file: string) => {
    const trigger = property(property(workflow, 'on'), event)
    if (trigger === undefined) return false
    const paths = property(trigger, 'paths')
    const branches = property(trigger, 'branches')
    if (!Array.isArray(paths)) throw new Error('Missing OpenCode input paths')
    return (
      matchesPaths(file, paths.map(text)) &&
      (!Array.isArray(branches) || matchesPaths(ref.replace(/^refs\/heads\//, ''), branches.map(text)))
    )
  }
  for (const [event, ref, file, validate, publish] of [
    ['pull_request', 'refs/pull/42/merge', '.github/workflows/opencode-ci.yml', true, false],
    ['pull_request', 'refs/pull/42/merge', '.github/workflows/nix-oci-build-common.yml', true, false],
    ['pull_request', 'refs/pull/42/merge', 'services/opencode/start.sh', true, false],
    ['pull_request_target', 'refs/heads/main', 'services/opencode/start.sh', false, false],
    ['push', 'refs/heads/main', 'services/opencode/start.sh', false, true],
    ['push', 'refs/heads/feature', 'services/opencode/start.sh', false, false],
    ['push', 'refs/heads/main', '.github/workflows/nix-oci-build-common.yml', false, false],
    ['workflow_dispatch', 'refs/heads/main', 'services/opencode/start.sh', false, false],
  ] as const) {
    expect(selected(validation, event, ref, file)).toBe(validate)
    expect(selected(publication, event, ref, file)).toBe(publish)
  }
  for (const helper of baynPostgresTestHelpers)
    expect(selected(validation, 'pull_request', 'refs/pull/42/merge', helper)).toBe(false)
})

test('Bayn push triggers cover exactly the installed Bun workspace manifests', () => {
  const { image } = parseTargets("image: ['', 'services/bayn']", '', '.github/workflows/bayn-build-push.yml', 'push')
  const lock = Bun.JSONC.parse(readFileSync('bun.lock', 'utf8'))
  const manifests = Object.keys(lock.workspaces).map((path) => (path ? `${path}/package.json` : 'package.json'))
  const dependencies = { image: { workspaces: image.workspaces, paths: [] } }

  expect(manifests.filter((file) => matchesPaths(file, image.paths))).toEqual(
    manifests.filter((file) => selectAffectedInputs([file], dependencies, lock, lock).image),
  )
  expect(matchesPaths('bun.lock', image.paths)).toBe(true)
})

test('Bayn publication ignores Froussard-only dependencies and still selects Bayn runtime changes', () => {
  const configured = parseTargets("image: ['', 'services/bayn']", '', '.github/workflows/bayn-build-push.yml', 'push')
  const prior = {
    ...before,
    workspaces: { ...before.workspaces, 'apps/froussard': { name: 'froussard', dependencies: {} } },
  }
  const next = {
    ...prior,
    workspaces: {
      ...prior.workspaces,
      'apps/froussard': { name: 'froussard', dependencies: { '@restatedev/restate-sdk': '1.16.5' } },
    },
    packages: {
      ...prior.packages,
      '@restatedev/restate-sdk': ['@restatedev/restate-sdk@1.16.5', '', {}, 'sdk-integrity'],
    },
  }
  expect(selectAffectedInputs(['bun.lock', 'apps/froussard/package.json'], configured, prior, next).image).toBe(false)
  expect(selectAffectedInputs(['services/bayn/src/runtime.ts'], configured, prior, next).image).toBe(true)
  expect(selectAffectedInputs(['services/bayn/package.json'], configured, prior, next).image).toBe(true)
  expect(
    selectAffectedInputs(['services/bayn/README.md', 'argocd/applications/bayn/README.md'], configured, prior, next)
      .image,
  ).toBe(false)
  expect(selectAffectedInputs(['argocd/applications/bayn/postgres-cluster.yaml'], configured, prior, next).image).toBe(
    true,
  )
  const changedDependency = {
    ...next,
    packages: { ...next.packages, client: ['client@1.1.0', '', {}, 'new-integrity'] },
  }
  expect(selectAffectedInputs(['bun.lock'], configured, prior, changedDependency).image).toBe(true)
})

test('App source changes do not force dependency downloads; dependency input changes still do', () => {
  const workflow: unknown = Bun.YAML.parse(readFileSync('.github/workflows/product-nix-images.yml', 'utf8'))
  const jobs = property(workflow, 'jobs')
  const steps = property(property(jobs, 'changes'), 'steps')
  if (!Array.isArray(steps)) throw new Error('Missing product planner')
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
  expect(configured.app_dependencies).toBeDefined()
  const workspaces = Object.fromEntries(
    Object.values(configured)
      .flatMap((target) => target.workspaces)
      .map((path) => [path, { name: path || 'root' }]),
  )
  const lock = { ...before, workspaces: { ...workspaces, ...before.workspaces } }
  for (const file of ['apps/app/src/routes/index.tsx', 'packages/design/src/button.tsx']) {
    const plan = selectAffectedInputs([file], configured, lock, lock)
    expect(plan.app).toBe(true)
    expect(plan.app_dependencies).toBe(false)
  }
  for (const file of [
    'apps/app/package.json',
    'packages/design/package.json',
    'patches/example.patch',
    'bunfig.toml',
    '.npmrc',
    'nix/images/app.nix',
    'nix/images/relativize-bun-cache.sh',
    'nix/check-bun-dependency-closure.sh',
  ]) {
    expect(selectAffectedInputs([file], configured, lock, lock).app_dependencies).toBe(true)
    const outer = property(property(property(workflow, 'on'), 'pull_request'), 'paths')
    if (!Array.isArray(outer)) throw new Error('Missing product PR inputs')
    expect(matchesPaths(file, outer.map(text))).toBe(true)
  }
  const expression = text(property(property(jobs, 'build-app'), 'if')).replaceAll(
    'needs.verify-app-dependency-closure',
    'needs["verify-app-dependency-closure"]',
  )
  for (const result of ['success', 'skipped', 'failure', 'cancelled']) {
    for (const dependenciesRequired of [true, false])
      for (const planner of ['success', 'failure'])
        for (const cancelled of [true, false]) {
          expect(
            runInNewContext(expression, {
              github: { event_name: 'push', ref: 'refs/heads/main' },
              needs: {
                changes: { result: planner, outputs: { app: 'true', app_dependencies: String(dependenciesRequired) } },
                'verify-app-dependency-closure': { result },
              },
              cancelled: () => cancelled,
            }),
          ).toBe(
            !cancelled &&
              planner === 'success' &&
              (result === 'success' || (!dependenciesRequired && result === 'skipped')),
          )
        }
  }
  const output = text(property(property(property(jobs, 'changes'), 'outputs'), 'app_dependencies')).replace(
    /^\$\{\{\s*|\s*\}\}$/g,
    '',
  )
  for (const selected of [true, false]) {
    expect(
      String(
        runInNewContext(output, {
          github: { event_name: 'workflow_dispatch' },
          steps: { manual: { outputs: { app: String(selected) } } },
          fromJSON: () => {
            throw new Error('manual builds must not read a skipped planner')
          },
        }),
      ),
    ).toBe(String(selected))
  }
})

test('runtime, dependency and image-definition changes still publish the complete release cohort', () => {
  for (const filename of ['ofz.yaml', 'tengri-images.yml', 'product-nix-images.yml']) {
    const workflow: unknown = Bun.YAML.parse(readFileSync(`.github/workflows/${filename}`, 'utf8'))
    const paths = property(property(property(workflow, 'on'), 'push'), 'paths')
    if (!Array.isArray(paths)) throw new Error('Missing cohort publication inputs')
    for (const file of [
      'services/tengri/src/activity.rs',
      'services/nanoagent/browser.go',
      'services/ofz/src/lib.rs',
      'apps/landing/src/components/tengri/chrome-app.tsx',
      'proto/proompteng/authz/v1/authz.proto',
      'nix/images/ofz.nix',
      'nix/images/proompteng.nix',
      'nix/packages.nix',
      'bun.lock',
      'package.json',
      'bunfig.toml',
      '.npmrc',
      'patches/example.patch',
      'tsconfig.base.json',
      'nix/images/relativize-bun-cache.sh',
    ]) {
      expect(matchesPaths(file, paths.map(text))).toBe(true)
    }
  }
})

test('CI publishing and cache helpers retain script validation', () => {
  const workflow: unknown = Bun.YAML.parse(readFileSync('.github/workflows/scripts-ci.yml', 'utf8'))
  for (const event of ['push', 'pull_request']) {
    const paths = property(property(property(workflow, 'on'), event), 'paths')
    if (!Array.isArray(paths)) throw new Error('Missing script validation inputs')
    for (const file of [
      '.github/workflows/nix-oci-build-common.yml',
      '.github/actions/setup-nix-toolchain/action.yml',
      'packages/scripts/src/shared/oci.ts',
      'nix/cache-push.sh',
      'nix/ci-run-timed.sh',
      'nix/oci-release-contract.sh',
      'nix/check-bun-dependency-closure.sh',
    ])
      expect(matchesPaths(file, paths.map(text))).toBe(true)
  }
})

test('a Landing dependency addition and hoist move do not rebuild Bayn', () => {
  expect(selectAffectedInputs(['bun.lock', 'apps/landing/package.json'], targets, before, after)).toEqual({
    bayn: false,
    landing: true,
  })
})

test('unrelated workspace metadata does not rebuild another service', () => {
  expect(selectAffectedInputs(['apps/landing/package.json'], targets, before, before).bayn).toBe(false)
})

test('native PR validation skips Bun metadata while production publishes the complete source cohort', () => {
  const workflow = Bun.YAML.parse(readFileSync('.github/workflows/tengri-images.yml', 'utf8'))
  for (const event of ['pull_request', 'push']) {
    const paths = property(property(property(workflow, 'on'), event), 'paths')
    if (!Array.isArray(paths)) throw new Error('Missing native image trigger paths')
    expect(paths.some((pattern) => matchesGlob('bun.lock', text(pattern)))).toBe(event === 'push')
    expect(paths.some((pattern) => matchesGlob('packages/scripts/package.json', text(pattern)))).toBe(false)
  }
})

test('Ofz implementation keeps runtime qualification and production packages one source cohort', () => {
  const workflow = Bun.YAML.parse(readFileSync('.github/workflows/tengri-images.yml', 'utf8'))
  for (const event of ['pull_request', 'push']) {
    const paths = property(property(property(workflow, 'on'), event), 'paths')
    if (!Array.isArray(paths)) throw new Error('Missing native image trigger paths')
    for (const file of ['services/ofz/README.md', 'nix/images/ofz.nix']) {
      expect(paths.some((pattern) => matchesGlob(file, text(pattern)))).toBe(event === 'push')
    }
    for (const file of [
      'services/ofz/src/lib.rs',
      'services/ofz/src/main.rs',
      'services/ofz/Cargo.toml',
      'services/ofz/Cargo.lock',
      'services/ofz/build.rs',
      'services/ofz/migrations/0001_control.sql',
      'services/ofz/schema.zed',
      'services/ofz/operations.json',
      'services/ofz/test-control.sh',
      'proto/proompteng/authz/v1/authz.proto',
    ]) {
      expect(paths.some((pattern) => matchesGlob(file, text(pattern)))).toBe(true)
    }
  }
})

test('Ofz publication helpers use script CI without waking service qualification', () => {
  const workflow = Bun.YAML.parse(readFileSync('.github/workflows/ofz.yaml', 'utf8'))
  for (const event of ['pull_request', 'push']) {
    const paths = property(property(property(workflow, 'on'), event), 'paths')
    if (!Array.isArray(paths)) throw new Error('Missing Ofz image trigger paths')
    for (const file of [
      'packages/scripts/src/shared/oci.ts',
      'packages/scripts/src/shared/cli.ts',
      'nix/oci-push.sh',
      'nix/oci-inspect-archive.sh',
      'nix/oci-release-contract.sh',
      'nix/ci-run-timed.sh',
      '.github/actions/setup-nix-toolchain/action.yml',
    ]) {
      expect(paths.some((pattern) => matchesGlob(file, text(pattern)))).toBe(false)
    }
  }
})

test('Ofz PR validation selects its identity fixture dependency changes', () => {
  const filename = '.github/workflows/ofz.yaml'
  const workflow: unknown = Bun.YAML.parse(readFileSync(filename, 'utf8'))
  const steps = property(property(property(workflow, 'jobs'), 'validate'), 'steps')
  if (!Array.isArray(steps)) throw new Error('Missing Ofz validation steps')
  const planning = steps.find((step) => property(step, 'id') === 'inputs')
  expect(property(planning, 'uses')).toBe('./.github/actions/affected-inputs')
  expect(property(planning, 'if')).toBe("github.event_name == 'pull_request'")
  const inputs = property(planning, 'with')
  const configured = parseTargets(
    text(property(inputs, 'workspaces')),
    '{}',
    text(property(inputs, 'workflow')),
    'pull_request',
  )
  const base = {
    ...before,
    workspaces: {
      ...before.workspaces,
      'packages/backend': { name: '@proompteng/backend' },
      'packages/design': { name: '@proompteng/design' },
      'services/golink': { name: '@proompteng/golink', dependencies: { dayjs: '^1.0.0' } },
    },
  }
  const unrelated = {
    ...base,
    workspaces: { ...base.workspaces, 'services/golink': { name: '@proompteng/golink', dependencies: {} } },
  }
  const identity = {
    ...base,
    workspaces: { ...base.workspaces, 'apps/landing': after.workspaces['apps/landing'] },
    packages: after.packages,
  }
  expect(selectAffectedInputs(['bun.lock'], configured, base, unrelated)).toEqual({ ofz: false })
  expect(selectAffectedInputs(['bun.lock'], configured, base, identity)).toEqual({ ofz: true })
  expect(selectAffectedInputs(['services/ofz/src/main.rs'], configured, base, base)).toEqual({ ofz: true })
  const identityStep = steps.find(
    (step) => property(step, 'name') === 'Verify real browser identity and shared sessions',
  )
  expect(property(identityStep, 'if')).toBe("steps.selection.outputs.run != 'false'")
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

test('Jangar CI selects runtime and dependency changes without taking Agents or observability ownership', () => {
  const router: unknown = Bun.YAML.parse(readFileSync('.github/workflows/pull-request.yml', 'utf8'))
  const steps = property(property(property(router, 'jobs'), 'plan'), 'steps')
  if (!Array.isArray(steps)) throw new Error('Missing CI planner steps')
  const step = steps.find((candidate) => property(candidate, 'id') === 'jangar')
  expect(step).toMatchObject({
    if: "github.event_name == 'pull_request'",
    uses: './.github/actions/affected-inputs',
  })
  const inputs = property(step, 'with')
  const configured = parseTargets(
    text(property(inputs, 'workspaces')),
    text(property(inputs, 'filters')),
    '',
    'pull_request',
  )
  const lock = Bun.JSONC.parse(readFileSync('bun.lock', 'utf8')) as { packages: Record<string, unknown[]> }
  const unrelated = [
    'argocd/applications/agents/values.yaml',
    'argocd/applications/agents/agents-primitives-agentprovider.yaml',
    'charts/agents/templates/deployment.yaml',
    'argocd/applications/observability/graf-mimir-rules.yaml',
    'services/agents/src/server/control-plane.ts',
    'docs/jangar/architecture-inventory.md',
    'packages/codex/src/app-server-client.test.ts',
    'packages/temporal-bun-sdk/tests/client.test.ts',
    'packages/temporal-bun-sdk/README.md',
  ]
  for (const file of unrelated) expect(selectAffectedInputs([file], configured, lock, lock).jangar, file).toBe(false)

  for (const file of [
    'services/jangar/src/server/index.ts',
    'services/bumba/src/atlas/reconciliation.ts',
    'packages/agent-contracts/src/index.ts',
    'packages/codex/src/app-server-client.ts',
    'packages/cx-tools/src/index.ts',
    'packages/cx-tools/package.json',
    'packages/design/src/components/ui/button.tsx',
    'packages/discord/src/index.ts',
    'packages/otel/src/index.ts',
    'packages/temporal-bun-sdk/src/index.ts',
    'packages/design/package.json',
    'argocd/applications/jangar/deployment.yaml',
    'argocd/bootstrap/jangar/kustomization.yaml',
    '.github/workflows/jangar-ci.yml',
  ]) {
    expect(selectAffectedInputs([...unrelated, file], configured, lock, lock).jangar, file).toBe(true)
  }

  const upgraded = (name: string) => {
    const entry = lock.packages[name]
    if (!Array.isArray(entry)) throw new Error(`Missing lock entry for ${name}`)
    return { ...lock, packages: { ...lock.packages, [name]: [...entry.slice(0, -1), 'new-integrity'] } }
  }
  expect(selectAffectedInputs([...unrelated, 'bun.lock'], configured, lock, upgraded('vite')).jangar).toBe(true)
  expect(selectAffectedInputs([...unrelated, 'bun.lock'], configured, lock, upgraded('nitro')).jangar).toBe(false)
})

test('planner implementation, action, and map changes retain their owning validation', () => {
  const workflow: unknown = Bun.YAML.parse(readFileSync('.github/workflows/scripts-ci.yml', 'utf8'))
  for (const event of ['pull_request', 'push']) {
    const paths = property(property(property(workflow, 'on'), event), 'paths')
    if (!Array.isArray(paths)) throw new Error('Missing scripts CI trigger paths')
    for (const file of [
      'packages/scripts/src/ci/affected-inputs.ts',
      '.github/actions/affected-inputs/action.yml',
      '.github/ci/root-script-map.yml',
    ]) {
      expect(paths.some((pattern) => matchesGlob(file, text(pattern)))).toBe(true)
    }
  }
})

test.each(['orbit-salvage', 'ricochet-rush'])('%s does not rebuild for unrelated impact-map edits', (name) => {
  const workflow: unknown = Bun.YAML.parse(readFileSync(`.github/workflows/${name}-ci.yml`, 'utf8'))
  for (const event of ['pull_request', 'push']) {
    const paths = property(property(property(workflow, 'on'), event), 'paths')
    if (!Array.isArray(paths)) throw new Error('Missing game CI trigger paths')
    expect(paths.some((pattern) => matchesGlob('.github/ci/impact-map.yml', text(pattern)))).toBe(false)
    expect(paths.some((pattern) => matchesGlob(`apps/${name}/project.godot`, text(pattern)))).toBe(true)
  }
})

test('Tengri runtime and publisher changes schedule desktop images on main only', () => {
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
  for (const source of ['services/tengri/src/slot/vmm.rs', 'services/tengri/network.sh', tengriPublisherPath]) {
    for (const event of ['pull_request', 'push']) {
      const paths = property(property(property(workflow, 'on'), event), 'paths')
      if (!Array.isArray(paths)) throw new Error('Missing image trigger paths')
      expect(paths.some((pattern) => matchesGlob(source, text(pattern)))).toBe(event === 'push')
    }
    expect(selectAffectedInputs([source], configured, lock, lock)).toEqual({
      proompteng: true,
      app: false,
      synthesis: false,
      docs: false,
      app_dependencies: false,
    })
  }
})

test('Tengri frontend PRs skip native images while main publishes coordinated releases', () => {
  const workflow: unknown = Bun.YAML.parse(readFileSync(tengriPublisherPath, 'utf8'))
  const ofz: unknown = Bun.YAML.parse(readFileSync('.github/workflows/ofz.yaml', 'utf8'))
  const source = 'apps/landing/src/components/tengri/desktop-dock.tsx'
  for (const event of ['pull_request', 'push']) {
    const paths = property(property(property(workflow, 'on'), event), 'paths')
    if (!Array.isArray(paths)) throw new Error('Missing native image trigger paths')
    expect(paths.some((pattern) => matchesGlob(source, text(pattern)))).toBe(event === 'push')
    for (const runtimeSource of ['services/tengri/src/slot/vmm.rs', 'services/nanoagent/internal/service/service.go']) {
      expect(paths.some((pattern) => matchesGlob(runtimeSource, text(pattern)))).toBe(true)
    }
    expect(matchesPaths(tengriPublisherPath, paths.map(text))).toBe(event === 'push')
    const ofzPaths = property(property(property(ofz, 'on'), event), 'paths')
    if (!Array.isArray(ofzPaths)) throw new Error('Missing Ofz trigger paths')
    expect(matchesPaths(tengriPublisherPath, ofzPaths.map(text))).toBe(event === 'push')
  }
})

test('the shared Warehouse binds desktop and runtime artifacts to the same immutable source', () => {
  const manifests: unknown = Bun.YAML.parse(readFileSync('argocd/applications/kargo/warehouses.yaml', 'utf8'))
  if (!Array.isArray(manifests)) throw new Error('Missing Warehouse manifests')
  const warehouse = manifests.find((manifest) => property(property(manifest, 'metadata'), 'name') === 'ofz')
  const criteria = text(property(property(property(warehouse, 'spec'), 'freightCreationCriteria'), 'expression'))
  for (const image of ['tengri', 'nanoagent', 'proompteng']) {
    expect(criteria).toContain(
      `imageFrom('registry.ide-newton.ts.net/lab/${image}').Tag == 'kargo-sha-' + imageFrom('registry.ide-newton.ts.net/lab/ofz').Annotations['org.opencontainers.image.revision']`,
    )
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
    Object.fromEntries(Object.keys(configured).map((name) => [name, false])),
  )
  for (const path of [
    'packages/scripts/src/ci/affected-inputs.ts',
    'packages/scripts/src/ci/__tests__/impact-router.test.ts',
    'packages/scripts/src/shared/__tests__/kargo.test.ts',
  ]) {
    expect(selectAffectedInputs([path], configured, base, base)).toEqual(
      Object.fromEntries(Object.keys(configured).map((name) => [name, false])),
    )
  }
  expect(
    selectAffectedInputs(
      ['.github/actions/affected-inputs/action.yml', 'bun.lock', 'apps/landing/package.json'],
      configured,
      base,
      head,
    ),
  ).toEqual(plan)
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
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/source.ts'), 'export const value = 1\n')
    const initial = commit(before)
    const head = commit(after)
    git('checkout', '-b', 'base', initial)
    const base = commit({ ...before, configVersion: 0 })
    const run = (event: string, baseSha: string, dependencyAwarePush = 'false', headSha = head) => {
      const output = join(dir, '.git', 'test-output')
      writeFileSync(output, '')
      execFileSync(process.execPath, [script], {
        cwd: dir,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: event,
          BASE_SHA: baseSha,
          HEAD_SHA: headSha,
          INPUT_WORKSPACES: 'bayn: ["", "services/bayn"]\nlanding: ["", "apps/landing"]',
          INPUT_FILTERS: 'bayn: ["bun.lock"]\nlanding: ["bun.lock"]',
          INPUT_ONLY_PATHS: '["tools/**", "docs/**"]',
          INPUT_WORKFLOW: '',
          INPUT_DEPENDENCY_AWARE_PUSH: dependencyAwarePush,
          GITHUB_OUTPUT: output,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const [affected, onlyPaths] = readFileSync(output, 'utf8').trim().split('\n')
      return {
        affected: JSON.parse(text(affected).slice('affected='.length)),
        onlyPaths: text(onlyPaths),
      }
    }
    expect(run('pull_request', base)).toEqual({
      affected: { bayn: false, landing: true },
      onlyPaths: 'only_paths=false',
    })
    expect(run('push', base).affected).toEqual({ bayn: true, landing: true })
    expect(run('push', initial, 'true').affected).toEqual({ bayn: false, landing: true })
    expect(run('push', base, 'true').affected).toEqual({ bayn: true, landing: true })
    expect(() => run('push', initial, 'typo')).toThrow()
    expect(run('workflow_dispatch', '')).toEqual({
      affected: { bayn: true, landing: true },
      onlyPaths: 'only_paths=false',
    })
    expect(() => changedRange('pull_request', '', head)).toThrow('valid nonzero')

    git('checkout', '-b', 'offline', initial)
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs/notes.md'), '# Offline notes\n')
    const docs = commit(before)
    expect(run('pull_request', base, 'false', docs).onlyPaths).toBe('only_paths=true')
    expect(run('push', initial, 'false', docs).onlyPaths).toBe('only_paths=false')
    expect(run('pull_request', docs, 'false', docs).onlyPaths).toBe('only_paths=false')
    mkdirSync(join(dir, ' docs'))
    writeFileSync(join(dir, ' docs/outside.md'), '# Outside the allowlist\n')
    expect(run('pull_request', base, 'false', commit(before)).onlyPaths).toBe('only_paths=false')
    git('rm', ' docs/outside.md')
    mkdirSync(join(dir, 'tools'))
    git('mv', 'src/source.ts', 'tools/source.ts')
    expect(run('pull_request', base, 'false', commit(before)).onlyPaths).toBe('only_paths=false')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Bayn selects fast checks only for offline PRs and retains full and independent validation', () => {
  const workflow: unknown = Bun.YAML.parse(readFileSync('.github/workflows/bayn-ci.yml', 'utf8'))
  const changes = property(property(workflow, 'jobs'), 'changes')
  const steps = property(changes, 'steps')
  if (!Array.isArray(steps)) throw new Error('Missing Bayn change detection')
  const inputs = property(
    steps.find((step) => property(step, 'id') === 'filter'),
    'with',
  )
  const targets = parseTargets(
    text(property(inputs, 'workspaces')),
    text(property(inputs, 'filters')),
    '',
    'pull_request',
  )
  const lock = Bun.JSONC.parse(readFileSync('bun.lock', 'utf8'))
  const onlyPaths: unknown = Bun.YAML.parse(text(property(inputs, 'only-paths')))
  if (!Array.isArray(onlyPaths)) throw new Error('Missing Bayn fast path allowlist')
  const outputNames = ['fast', 'full', 'pr_checks', 'formal', 'gepa']
  const selected = (paths: string[], event = 'pull_request') => {
    const outputs =
      event === 'pull_request'
        ? {
            affected: JSON.stringify(selectAffectedInputs(paths, targets, lock, lock)),
            only_paths: String(matchesOnlyPaths(paths, onlyPaths.map(text))),
          }
        : {}
    return outputNames.filter((key) => {
      const expression = text(property(property(changes, 'outputs'), key)).replace(/^\s*\$\{\{|\}\}\s*$/g, '')
      return runInNewContext(expression, {
        fromJSON: JSON.parse,
        github: { event_name: event },
        steps: { filter: { outputs } },
      })
    })
  }
  const full = ['full', 'pr_checks', 'formal', 'gepa']
  const docs = 'docs/bayn/test-suite-audit-2026-11-27.md'
  const tool = 'services/bayn/tools/research-10yr-pure-etf-dual-horizon.ts'
  for (const paths of [[docs], [tool], [docs, tool], ['services/bayn/tools/native-arrival-coverage.md']])
    expect(selected(paths)).toEqual(['fast'])
  for (const event of ['merge_group', 'workflow_dispatch', 'push']) expect(selected([tool], event)).toEqual(full)

  for (const path of [
    'services/bayn/src/execution/controller.ts',
    'services/bayn/src/risk.test.ts',
    'services/bayn/src/system-assessment/README.md',
    'services/bayn/migrations/20261106-cost-evidence.sql',
    'argocd/applications/bayn/research-networkpolicy.yaml',
    'argocd/applications/bayn/postgres-monitoring.yaml',
    'argocd/applications/bayn/README.md',
    '.github/workflows/bayn-ci.yml',
    '.github/workflows/bayn-formal.yml',
    '.github/workflows/common-monorepo.yml',
    'argocd/applications/torghut/clickhouse/schema/historical-datasets.sql',
    'nix/images/bayn.nix',
    'services/bayn/tools/compile-frozen-control.ts',
    'services/bayn/tools/test-postgres.ts',
    'services/bayn/tools/test-ledger.ts',
    'services/bayn/tools/retire-broker-polls.integration.test.ts',
    'services/bayn/tools/run-macro-etf-core-rebalance.ts',
    ...baynPostgresTestHelpers,
    'docs/bayn/jev-migration-acceptance-v2.json',
  ]) {
    expect(selected([path])).toEqual(full)
    expect(selected([docs, tool, path])).toEqual(full)
  }
  for (const path of ['nix/ci-run-timed.sh', 'apps/landing/src/index.ts', 'bun.lock'])
    expect(selected([docs, path])).toEqual(full)

  for (const path of [
    'services/bayn/formal/Bayn/Reliability.lean',
    'services/bayn/formal/tla/Controller.tla',
    'services/bayn/formal/conformance/economics.test.ts',
  ])
    expect(selected([path])).toEqual(['formal'])
  for (const path of ['packages/scripts/src/bayn/verify-egress-proxy-restart.sh', 'packages/scripts/package.json'])
    expect(selected([path])).toEqual(['pr_checks'])
  for (const path of ['apps/landing/src/index.ts', 'services/bayn/formal/tla/README.md', 'services/dorvud/README.md'])
    expect(selected([path])).toEqual([])
  expect(selected([])).toEqual([])
  expect(selected(['services/bayn/gepa/runner.py'])).toEqual(['pr_checks', 'gepa'])
})

test('Bayn publication still watches runtime rather than test or offline inputs', () => {
  const publication: unknown = Bun.YAML.parse(readFileSync('.github/workflows/bayn-build-push.yml', 'utf8'))
  const paths = property(property(property(publication, 'on'), 'push'), 'paths')
  if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string'))
    throw new Error('Missing publication paths')
  for (const path of [
    'services/bayn/formal/Bayn/Reliability.lean',
    'services/bayn/formal/tla/Controller.tla',
    'services/bayn/formal/conformance/economics.test.ts',
    'services/bayn/README.md',
    'services/bayn/tools/macro-canary-runner/README.md',
    'services/bayn/tools/benchmark-forward-performance.md',
    'services/bayn/AGENTS.md',
    'services/bayn/.gitignore',
    'services/bayn/tools/research-10yr-pure-etf-dual-horizon.ts',
    'services/bayn/tools/research-sip-momentum-data.ts',
    'services/bayn/src/jev/entry-economics.test.ts',
    'services/bayn/src/jev/native.test-support.ts',
    'services/bayn/src/testing/streaming-market-fixture.ts',
    'services/bayn/tools/test-postgres.ts',
    'services/bayn/tools/test-ledger.ts',
    'services/bayn/tools/ci-unit-timings.json',
    'services/bayn/tools/verify-image-metadata.ts',
    'packages/scripts/src/bayn/market-data-replay-ci.test.ts',
    'packages/scripts/src/bayn/verify-research-commands.sh',
  ])
    expect(matchesPaths(path, paths)).toBe(false)
  expect(matchesPaths('services/bayn/src/execution/controller.ts', paths)).toBe(true)
  for (const path of [
    'services/bayn/src/jev/entry-economics.ts',
    'services/bayn/migrations/20261106-cost-evidence.sql',
    'services/bayn/tools/compile-frozen-control.ts',
    'services/bayn/tools/record-jev-compiler-dependencies.ts',
    'services/bayn/tools/equity-edge-screen.ts',
    'services/bayn/src/research-command.ts',
    'services/bayn/gepa/native.py',
    'services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/BrokerFeedMain.kt',
    'docs/bayn/jev-migration-acceptance-v2.json',
    'services/bayn/package.json',
    'nix/images/bayn.nix',
    'argocd/applications/bayn/configmap.yaml',
    'bun.lock',
  ])
    expect(['services/bayn/README.md', path].some((changed) => matchesPaths(changed, paths))).toBe(true)
})

test.each([
  'bumba-ci.yml',
  'oirat-ci.yml',
  'froussard-ci.yml',
  'signal-publisher-build-push.yml',
  'product-nix-images.yml',
])('%s gives shared verifier changes one native App owner', (filename) => {
  const workflow = Bun.YAML.parse(readFileSync(`.github/workflows/${filename}`, 'utf8'))
  const steps = property(property(property(workflow, 'jobs'), 'changes'), 'steps')
  if (!Array.isArray(steps)) throw new Error('Missing planner steps')
  const inputs = property(
    steps.find((step) => property(step, 'id') === 'filter'),
    'with',
  )
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
  const lock = { ...before, workspaces: { ...workspaces, ...before.workspaces } }
  const plan = selectAffectedInputs(['nix/check-bun-dependency-closure.sh'], configured, lock, lock)
  expect(Object.keys(plan).filter((name) => plan[name])).toEqual(
    filename === 'product-nix-images.yml' ? ['app_dependencies'] : [],
  )
  expect(
    Object.values(selectAffectedInputs(['nix/images/bun-workspace-service.nix'], configured, lock, lock)).some(Boolean),
  ).toBe(true)
})
