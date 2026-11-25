# Tareas 029 · Cuenta segura (TOTP y sesiones)

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` en paralelo con las indicadas (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: pruebas (rojo) → implementar (verde) → cobertura → atacar (≤ 2 rondas, Opus) → corregir → E2E y verificar → revisión de Opus → cerrar. CA, D y U = `spec.md`; contratos = `plan.md`. Migraciones: 0078 (T5), 0079 (T14) y 0080 (T16), estas dos solo si hacen falta.

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Pruebas de BD: tablas, grants, funciones, concurrencia, catálogo, escalada, soportes, CLI y rendimiento (rojo) | tester | sonnet | — ∥ T2, T3, T4 | ✓ | — | [x] |
| T2 | Pruebas puras: RFC 6238, cifrado, recuperación, dispositivo, `shared` y plantillas de correo (rojo) | tester | sonnet | — ∥ T1, T3, T4 | ✓ | — | [x] |
| T3 | Pruebas HTTP: login en dos pasos, enrolar, exigencia, sesiones, CSRF, canarios (rojo) | tester | sonnet | — ∥ T1, T2, T4 | ✓ | — | [x] |
| T4 | Pruebas del frontend: paso de código, Seguridad, enrolamiento forzado (rojo) | tester | sonnet | — ∥ T1, T2, T3 | ✓ | — | [x] |
| T5 | Migración 0078, esquema drizzle y repositorio `auth/totp`, `auth/sesiones` | backend | opus | T1 ∥ T6 | ✓ | — | [x] |
| T6 | Puros del backend, `shared`, plantillas de `correo`, `TOTP_CLAVE` y dependencias | backend | sonnet | T2 ∥ T5 | ✓ | — | [x] |
| T7 | Servicios, guards y controlador: dos pasos, exigencia, sesiones, avisos | backend | opus | T3, T5, T6 ∥ T8, T9 | ✓ | — | [x] |
| T8 | CLI `db:totp-restablecer` | backend | sonnet | T1, T5, T6 ∥ T7, T9 | ✓ | — | [x] |
| T9 | Pantallas de 029 | frontend | sonnet | T4, T6 ∥ T5, T7, T8 | ✓ | — | [x] |
| T10 | Cobertura ≥ 90 % por archivo (globs) | devops | sonnet | T7, T8 ∥ T9 | — | — | [ ] |
| T11 | E2E con Mailpit y `pnpm e2e` completo | tester | sonnet | T7, T8, T9 ∥ T12–T16 | — | — | [ ] |
| T12 | Ronda 1a (caja negra, HTTP): autenticación y sesiones | adversario | opus | T10 ∥ T13 | — | ✓ | [ ] |
| T13 | Ronda 1b (caja blanca, BD y secretos) | adversario | opus | T10 ∥ T12 | — | ✓ | [ ] |
| T14 | Corregir hallazgos de la ronda 1 | backend (+frontend) | opus (sonnet) | T12, T13 | — | — | [ ] |
| T15 | Ronda 2: regresión y ataques a las correcciones (solo con hallazgos media/alta) | adversario | opus | T14 | — | ✓ | [ ] |
| T16 | Corregir hallazgos de la ronda 2 | backend (+frontend) | opus (sonnet) | T15 | — | — | [ ] |
| T17 | Verificar CA-1 a CA-11 con evidencia y prueba manual | tester | sonnet | T11, T16 | — | — | [ ] |
| T18 | Revisión final contra la spec | arquitecto | opus | T17 | — | — | [ ] |
| T19 | Cierre: `tasks.md`, `spec.md` y commit (el orquestador actualiza `ESTADO.md`) | devops | haiku | T18 | — | — | [ ] |

Paralelismo: oleada 1 = T1 (`tests/aislamiento/`, `packages/db/src/**/*.spec.ts`) ∥ T2 (specs de `totp/`, `packages/shared`, `packages/correo`) ∥ T3 (`apps/backend/src/modules/**/*.int.spec.ts`, `apps/backend/test/`) ∥ T4 (`apps/frontend/**/*.spec.tsx`). Oleada 2 = T5 (`packages/db/migrations`, `src/auth`, `src/schema`) ∥ T6 (`apps/backend/src/modules/auth/totp/` puros, `config/`, `shared`, `correo`, `package.json` de db y frontend, `pnpm-lock.yaml`) ∥ T9 desde que T6 termina. Oleada 3 = T7 (`apps/backend/src/modules/{auth,acceso,plataforma}`) ∥ T8 (`packages/db/src/cli/`, `package.json` raíz) ∥ T9 (`apps/frontend`). Rondas y correcciones en serie; T11 (`tests/e2e/`) ∥ T12–T16, y su `pnpm e2e` se repite tras T16 si T14 o T16 tocaron producción. Si la ronda 1 no deja hallazgos media/alta, T15 y T16 se marcan `[x]` «sin hallazgos».

Escalamientos: T5 y T7 nacen en `opus` (`SECURITY DEFINER`, RLS, concurrencia, autenticación; 04 §3.2). T6, T8, T9 pasan a `opus` si fallan 2 veces; T10 y T19 a `sonnet` si `haiku`/`sonnet` falla una vez.

Reglas comunes:
- **BD propia**: cada agente usa `contapp_029tN` (N = su tarea; T12 y T13 la suya) creada y migrada por él; **nunca** `DROP` ni `TRUNCATE` de `contapp` ni `contapp_e2e`. Nunca leer ni imprimir `.env`.
- Un commit por tarea (`test(029)`, `feat(029)`, `fix(029)`, `chore(029)`) con `git add <rutas>` explícitas y el trailer del modelo; sin `stash`, `reset`, `clean` ni push.
- El tester no toca producción; backend y frontend no editan `*.spec.ts`; solo T12, T13 y T15 escriben `*.adv.spec.ts` / `*.adv.int.spec.ts` (T1 solo amplía la lista cerrada de `escalada.adv.spec.ts`). La tarea que rompe una suite existente la ajusta sin quitar aserciones.
- **Funciones**: `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, `REVOKE ALL … FROM PUBLIC` y de cada rol antes del `GRANT` justo, SQLSTATE y mensaje fijos; cada función y tabla nueva en `escalada.adv.spec.ts` y `catalogo.spec.ts`. Nunca editar una migración aplicada.
- **Soportes de prueba** (`tests/aislamiento/auth-soporte.ts`, `acceso-soporte.ts`, `apps/backend/test/soporte-acceso.ts`, `tests/e2e/soporte/`): en `session_replication_role = replica` borran `auth.totp*`, `auth.cuenta_evento` y sesiones antes del usuario, y toda tabla con FK a `tenant` (descubierta por `information_schema`) antes del estudio; lanzan si algo queda.
- **Canarios** (CA-6): secreto, URI, códigos TOTP y de recuperación, contraseña; se buscan en logs, errores, `pg`, auditoría, `cuenta_evento`, correos y respuestas.
- **Rendimiento** (CA-8): `medirEscala` (`packages/domain/tests/ayudas/rendimiento.ts`; variante async en el soporte), mínimo de ≥ 5 corridas intercaladas, en `*.rendimiento.spec.ts` fuera de cobertura; no se sube un tope para que pase.
- Tareas largas (`pnpm e2e`, `test:aislamiento`, coberturas) desacopladas con `nohup … > log 2>&1 &`. Checks: solo fallos (`archivo:línea · mensaje`) o «OK» + conteo.
- **Mailpit** ya está en `docker-compose.yml` (028). Si falta la imagen o hay que instalar algo, parar y pedir permiso al usuario vía el orquestador.

