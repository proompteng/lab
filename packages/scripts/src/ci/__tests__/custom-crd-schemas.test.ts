import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const root = resolve(import.meta.dir, '../../../../..')
const schemaDir = resolve(root, 'schemas/custom')
const agentsCrdDir = resolve(root, 'charts/agents/crds')
const kubeconformScript = resolve(root, 'scripts/kubeconform.sh')
const schemaPaths = new Set(new Bun.Glob('**/*.json').scanSync({ cwd: schemaDir }))
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

test('custom schemas use only the full group, version and lowercase kind', () => {
  expect(schemaPaths.size).toBeGreaterThan(0)
  for (const path of schemaPaths) {
    // apps and batch are native schema overrides, not shortened CRD groups.
    expect(path).toMatch(/^(?:apps|batch|[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+)\/[a-z0-9-]+\/[a-z][a-z0-9]*\.json$/)
  }
  expect(schemaPaths).toContain('argoproj.io/v1alpha1/workflowtemplate.json')
})

test('every Agents CRD has a schema at the path kubeconform resolves', () => {
  for (const path of new Bun.Glob('*.yaml').scanSync({ cwd: agentsCrdDir })) {
    const { spec } = parse(readFileSync(resolve(agentsCrdDir, path), 'utf8'))
    for (const { name } of spec.versions) {
      expect(schemaPaths).toContain(`${spec.group}/${name}/${spec.names.kind.toLowerCase()}.json`)
    }
  }
})

test('kubeconform uses one custom schema lookup and skips only explicit GVKs without schemas', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'kubeconform-'))
  cleanups.push(() => rm(fixture, { force: true, recursive: true }))

  const bin = join(fixture, 'bin')
  const manifests = join(fixture, 'manifests')
  const capture = join(fixture, 'kubeconform-args')
  await mkdir(bin)
  await mkdir(manifests)

  const fakeKubeconform = join(bin, 'kubeconform')
  const fakeYq = join(bin, 'yq')
  await writeFile(fakeKubeconform, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$KUBECONFORM_CAPTURE"\n')
  await writeFile(fakeYq, '#!/usr/bin/env bash\nexit 0\n')
  await Promise.all([chmod(fakeKubeconform, 0o755), chmod(fakeYq, 0o755)])

  await Promise.all([
    writeFile(
      join(manifests, 'kustomization.yaml'),
      'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n',
    ),
    writeFile(
      join(manifests, 'kustomizeconfig.yaml'),
      'nameReference:\n  - kind: ConfigMap\n    fieldSpecs:\n      - path: data/NANOAGENT_IMAGE\n',
    ),
    writeFile(join(manifests, 'kustomizeconfig.yml'), 'varReference:\n  - kind: Secret\n    path: stringData/TOKEN\n'),
    writeFile(join(manifests, 'deployment.yaml'), 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: demo\n'),
  ])

  const result = Bun.spawnSync(['/bin/bash', kubeconformScript, manifests], {
    cwd: fixture,
    env: {
      ...process.env,
      KUBECONFORM_CACHE_DIR: join(fixture, 'cache'),
      KUBECONFORM_CAPTURE: capture,
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
  })

  expect(result.exitCode).toBe(0)
  const args = (await readFile(capture, 'utf8')).trimEnd().split('\n')
  expect(args.filter((_, index) => args[index - 1] === '--schema-location')).toEqual([
    join(schemaDir, '{{.Group}}/{{.ResourceAPIVersion}}/{{.ResourceKind}}.json'),
    'default',
  ])
  expect(args).not.toContain('--ignore-missing-schemas')
  const skipped = (args[args.indexOf('--skip') + 1] ?? '').split(',')
  expect(skipped).toContain('serving.knative.dev/v1/Service')
  for (const gvk of skipped) {
    expect(gvk).toContain('/')
    expect(schemaPaths).not.toContain(`${gvk.toLowerCase()}.json`)
  }
  expect(args).toContain(join(manifests, 'deployment.yaml'))
  expect(args).not.toContain(join(manifests, 'kustomization.yaml'))
  expect(args).not.toContain(join(manifests, 'kustomizeconfig.yaml'))
  expect(args).not.toContain(join(manifests, 'kustomizeconfig.yml'))
})
