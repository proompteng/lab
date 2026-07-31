import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { parse } from 'yaml'

const path = new URL('../../../../.github/workflows/bayn-paper-activation.yml', import.meta.url)
const workflow = readFileSync(path, 'utf8')
const parsed = parse(workflow) as {
  readonly name: string
  readonly on: Readonly<{
    readonly workflow_run?: Readonly<{
      readonly workflows: readonly string[]
      readonly types: readonly string[]
      readonly branches: readonly string[]
    }>
    readonly schedule?: readonly { readonly cron: string }[]
    readonly workflow_dispatch?: unknown
    readonly push?: unknown
    readonly pull_request?: unknown
    readonly pull_request_target?: unknown
  }>
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly if?: string
        readonly steps: readonly {
          readonly name?: string
          readonly run?: string
          readonly if?: string
          readonly uses?: string
          readonly with?: Readonly<Record<string, unknown>>
        }[]
      }
    >
  >
}

const count = (value: string): number => workflow.split(value).length - 1
const scriptFor = (jobName: string, stepName: string): string => {
  const step = parsed.jobs[jobName]?.steps.find((candidate) => candidate.name === stepName)
  if (step?.run === undefined) throw new Error(`workflow step ${jobName}/${stepName} is missing`)
  return step.run
}
const stepFor = (jobName: string, stepName: string) => {
  const step = parsed.jobs[jobName]?.steps.find((candidate) => candidate.name === stepName)
  if (step === undefined) throw new Error(`workflow step ${jobName}/${stepName} is missing`)
  return step
}

const writeExecutable = (directory: string, name: string, contents: string): void => {
  const target = join(directory, name)
  writeFileSync(target, `#!/bin/bash\nset -euo pipefail\n${contents}\n`)
  chmodSync(target, 0o755)
}

const isoSeconds = (epochMs: number): string => new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')

const portableDate = `
python3 - "$@" <<'PY'
import datetime
import sys

args = sys.argv[1:]
value = None
if '-d' in args:
    index = args.index('-d')
    value = args[index + 1]
    if value.endswith(' days ago'):
        days = int(value.removesuffix(' days ago'))
        instant = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
    else:
        instant = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
else:
    instant = datetime.datetime.now(datetime.timezone.utc)
format_arg = next((arg for arg in args if arg.startswith('+')), '+%Y-%m-%dT%H:%M:%SZ')
if format_arg == '+%s':
    print(int(instant.timestamp()))
elif format_arg == '+%s%3N':
    print(int(instant.timestamp()) * 1000 + instant.microsecond // 1000)
else:
    print(instant.astimezone(datetime.timezone.utc).strftime(format_arg[1:]))
PY
`

