import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { releasePlan } from './release-inputs'

const fixtures: string[] = []
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'restate-release-inputs-'))
  fixtures.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const write = (path: string, value: string) => {
    mkdirSync(join(cwd, path, '..'), { recursive: true })
    writeFileSync(join(cwd, path), value)
  }
  const workflow = {
    jobs: {
      build: {
        steps: ['Prove metadata writes and cold-peer elections', 'Build runtime'].map((name) => ({
          name,
          uses: 'docker/build-push-action@v6',
          with: { context: 'services/restate', platforms: 'linux/amd64' },
        })),
      },
    },
  }
  git('init', '--quiet')
  git('config', 'user.name', 'Restate test')
  git('config', 'user.email', 'restate-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  const commit = (message = 'fixture') => {
    git('add', '.')
    git('commit', '--quiet', '-m', message)
  }
  write('.github/workflows/restate-images.yml', YAML.stringify(workflow))
  write('services/restate/Dockerfile', 'FROM scratch\n')
  commit()
  const source = git('rev-parse', 'HEAD')
  write(
    'argocd/applications/restate/kustomization.yaml',
    YAML.stringify({
      images: [
        {
          name: 'restate-runtime',
          newName: 'registry.ide-newton.ts.net/lab/restate',
          digest: `sha256:${'a'.repeat(64)}`,
        },
      ],
    }),
  )
  commit(`kargo(restate): promote fixture\n\nSource commit: ${source}\nBuild run: 123`)
  git('update-ref', 'refs/remotes/origin/kargo/restate', 'HEAD')
  return { cwd, git, write, commit, workflow }
}

test('configuration changes reuse the qualified runtime', () => {
  const f = fixture()
  f.write('argocd/applications/restate/statefulset.yaml', 'storageClassName: local-path\n')
  f.commit()
  expect(releasePlan(f.cwd)).toMatchObject({ reuse: true, run: '123', digest: `sha256:${'a'.repeat(64)}` })
})

test.each(['Dockerfile', 'metadata-background.patch', 'tests/fault.rs'])(
  'changed runtime input %s requires a build',
  (file) => {
    const f = fixture()
    f.write(`services/restate/${file}`, 'changed\n')
    f.commit()
    expect(releasePlan(f.cwd).reuse).toBe(false)
  },
)

test('new build parameters require a build', () => {
  const f = fixture()
  const changed = structuredClone(f.workflow)
  Object.assign(changed.jobs.build.steps[1]?.with ?? {}, { 'build-args': 'FEATURE=new' })
  f.write('.github/workflows/restate-images.yml', YAML.stringify(changed))
  f.commit()
  expect(releasePlan(f.cwd).reuse).toBe(false)
})

test('release labels and cache destinations do not change runtime inputs', () => {
  const f = fixture()
  Object.assign(f.workflow.jobs.build.steps[1]?.with ?? {}, {
    labels: 'revision=new',
    'cache-to': 'type=gha,scope=new',
  })
  f.write('.github/workflows/restate-images.yml', YAML.stringify(f.workflow))
  f.commit()
  expect(releasePlan(f.cwd).reuse).toBe(true)
})

test('an unqualified Kargo baseline fails closed', () => {
  const f = fixture()
  f.write('argocd/applications/restate/kustomization.yaml', 'images: []\n')
  f.commit('invalid baseline')
  f.git('update-ref', 'refs/remotes/origin/kargo/restate', 'HEAD')
  expect(() => releasePlan(f.cwd)).toThrow('qualified Restate release')
})
