import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: true,
    port: 1420,
    watch: {
      ignored: [
        '**/node_modules/**',
        '**/src-tauri/target/**',
        '**/src-tauri/target/**/*',
        '**/src-tauri/RefMind3D_Project/**',
        '**/src-tauri/RefMind3D_Project/**/*',
        '**/RefMind3D_Project/**',
        '**/RefMind3D_Project/**/*',
        '**/src-tauri/gen/**',
        '**/src-tauri/.cargo/**'
      ]
    }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/@tauri-apps')) return 'tauri';
          if (id.includes('node_modules/react') || id.includes('node_modules/zustand')) return 'ui';
          return undefined;
        }
      }
    }
  }
});
