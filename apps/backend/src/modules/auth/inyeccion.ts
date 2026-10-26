// Tokens de inyección del módulo `auth` (Nest con `@Inject(TOKEN)` explícito: vitest no emite
// design:paramtypes). T12 los registra en `auth.module`.
/** `ContappDb` (se usan `withAuth` y `withUsuario`). */
export const DB = Symbol("AUTH_DB");
/** `Hasher` de Argon2id (D1). */
export const HASHER = Symbol("AUTH_HASHER");
/** `ColaCorreo`: envío fuera de la petición (D8). */
export const COLA_CORREO = Symbol("AUTH_COLA_CORREO");
/** Lista de contraseñas comunes (`cargarComunes()`, P5). */
export const COMUNES = Symbol("AUTH_COMUNES");
/** `APP_ORIGIN` exacto (D6). */
export const APP_ORIGIN = Symbol("AUTH_APP_ORIGIN");