## T1 · Pruebas de BD (tester · sonnet)
- **Contexto**: `plan.md#contratos` (BD), spec CA-1–CA-3, CA-5–CA-9; `tests/aislamiento/{auth-funciones,auth-sesion-consultar,catalogo}.spec.ts`, `escalada.adv.spec.ts`, `auth-soporte.ts`; `packages/db/src/auth/repositorio.spec.ts`; `packages/db/src/cli/plataforma-alta.int.spec.ts`.
- **Hacer**: `tests/aislamiento/auth-totp*.spec.ts` (grants, D3 atómico, reservar ≤ 5 de 20 concurrentes, recuperación de un uso concurrente, `totp_desactivar` con `CASOS_FACTOR_EXIGIDO`, `sin_factor` por defecto, revocar ajena = misma salida); repositorio `auth/totp.spec.ts`, `sesiones.spec.ts` (+ `.rendimiento.spec.ts`); `cli/totp-restablecer*.spec.ts`; soportes y listas cerradas.
- **Hecho cuando**: todo en rojo por falta de 0078/repositorio/CLI (no por error de la prueba) y las suites existentes siguen verdes.

## T2 · Pruebas puras (tester · sonnet)
- **Contexto**: `plan.md#contratos` (Shared, Entorno) y `#decisiones`; spec D1, U4, U6, U8; `apps/backend/src/modules/auth/sesion/token.spec.ts`; `packages/correo/src/consola.spec.ts`.
- **Hacer**: specs de `totp/{rfc6238,cifrado,recuperacion,dispositivo}` (vectores RFC 6238 apéndice B, ±1 paso y bordes, AAD distinto falla, versión de clave, HMAC, UA→lista cerrada, /24 y /48); `packages/shared/src/auth/seguridad.spec.ts` y `factor-exigido.casos.ts`; `packages/correo/src/seguridad.spec.ts` (sin códigos ni enlaces).
- **Hecho cuando**: rojo por módulos ausentes; `CASOS_FACTOR_EXIGIDO` cubre U1–U2 (super-admin, Dueño, Administrador, cada permiso de U2, rol sin ellos).

