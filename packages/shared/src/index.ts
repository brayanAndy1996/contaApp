import { z } from "zod";

export const saludoSchema = z.object({ mensaje: z.string() });

export type Saludo = z.infer<typeof saludoSchema>;

export * from "./autor.js";
export * from "./auth/index.js";
export * from "./acceso/index.js";
export * from "./trabajos/index.js";
export * from "./planes/index.js";
export * from "./clientes/index.js";
export * from "./credenciales/index.js";
export * from "./importacion/index.js";
export * from "./xml/index.js";
export * from "./compras/index.js";
export * from "./ventas/index.js";
export * from "./archivos/index.js";
export * from "./auditoria/index.js";
export * from "./notificaciones/index.js";
