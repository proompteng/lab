export {
  AgentsShellRunner,
  buildBearerChallenge,
  createAgentsShellRequestHandler,
  createAgentsShellServer,
  defaultAgentsShellConfigFromEnv,
  normalizeMcpAcceptHeader,
  oauthIdentityAllowed,
  oauthProtectedResourceMetadata,
  resolveWorkspacePath,
  startAgentsShellServer,
  type AgentsShellConfig,
  type AuthContext,
} from './agents-shell'

import { startAgentsShellServer } from './agents-shell'

if (import.meta.main) {
  startAgentsShellServer()
}