## T3 · Pruebas HTTP (tester · sonnet)
- **Contexto**: `plan.md#contratos` (HTTP); spec CA-1–CA-6, CA-9, CA-10; `apps/backend/src/modules/auth/{auth.login,auth.sesion,auth.csrf,auth.fugas}.int.spec.ts`, `plataforma/plataforma.int.spec.ts`; `apps/backend/test/{soporte-acceso,fakes-auth,auditoria-rutas}.ts`.
- **Hacer**: `modules/auth/totp*.int.spec.ts`: `pendiente` 401 en toda ruta salvo verificar/logout, rotación, replay, 403 `segundo_factor_requerido` (plataforma, cambio de estudio y de rol, sesión previa), lista cerrada, restablecer contraseña no salta TOTP, desactivar 409, sesiones, CSRF/Origen, `no-store`, canarios, avisos en `CorreoMemoria`; reloj inyectado.
- **Hecho cuando**: rojo por rutas ausentes; `auditoria-rutas` incluye las rutas nuevas.

## T4 · Pruebas del frontend (tester · sonnet)
- **Contexto**: `plan.md#contratos`; spec Alcance; `apps/frontend/app/(publico)/login/page.spec.tsx`, `(app)/cuenta/contrasena/page.spec.tsx`, `(app)/layout.spec.tsx`, `components/marco/menu-principal.spec.tsx`.
- **Hacer**: `login/segundo-factor.spec.tsx` (código y recuperación, errores, 429); `(app)/cuenta/seguridad/page.spec.tsx` (enrolar con QR sin guardar el URI, confirmar, códigos una vez, desactivar, regenerar, lista y revocación); enrolamiento forzado en `(app)` y `(plataforma)`; entrada de menú.
- **Hecho cuando**: rojo por pantallas ausentes; la API se simula con los esquemas de `shared`.

## T5 · Migración 0078 y repositorio (backend · opus)
- **Contexto**: `plan.md#contratos` (BD) y `#decisiones`; `packages/db/migrations/0007_auth.sql`, `0010_auth_final.sql`, `0013_acceso_auth.sql`; `packages/db/src/auth/repositorio.ts`; pruebas de T1.
- **Hacer**: `0078_cuenta_segura.sql` (tablas, columnas y motivos de `auth.sesion`, funciones y nuevas versiones de `login_exito` y de la validación de sesión), drizzle, `src/auth/totp.ts`, `sesiones.ts`.
- **Hecho cuando**: pruebas de BD de T1 (salvo CLI) en verde; `db:migrate` dos veces sin error; suites `tests/aislamiento/auth*` y `packages/db` verdes.

