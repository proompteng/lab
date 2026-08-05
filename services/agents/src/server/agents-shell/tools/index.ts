import { createDelegatedAgentTools } from './delegated-agent'
import { createFileTools } from './file'
import { createGitTools } from './git'
import { createGuideTools } from './guide'
import { createKubectlTools } from './kubectl'
import { createPatchTools } from './patch'
import { createShellTools } from './shell'
import { createWorkspaceTools } from './workspace'

export const createAgentsShellTools = () => [
  ...createWorkspaceTools(),
  ...createFileTools(),
  ...createPatchTools(),
  ...createGuideTools(),
  ...createShellTools(),
  ...createGitTools(),
  ...createKubectlTools(),
  ...createDelegatedAgentTools(),
]
