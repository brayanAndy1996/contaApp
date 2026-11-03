import { defineConfig } from "drizzle-kit";

// Sin dbCredentials: `drizzle-kit generate` no se conecta a la base de datos.
export default defineConfig({
  dialect: "postgresql",
  // Archivos explícitos: evita que drizzle-kit cargue *.spec.ts (vitest no es CJS). Las tablas de 003
  // van aparte del índice: el inventario de 002 (schema.spec.ts) fija las tablas base y sus invariantes
  // (auditoria_descifrado es solo de inserción: sin updated_at ni UNIQUE de negocio). Las de 008 (job_registro,
  // config_sistema) también van aparte por la misma razón.
  schema: [
    "./src/schema/index.ts",
    "./src/schema/credenciales.ts",
    "./src/schema/trabajos.ts",
  ],
  out: "./migrations",
});