## T6 · Puros, shared, correo y entorno (backend · sonnet)
- **Contexto**: `plan.md` (Archivos, Shared, Entorno, Decisiones); pruebas de T2; `apps/backend/src/config/`; `packages/correo/src/index.ts`; `.env.example`.
- **Hacer**: `totp/{rfc6238,cifrado,recuperacion,dispositivo}.ts` con `node:crypto` y `timingSafeEqual`; `shared/auth/seguridad.ts`; `correo/src/seguridad.ts`; `TOTP_CLAVE` obligatoria; añade `@contapp/correo` a `packages/db` y `qrcode` (versión exacta ≥ 14 días) a `apps/frontend`.
- **Hecho cuando**: pruebas de T2 verdes; el backend no arranca sin `TOTP_CLAVE` válida; `pnpm install --frozen-lockfile` OK.

## T7 · Servicios, guards y controlador (backend · opus)
- **Contexto**: `plan.md` completo; pruebas de T3; `apps/backend/src/modules/auth/{auth.service,auth.controller}.ts`, `guards/`, `acceso/guards/permiso.guard.ts`, `infra/correo/cola.ts`.
- **Hacer**: `totp.service`, `sesiones.service`, `totp.controller`; login en dos pasos, `@PermitirPendiente`, exigencia en `PermisoGuard` y `@SoloPlataforma` sin consulta extra (D2), lista cerrada, rotación, revocaciones, eventos y avisos (U8).
- **Hecho cuando**: pruebas de T3 verdes; `auth*`, `acceso*` y `plataforma*` del backend verdes; CA-8 del guard en verde.

## T8 · CLI de restablecimiento (backend · sonnet)
- **Contexto**: `plan.md` (U5, Decisiones); `packages/db/src/cli/plataforma-alta.ts`, `comun.ts`; pruebas `cli/totp-restablecer*` de T1.
- **Hacer**: `cli/totp-restablecer.ts` con `MIGRATIONS_DATABASE_URL`, llama `auth.totp_restablecer`, avisa con la fábrica de `@contapp/correo`, salida y código de salida iguales exista o no el correo; script raíz `db:totp-restablecer`.
- **Hecho cuando**: pruebas del CLI verdes; nunca imprime URL, secreto ni correo ajeno.

## T9 · Pantallas (frontend · sonnet)
- **Contexto**: `plan.md#contratos`; pruebas de T4; `apps/frontend/app/(publico)/login/page.tsx`, `(app)/cuenta/contrasena/page.tsx`, `(app)/layout.tsx`, `(plataforma)/`, `components/marco/menu-principal.tsx`.
- **Hacer**: paso de código en login, `(app)/cuenta/seguridad/`, enrolamiento forzado ante `factorExigido` o 403 `segundo_factor_requerido`, entrada «Seguridad»; QR con `qrcode`; los códigos se muestran una vez y no se persisten.
- **Hecho cuando**: pruebas de T4 verdes; `pnpm --filter @contapp/frontend build` y lint OK.

## T10 · Cobertura (devops · sonnet)
- **Contexto**: `apps/backend/vitest.cobertura.config.mts`, `packages/db/vitest.cobertura.config.mts`; spec «Cobertura».
- **Hacer**: agregar globs y proyectos que falten (`packages/correo/src/seguridad.ts` y sus pruebas, `tests/aislamiento/auth-totp*`); sin configs ni pasos de CI nuevos; correr `cobertura:backend` y `cobertura:db`.
- **Hecho cuando**: ≥ 90 % por archivo en lo nuevo; si no, crear T10a (tester, ramas faltantes) sin bajar umbrales ni excluir.

## T11 · E2E con Mailpit (tester · sonnet)
- **Contexto**: `tests/e2e/README.md`, `soporte/correo.ts`, `flujos/correo.e2e.ts`, `flujos/alta.e2e.ts`; spec CA-2, CA-4, CA-10.
- **Hacer**: `flujos/cuenta-segura.e2e.ts`: super-admin forzado a enrolar, login en dos pasos con TOTP calculado en la prueba, código de recuperación, revocar otra sesión, avisos en Mailpit sin códigos.
- **Hecho cuando**: el flujo y `pnpm e2e` completo en verde con adaptadores `mock`.

