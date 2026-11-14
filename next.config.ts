import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static site: data lives in /public/data, audio is synthesized in the browser.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
