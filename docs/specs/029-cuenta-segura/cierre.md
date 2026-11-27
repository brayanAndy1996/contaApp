# Cierre 029 · Cuenta segura (TOTP y sesiones)

Spec `029-cuenta-segura` · nivel A · estado `hecha` (2026-11-26). Sin mergear: rama `spec/029-cuenta-segura`, desde `main`; sin PR. Tablero: nota corta en `ESTADO.md`; hallazgos cerrados en `HALLAZGOS.md`.

## Qué quedó

- **TOTP** RFC 6238 (SHA-1, 6 dígitos, 30 s). El secreto se cifra con AES-256-GCM (AAD = `usuario_id`) con `TOTP_CLAVE` versionada, solo del backend; sin ella no arranca. En producción se rechaza el valor de ejemplo de `.env.example` (T18b).
- **Códigos de recuperación**: 10 de un uso, guardados como HMAC-SHA-256; se muestran una vez y se regeneran con contraseña y código.
- **Login en dos pasos**: la contraseña crea una sesión `pendiente` (sin estudio, 5 min) que solo verifica o cierra; al verificar, el token rota.
- **Exigencia por rol** (U1–U2): super-admin, Dueño, Administrador y roles con `usuarios.gestionar`, `roles.gestionar`, `plan.gestionar` o `credenciales.editar`. Sin plazo: las sesiones previas quedan `sin_factor` (U3).
- **Sesiones**: «Mi cuenta → Seguridad» lista las vigentes (dispositivo resumido, IP /24 y /48) y revoca una o todas menos la actual.
- **Operador**: `pnpm db:totp-restablecer --correo <correo>` borra TOTP y códigos, revoca sesiones y deja evento; un correo inexistente da la misma salida.
- **Avisos por correo** (U8) al activar o desactivar, usar un código de recuperación y restablecer; sin códigos, secretos ni enlaces.
- **Migraciones**: 0078 (T5), 0079 (T7, `intento_acierto`), 0080 (ronda 1) y 0081 (ronda 2). Siguiente libre: **0082**.

## Criterios

CA-1 a CA-11 y U1 a U9 cumplidos; evidencia por criterio en `resultados.md` (T17). Suites clave:

- CA-2 y CA-3: `totp.login.int.spec` (5.º error bloquea 15 min; 20 concurrentes, ≤ 5 evaluaciones) y `rfc6238.spec`.
- CA-4 y CA-5: `totp.exigencia.int.spec`, `totp.sesiones.int.spec` y E2E `cuenta-segura`.
- CA-6 y CA-10: `totp.fugas.int.spec` (canarios y un aviso por evento).
- CA-8: `auth-sesiones.rendimiento.spec` (razón ≤ 3× con 40 000 sesiones ajenas).

## Decisiones del usuario

U1–U9 con la opción (a), la recomendada. P10 (invitación y registro con factor exigido sin verificar): opción (a), enrolar en Seguridad y reabrir el enlace; el token sigue solo en memoria (005 D15).

## Hallazgos adversariales

- **Ronda 1** (T12 caja negra, T13 caja blanca): 2 medios y 4 bajos. Corregidos en T14 (`c363c8d`), salvo los 2 bajos aceptados.
- **Ronda 2** (T15): 1 alto, 3 medios y 2 bajos. Corregidos en T16 (`cd98f90`).
- **Riesgos bajos aceptados por el usuario (2)**:
  1. Funciones previas a 029 que aceptan una sesión `pendiente`. Solo se alcanzan por HTTP, y ahí el guard responde 401.
  2. `intento_acierto` sin reserva: `auth-totp-r1b.adv.spec.ts:384` es `it.fails`; vitest avisa si empieza a pasar.

## Defectos de la verificación

- **T11b**: la E2E halló que el login pendiente no devolvía el `csrf` que exige el paso de código; ahora lo incluye la respuesta del login.
- **T17a**: `equipo.e2e` invitaba a un Dueño sin TOTP, que no podía completar la invitación. Se sembró un Contador; T18a volvió a `a.dueno` con TOTP activo.
- **T18a**: con TOTP activo o exigido, invitación y registro con cuenta existente no tenían paso de código y perdían el token. Ahora reutilizan el de `login`; sin factor verificado, avisan y enlazan a Seguridad.
- **T18b**: `TOTP_CLAVE` de ejemplo rechazada en producción.

## Límites y pendientes

- El CI de GitHub no se ha ejecutado para 029; se ejecutará en el PR a `main`.
- `pnpm e2e`: 111 de 111 (las 4 `test.fail` de `soporte.e2e` cuentan como pasadas). Sin prueba manual en navegador; la E2E con la pila real recorre el flujo.
- Fallas ajenas al entorno: 9 aserciones en 4 archivos de `tests/aislamiento` (un superusuario de pruebas en listas de `EXECUTE`; `MERGE … RETURNING` da `42601` en PG16). Ninguna nombra `totp`, `sesion` ni `cuenta_evento`. Se atribuyen al entorno local; el CI con `postgres:17` debe confirmarlo.
- Código defensivo conservado: `packages/db/src/cli/totp-restablecer.ts:54` (relanza lo ajeno a `CorreoNoAsciiError`) y `packages/correo/src/seguridad.ts:53` (respaldo de `formatToParts`).
- La cabecera de `tasks.md` numera 0079 (T14) y 0080 (T16); la numeración real es la de arriba.
