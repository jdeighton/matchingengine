import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/instruments': 'http://localhost:3001',
      '/sessions':    'http://localhost:3001',
    },
  },
});
