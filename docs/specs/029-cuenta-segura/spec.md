# Spec 029 · Cuenta segura (TOTP y sesiones)

Estado: **hecha (2026-11-26)**, P1–P9 con la opción (a) (U1–U9). Rama `spec/029-cuenta-segura`; `plan.md`, `tasks.md`, `cierre.md`.
Nivel de riesgo: A — (2) una contraseña robada bastaría, también para el panel; (3) un código reusable o una sesión revocada viva no se notan; (4) tiempo, concurrencia, sesiones y estudios.
Cubre: RF-012, RF-014 (resto tras 004 P2), RF-015 (segundo paso) · TOTP del super-admin (006) · RNF-004, RNF-007, RNF-009

## Objetivo
Que la cuenta resista una contraseña filtrada: TOTP, códigos de recuperación y sesiones revocables; el super-admin ya no entra al panel solo con contraseña.

## Alcance
- **Enrolar** (RFC 6238, SHA-1, 6 dígitos, 30 s): con la contraseña actual se genera un secreto de 20 B y se devuelve una vez el URI `otpauth://` (QR en el navegador). Se activa al confirmar un código y entrega los códigos de U4; el pendiente caduca a los 10 min.
- **Login en dos pasos**: con TOTP activo, la contraseña crea una sesión `pendiente` (sin estudio, 5 min); al verificar (TOTP o código de recuperación) el token rota (004 D4).
- **Exigencia** (U1–U3): si se exige y falta, solo se puede enrolar, ver la sesión, elegir estudio y salir.
- **Desactivar** con contraseña y código, solo sin exigencia en ningún estudio ni rol de plataforma; revoca las demás sesiones.
- **Sesiones (RF-014)**: «Mi cuenta → Seguridad» lista las vigentes (creación, último uso, dispositivo U6, «esta sesión»); se revoca una o todas menos la actual.
- U4, U5 y U8. Frontend: Seguridad, paso de código, enrolamiento forzado; zod en `packages/shared`.

## Fuera de alcance
- U7, U9, WebAuthn, SMS, soporte a tenants (RNF-022).

## Criterios de aceptación
- [ ] CA-1 (enrolar): sin contraseña actual no hay secreto; sin código válido no se activa; un pendiente vencido o reemplazado no se confirma. Re-enrolar exige código vigente.
- [ ] CA-2 (login): la sesión `pendiente` recibe 401 en toda ruta salvo verificar y logout (también `GET /auth/sesion`); su `csrf` llega en la respuesta del login. Contraseña errónea o cuenta bloqueada: como 004 CA-2. Ventana ±1 paso, comparación en tiempo constante. Un código de un paso ya usado se rechaza; de dos verificaciones concurrentes del mismo código solo pasa una.
- [ ] CA-3 (fuerza bruta): cada código erróneo (TOTP o de recuperación, en cualquier paso) suma al contador de 004 D7; al 5.º la cuenta se bloquea 15 min y la sesión pendiente se revoca; 20 intentos concurrentes no dan más de 5 evaluaciones. El intento se reserva antes de evaluarse: con 4 erróneos previos, el 5.º se rechaza aunque sea correcto.
- [ ] CA-4 (exigencia): sin factor verificado, 403 en toda ruta `@SoloPlataforma` y en un estudio cuyo rol lo exige, también tras cambiar de estudio o de rol y con sesiones previas al despliegue. Restablecer la contraseña (004 CA-8) no desactiva ni salta el TOTP. Quien lo tiene exigido no puede desactivarlo.
- [ ] CA-5 (sesiones): solo las propias vigentes, sin hashes ni tokens. Revocar un id ajeno, inexistente o ya revocado responde igual; la revocada da 401 en su siguiente petición.
- [ ] CA-6 (secretos, RNF-004): secreto, códigos y URI canario no aparecen en logs, errores (también de `pg`), auditoría, correos ni respuestas (salvo URI y códigos al generarlos). Un volcado de tablas no permite generar códigos TOTP ni probar los de recuperación (D1).
- [ ] CA-7 (BD): tablas nuevas sin `GRANT` a los roles de la app; acceso por funciones `SECURITY DEFINER` del esquema `auth`, `EXECUTE` solo para `contapp_backend` (la de U5, solo para el operador), en `tests/aislamiento/escalada.adv.spec.ts` y `catalogo.spec.ts`. Migraciones desde la 0078.
- [ ] CA-8 (escala): guard y lista de sesiones no crecen con las sesiones de otros usuarios (`medirEscala`).
- [ ] CA-9 (recuperación y operador): un código de recuperación sirve una vez (también con dos usos concurrentes); regenerar invalida los anteriores; `db:totp-restablecer` borra TOTP y códigos, revoca todas las sesiones, avisa y deja evento; un correo inexistente da salida indistinguible.
- [ ] CA-10 (avisos): llega un correo en cada evento de U8, sin código, secreto ni enlace de acción (E2E con Mailpit).
- [ ] CA-11 (adversario, ≤ 2 rondas): replay, carreras, desfase de reloj, fuerza bruta, sesión pendiente en otras rutas o al cambiar de estudio, saltar el enrolamiento, revocar sesiones ajenas, enumeración, CSRF, lectura del secreto con el rol del backend.
- [ ] Casos reales aplicables: ninguno.

**Cobertura (DoD A):** lo nuevo ≥ 90 % por archivo (globs en los `vitest.cobertura.config.mts` existentes, sin CI nuevo).

## Decisiones técnicas
- D1 Secreto con AES-256-GCM, AAD = `usuario_id`, clave `TOTP_CLAVE` versionada solo del backend (no es la KEK de 003); sin ella no arranca. Códigos de recuperación como HMAC-SHA-256 con subclave de `TOTP_CLAVE`.
- D2 Factor de la sesión (`pendiente`, `verificado`, `sin_factor`) en `auth.sesion`, con motivos `revocada_usuario` y `totp`; los guards lo leen sin consulta extra.
- D3 Último paso aceptado por usuario; verificar es un `UPDATE … WHERE ultimo_paso < $paso` atómico.
- D4 `db:plataforma-alta` no toca TOTP: el super-admin se enrola en la web al primer ingreso.

## Decisiones del usuario (P1–P9, opción a)
- U1 Obligatorio para super-admin, Dueño y Administrador; opcional el resto. U2 También roles propios con `usuarios.gestionar`, `roles.gestionar`, `plan.gestionar` o `credenciales.editar`. U3 Sin plazo: se exige al siguiente ingreso (sesiones previas quedan `sin_factor`).
- U4 10 códigos de recuperación de un uso, como hash, mostrados una vez, regenerables con contraseña y código.
- U5 Dispositivo perdido: `pnpm db:totp-restablecer --correo` (operador) borra TOTP, revoca sesiones, avisa y deja evento.
- U6 Dispositivo: navegador y SO resumidos, IP truncada (/24, /48). U7 Sin «recordar este equipo».
- U8 Avisos al activar o desactivar TOTP, usar un código de recuperación y restablecerlo el operador.
- U9 Cambio de correo y política de contraseña fuera de 029.

## Dependencias
- Specs: 004, 005 (`PermisoGuard`), 006 (`@SoloPlataforma`), 017, 028 (`packages/correo`, Mailpit). Externas: ninguna.
