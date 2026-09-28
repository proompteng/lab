import { startAgentsControlPlane } from './control-plane'

if (import.meta.main) {
  await startAgentsControlPlane()
}
