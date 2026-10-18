import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, API calls go to the local server (contracts/registry/deploy/server.mjs).
const api = 'http://localhost:5180';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': api, '/deployments': api } },
});
