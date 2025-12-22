import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import tsconfigPaths from 'vite-tsconfig-paths'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [
    nitro(),
    tsconfigPaths(),
    tanstackStart(),
    react(),
    viteStaticCopy({
      targets: [
        {
          src: resolve(rootDir, '../../node_modules/@fontsource-variable/jetbrains-mono/files/*'),
          dest: 'assets/files',
        },
      ],
    }),
  ],
})
