# Tareas 008 · Cola de trabajos, despachador justo, locks por RUC y estado en tiempo real

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: andamiaje → pruebas (rojo) → implementación (verde, cobertura por archivo desde el diseño) → integración → adversario (máx. 2 rondas, cada una en dos piezas) → verificación → revisión final → cierre. Rama `spec/008-cola` (desde `main`); spec, plan y tareas aprobados y commiteados. CA = `spec.md`; contratos y decisiones = `plan.md`. 008 va antes que 006 (orden 011 → 008 → 006) y comparte la BD de pruebas local.

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Redis en local (U1) y en el CI | devops | haiku | decisión U1 del usuario | — | — | [ ] |
| T2 | Andamiaje: `packages/queue`, `packages/sunat`, lint y `cobertura:cola` | devops | sonnet | — ∥ T1 | — | — | [x] |
| T3 | Pruebas de BD: tablas, RLS, grants, trigger, `sistema.*`, `auth.purgar`, `kekAnterior` (rojo) | tester | sonnet | T2 | ✓ | — | [ ] |
| T4 | Pruebas unitarias de `queue`, `sunat` y `shared/trabajos` (rojo) | tester | sonnet | T2 ∥ T3 | ✓ | — | [ ] |
| T5 | Pruebas de integración del worker y el despachador con Redis y PG (rojo) | tester | sonnet | T1, T2 ∥ T4 | ✓ | — | [ ] |
| T6 | Pruebas HTTP de `/trabajos`, SSE y HU-40 (rojo) | tester | sonnet | T1, T2 ∥ T5 | ✓ | — | [ ] |
| T7 | Migraciones 0017–0018, esquema y repos de `packages/db` | backend | opus | T3 | ✓ | — | [ ] |
| T8 | `packages/sunat` y `shared/trabajos` | backend | sonnet | T4 ∥ T7 | ✓ | — | [ ] |
| T9 | `packages/queue`: encolado, despachador, arriendos, reconciliador | backend | opus | T4, T7, T8 | ✓ | — | [ ] |
| T10 | Worker: ejecutor, errores y reintentos, credencial, token SIRE, `kek.rotar`, `auth.purgar` | backend | opus | T5, T9 | ✓ | — | [ ] |
| T11 | Backend: módulo `trabajos` (lista, SSE, cancelar, `Encolador`) | backend | opus | T6, T9 ∥ T10 | ✓ | — | [ ] |
| T12 | Integración: checks completos y prueba manual | devops | haiku | T10, T11 | — | — | [ ] |
| T13a | Ronda adversarial 1a: lista mínima (caja negra) | adversario | opus | T12 | — | ✓ | [ ] |
| T13b | Ronda adversarial 1b: escenarios nuevos (caja blanca) | adversario | opus | T12 ∥ T13a | — | ✓ | [ ] |
| T14 | Corregir hallazgos de la ronda 1 | backend | opus | T13a, T13b | — | — | [ ] |
| T15a | Ronda adversarial 2a: regresión y reconversión | adversario | opus | T14 | — | ✓ | [ ] |
| T15b | Ronda adversarial 2b: ataques nuevos contra las correcciones | adversario | opus | T14 ∥ T15a | — | ✓ | [ ] |
| T16 | Corregir hallazgos de la ronda 2 | backend | opus | T15a, T15b | — | — | [ ] |
| T17 | Verificar CA-1 a CA-17 y cobertura con evidencia | tester | sonnet | T16 | — | — | [ ] |
| T18 | Revisión final contra la spec | arquitecto | opus | T17 | — | — | [ ] |
| T19 | Cierre: ESTADO, tasks y commit | devops | haiku | T18 | — | — | [ ] |

Escalamientos: —

Decisiones del usuario: 2026-10-27, "Apruebo las specs 006, 008 y 011 con todo lo recomendado por el arquitecto en cada P. Continúa con plan y tareas." (D13–D20 de `spec.md`). **Pendiente: U1** (Redis en local, `plan.md` Decisiones); bloquea T1, T5, T6 y lo que depende de ellos. T2–T4 y T7–T8 pueden avanzar sin Redis.

