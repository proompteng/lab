import { createAgentRunTools } from './agent-runs'
import { createBmcTools } from './bmc'
import { createFileTools } from './file'
import { createGitTools } from './git'
import { createGuideTools } from './guide'
import { createInfrastructureTools } from './infrastructure'
import { createKubectlTools } from './kubectl'
import { createMemoryTools } from './memory'
import { createPatchTools } from './patch'
import { createRepoSessionTools } from './repo-session'
import { createShellTools } from './shell'

export const createAgentsShellTools = () => [
  ...createRepoSessionTools(),
  ...createFileTools(),
  ...createPatchTools(),
  ...createGuideTools(),
  ...createMemoryTools(),
  ...createShellTools(),
  ...createGitTools(),
  ...createKubectlTools(),
  ...createInfrastructureTools(),
  ...createBmcTools(),
  ...createAgentRunTools(),
]
