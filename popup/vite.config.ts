import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function extensionDevPagePlugin(): Plugin {
  return {
    name: 'extension-dev-page',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url === '/' || request.url === '/index.html') {
          response.statusCode = 302
          response.setHeader('Location', '/dev.html')
          response.end()
          return
        }
        next()
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), extensionDevPagePlugin()],
  base: './',
  server: {
    open: '/dev.html',
    port: 5174
  },
  build: {
    outDir: './build',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: './index.html'
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  }
})

