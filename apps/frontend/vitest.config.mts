import { defineConfig } from "vitest/config";

// Pruebas de pantallas y componentes (*.spec.tsx) en un DOM simulado.
export default defineConfig({
  test: {
    environment: "jsdom",
  },
});
