import { z } from "zod";

export const saludoSchema = z.object({ mensaje: z.string() });

export type Saludo = z.infer<typeof saludoSchema>;

export * from "./auth/index.js";
