import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type PluginOption, type UserConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const plugins: PluginOption[] = [
  ...tanstackStart({
    customViteReactPlugin: true,
    target: 'bun',
    tsr: {
      srcDirectory: 'src/app',
    },
  }),
  react(),
  tailwindcss() as unknown as PluginOption,
  tsconfigPaths(),
]

const config = {
  plugins,
  server: {
    port: 3000,
  },
  preview: {
    port: 3000,
  },
} satisfies UserConfig

export default defineConfig(config)
