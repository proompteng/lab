import { defineNitroPlugin } from 'nitro/runtime'

import { startControlPlaneCache } from '../../src/server/control-plane-cache'

export default defineNitroPlugin(() => {
  void startControlPlaneCache()
})
