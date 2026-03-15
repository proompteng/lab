import { Layer, ManagedRuntime } from 'effect'

import { makeCodexSessionLayer } from './codex-app-session'
import { makeIssueRunnerLayer } from './issue-runner'
import { makeLeaderElectionLayer } from './leader-election'
import { makeTrackerLayer } from './linear-client'
import { makeOrchestratorLayer } from './orchestrator'
import { makeStateStoreLayer } from './state-store'
import { makeTargetHealthLayer } from './target-health'
import { makeWorkflowLayer } from './workflow'
import { makeShellLayer, makeWorkspaceLayer } from './workspace-manager'
import type { Logger } from './logger'

export const makeSymphonyLayer = (workflowPath: string, logger: Logger) => {
  const workflowLayer = makeWorkflowLayer(workflowPath, logger)
  const shellLayer = makeShellLayer(logger)
  const trackerLayer = makeTrackerLayer(logger).pipe(Layer.provide(workflowLayer))
  const workspaceLayer = makeWorkspaceLayer(logger).pipe(Layer.provide(shellLayer), Layer.provide(workflowLayer))
  const codexSessionLayer = makeCodexSessionLayer(logger)
  const leaderElectionLayer = makeLeaderElectionLayer(logger)
  const stateStoreLayer = makeStateStoreLayer(logger).pipe(Layer.provide(workflowLayer))
  const targetHealthLayer = makeTargetHealthLayer(logger).pipe(Layer.provide(workflowLayer))
  const issueRunnerLayer = makeIssueRunnerLayer(logger)
    .pipe(Layer.provide(codexSessionLayer))
    .pipe(Layer.provide(workspaceLayer))
    .pipe(Layer.provide(trackerLayer))
    .pipe(Layer.provide(workflowLayer))

  return makeOrchestratorLayer(logger)
    .pipe(Layer.provide(issueRunnerLayer))
    .pipe(Layer.provide(workspaceLayer))
    .pipe(Layer.provide(trackerLayer))
    .pipe(Layer.provide(leaderElectionLayer))
    .pipe(Layer.provide(stateStoreLayer))
    .pipe(Layer.provide(targetHealthLayer))
    .pipe(Layer.provide(workflowLayer))
}

export const makeSymphonyRuntime = (workflowPath: string, logger: Logger) =>
  ManagedRuntime.make(makeSymphonyLayer(workflowPath, logger))
