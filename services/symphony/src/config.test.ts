import { describe, expect, test } from 'bun:test'

import { toSymphonyConfig } from './config'

describe('config normalization', () => {
  test('parses target, release, and health extensions', async () => {
    const config = await toSymphonyConfig(
      '/tmp/WORKFLOW.md',
      {
        tracker: {
          kind: 'linear',
          api_key: '$LINEAR_API_KEY',
          project_slug: 'project-slug',
          handoff_state: 'Backlog',
        },
        workspace: {
          root: '/workspace/symphony-jangar',
        },
        instance: {
          name: 'symphony-jangar',
          namespace: 'jangar',
          argocd_application: 'symphony-jangar',
        },
        target: {
          name: 'Jangar',
          namespace: 'jangar',
          argocd_application: 'jangar',
          repo: 'proompteng/lab',
          default_branch: 'main',
        },
        release: {
          mode: 'gitops_pr_on_main',
          required_checks_source: 'branch_protection',
          promotion_branch_prefix: 'codex/jangar-release-',
          blocked_labels: ['manual-only', 'cluster-recovery'],
          deployables: [
            {
              name: 'jangar',
              image: 'registry.ide-newton.ts.net/lab/jangar',
              manifest_paths: ['argocd/applications/jangar', 'argocd/applications/agents/values.yaml'],
              build_workflow: 'jangar-build-push',
              release_workflow: 'jangar-release',
              post_deploy_workflow: 'jangar-post-deploy-verify',
            },
          ],
        },
        health: {
          pre_dispatch: [
            {
              name: 'jangar-argo',
              type: 'argocd_application',
              namespace: 'argocd',
              application: 'jangar',
              expected_sync: 'Synced',
              expected_health: 'Healthy',
            },
          ],
          post_deploy: [
            {
              name: 'jangar-api',
              type: 'http',
              url: 'http://jangar.jangar.svc.cluster.local/health',
              expected_status: 200,
            },
          ],
        },
      },
      {
        LINEAR_API_KEY: 'token',
      },
    )

    expect(config.target).toEqual({
      name: 'Jangar',
      namespace: 'jangar',
      argocdApplication: 'jangar',
      repo: 'proompteng/lab',
      defaultBranch: 'main',
    })
    expect(config.instance).toEqual({
      name: 'symphony-jangar',
      namespace: 'jangar',
      argocdApplication: 'symphony-jangar',
    })
    expect(config.release.promotionBranchPrefix).toBe('codex/jangar-release-')
    expect(config.release.blockedLabels).toEqual(['manual-only', 'cluster-recovery'])
    expect(config.tracker.handoffState).toBe('Backlog')
    expect(config.release.deployables).toEqual([
      {
        name: 'jangar',
        image: 'registry.ide-newton.ts.net/lab/jangar',
        manifestPaths: ['argocd/applications/jangar', 'argocd/applications/agents/values.yaml'],
        buildWorkflow: 'jangar-build-push',
        releaseWorkflow: 'jangar-release',
        postDeployWorkflow: 'jangar-post-deploy-verify',
      },
    ])
    expect(config.health.preDispatch[0]?.application).toBe('jangar')
    expect(config.health.postDeploy[0]?.url).toBe('http://jangar.jangar.svc.cluster.local/health')
  })
})
