import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  typescript: {
    // Never silently ship type errors. Linting is a separate CI step
    // (`npm run lint`); Next 16 no longer runs ESLint during `next build`.
    ignoreBuildErrors: false,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Stops a browser second-guessing a declared Content-Type, which is
          // what turns an uploaded or proxied file into executable script.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // No part of Matchday is meant to be framed, and a framed
          // authenticated page is a clickjacking target.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // The service worker sits in front of every request the app makes, so a
        // stale one is a persistent bug users cannot clear. Never cache it, and
        // never let it load script from anywhere but this origin.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
