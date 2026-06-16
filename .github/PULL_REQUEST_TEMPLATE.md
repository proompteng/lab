## Summary

<!-- 3-5 concise bullets describing what changed. -->

- **Manifests**: AgentRun labels, validationCommands, Argo manifests
- **Documentation**: Prompt evaluation batch guide, auditability checklist
- **Validation**: Code and manifest validation improvements

## Related Issues

<!-- Reference issues with closes/fixes/resolves keywords. Write `None` if no issue. -->

## Testing

<!-- List each command or manual step used to verify the change. Use `N/A` only when nothing could be tested. -->

- [ ] Argo manifests render: `kustomize build --enable-helm argocd/applications/agents`
- [ ] AgentRun manifest validation: Check labels and validationCommands are present
- [ ] Documentation review: Verify auditability goals and validation checklist are complete
- [ ] PR template compliance: All sections filled, no placeholders

## Screenshots (if applicable)

<!-- Describe or attach images/GIFs that demonstrate the change. Delete this section if not applicable. -->

## Breaking Changes

<!-- State `None` or explain required migrations, deprecations, or follow-up actions. -->

## Checklist

- [ ] Testing section documents the exact validation performed (or `N/A` with justification).
- [ ] Screenshots and Breaking Changes sections are handled appropriately (removed or filled in).
- [ ] Documentation, release notes, and follow-ups are updated or tracked.
- [ ] AgentRun manifests use required labels: `anypi.proompteng.ai/prompt-variant`, `anypi.proompteng.ai/task`, `anypi.proompteng.ai/eval-batch`
- [ ] AgentRun manifests include comprehensive validationCommands for all services touched
- [ ] PR body includes validation evidence from runner status (commit, validation results, CI status)
