/** @type {import('next').NextConfig} */
const nextConfig = {
  // @summeet/core is shipped as raw TS source; let Next transpile it.
  transpilePackages: ["@summeet/core"],

  // Dev and prod builds share `.next` by default — running `next build` while
  // `next dev` is up corrupts the dev server's manifests ("Could not find the
  // module ... in the React Client Manifest"). Build into a separate dir with
  // NEXT_DIST_DIR=.next-build to check compilation without killing dev.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
