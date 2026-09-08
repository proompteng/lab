import { fetchViteEnv } from 'nitro/vite/runtime'

export default {
  fetch(request: Request) {
    return fetchViteEnv('ssr', request)
  },
}
