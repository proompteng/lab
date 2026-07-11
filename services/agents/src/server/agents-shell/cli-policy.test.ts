import { describe, expect, it } from 'vitest'

import { requireAllowedShellCommand } from './cli-policy'

describe('agents-shell CLI policy', () => {
  it('blocks manual Codex review comments through gh pr comment', () => {
    expect(() => requireAllowedShellCommand("gh pr comment 12234 -R proompteng/lab --body '@codex review'")).toThrow(
      'manual Codex review comments are disabled',
    )
    expect(() =>
      requireAllowedShellCommand(
        "gh pr comment 12234 -R proompteng/lab --body '<!-- codex:review-request --> @codex review'",
      ),
    ).toThrow('manual Codex review comments are disabled')
  })

  it('blocks manual Codex review comments through writable gh api calls', () => {
    expect(() =>
      requireAllowedShellCommand("gh api -X POST repos/proompteng/lab/issues/12234/comments -f body='@codex review'"),
    ).toThrow('manual Codex review comments are disabled')
    expect(() =>
      requireAllowedShellCommand(
        'gh api graphql -f query=\'mutation { addComment(input: { body: "@codex review" }) { clientMutationId } }\'',
      ),
    ).toThrow('manual Codex review comments are disabled')
  })

  it('allows read-only inspection of existing manual review comments', () => {
    expect(() => requireAllowedShellCommand("gh pr view 12234 --json comments | rg '@codex review'")).not.toThrow()
  })
})
