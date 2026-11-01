import { createAgentRunTools } from './agent-runs'
import { createFileTools } from './file'
import { createGitTools } from './git'
import { createGuideTools } from './guide'
import { createKubectlTools } from './kubectl'
import { createPatchTools } from './patch'
import { createRepoSessionTools } from './repo-session'
import { createShellTools } from './shell'

export const createAgentsShellTools = () => [
  ...createRepoSessionTools(),
  ...createFileTools(),
  ...createPatchTools(),
  ...createGuideTools(),
  ...createShellTools(),
  ...createGitTools(),
  ...createKubectlTools(),
  ...createAgentRunTools(),
]
