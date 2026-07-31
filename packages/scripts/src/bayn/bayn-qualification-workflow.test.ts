import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/bayn-qualification.yml', 'utf8')
const image = readFileSync('nix/images/bayn.nix', 'utf8')
const packageManifest = readFileSync('services/bayn/package.json', 'utf8')
const collector = readFileSync('services/bayn/src/qualification-collector-command.ts', 'utf8')
const auditCommand = readFileSync('services/bayn/src/qualification-audit-command.ts', 'utf8')

describe('Bayn qualification workflow collector/executor contract', () => {
  test('stays dormant before any credential, image, database, Signal, or qualification access', () => {
    const dormant = workflow.indexOf('Verify dormant calendar before any privileged access')
    const imageBinding = workflow.indexOf('Bind the exact promoted unpinned qualification image')
    const secretReference = workflow.indexOf('secrets.BAYN_QUALIFICATION_CLICKHOUSE_USERNAME')
    const imagePull = workflow.indexOf('docker pull "$IMAGE_REFERENCE"')

    expect(dormant).toBeGreaterThan(0)
    expect(imageBinding).toBeGreaterThan(dormant)
    expect(secretReference).toBeGreaterThan(imageBinding)
    expect(imagePull).toBeGreaterThan(imageBinding)
    expect(workflow).toContain('nextCandidatePreregistration: null')
    expect(workflow).toContain(
      'No credentials, Signal data, PostgreSQL state, holdout, image, or qualification command were accessed.',
    )
    expect(workflow).toContain("if: steps.calendar.outputs.dormant != 'true'")
  })

  test('binds and executes only the exact promoted unpinned source image', () => {
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('test "$(git rev-parse refs/remotes/origin/main)" = "${GITHUB_SHA}"')
    expect(workflow).toContain('qualification_pin_count')
    expect(workflow).toContain('test "$qualification_pin_count" = 0')
    expect(workflow).toContain('[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]')
    expect(workflow).toContain('image_reference="${image_repository}@${image_digest}"')
    expect(workflow).toContain('docker pull "$IMAGE_REFERENCE"')
    expect(workflow).toContain('jq -e --arg expected "$IMAGE_REFERENCE" \'index($expected) != null\'')
    expect(workflow).toContain('--read-only')
    expect(workflow).toContain('--mount "type=bind,src=${GITHUB_WORKSPACE},dst=/workspace,readonly"')
    expect(workflow).toContain('--entrypoint bayn-qualification-collector')
    expect(workflow).toContain('"$IMAGE_REFERENCE" | tee "$log"')
  })

  test('uses in-process evidence rather than an arbitrary prewritten eligibility file', () => {
    expect(workflow).not.toContain('/run/bayn-qualification/eligibility-input.json')
    expect(workflow).not.toContain('verify-qualification-eligibility.ts')
    expect(collector).toContain('verifyCandidateDevelopmentRepositoryIntegrity')
    expect(collector).toContain('verifyCandidateDevelopmentPreregistrationLineage')
    expect(collector).toContain('validateCandidateDevelopmentPreregistrationDocument')
    expect(collector).toContain('verifyCandidateDevelopmentPreregistrationModuleNovelty')
    expect(collector).toContain('verifyQualificationCandidateImmutableSource')
    expect(collector).toContain('compiledBoundedContentHash')
    expect(collector).toContain('isQualificationSourceAffectingPath')
    expect(collector).toContain("['diff', '--no-renames', '--name-only'")
    expect(collector).toContain('verifyQualificationCandidateBinding')
    expect(collector).toContain('runStartup(input.plan.config')
    expect(collector).toContain('collectQualificationAuditReport')
    expect(collector.indexOf('readQualification(candidate.candidateRunId)')).toBeLessThan(
      collector.indexOf('runStartup(input.plan.config'),
    )
  })

  test('runs the exact image preflight without credentials before the secret-bearing execution step', () => {
    const preflight = workflow.indexOf('Preflight immutable qualification evidence without credentials')
    const secretExecution = workflow.indexOf('Collect, lock, execute once, and independently audit')
    const firstSecret = workflow.indexOf('secrets.BAYN_QUALIFICATION_CLICKHOUSE_USERNAME')

    expect(preflight).toBeGreaterThan(0)
    expect(secretExecution).toBeGreaterThan(preflight)
    expect(firstSecret).toBeGreaterThan(secretExecution)
    expect(workflow).toContain('-e BAYN_QUALIFICATION_MODE=preflight')
    expect(workflow).toContain('-e BAYN_QUALIFICATION_MODE=execute')
    expect(workflow).toContain('bayn.qualification-collector-preflight.v1')
  })

  test('keeps GitHub permissions read-only and declares only explicit secret wiring', () => {
    expect(workflow).toContain('actions: read')
    expect(workflow).toContain('contents: read')
    expect(workflow).not.toMatch(/(?:issues|packages|pull-requests|statuses|checks|deployments|id-token): write/)
    for (const secret of [
      'BAYN_QUALIFICATION_CLICKHOUSE_USERNAME',
      'BAYN_QUALIFICATION_CLICKHOUSE_PASSWORD',
      'BAYN_QUALIFICATION_POSTGRES_URL',
      'BAYN_QUALIFICATION_POSTGRES_CA_PEM',
      'BAYN_QUALIFICATION_SIGNAL_PUBLISHER_USERNAME',
      'BAYN_QUALIFICATION_AUDIT_CLICKHOUSE_USERNAME',
      'BAYN_QUALIFICATION_AUDIT_CLICKHOUSE_PASSWORD',
    ]) {
      expect(workflow).toContain(`secrets.${secret}`)
    }
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(workflow).toContain('Manual qualification dispatch is forbidden.')
  })

  test('packages the candidate, collector, and independent audit into both production image platforms', () => {
    expect(packageManifest).toContain('"collect:qualification": "bun src/qualification-collector-command.ts"')
    for (const command of [
      'qualification-audit-command',
      'qualification-candidate-command',
      'qualification-collector-command',
    ]) {
      expect(packageManifest).toContain(`src/${command}.ts`)
      expect(image).toContain(`src/${command}.ts`)
      expect(image).toContain(`dist/${command}.js`)
    }
    expect(image).toContain('pkgs.git')
    expect(image).toContain('bayn-qualification-candidate')
    expect(image).toContain('bayn-qualification-audit')
    expect(image).toContain('bayn-qualification-collector')
    expect(image).toContain('exec "$root/bin/bun" "$root/app/services/bayn/dist/qualification-collector-command.js"')
    expect(image).toContain('includeBunRuntime = true;')
    expect(image).toContain('sha256-y7PRw8e/DeerQppuopDJREtOGA5qB24hX9HUyumngzg=')
    expect(image).toContain('sha256-SnSTaAPp9/4mjEQxUwZGApZWqsfPd+2MWtvwJ10iqkQ=')
  })

  test('keeps standalone dossier output while the collector imports the report-only audit wrapper', () => {
    expect(auditCommand).toContain('const collectQualificationAuditOutput')
    expect(auditCommand).toContain('const { input, report } = yield* collectQualificationAuditOutput')
    expect(auditCommand).toContain('renderQualificationAuditCommandOutput(report)')
    expect(auditCommand).toContain('completeQualificationAuditCommand(input, report)')
    expect(auditCommand).toContain("input.output === 'audit' && 'status' in report && report.status !== 'PASS'")
    expect(auditCommand).toContain('export const requireQualificationAuditReport')
    expect(auditCommand).toContain(
      'export const collectQualificationAuditReport = collectQualificationAuditOutput.pipe(',
    )
    expect(collector).toContain("import { collectQualificationAuditReport } from './qualification-audit-command'")
  })

  test('keeps collector configuration failures typed and delegates termination to NodeRuntime', () => {
    expect(collector).toContain('export const requiredQualificationEnvironment')
    expect(collector).toContain('export const loadQualificationCollectorInvocation')
    expect(collector).toContain('export const qualificationCollectorMain')
    expect(collector).toContain('Effect.tapError')
    expect(collector).toContain('NodeRuntime.runMain(qualificationCollectorMain)')
    expect(collector).not.toContain('process.exitCode')
    expect(collector).not.toContain('Effect.catch((error)')
  })
})
