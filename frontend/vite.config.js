import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite configuration.
 *
 * No dev proxy is configured, on purpose. The point of this migration is that
 * the frontend is a separate origin talking to the API over HTTP, so development
 * should exercise that same arrangement — CORS, credentialed fetches and all —
 * rather than hide it behind a same-origin proxy that only exists in dev. A
 * proxy would make cross-origin problems appear for the first time in
 * production, which is the worst place to find them.
 *
 * The API origin therefore comes from VITE_API_BASE_URL (see .env.development).
 * Leave it empty to make every request same-origin, which is what a deployment
 * that serves this bundle from behind the same reverse proxy as the API wants.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },

  server: {
    port: 5173,
    // Fail loudly instead of silently moving to 5174. The backend's CORS
    // allowlist names an exact port, so a silent reassignment would present as
    // every request being blocked for no visible reason.
    strictPort: true
  },

  preview: {
    port: 4173,
    strictPort: true
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    // Vendor code changes on a different cadence to application code; splitting it keeps
    // a routine deploy from invalidating the whole bundle in operators' caches. This app
    // is used all day, so that matters more than it usually would.
    //
    // Expressed as a function rather than an object map because Vite 8 bundles with
    // rolldown, which only accepts the function form.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;

          // react-router-dom matches this too, which is intended — the router ships with
          // React and there is no value in splitting them apart.
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)/.test(id)) {
            return 'react';
          }
          if (id.includes('@tanstack')) return 'query';

          return 'vendor';
        }
      }
    }
  }
});
