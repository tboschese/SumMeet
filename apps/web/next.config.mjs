/** @type {import('next').NextConfig} */
const nextConfig = {
  // @summeet/core is shipped as raw TS source; let Next transpile it.
  transpilePackages: ["@summeet/core"],
};

export default nextConfig;
