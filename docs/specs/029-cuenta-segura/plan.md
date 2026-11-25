# Plan 029 · Cuenta segura (TOTP y sesiones)

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/db/migrations/0078_cuenta_segura.sql` (0079–0080 solo para correcciones) | tablas, columnas de `auth.sesion`, funciones |
| crear | `packages/db/src/auth/totp.ts`, `sesiones.ts` (+ esquema drizzle) | repositorio sobre las funciones |
| crear | `packages/db/src/cli/totp-restablecer.ts`; script raíz `db:totp-restablecer` | U5 |
| crear | `packages/shared/src/auth/seguridad.ts` | zod, códigos de error, `factorExigido()` |
| crear | `packages/correo/src/seguridad.ts` | 4 plantillas de aviso (U8), texto plano escapado |
| crear | `apps/backend/src/modules/auth/totp/{rfc6238,cifrado,recuperacion,dispositivo}.ts` | puros: códigos, AES-GCM, HMAC, UA/IP |
| crear | `apps/backend/src/modules/auth/totp/{totp.service,sesiones.service,totp.controller}.ts` | casos de uso y rutas |
| modificar | `apps/backend/src/config/*` · `.env.example` | `TOTP_CLAVE` obligatoria (D1) |
| modificar | `auth.service.ts`, `guards/sesion.guard.ts`, `guards/decoradores.ts`, `acceso/guards/permiso.guard.ts` | login en dos pasos, `pendiente`, exigencia |
| crear/modificar | `apps/frontend/app/(publico)/login/`, `(app)/cuenta/seguridad/`, `(app)/layout.tsx`, `(plataforma)/` | paso de código, Seguridad, enrolamiento forzado |
| modificar | `apps/backend/vitest.cobertura.config.mts` | globs nuevos (`packages/correo/src/seguridad.ts`) |

## Contratos
**HTTP** (`@SinEstudio`, Origen + CSRF de 004; respuestas con secretos `Cache-Control: no-store`):
| Ruta | Sesión | Respuesta |
|---|---|---|
| `POST /auth/login` | pública | como 004; si hay TOTP: `{segundoFactor: true, estudioActivo: null}` y sesión `pendiente` |
| `POST /auth/2fa/verificar` `{codigo}` \| `{codigoRecuperacion}` | solo `pendiente` (`@PermitirPendiente`) | 200 como login, token rotado · 401 `codigo_invalido` · 429 `demasiados_intentos` |
| `GET /auth/sesion` | cualquiera | + `factor`, `totpActivo`, `factorExigido` |
| `POST /auth/totp/enrolar` `{contrasena}` | no `pendiente` | 200 `{uri}` · 401 `credenciales_invalidas` |
| `POST /auth/totp/confirmar` `{codigo}` | ídem | 200 `{codigosRecuperacion: string[10]}`, token rotado, sesión `verificado`, otras revocadas |
| `POST /auth/totp/desactivar` `{contrasena, codigo}` | `verificado` | 204 · 409 `totp_exigido` |
| `POST /auth/totp/recuperacion` `{contrasena, codigo}` | `verificado` | 200 `{codigosRecuperacion}` |
| `GET /auth/sesiones` | no `pendiente` | `[{id, creadaEn, ultimoUso, dispositivo, ip, actual}]` |
| `POST /auth/sesiones/:id/revocar` · `POST /auth/sesiones/revocar-otras` | no `pendiente` | 204 siempre |
Exigencia: 403 `segundo_factor_requerido`. Lista cerrada sin factor exigido: `GET /auth/sesion`, `GET/POST /auth/estudio(s)`, `totp/enrolar`, `totp/confirmar`, `logout`.

**BD** (sin `GRANT` a roles de la app; FK a `auth.usuario`; dueño y patrón de 0007):
- `auth.totp(usuario_id PK, activo_cifrado, activo_version, pendiente_cifrado, pendiente_version, pendiente_expira, ultimo_paso bigint, activado_en)`.
- `auth.totp_recuperacion(id, usuario_id, hash bytea UNIQUE, usado_en)`.
- `auth.cuenta_evento(id, usuario_id, tipo CHECK (totp_activado, totp_desactivado, recuperacion_usada, recuperacion_regenerada, totp_restablecido), creado_en)`: sin texto libre.
- `auth.sesion` + `factor` (`pendiente|verificado|sin_factor`, default `sin_factor`), `dispositivo` (≤ 60), `ip_red cidr`; motivos + `revocada_usuario`, `totp`.
- Funciones `auth.*` `SECURITY DEFINER`, `EXECUTE` a `contapp_backend`: `totp_leer`, `totp_enrolar_iniciar`, `totp_intento_reservar`, `totp_confirmar`, `totp_verificar_exito`, `totp_recuperacion_usar`, `totp_desactivar`, `totp_recuperacion_regenerar`, `sesiones_listar`, `sesion_revocar`, `sesiones_revocar_otras`; nuevas versiones de `login_exito` (factor, dispositivo, red) y de la validación de sesión (devuelve `factor`). `totp_restablecer(clave_correo)`: `EXECUTE` solo `contapp_migrator`.

**Shared**: `codigoTotpSchema` (`^\d{6}$`), `codigoRecuperacionSchema` (`XXXX-XXXX-XXXX`, base32), cuerpos y respuestas de arriba, `factorExigido({plataforma, rolSistema, permisos})` y `CASOS_FACTOR_EXIGIDO` (`factor-exigido.casos.ts`, tabla común para TS y SQL).

**Entorno**: `TOTP_CLAVE=<versión>:<base64 32 B>` (obligatoria en backend), `TOTP_CLAVE_ANTERIOR` opcional (solo descifra).

## Decisiones
- Verificar = `totp_intento_reservar` (suma al contador de 004 D7 de forma atómica; al 5.º bloquea 15 min y revoca la `pendiente`) → descifrar y evaluar en el backend → `totp_verificar_exito` (`UPDATE … WHERE ultimo_paso < $paso`, D3; reinicia el contador). Así 20 concurrentes dan ≤ 5 evaluaciones (CA-3). La 5.ª reserva bloquea y revoca antes de evaluar: no se evalúa, aunque el código sea bueno (decisión: más simple y sin ventana entre evaluar y revocar).
- Código de recuperación: 60 bits base32, HMAC-SHA-256 con subclave HKDF de `TOTP_CLAVE` (D1); uso = `UPDATE … WHERE usado_en IS NULL` atómico.
- Exigencia: `factorExigido` en `shared` (U1–U2), evaluada en `PermisoGuard` y en `@SoloPlataforma` con el rol y permisos que ya carga 005 y el `factor` de la validación de sesión (D2, sin consulta extra). `totp_desactivar` repite la regla en SQL sobre todas las membresías vigentes; una tabla de casos común prueba ambas.
- Sesiones previas (U3): la migración deja `factor = 'sin_factor'`; activar TOTP revoca las demás sesiones (motivo `totp`).
- Eventos de cuenta en `auth.cuenta_evento` (la auditoría de 017 es por estudio y el super-admin no tiene).
- Avisos: el backend usa `ColaCorreo` (004 D8) con `packages/correo/src/seguridad.ts`; el CLI usa la fábrica de `@contapp/correo` (sin ciclo: `correo` no depende de `db`). Sin códigos, secretos ni enlaces.
- QR en el navegador con `qrcode` (versión fija con ≥ 14 días); el URI no se guarda en estado persistente ni en el historial.
- Dispositivo (U6): lista cerrada navegador/SO o «Otro»; IP truncada a /24 o /48 antes de guardar.

## Riesgos
- Romper 004/005/006 al cambiar `login_exito` y la validación de sesión: se detecta con sus suites (`auth*.int.spec.ts`, `plataforma.int.spec.ts`), que se corren en T7 y T17.
- Regla de exigencia duplicada TS/SQL: tabla de casos común (T1, T3).
- Bloqueo por un atacante que conoce la contraseña (15 min): aceptado como en 004 CA-2.
- Reloj del servidor desfasado: pruebas con reloj inyectado en ±1 paso y bordes.
- Soportes de prueba: en modo `replica` no corren los `ON DELETE CASCADE`; borran `totp*`, `cuenta_evento` y sesiones antes del usuario y del estudio (y toda tabla con FK a `tenant`).
- Fuga del URI o códigos por caché o logs: canarios (CA-6) en backend, CLI, correo y frontend.
