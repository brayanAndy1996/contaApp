import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// La demo importa el código FUENTE de packages/domain y packages/shared (no su dist), así usa
// exactamente el mismo motor de reglas, prevalidación y TXT que usará el producto.
const raiz = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@contapp/domain": raiz("../../packages/domain/src/index.ts"),
      "@contapp/shared": raiz("../../packages/shared/src/index.ts"),
    },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
});
