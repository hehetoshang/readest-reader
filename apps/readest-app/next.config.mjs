import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';
const embeddedBasePath = process.env.NEXT_PUBLIC_EMBEDDED_BASE_PATH || '/readest';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: isDev ? undefined : 'export',
  distDir: isDev ? '.next' : '../../out/readest',
  basePath: embeddedBasePath,
  pageExtensions: ['moke.tsx'],
  images: { unoptimized: true },
  devIndicators: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  outputFileTracingRoot: path.join(__dirname, '../..'),
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  experimental: {
    turbopackFileSystemCacheForDev: true,
    turbopackFileSystemCacheForBuild: true,
    turbopackMemoryLimit: 8192,
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      nunjucks: 'nunjucks/browser/nunjucks.js',
      fflate: path.resolve(__dirname, 'node_modules/fflate'),
      '@tursodatabase/database-wasm': false,
    };
    return config;
  },
  turbopack: {
    resolveAlias: {
      nunjucks: 'nunjucks/browser/nunjucks.js',
      fflate: './node_modules/fflate',
      '@tursodatabase/database-wasm': './src/utils/stub.ts',
    },
  },
  transpilePackages: [
    'ai',
    'ai-sdk-ollama',
    '@assistant-ui/react',
    '@assistant-ui/react-markdown',
    ...(isDev
      ? []
      : [
          'i18next-browser-languagedetector',
          'react-i18next',
          'i18next',
          '@tauri-apps',
          'highlight.js',
          'foliate-js',
          'marked',
        ]),
  ],
};

export default nextConfig;
