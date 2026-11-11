import { z } from "zod";

// Spec 017 (D-12, CA-13). Autor con nombre junto a cada id de usuario. `nombre: null` es «Usuario desconocido»
// (un id que no es miembro del estudio); `activo: false` con nombre es un miembro desactivado. `z.object` descarta
// cualquier otra clave: el autor nunca filtra más que id, nombre y activo (ni correo ni rol).
export const autorSchema = z.object({
  id: z.uuid(),
  nombre: z.string().nullable(),
  activo: z.boolean(),
});
export type Autor = z.infer<typeof autorSchema>;
