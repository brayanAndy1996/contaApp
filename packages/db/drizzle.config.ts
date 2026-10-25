import { defineConfig } from "drizzle-kit";

// Sin dbCredentials: `drizzle-kit generate` no se conecta a la base de datos.
export default defineConfig({
  dialect: "postgresql",
  // Solo el índice: evita que drizzle-kit cargue schema.spec.ts (vitest no es CJS).
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
