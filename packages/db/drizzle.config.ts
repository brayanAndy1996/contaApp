import { defineConfig } from "drizzle-kit";

// Sin dbCredentials: `drizzle-kit generate` no se conecta a la base de datos.
export default defineConfig({
  dialect: "postgresql",
  // Archivos explícitos: evita que drizzle-kit cargue *.spec.ts (vitest no es CJS). Las tablas de 003
  // van aparte del índice: el inventario de 002 (schema.spec.ts) fija las tablas base y sus invariantes
  // (auditoria_descifrado es solo de inserción: sin updated_at ni UNIQUE de negocio). Las de 008 (job_registro,
  // config_sistema) también van aparte por la misma razón, las de 006 (plan, suscripcion, admin_plataforma) y las de 013 (propuesta, venta) y las de 014 (compra y sus cuatro tablas) y 016 (documento_xml, su obtención y compra_evaluacion) y 012b (archivo_generado) y 017 (auditoria, notificacion y plan_aviso) y 021 (reglas aprendidas).
  schema: [
    "./src/schema/index.ts",
    "./src/schema/credenciales.ts",
    "./src/schema/trabajos.ts",
    "./src/schema/planes.ts",
    "./src/schema/propuestas.ts",
    "./src/schema/ventas.ts",
    "./src/schema/compras.ts",
    "./src/schema/xml.ts",
    "./src/schema/archivos.ts",
    "./src/schema/auditoria.ts",
    "./src/schema/notificaciones.ts",
    "./src/schema/reglas.ts",
  ],
  out: "./migrations",
});
