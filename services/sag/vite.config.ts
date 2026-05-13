import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [
    nitro(),
    viteTsConfigPaths({
      projects: ['./tsconfig.paths.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
