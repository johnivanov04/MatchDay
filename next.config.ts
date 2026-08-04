import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  typescript: {
    // Never silently ship type errors. Linting is a separate CI step
    // (`npm run lint`); Next 16 no longer runs ESLint during `next build`.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
