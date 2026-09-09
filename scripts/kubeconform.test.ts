import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const kubeconformScript = resolve(import.meta.dir, 'kubeconform.sh')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

test('does not submit Kustomize configuration metadata to kubeconform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kubeconform-'))
  cleanups.push(() => rm(root, { force: true, recursive: true }))

  const bin = join(root, 'bin')
  const manifests = join(root, 'manifests')
  const capture = join(root, 'kubeconform-args')
  await mkdir(bin, { recursive: true })
  await mkdir(manifests, { recursive: true })

  const fakeKubeconform = join(bin, 'kubeconform')
  const fakeYq = join(bin, 'yq')
  await writeFile(fakeKubeconform, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$KUBECONFORM_CAPTURE"\n', 'utf8')
  await writeFile(fakeYq, '#!/usr/bin/env bash\nexit 0\n', 'utf8')
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
    env: {
      ...process.env,
      KUBECONFORM_CACHE_DIR: join(root, 'cache'),
      KUBECONFORM_CAPTURE: capture,
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })

  expect(result.exitCode).toBe(0)
  const args = await readFile(capture, 'utf8')
  expect(args).toContain(join(manifests, 'deployment.yaml'))
  expect(args).not.toContain(join(manifests, 'kustomizeconfig.yaml'))
  expect(args).not.toContain(join(manifests, 'kustomizeconfig.yml'))
})
