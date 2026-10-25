import { basePath, standaloneOutput } from "./app.config.mjs";

const prefix = basePath();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(prefix ? { basePath: prefix } : {}),
  ...(standaloneOutput() ? { output: "standalone" } : {}),
  env: { APP_BASE_PATH: prefix },
};

export default nextConfig;
