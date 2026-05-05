import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable Next.js instrumentation (starts BullMQ worker at server boot)
  experimental: {
    instrumentationHook: true,
  },
  // Ensure environment variables are validated at build time
  images: {
    // MinIO presigned URLs will be from the configured endpoint
    remotePatterns: [
      {
        protocol: "http",
        hostname: process.env.MINIO_PUBLIC_HOSTNAME ?? "localhost",
        port: process.env.MINIO_PUBLIC_PORT ?? "9000",
        pathname: "/hypereels/**",
      },
    ],
  },
};

export default nextConfig;
