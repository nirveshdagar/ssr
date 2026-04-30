/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
  // Heavy native + dynamic-require packages must run as Node externals
  // (Turbopack's eager static analysis can't follow patchright's dynamic
  // imports into playwright-core/lib/zipBundle, ssh2's native bindings, or
  // node-forge's UMD entry).
  serverExternalPackages: ["patchright", "patchright-core", "playwright-core", "ssh2", "nodemailer"],
}

export default nextConfig
