import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { build, defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function collectOfflineDistFiles(distDir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(distDir)) return results;

  const walk = (dir: string, relBase: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      // Exclude non-runtime archive/video folders and SW/manifest build meta
      if (
        relPath === 'assets/aistudio' ||
        relPath.startsWith('assets/aistudio/') ||
        relPath === 'offline-apk-manifest.json' ||
        relPath === 'sw.js' ||
        relPath === 'registerSW.js' ||
        relPath.startsWith('workbox-')
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        results.push(relPath);
      }
    }
  };

  walk(distDir, '');
  results.sort();
  return results;
}

function getLatestSourceMtimeMs(rootDir: string): number {
  let latest = 0;
  const check = (p: string) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isFile()) {
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    } else if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        if (name === 'aistudio' || name === 'node_modules' || name === 'dist' || name === 'dev-dist') continue;
        check(path.join(p, name));
      }
    }
  };
  check(path.join(rootDir, 'index.html'));
  check(path.join(rootDir, 'vite.config.ts'));
  check(path.join(rootDir, 'src'));
  check(path.join(rootDir, 'public'));
  return latest;
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function aria48OfflineApkBundlePlugin(rootDir: string): Plugin {
  const distDir = path.join(rootDir, 'dist');
  const manifestPath = path.join(distDir, 'offline-apk-manifest.json');
  let activeBuildPromise: Promise<void> | null = null;

  const ensureFreshDistForDev = async () => {
    let needsBuild = !fs.existsSync(manifestPath) || !fs.existsSync(path.join(distDir, 'index.html'));
    if (!needsBuild) {
      const manifestMtime = fs.statSync(manifestPath).mtimeMs;
      const srcMtime = getLatestSourceMtimeMs(rootDir);
      if (srcMtime > manifestMtime) {
        needsBuild = true;
      }
    }
    if (!needsBuild) return;

    if (!activeBuildPromise) {
      activeBuildPromise = build({
        configFile: path.join(rootDir, 'vite.config.ts'),
        logLevel: 'warn',
      })
        .then(() => undefined)
        .finally(() => {
          activeBuildPromise = null;
        });
    }
    await activeBuildPromise;
  };

  return {
    name: 'aria48-offline-apk-bundle',
    closeBundle() {
      if (!fs.existsSync(distDir) || !fs.existsSync(path.join(distDir, 'index.html'))) return;
      const files = collectOfflineDistFiles(distDir);
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            manifestPrefix: '/',
            files,
          },
          null,
          2
        )
      );
    },
    configureServer(server) {
      server.middlewares.use('/offline-apk-manifest.json', async (_req, res, next) => {
        try {
          await ensureFreshDistForDev();
          const raw = fs.readFileSync(manifestPath, 'utf-8');
          const parsed = JSON.parse(raw);
          parsed.manifestPrefix = '/__offline_dist/';
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(parsed));
        } catch (err) {
          next(err);
        }
      });

      server.middlewares.use('/__offline_dist', (req, res, next) => {
        const cleanReqUrl = (req.url || '/').split('?')[0].replace(/^\/+/, '');
        if (!cleanReqUrl || cleanReqUrl.includes('..')) {
          res.statusCode = 400;
          res.end('Invalid path');
          return;
        }
        const resolved = path.resolve(distDir, cleanReqUrl);
        if (!resolved.startsWith(distDir + path.sep) && resolved !== distDir) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          next();
          return;
        }
        const ext = path.extname(resolved).toLowerCase();
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(resolved).pipe(res);
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      aria48OfflineApkBundlePlugin(__dirname),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'favicon.ico',
          'apple-touch-icon.png',
          'icon.svg',
          'sunvox/sunvox.js',
          'sunvox/sunvox_lib_loader.js',
          'sunvox/sunvox.wasm',
        ],
        manifest: {
          id: '/',
          name: 'Aria48 Tracker - Chiptune & MIDI Studio',
          short_name: 'Aria48',
          description: 'Universal 48-channel chiptune, MIDI, SoundFont2/SFE, WebSID & SunVox 2.1.4 WASM workstation.',
          theme_color: '#09090b',
          background_color: '#09090b',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm,woff,woff2}'],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'cdn-synth-cache',
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
