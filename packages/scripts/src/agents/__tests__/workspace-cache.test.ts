import { mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const app = join(import.meta.dir, '../../../../../argocd/applications/agents')
const readYaml = (file: string) => YAML.parse(readFileSync(join(app, file), 'utf8'))

describe('Agents workspace cache', () => {
  it('schedules a bounded writer only on the two build nodes', () => {
    const daemonSet = readYaml('workspace-cache-daemonset.yaml')
    expect(daemonSet.kind).toBe('DaemonSet')
    const pod = daemonSet.spec.template.spec
    expect(pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms).toEqual([
      {
        matchExpressions: [
          { key: 'kubernetes.io/hostname', operator: 'In', values: ['turin', 'talos-192-168-1-85'] },
          { key: 'kubernetes.io/hostname', operator: 'NotIn', values: ['talos-192-168-1-194'] },
        ],
      },
    ])
    expect(pod.automountServiceAccountToken).toBe(false)
    expect(pod.volumes).toContainEqual({
      name: 'workspace-cache',
      hostPath: { path: '/var/lib/agents-workspace-cache', type: 'DirectoryOrCreate' },
    })
    const [refresh] = pod.containers
    expect(refresh.resources).toEqual({
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { cpu: '1', memory: '2Gi' },
    })
    expect(refresh.env).toContainEqual({
      name: 'GITHUB_TOKEN',
      valueFrom: { secretKeyRef: { name: 'github-token', key: 'token' } },
    })
    expect(refresh.volumeMounts).toContainEqual({ name: 'workspace-cache', mountPath: '/var/cache/agents-shared' })
    expect(refresh.readinessProbe.exec.command.at(-1)).toContain('.refreshed')
    expect(refresh.args[0]).toContain('300 - (SECONDS - started)')
  })

  it('renders the writer with the promoted runner image and rolls it on script changes', () => {
    const kustomization = readYaml('kustomization.yaml')
    expect(kustomization.resources).toContain('workspace-cache-daemonset.yaml')
    expect(kustomization.configMapGenerator).toContainEqual({
      name: 'agents-workspace-cache-refresh',
      files: ['refresh.sh=workspace-cache-refresh.sh'],
    })
    expect(kustomization.replacements).toContainEqual({
      source: {
        kind: 'Deployment',
        name: 'agents-controllers',
        fieldPath: 'spec.template.spec.containers.0.env.[name=AGENTS_AGENT_RUNNER_IMAGE].value',
      },
      targets: [
        {
          select: { kind: 'DaemonSet', name: 'agents-workspace-cache' },
          fieldPaths: ['spec.template.spec.containers.[name=refresh].image'],
        },
      ],
    })
    const values = readYaml('values.yaml')
    expect(values.controllers.env.vars.AGENTS_AGENT_RUNNER_SHARED_CACHE_HOST_PATH).toBe(
      '/var/lib/agents-workspace-cache',
    )
    expect(values.controllers.env.vars.AGENTS_DB_POOL_MAX).toBe('24')
    const productApplicationSet = YAML.parse(readFileSync(join(app, '../../applicationsets/product.yaml'), 'utf8')) as {
      spec: {
        generators: Array<{
          matrix: {
            generators: Array<{
              list?: {
                elements?: Array<{
                  name?: string
                  managedNamespaceMetadata?: { labels?: Record<string, string> }
                }>
              }
            }>
          }
        }>
      }
    }
    const agentsApp = productApplicationSet.spec.generators[0]?.matrix.generators[1]?.list?.elements?.find(
      (element) => element.name === 'agents',
    )
    expect(agentsApp?.managedNamespaceMetadata?.labels?.['pod-security.kubernetes.io/enforce']).toBe('privileged')
  })

  it('publishes fetched and pruned refs, and keeps the previous snapshots on refresh failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-workspace-cache-'))
    try {
      const upstream = join(dir, 'upstream')
      const root = join(dir, 'cache')
      const mirror = join(root, 'git/proompteng/lab.git')
      const cache = join(root, 'bun-cache')
      const globalGit = join(dir, 'gitconfig')
      const env = {
        ...process.env,
        BUN_INSTALL_CACHE_DIR: join(dir, 'runner-image-default-cache'),
        GIT_CONFIG_GLOBAL: globalGit,
        TMPDIR: dir,
        GITHUB_TOKEN: 'fixture-token',
      }
      const run = (argv: string[], cwd = upstream) => Bun.spawnSync(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
      const ok = (argv: string[], cwd?: string) => {
        const result = run(argv, cwd)
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        return result.stdout.toString().trim()
      }
      const refresh = ['bash', join(app, 'workspace-cache-refresh.sh'), root]
      const routeTo = (path: string) =>
        writeFileSync(globalGit, `[url "file://${path}"]\n  insteadOf = https://github.com/proompteng/lab.git\n`)
      const commit = (message: string) => {
        ok(['git', 'add', 'package.json', 'services', 'patches', 'bun.lock'])
        ok(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message])
      }

      mkdirSync(join(upstream, 'services/memories'), { recursive: true })
      mkdirSync(join(upstream, 'services/contracts'))
      mkdirSync(join(upstream, 'patches'))
      mkdirSync(join(dir, 'package'))
      writeFileSync(join(dir, 'package/package.json'), '{"name":"cached-fixture","version":"1.0.0"}')
      ok(['tar', '-czf', join(upstream, 'patches/fixture.tgz'), '-C', dir, 'package'])
      routeTo(upstream)
      ok(['git', 'init', '-b', 'main'])
      writeFileSync(
        join(upstream, 'package.json'),
        JSON.stringify({ name: 'fixture', workspaces: ['services/*'], scripts: { postinstall: 'exit 42' } }),
      )
      writeFileSync(
        join(upstream, 'services/memories/package.json'),
        JSON.stringify({
          name: 'memories',
          dependencies: { contracts: 'workspace:*', 'cached-fixture': 'file:../../patches/fixture.tgz' },
        }),
      )
      const contracts = join(upstream, 'services/contracts/package.json')
      writeFileSync(contracts, JSON.stringify({ name: 'contracts', version: '1.0.0' }))
      const install = ['bun', 'install', '--ignore-scripts', '--filter', 'memories']
      ok(install)
      commit('initial')
      ok(['git', 'branch', 'retired'])
      ok(refresh)

      const firstMirror = readlinkSync(mirror)
      const firstCache = readlinkSync(cache)
      const firstKey = readFileSync(join(cache, '.key'), 'utf8')
      expect(readdirSync(cache)).toContain('cached-fixture')
      expect(ok(['git', '--git-dir', mirror, 'rev-parse', '--is-bare-repository'])).toBe('true')
      expect(ok(['git', '--git-dir', mirror, 'config', '--local', 'remote.origin.url'])).toBe(
        'https://github.com/proompteng/lab.git',
      )
      expect(readFileSync(join(mirror, 'config'), 'utf8')).not.toContain('extraHeader')
      expect(ok(['git', '--git-dir', mirror, 'rev-parse', 'refs/heads/retired'])).toBe(ok(['git', 'rev-parse', 'HEAD']))

      ok(['git', 'branch', '-D', 'retired'])
      ok(refresh)
      const secondMirror = readlinkSync(mirror)
      expect(secondMirror).not.toBe(firstMirror)
      expect(run(['git', '--git-dir', mirror, 'rev-parse', '--verify', 'refs/heads/retired']).exitCode).not.toBe(0)
      expect(readlinkSync(cache)).toBe(firstCache)

      routeTo(join(dir, 'missing-upstream'))
      expect(run(refresh).exitCode).not.toBe(0)
      expect(readlinkSync(mirror)).toBe(secondMirror)
      expect(readlinkSync(cache)).toBe(firstCache)
      routeTo(upstream)

      writeFileSync(contracts, JSON.stringify({ name: 'contracts', version: '2.0.0' }))
      ok(install)
      commit('new lock')
      ok(refresh)
      const secondCache = readlinkSync(cache)
      expect(secondCache).not.toBe(firstCache)
      expect(readFileSync(join(cache, '.key'), 'utf8')).not.toBe(firstKey)
      expect(ok(['git', '--git-dir', mirror, 'rev-parse', 'refs/heads/main'])).toBe(ok(['git', 'rev-parse', 'HEAD']))

      writeFileSync(join(upstream, 'bun.lock'), 'invalid lockfile')
      commit('broken lock')
      expect(run(refresh).exitCode).not.toBe(0)
      expect(readlinkSync(cache)).toBe(secondCache)
      expect(
        readdirSync(root)
          .filter((name) => name.startsWith('bun-cache.'))
          .sort(),
      ).toEqual(['bun-cache.0', 'bun-cache.1'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
