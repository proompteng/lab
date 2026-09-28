package ai.proompteng.graf.codex

import io.temporal.workflow.WorkflowInterface
import io.temporal.workflow.WorkflowMethod

@WorkflowInterface
interface CodexResearchWorkflow {
  @WorkflowMethod
  fun run(input: CodexResearchWorkflowInput): CodexResearchWorkflowResult
}
