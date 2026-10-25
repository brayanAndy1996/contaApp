import { defineConfig } from "drizzle-kit";

// Sin dbCredentials: `drizzle-kit generate` no se conecta a la base de datos.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema",
  out: "./migrations",
});
