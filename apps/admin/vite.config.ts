import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
// VITE_BASE_PATH is set to /admin/ in the Dockerfile so assets resolve
// correctly when the app is served under that path by the Express server.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? '/',
  optimizeDeps: {
    exclude: ['@ubimate/crypto'],
    include: ['@ubimate/crypto > libsodium-wrappers-sumo'],
  },
});
