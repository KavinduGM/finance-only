import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = `http://localhost:${process.env.API_PORT || '3001'}`

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.PORT || '5173'),
    // The Host header is passed through unchanged so the API's same-origin
    // check sees the address the browser is actually on.
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/uploads': { target: api, changeOrigin: false },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
})
