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

it('gates the auto-syncing root handoff on MetalLB readiness', () => {
  const bootstrapRunbook = readFileSync(join(repoRoot, 'devices/galactic/docs/bootstrap-argocd.md'), 'utf8')
  const applicationSetsRunbook = readFileSync(join(repoRoot, 'argocd/applicationsets/README.md'), 'utf8')
  const bootstrapApplicationSet = readFileSync(join(repoRoot, 'argocd/applicationsets/bootstrap.yaml'), 'utf8')

  const metallbEntry = bootstrapApplicationSet.match(
    /                - name: metallb-system\n[\s\S]*?(?=\n                - name:)/,
  )?.[0]
  const gateIndex = applicationSetsRunbook.indexOf('**Bootstrap MetalLB before the root handoff.**')
  const rootHandoffIndex = applicationSetsRunbook.indexOf(
    'kubectl --context "$GALACTIC_CONTEXT" -n argocd apply -f argocd/root.yaml',
  )

  expect(metallbEntry).toContain('automation: manual')
  expect(bootstrapRunbook).toContain('## Bootstrap MetalLB before the root handoff')
  expect(bootstrapRunbook).toContain('kustomize build --enable-helm argocd/applications/metallb-system')
  expect(bootstrapRunbook).toContain('select(.kind != "IPAddressPool" and .kind != "L2Advertisement")')
  expect(bootstrapRunbook).toContain('select(.kind == "IPAddressPool" or .kind == "L2Advertisement")')
  expect(bootstrapRunbook).toContain('wait --for=condition=Established --timeout=120s')
  expect(bootstrapRunbook).toContain('deployment/controller --timeout=300s')
  expect(bootstrapRunbook).toContain('daemonset/speaker --timeout=300s')
  expect(bootstrapRunbook).toContain('ipaddresspool.metallb.io/metallb-ip-pool')
  expect(bootstrapRunbook).toContain('l2advertisement.metallb.io/metallb-l2-advertisement')
  expect(gateIndex).toBeGreaterThan(-1)
  expect(rootHandoffIndex).toBeGreaterThan(gateIndex)
  expect(applicationSetsRunbook).toContain(
    "--for=jsonpath='{.status.sync.status}'=Synced application/metallb-system --timeout=300s",
  )
  expect(applicationSetsRunbook).toContain(
    "--for=jsonpath='{.status.health.status}'=Healthy application/metallb-system --timeout=300s",
  )
  expect(applicationSetsRunbook).toContain(
    "--for=jsonpath='{.status.loadBalancer.ingress[0].ip}'=100.100.244.181 service/traefik --timeout=300s",
  )
})
