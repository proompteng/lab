import { createDelegatedAgentTools } from './delegated-agent'
import { createFileTools } from './file'
import { createGitTools } from './git'
import { createGuideTools } from './guide'
import { createKubectlTools } from './kubectl'
import { createPatchTools } from './patch'
import { createShellTools } from './shell'

export const createAgentsShellTools = () => [
  ...createFileTools(),
  ...createPatchTools(),
  ...createGuideTools(),
  ...createShellTools(),
  ...createGitTools(),
  ...createKubectlTools(),
  ...createDelegatedAgentTools(),
]
