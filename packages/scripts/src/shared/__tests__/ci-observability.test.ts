import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import YAML from 'yaml'
import { imageWorkflowCatalog, imageWorkflows, repoRoot } from '../../ci/generate-observability-workflows'

describe('CI build observability', () => {
  test('enrolls every image builder and its reusable workflow callers', () => {
    const catalog: unknown = JSON.parse(
      readFileSync(resolve(repoRoot, 'argocd/applications/observability/ci/workflows.json'), 'utf8'),
    )
    const discovered = imageWorkflows(repoRoot)
    expect(discovered).toContain('temporal-worker-images.yml')
    expect(discovered).toContain('symphony-build-push.yaml')
    expect(discovered).toContain('arc-runner-build-push.yml')
    expect(discovered).not.toContain('semantic-pull-request.yml')
    expect(catalog).toEqual(imageWorkflowCatalog(repoRoot))
  })

  test('preserves attempt identity, timing and durable delivery behavior', () => {
    const result = Bun.spawnSync(
      [
        'python3',
        '-m',
        'unittest',
        'discover',
        '-s',
        'argocd/applications/observability/ci',
        '-p',
        'test_collector.py',
      ],
      { cwd: repoRoot },
    )
    expect({ exitCode: result.exitCode, output: result.stderr.toString() }).toEqual({
      exitCode: 0,
      output: expect.stringContaining('OK'),
    })
  })

  test('retains static suffixes that distinguish dynamic matrix job names', () => {
    const families = imageWorkflowCatalog(repoRoot)['kata-firecracker-extension.yaml']
    if (!families) throw new Error('Kata workflow is missing from enrollment')
    const match = (name: string) =>
      families.filter((family) => new RegExp(family.pattern).test(name)).map((family) => family.id)
    expect(match('Build amd64 extension')).toEqual(['build'])
    expect(match('Build cloud-hypervisor installer')).toEqual(['installers'])
  })

  test('keeps the provisioned dashboard in sync with its source', () => {
    const result = Bun.spawnSync(['python3', 'argocd/applications/observability/ci/dashboard.py', '--check'], {
      cwd: repoRoot,
    })
    expect({ exitCode: result.exitCode, error: result.stderr.toString() }).toEqual({ exitCode: 0, error: '' })
  })

  test('evaluates alerts and dashboard queries with native Prometheus', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'ci-build-promql-'))
    try {
      const document = YAML.parseDocument(
        readFileSync(resolve(repoRoot, 'argocd/applications/observability/graf-mimir-rules.yaml'), 'utf8'),
      )
      const rules: unknown = document.getIn(['data', 'graf-rules.yaml'])
      if (typeof rules !== 'string') throw new Error('Mimir rule source is missing')
      writeFileSync(resolve(directory, 'rules.yaml'), rules)
      writeFileSync(
        resolve(directory, 'tests.yaml'),
        readFileSync(resolve(repoRoot, 'argocd/applications/observability/tests/ci-build-alerts.yaml'), 'utf8'),
      )
      const generated = Bun.spawnSync(
        [
          'python3',
          '-c',
          'import json,sys; sys.path.insert(0,"argocd/applications/observability/ci"); from dashboard import dashboard; print(json.dumps([t["expr"] for p in dashboard()["panels"] if p["datasource"]["uid"]=="prom" for t in p["targets"]]))',
        ],
        { cwd: repoRoot },
      )
      expect(generated.exitCode).toBe(0)
      const expressions: unknown = JSON.parse(generated.stdout.toString())
      if (!Array.isArray(expressions)) throw new Error('Dashboard queries are not an array')
      const checks = expressions.map((value: unknown, index: number) => {
        if (typeof value !== 'string') throw new Error('Dashboard query is not a string')
        return {
          record: `ci:dashboard_validation_${index}`,
          expr: value
            .replace(/\$(workflow|architecture|runner_pool|job_role|job_family|event|cache_state)/g, '.*')
            .replace(/\$runner_pod/g, 'test-pod'),
        }
      })
      writeFileSync(
        resolve(directory, 'dashboard.json'),
        JSON.stringify({ groups: [{ name: 'dashboard', rules: checks }] }),
      )
      for (const args of [
        ['check', 'rules', 'rules.yaml', 'dashboard.json'],
        ['test', 'rules', 'tests.yaml'],
      ]) {
        const result = Bun.spawnSync([process.env.PROMTOOL ?? 'promtool', ...args], { cwd: directory })
        expect({ exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }).toEqual({
          exitCode: 0,
          output: expect.stringContaining('SUCCESS'),
        })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('validates the Alloy scrape configuration with the native collector', () => {
    const result = Bun.spawnSync(
      [
        process.env.ALLOY ?? 'alloy',
        'validate',
        'argocd/applications/observability/cluster-metrics-alloy-config.river',
      ],
      { cwd: repoRoot },
    )
    expect({ exitCode: result.exitCode, error: result.stderr.toString() }).toEqual({ exitCode: 0, error: '' })
  })

  test('exports valid Prometheus metric types and bounded labels', () => {
    const fixture = Bun.spawnSync(
      [
        'python3',
        '-c',
        'import sys; sys.path.insert(0,"argocd/applications/observability/ci"); from collector import Store,job_record,cache_evidence,timestamp; from test_collector import run,job; s=Store(":memory:"); s.discover(run(),timestamp("2026-10-25T12:35:00Z")); s.save_job(job_record(run(),job()),cache_evidence("")); s.finish(run(),[job()]); print(s.render(timestamp("2026-10-25T12:35:00Z")))',
      ],
      { cwd: repoRoot },
    )
    expect(fixture.exitCode).toBe(0)
    const checked = Bun.spawnSync([process.env.PROMTOOL ?? 'promtool', 'check', 'metrics'], { stdin: fixture.stdout })
    expect({ exitCode: checked.exitCode, output: checked.stdout.toString() + checked.stderr.toString() }).toEqual({
      exitCode: 0,
      output: '',
    })
  })
})
