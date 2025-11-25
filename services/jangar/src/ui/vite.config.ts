import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig, type Plugin } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const nitroPlugin = nitro({
  preset: 'bun',
}) as unknown as Plugin

export default defineConfig({
  plugins: [
    nitroPlugin,
    tsconfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tanstackStart({
      srcDirectory: './app',
    }),
    react(),
  ],
  build: {
    outDir: 'dist',
  },
})
