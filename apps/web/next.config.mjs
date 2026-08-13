import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Pin file tracing to the monorepo root. Without this Next infers the root by
  // walking up looking for a lockfile and can wander outside the repo — on
  // Windows that means scanning legacy junctions under the user profile, which
  // deny access and fail the build.
  outputFileTracingRoot: resolve(here, '../..'),

  // @orbit/ui ships TSX and Tailwind classes; Next compiles it from source.
  // Every other workspace package is consumed from its built dist.
  transpilePackages: ['@orbit/ui'],

  // Node-only packages that must not be bundled. @orbit/db wraps a generated
  // Prisma client with a native query engine; bundling it makes Prisma's
  // platform detection glob the filesystem looking for the engine binary,
  // which fails on Windows the moment it reaches a permission-denied junction.
  // pino likewise resolves transports at runtime.
  serverExternalPackages: ['@orbit/db', '@prisma/client', '.prisma/client', 'pino', 'pino-pretty'],

  eslint: {
    // Linting is a separate CI step across the whole workspace; running it
    // again here would use a different config and report different results.
    ignoreDuringBuilds: true,
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
