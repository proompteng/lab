import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
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
const tengriPublisherPath = '.github/workflows/tengri-images.yml'
const baynPostgresTestHelpers = [
  ['services/bayn/src/testing/postgres-template.test-support.ts', true],
  ['services/bayn/tools/postgres-file-preload.ts', false],
  ['services/bayn/tools/postgres-test-databases.ts', false],
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
    const helpers = baynPostgresTestHelpers.map(([path]) => path)
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
  for (const [helper] of baynPostgresTestHelpers)
    expect(selected(validation, 'pull_request', 'refs/pull/42/merge', helper)).toBe(false)
})

test('Bayn CI does not run trading qualification for orchestration and documentation changes', () => {
  const workflow: unknown = Bun.YAML.parse(readFileSync('.github/workflows/bayn-ci.yml', 'utf8'))
  const steps = property(property(property(workflow, 'jobs'), 'changes'), 'steps')
  if (!Array.isArray(steps)) throw new Error('Missing Bayn planner')
  const filters: unknown = Bun.YAML.parse(
    text(
      property(
        property(
          steps.find((step) => property(step, 'id') === 'filter'),
          'with',
        ),
        'filters',
      ),
    ),
  )
  const paths = property(filters, 'bayn')
  if (!Array.isArray(paths)) throw new Error('Missing Bayn validation inputs')
  for (const file of [
    'services/bayn/README.md',
    'argocd/applications/bayn/README.md',
    '.github/workflows/bayn-ci.yml',
    '.github/workflows/bayn-build-push.yml',
    '.github/workflows/common-monorepo.yml',
    '.github/workflows/nix-oci-build-common.yml',
    '.github/actions/setup-nix-toolchain/action.yml',
    'nix/cache-push.sh',
    'nix/ci-run-timed.sh',
    'nix/oci-push.sh',
    'nix/images/opencode-cli.nix',
  ])
    expect(matchesPaths(file, paths.map(text))).toBe(false)
  expect(matchesPaths('services/bayn/src/runtime.ts', paths.map(text))).toBe(true)
  expect(matchesPaths('nix/images/bayn.nix', paths.map(text))).toBe(true)
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

test('Bayn retains a pending production push when a later manifest-only push skips publication', () => {
  const workflowPath = '.github/workflows/bayn-build-push.yml'
  const workflow: unknown = Bun.YAML.parse(readFileSync(workflowPath, 'utf8'))
  const configured = parseTargets("image: ['', 'services/bayn']", '', workflowPath, 'push')
  const paths = configured.image?.paths
  if (paths === undefined) throw new Error('Missing Bayn publication inputs')
  const lock = {
    ...before,
    workspaces: { ...before.workspaces, 'apps/froussard': { name: 'froussard', dependencies: {} } },
  }
  const productionPush = ['services/bayn/src/jev/runtime.ts']
  const laterManifestPush = ['apps/froussard/package.json']
  expect(productionPush.some((file) => matchesPaths(file, paths))).toBe(true)
  expect(laterManifestPush.some((file) => matchesPaths(file, paths))).toBe(true)
  expect(selectAffectedInputs(productionPush, configured, lock, lock).image).toBe(true)
  expect(selectAffectedInputs(laterManifestPush, configured, lock, lock).image).toBe(false)
  // Both pushes enter concurrency before selection; the skipped successor must retain the pending production run.
  expect(property(workflow, 'concurrency')).toEqual({
    group: '${{ github.workflow }}-main',
    'cancel-in-progress': false,
    queue: 'max',
  })
})

test('Bayn queue lint compatibility is limited to its exact unsupported-key diagnostic', () => {
  const config: unknown = Bun.YAML.parse(readFileSync('.github/actionlint.yaml', 'utf8'))
  const path = '.github/workflows/bayn-build-push.yml'
  const workflow: unknown = Bun.YAML.parse(readFileSync(path, 'utf8'))
  const declarations: string[] = []
  const visit = (value: unknown, ancestors: string[]) => {
    if (typeof value !== 'object' || value === null) return
    for (const [key, child] of Object.entries(value)) {
      const location = [...ancestors, key]
      if (key === 'concurrency' || key === 'queue') declarations.push(location.join('.'))
      visit(child, location)
    }
  }
  visit(workflow, [])
  // The parser exception must not hide an invalid nested queue or job-level concurrency.
  expect(declarations).toEqual(['concurrency', 'concurrency.queue'])
  const scopes = property(config, 'paths')
  if (typeof scopes !== 'object' || scopes === null) throw new Error('Missing actionlint file scopes')
  expect(Object.keys(scopes).filter((scope) => matchesGlob(path, scope))).toEqual([path])
  expect(matchesGlob('.github/workflows/opencode-build-push.yml', path)).toBe(false)
  expect(property(config, 'ignore')).toBeUndefined()
  const pattern = String.raw`^unexpected key "queue" for "concurrency" section\. expected one of "cancel-in-progress", "group"$`
  expect(property(property(scopes, path), 'ignore')).toEqual([pattern])
  const ignored = new RegExp(pattern)
  expect(
    ignored.test('unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"'),
  ).toBe(true)
  expect(
    ignored.test('unexpected key "bogus" for "concurrency" section. expected one of "cancel-in-progress", "group"'),
  ).toBe(false)
  expect(ignored.test('unexpected key "queue" for "job" section. expected one of "name", "runs-on"')).toBe(false)
  expect(ignored.test('property "unknown" is not defined in object type')).toBe(false)
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
    const initial = commit(before)
    const head = commit(after)
    git('checkout', '-b', 'base', initial)
    const base = commit({ ...before, configVersion: 0 })
    const run = (event: string, baseSha: string, dependencyAwarePush = 'false') => {
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
          INPUT_DEPENDENCY_AWARE_PUSH: dependencyAwarePush,
          GITHUB_OUTPUT: output,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return JSON.parse(readFileSync(output, 'utf8').trim().slice('affected='.length))
    }
    expect(run('pull_request', base)).toEqual({ bayn: false, landing: true })
    expect(run('push', base)).toEqual({ bayn: true, landing: true })
    expect(run('push', initial, 'true')).toEqual({ bayn: false, landing: true })
    expect(run('push', base, 'true')).toEqual({ bayn: true, landing: true })
    expect(() => run('push', initial, 'typo')).toThrow()
    expect(run('workflow_dispatch', '')).toEqual({ bayn: true, landing: true })
    expect(() => changedRange('pull_request', '', head)).toThrow('valid nonzero')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Bayn separates formal checks from runtime validation and publication', () => {
  const workflow: unknown = Bun.YAML.parse(readFileSync('.github/workflows/bayn-ci.yml', 'utf8'))
  const steps = property(property(property(workflow, 'jobs'), 'changes'), 'steps')
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
  const lock = { ...before, workspaces: { ...before.workspaces, 'packages/scripts': { name: 'scripts' } } }
  for (const path of [
    'services/bayn/formal/Bayn/Reliability.lean',
    'services/bayn/formal/tla/Controller.tla',
    'services/bayn/formal/conformance/economics.test.ts',
    '.github/workflows/bayn-formal.yml',
  ])
    expect(selectAffectedInputs([path], targets, lock, lock)).toEqual({ bayn: false, gepa: false, formal: true })
  expect(selectAffectedInputs(['services/bayn/src/execution/controller.ts'], targets, lock, lock)).toEqual({
    bayn: true,
    gepa: false,
    formal: true,
  })
  expect(selectAffectedInputs(['argocd/applications/bayn/configmap.yaml'], targets, lock, lock)).toEqual({
    bayn: true,
    gepa: false,
    formal: false,
  })
  expect(selectAffectedInputs(['apps/landing/src/index.ts'], targets, lock, lock)).toEqual({
    bayn: false,
    gepa: false,
    formal: false,
  })
  for (const path of ['services/bayn/src/risk.test.ts', 'services/bayn/tools/history.test.ts'])
    expect(selectAffectedInputs([path], targets, lock, lock)).toEqual({ bayn: true, formal: false, gepa: false })
  for (const [path, formal] of baynPostgresTestHelpers)
    expect(selectAffectedInputs([path], targets, lock, lock)).toEqual({ bayn: true, formal, gepa: false })
  expect(selectAffectedInputs(['services/bayn/gepa/runner.py'], targets, lock, lock)).toEqual({
    bayn: true,
    formal: false,
    gepa: true,
  })
  for (const path of [
    'services/bayn/src/db/entry-inference-postgres.integration.test.ts',
    'services/bayn/src/system-assessment/postgres.integration.test.ts',
    'services/bayn/src/db/risk-clock-rejection.integration.test.ts',
    'services/bayn/src/db/candidate-observation-window.integration.test.ts',
  ])
    expect(selectAffectedInputs([path], targets, lock, lock).formal).toBe(true)
  const publication: unknown = Bun.YAML.parse(readFileSync('.github/workflows/bayn-build-push.yml', 'utf8'))
  const paths = property(property(property(publication, 'on'), 'push'), 'paths')
  if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string'))
    throw new Error('Missing publication paths')
  for (const path of [
    'services/bayn/formal/Bayn/Reliability.lean',
    'services/bayn/formal/tla/Controller.tla',
    'services/bayn/formal/conformance/economics.test.ts',
    'services/bayn/README.md',
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
    'services/bayn/package.json',
    'nix/images/bayn.nix',
    'argocd/applications/bayn/configmap.yaml',
    'bun.lock',
  ])
    expect(['services/bayn/README.md', path].some((changed) => matchesPaths(changed, paths))).toBe(true)
  expect(
    selectAffectedInputs(['services/bayn/README.md', 'argocd/applications/bayn/README.md'], targets, lock, lock),
  ).toEqual({
    bayn: false,
    gepa: false,
    formal: false,
  })
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
