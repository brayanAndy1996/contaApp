# Tareas 006 · Planes, registro de estudio y límites

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel B. Flujo 04 §1.3: pruebas primero (rojo) → implementar (verde) → atacar solo el registro público (D12) → corregir → verificar → revisión contra la spec → cerrar. La rama `spec/006-planes` ya existe (desde `main`) y los docs aprobados están commiteados. CA y D = `spec.md`; contratos y decisiones = `plan.md`. Se implementa después de 011 y 008 sobre la misma BD de pruebas local: 006 no usa código de 008 (spec, Dependencias).
| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Pruebas de BD: esquema, grants, funciones `auth`, carreras de cupo (rojo) | tester | sonnet | — | ✓ | — | [ ] |
| T2 | Pruebas unitarias: shared, adaptadores de cupo, `@SoloPlataforma` y rutas (rojo) | tester | sonnet | — ∥ T1 | ✓ | — | [ ] |
| T3 | Pruebas de integración HTTP: registro, uso, plataforma y cupos (rojo) | tester | sonnet | T1 ∥ T2 | ✓ | — | [ ] |
| T4 | Pruebas del frontend (rojo) | tester | sonnet | — ∥ T3 | ✓ | — | [ ] |
| T5 | Migraciones, esquema, repos de `planes`, `AuthRepo` y seed | backend | opus | T1 | ✓ | — | [ ] |
| T6 | `shared/planes`: esquemas y `limiteEfectivoRucs` | backend | sonnet | T2 ∥ T5 | ✓ | — | [ ] |
| T7 | Cupos reales (`CupoUsuarios`, `CupoRucs`), `crearApp`, `GET /plan/uso` y módulos vacíos | backend | sonnet | T2, T3, T5, T6 | ✓ | — | [ ] |
| T8 | Registro público: servicio y controlador | backend | sonnet | T3, T5, T6, T7 | ✓ | — | [ ] |
| T9 | Plataforma: `@SoloPlataforma`, planes, estudios y suscripción | backend | sonnet | T3, T5, T6, T7 ∥ T8 | ✓ | — | [ ] |
| T10a | Pantallas: registro, confirmación, onboarding e indicador de uso | frontend | haiku | T4 ∥ T5–T9 | ✓ | — | [ ] |
| T10b | Pantalla del super-admin: planes y suscripción de estudios | frontend | haiku | T4 ∥ T10a | ✓ | — | [ ] |
| T11 | Integración: checks completos y prueba manual | devops | haiku | T8, T9, T10a, T10b | — | — | [ ] |
| T12a | Ronda adversarial del registro: caja negra | adversario | opus | T11 | — | ✓ | [ ] |
| T12b | Ronda adversarial del registro: caja blanca | adversario | opus | T11 ∥ T12a | — | ✓ | [ ] |
| T13 | Corregir hallazgos de la ronda | backend (+frontend) | sonnet / opus | T12a, T12b | — | — | [ ] |
| T14 | Verificar CA-1 a CA-11 con evidencia | tester | sonnet | T13 | — | — | [ ] |
| T15 | Revisión contra la spec | arquitecto | sonnet | T14 | — | — | [ ] |
| T16 | Cierre: tasks y commit (el orquestador actualiza ESTADO) | devops | haiku | T15 | — | — | [ ] |

Escalamientos: T5 nace en `opus` (funciones `SECURITY DEFINER` que crean estudios y escriben planes; precedente 005 T7, 04 §3.3). T13 pasa a `opus` solo si el hallazgo toca una función `auth.*` o una migración.

Decisiones del usuario: 2026-10-27, "Apruebo las specs 006, 008 y 011 con todo lo recomendado por el arquitecto en cada P. Continúa con plan y tareas." (P1 super-admin con tabla y endpoints; P2 registro por enlace de correo; P3 usuarios = activos + pendientes; P4 Prueba con 1 usuario; P5 adicionales fijados por el super-admin y plan editado en sitio; P6 adversario solo en el registro.)

