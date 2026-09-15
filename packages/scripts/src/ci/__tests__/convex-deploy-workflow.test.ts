import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

const workflow = readFileSync(new URL('../../../../../.github/workflows/convex-deploy.yml', import.meta.url), 'utf8')

describe('Convex production deployment workflow', () => {
  test('deploys backend function changes from main with self-hosted credentials', () => {
    expect(workflow).toContain('push:')
    expect(workflow).toContain('- main')
    expect(workflow).toMatch(/deploy:\n\s+name: Deploy functions\n\s+if: github\.ref == 'refs\/heads\/main'/)
    expect(workflow).toContain("- 'packages/backend/convex/**'")
    expect(workflow).not.toContain('pull_request:')
    expect(workflow).toContain('CONVEX_SELF_HOSTED_URL: ${{ secrets.CONVEX_SELF_HOSTED_URL }}')
    expect(workflow).toContain('CONVEX_SELF_HOSTED_ADMIN_KEY: ${{ secrets.CONVEX_SELF_HOSTED_ADMIN_KEY }}')
    expect(workflow.match(/CONVEX_SELF_HOSTED_URL: \$\{\{ secrets\.CONVEX_SELF_HOSTED_URL \}\}/g)).toHaveLength(2)
    expect(
      workflow.match(/CONVEX_SELF_HOSTED_ADMIN_KEY: \$\{\{ secrets\.CONVEX_SELF_HOSTED_ADMIN_KEY \}\}/g),
    ).toHaveLength(2)
    expect(workflow).not.toMatch(/timeout-minutes: 10\n\s+env:/)
    expect(workflow).toContain('bun install --frozen-lockfile --ignore-scripts --filter @proompteng/backend')
    expect(workflow).toContain('bun run --cwd packages/backend deploy --message "GitHub ${GITHUB_SHA}"')
  })

  test('serializes production deploys instead of cancelling an active push', () => {
    expect(workflow).toContain('group: convex-production')
    expect(workflow).toContain('cancel-in-progress: false')
  })
})