Reglas comunes:
- Un commit por tarea (Conventional Commits `feat(008): …`, `test(008): …`, `fix(008): …`, `chore(008): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md`: `git add <rutas>` explícitas, nunca `git add -A`/`.`. No editar `docs/specs/ESTADO.md` salvo en T19 (y los hallazgos en T13–T16).
- Nunca imprimir, registrar ni commitear claves SOL, `client_secret`, tokens SIRE, llaves efímeras ni el contenido de `.env`. Las pruebas usan canarios (`CANARIO-SOL-…`, `CANARIO-SECRET-…`, `CANARIO-TOKEN-…`) y los buscan en logs, BD, Redis y SSE.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o "OK" + conteo. Correr solo las pruebas del paquete afectado; la suite completa en T12 y T17.
- El tester no toca código de producción; backend no edita `*.spec.ts` ni `*.adv*.spec.ts`; el adversario solo escribe `*.adv.spec.ts` (`*.adv.int.spec.ts` si usa BD, Redis o HTTP).
- Migraciones: nunca editar una aplicada (0000–0016 ni, tras T7, 0017–0018); corregir con una nueva. No redefinir funciones de 0008. 006 numera después de las de 008.
- Redis en pruebas: prefijo aleatorio por archivo y base 15; cada prueba borra solo su prefijo. PG: cada prueba deja la BD como estaba (BD local compartida con 006 y 011).
- Sin `withTenant` anidado: los ciclos por estudio abren un `withTenant` cada uno, en secuencia; `publicar` y los eventos van después del callback (nota [004/008]).
- 008 no bloquea `membresia`, `cliente` ni `asignacion` (lecturas sin `FOR UPDATE`); si una corrección necesitara bloquearlas, sigue el orden global de 005 (`bloquearMiembros` → último Dueño → clientes por id → asignaciones/invitaciones).
- Las pruebas de 002–005 siguen en verde; si una contradice una decisión de 008, se ajusta solo en la tarea de pruebas que lo diga, con comentario.
- Si la cobertura de un archivo no llega a 90 % en alguna métrica: no excluir ni bajar el umbral; subtareas tester (ramas faltantes) y backend (inyección).
- Escalar según 04 §3.3 y anotarlo arriba. Una ambigüedad que cambie la spec no se decide: se marca `requiere usuario` y se informa al orquestador.

## T1 · Redis en local y en el CI (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/008-cola/plan.md` (Decisiones: U1, Sin variables de entorno nuevas), `.env.example`, `.github/workflows/ci.yml` (job `aislamiento`), `package.json` (`ci:db`).
- **Hacer**: (1) Tras la decisión U1, comprobar con el usuario que el Redis elegido está instalado como servicio en `localhost:6379` (no instalar nada sin su permiso): `redis-cli ping` o `memurai-cli ping` → `PONG`; `INFO server` reporta versión compatible ≥ 6.2. (2) CI, job `aislamiento`: servicio `redis:7` con health check (`redis-cli ping`), puerto 6379, `REDIS_URL: redis://localhost:6379` en el `env` del job. (3) README del worker: una línea sobre cómo arrancar Redis en local según U1.
- **Hecho cuando**: `PONG` en local (pegar versión, sin datos sensibles); `prettier --check .github/workflows/ci.yml` OK; `.env.example` sin cambios. Commit `ci(008): servicio Redis en el job de aislamiento`.

## T2 · Andamiaje de paquetes, lint y cobertura (devops · sonnet) ∥ T1
- **Contexto (leer solo esto)**: `docs/specs/008-cola/plan.md` (Archivos, Decisiones: Lint, Cobertura), `packages/crypto/{package.json,tsconfig.json,vitest.config.mts}` (patrón de paquete), `apps/worker/package.json`, `apps/backend/vitest.cobertura-acceso.config.mts` (patrón), `eslint.config.mjs` (bloque de `no-restricted-imports` de backend), `package.json`, `pnpm-workspace.yaml`, `turbo.json`.
- **Hacer**: (1) `packages/queue` y `packages/sunat` vacíos que compilan (`src/index.ts` con `export {}`), con `test`, `test:int` (modo `int`), `build`, `typecheck`, `lint`; `@contapp/queue` exporta `.` y `./worker`. (2) Dependencias exactas: `bullmq` e `ioredis` (última estable, versión fija) en `packages/queue`; `@contapp/queue` y `@contapp/sunat` en worker; `@contapp/queue` en backend. (3) Lint: backend sin `bullmq`, `@contapp/queue/worker`, `@contapp/sunat`; frontend sin `@contapp/queue`. (4) `apps/worker/vitest.cobertura-cola.config.mts` con proyectos e `include` del plan; script worker `test:cobertura:cola`; raíz `cobertura:cola` (build de `shared`, `db`, `sunat`, `queue` + ese script); `ci:db` compila también `sunat` y `queue`; paso `pnpm cobertura:cola` en el CI tras `cobertura:acceso` con el mismo `env`.
- **Hecho cuando**: `pnpm install`, `build`, `typecheck` y `lint` OK; un import de prueba de `bullmq` en `apps/backend/src` hace fallar el lint (revertido); `pnpm cobertura:cola` sale ≠ 0 solo por "sin pruebas" o umbral, nunca por configuración; `cobertura:acceso` sigue en 0. Commit `chore(008): paquetes queue y sunat, lint y cobertura:cola`.

- **Resultado (2026-10-27)**: `packages/queue` (`bullmq` 6.5.0, `ioredis` 6.0.0 fijos; exporta `.` y `./worker`; depende también de `@contapp/db` y `@contapp/shared` por workspace, para T9) y `packages/sunat` creados con `src/index.ts` vacío, scripts `build`, `typecheck`, `lint`, `test`, `test:int`. Worker depende de `@contapp/queue` y `@contapp/sunat`; backend de `@contapp/queue`. ESLint: backend sin `bullmq`, `@contapp/queue/worker` ni `@contapp/sunat`; frontend sin `bullmq` ni `@contapp/queue`. `apps/worker/vitest.cobertura-cola.config.mts` (10 proyectos, alias a fuentes, `perFile` 90) + scripts `test:cobertura:cola` y raíz `cobertura:cola`; `ci:db` compila `sunat` y `queue`; paso `cobertura:cola` en el CI tras `cobertura:acceso` (el servicio Redis lo agrega T1). Verificado: `pnpm install`, `build` (9/9), `typecheck` (14/14), `lint` (9/9) OK; imports de prueba de `bullmq`, `@contapp/queue/worker`, `@contapp/sunat` (backend) y `@contapp/queue` (frontend) fallan el lint (revertidos); `cobertura:cola` sale 1 solo por "No test files found"; `cobertura:acceso` 0 (86 archivos, 1379 pruebas, con el `.env` del repo principal).

## T3 · Pruebas de BD, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/008-cola/spec.md` (CA-9, CA-12, CA-13, CA-14, CA-15; D13, D16, D18, D19), `docs/specs/008-cola/plan.md` (Contratos: packages/db, BD), `tests/aislamiento/{soporte,auth-soporte}.ts`, `tests/aislamiento/{catalogo,auth,credencial}.spec.ts`, `tests/aislamiento/acceso.spec.ts` (patrón de privilegios y funciones), `packages/db/src/credenciales/repositorio.spec.ts` (patrón de tx falsa).
- **Hacer**: `tests/aislamiento/trabajos.spec.ts` (catálogo y privilegios), `trabajos-funciones.spec.ts` (comportamiento) y `packages/db/src/trabajos/*.spec.ts`. Cubrir: `job_registro` con RLS `ENABLE`+`FORCE`, `tenant_isolation`, FK compuestas (cliente o membresía de otro estudio → 23503), `CHECK` de tipo, estado, motivo, tamaños y `clave_dedupe`; índice único de dedupe solo con estados vivos; grants exactos por rol y columna (backend no actualiza `intentos`/`resultado`; worker borra solo terminales; platform nada); `config_sistema` con `CHECK` (0, negativos, enormes, tenant > global/2 → 23514), SELECT backend/worker y sin escritura de la app; filas por defecto de D12; `credencial.estado` (grants por columna, trigger al cambiar `ciphertext`, `reemplazarDekEnvuelta` no lo cambia); `contapp_enumerador` `NOLOGIN` y nadie lo asume (`SET ROLE` falla desde `contapp_app`), `sistema.*` devuelven solo `uuid`, `EXECUTE` solo worker, `search_path` fijo, `STABLE`; `withSistema` no ve filas de negocio y no se anida; `auth.purgar` borra solo lo de D16 (sesión vigente intacta, `intento_login` bloqueado intacto, retención < 1 día → error) y `EXECUTE` solo worker; `reemplazarDekEnvuelta` sin `kekAnterior` lanza antes de consultar (y `// @ts-expect-error` en el tipo). Ajustes con comentario: `catalogo.spec.ts` (tabla nueva), `auth-soporte.ts` (`FUNCIONES_AUTH` = 16), `auth.spec.ts` (grants DELETE de `contapp_auth`), `credencial.spec.ts` (`kekAnterior` obligatorio; nota [008]).
- **Hecho cuando**: `pnpm test:aislamiento` y `pnpm --filter @contapp/db test` fallan solo en lo nuevo y por falta de esquema, funciones o repos; lo de 002–005 sigue verde salvo los ajustes, que fallan solo por lo que falta. Firmas en el encabezado de `tests/aislamiento/trabajos-repos.spec.ts`. Commit `test(008): esquema de trabajos, enumerador y purga (rojo)`.

## T4 · Pruebas unitarias, rojo (tester · sonnet) ∥ T3
- **Contexto (leer solo esto)**: `docs/specs/008-cola/spec.md` (CA-2, CA-3, CA-5, CA-8, CA-11, CA-16; D7, D8, D12, D19, D20), `docs/specs/008-cola/plan.md` (Contratos: shared, packages/sunat, packages/queue; Decisiones: Posición, Pruebas de tiempo), `packages/shared/src/acceso/esquemas.spec.ts` (patrón).
- **Hacer**: `packages/shared/src/trabajos/*.spec.ts` (estados, motivos, vista y evento; claves desconocidas descartadas). `packages/sunat/src/**/*.spec.ts`: errores con código fijo y `message` sin datos de entrada (canario); `MockSireAuth` determinista y modos de falla. `packages/queue/src/**/*.spec.ts` con dobles de `db` y `redis` y `Reloj` falso: catálogo (tipo desconocido, parámetros inválidos, `prueba.eco` solo en test); `clave_dedupe` estable ante el orden de claves del JSON; selección round-robin con 3 estudios; prioridad dentro del estudio; respeto de cupo global, cupo del tenant y lock de RUC; backoff `base·2^(n−1)` ± 20 % y tope de reintentos; clasificación de errores (no clasificado = transitorio); cálculo de posición; `publicar` no propaga errores de Redis; payload BullMQ solo con `{jobId, tenantId, tipo}`.
- **Hecho cuando**: `pnpm --filter @contapp/{shared,sunat,queue} test` fallan solo por falta de implementación (import o firma). Commit `test(008): catálogo, despachador y errores SUNAT (rojo)`.

## T5 · Pruebas de integración del worker, rojo (tester · sonnet) ∥ T4
- **Contexto (leer solo esto)**: `docs/specs/008-cola/spec.md` (CA-1 a CA-4, CA-8 a CA-16, "Ataques mínimos"), `docs/specs/008-cola/plan.md` (Contratos: packages/queue, Worker; Decisiones), `apps/worker/test/{bd,soporte}.ts`, `apps/worker/src/credenciales/rotar-kek.int.spec.ts` (patrón con PG), `apps/worker/src/cli/kek-rotar.int.spec.ts`.
- **Hacer**: `apps/worker/src/trabajos/*.int.spec.ts` y `packages/queue/src/*.int.spec.ts` con Redis (prefijo propio) y PG reales, `prueba.eco` con comportamiento programable (duración, error a lanzar, contador de llamadas) y `config_sistema` con esperas cortas. Cubrir: outbox: transacción revertida → nada en Redis; Redis caído al encolar → `en_cola` y el reconciliador lo publica (CA-1); A con 1,000 y B con 1 → B empieza al liberarse el primer cupo y A nunca supera 2 en ejecución; round-robin con 3 estudios; interactivo antes que programado (CA-2); 20 trabajos del mismo RUC con 4 en paralelo y desde dos estudios → nunca solapados y con la espera mínima entre marcas de tiempo (CA-3); cambio de `config_sistema` aplicado en ≤ 10 s sin reiniciar (CA-4); 3 reintentos con backoff y luego `sunat_no_responde`; `ErrorDatos`/`ErrorPortal` sin reintento (CA-8); `ErrorCredencial` → `credencial_invalida`, `credencial.estado = 'invalida'`, `Notificador` una sola vez, pendientes y nuevos del cliente cancelados, reemplazar `ciphertext` lo desbloquea (CA-9); proceso que muere a mitad (cerrar el worker sin terminar) → cupo y lock libres en ≤ 60 s, idempotente reintentado, no idempotente `interrumpido`, 10 caídas seguidas sin contadores desfasados (CA-10); token: 10 trabajos simultáneos del mismo cliente → una llamada a `SireAuth`, renovación antes de vencer y tras 401 una vez, en Redis no aparece el canario en claro (CA-11); `kek.rotar` rota todos los estudios del seed sin `withTenant` anidado (CA-12); `auth.purgar` con filas sembradas de cada caso de D16 (CA-13); desasignar al creador, cambiarle el rol o desactivarlo antes del despacho → `acceso_retirado` sin ejecutar; programado sin usuario sigue (CA-14); payload forjado con `jobId` de otro estudio o tipo distinto → sin efectos (CA-15); canarios de secretos ausentes de logs, `job_registro` y Redis (CA-16).
- **Hecho cuando**: `pnpm --filter @contapp/worker test:int` y `pnpm --filter @contapp/queue test:int` fallan solo por falta de implementación; las int de 003 del worker siguen verdes. Commit `test(008): integración del despachador y el worker (rojo)`.

## T6 · Pruebas HTTP y HU-40, rojo (tester · sonnet) ∥ T5
- **Contexto (leer solo esto)**: `docs/specs/008-cola/spec.md` (CA-1, CA-5, CA-6, CA-7, CA-14, CA-16; D9, D11, D15), `docs/specs/008-cola/plan.md` (Contratos: HTTP, Backend), `apps/backend/test/{soporte,soporte-acceso}.ts`, `apps/backend/src/modules/clientes/clientes.int.spec.ts` (patrón de alcance), `apps/backend/src/aislamiento/hu40-api.int.spec.ts`, `apps/backend/src/modules/acceso/rutas.spec.ts`.
- **Hacer**: `apps/backend/src/modules/trabajos/*.int.spec.ts` con Redis y PG reales (trabajos creados con el `Encolador`, no hay ruta de encolar en 008). Cubrir: lista y filtro por estudio y alcance (Dueño todos, asistente solo asignados), `jobId` ajeno, no asignado e inexistente → mismo 404 salvo `Date`; estado, posición, intentos y motivo (CA-5); SSE con sesión y estudio, evento en ≤ 2 s, desasignar/cambiar rol/desactivar/cambiar de estudio → sin eventos del cliente retirado o cierre en ≤ 10 s, cuarto stream → 429 (CA-6); cancelar: creador, Dueño y Administrador sí, otro contador visible → 403, iniciado → 409, carrera cancelar vs despachar → un solo resultado, sin CSRF → 403 (CA-7, D9); `Encolador` publica después del commit y no publica si la transacción falla (CA-1); canarios ausentes de respuestas y eventos (CA-16). `hu40-api.int.spec.ts`: casos para las 3 rutas nuevas con IDs del otro estudio. `rutas.spec.ts` sigue cubriendo las rutas nuevas (CA-11 de 005).
- **Hecho cuando**: `pnpm --filter @contapp/backend test:int` falla solo por falta de implementación; lo de 004–005 sigue verde. Commit `test(008): HTTP y SSE de trabajos y HU-40 (rojo)`.

## T7 · BD de trabajos (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/008-cola/plan.md` (Contratos: packages/db, BD; Decisiones: Migraciones, Sin anidar `withTenant`), pruebas de T3, `packages/db/src/schema/{credenciales,acceso,index}.ts`, `packages/db/migrations/{0006_credencial_rls_y_grants,0007_auth,0012_acceso_rls,0013_acceso_auth}.sql` (patrones de RLS, grants, `SECURITY DEFINER` y políticas de `contapp_auth`), `packages/db/src/{client.ts,with-tenant.ts,index.ts}`, `packages/db/src/credenciales/repositorio.ts`, `packages/db/src/acceso/alcance.ts`.
- **Hacer**: esquema TS → `drizzle-kit generate` → `0017_trabajos.sql`; `0018_trabajos_rls.sql` custom según el plan (con `drizzle-kit generate --custom` y entrada en el journal); `src/trabajos/**`, `src/credenciales/estado.ts`, `withSistema`, `kekAnterior` obligatorio, exportes. No tocar `apps/`.
- **Hecho cuando**: `pnpm db:migrate` ×2 y `pnpm db:seed` ×2; `drizzle-kit generate` sin cambios; `pnpm test:aislamiento` verde (002–005 incluidos `auth-r2a.adv` y `escalada.adv` con `FUNCIONES_AUTH` = 16; si algo falla por otra causa, escalar al tester); `pnpm --filter @contapp/db test` verde; `pnpm cobertura:db` 0; `packages/db/src/trabajos/**` ≥ 90 % por archivo; worker y backend `test:int` de 003–005 verdes; lint OK. Commit `feat(008): job_registro, config_sistema, estado de credencial, enumerador y purga`.

## T8 · Sunat y shared de trabajos (backend · sonnet) ∥ T7
- **Contexto (leer solo esto)**: `docs/specs/008-cola/plan.md` (Contratos: shared, packages/sunat), pruebas de T4 de `shared` y `sunat`, `packages/shared/src/{index.ts,acceso/esquemas.ts}`.
- **Hacer**: `packages/sunat/src/{errores,puertos,index}.ts`, `src/mock/sire-auth.mock.ts`; `packages/shared/src/trabajos/**` y exportar. Sin IO salvo el mock (en memoria).
- **Hecho cuando**: `pnpm --filter @contapp/{shared,sunat} test` verde; build, typecheck y lint OK; esos archivos ≥ 90 % por archivo. Commit `feat(008): errores SUNAT, puerto SireAuth y esquemas de trabajos`.

## T9 · Paquete queue (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/008-cola/plan.md` (Contratos: packages/queue, packages/db; Decisiones: Fuente de verdad, Posición, Sin anidar `withTenant`, Pruebas de tiempo), `docs/specs/008-cola/spec.md` (D1–D8, D17, D19, D20), pruebas de T4 (`queue`) y las de `packages/queue/src/*.int.spec.ts` de T5, `packages/db/src/index.ts`.
- **Hacer**: `packages/queue/src/**` según el plan: catálogo, `encolar` y `publicar`, `Despachador` (liderazgo, recarga de config, round-robin, cupos, locks, revalidación, transición atómica), arriendos con latido, `Reconciliador`, eventos; `./worker` con la fábrica de colas y workers BullMQ. Sin SQL fuera de `packages/db`.
- **Hecho cuando**: `pnpm --filter @contapp/queue test` y `test:int` verdes; typecheck y lint OK; `packages/queue/src/**` ≥ 90 % por archivo. Commit `feat(008): despachador round-robin con cupos, locks por RUC y reconciliador`.

## T10 · Worker de trabajos (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/008-cola/plan.md` (Contratos: Worker, packages/queue; Decisiones), `docs/specs/008-cola/spec.md` (CA-8 a CA-16; D6, D10, D13, D14, D16, D18), pruebas de T5 (`apps/worker/src/trabajos/*.int.spec.ts`), `apps/worker/src/{app.module.ts,main.ts}`, `apps/worker/src/credenciales/{descifrar-credencial,rotar-kek,errores}.ts`, `apps/worker/src/cli/kek-rotar.ts` (patrón de CLI).
- **Hacer**: `apps/worker/src/trabajos/**`, `src/cli/encolar-kek-rotar.ts`, script `trabajos:kek-rotar`; registrar `TrabajosModule` con cierre ordenado (deja de tomar trabajos, espera a los en curso hasta 30 s, libera arriendos). El token SIRE se descifra con `descifrarCredencial` de 003 y solo vive en memoria.
- **Hecho cuando**: `pnpm --filter @contapp/worker test` y `test:int` verdes (incluidas las de 003); typecheck y lint OK; `apps/worker/src/trabajos/**` ≥ 90 % por archivo. Commit `feat(008): ejecutor con reintentos, credencial inválida, token SIRE y trabajos de sistema`.

## T11 · Backend de trabajos (backend · opus) ∥ T10
- **Contexto (leer solo esto)**: `docs/specs/008-cola/plan.md` (Contratos: HTTP, Backend; Decisiones: Lint), `docs/specs/008-cola/spec.md` (CA-1, CA-5 a CA-7; D9, D11), pruebas de T6, `apps/backend/src/{app.ts,app.module.ts}`, `apps/backend/src/modules/acceso/guards/decoradores.ts`, `apps/backend/src/modules/clientes/{clientes.controller,contexto}.ts` (patrón de alcance), `apps/backend/src/comun/filtro-errores.ts`.
- **Hacer**: `apps/backend/src/modules/trabajos/**` y registro en `AppModule`/`crearApp` (suscriptor Redis con cierre ordenado). Sin SQL ni `bullmq` en el backend.
- **Hecho cuando**: las `*.int.spec.ts` de `trabajos`, HU-40 y `rutas.spec.ts` en verde; `test:int` de 004–005 verde; typecheck y lint OK; `modules/trabajos/**` ≥ 90 % por archivo. Commit `feat(008): lista, SSE y cancelación de trabajos`.

## T12 · Integración (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/008-cola/plan.md` (Contratos: HTTP, Worker), `package.json`.
- **Hacer**: correr `pnpm build`, `typecheck`, `lint`, `test`, `ci:db`, `cobertura:cola`, `cobertura:acceso`, `cobertura:auth`, `cobertura:db`. Prueba manual (Redis local, backend `PORT=4000`, worker en marcha, `NODE_ENV=test` para `prueba.eco`): encolar un `prueba.eco` con un script de una línea que use el `Encolador`; `curl -N` a `/trabajos/stream` con la cookie de `uA` muestra `en_cola → ejecutando → completado`; `GET /trabajos` lo lista; `redis-cli --scan --pattern 'contapp:sire:token:*'` y un `GET` de esa clave no muestran texto legible (no copiar valores al informe).
- **Hecho cuando**: todos salen 0 (reportar conteos); la prueba manual da lo esperado; procesos parados; `git status` sin archivos ajenos agregados. Commit `chore(008): integración y checks completos` solo si cambió algún archivo.

## T13a · Ronda adversarial 1a: lista mínima (adversario · opus)
- **Contexto (leer solo esto)**: `docs/specs/008-cola/spec.md` (Criterios y "Ataques mínimos"), `docs/specs/008-cola/plan.md` (Contratos). **Caja negra**: no leer implementación.
- **Hacer**: hasta ~8 pruebas en `apps/worker/src/trabajos/r1a.adv.int.spec.ts`, `apps/backend/src/modules/trabajos/r1a.adv.int.spec.ts` y `tests/aislamiento/trabajos-r1a.adv.spec.ts` sobre la lista mínima (1,000 contra 1, mismo RUC en uno y dos estudios, worker que muere tras tomar el lock, cancelar en carrera, 50 encolados iguales, IDOR de `jobId` en lista/SSE/cancelar, SSE durante desasignación o cambio de estudio, payload forjado, Redis caído, `config_sistema` hostil, canarios, `kek.rotar` viendo otro estudio).
- **Instrucciones defensivas**: solo escribir `*.adv.spec.ts`/`*.adv.int.spec.ts`; no modificar producción, pruebas ajenas, migraciones ni `.env`; canarios, nunca secretos reales; cada prueba deja BD y Redis como estaban (prefijo propio); aserción concreta; un fallo del entorno (Redis caído sin que la prueba lo provoque) no es hallazgo.
- **Hecho cuando**: pruebas commiteadas; cada fallo en "Resultado" de esta tarea y en "Hallazgos adversariales abiertos" de `ESTADO.md` (archivo:línea, severidad, una línea). Commit `test(008): ronda adversarial 1a`.

## T13b · Ronda adversarial 1b: escenarios nuevos (adversario · opus) ∥ T13a
- **Contexto (leer solo esto)**: igual que T13a + `plan.md` (Decisiones, Riesgos); después (caja blanca) `packages/queue/src/**`, `apps/worker/src/trabajos/**`, `apps/backend/src/modules/trabajos/**`, `packages/db/src/trabajos/**`, `packages/db/migrations/0017_trabajos.sql`–`0018_trabajos_rls.sql`.
- **Hacer**: hasta ~7 pruebas en `*-r1b.adv*.spec.ts`, distintas de T13a: funciones `sistema.*` y `auth.purgar` con `search_path` hostil o argumentos extremos; asumir `contapp_enumerador`; trigger de `credencial` saltado por una rotación o por un `UPDATE` sin cambio real; dos despachadores que creen ser líderes (arriendo vencido en mitad del ciclo); reloj desfasado entre procesos; evento SSE con `clienteId` de otro estudio inyectado en `eventos:{tenantId}`; token SIRE de un proceso leído por otro; `prueba.eco` registrado fuera de test; riesgos del plan.
- **Instrucciones defensivas**: las de T13a.
- **Hecho cuando**: igual que T13a. Commit `test(008): ronda adversarial 1b`.

## T14 · Corregir ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de 008 en `ESTADO.md`, los `*.adv*.spec.ts` que fallan, los archivos que señalan, `plan.md` (Decisiones).
- **Hacer**: corregir en `src/` o con una migración nueva (0019 o la siguiente libre). Si un hallazgo pide cambiar la spec o aceptar un riesgo: `abierto · requiere usuario`, sin decidir.
- **Hecho cuando**: `pnpm test`, `pnpm ci:db` y `pnpm cobertura:cola` en verde salvo lo marcado para el usuario; hallazgos `corregido (<commit>)`; `plan.md` actualizado si cambió un contrato. Commit `fix(008): hallazgos de la ronda adversarial 1`.

## T15a · Ronda 2a: regresión y reconversión (adversario · opus)
- **Contexto (leer solo esto)**: igual que T13b + `git diff <commit T13b>..HEAD -- apps packages`.
- **Hacer**: si la ronda 1 no tuvo fallos, marcar T15a, T15b y T16 `[x]` "omitida: ronda 1 sin fallos". Si no: reconvertir las pruebas de hallazgos aceptados por el usuario (con comentario) y hasta ~5 pruebas que reintenten cada corrección por otra vía.
- **Instrucciones defensivas**: las de T13a; además, comprobar que la prueba ataca la vía real de uso y que el hallazgo tiene arreglo posible.
- **Hecho cuando**: igual que T13a. Commit `test(008): ronda adversarial 2a`.

## T15b · Ronda 2b: ataques nuevos (adversario · opus) ∥ T15a
- **Contexto (leer solo esto)**: igual que T15a.
- **Hacer**: hasta ~10 pruebas nuevas en `*-r2b.adv*.spec.ts` contra las correcciones y huecos restantes. Omitida si la ronda 1 no tuvo fallos.
- **Instrucciones defensivas**: las de T15a.
- **Hecho cuando**: igual que T13a. Commit `test(008): ronda adversarial 2b`.

## T16 · Corregir ronda 2 (backend · opus)
- **Contexto / Hacer / Hecho cuando**: igual que T14 con los hallazgos de T15a/T15b; omitida si no hubo. Commit `fix(008): hallazgos de la ronda adversarial 2`.

## T17 · Verificación (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/008-cola/spec.md` (Criterios, "Cobertura"), `plan.md` (Contratos; Decisiones: Cobertura, Lint), hallazgos de 008 en `ESTADO.md`.
- **Hacer**: evidencia por CA con comando y resultado: CA-1 a CA-16 (worker y queue `test:int`, backend `test:int`, `test:aislamiento`, consulta propia a `pg_policy`/`has_table_privilege`/`has_column_privilege`/`has_function_privilege`/`pg_roles` para CA-12, CA-13 y CA-15, `pnpm lint` para CA-1); CA-17 (hallazgos cerrados o aceptados, `*.adv*` verdes); `pnpm cobertura:cola` (4 métricas ≥ 90 % por archivo, listar el mínimo); `cobertura:acceso`, `cobertura:auth` y `cobertura:db` en 0; migraciones desde cero en una base desechable; `redis-cli` sobre las claves de token sin texto legible.
- **Hecho cuando**: cada CA con evidencia en "Resultado"; ESTADO 008 → `verificada`. Commit `docs(008): verificación de criterios con evidencia`.

## T18 · Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `docs/specs/008-cola/{spec,plan}.md`, "Resultado" de T17, `packages/db/migrations/0017_trabajos.sql`–`0018_trabajos_rls.sql`, `packages/queue/src/{despachador,arriendos,reconciliador,encolado}.ts`, `apps/worker/src/trabajos/{ejecutor,token-sire/cache-token}.ts`, `apps/backend/src/modules/trabajos/{trabajos.service,stream.service}.ts`.
- **Hacer**: contrastar cada CA, D1–D20 y el DoD A (04 §5) con su evidencia; listar faltantes y riesgos aceptados para informar al usuario; condición de CI en verde como en 005 (push solo si el usuario lo autoriza).
- **Hecho cuando**: veredicto "aprobada" o lista de faltantes con tarea asignada. Sin commit si no cambia archivos.

## T19 · Cierre (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/ESTADO.md`, `docs/specs/008-cola/tasks.md`, observaciones de T18.
- **Hacer**: marcar `[x]` las tareas hechas y las casillas CA de `spec.md`; ESTADO 008 → `hecha`, "Tarea actual" → `—`; hallazgos de 008 en su estado final; quitar de "Notas para specs futuras" las notas `[008]` y `[004/008]` resueltas (enumeración para `kek.rotar`, `kekAnterior`, purga de `auth`, cliente desasignado, `withTenant` anidado) y agregar las que deje 008 (007: panel de trabajos, `archivado_at` en la revalidación de D17, estados de credencial ya creados; 009: adaptador real de `SireAuth`; 017: reemplazar `NotificadorLog`; despliegue: límite de streams por proceso y Redis gestionado).
- **Hecho cuando**: `git status` limpio salvo `docs/explorador/`, `.codex/`, `AGENTS.md`; `git log --oneline` muestra los commits de 008. Commit `chore(008): cierra spec 008`.