Reglas comunes:
- Un commit por tarea (Conventional Commits `feat(006): …`, `test(006): …`, `fix(006): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin remoto ni push.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` (cambios ajenos): `git add <rutas>` explícitas, nunca `git add -A`/`.`.
- Nunca imprimir, registrar ni commitear contraseñas reales, tokens de registro o de sesión, `SMTP_URL` ni el contenido de `.env`. Las pruebas usan canarios; la única contraseña versionada sigue siendo `SEED.contrasenaDesarrollo`.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o "OK" + conteo. Correr solo las pruebas del paquete afectado; la suite completa en T11 y T14.
- El tester no toca código de producción; backend y frontend no editan `*.spec.ts` ni `*.adv*.spec.ts`; el adversario solo escribe `*.adv.spec.ts` (`*.adv.int.spec.ts` si usa BD o HTTP).
- Migraciones: número = el siguiente libre tras la última aplicada (008 pudo ocupar 0017 en adelante; comprobar `packages/db/migrations`); nunca editar una aplicada, ni las de 005 (0011–0016); no redefinir funciones de 0008. Las pruebas no fijan cifras como `FUNCIONES_AUTH = 15`: leen el conteo vigente y suman las 11 de 006.
- Las pruebas de 002–005 (y las de 008 si ya están) siguen en verde; si una contradice 006 se ajusta solo en la tarea de pruebas que lo diga, con comentario.
- Orden de bloqueo de `plan.md` (Decisiones) obligatorio: el cupo se llama después de bloquear miembros y antes de tocar `cliente`, `asignacion` o `invitacion`.
- Escalar según 04 §3.3 y anotar arriba. Una ambigüedad que cambie la spec no se decide: `requiere usuario` y se informa al orquestador.

## T1 · Pruebas de BD, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/006-planes/spec.md` (CA-1 a CA-8; D1–D3, D5–D7, D10, D11), `docs/specs/006-planes/plan.md` (Contratos: BD; Decisiones), `tests/aislamiento/{soporte,auth-soporte,acceso-soporte}.ts`, `tests/aislamiento/{catalogo,auth,acceso,acceso-funciones}.spec.ts` (patrones de catálogo, privilegios, funciones y carreras con dos conexiones).
- **Hacer**: `tests/aislamiento/planes.spec.ts` (catálogo y privilegios) y `planes-funciones.spec.ts` (comportamiento). Cubrir: `suscripcion` con RLS `ENABLE`+`FORCE` y `tenant_isolation`; `plan` y `admin_plataforma` sin `tenant_id`; `contapp_backend` solo `SELECT` en `suscripcion` y sin `precio_*` (permission denied al leerlos), nada en `admin_plataforma`; `contapp_worker` y `contapp_platform` sin acceso nuevo; CHECK de `plan` (límites en 0, negativos, `max_rucs_extra * 5 > max_rucs`, `NULL` solo en `max_usuarios`), `UNIQUE(tenant_id)`, `prueba_vence_en` obligatorio en `prueba`; los 5 planes del seed y el backfill (todo estudio existente tiene suscripción); `registro_crear` igual con cuenta existente o no (mismo retorno, una fila, invalida la anterior del mismo correo, borra vencidos de más de 7 días), `registro_confirmar_nueva` crea estudio + usuario + membresía `dueno` + suscripción `prueba` de 14 días en una transacción, `cuenta_existe` sin consumir, token reusado/vencido/alterado → `invalida`, dos confirmaciones concurrentes → un solo estudio, `sin_plan` sin plan `prueba` activo; `registro_confirmar_existente` (correo de la sesión, sin tocar contraseña); `cupo_usuarios_aceptar`; las 6 funciones de plataforma con un no-admin (cero filas o error genérico), sesión revocada o sin alta, y las que escriben solo tocan `plan`/`suscripcion`; asignar plan inactivo y extra sobre el tope; `limite_consumir('registro_ip'|'registro_correo')`; carreras con dos conexiones: dos `bloquearCupo` del mismo estudio se serializan, de estudios distintos no; invitar + aceptar + reactivar simultáneos con un solo cupo libre dejan `activos + pendientes ≤ max` y ningún `40P01`. Ajustar `catalogo.spec.ts`, `auth-soporte.ts` y `auth.spec.ts` (conteo de funciones = vigente + 11) con comentario.
- **Hecho cuando**: `pnpm test:aislamiento` falla solo en lo nuevo y por falta de esquema o funciones; lo de 002–005 (y 008 si está) sigue verde salvo los ajustes, que fallan solo por lo que falta. Lista de pruebas en el commit. Commit `test(006): esquema de planes, funciones auth y carreras de cupo (rojo)`.

## T2 · Pruebas unitarias, rojo (tester · sonnet) ∥ T1
- **Contexto (leer solo esto)**: `docs/specs/006-planes/spec.md` (CA-1, CA-2, CA-5, CA-6, CA-7; D4, D6, D7, D10), `docs/specs/006-planes/plan.md` (Contratos: shared, Puertos de cupo, HTTP), `apps/backend/src/modules/acceso/cupo/cupo-usuarios.ts`, `apps/backend/src/modules/acceso/guards/{decoradores,permiso.guard}.ts` y su `*.spec.ts`, `apps/backend/test/auditoria-rutas.ts`.
- **Hacer**: `packages/shared/src/planes/*.spec.ts`: esquemas (límites inválidos, precios con más de 2 decimales o en notación científica, claves extra descartadas, `features` grande), `limiteEfectivoRucs` por tabla (`contratados` mayor y menor que el tope). `apps/backend/src/modules/planes/cupo/*.spec.ts` con `tx` falsa: `CupoUsuariosPlanes` (alInvitar/alReactivar cuentan activos + pendientes + 1; alAceptar llama `cupoUsuariosAceptar`; `max_usuarios` nulo no limita; sin suscripción → `PlanNoDisponibleError`; el bloqueo se toma antes de contar, espía de orden), `CupoRucs` (`libres`, `reservar` con `n` = 1, 50 y 0; sobre el límite → `CupoRucsError`). Guard: `@SoloPlataforma` es declaración válida solo junto a `@SinEstudio`, no con `@Permiso`/`@SoloEstudio`; sin declaración sigue 403; la auditoría de rutas (CA-11 de 005) lista las rutas nuevas con su declaración.
- **Hecho cuando**: `pnpm --filter @contapp/shared test` y `pnpm --filter @contapp/backend test` fallan solo por falta de implementación. Commit `test(006): esquemas, cupos y declaración de plataforma (rojo)`.

## T3 · Pruebas de integración HTTP, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/006-planes/spec.md` (CA-1 a CA-9), `docs/specs/006-planes/plan.md` (Contratos: HTTP; Decisiones: Orden de bloqueo), `apps/backend/test/{soporte,soporte-acceso,soporte-cupo}.ts`, `apps/backend/src/modules/acceso/invitaciones.int.spec.ts` (patrón de correo en memoria y espías), `apps/backend/src/aislamiento/hu40-api.int.spec.ts`.
- **Hacer**: `apps/backend/src/modules/{planes,registro,plataforma}/*.int.spec.ts` con `crearApp({ correo: CorreoMemoria })` y el adaptador real. Registro: 202 igual con correo nuevo y con cuenta existente (cuerpo, código y cabeceras; sin `Set-Cookie`; el correo sale por la cola con enlace `#t=`); 429 por IP y por correo; consultar/confirmar felices (estudio con plan Prueba, 14 días, 5 RUCs, Dueño); contraseña inválida antes de tocar el token; enlace reusado, vencido, alterado o ajeno → misma respuesta; cuenta existente → 409 `requiere_sesion` y `confirmar-con-sesion` con otro correo → 400; confirmar dos veces a la vez → un solo estudio; canarios de token y contraseña ausentes de logs, errores y respuestas. `GET /plan/uso` (miembro de cualquier rol, sin precios, 409 `sin_plan` sin suscripción, nunca datos de otro estudio). Cupos: invitar al llegar al máximo → 409 `cupo_usuarios`; aceptar con el plan bajado → 409; reactivar → 409; dos invitaciones simultáneas con un solo cupo → una; `CupoRucs.reservar` con el adaptador real y dos `withTenant` simultáneos del mismo estudio (sin HTTP: 007 aún no trae rutas de clientes), con dos importaciones que juntas superan el límite; bajar `max_usuarios` o `max_rucs` por la API de plataforma no borra ni desactiva nada y bloquea agregar (CA-7); cambiar el plan en BD cambia el comportamiento sin reiniciar (CA-2). Plataforma: CRUD de planes con valores inválidos, plan desactivado no asignable (409), no-admin (miembro Dueño incluido) → 403 en todas, usuario sin estudio pero admin sí entra, ningún campo `tenantId`/`planId` del cuerpo cambia otro estudio salvo en la ruta de asignación. HU-40: usuario de A con IDs de B en `/plataforma/*` y `/plan/uso` (CA-8). Regresión CA-9: ajustar `soporte-acceso.ts` para que los fixtures de estudio creen su suscripción `corporativo`, y correr las suites de 004 y 005 con el adaptador real.
- **Hecho cuando**: `pnpm --filter @contapp/backend test:int` falla solo en lo nuevo y por lo que falta; las suites de 004–005 siguen en el mismo estado salvo el ajuste de fixtures. Commit `test(006): registro, uso, plataforma y cupos por HTTP (rojo)`.

## T4 · Pruebas del frontend, rojo (tester · sonnet) ∥ T3
- **Contexto (leer solo esto)**: `docs/specs/006-planes/spec.md` (CA-10; D8), `docs/specs/006-planes/plan.md` (Contratos: HTTP, shared), `apps/frontend/app/(publico)/invitacion/page.spec.tsx` (patrón de token en fragmento), `apps/frontend/app/(app)/usuarios/page.spec.tsx`, `apps/frontend/vitest.config.mts`.
- **Hacer**: pruebas de componente: registro (campos, RUC de 11 dígitos opcional, siempre el mismo mensaje "revisa tu correo", 429); confirmar (lee el token del fragmento, contraseña inválida muestra el motivo, 409 `requiere_sesion` lleva a iniciar sesión); onboarding de primeros pasos tras el primer login; indicador `usados de límite` de RUCs y usuarios con ilimitado, y aviso al llegar al máximo con "contacta a ContApp para subir de plan"; la pantalla Usuarios muestra el 409 `cupo_usuarios` de forma clara; pantalla de planes del super-admin (lista, crear/editar con errores de validación del servidor, desactivar) y asignación de plan a un estudio; las acciones y el menú de plataforma no aparecen si `GET /plataforma/yo` da 403.
- **Hecho cuando**: `pnpm --filter @contapp/frontend test` falla solo por falta de las pantallas. Commit `test(006): pantallas de registro, uso del plan y planes (rojo)`.

## T5 · Migraciones, esquema, repos y seed (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/006-planes/plan.md` (Archivos, Contratos: BD y packages/db, Decisiones), `tests/aislamiento/planes*.spec.ts`, `packages/db/migrations/{0007_auth,0012_acceso_rls,0013_acceso_auth,0016_acceso_ronda2}.sql` (patrones de funciones `SECURITY DEFINER`, políticas de `contapp_auth` y reglas del nombre), `packages/db/src/{schema,auth/repositorio.ts,seed/datos.ts,cli/seed.ts,index.ts}`.
- **Hacer**: comprobar el último número aplicado y crear las tres migraciones de `plan.md` (la primera con `drizzle-kit generate`, las otras con `--custom`; seed de planes y backfill en la primera, dentro del mismo archivo). Esquema Drizzle de `plan`, `suscripcion`, `admin_plataforma` y `tenant.ruc_estudio`. Repos de `planes/` y las 11 funciones en `AuthRepo`. Seed: un usuario de plataforma dado de alta en `admin_plataforma` sin membresía, con `SEED.contrasenaDesarrollo`. Aplicar con `MIGRATIONS_DATABASE_URL`.
- **Hecho cuando**: `pnpm test:aislamiento` y `pnpm --filter @contapp/db test` de T1 en verde y las de 002–005 (y 008) sin regresión; migraciones idempotentes al correrlas dos veces; sin SQL crudo fuera de `packages/db` (lint). Commit `feat(006): planes, suscripción y funciones de registro y plataforma`.

## T6 · `shared/planes` (backend · sonnet) ∥ T5
- **Contexto (leer solo esto)**: `docs/specs/006-planes/plan.md` (Contratos: shared), `packages/shared/src/planes/*.spec.ts`, `packages/shared/src/acceso/esquemas.ts` (patrón zod), `packages/shared/src/index.ts`.
- **Hacer**: esquemas zod, tipos y `limiteEfectivoRucs` (función pura, enteros; precios como cadena, sin `number` para dinero); exportar.
- **Hecho cuando**: `pnpm --filter @contapp/shared test`, typecheck y lint en verde. Commit `feat(006): esquemas y límite efectivo de planes en shared`.

## T7 · Cupos reales, `crearApp` y `GET /plan/uso` (backend · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/006-planes/plan.md` (Contratos: puertos de cupo, HTTP; Decisiones: orden de bloqueo), `apps/backend/src/modules/planes/**/*.spec.ts` y `*.int.spec.ts`, `apps/backend/src/modules/acceso/cupo/{cupo-usuarios,sin-limite}.ts`, `apps/backend/src/modules/acceso/{usuarios,invitaciones}.service.ts` (solo dónde llaman al cupo), `apps/backend/src/{app.ts,app.module.ts}`, `apps/backend/src/infra/nucleo.module.ts`.
- **Hacer**: `PlanesModule` con `CupoUsuariosPlanes`, `CupoRucs` (token `CUPO_RUCS`, `CupoRucsError`, `PlanNoDisponibleError` → 409 `sin_plan`) y `GET /plan/uso` (`@SoloEstudio`); `crearApp({cupoUsuarios?, cupoRucs?})` con los adaptadores reales por defecto; registrar en `AppModule` los módulos `planes`, `registro` y `plataforma` (los dos últimos vacíos, para que T8 y T9 no toquen `app.module.ts`). Si una prueba de carrera muestra que 005 llama al cupo antes de bloquear al actor, mover solo esa llamada (ver Archivos).
- **Hecho cuando**: pruebas de T2 (cupos) y de T3 (uso, cupos, regresión CA-9) en verde; suites de 004 y 005 sin regresión; typecheck y lint OK. Commit `feat(006): cupos reales de usuarios y RUCs y uso del plan`.

## T8 · Registro público (backend · sonnet) ∥ T9
- **Contexto (leer solo esto)**: `docs/specs/006-planes/spec.md` (CA-3, CA-4; D3), `docs/specs/006-planes/plan.md` (Contratos: HTTP, BD), `apps/backend/src/modules/registro/*.spec.ts`, `apps/backend/src/modules/acceso/{invitaciones.service,invitaciones.controller,entrada}.ts` (patrón: token, correo por cola, aceptar con y sin sesión), `apps/backend/src/modules/auth/limites/ip.ts`, `apps/backend/src/modules/auth/contrasena/politica.ts`.
- **Hacer**: `RegistroService` y controlador: `randomBytes(32)` base64url y SHA-256 a BD, límite por IP y por correo (`registro_ip`, `registro_correo`) antes de cualquier trabajo, correo por `ColaCorreo` tras el commit con `${APP_ORIGIN}/registro/confirmar#t=<token>` (mismo texto exista o no la cuenta), validación de contraseña con la política de 004 antes de tocar el token, `confirmar-con-sesion`, errores sin eco de la entrada. Sin auto-login: tras confirmar el usuario inicia sesión.
- **Hecho cuando**: pruebas de T3 del registro en verde, incluidas la de tiempo/cabeceras y los canarios; typecheck y lint OK. Commit `feat(006): registro público de estudio con confirmación por correo`.

## T9 · Plataforma: planes, estudios y suscripción (backend · sonnet) ∥ T8
- **Contexto (leer solo esto)**: `docs/specs/006-planes/spec.md` (CA-1, CA-7; D5, D10, D11, D13), `docs/specs/006-planes/plan.md` (Contratos: HTTP, BD), `apps/backend/src/modules/plataforma/*.spec.ts` y `*.int.spec.ts`, `apps/backend/src/modules/acceso/guards/{decoradores,permiso.guard}.ts`, `apps/backend/test/auditoria-rutas.ts`, `apps/backend/src/modules/auth/guards/{sesion,estudio}.guard.ts`.
- **Hacer**: decorador `@SoloPlataforma()` (declaración válida junto a `@SinEstudio`, excluyente con `@Permiso`/`@SoloEstudio`) y su soporte en `PermisoGuard` y en la auditoría de rutas; controlador y servicio que llaman las funciones `auth.*` con el hash de la sesión viva; ningún endpoint recibe el estudio del cuerpo salvo `:tenantId` de la ruta de asignación; el DTO nunca incluye hashes ni datos de otro estudio.
- **Hecho cuando**: pruebas de T2 (guard y rutas) y de T3 (plataforma, HU-40) en verde; typecheck y lint OK. Commit `feat(006): gestión de planes y suscripciones por el super-admin`.

## T10a · Registro, confirmación, onboarding e indicador de uso (frontend · haiku)
- **Contexto (leer solo esto)**: `docs/specs/006-planes/spec.md` (CA-10; D8), `docs/specs/006-planes/plan.md` (Contratos: HTTP, shared), `apps/frontend/app/(publico)/registro/**/*.spec.tsx` y `apps/frontend/app/(app)/**/*.spec.tsx` de T4, `apps/frontend/app/(publico)/invitacion/page.tsx` (patrón de token en fragmento), `apps/frontend/lib/api.ts`, `apps/frontend/next.config.ts`.
- **Hacer**: `registro/page.tsx` y `registro/confirmar/page.tsx`, `components/uso-plan.tsx`, tarjeta de primeros pasos en `(app)/page.tsx` y el indicador en Usuarios (más el mensaje del 409 `cupo_usuarios`); `Referrer-Policy: no-referrer` en `/registro/confirmar`; enlace "Crear estudio" en login. Solo depende de `packages/shared`.
- **Hecho cuando**: pruebas de T4 correspondientes, typecheck y lint verdes. Commit `feat(006): registro, onboarding e indicador de uso del plan`.

## T10b · Pantalla del super-admin (frontend · haiku) ∥ T10a
- **Contexto (leer solo esto)**: `docs/specs/006-planes/plan.md` (Contratos: HTTP, shared), pruebas de T4 de `(plataforma)/admin`, `apps/frontend/app/(app)/usuarios/page.tsx` (patrón de lista y formularios), `apps/frontend/lib/api.ts`.
- **Hacer**: `(plataforma)/admin/{page,planes/page}.tsx`: lista y edición de planes (precios como texto decimal), desactivar, lista mínima de estudios y asignación de plan y RUCs adicionales; la sección no se muestra si `GET /plataforma/yo` da 403.
- **Hecho cuando**: pruebas de T4 correspondientes, typecheck y lint verdes. Commit `feat(006): pantalla de planes del super-admin`.

## T11 · Integración (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/006-planes/plan.md` (Contratos: HTTP), `package.json`.
- **Hacer**: correr `pnpm build`, `typecheck`, `lint`, `test`, `ci:db`. Prueba manual (backend `PORT=4000`, frontend `next build && next start`, `curl` vía `http://localhost:3000/api`): registrar un correo nuevo → el enlace sale por el stdout del backend (no copiarlo al informe) → confirmar → login → `GET /plan/uso` muestra Prueba, 5 RUCs, 1 usuario; invitar da 409 `cupo_usuarios`; el usuario de plataforma del seed lista planes y sube el estudio a `estudio`; un Dueño de estudio recibe 403 en `/plataforma/planes`; `curl -I /registro/confirmar` trae `Referrer-Policy: no-referrer`.
- **Hecho cuando**: todo sale 0 (reportar conteos); la prueba manual da lo esperado; servidores parados; `git status` sin archivos ajenos agregados. Commit `chore(006): integración y checks completos` solo si cambió algún archivo.

## T12a · Ronda adversarial del registro, caja negra (adversario · opus)
- **Contexto (leer solo esto)**: `docs/specs/006-planes/spec.md` (CA-3, CA-4, CA-11; D3, D12), `docs/specs/006-planes/plan.md` (Contratos: HTTP), `apps/backend/test/soporte.ts` (arranque de la app), `docs/04-metodologia.md` §2.3.
- **Hacer**: solo con la interfaz pública, escribir hasta ~15 pruebas `*.adv.int.spec.ts`: enumeración de cuentas por código, cuerpo, cabeceras o tiempo (variantes de mayúsculas, espacios y alias del correo); token reusado, concurrente, vencido, truncado, de otro correo; confirmar con sesión de otra cuenta; registro masivo para crear estudios basura (límites por IP y por correo, cabeceras `X-Forwarded-For` falsas); RUC o nombres con caracteres de control, longitudes enormes o inyección; `plan`/`rol`/`tenantId` extra en el cuerpo; XSS o enlace falso en el correo (`APP_ORIGIN`); token o contraseña en logs.
- **Hecho cuando**: lista de hallazgos (prueba que falla, archivo:línea) o "sin hallazgos"; commit `test(006): ronda adversarial 1a del registro`.

## T12b · Ronda adversarial del registro, caja blanca (adversario · opus) ∥ T12a
- **Contexto (leer solo esto)**: `docs/specs/006-planes/plan.md`, `packages/db/migrations/` (las tres de 006), `apps/backend/src/modules/registro/*.ts`, `packages/db/src/auth/repositorio.ts`.
- **Hacer**: leyendo la implementación, hasta ~15 pruebas nuevas: ramas de `registro_crear` que varíen tiempo o conteo según exista la cuenta; carrera entre dos confirmaciones y entre confirmar y un `registro_crear` del mismo correo; `search_path` y ACL de las funciones; fuga de `cuenta_existe` a quien no tiene el token; estudio creado con plan inactivo o sin plan; purga de pendientes que borre una vigente; `limite_consumir` con sujetos largos o vacíos; ruta de `confirmar-con-sesion` con sesión revocada.
- **Hecho cuando**: lista de hallazgos o "sin hallazgos"; commit `test(006): ronda adversarial 1b del registro`.

## T13 · Corregir hallazgos (backend · sonnet / opus)
- **Contexto (leer solo esto)**: los `*.adv*.spec.ts` que fallan, `docs/specs/006-planes/plan.md` y los archivos que cada hallazgo indique.
- **Hacer**: corregir cada hallazgo (o proponer ajuste de la spec al orquestador si el ataque es válido pero la spec lo permite); migración nueva si hace falta, nunca editar una aplicada. Una sola ronda (D12), salvo que el usuario pida otra.
- **Hecho cuando**: todas las `*.adv*.spec.ts` verdes o cada fallo aceptado por el usuario y anotado; suites previas sin regresión. Commit `fix(006): hallazgos de la ronda adversarial del registro`.

## T14 · Verificación (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/006-planes/spec.md`, resultados de T11 y T13.
- **Hacer**: para cada CA-1 a CA-11, ejecutar la prueba o el comando que lo prueba y anotar la evidencia; correr la suite completa (`pnpm test`, `ci:db`, `typecheck`, `lint`); CA-9 con las suites de 004 y 005; CA-5 y CA-6 con la prueba de carrera repetida 20 veces sin `40P01` ni exceso. Marcar las casillas CA de `spec.md`.
- **Hecho cuando**: tabla CA → evidencia en "Resultado" sin criterios abiertos, o lista de faltantes con tarea asignada. Commit `test(006): verificación de criterios de aceptación`.

## T15 · Revisión contra la spec (arquitecto · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/006-planes/{spec,plan}.md`, "Resultado" de T14, las tres migraciones de 006, `apps/backend/src/modules/{planes,registro,plataforma}/*.ts`.
- **Hacer**: contrastar cada CA y D1–D13 con su evidencia y el DoD B (04 §5); comprobar que el orden de bloqueo de `plan.md` se respeta y que `CupoRucs` queda documentado para 007; listar faltantes y riesgos aceptados.
- **Hecho cuando**: veredicto "aprobada" o lista de faltantes con tarea asignada. Sin commit si no cambia archivos.

## T16 · Cierre (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/006-planes/tasks.md`, observaciones de T15.
- **Hacer**: marcar `[x]` las tareas hechas y las casillas CA de `spec.md`; dejar en "Resultado" las notas para el orquestador (el orquestador actualiza `docs/specs/ESTADO.md` en `main`): 007 llama `CupoRucs.reservar` tras bloquear al actor y antes de tocar `cliente`, cuenta solo clientes activos al agregar el archivado y mapea 409 `cupo_rucs`; el Dueño aún no cambia de plan (RF-005, R3); el super-admin no tiene TOTP hasta R2.
- **Hecho cuando**: `git status` limpio salvo `docs/explorador/`, `.codex/`, `AGENTS.md`. Commit `chore(006): cierra spec 006`.
