import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // El token de recuperación viaja en el fragmento (#t=): estas pantallas no deben filtrar la URL.
  async headers() {
    const politica = [{ key: "Referrer-Policy", value: "no-referrer" }];
    return [
      { source: "/recuperar/:path*", headers: politica },
      { source: "/login", headers: politica },
      // La invitación también viaja en el fragmento (#t=): sin Referer (spec 005, D7).
      { source: "/invitacion", headers: politica },
    ];
  },
  // El navegador llama a /api/*; Next lo reenvía al backend (mismo origen para la cookie).
  async rewrites() {
    const backend = process.env.BACKEND_URL ?? "http://localhost:4000";
    return [{ source: "/api/:path*", destination: `${backend}/:path*` }];
  },
};

export default nextConfig;
