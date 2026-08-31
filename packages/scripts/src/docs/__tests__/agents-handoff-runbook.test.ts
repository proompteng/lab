import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

it('keeps Agents handoff shell snippets directly executable', () => {
  const runbook = readFileSync(join(repoRoot, 'docs/agents/designs/handoff-common.md'), 'utf8')
  const scriptsWorkflow = readFileSync(join(repoRoot, '.github/workflows/scripts-ci.yml'), 'utf8')

  expect(runbook).not.toContain('\\"')
  expect(runbook).toContain("rg -n '^kind: (Deployment|Service|CustomResourceDefinition)$' /tmp/agents.yaml | head")
  expect(runbook).toContain("kubectl get application -n argocd agents -o yaml | rg -n 'sync|health|revision'")
  expect(runbook).toContain("kubectl get crd | rg 'proompteng\\.ai'")
  expect(
    scriptsWorkflow.split('\n').filter((line) => line.trim() === "- 'docs/agents/designs/handoff-common.md'"),
  ).toHaveLength(2)
})

it('sanitizes the full Sealed Secrets key backup before restoring it', () => {
  const runbook = readFileSync(join(repoRoot, 'devices/galactic/docs/bootstrap-argocd.md'), 'utf8')
  const flake = readFileSync(join(repoRoot, 'flake.nix'), 'utf8')
  const scriptsWorkflow = readFileSync(join(repoRoot, '.github/workflows/scripts-ci.yml'), 'utf8')

  expect(runbook).toContain('SEALED_SECRETS_KEY_MANIFEST="$SEALED_SECRETS_BOOTSTRAP_DIR/controller-key.json"')
  expect(runbook).toContain('namespace: (.metadata.namespace // "sealed-secrets")')
  expect(runbook).toContain('labels: .metadata.labels')
  expect(runbook).toContain('type: .type')
  expect(runbook).toContain('data: .data')
  expect(runbook).toContain('chmod 600 "$SEALED_SECRETS_KEY_MANIFEST"')
  expect(runbook).toContain('--server-side --force-conflicts -f "$SEALED_SECRETS_KEY_MANIFEST" -o name')
  expect(runbook).toContain('argocd admin initial-password --kube-context "$GALACTIC_CONTEXT" -n argocd')
  expect(runbook).not.toContain('argocd admin initial-password -n argocd')
  expect(runbook).not.toContain('--server-side --force-conflicts -f "$SEALED_SECRETS_KEY_BACKUP_PATH" -o name')
  expect(flake).toContain('pkgs.kubeseal')
  expect(flake).toContain('pkgs.curl')
  expect(flake).toContain('pkgs.coreutils')
  expect(runbook).toContain('[ ! -f "$SEALED_SECRETS_KEY_BACKUP_PATH" ]')
  expect(runbook).toContain('[ -L "$SEALED_SECRETS_KEY_BACKUP_PATH" ]')
  expect(runbook).toContain('stat -c \'%u\' -- "$SEALED_SECRETS_KEY_BACKUP_PATH"')
  expect(runbook).toContain('stat -c \'%a\' -- "$SEALED_SECRETS_KEY_BACKUP_PATH"')
  expect(runbook).toContain('[ "$SEALED_SECRETS_KEY_BACKUP_MODE" != \'600\' ]')
  expect(runbook).toContain('SEALED_SECRETS_KEY_BACKUP_REALPATH="$(realpath -- "$SEALED_SECRETS_KEY_BACKUP_PATH")"')
  expect(runbook).toContain('"$REPO_ROOT"|"$REPO_ROOT"/*)')
  expect(
    scriptsWorkflow.split('\n').filter((line) => line.trim() === "- 'devices/galactic/docs/bootstrap-argocd.md'"),
  ).toHaveLength(2)
})
