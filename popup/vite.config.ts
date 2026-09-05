import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface TabCloudAwsDefaults {
  endpointUrl: string
  region: string
  clientId: string
}

function yamlSectionValueRead(yamlText: string, sectionName: string, valueName: string) {
  const lineList = yamlText.split(/\r?\n/)
  const sectionStart = lineList.findIndex((line) => line === `${sectionName}:`)
  if (sectionStart < 0) return ''

  for (let index = sectionStart + 1; index < lineList.length; index += 1) {
    const line = lineList[index]
    if (line && !line.startsWith(' ')) break
    const match = line.match(new RegExp(`^  ${valueName}:\\s*(.*)$`))
    if (match) return match[1].trim()
  }
  return ''
}

function tabCloudAwsDefaultsLoad(): TabCloudAwsDefaults {
  const popupDir = path.dirname(fileURLToPath(import.meta.url))
  const configGenPath = path.resolve(popupDir, '../backend-aws/config_gen.yaml')
  if (!existsSync(configGenPath)) {
    return { endpointUrl: '', region: '', clientId: '' }
  }

  const configGenText = readFileSync(configGenPath, 'utf8')
  return {
    endpointUrl: yamlSectionValueRead(configGenText, 'api', 'endpoint'),
    region: yamlSectionValueRead(configGenText, 'cognito', 'region'),
    clientId: yamlSectionValueRead(configGenText, 'cognito', 'app_client_id')
  }
}

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
  define: {
    __TAB_CLOUD_AWS_DEFAULTS__: JSON.stringify(tabCloudAwsDefaultsLoad())
  },
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