const runWorkflowScript = async (input: {
  readonly script: string
  readonly environment: Readonly<Record<string, string>>
  readonly executables?: Readonly<Record<string, string>>
  readonly files?: Readonly<Record<string, string>>
}) => {
  const root = mkdtempSync(join(tmpdir(), 'bayn-paper-workflow-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeExecutable(bin, 'date', portableDate)
  for (const [name, contents] of Object.entries(input.executables ?? {})) writeExecutable(bin, name, contents)
  for (const [name, contents] of Object.entries(input.files ?? {})) {
    const target = join(root, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  const output = join(root, 'github-output')
  const process = Bun.spawn(['bash', '-c', input.script], {
    cwd: root,
    env: {
      ...globalThis.process.env,
      PATH: `${bin}:${globalThis.process.env.PATH ?? ''}`,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'proompteng/lab',
      RUNNER_TEMP: root,
      ...input.environment,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  const githubOutput = readFileSync(output, { encoding: 'utf8', flag: 'a+' })
  return {
    exitCode,
    stdout,
    stderr,
    githubOutput,
    root,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

const mergeGh = `
case "$*" in
  *"/merge"*)
    printf '%s\n' merge >> "${'${FAKE_MERGE_LOG}'}"
    printf '%s\n' '{"merged":true}'
    ;;
  *"--method PATCH"*"pulls/${'${ROLLBACK_PR_NUMBER}'}"*)
    printf '%s\n' reopen >> "${'${FAKE_ROLLBACK_REOPEN_LOG}'}"
    printf '%s\n' '{"state":"open"}'
    ;;
  *"git/ref/heads/"*) printf '%s\n' "${'${FAKE_HEAD_SHA}'}" ;;
  *"check-runs?filter=latest"*)
    printf '%s\n' '[{"total_count":1,"check_runs":[{"id":1,"status":"completed","conclusion":"success"}]}]'
    ;;
  *"commits/main"*) printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  *"api graphql"*)
    printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}'
    ;;
  *"pulls/${'${ROLLBACK_PR_NUMBER}'}"*)
    rollback_state="${'${FAKE_ROLLBACK_STATE}'}"
    [[ -s "${'${FAKE_ROLLBACK_REOPEN_LOG}'}" ]] && rollback_state=open
    printf '{"state":"%s","head":{"sha":"%s","ref":"%s"},"base":{"ref":"%s"},"merged_at":null}\n' \
      "${'${rollback_state}'}" "${'${FAKE_ROLLBACK_HEAD_SHA}'}" "${'${ROLLBACK_BRANCH}'}" "${'${FAKE_ROLLBACK_BASE_REF}'}"
    ;;
  *"pulls/${'${PR_NUMBER}'}"*)
    printf '{"head":{"sha":"%s"},"base":{"ref":"main","sha":"%s"},"mergeable_state":"clean","merged_at":"2026-07-31T00:05:00Z"}\n' \
      "${'${FAKE_HEAD_SHA}'}" "${'${FAKE_PULL_BASE_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 90 ;;
esac
`

const activationRollbackEnvironment = {
  EXPECTED_ROLLBACK_SHA: '4'.repeat(40),
  ROLLBACK_BRANCH: 'codex/bayn-paper-rollback/test',
  ROLLBACK_PR_NUMBER: '2',
  FAKE_ROLLBACK_HEAD_SHA: '4'.repeat(40),
  FAKE_ROLLBACK_STATE: 'open',
  FAKE_ROLLBACK_BASE_REF: 'main',
  FAKE_ROLLBACK_REOPEN_LOG: 'rollback-reopen.log',
} as const

const paperStatus = (input: {
  readonly checkedAt: string
  readonly access?: 'mutation' | 'read-only'
  readonly capital?: 'sandbox-capital' | 'none'
  readonly maximum?: 'paper' | 'observe'
  readonly effective?: 'paper' | 'observe'
  readonly current?: unknown
  readonly last?: unknown
  readonly zeroMutation?: boolean
  readonly mutationEventCount?: number
  readonly unresolvedMutationCount?: number
  readonly coversLatestMutation?: boolean
  readonly authorityGenerationHash?: string
  readonly authorityUpdatedAt?: string
}) =>
  JSON.stringify({
    operational: { ready: true, checkedAt: input.checkedAt },
    qualification: { verdict: 'QUALIFIED' },
    build: { sourceRevision: 'b'.repeat(40), image: { digest: `sha256:${'c'.repeat(64)}` } },
    authority: {
      brokerEnvironment: 'sandbox',
      brokerAccess: input.access ?? 'mutation',
      capitalAuthority: input.capital ?? 'sandbox-capital',
      durable: {
        available: true,
        maximum: input.maximum ?? 'paper',
        effective: input.effective ?? 'paper',
        kill: 'clear',
      },
    },
    cycle: {
      observationAvailable: true,
      zeroMutation: input.zeroMutation ?? true,
      authority: {
        generationHash: input.authorityGenerationHash ?? 'f'.repeat(64),
        updatedAt: input.authorityUpdatedAt ?? input.checkedAt,
      },
      current: input.current ?? null,
      last: input.last ?? null,
      mutations: {
        eventCount: input.mutationEventCount ?? 0,
        unresolvedCount: input.unresolvedMutationCount ?? 0,
      },
      reconciliation: {
        status: 'EXACT',
        discrepancyCount: 0,
        coversLatestMutation: input.coversLatestMutation ?? true,
      },
    },
  })

const runWatchdog = async (
  runtimeStatus: string,
  options: {
    readonly expected?: string
    readonly current?: string
    readonly initialBaseRef?: string
    readonly finalBaseRef?: string
    readonly rollbackState?: 'open' | 'closed'
    readonly foreignBaseMergedOnly?: boolean
    readonly attestationMatches?: boolean
    readonly branchMissing?: boolean
    readonly gitopsObserve?: boolean
    readonly latestRunAttempt?: number
    readonly attestationAttempt?: number
    readonly unrelatedArtifactCount?: number
    readonly artifactProducerRunId?: number
    readonly activationBaseRef?: string
  } = {},
) => {
  const rollbackBranch = 'codex/bayn-paper-rollback/test-activation'
  const activationBranch = 'codex/bayn-paper-activation/test-activation'
  const activationSha = '1'.repeat(40)
  const initialRollbackSha = '2'.repeat(40)
  const rollbackSha = '4'.repeat(40)
  const mainSha = '5'.repeat(40)
  const workflowHeadSha = 'a'.repeat(40)
  const desiredBlob = '6'.repeat(40)
  const authorityGenerationHash = options.expected ?? '8'.repeat(64)
  const observeAuthorityGenerationHash = '7'.repeat(64)
  const latestRunAttempt = options.latestRunAttempt ?? 1
  const attestationAttempt = options.attestationAttempt ?? 1
  const metadata = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      activationId: 'test-activation',
      activationBranch,
      rollbackBranch,
      sourceMainSha: mainSha,
      authorityExpiresAt: '2026-07-31T00:00:00Z',
      authorityGenerationHash,
      previousObserveGenerationHash: '6'.repeat(64),
      observeAuthorityGenerationHash,
      baselineCycleId: '',
      workflowRunId: 1,
      workflowRunAttempt: attestationAttempt,
    }),
  ).toString('base64')
  const attestation = JSON.stringify({
    schemaVersion: 1,
    repository: 'proompteng/lab',
    workflowPath: '.github/workflows/bayn-paper-activation.yml',
    workflowRunId: 1,
    workflowRunAttempt: attestationAttempt,
    activationId: 'test-activation',
    activationBranch,
    activationCommitSha: activationSha,
    rollbackBranch,
    rollbackCommitSha: initialRollbackSha,
    rollbackMetadataB64: options.attestationMatches === false ? `${metadata}forged` : metadata,
    sourceMainSha: mainSha,
    workflowHeadSha,
    authorityGenerationHash,
    observeAuthorityGenerationHash,
    authorityExpiresAt: '2026-07-31T00:00:00Z',
  })
  return runWorkflowScript({
    script: scriptFor('rollback-watchdog', 'Restore OBSERVE for expired or abandoned activation'),
    executables: {
      curl: `cat "${'${FAKE_RUNTIME_STATUS}'}"`,
      bun: `
mode=''
output=''
previous=''
for argument in "$@"; do
  if [[ "${'${previous}'}" == --mode ]]; then mode="${'${argument}'}"; fi
  if [[ "${'${previous}'}" == --output ]]; then output="${'${argument}'}"; fi
  previous="${'${argument}'}"
done
case "${'${mode}'}" in
  inspect-deployment-authority)
    if [[ "${'${FAKE_GITOPS_MAXIMUM}'}" == OBSERVE ]]; then
      printf '{"maximumAuthority":"OBSERVE","brokerAccess":"read-only","capitalAuthority":"none","authorityGenerationHash":"%s"}\n' \
        "${'${FAKE_PAPER_GENERATION}'}" > "${'${output}'}"
    else
      printf '{"maximumAuthority":"PAPER","brokerAccess":"mutation","capitalAuthority":"sandbox-capital","authorityGenerationHash":"%s"}\n' \
        "${'${FAKE_PAPER_GENERATION}'}" > "${'${output}'}"
    fi
    ;;
  render-rollback) cat "${'${FAKE_OBSERVE_DEPLOYMENT}'}" > "${'${output}'}" ;;
  *) printf 'unexpected bun mode: %s\n' "${'${mode}'}" >&2; exit 92 ;;
esac
`,
      git: `
case "$*" in
  "config "*|"fetch "*|"read-tree "*|"update-index "*) exit 0 ;;
  "rev-parse origin/main") printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  "show ${'${FAKE_MAIN_SHA}'}:argocd/applications/bayn/deployment.yaml") cat "${'${FAKE_PAPER_DEPLOYMENT}'}" ;;
  "hash-object -w deployment.observe.yaml") printf '%s\n' "${'${FAKE_DESIRED_BLOB}'}" ;;
  "write-tree") printf '%s\n' "${'${FAKE_TREE_SHA}'}" ;;
  "commit-tree "*) printf '%s\n' "${'${FAKE_ROLLBACK_SHA}'}" ;;
  "ls-remote --heads origin refs/heads/${'${FAKE_ROLLBACK_BRANCH}'}")
    if [[ "${'${FAKE_BRANCH_MISSING}'}" != true ]]; then
      printf '%s\trefs/heads/%s\n' "${'${FAKE_ROLLBACK_SHA}'}" "${'${FAKE_ROLLBACK_BRANCH}'}"
    fi
    ;;
  "push "*) printf '%s\n' push >> "${'${FAKE_PUSH_LOG}'}" ;;
  *) printf 'unexpected git invocation: %s\n' "$*" >&2; exit 93 ;;
esac
`,
      gh: `
case "$*" in
  *"pr comment"*) printf 'manual review trigger is prohibited\n' >&2; exit 94 ;;
  *"branches?per_page=100"*)
    printf 'branch-first watchdog discovery is prohibited\n' >&2
    exit 96
    ;;
  *"actions/runs/"*"/artifacts"*)
    printf 'per-run artifact discovery is prohibited\n' >&2
    exit 97
    ;;
  *"actions/artifacts?per_page=100"*)
    printf '%s\n' scan >> "${'${FAKE_ARTIFACT_SCAN_LOG}'}"
    python3 - "${'${FAKE_UNRELATED_ARTIFACT_COUNT}'}" "${'${FAKE_ATTESTATION_ATTEMPT}'}" "${'${FAKE_LATEST_RUN_ATTEMPT}'}" "${'${FAKE_ARTIFACT_PRODUCER_RUN_ID}'}" <<'PY'
import json
import sys

unrelated = int(sys.argv[1])
attestation_attempt = int(sys.argv[2])
latest_attempt = int(sys.argv[3])
producer_run_id = int(sys.argv[4])
artifacts = [{
    "id": 99,
    "name": f"bayn-paper-rollback-attestation-test-activation-1-{attestation_attempt}",
    "expired": False,
    "created_at": "2026-07-31T00:00:00Z",
    "workflow_run": {"id": producer_run_id},
}]
if latest_attempt != attestation_attempt:
    artifacts.append({
        "id": 98,
        "name": f"bayn-paper-rollback-attestation-test-activation-1-{latest_attempt}",
        "expired": True,
        "created_at": "2026-07-31T00:01:00Z",
        "workflow_run": {"id": 1},
    })
for index in range(unrelated):
    artifacts.append({
        "id": 1000 + index,
        "name": f"unrelated-artifact-{index}",
        "expired": False,
        "created_at": "2026-07-31T00:00:00Z",
        "workflow_run": {"id": 1000 + index},
    })
total = len(artifacts)
pages = [{"total_count": total, "artifacts": artifacts[offset:offset + 100]} for offset in range(0, total, 100)]
print(json.dumps(pages, separators=(",", ":")))
PY
    ;;
  *"actions/runs/1/attempts/${'${FAKE_ATTESTATION_ATTEMPT}'}"*)
    printf '{"id":1,"run_attempt":%s,"event":"workflow_run","path":".github/workflows/bayn-paper-activation.yml","head_sha":"%s","repository":{"full_name":"proompteng/lab"},"status":"completed"}\n' \
      "${'${FAKE_ATTESTATION_ATTEMPT}'}" "${'${FAKE_WORKFLOW_HEAD_SHA}'}"
    ;;
  *"commits/${'${FAKE_ACTIVATION_SHA}'}"*)
    printf '{"sha":"%s","parents":[{"sha":"%s"}],"files":[{"filename":"argocd/applications/bayn/deployment.yaml","status":"modified"}],"commit":{"message":"activation"}}\n' \
      "${'${FAKE_ACTIVATION_SHA}'}" "${'${FAKE_MAIN_SHA}'}"
    ;;
  *"commits/${'${FAKE_INITIAL_ROLLBACK_SHA}'}"*)
    message="$(printf 'chore(bayn): rollback\n\nBAYN_PAPER_ROLLBACK_METADATA=%s' "${'${FAKE_METADATA_B64}'}")"
    jq -nc \
      --arg sha "${'${FAKE_INITIAL_ROLLBACK_SHA}'}" \
      --arg parent "${'${FAKE_MAIN_SHA}'}" \
      --arg message "${'${message}'}" \
      '{sha:$sha,parents:[{sha:$parent}],files:[{filename:"argocd/applications/bayn/deployment.yaml",status:"modified"}],commit:{message:$message}}'
    ;;
  *"actions/artifacts/99/zip"*)
    printf '%s\n' open >> "${'${FAKE_ARTIFACT_OPEN_LOG}'}"
    python3 - "${'${FAKE_ATTESTATION_FILE}'}" <<'PY'
import io
import pathlib
import sys
import zipfile

buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w') as archive:
    archive.writestr('bayn-paper-rollback-attestation.json', pathlib.Path(sys.argv[1]).read_bytes())
sys.stdout.buffer.write(buffer.getvalue())
PY
    ;;
  *"pulls?state=all"*"${'${FAKE_ACTIVATION_BRANCH}'}"*)
    printf '[{"number":40,"state":"closed","merged_at":"2026-07-31T00:00:00Z","head":{"sha":"%s","ref":"%s"},"base":{"ref":"%s"}}]\n' \
      "${'${FAKE_ACTIVATION_SHA}'}" "${'${FAKE_ACTIVATION_BRANCH}'}" "${'${FAKE_ACTIVATION_BASE_REF}'}"
    ;;
  *"pulls?state=all"*"${'${FAKE_ROLLBACK_BRANCH}'}"*)
    if [[ "${'${FAKE_BRANCH_MISSING}'}" == true ]]; then
      printf '%s\n' '[]'
    elif [[ "${'${FAKE_FOREIGN_BASE_MERGED_ONLY}'}" == true ]]; then
      printf '[{"number":41,"state":"closed","merged_at":"2026-07-31T00:01:00Z","head":{"sha":"%s","ref":"%s"},"base":{"ref":"foreign"}}]\n' \
        "${'${FAKE_ROLLBACK_SHA}'}" "${'${FAKE_ROLLBACK_BRANCH}'}"
    else
      printf '[{"number":42,"state":"%s","merged_at":null,"head":{"sha":"%s","ref":"%s"},"base":{"ref":"%s"}}]\n' \
        "${'${FAKE_ROLLBACK_STATE}'}" "${'${FAKE_ROLLBACK_SHA}'}" "${'${FAKE_ROLLBACK_BRANCH}'}" "${'${FAKE_INITIAL_BASE_REF}'}"
    fi
    ;;
  *"pr create"*)
    printf '%s\n' create >> "${'${FAKE_PR_CREATE_LOG}'}"
    printf '%s\n' 'https://github.com/proompteng/lab/pull/77'
    ;;
  *"--method PATCH"*"pulls/42"*|*"--method PATCH"*"pulls/77"*)
    printf '%s\n' reopen >> "${'${FAKE_WATCHDOG_REOPEN_LOG}'}"
    printf '%s\n' '{"state":"open"}'
    ;;
  "auth setup-git"|"pr ready 42 --repo proompteng/lab"|"pr ready 77 --repo proompteng/lab") exit 0 ;;
  *"api graphql"*)
    printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}'
    ;;
  *"commits/${'${FAKE_ROLLBACK_SHA}'}/check-runs"*) printf '%s\n' '[{"total_count":1,"check_runs":[{"id":1,"status":"completed","conclusion":"success"}]}]' ;;
  *"pulls/42/merge"*|*"pulls/77/merge"*) printf '%s\n' merge >> "${'${FAKE_MERGE_LOG}'}"; printf '%s\n' '{"merged":true}' ;;
  *"pulls/42"*|*"pulls/77"*)
    count=0
    [[ -s "${'${FAKE_PULL_COUNTER}'}" ]] && count="$(cat "${'${FAKE_PULL_COUNTER}'}")"
    count=$((count + 1))
    printf '%s' "${'${count}'}" > "${'${FAKE_PULL_COUNTER}'}"
    base_ref="${'${FAKE_INITIAL_BASE_REF}'}"
    [[ "${'${count}'}" -gt 2 ]] && base_ref="${'${FAKE_FINAL_BASE_REF}'}"
    rollback_state="${'${FAKE_ROLLBACK_STATE}'}"
    [[ -s "${'${FAKE_WATCHDOG_REOPEN_LOG}'}" ]] && rollback_state=open
    if [[ "$*" == *"pulls/77"* ]]; then rollback_state=open; base_ref=main; fi
    printf '{"state":"%s","merged_at":null,"head":{"sha":"%s","ref":"%s"},"base":{"ref":"%s"},"mergeable_state":"clean"}\n' \
      "${'${rollback_state}'}" "${'${FAKE_ROLLBACK_SHA}'}" "${'${FAKE_ROLLBACK_BRANCH}'}" "${'${base_ref}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 95 ;;
esac
`,
      sleep: 'exit 0',
    },
    files: {
      'runtime-status.json': runtimeStatus,
      'paper-deployment.yaml': 'paper manifest\n',
      'observe-deployment.yaml': 'observe manifest\n',
      'attestation.json': attestation,
      '.github/PULL_REQUEST_TEMPLATE.md':
        '## Summary\n## Related Issues\n## Testing\n## Breaking Changes\n## Checklist\n',
    },
    environment: {
      GH_TOKEN: 'test-token',
      FAKE_RUNTIME_STATUS: 'runtime-status.json',
      FAKE_PAPER_DEPLOYMENT: 'paper-deployment.yaml',
      FAKE_OBSERVE_DEPLOYMENT: 'observe-deployment.yaml',
      FAKE_PAPER_GENERATION: options.current ?? options.expected ?? '8'.repeat(64),
      FAKE_GITOPS_MAXIMUM: options.gitopsObserve === true ? 'OBSERVE' : 'PAPER',
      FAKE_MAIN_SHA: mainSha,
      FAKE_WORKFLOW_HEAD_SHA: workflowHeadSha,
      FAKE_ROLLBACK_SHA: rollbackSha,
      FAKE_INITIAL_ROLLBACK_SHA: initialRollbackSha,
      FAKE_ACTIVATION_SHA: activationSha,
      FAKE_DESIRED_BLOB: desiredBlob,
      FAKE_TREE_SHA: '9'.repeat(40),
      FAKE_ROLLBACK_BRANCH: rollbackBranch,
      FAKE_ACTIVATION_BRANCH: activationBranch,
      FAKE_METADATA_B64: metadata,
      FAKE_MERGE_LOG: 'merge.log',
      FAKE_INITIAL_BASE_REF: options.initialBaseRef ?? 'main',
      FAKE_FINAL_BASE_REF: options.finalBaseRef ?? options.initialBaseRef ?? 'main',
      FAKE_PULL_COUNTER: 'pull-counter',
      FAKE_ROLLBACK_STATE: options.rollbackState ?? 'open',
      FAKE_WATCHDOG_REOPEN_LOG: 'watchdog-reopen.log',
      FAKE_ATTESTATION_FILE: 'attestation.json',
      FAKE_FOREIGN_BASE_MERGED_ONLY: options.foreignBaseMergedOnly === true ? 'true' : 'false',
      FAKE_BRANCH_MISSING: options.branchMissing === true ? 'true' : 'false',
      FAKE_LATEST_RUN_ATTEMPT: String(latestRunAttempt),
      FAKE_ATTESTATION_ATTEMPT: String(attestationAttempt),
      FAKE_UNRELATED_ARTIFACT_COUNT: String(options.unrelatedArtifactCount ?? 0),
      FAKE_ARTIFACT_PRODUCER_RUN_ID: String(options.artifactProducerRunId ?? 1),
      FAKE_ACTIVATION_BASE_REF: options.activationBaseRef ?? 'main',
      FAKE_ARTIFACT_SCAN_LOG: 'artifact-scan.log',
      FAKE_ARTIFACT_OPEN_LOG: 'artifact-open.log',
      FAKE_PR_CREATE_LOG: 'pr-create.log',
      FAKE_PUSH_LOG: 'push.log',
    },
  })
}

describe('Bayn PAPER activation workflow', () => {
  test('uses only default-branch-loaded triggers and retains a read-only event token', () => {
    expect(parsed.name).toBe('bayn-paper-activation')
    expect(Object.keys(parsed.on).sort()).toEqual(['schedule', 'workflow_run'])
    expect(parsed.on.workflow_run).toEqual({
      workflows: ['bayn-qualification'],
      types: ['completed'],
      branches: ['main'],
    })
    expect(parsed.on.schedule).toEqual([{ cron: '3,8,13,18,23,28,33,38,43,48,53,58 * * * *' }])
    for (const branchSelectableEvent of ['workflow_dispatch', 'push', 'pull_request', 'pull_request_target'] as const)
      expect(parsed.on[branchSelectableEvent], branchSelectableEvent).toBeUndefined()
    expect(workflow).not.toContain('inputs.')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('actions: read')
    expect(workflow).not.toContain(': write')
    expect(workflow).toContain('AGENTS_SPLIT_TOKEN')
    expect(workflow).not.toContain('kubectl')
  })

  test('cannot expose GitOps secrets through an attacker-selected workflow ref', () => {
    expect(workflow).not.toContain('workflow_dispatch')
    expect(workflow).not.toContain('github.ref_protected')
    expect(workflow).not.toContain('github.workflow_ref')
    expect(parsed.jobs['verify-and-prepare']?.if).toContain("github.event_name == 'workflow_run'")
    expect(parsed.jobs['verify-and-prepare']?.if).toContain("github.event.workflow_run.event == 'schedule'")
    expect(parsed.jobs['activate-and-observe']?.if).toContain("github.event_name == 'workflow_run'")
    expect(parsed.jobs.rollback?.if).toContain("github.event_name == 'workflow_run'")
    expect(parsed.jobs['rollback-watchdog']?.if).toBe("github.event_name == 'schedule'")

    const identity = scriptFor('verify-and-prepare', 'Authenticate activation identity and evidence producer')
    expect(identity).not.toContain('AGENTS_SPLIT_TOKEN')
    expect(identity).not.toContain('GITOPS_TOKEN')
    expect(identity).toContain('event=workflow_run')
    expect(workflow).toContain('protected-gitops-token-missing')
  })

  test('stays dormant without an exact qualification activation artifact', async () => {
    const mainSha = 'a'.repeat(40)
    const result = await runWorkflowScript({
      script: scriptFor('verify-and-prepare', 'Authenticate activation identity and evidence producer'),
      executables: {
        git: `
case "$*" in
  "rev-parse HEAD") printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  *) printf 'unexpected git invocation: %s\n' "$*" >&2; exit 96 ;;
esac
`,
        gh: `
case "$*" in
  *"commits/main"*) printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  *"actions/workflows/bayn-paper-activation.yml"*"--jq .id"*) printf '%s\n' 123 ;;
  *"actions/workflows/123/runs?event=workflow_run"*) printf '%s\n' '{"workflow_runs":[]}' ;;
  *"actions/workflows/bayn-qualification.yml"*) printf '%s\n' '{"id":456}' ;;
  *"actions/runs/77/artifacts?name=bayn-paper-activation-evidence-77-1"*) printf '%s\n' '{"artifacts":[]}' ;;
  *"actions/runs/77"*)
    printf '{"workflow_id":456,"path":".github/workflows/bayn-qualification.yml","event":"schedule","status":"completed","conclusion":"success","head_branch":"main","head_sha":"%s","repository":{"full_name":"proompteng/lab"},"run_attempt":1}\n' "${'${FAKE_MAIN_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 97 ;;
esac
`,
      },
      environment: {
        ACTIVATION_ID: 'qualification-77-1',
        ARTIFACT_NAME: 'bayn-paper-activation-evidence-77-1',
        EVIDENCE_RUN_ATTEMPT: '1',
        EVIDENCE_RUN_ID: '77',
        GH_TOKEN: 'read-only-event-token',
        GITHUB_RUN_ID: '88',
        FAKE_MAIN_SHA: mainSha,
      },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain('PAPER activation remains dormant')
      expect(result.githubOutput).toContain('activation_id=qualification-77-1')
      expect(result.githubOutput).toContain(`current_main_sha=${mainSha}`)
      expect(result.githubOutput).toContain('live=false')
    } finally {
      result.dispose()
    }
  })

  test('authenticates a current-main qualification artifact and canonical generation', () => {
    expect(workflow).toContain('actions/workflows/bayn-qualification.yml')
    expect(workflow).toContain('bayn-paper-activation-evidence-${EVIDENCE_RUN_ID}-${evidence_attempt}')
    expect(workflow).toContain('--mode extract-manifest-pins')
    expect(workflow).toContain('--kustomization argocd/applications/bayn/kustomization.yaml')
    expect(workflow).toContain('.authorityGeneration.generationHash')
    expect(workflow).toContain('--mode derive-observe-rollback')
    expect(workflow).toContain('--previous-observe-generation-hash')
    expect(workflow).toContain('--paper-authority-generation-hash')
    expect(workflow).toContain('observe-rollback-generation.json')
  })

  test('precommits reviewed activation and a fresh rollback before PAPER can merge', () => {
    const preparationSteps = parsed.jobs['verify-and-prepare']?.steps ?? []
    const uploadIndex = preparationSteps.findIndex((step) => step.name === 'Upload rollback watchdog attestation')
    const releaseIndex = preparationSteps.findIndex(
      (step) => step.name === 'Release activation only after durable rollback attestation',
    )
    const upload = stepFor('verify-and-prepare', 'Upload rollback watchdog attestation')
    const release = stepFor('verify-and-prepare', 'Release activation only after durable rollback attestation')
    expect(workflow).toContain('--mode render-transition')
    expect(workflow).toContain('--observe-authority-generation-hash')
    expect(workflow).toContain('--authority-expires-at')
    expect(workflow).toContain('codex/bayn-paper-activation/${ACTIVATION_ID}')
    expect(workflow).toContain('codex/bayn-paper-rollback/${ACTIVATION_ID}')
    expect(workflow).toContain('activation_commit_sha=${activation_commit}')
    expect(workflow).toContain('rollback_commit_sha=${rollback_commit}')
    expect(workflow).toContain('rollback_metadata_b64=${metadata_b64}')
    expect(workflow).toContain('EXPECTED_ACTIVATION_SHA: ${{ needs.verify-and-prepare.outputs.activation_commit_sha }}')
    expect(workflow).toContain(
      'EXPECTED_ROLLBACK_METADATA_B64: ${{ needs.verify-and-prepare.outputs.rollback_metadata_b64 }}',
    )
    expect(workflow).toContain('rollback_commit_sha: ${{ steps.rebase_rollback.outputs.rollback_commit_sha }}')
    expect(workflow).toContain(
      'EXPECTED_ROLLBACK_SHA: ${{ needs.activate-and-observe.outputs.rollback_commit_sha || needs.verify-and-prepare.outputs.rollback_commit_sha }}',
    )
    expect(workflow).toContain('BAYN_PAPER_ROLLBACK_METADATA=')
    expect(count('--draft')).toBeGreaterThanOrEqual(2)
    expect(uploadIndex).toBeGreaterThan(-1)
    expect(releaseIndex).toBeGreaterThan(uploadIndex)
    expect(upload.uses).toBe('actions/upload-artifact@v4')
    expect(upload.with?.['if-no-files-found']).toBe('error')
    expect(release.if).toBe("steps.identity.outputs.live == 'true'")
    expect(release.run).toContain('activation-draft-changed')
    expect(release.run).toContain('activation-containment-failed')
    expect(release.run).toContain('gh pr ready "${PR_NUMBER}" --undo')
    expect(workflow.indexOf('git push origin "${rollback_commit}:refs/heads/${rollback_branch}"')).toBeLessThan(
      workflow.indexOf('gh pr create'),
    )
    expect(workflow).toContain("template_file='.github/PULL_REQUEST_TEMPLATE.md'")
    expect(workflow).toContain('--body-file rollback-pr-body.md')
    expect(workflow).toContain('--body-file activation-pr-body.md')
    expect(workflow).toContain('## Related Issues')
    expect(workflow).toContain('## Breaking Changes')
    expect(workflow).toContain('- [x] Testing section documents the exact validation performed')
    expect(workflow).not.toContain('--body "Precommitted automatic OBSERVE rollback')
    expect(workflow).not.toContain('--body "Reviewed GitOps PAPER transition')
    expect(workflow).toContain('rollback-precommit-changed')
    expect(workflow).toContain('ensure_rollback_pr_open')
    expect(workflow).toContain('bayn-paper-rollback-attestation-${{ steps.identity.outputs.activation_id }}')
    expect(workflow).toContain('rollbackMetadataB64')
    expect(workflow).toContain('workflowRunAttempt')
    expect(workflow).toContain('workflowHeadSha')
    expect(workflow).toContain('actions/runs/${workflow_run_id}/attempts/${workflow_run_attempt}')
    expect(workflow).not.toContain('branches?per_page=100')
    expect(workflow).toContain('--body-file rollback-watchdog-pr-body.md')
    const watchdog = scriptFor('rollback-watchdog', 'Restore OBSERVE for expired or abandoned activation')
    expect(watchdog).toContain('GitOps already declares OBSERVE; no rollback discovery is required.')
    expect(watchdog).toContain('actions/artifacts?per_page=100')
    expect(watchdog).not.toContain('actions/runs/${workflow_run_id}/artifacts')
    expect(watchdog).toContain('.workflow_run.id')
    expect(watchdog).toContain('artifactWorkflowRunId')
    expect(watchdog.indexOf('--mode inspect-deployment-authority')).toBeLessThan(
      watchdog.indexOf('actions/artifacts?per_page=100'),
    )
    expect(count('reviewThreads(first:100,after:$after)')).toBe(3)
    expect(count('pageInfo{hasNextPage endCursor}')).toBe(3)
    expect(count('load_check_runs()')).toBe(3)
    expect(count('check-run-pagination-invalid')).toBe(3)
    expect(count('merge_method=squash')).toBe(3)
  })

  test('leaves no mergeable activation when attestation persistence fails or the job is cancelled', async () => {
    const activationBranch = 'codex/bayn-paper-activation/test-activation'
    const rollbackBranch = 'codex/bayn-paper-rollback/test-activation'
    const result = await runWorkflowScript({
      script: scriptFor('verify-and-prepare', 'Atomically claim and create paired reviewed GitOps pull requests'),
      executables: {
        git: `
case "$*" in
  "ls-remote --exit-code --heads origin refs/heads/"*) exit 2 ;;
  "config "*|"read-tree "*|"update-index "*) exit 0 ;;
  "hash-object -w deployment.paper.yaml") printf '%s\n' "${'${FAKE_PAPER_BLOB}'}" ;;
  "hash-object -w deployment.observe.yaml") printf '%s\n' "${'${FAKE_OBSERVE_BLOB}'}" ;;
  "write-tree") printf '%s\n' "${'${FAKE_TREE_SHA}'}" ;;
  "commit-tree "*)
    count=0
    [[ -s "${'${FAKE_COMMIT_COUNTER}'}" ]] && count="$(cat "${'${FAKE_COMMIT_COUNTER}'}")"
    count=$((count + 1))
    printf '%s' "${'${count}'}" > "${'${FAKE_COMMIT_COUNTER}'}"
    if [[ "${'${count}'}" == 1 ]]; then printf '%s\n' "${'${FAKE_ACTIVATION_SHA}'}"; else printf '%s\n' "${'${FAKE_ROLLBACK_SHA}'}"; fi
    ;;
  "push "*) printf '%s\n' "$*" >> "${'${FAKE_PUSH_LOG}'}" ;;
  *) printf 'unexpected git invocation: %s\n' "$*" >&2; exit 96 ;;
esac
`,
        gh: `
case "$*" in
  "auth setup-git") exit 0 ;;
  "pr create "*)
    printf '%s\n' "$*" >> "${'${FAKE_PR_CREATE_LOG}'}"
    if [[ "$*" == *"${'${FAKE_ROLLBACK_BRANCH}'}"* ]]; then
      printf '%s\n' 'https://github.com/proompteng/lab/pull/42'
    else
      printf '%s\n' 'https://github.com/proompteng/lab/pull/41'
    fi
    ;;
  "pr ready "*) printf '%s\n' "$*" >> "${'${FAKE_READY_LOG}'}"; exit 97 ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 98 ;;
esac
`,
      },
      files: {
        'deployment.paper.yaml': 'paper\n',
        'deployment.observe.yaml': 'observe\n',
        '.github/PULL_REQUEST_TEMPLATE.md':
          '## Summary\n## Related Issues\n## Testing\n## Breaking Changes\n## Checklist\n',
      },
      environment: {
        ACTIVATION_ID: 'test-activation',
        AUTHORITY_EXPIRES_AT: '2026-07-31T18:00:00Z',
        AUTHORITY_GENERATION_HASH: '8'.repeat(64),
        BASELINE_CYCLE_ID: '',
        CURRENT_MAIN_SHA: '5'.repeat(40),
        GH_TOKEN: 'test-token',
        OBSERVE_AUTHORITY_GENERATION_HASH: '7'.repeat(64),
        PREVIOUS_OBSERVE_GENERATION_HASH: '6'.repeat(64),
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_RUN_ID: '77',
        FAKE_ACTIVATION_SHA: '1'.repeat(40),
        FAKE_ROLLBACK_SHA: '2'.repeat(40),
        FAKE_PAPER_BLOB: '3'.repeat(40),
        FAKE_OBSERVE_BLOB: '4'.repeat(40),
        FAKE_TREE_SHA: '9'.repeat(40),
        FAKE_COMMIT_COUNTER: 'commit-counter',
        FAKE_PUSH_LOG: 'push.log',
        FAKE_PR_CREATE_LOG: 'pr-create.log',
        FAKE_READY_LOG: 'ready.log',
        FAKE_ROLLBACK_BRANCH: rollbackBranch,
      },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      const createCalls = readFileSync(join(result.root, 'pr-create.log'), 'utf8').trim().split('\n')
      expect(createCalls).toHaveLength(2)
      expect(createCalls.find((call) => call.includes(rollbackBranch))).toContain('--draft')
      expect(createCalls.find((call) => call.includes(activationBranch))).toContain('--draft')
      expect(result.githubOutput).toContain('activation_pr=41')
      expect(result.githubOutput).toContain('rollback_pr=42')
      expect(existsSync(join(result.root, 'ready.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('marks the exact activation ready only on the normal attested path', async () => {
    const head = '1'.repeat(40)
    const base = '2'.repeat(40)
    const branch = 'codex/bayn-paper-activation/test-activation'
    const result = await runWorkflowScript({
      script: scriptFor('verify-and-prepare', 'Release activation only after durable rollback attestation'),
      executables: {
        gh: `
case "$*" in
  *"commits/main"*) printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  "pr ready ${'${PR_NUMBER}'} --undo "*) printf 'unexpected undo\n' >&2; exit 96 ;;
  "pr ready ${'${PR_NUMBER}'} --repo "*) printf '%s\n' ready >> "${'${FAKE_READY_LOG}'}" ;;
  *"pulls/${'${PR_NUMBER}'}"*)
    draft=true
    [[ -s "${'${FAKE_READY_LOG}'}" ]] && draft=false
    printf '{"state":"open","draft":%s,"merged_at":null,"head":{"sha":"%s","ref":"%s"},"base":{"ref":"main","sha":"%s"}}\n' \
      "${'${draft}'}" "${'${EXPECTED_ACTIVATION_SHA}'}" "${'${ACTIVATION_BRANCH}'}" "${'${EXPECTED_BASE_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 97 ;;
esac
`,
      },
      environment: {
        ACTIVATION_BRANCH: branch,
        EXPECTED_ACTIVATION_SHA: head,
        EXPECTED_BASE_SHA: base,
        GH_TOKEN: 'test-token',
        PR_NUMBER: '41',
        FAKE_MAIN_SHA: base,
        FAKE_READY_LOG: 'ready.log',
      },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'ready.log'), 'utf8')).toContain('ready')
      expect(result.stderr).not.toContain('activation-draft-changed')
      expect(result.stderr).not.toContain('activation-ready-changed')
    } finally {
      result.dispose()
    }
  })

  test('returns a drifted activation to draft during the post-attestation release interleaving', async () => {
    const head = '1'.repeat(40)
    const replacement = '9'.repeat(40)
    const base = '2'.repeat(40)
    const branch = 'codex/bayn-paper-activation/test-activation'
    const result = await runWorkflowScript({
      script: scriptFor('verify-and-prepare', 'Release activation only after durable rollback attestation'),
      executables: {
        gh: `
case "$*" in
  *"commits/main"*) printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  "pr ready ${'${PR_NUMBER}'} --undo "*) printf '%s\n' undo >> "${'${FAKE_READY_LOG}'}" ;;
  "pr ready ${'${PR_NUMBER}'} --repo "*) printf '%s\n' ready >> "${'${FAKE_READY_LOG}'}" ;;
  *"pulls/${'${PR_NUMBER}'}"*)
    count=0
    [[ -s "${'${FAKE_PULL_COUNTER}'}" ]] && count="$(cat "${'${FAKE_PULL_COUNTER}'}")"
    count=$((count + 1))
    printf '%s' "${'${count}'}" > "${'${FAKE_PULL_COUNTER}'}"
    if [[ "${'${count}'}" == 1 ]]; then
      printf '{"state":"open","draft":true,"merged_at":null,"head":{"sha":"%s","ref":"%s"},"base":{"ref":"main","sha":"%s"}}\n' \
        "${'${EXPECTED_ACTIVATION_SHA}'}" "${'${ACTIVATION_BRANCH}'}" "${'${EXPECTED_BASE_SHA}'}"
    elif [[ "${'${count}'}" == 2 ]]; then
      printf '{"state":"open","draft":false,"merged_at":null,"head":{"sha":"%s","ref":"%s"},"base":{"ref":"main","sha":"%s"}}\n' \
        "${'${FAKE_REPLACEMENT_SHA}'}" "${'${ACTIVATION_BRANCH}'}" "${'${EXPECTED_BASE_SHA}'}"
    else
      printf '{"state":"open","draft":true,"merged_at":null,"head":{"sha":"%s","ref":"%s"},"base":{"ref":"main","sha":"%s"}}\n' \
        "${'${FAKE_REPLACEMENT_SHA}'}" "${'${ACTIVATION_BRANCH}'}" "${'${EXPECTED_BASE_SHA}'}"
    fi
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 98 ;;
esac
`,
      },
      environment: {
        ACTIVATION_BRANCH: branch,
        EXPECTED_ACTIVATION_SHA: head,
        EXPECTED_BASE_SHA: base,
        GH_TOKEN: 'test-token',
        PR_NUMBER: '41',
        FAKE_MAIN_SHA: base,
        FAKE_REPLACEMENT_SHA: replacement,
        FAKE_PULL_COUNTER: 'pull-counter',
        FAKE_READY_LOG: 'ready.log',
      },
    })
    try {
      expect(result.exitCode).toBe(1)
      expect(readFileSync(join(result.root, 'ready.log'), 'utf8').trim().split('\n')).toEqual(['ready', 'undo'])
      expect(result.stderr).toContain('activation-ready-changed')
      expect(result.stderr).not.toContain('activation-containment-failed')
    } finally {
      result.dispose()
    }
  })

  test('merges only while the exact verified base and authority window remain current', async () => {
    const script = scriptFor('activate-and-observe', 'Merge only a clean exact-head protected activation PR')
    const head = '1'.repeat(40)
    const base = '2'.repeat(40)
    const expiry = isoSeconds(Date.now() + 60 * 60 * 1_000)
    const result = await runWorkflowScript({
      script,
      executables: { gh: mergeGh },
      environment: {
        ...activationRollbackEnvironment,
        ACTIVATION_BRANCH: 'codex/test',
        EXPECTED_ACTIVATION_SHA: head,
        AUTHORITY_EXPIRES_AT: expiry,
        QUALIFICATION_EXPIRES_AT: expiry,
        EXPECTED_BASE_SHA: base,
        PR_NUMBER: '1',
        FAKE_HEAD_SHA: head,
        FAKE_MAIN_SHA: base,
        FAKE_PULL_BASE_SHA: base,
        FAKE_MERGE_LOG: join(tmpdir(), `bayn-paper-merge-${crypto.randomUUID()}`),
      },
    })

    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.githubOutput).toContain('activation_merged_at=2026-07-31T00:05:00Z')
    } finally {
      result.dispose()
    }
  })

  test('paginates review threads and blocks an unresolved thread after the first page', async () => {
    const head = '1'.repeat(40)
    const base = '2'.repeat(40)
    const expiry = isoSeconds(Date.now() + 60 * 60 * 1_000)
    const result = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Merge only a clean exact-head protected activation PR'),
      executables: {
        gh: `
case "$*" in
  *"/merge"*)
    printf '%s\n' merge >> "${'${FAKE_MERGE_LOG}'}"
    printf '%s\n' '{"merged":true}'
    ;;
  *"git/ref/heads/"*) printf '%s\n' "${'${FAKE_HEAD_SHA}'}" ;;
  *"check-runs?filter=latest"*) printf '%s\n' '[{"total_count":1,"check_runs":[{"id":1,"status":"completed","conclusion":"success"}]}]' ;;
  *"commits/main"*) printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  *"api graphql"*)
    printf '%s\n' "$*" >> "${'${FAKE_PAGINATION_LOG}'}"
    if [[ "$*" == *"after=cursor-1"* ]]; then
      printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":false}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}'
    else
      printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":true}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor-1"}}}}}}'
    fi
    ;;
  *"pulls/${'${ROLLBACK_PR_NUMBER}'}"*)
    printf '{"state":"open","head":{"sha":"%s","ref":"%s"},"base":{"ref":"main"},"merged_at":null}\n' \
      "${'${EXPECTED_ROLLBACK_SHA}'}" "${'${ROLLBACK_BRANCH}'}"
    ;;
  *"pulls/${'${PR_NUMBER}'}"*)
    printf '{"head":{"sha":"%s"},"base":{"ref":"main","sha":"%s"},"mergeable_state":"clean","merged_at":null}\n' \
      "${'${FAKE_HEAD_SHA}'}" "${'${FAKE_PULL_BASE_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 90 ;;
esac
`,
        sleep: 'exit 99',
      },
      environment: {
        ...activationRollbackEnvironment,
        ACTIVATION_BRANCH: 'codex/test',
        EXPECTED_ACTIVATION_SHA: head,
        AUTHORITY_EXPIRES_AT: expiry,
        QUALIFICATION_EXPIRES_AT: expiry,
        EXPECTED_BASE_SHA: base,
        PR_NUMBER: '1',
        FAKE_HEAD_SHA: head,
        FAKE_MAIN_SHA: base,
        FAKE_PULL_BASE_SHA: base,
        FAKE_MERGE_LOG: 'merge.log',
        FAKE_PAGINATION_LOG: 'pagination.log',
      },
    })

    try {
      expect(result.exitCode).not.toBe(0)
      const pagination = readFileSync(join(result.root, 'pagination.log'), 'utf8')
      expect(pagination).toContain('after=cursor-1')
      expect(pagination.trim().split('\n')).toHaveLength(2)
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('paginates check runs and blocks a failed run after the first page', async () => {
    const head = '1'.repeat(40)
    const base = '2'.repeat(40)
    const expiry = isoSeconds(Date.now() + 60 * 60 * 1_000)
    const result = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Merge only a clean exact-head protected activation PR'),
      executables: {
        gh: `
case "$*" in
  *"/merge"*)
    printf '%s\n' merge >> "${'${FAKE_MERGE_LOG}'}"
    printf '%s\n' '{"merged":true}'
    ;;
  *"git/ref/heads/"*) printf '%s\n' "${'${FAKE_HEAD_SHA}'}" ;;
  *"check-runs?filter=latest"*)
    [[ "$*" == *"--paginate --slurp"* ]] || { printf 'check pagination flags are required\n' >&2; exit 96; }
    printf '%s\n' "$*" >> "${'${FAKE_CHECK_PAGINATION_LOG}'}"
    python3 - <<'PY'
import json
first = [{"id": index, "status": "completed", "conclusion": "success"} for index in range(1, 101)]
second = [{"id": 101, "status": "completed", "conclusion": "failure"}]
print(json.dumps([
    {"total_count": 101, "check_runs": first},
    {"total_count": 101, "check_runs": second},
], separators=(",", ":")))
PY
    ;;
  *"commits/main"*) printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  *"api graphql"*)
    printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}'
    ;;
  *"pulls/${'${ROLLBACK_PR_NUMBER}'}"*)
    printf '{"state":"open","head":{"sha":"%s","ref":"%s"},"base":{"ref":"main"},"merged_at":null}\n' \
      "${'${EXPECTED_ROLLBACK_SHA}'}" "${'${ROLLBACK_BRANCH}'}"
    ;;
  *"pulls/${'${PR_NUMBER}'}"*)
    printf '{"head":{"sha":"%s"},"base":{"ref":"main","sha":"%s"},"mergeable_state":"clean","merged_at":null}\n' \
      "${'${FAKE_HEAD_SHA}'}" "${'${FAKE_PULL_BASE_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 90 ;;
esac
`,
        sleep: 'exit 99',
      },
      environment: {
        ...activationRollbackEnvironment,
        ACTIVATION_BRANCH: 'codex/test',
        EXPECTED_ACTIVATION_SHA: head,
        AUTHORITY_EXPIRES_AT: expiry,
        QUALIFICATION_EXPIRES_AT: expiry,
        EXPECTED_BASE_SHA: base,
        PR_NUMBER: '1',
        FAKE_HEAD_SHA: head,
        FAKE_MAIN_SHA: base,
        FAKE_PULL_BASE_SHA: base,
        FAKE_MERGE_LOG: 'merge.log',
        FAKE_CHECK_PAGINATION_LOG: 'check-pagination.log',
      },
    })
    try {
      expect(result.exitCode).not.toBe(0)
      expect(readFileSync(join(result.root, 'check-pagination.log'), 'utf8')).toContain('--paginate --slurp')
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('reopens a closed paired rollback PR immediately before activation merge', async () => {
    const head = '1'.repeat(40)
    const base = '2'.repeat(40)
    const expiry = isoSeconds(Date.now() + 60 * 60 * 1_000)
    const result = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Merge only a clean exact-head protected activation PR'),
      executables: { gh: mergeGh },
      environment: {
        ...activationRollbackEnvironment,
        ACTIVATION_BRANCH: 'codex/test',
        EXPECTED_ACTIVATION_SHA: head,
        AUTHORITY_EXPIRES_AT: expiry,
        QUALIFICATION_EXPIRES_AT: expiry,
        EXPECTED_BASE_SHA: base,
        PR_NUMBER: '1',
        FAKE_HEAD_SHA: head,
        FAKE_MAIN_SHA: base,
        FAKE_PULL_BASE_SHA: base,
        FAKE_MERGE_LOG: 'merge.log',
        FAKE_ROLLBACK_STATE: 'closed',
        FAKE_ROLLBACK_REOPEN_LOG: 'rollback-reopen.log',
      },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'rollback-reopen.log'), 'utf8')).toContain('reopen')
      expect(readFileSync(join(result.root, 'merge.log'), 'utf8')).toContain('merge')
    } finally {
      result.dispose()
    }
  })

  test('refuses changed base and near-expiry authority before merge', async () => {
    const script = scriptFor('activate-and-observe', 'Merge only a clean exact-head protected activation PR')
    const base = '2'.repeat(40)
    const common = {
      ...activationRollbackEnvironment,
      ACTIVATION_BRANCH: 'codex/test',
      EXPECTED_ACTIVATION_SHA: '1'.repeat(40),
      EXPECTED_BASE_SHA: base,
      PR_NUMBER: '1',
      FAKE_HEAD_SHA: '1'.repeat(40),
      FAKE_PULL_BASE_SHA: base,
      FAKE_MERGE_LOG: join(tmpdir(), `bayn-paper-merge-${crypto.randomUUID()}`),
    }
    const changedBase = await runWorkflowScript({
      script,
      executables: { gh: mergeGh },
      environment: {
        ...common,
        AUTHORITY_EXPIRES_AT: isoSeconds(Date.now() + 60 * 60 * 1_000),
        QUALIFICATION_EXPIRES_AT: isoSeconds(Date.now() + 60 * 60 * 1_000),
        FAKE_MAIN_SHA: '3'.repeat(40),
      },
    })

    const expiring = await runWorkflowScript({
      script,
      executables: { gh: mergeGh },
      environment: {
        ...common,
        AUTHORITY_EXPIRES_AT: isoSeconds(Date.now() + 5 * 60 * 1_000),
        QUALIFICATION_EXPIRES_AT: isoSeconds(Date.now() + 60 * 60 * 1_000),
        FAKE_MAIN_SHA: base,
      },
    })

    try {
      expect(changedBase.exitCode).not.toBe(0)
      expect(changedBase.stderr).toContain('activation-base-changed')
      expect(expiring.exitCode).not.toBe(0)
      expect(expiring.stderr).toContain('authority-window-too-short')
    } finally {
      changedBase.dispose()
      expiring.dispose()
    }
  })

  test('refuses an activation base retarget with the same base SHA immediately before merge', async () => {
    const head = '1'.repeat(40)
    const base = '2'.repeat(40)
    const expiry = isoSeconds(Date.now() + 60 * 60 * 1_000)
    const result = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Merge only a clean exact-head protected activation PR'),
      executables: {
        gh: `
case "$*" in
  *"pulls/1/merge"*)
    printf '%s\n' merge >> "${'${FAKE_MERGE_LOG}'}"
    printf '%s\n' '{"merged":true}'
    ;;
  *"git/ref/heads/"*) printf '%s\n' "${'${FAKE_HEAD_SHA}'}" ;;
  *"check-runs?filter=latest"*) printf '%s\n' '[{"total_count":1,"check_runs":[{"id":1,"status":"completed","conclusion":"success"}]}]' ;;
  *"commits/main"*) printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  *"api graphql"*)
    printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}'
    ;;
  *"pulls/2"*)
    printf '{"state":"open","head":{"sha":"%s","ref":"%s"},"base":{"ref":"main"},"merged_at":null}\n' \
      "${'${EXPECTED_ROLLBACK_SHA}'}" "${'${ROLLBACK_BRANCH}'}"
    ;;
  *"pulls/1"*)
    count=0
    [[ -s "${'${FAKE_PULL_COUNTER}'}" ]] && count="$(cat "${'${FAKE_PULL_COUNTER}'}")"
    count=$((count + 1))
    printf '%s' "${'${count}'}" > "${'${FAKE_PULL_COUNTER}'}"
    base_ref=main
    [[ "${'${count}'}" -gt 1 ]] && base_ref=retargeted
    printf '{"head":{"sha":"%s"},"base":{"ref":"%s","sha":"%s"},"mergeable_state":"clean","merged_at":null}\n' \
      "${'${FAKE_HEAD_SHA}'}" "${'${base_ref}'}" "${'${FAKE_MAIN_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 90 ;;
esac
`,
      },
      environment: {
        ...activationRollbackEnvironment,
        ACTIVATION_BRANCH: 'codex/test',
        EXPECTED_ACTIVATION_SHA: head,
        AUTHORITY_EXPIRES_AT: expiry,
        QUALIFICATION_EXPIRES_AT: expiry,
        EXPECTED_BASE_SHA: base,
        PR_NUMBER: '1',
        FAKE_HEAD_SHA: head,
        FAKE_MAIN_SHA: base,
        FAKE_MERGE_LOG: 'merge.log',
        FAKE_PULL_COUNTER: 'pull-counter',
      },
    })
    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('activation-base-changed')
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('rechecks qualification freshness after the review wait and before merge', async () => {
    const script = scriptFor('activate-and-observe', 'Merge only a clean exact-head protected activation PR')
    const initialEpoch = Math.floor(Date.now() / 1_000)
    const expiry = isoSeconds((initialEpoch + 20 * 60) * 1_000)
    const result = await runWorkflowScript({
      script,
      executables: {
        gh: mergeGh,
        date: `
if [[ "$*" == *" -d "* || "$1" == "-d" || "${'${2:-}'}" == "-d" ]]; then
  exec python3 - "$@" <<'PY'
import datetime
import sys
args = sys.argv[1:]
index = args.index('-d')
instant = datetime.datetime.fromisoformat(args[index + 1].replace('Z', '+00:00'))
print(int(instant.timestamp()))
PY
fi
count=0
[[ -s "${'${FAKE_DATE_COUNTER}'}" ]] && count="$(cat "${'${FAKE_DATE_COUNTER}'}")"
count=$((count + 1))
printf '%s' "${'${count}'}" > "${'${FAKE_DATE_COUNTER}'}"
if [[ "${'${count}'}" == 1 ]]; then printf '%s\n' "${'${FAKE_NOW_INITIAL}'}"; else printf '%s\n' "${'${FAKE_NOW_LATER}'}"; fi
`,
      },
      environment: {
        ...activationRollbackEnvironment,
        ACTIVATION_BRANCH: 'codex/test',
        EXPECTED_ACTIVATION_SHA: '1'.repeat(40),
        AUTHORITY_EXPIRES_AT: expiry,
        QUALIFICATION_EXPIRES_AT: expiry,
        EXPECTED_BASE_SHA: '2'.repeat(40),
        PR_NUMBER: '1',
        FAKE_HEAD_SHA: '1'.repeat(40),
        FAKE_MAIN_SHA: '2'.repeat(40),
        FAKE_PULL_BASE_SHA: '2'.repeat(40),
        FAKE_MERGE_LOG: join(tmpdir(), `bayn-paper-merge-${crypto.randomUUID()}`),
        FAKE_DATE_COUNTER: join(tmpdir(), `bayn-paper-date-${crypto.randomUUID()}`),
        FAKE_NOW_INITIAL: String(initialEpoch),
        FAKE_NOW_LATER: String(initialEpoch + 21 * 60),
      },
    })

    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('qualification-stale')
    } finally {
      result.dispose()
    }
  })

  test('refuses an activation branch replacement before the merge job starts', async () => {
    const expected = '1'.repeat(40)
    const replacement = '9'.repeat(40)
    const result = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Merge only a clean exact-head protected activation PR'),
      executables: { gh: mergeGh },
      environment: {
        ...activationRollbackEnvironment,
        ACTIVATION_BRANCH: 'codex/test',
        EXPECTED_ACTIVATION_SHA: expected,
        AUTHORITY_EXPIRES_AT: isoSeconds(Date.now() + 60 * 60 * 1_000),
        QUALIFICATION_EXPIRES_AT: isoSeconds(Date.now() + 60 * 60 * 1_000),
        EXPECTED_BASE_SHA: '2'.repeat(40),
        PR_NUMBER: '1',
        FAKE_HEAD_SHA: replacement,
        FAKE_MAIN_SHA: '2'.repeat(40),
        FAKE_PULL_BASE_SHA: '2'.repeat(40),
        FAKE_MERGE_LOG: 'merge.log',
      },
    })

    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('activation-head-changed')
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('refuses a force-pushed rollback branch before rebasing its metadata', async () => {
    const expected = '4'.repeat(40)
    const replacement = '9'.repeat(40)
    const result = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Rebase the precommitted rollback tree onto activated main'),
      executables: {
        gh: `
case "$*" in
  "auth setup-git") exit 0 ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 96 ;;
esac
`,
        git: `
case "$*" in
  "config "*|"fetch "*) exit 0 ;;
  "rev-parse origin/main") printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  "rev-parse origin/${'${ROLLBACK_BRANCH}'}") printf '%s\n' "${'${FAKE_REPLACEMENT_SHA}'}" ;;
  *"push "*) printf '%s\n' push >> "${'${FAKE_PUSH_LOG}'}" ;;
  *) printf 'unexpected git invocation: %s\n' "$*" >&2; exit 97 ;;
esac
`,
      },
      environment: {
        EXPECTED_ROLLBACK_SHA: expected,
        EXPECTED_ROLLBACK_METADATA_B64: 'metadata',
        ROLLBACK_BRANCH: 'codex/bayn-paper-rollback/test',
        FAKE_MAIN_SHA: '5'.repeat(40),
        FAKE_REPLACEMENT_SHA: replacement,
        FAKE_PUSH_LOG: 'push.log',
      },
    })
    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('rollback-precommit-changed')
      expect(existsSync(join(result.root, 'push.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('refuses to rebase its rollback over a foreign PAPER generation', async () => {
    const activationBranch = 'codex/bayn-paper-activation/test'
    const rollbackBranch = 'codex/bayn-paper-rollback/test'
    const expectedRollbackSha = '4'.repeat(40)
    const mainSha = '5'.repeat(40)
    const authorityGenerationHash = '8'.repeat(64)
    const observeGenerationHash = '7'.repeat(64)
    const previousObserveGenerationHash = '6'.repeat(64)
    const metadata = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        activationId: 'test',
        activationBranch,
        rollbackBranch,
        sourceMainSha: mainSha,
        authorityGenerationHash,
        previousObserveGenerationHash,
        observeAuthorityGenerationHash: observeGenerationHash,
        authorityExpiresAt: '2026-07-31T13:00:00Z',
        baselineCycleId: '',
        workflowRunId: 77,
        workflowRunAttempt: 1,
      }),
    ).toString('base64')
    const result = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Rebase the precommitted rollback tree onto activated main'),
      executables: {
        gh: `
case "$*" in
  "auth setup-git") exit 0 ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 96 ;;
esac
`,
        git: `
case "$*" in
  "config "*|"fetch "*) exit 0 ;;
  "rev-parse origin/main") printf '%s\n' "${'${FAKE_MAIN_SHA}'}" ;;
  "rev-parse origin/${'${ROLLBACK_BRANCH}'}") printf '%s\n' "${'${EXPECTED_ROLLBACK_SHA}'}" ;;
  "show -s --format=%B ${'${EXPECTED_ROLLBACK_SHA}'}")
    printf 'chore(bayn): rollback\n\nBAYN_PAPER_ROLLBACK_METADATA=%s\n' "${'${EXPECTED_ROLLBACK_METADATA_B64}'}"
    ;;
  "show ${'${FAKE_MAIN_SHA}'}:argocd/applications/bayn/deployment.yaml") printf '%s\n' 'foreign paper manifest' ;;
  *"push "*) printf '%s\n' push >> "${'${FAKE_PUSH_LOG}'}" ;;
  *) printf 'unexpected git invocation: %s\n' "$*" >&2; exit 97 ;;
esac
`,
        bun: `
mode=''
output=''
previous=''
for argument in "$@"; do
  if [[ "${'${previous}'}" == --mode ]]; then mode="${'${argument}'}"; fi
  if [[ "${'${previous}'}" == --output ]]; then output="${'${argument}'}"; fi
  previous="${'${argument}'}"
done
case "${'${mode}'}" in
  inspect-deployment-authority)
    printf '{"maximumAuthority":"PAPER","brokerAccess":"mutation","capitalAuthority":"sandbox-capital","authorityGenerationHash":"%s"}\n' \
      "${'${FAKE_FOREIGN_GENERATION}'}" > "${'${output}'}"
    ;;
  render-rollback) printf '%s\n' render >> "${'${FAKE_RENDER_LOG}'}" ;;
  *) printf 'unexpected bun mode: %s\n' "${'${mode}'}" >&2; exit 98 ;;
esac
`,
      },
      environment: {
        ACTIVATION_BRANCH: activationBranch,
        ACTIVATION_ID: 'test',
        AUTHORITY_EXPIRES_AT: '2026-07-31T13:00:00Z',
        AUTHORITY_GENERATION_HASH: authorityGenerationHash,
        BASELINE_CYCLE_ID: '',
        EXPECTED_ROLLBACK_METADATA_B64: metadata,
        EXPECTED_ROLLBACK_SHA: expectedRollbackSha,
        GITHUB_RUN_ID: '77',
        GITHUB_RUN_ATTEMPT: '1',
        OBSERVE_AUTHORITY_GENERATION_HASH: observeGenerationHash,
        PREVIOUS_OBSERVE_AUTHORITY_GENERATION_HASH: previousObserveGenerationHash,
        ROLLBACK_BRANCH: rollbackBranch,
        SOURCE_MAIN_SHA: mainSha,
        FAKE_MAIN_SHA: mainSha,
        FAKE_FOREIGN_GENERATION: '9'.repeat(64),
        FAKE_PUSH_LOG: 'push.log',
        FAKE_RENDER_LOG: 'render.log',
      },
    })
    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('foreign-paper-generation')
      expect(existsSync(join(result.root, 'render.log'))).toBe(false)
      expect(existsSync(join(result.root, 'push.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('accepts an OBSERVE baseline with resolved historical mutations', async () => {
    const baseline = paperStatus({
      checkedAt: isoSeconds(Date.now()),
      access: 'read-only',
      capital: 'none',
      maximum: 'observe',
      effective: 'observe',
      zeroMutation: false,
      mutationEventCount: 4,
      unresolvedMutationCount: 0,
      coversLatestMutation: true,
      last: { cycleId: 'historical-terminal-cycle', phase: 'COMPLETED' },
    })
    const result = await runWorkflowScript({
      script: scriptFor('verify-and-prepare', 'Capture exact OBSERVE baseline before any GitOps write'),
      executables: { curl: `cat "${'${FAKE_STATUS}'}"` },
      files: { 'status.json': baseline },
      environment: { FAKE_STATUS: 'status.json' },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.githubOutput).toContain('baseline_cycle_id=historical-terminal-cycle')
    } finally {
      result.dispose()
    }
  })

  test('waits through OBSERVE rollout lag before recording PAPER visibility', async () => {
    const script = scriptFor('activate-and-observe', 'Wait for the verified PAPER rollout')
    const checkedAt = isoSeconds(Date.now() - 10_000)
    const transitional = paperStatus({
      checkedAt,
      access: 'read-only',
      capital: 'none',
      maximum: 'observe',
      effective: 'observe',
    })
    const ready = paperStatus({ checkedAt, last: { cycleId: 'baseline-cycle' } })
    const result = await runWorkflowScript({
      script,
      executables: {
        curl: `
count=0
[[ -s "${'${FAKE_COUNTER}'}" ]] && count="$(cat "${'${FAKE_COUNTER}'}")"
count=$((count + 1))
printf '%s' "${'${count}'}" > "${'${FAKE_COUNTER}'}"
if [[ "${'${count}'}" == 1 ]]; then cat "${'${FAKE_STATUS_ONE}'}"; else cat "${'${FAKE_STATUS_TWO}'}"; fi
`,
        sleep: 'exit 0',
      },
      files: { 'status-one.json': transitional, 'status-two.json': ready },
      environment: {
        ACTIVATION_MERGED_AT: isoSeconds(Date.now() - 60_000),
        AUTHORITY_EXPIRES_AT: isoSeconds(Date.now() + 60 * 60 * 1_000),
        AUTHORITY_GENERATION_HASH: 'f'.repeat(64),
        EXPECTED_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
        EXPECTED_SOURCE_SHA: 'b'.repeat(40),
        PREACTIVATION_BASELINE_CYCLE_ID: 'baseline-cycle',
        FAKE_COUNTER: join(tmpdir(), `bayn-paper-curl-${crypto.randomUUID()}`),
        FAKE_STATUS_ONE: 'status-one.json',
        FAKE_STATUS_TWO: 'status-two.json',
      },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.githubOutput).toContain('paper_baseline_last_cycle_id=baseline-cycle')
      expect(result.githubOutput).toContain(`paper_rollout_observed_at=${checkedAt}`)
    } finally {
      result.dispose()
    }
  })

  test('counts a terminal cycle completed before the first PAPER status poll', async () => {
    const nowMs = Date.now()
    const checkedAt = isoSeconds(nowMs)
    const activationMergedAt = isoSeconds(nowMs - 10_000)
    const fastTerminal = paperStatus({
      checkedAt,
      authorityUpdatedAt: isoSeconds(nowMs - 8_000),
      last: {
        cycleId: 'fast-paper-cycle',
        phase: 'NO_TRADE',
        createdAt: isoSeconds(nowMs - 5_000),
      },
    })
    const rollout = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Wait for the verified PAPER rollout'),
      executables: { curl: `cat "${'${FAKE_STATUS}'}"`, sleep: 'exit 0' },
      files: { 'status.json': fastTerminal },
      environment: {
        ACTIVATION_MERGED_AT: activationMergedAt,
        AUTHORITY_EXPIRES_AT: isoSeconds(Date.now() + 60 * 60 * 1_000),
        AUTHORITY_GENERATION_HASH: 'f'.repeat(64),
        EXPECTED_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
        EXPECTED_SOURCE_SHA: 'b'.repeat(40),
        PREACTIVATION_BASELINE_CYCLE_ID: 'observe-baseline-cycle',
        FAKE_STATUS: 'status.json',
      },
    })
    expect(rollout.exitCode, rollout.stderr).toBe(0)
    expect(rollout.githubOutput).toContain('paper_baseline_last_cycle_id=observe-baseline-cycle')
    expect(rollout.githubOutput).toContain('paper_initial_terminal_cycle_id=fast-paper-cycle')
    rollout.dispose()

    const observe = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Observe exactly one new natural scheduled cycle'),
      executables: { curl: 'printf "observer must not wait for a second cycle\\n" >&2; exit 96' },
      files: { 'bayn-paper-observation/rollout-status.json': fastTerminal },
      environment: {
        ACTIVATION_MERGED_AT: activationMergedAt,
        AUTHORITY_EXPIRES_AT: isoSeconds(Date.now() + 60 * 60 * 1_000),
        AUTHORITY_GENERATION_HASH: 'f'.repeat(64),
        BASELINE_CURRENT_CYCLE_ID: '',
        BASELINE_LAST_CYCLE_ID: 'observe-baseline-cycle',
        EXPECTED_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
        EXPECTED_SOURCE_SHA: 'b'.repeat(40),
        INITIAL_TERMINAL_CYCLE_ID: 'fast-paper-cycle',
        PAPER_ROLLOUT_OBSERVED_AT: checkedAt,
      },
    })
    try {
      expect(observe.exitCode, observe.stderr).toBe(0)
      expect(observe.githubOutput).toContain('observation=terminal_success')
      expect(observe.stderr).not.toContain('observer must not wait for a second cycle')
      const proof = JSON.parse(readFileSync(join(observe.root, 'bayn-paper-observation/proof.json'), 'utf8')) as {
        readonly observedCycleId: string
      }
      expect(proof.observedCycleId).toBe('fast-paper-cycle')
    } finally {
      observe.dispose()
    }
  })

  test('tracks a cycle already active under the reviewed PAPER generation to terminal', async () => {
    const secondBoundary = Math.floor(Date.now() / 1_000) * 1_000
    const checkedAt = new Date(secondBoundary + 900).toISOString()
    const activationMergedAt = new Date(secondBoundary + 100).toISOString()
    const authorityUpdatedAt = new Date(secondBoundary + 200).toISOString()
    const createdAt = new Date(secondBoundary + 300).toISOString()
    const active = paperStatus({
      checkedAt,
      authorityUpdatedAt,
      current: { cycleId: 'already-active-paper-cycle', phase: 'ACTIVE', createdAt },
      last: {
        cycleId: 'observe-baseline-cycle',
        phase: 'NO_TRADE',
        createdAt: new Date(secondBoundary - 60_000).toISOString(),
      },
    })
    const terminal = paperStatus({
      checkedAt: new Date(secondBoundary + 5_000).toISOString(),
      authorityUpdatedAt,
      last: { cycleId: 'already-active-paper-cycle', phase: 'COMPLETED', createdAt },
    })
    const rollout = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Wait for the verified PAPER rollout'),
      executables: { curl: `cat "${'${FAKE_STATUS}'}"`, sleep: 'exit 0' },
      files: { 'status.json': active },
      environment: {
        ACTIVATION_MERGED_AT: activationMergedAt,
        AUTHORITY_EXPIRES_AT: isoSeconds(secondBoundary + 60 * 60 * 1_000),
        AUTHORITY_GENERATION_HASH: 'f'.repeat(64),
        EXPECTED_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
        EXPECTED_SOURCE_SHA: 'b'.repeat(40),
        PREACTIVATION_BASELINE_CYCLE_ID: 'observe-baseline-cycle',
        FAKE_STATUS: 'status.json',
      },
    })
    expect(rollout.exitCode, rollout.stderr).toBe(0)
    expect(rollout.githubOutput).toContain('paper_baseline_current_cycle_id=already-active-paper-cycle')
    rollout.dispose()

    const observe = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Observe exactly one new natural scheduled cycle'),
      executables: { curl: `cat "${'${FAKE_STATUS}'}"`, sleep: 'exit 0' },
      files: {
        'bayn-paper-observation/rollout-status.json': active,
        'terminal-status.json': terminal,
      },
      environment: {
        ACTIVATION_MERGED_AT: activationMergedAt,
        AUTHORITY_EXPIRES_AT: isoSeconds(secondBoundary + 60 * 60 * 1_000),
        AUTHORITY_GENERATION_HASH: 'f'.repeat(64),
        BASELINE_CURRENT_CYCLE_ID: 'already-active-paper-cycle',
        BASELINE_LAST_CYCLE_ID: 'observe-baseline-cycle',
        EXPECTED_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
        EXPECTED_SOURCE_SHA: 'b'.repeat(40),
        INITIAL_TERMINAL_CYCLE_ID: '',
        PAPER_ROLLOUT_OBSERVED_AT: checkedAt,
        FAKE_STATUS: 'terminal-status.json',
      },
    })
    try {
      expect(observe.exitCode, observe.stderr).toBe(0)
      expect(observe.githubOutput).toContain('observation=terminal_success')
      const proof = JSON.parse(readFileSync(join(observe.root, 'bayn-paper-observation/proof.json'), 'utf8')) as {
        readonly observedCycleId: string
      }
      expect(proof.observedCycleId).toBe('already-active-paper-cycle')
    } finally {
      observe.dispose()
    }
  })

  test('rejects an intervening OBSERVE terminal cycle at the first PAPER status poll', async () => {
    const nowMs = Date.now()
    const status = paperStatus({
      checkedAt: isoSeconds(nowMs),
      authorityUpdatedAt: isoSeconds(nowMs - 10_000),
      last: {
        cycleId: 'intervening-observe-cycle',
        phase: 'COMPLETED',
        createdAt: isoSeconds(nowMs - 15_000),
      },
    })
    const result = await runWorkflowScript({
      script: scriptFor('activate-and-observe', 'Wait for the verified PAPER rollout'),
      executables: { curl: `cat "${'${FAKE_STATUS}'}"`, sleep: 'exit 0' },
      files: { 'status.json': status },
      environment: {
        ACTIVATION_MERGED_AT: isoSeconds(nowMs - 20_000),
        AUTHORITY_EXPIRES_AT: isoSeconds(nowMs + 60 * 60 * 1_000),
        AUTHORITY_GENERATION_HASH: 'f'.repeat(64),
        EXPECTED_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
        EXPECTED_SOURCE_SHA: 'b'.repeat(40),
        PREACTIVATION_BASELINE_CYCLE_ID: 'observe-baseline-cycle',
        FAKE_STATUS: 'status.json',
      },
    })
    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('initial-cycle-before-paper-authority')
    } finally {
      result.dispose()
    }
  })

  test('accepts one resolved-trade terminal cycle first created after PAPER became visible', async () => {
    const script = scriptFor('activate-and-observe', 'Observe exactly one new natural scheduled cycle')
    const rolloutAt = isoSeconds(Date.now() - 5 * 60 * 1_000)
    const createdAt = isoSeconds(Date.now() - 4 * 60 * 1_000)
    const active = paperStatus({
      checkedAt: isoSeconds(Date.now()),
      current: { cycleId: 'fresh-paper-cycle', phase: 'ACTIVE', createdAt },
      last: { cycleId: 'baseline-cycle', phase: 'NO_TRADE', createdAt: rolloutAt },
    })
    const terminal = paperStatus({
      checkedAt: isoSeconds(Date.now()),
      zeroMutation: false,
      mutationEventCount: 2,
      unresolvedMutationCount: 0,
      coversLatestMutation: true,
      last: { cycleId: 'fresh-paper-cycle', phase: 'COMPLETED', createdAt },
    })
    const result = await runWorkflowScript({
      script,
      executables: {
        curl: `
count=0
[[ -s "${'${FAKE_COUNTER}'}" ]] && count="$(cat "${'${FAKE_COUNTER}'}")"
count=$((count + 1))
printf '%s' "${'${count}'}" > "${'${FAKE_COUNTER}'}"
if [[ "${'${count}'}" == 1 ]]; then cat "${'${FAKE_STATUS_ONE}'}"; else cat "${'${FAKE_STATUS_TWO}'}"; fi
`,
        sleep: 'exit 0',
      },
      files: {
        'bayn-paper-observation/rollout-status.json': active,
        'status-one.json': active,
        'status-two.json': terminal,
      },
      environment: {
        ACTIVATION_MERGED_AT: isoSeconds(Date.parse(rolloutAt) - 60_000),
        AUTHORITY_EXPIRES_AT: isoSeconds(Date.now() + 60 * 60 * 1_000),
        AUTHORITY_GENERATION_HASH: 'f'.repeat(64),
        BASELINE_CURRENT_CYCLE_ID: '',
        BASELINE_LAST_CYCLE_ID: 'baseline-cycle',
        EXPECTED_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
        EXPECTED_SOURCE_SHA: 'b'.repeat(40),
        INITIAL_TERMINAL_CYCLE_ID: '',
        PAPER_ROLLOUT_OBSERVED_AT: rolloutAt,
        FAKE_COUNTER: join(tmpdir(), `bayn-paper-curl-${crypto.randomUUID()}`),
        FAKE_STATUS_ONE: 'status-one.json',
        FAKE_STATUS_TWO: 'status-two.json',
      },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.githubOutput).toContain('observation=terminal_success')
      const proof = JSON.parse(readFileSync(join(result.root, 'bayn-paper-observation/proof.json'), 'utf8')) as {
        readonly observedCycleId: string
        readonly authorityGenerationHash: string
      }
      expect(proof.observedCycleId).toBe('fresh-paper-cycle')
      expect(proof.authorityGenerationHash).toBe('f'.repeat(64))
    } finally {
      result.dispose()
    }
  })

  test('rejects a terminal cycle created before PAPER visibility', async () => {
    const script = scriptFor('activate-and-observe', 'Observe exactly one new natural scheduled cycle')
    const rolloutAt = isoSeconds(Date.now() - 5 * 60 * 1_000)
    const stale = paperStatus({
      checkedAt: isoSeconds(Date.now()),
      last: {
        cycleId: 'stale-observe-cycle',
        phase: 'COMPLETED',
        createdAt: isoSeconds(Date.now() - 6 * 60 * 1_000),
      },
    })
    const result = await runWorkflowScript({
      script,
      executables: { curl: `cat "${'${FAKE_STATUS}'}"`, sleep: 'exit 0' },
      files: { 'bayn-paper-observation/rollout-status.json': stale, 'status.json': stale },
      environment: {
        ACTIVATION_MERGED_AT: isoSeconds(Date.parse(rolloutAt) - 60_000),
        AUTHORITY_EXPIRES_AT: isoSeconds(Date.now() + 60 * 60 * 1_000),
        AUTHORITY_GENERATION_HASH: 'f'.repeat(64),
        BASELINE_CURRENT_CYCLE_ID: '',
        BASELINE_LAST_CYCLE_ID: 'baseline-cycle',
        EXPECTED_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
        EXPECTED_SOURCE_SHA: 'b'.repeat(40),
        INITIAL_TERMINAL_CYCLE_ID: '',
        PAPER_ROLLOUT_OBSERVED_AT: rolloutAt,
        FAKE_STATUS: 'status.json',
      },
    })
    try {
      expect(result.exitCode).not.toBe(0)
      const proof = JSON.parse(readFileSync(join(result.root, 'bayn-paper-observation/proof.json'), 'utf8')) as {
        readonly outcome: string
      }
      expect(proof.outcome).toBe('cycle-not-started-under-visible-paper')
    } finally {
      result.dispose()
    }
  })

  test('restores committed PAPER GitOps even when the serving runtime reports OBSERVE', async () => {
    const result = await runWatchdog(
      paperStatus({
        checkedAt: isoSeconds(Date.now()),
        access: 'read-only',
        capital: 'none',
        maximum: 'observe',
        effective: 'observe',
      }),
    )
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(existsSync(join(result.root, 'merge.log')), `${result.stdout}\n${result.stderr}`).toBe(true)
      expect(readFileSync(join(result.root, 'merge.log'), 'utf8')).toContain('merge')
    } finally {
      result.dispose()
    }
  })

  test('watchdog consumes automatic protected checks without a manual review trigger', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }))
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'merge.log'), 'utf8')).toContain('merge')
      expect(result.stderr).not.toContain('manual review trigger is prohibited')
    } finally {
      result.dispose()
    }
  })

  test('watchdog discovers recovery from the authenticated attestation without listing rollback branches', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }))
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'merge.log'), 'utf8')).toContain('merge')
      expect(result.stderr).not.toContain('branch-first watchdog discovery is prohibited')
    } finally {
      result.dispose()
    }
  })

  test('watchdog rejects an attestation artifact from another producer before opening its archive', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }), {
      artifactProducerRunId: 2,
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'artifact-scan.log'), 'utf8')).toContain('scan')
      expect(existsSync(join(result.root, 'artifact-open.log'))).toBe(false)
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('watchdog restores an exact foreign-base activation after its PAPER generation reaches current main', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }), {
      activationBaseRef: 'staging',
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'artifact-open.log'), 'utf8')).toContain('open')
      expect(readFileSync(join(result.root, 'merge.log'), 'utf8')).toContain('merge')
    } finally {
      result.dispose()
    }
  })

  test('watchdog accepts a retained earlier-attempt attestation after a later rerun fails early', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }), {
      latestRunAttempt: 2,
      attestationAttempt: 1,
    })

    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'merge.log'), 'utf8')).toContain('merge')
    } finally {
      result.dispose()
    }
  })

  test('watchdog authenticates the dispatch head separately from the later exact-main source', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }))
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'merge.log'), 'utf8')).toContain('merge')
    } finally {
      result.dispose()
    }
  })

  test('watchdog performs one artifact scan with thousands of unrelated retained artifacts', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }), {
      unrelatedArtifactCount: 2184,
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'artifact-scan.log'), 'utf8').trim().split('\n')).toHaveLength(1)
      expect(result.stderr).not.toContain('per-run artifact discovery is prohibited')
      expect(readFileSync(join(result.root, 'merge.log'), 'utf8')).toContain('merge')
    } finally {
      result.dispose()
    }
  })

  test('watchdog exits on committed OBSERVE before any artifact discovery', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }), { gitopsObserve: true })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain('GitOps already declares OBSERVE; no rollback discovery is required.')
      expect(existsSync(join(result.root, 'artifact-scan.log'))).toBe(false)
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('watchdog recreates a deleted rollback branch from the authenticated workflow attestation', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }), { branchMissing: true })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'push.log'), 'utf8')).toContain('push')
      expect(readFileSync(join(result.root, 'pr-create.log'), 'utf8')).toContain('create')
      expect(readFileSync(join(result.root, 'merge.log'), 'utf8')).toContain('merge')
    } finally {
      result.dispose()
    }
  })

  test('watchdog recreates an exact main rollback PR after the prior PR merged into a foreign base', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }), {
      foreignBaseMergedOnly: true,
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(result.root, 'pr-create.log'), 'utf8')).toContain('create')
      expect(readFileSync(join(result.root, 'merge.log'), 'utf8')).toContain('merge')
    } finally {
      result.dispose()
    }
  })

  test('watchdog rejects self-authored rollback metadata without the exact workflow attestation', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }), {
      attestationMatches: false,
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain('rollback metadata is malformed or does not match the attestation')
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
      expect(existsSync(join(result.root, 'pr-create.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('watchdog refuses to apply an old rollback to a later PAPER generation', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }), {
      expected: '8'.repeat(64),
      current: '9'.repeat(64),
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain('current PAPER generation belongs to another activation')
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('closes an exact unmerged activation before skipping OBSERVE rollback', async () => {
    const exactHead = '1'.repeat(40)
    const result = await runWorkflowScript({
      script: scriptFor('rollback', 'Determine whether activation merged'),
      executables: {
        gh: `
case "$*" in
  *"--method PATCH"*"pulls/41"*)
    printf '%s\n' close >> "${'${FAKE_ACTIVATION_CLOSE_LOG}'}"
    printf '%s\n' '{"state":"closed"}'
    ;;
  *"pulls/41"*)
    state=open
    [[ -s "${'${FAKE_ACTIVATION_CLOSE_LOG}'}" ]] && state=closed
    printf '{"state":"%s","head":{"sha":"%s"},"merged_at":null}\n' "${'${state}'}" "${'${EXPECTED_ACTIVATION_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 97 ;;
esac
`,
      },
      environment: {
        EXPECTED_ACTIVATION_SHA: exactHead,
        PR_NUMBER: '41',
        FAKE_ACTIVATION_CLOSE_LOG: 'activation-close.log',
      },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.githubOutput).toContain('restore=false')
      expect(readFileSync(join(result.root, 'activation-close.log'), 'utf8')).toContain('close')
    } finally {
      result.dispose()
    }
  })

  test('skips rollback after the exact activation merged only into a foreign base', async () => {
    const exactHead = '1'.repeat(40)
    const result = await runWorkflowScript({
      script: scriptFor('rollback', 'Determine whether activation merged'),
      executables: {
        gh: `
case "$*" in
  *"pulls/41"*)
    printf '{"state":"closed","head":{"sha":"%s"},"base":{"ref":"staging"},"merged_at":"2026-07-31T00:05:00Z"}\n' \
      "${'${EXPECTED_ACTIVATION_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 97 ;;
esac
`,
      },
      environment: { EXPECTED_ACTIVATION_SHA: exactHead, PR_NUMBER: '41' },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.githubOutput).toContain('restore=false')
      expect(result.stdout).toContain('merged only into a foreign base')
    } finally {
      result.dispose()
    }
  })

  test('retains fail-closed rollback after the exact activation merged into main', async () => {
    const exactHead = '1'.repeat(40)
    const result = await runWorkflowScript({
      script: scriptFor('rollback', 'Determine whether activation merged'),
      executables: {
        gh: `
case "$*" in
  *"pulls/41"*)
    printf '{"state":"closed","head":{"sha":"%s"},"base":{"ref":"main"},"merged_at":"2026-07-31T00:05:00Z"}\n' \
      "${'${EXPECTED_ACTIVATION_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 97 ;;
esac
`,
      },
      environment: { EXPECTED_ACTIVATION_SHA: exactHead, PR_NUMBER: '41' },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.githubOutput).toContain('restore=true')
      expect(result.stdout).not.toContain('merged only into a foreign base')
    } finally {
      result.dispose()
    }
  })

  test('retains fail-closed rollback for ambiguous activation state', async () => {
    const exactHead = '1'.repeat(40)
    const result = await runWorkflowScript({
      script: scriptFor('rollback', 'Determine whether activation merged'),
      executables: {
        gh: `
case "$*" in
  *"pulls/41"*)
    printf '{"state":"closed","head":{"sha":"%s"},"merged_at":"2026-07-31T00:05:00Z"}\n' \
      "${'${EXPECTED_ACTIVATION_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 97 ;;
esac
`,
      },
      environment: { EXPECTED_ACTIVATION_SHA: exactHead, PR_NUMBER: '41' },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.githubOutput).toContain('restore=true')
      expect(result.stdout).not.toContain('merged only into a foreign base')
    } finally {
      result.dispose()
    }
  })

  test('retains fail-closed rollback when activation state is unavailable', async () => {
    const result = await runWorkflowScript({
      script: scriptFor('rollback', 'Determine whether activation merged'),
      executables: { gh: 'exit 1' },
      environment: { EXPECTED_ACTIVATION_SHA: '1'.repeat(40), PR_NUMBER: '41' },
    })
    try {
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.githubOutput).toContain('restore=true')
      expect(result.stderr).toContain('Activation PR state is unavailable; retaining fail-closed OBSERVE rollback.')
    } finally {
      result.dispose()
    }
  })

  test('owning rollback refuses a base retarget immediately before merge', async () => {
    const result = await runWorkflowScript({
      script: scriptFor('rollback', 'Merge only clean exact-head protected rollback'),
      executables: {
        gh: `
case "$*" in
  *"pulls/42/merge"*) printf '%s\n' merge >> "${'${FAKE_MERGE_LOG}'}"; printf '%s\n' '{"merged":true}' ;;
  *"api graphql"*)
    printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}'
    ;;
  *"check-runs?filter=latest"*) printf '%s\n' '[{"total_count":1,"check_runs":[{"id":1,"status":"completed","conclusion":"success"}]}]' ;;
  *"pulls/42"*)
    count=0
    [[ -s "${'${FAKE_PULL_COUNTER}'}" ]] && count="$(cat "${'${FAKE_PULL_COUNTER}'}")"
    count=$((count + 1))
    printf '%s' "${'${count}'}" > "${'${FAKE_PULL_COUNTER}'}"
    base_ref=main
    [[ "${'${count}'}" -gt 2 ]] && base_ref=retargeted
    printf '{"state":"open","head":{"sha":"%s"},"base":{"ref":"%s"},"mergeable_state":"clean"}\n' \
      "${'${FAKE_HEAD_SHA}'}" "${'${base_ref}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 97 ;;
esac
`,
        sleep: 'exit 0',
      },
      environment: {
        EXPECTED_ROLLBACK_SHA: 'a'.repeat(40),
        PR_NUMBER: '42',
        FAKE_HEAD_SHA: 'a'.repeat(40),
        FAKE_PULL_COUNTER: 'pull-counter',
        FAKE_MERGE_LOG: 'merge.log',
      },
    })

    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('rollback head or base changed immediately before merge')
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('owning rollback refuses a branch replacement before the merge job starts', async () => {
    const expected = 'a'.repeat(40)
    const replacement = 'b'.repeat(40)
    const result = await runWorkflowScript({
      script: scriptFor('rollback', 'Merge only clean exact-head protected rollback'),
      executables: {
        gh: `
case "$*" in
  *"pulls/42/merge"*) printf '%s\n' merge >> "${'${FAKE_MERGE_LOG}'}"; printf '%s\n' '{"merged":true}' ;;
  *"pulls/42"*)
    printf '{"state":"open","head":{"sha":"%s"},"base":{"ref":"main"},"mergeable_state":"clean"}\n' "${'${FAKE_REPLACEMENT_SHA}'}"
    ;;
  *) printf 'unexpected gh invocation: %s\n' "$*" >&2; exit 98 ;;
esac
`,
      },
      environment: {
        EXPECTED_ROLLBACK_SHA: expected,
        PR_NUMBER: '42',
        FAKE_REPLACEMENT_SHA: replacement,
        FAKE_MERGE_LOG: 'merge.log',
      },
    })
    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('rollback-head-changed')
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('watchdog refuses a base retarget immediately before merge', async () => {
    const result = await runWatchdog(paperStatus({ checkedAt: isoSeconds(Date.now()) }), {
      initialBaseRef: 'main',
      finalBaseRef: 'retargeted',
    })
    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('head or base changed immediately before merge')
      expect(existsSync(join(result.root, 'merge.log'))).toBe(false)
    } finally {
      result.dispose()
    }
  })

  test('always restores OBSERVE through the owning job and independent watchdog', () => {
    expect(parsed.jobs.rollback?.if ?? '').toContain('always()')
    expect(parsed.jobs.rollback?.if ?? '').toContain("needs.verify-and-prepare.outputs.live == 'true'")
    expect(workflow).toContain('--mode render-rollback')
    expect(workflow).toContain('Always restore reviewed OBSERVE GitOps state')
    expect(workflow).toContain("if: steps.activation_state.outputs.restore == 'true'")
    expect(workflow).toContain('Recover abandoned PAPER activation')
    expect(workflow).toContain('bayn-paper-rollback-watchdog')
    expect(workflow).toContain('--force-with-lease=')
    expect(workflow).toContain('--mode inspect-deployment-authority')
    expect(workflow).not.toContain('@codex review')
    expect(workflow).not.toContain('gh pr comment')
    expect(workflow).not.toContain('/reviews?per_page=100')
    expect(workflow).not.toContain('/reactions?per_page=100')
    expect(workflow).not.toContain('chatgpt-codex-connector[bot]')
    expect(workflow.match(/\.base\.ref/g)?.length ?? 0).toBeGreaterThanOrEqual(6)
    expect(count('-f sha="${')).toBe(3)
    expect(workflow).not.toContain('https://api.alpaca.markets')
    expect(workflow).not.toContain('value: live-capital-grant')
  })
})
