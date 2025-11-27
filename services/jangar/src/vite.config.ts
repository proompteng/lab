import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig, type Plugin } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const nitroPlugin = nitro({
  preset: 'bun',
}) as unknown as Plugin

export default defineConfig({
  server: {
    host: true,
    port: Number(process.env.UI_PORT ?? process.env.PORT ?? '3000'),
    allowedHosts: ['host.docker.internal'],
  },
  plugins: [
    nitroPlugin,
    tsconfigPaths({
      projects: ['../tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart({
      srcDirectory: './app',
    }),
    react(),
  ],
  build: {
    outDir: 'dist',
  },
})
