declare module '*.css?url' {
  const href: string
  export default href
}

declare module '@xterm/addon-ligatures/lib/addon-ligatures.mjs' {
  export { LigaturesAddon } from '@xterm/addon-ligatures'
}

declare module 'nitro/runtime' {
  export const defineNitroPlugin: (plugin: (nitroApp?: unknown) => void) => unknown
}

declare module 'virtual:tanstack-start-server-entry' {
  const entry: {
    fetch: (request: Request) => Promise<Response>
  }
  export default entry
}
