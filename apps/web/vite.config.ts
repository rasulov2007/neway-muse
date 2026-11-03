import { tanstackRouter } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';

/**
 * The public driver application is its own small page (apply.html), not a route of the TMS. In
 * production nginx sends /apply/<slug> to it; this does the same for `vite` and `vite preview`.
 */
function applyPageRewrite(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    if (req.url && /^\/apply\/[^/?#]+\/?(\?.*)?$/.test(req.url)) {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      req.url = `/apply.html${query}`;
    }
    // NORTHWIND FREIGHT Driver Care (/care/<slug>): its own small page too (care.html).
    if (req.url && /^\/care\/[^/?#]+\/?(\?.*)?$/.test(req.url)) {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      req.url = `/care.html${query}`;
    }
    // The DOT driver application v2 (/application/#token=…): its own page (application.html).
    if (req.url && /^\/application\/?(\?.*)?$/.test(req.url)) {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      req.url = `/application.html${query}`;
    }
    // The previous personal application page, kept for links sent before v2: byte for byte.
    if (req.url && /^\/application-legacy\/?(\?.*)?$/.test(req.url)) {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      req.url = `/hosted/external-driver-application.html${query}`;
    }
    // The candidate consent (/consent/#token=…): its own page too (consent.html).
    if (req.url && /^\/consent\/?(\?.*)?$/.test(req.url)) {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      req.url = `/consent.html${query}`;
    }
    // The DOT application sent to a driver (/dot/<token>): its own page too (dot.html).
    if (req.url && /^\/dot\/[^/?#]+\/?(\?.*)?$/.test(req.url)) {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      req.url = `/dot.html${query}`;
    }
    next();
  };
  return {
    name: 'neway-apply-page',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
}

export default defineConfig({
  plugins: [
    // Must run before the React plugin: generates src/routeTree.gen.ts from src/routes.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    applyPageRewrite(),
  ],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        apply: fileURLToPath(new URL('./apply.html', import.meta.url)),
        care: fileURLToPath(new URL('./care.html', import.meta.url)),
        dot: fileURLToPath(new URL('./dot.html', import.meta.url)),
        consent: fileURLToPath(new URL('./consent.html', import.meta.url)),
        application: fileURLToPath(new URL('./application.html', import.meta.url)),
      },
      output: {
        // The libraries every page needs live in their own chunks (owner, 2026-10-23: "very slow").
        // They change only when a dependency does, so after a deploy the browser keeps them cached
        // and downloads just the app code - over a 200 ms, lossy link that is most of the wait.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (id.includes('@tanstack')) return 'vendor-tanstack';
          if (/[\\/]node_modules[\\/]zod[\\/]/.test(id)) return 'vendor-zod';
          if (/[\\/]node_modules[\\/](date-fns|@date-fns|react-day-picker)[\\/]/.test(id)) return 'vendor-date';
          if (/[\\/]node_modules[\\/](@radix-ui|@floating-ui|tailwind-merge|clsx|class-variance-authority|lucide-react)[\\/]/.test(id)) return 'vendor-ui';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  preview: {
    proxy: {
      // The application page posts to same-origin /api/applications; nginx maps it the same way.
      '/api/applications': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: () => '/api/v1/public/driver-application',
      },
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The application page posts to same-origin /api/applications; nginx maps it the same way.
      '/api/applications': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: () => '/api/v1/public/driver-application',
      },
      // Forward API calls to the NestJS server during development.
      '/api': {
        // API_PROXY_TARGET lets a second checkout run beside the first on another port.
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
