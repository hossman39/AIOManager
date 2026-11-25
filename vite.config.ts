/// <reference lib="es2022.intl" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import packageJson from './package.json'

export default defineConfig({
  base: '/', // Use absolute paths to fix deep-link reloads
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __BUILD_TIMEZONES__: JSON.stringify(Intl.supportedValuesOf('timeZone')),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:16100',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
