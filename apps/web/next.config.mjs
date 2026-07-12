/** @type {import('next').NextConfig} */
const nextConfig = {
  // @summeet/core is shipped as raw TS source; let Next transpile it.
  transpilePackages: ["@summeet/core"],

  // Dev and prod builds share `.next` by default — running `next build` while
  // `next dev` is up corrupts the dev server's manifests ("Could not find the
  // module ... in the React Client Manifest"). Build into a separate dir with
  // NEXT_DIST_DIR=.next-build to check compilation without killing dev.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // The panel is a client-side app that talks to the local API over HTTP: no server
  // components, no API routes, no server actions. Exporting it as static files lets the
  // desktop app serve it straight from its own bundle — no Next server, no port 3000,
  // and nothing left orphaned holding a port. `next dev` is unaffected.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
