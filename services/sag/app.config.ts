import viteTsConfigPaths from 'vite-tsconfig-paths'

const config = {
  vite: {
    plugins: [
      viteTsConfigPaths({
        projects: ['./tsconfig.json'],
      }),
    ],
  },
  routers: {
    client: {
      entry: './src/client.tsx',
    },
    ssr: {
      entry: './src/ssr.tsx',
    },
  },
  tsr: {
    appDirectory: './src',
    routesDirectory: './src/routes',
  },
}

export default config
