import { randomUUID } from 'node:crypto';

// Share the production build identity with the render workers and offline cache.
const buildId = (process.env.NEXT_PUBLIC_ARCANA_BUILD_ID ??= randomUUID());

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: import.meta.dirname,
  turbopack: { root: import.meta.dirname },
  generateBuildId: () => buildId,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Arcana-Build', value: buildId },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
    ];
  },
};

export default config;