## T12 · Ronda 1a, caja negra (adversario · opus)
- **Contexto**: spec CA-11 y CA-1–CA-6; `plan.md#contratos`; 04 §2.3. Sin leer la implementación.
- **Hacer**: ≤ 15 pruebas en `apps/backend/src/modules/auth/totp-r1a.adv.int.spec.ts`: replay, carreras, desfase de reloj, fuerza bruta del segundo paso, `pendiente` en otras rutas o al cambiar de estudio, saltar el enrolamiento, revocar ajenas, enumeración, CSRF.
- **Hecho cuando**: cada prueba que falla es un hallazgo con severidad en `resultados.md`; las que pasan quedan como regresión.

## T13 · Ronda 1b, caja blanca (adversario · opus)
- **Contexto**: spec CA-6, CA-7, CA-9; `0078_cuenta_segura.sql`; `packages/db/src/auth/totp.ts`; `totp/cifrado.ts`, `recuperacion.ts`; `packages/db/src/cli/totp-restablecer.ts`.
- **Hacer**: ≤ 15 pruebas en `tests/aislamiento/auth-totp-r1b.adv.spec.ts`: leer el secreto o los hashes con el rol del backend, volcado sin clave, funciones definer con argumentos ajenos, sesiones previas, restablecer contraseña o CLI con sesión viva, canarios en `pg`.
- **Hecho cuando**: como T12.

## T14 · Corregir ronda 1 (backend · opus; frontend · sonnet si hay pantalla)
- **Contexto**: `resultados.md` (hallazgos de T12–T13) y solo los archivos que nombran.
- **Hacer**: corregir sin editar las `*.adv.spec.ts`; migración 0079 si toca BD.
- **Hecho cuando**: las pruebas de T12–T13 y las suites del paquete afectado en verde.

## T15 · Ronda 2 (adversario · opus)
- **Contexto**: diff de T14; `resultados.md`; spec CA-11.
- **Hacer**: solo si T12–T13 dejaron hallazgos media/alta: ≤ 15 pruebas en `totp-r2.adv.int.spec.ts` contra las correcciones (regresión y variantes).
- **Hecho cuando**: hallazgos con severidad en `resultados.md`, o `[x]` «sin hallazgos».

## T16 · Corregir ronda 2 (backend · opus; frontend · sonnet si hay pantalla)
- **Contexto**: `resultados.md` (hallazgos de T15) y los archivos que nombran.
- **Hacer**: corregir; migración 0080 si toca BD.
- **Hecho cuando**: pruebas de T15 y suites afectadas en verde.

## T17 · Verificar (tester · sonnet)
- **Contexto**: spec completa; `resultados.md`.
- **Hacer**: evidencia por CA (prueba o comando); `test:aislamiento`, backend, db, shared, correo y frontend completos; `db:migrate` ×2; coberturas; `pnpm e2e`; prueba manual con el sistema levantado y `mock`.
- **Hecho cuando**: tabla CA → evidencia en `resultados.md` sin pendientes, o defectos listados como T17a/T17b.

## T18 · Revisión final (arquitecto · opus)
- **Contexto**: spec, plan, `resultados.md`, diff de la rama.
- **Hacer**: revisar cada CA con su evidencia y las reglas de `CLAUDE.md` (secretos, RLS, puertos).
- **Hecho cuando**: veredicto en `resultados.md`; defectos como T18a (tester, rojo) y T18b (backend · opus).

## T19 · Cierre (devops · haiku)
- **Contexto**: esta tabla; `cierre.md` de la plantilla.
- **Hacer**: marcar estados, `spec.md` a «hecha», `cierre.md`, commit `chore(029): cierre`.
- **Hecho cuando**: árbol limpio para las rutas de 029 y el orquestador puede actualizar `ESTADO.md`.
