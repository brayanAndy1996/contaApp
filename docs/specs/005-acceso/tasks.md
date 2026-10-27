# Tareas 005 · Roles, permisos, asignación y alcance

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: andamiaje → pruebas (rojo) → implementación (verde, cobertura por archivo desde el diseño) → integración → adversario (máx. 2 rondas, cada una en dos piezas) → verificación → revisión final → cierre. La rama `spec/005-acceso` ya existe (desde `spec/004-auth`) y los docs aprobados están commiteados. CA = `spec.md`; contratos y decisiones = `plan.md`.
| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Andamiaje: `cobertura:acceso` (90 % por archivo) y CI | devops | sonnet | — | — | — | [x] |
| T2 | Pruebas de BD: esquema, RLS, trigger, funciones `auth` y repos (rojo) | tester | sonnet | T1 | ✓ | — | [ ] |
| T3 | Pruebas unitarias de shared, guards y rutas declaradas (rojo) | tester | sonnet | T1 ∥ T2 | ✓ | — | [ ] |
| T4 | Pruebas de integración HTTP de acceso (rojo) | tester | sonnet | T1 ∥ T3 | ✓ | — | [ ] |
| T5 | Suite HU-40 por API con dos estudios (rojo) | tester | sonnet | T1 ∥ T4 | ✓ | — | [ ] |
| T6 | Pruebas del frontend (rojo) | tester | sonnet | — ∥ T5 | ✓ | — | [ ] |
| T7 | Migraciones 0011–0013, esquema, repos de `acceso`, `AuthRepo` y seed | backend | opus | T2 | ✓ | — | [ ] |
| T8 | `shared/acceso`: catálogo, matriz, escalada y esquemas | backend | sonnet | T3 ∥ T7 | ✓ | — | [ ] |
| T9 | Guards `Permiso` y `ClienteScope`, decoradores y arranque | backend | opus | T3, T7, T8 | ✓ | — | [ ] |
| T10 | Usuarios e invitaciones (D8, aceptación, `CupoUsuarios`) | backend | opus | T4, T9 | ✓ | — | [ ] |
| T11 | Clientes y asignaciones | backend | sonnet | T4, T9 ∥ T10 | ✓ | — | [ ] |
| T12 | Pantallas: Usuarios, invitación, clientes y asignación, menú | frontend | sonnet | T6 ∥ T7–T11 | ✓ | — | [ ] |
| T13 | Integración: checks completos y prueba manual | devops | haiku | T5, T10, T11, T12 | — | — | [ ] |
| T14a | Ronda adversarial 1a: lista mínima (caja negra) | adversario | opus | T13 | — | ✓ | [ ] |
| T14b | Ronda adversarial 1b: escenarios nuevos (caja blanca) | adversario | opus | T13 ∥ T14a | — | ✓ | [ ] |
| T15 | Corregir hallazgos de la ronda 1 | backend (+frontend) | opus / sonnet | T14a, T14b | — | — | [ ] |
| T16a | Ronda adversarial 2a: regresión y reconversión | adversario | opus | T15 | — | ✓ | [ ] |
| T16b | Ronda adversarial 2b: ataques nuevos contra las correcciones | adversario | opus | T15 ∥ T16a | — | ✓ | [ ] |
| T17 | Corregir hallazgos de la ronda 2 | backend (+frontend) | opus / sonnet | T16a, T16b | — | — | [ ] |
| T18 | Verificar CA-1 a CA-16 y cobertura con evidencia | tester | sonnet | T17 | — | — | [ ] |
| T19 | Revisión final contra la spec | arquitecto | opus | T18 | — | — | [ ] |
| T20 | Cierre: ESTADO, tasks y commit | devops | haiku | T19 | — | — | [ ] |

Escalamientos: —

Reglas comunes:
- Un commit por tarea (Conventional Commits `feat(005): …`, `test(005): …`, `fix(005): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin remoto ni push.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` (cambios ajenos): `git add <rutas>` explícitas, nunca `git add -A`/`.`.
- Nunca imprimir, registrar ni commitear contraseñas reales, tokens de invitación o sesión, `SMTP_URL` ni el contenido de `.env`. Las pruebas usan canarios; la única contraseña versionada sigue siendo `SEED.contrasenaDesarrollo`.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o "OK" + conteo. Correr solo las pruebas del paquete afectado; la suite completa en T13 y T18.
- El tester no toca código de producción; backend y frontend no editan `*.spec.ts` ni `*.adv*.spec.ts`; el adversario solo escribe `*.adv.spec.ts` (`*.adv.int.spec.ts` si usa BD o HTTP).
- Migraciones: nunca editar una aplicada (0000–0010 ni, tras T7, 0011–0013); corregir con una nueva. No redefinir funciones de 0008 (`auth-r2a.adv.spec.ts` la re-aplica y compara).
- Las pruebas de 002, 003 y 004 siguen en verde; si una contradice una decisión de 005, se ajusta solo en la tarea de pruebas que lo diga, con comentario.
- Si la cobertura de un archivo no llega a 90 % en alguna métrica: no excluir ni bajar el umbral; subtareas tester (ramas faltantes) y backend (inyección).
- Escalar según 04 §3.3 y anotar arriba. Una ambigüedad que cambie la spec no se decide: `requiere usuario` y se informa al orquestador.

## T1 · Andamiaje de cobertura y CI (devops · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/plan.md` (Decisiones: Cobertura), `apps/backend/vitest.cobertura.config.mts` (patrón), `apps/backend/package.json`, `package.json`, `.github/workflows/ci.yml` (job `aislamiento`).
- **Hacer**: (1) `apps/backend/vitest.cobertura-acceso.config.mts` con los proyectos e `include` exactos del plan, alias a `src` de `shared` y `db`, `perFile: true` y 90 en `lines`, `statements`, `functions`, `branches`; `exclude` solo pruebas. (2) Script backend `test:cobertura:acceso`; raíz `cobertura:acceso` = build de `@contapp/shared` y `@contapp/db` + ese script. (3) CI, job `aislamiento`: paso `pnpm cobertura:acceso` tras `pnpm cobertura:auth`, con el mismo `env`.
- **Hecho cuando**: `pnpm cobertura:acceso` corre y sale ≠ 0 solo por "sin pruebas" o umbral (archivos aún inexistentes), nunca por error de configuración; un archivo temporal incluido al 50 % hace fallar por ese archivo (revertido); `pnpm cobertura:auth` sigue en 0; `prettier --check .github/workflows/ci.yml` OK. Commit `test(005): comando cobertura:acceso con umbral 90 % por archivo`.
- **Resultado**: creado `apps/backend/vitest.cobertura-acceso.config.mts` (proyectos backend-unit, backend-int, aislamiento-acceso, shared-acceso, db-acceso; `perFile` 90 en 4 métricas; alias a `src`), script backend `test:cobertura:acceso`, raíz `cobertura:acceso` y paso en CI (job `aislamiento`, tras `cobertura:auth`, mismo `env`). `pnpm cobertura:acceso` sale 0 hoy (43 archivos/583 pruebas, 9 archivos cubiertos al 100 %; los archivos de 005 aún no existen, así que `include` no los exige); un archivo temporal al 50 % de ramas hizo fallar por ese archivo (revertido). `cobertura:auth` sigue en 0; `prettier --check` OK.

## T2 · Pruebas de BD, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/spec.md` (CA-3, CA-7, CA-8, CA-9, CA-10, CA-13; D6, D7, D9, D10, D19, D21), `docs/specs/005-acceso/plan.md` (Contratos: packages/db, BD), `tests/aislamiento/{soporte,auth-soporte}.ts`, `tests/aislamiento/catalogo.spec.ts`, `tests/aislamiento/auth.spec.ts` (patrón de privilegios), `tests/aislamiento/auth-funciones.spec.ts` (patrón de funciones y carreras), `packages/db/src/auth/repositorio.spec.ts` (patrón de tx falsa).
- **Hacer**: `tests/aislamiento/acceso.spec.ts` (catálogo y privilegios), `acceso-funciones.spec.ts` (comportamiento) y `packages/db/src/acceso/*.spec.ts`. Cubrir: `asignacion` e `invitacion` con RLS `ENABLE`+`FORCE`, `tenant_isolation`, FK compuestas (cliente o membresía de otro estudio → 23503), grants exactos por rol (worker y platform sin acceso; backend sin DELETE en `invitacion`), `CHECK` de rol y de correo, `token_hash` de 32 B; conversión del seed (`uA`, `uB` = `dueno`); índice único de responsable y **dos conexiones** asignando responsable al mismo cliente → exactamente uno; trigger: degradar, desactivar o borrar al único Dueño con `contapp_backend` → error y BD intacta, dos Dueños degradándose a la vez → queda uno, un estudio sin Dueño no bloquea otras filas (CA-10); funciones redefinidas: membresía desactivada → `sesion_validar` devuelve `estudio_revocado`, `login_exito`/`sesion_rotar` la rechazan, `ultimo_estudio` la ignora, la de otro estudio sigue (CA-9, D9); invitaciones: `invitacion_vigente` sin efectos y cero filas si aceptada/revocada/vencida, `aceptar_nueva` crea usuario, credencial y membresía en una transacción, `cuenta_existe` no consume, dos aceptaciones concurrentes del mismo token → una sola, `aceptar_existente` con otro correo, sesión revocada o ya miembro → cero filas; solo hashes en BD (CA-3, CA-14); `filtroAlcance`/`clienteVisible` global y asignado; `desactivar` borra asignaciones (D19); lote con un ID ajeno → nada aplicado (CA-8). Ajustar `catalogo.spec.ts` (políticas de `contapp_auth` exactamente como el plan) y `FUNCIONES_AUTH` (15), con comentario.
- **Hecho cuando**: `pnpm test:aislamiento` y `pnpm --filter @contapp/db test` fallan solo en lo nuevo y por falta de esquema/funciones/repos; lo de 002–004 sigue verde salvo los dos ajustes, que fallan solo por lo que falta. Lista de pruebas en el commit. Commit `test(005): esquema de acceso, trigger y funciones de invitación (rojo)`.

## T3 · Pruebas unitarias y de rutas, rojo (tester · sonnet) ∥ T2
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/spec.md` (CA-1, CA-4, CA-5, CA-11; D2, D4, D8, D13, D16–D18), `docs/specs/005-acceso/plan.md` (Contratos: shared, Guards y decoradores; Decisiones: Orden, Escalada, CA-11), `apps/backend/src/modules/auth/guards/{decoradores,estudio.guard}.ts`, `apps/backend/src/modules/auth/guards/guards.spec.ts` (patrón), `apps/backend/test/fakes-auth.ts`.
- **Hacer**: `packages/shared/src/acceso/*.spec.ts`: prueba de **tabla** 5 roles × 22 permisos contra D2/D17; alcance por rol; `puedeGestionar` (Administrador no toca ni crea Dueño, nadie otorga lo que no tiene); `puedeSerResponsable`; esquemas descartan `tenantId`/`rol` extra y limitan lotes a 1..500. `apps/backend/src/modules/acceso/guards/*.spec.ts` con dobles: sin declaración → 403; sin permiso → 403 antes de consultar el cliente (espía); `req.acceso` no enumerable; alcance global y asignado; cliente inexistente, ajeno y no asignado → mismo 404; UUID mal formado → 404. `apps/backend/src/modules/acceso/rutas.spec.ts` (CA-11): `crearApp` + `DiscoveryService`: toda ruta con exactamente una declaración; `:clienteId` solo con `@Permiso`; un controlador de prueba sin declarar hace fallar la comprobación.
- **Hecho cuando**: `pnpm --filter @contapp/shared test` y `pnpm --filter @contapp/backend test` fallan solo por falta de implementación (import o firma). Commit `test(005): matriz de permisos, guards y rutas declaradas (rojo)`.

## T4 · Pruebas de integración HTTP, rojo (tester · sonnet) ∥ T3
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/spec.md` (CA-1 a CA-10, CA-14, "Ataques mínimos"), `docs/specs/005-acceso/plan.md` (Contratos: HTTP, Backend; Decisiones), `apps/backend/test/soporte.ts`, `apps/backend/src/modules/auth/auth.estudio.int.spec.ts` (patrón).
- **Hacer**: `apps/backend/src/modules/{acceso,clientes}/*.int.spec.ts` con `crearApp({ correo: CorreoMemoria, cupoUsuarios })` y usuarios propios por rol. Cubrir: tabla 5 roles × endpoints de 005 → 2xx/403 según D2 (CA-1); invitar responde igual con correo con o sin cuenta, solo hash en BD, 72 h, correo por la cola con el enlace `#t=`, 409 a miembro activo o desactivado, reenviar invalida el token anterior, revocar lo anula (CA-2); aceptar crea todo, política de 004, concurrente → uno, reusado/vencido/revocado/alterado → misma respuesta, cuenta existente → 409 `requiere_sesion` sin cambiar su contraseña, `aceptar-con-sesion` con otro correo → 400 (CA-3, D15); escalada D8, propio rol, autodesactivación, `rol`/`tenantId` en el cuerpo ignorados (CA-4); 15 de 120 asignados, 404 idénticos salvo `Date`, 403 antes del 404 (CA-5); sesión viva tras desasignar, cambiar rol o desactivar → la siguiente petición ya cambia (CA-6); responsable único, `anterior` colaborador/retirar, carrera HTTP, lectura como responsable → 409 (CA-7, D18); lote de 500, lote con un ID ajeno → 404 sin aplicar nada, >500 → 400 (CA-8); desactivar: sesiones de ese estudio sin estudio y las de otro estudio siguen, asignaciones retiradas, reactivar no las devuelve (CA-9, D19); último Dueño → 409, también concurrente (CA-10); canarios de token y contraseña ausentes de logs, errores y respuestas, `GET /invitaciones` sin token ni hash (CA-14). `CupoUsuarios` espía: llamado al invitar, aceptar y reactivar en la misma transacción.
- **Hecho cuando**: `pnpm --filter @contapp/backend test:int` falla solo por falta de implementación; las de 004 siguen verdes salvo las que dependan de `uA` como `admin` (ajustar a `dueno`, con comentario). Commit `test(005): integración HTTP de acceso (rojo)`.

## T5 · Suite HU-40 por API, rojo (tester · sonnet) ∥ T4
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/spec.md` (CA-12, D14), `docs/specs/005-acceso/plan.md` (Contratos: HTTP; Decisiones: HU-40), `apps/backend/test/soporte.ts`, `docs/02-requerimientos.md` (solo HU-40).
- **Hacer**: `apps/backend/src/aislamiento/hu40-api.int.spec.ts`: estudios A y B con un Dueño y un asistente cada uno; un usuario de A llama a **todas** las rutas de 004 y 005 (lista sacada de las rutas registradas, para que una ruta nueva entre sola) con IDs de B (cliente, usuario, membresía, invitación, asignación) en URL, cuerpo y lotes mezclados con IDs propios → siempre 404 o listas sin datos de B, y la BD de B intacta; simétrica (B contra A). Falla si una ruta registrada no tiene caso.
- **Hecho cuando**: falla solo por falta de implementación; corre dentro de `pnpm ci:db`. Commit `test(005): HU-40 por API con dos estudios (rojo)`.

## T6 · Pruebas del frontend, rojo (tester · sonnet) ∥ T5
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/spec.md` (CA-15, D15), `docs/specs/005-acceso/plan.md` (Contratos: HTTP; Decisiones: Aceptación), `apps/frontend/next.config.ts`, `apps/frontend/app/(app)/layout.spec.tsx` (patrón), `apps/frontend/lib/api.ts`.
- **Hacer**: `apps/frontend/**/*.spec.tsx` con `fetch` simulado: menú oculta Usuarios/Clientes según `GET /acceso/yo`; Usuarios lista rol y estado y muestra invitar, reenviar, revocar, cambiar rol, desactivar y reactivar solo con `usuarios.gestionar` (un Administrador no ve acciones sobre Dueños); `/invitacion` lee `#t=`, lo borra con `replaceState`, nunca lo pone en URL ni `console`, consulta, crea cuenta (política 12–128) o, con `cuentaExiste`, inicia sesión en la misma página y acepta con sesión; `next.config` devuelve `Referrer-Policy: no-referrer` en `/invitacion`; clientes: asignación individual (con elección colaborador/retirar) y masiva (selección múltiple → `POST /asignaciones/por-usuario`); 403/404 muestran mensajes genéricos.
- **Hecho cuando**: `pnpm --filter @contapp/frontend test` falla solo por falta de implementación. Commit `test(005): pantallas de acceso (rojo)`.

## T7 · BD de acceso (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/plan.md` (Contratos: packages/db, BD; Decisiones: D3 y carreras, Seed), pruebas de T2, `packages/db/src/schema/{acceso,clientes}.ts`, `packages/db/migrations/{0002_rls_y_grants,0007_auth,0009_auth_ronda2,0010_auth_final}.sql` (patrones y cuerpos a redefinir), `packages/db/src/auth/repositorio.ts`, `packages/db/src/credenciales/repositorio.ts` (patrón de repo), `packages/db/src/{index.ts,seed/datos.ts,cli/seed.ts}`.
- **Hacer**: esquema TS → `drizzle-kit generate` → `0011_acceso.sql` (con la conversión `admin` → `dueno` antes del `CHECK`); `0012_acceso_rls.sql` y `0013_acceso_auth.sql` custom según el plan (mismas firmas, dueño y `search_path` en las redefinidas; nada de 0008); `src/acceso/**`, `AuthRepo` += invitación, exportar; seed. No tocar `apps/`.
- **Hecho cuando**: `pnpm db:migrate` ×2 y `pnpm db:seed` ×2; `drizzle-kit generate` sin cambios; `pnpm test:aislamiento` todo verde (002–005); `pnpm --filter @contapp/db test` verde; `pnpm cobertura:db` 0; `packages/db/src/{acceso,auth}/**` ≥ 90 % por archivo; backend `test:int` de 004 sigue verde; lint OK. Commit `feat(005): asignaciones, invitaciones, último Dueño y membresía activa en auth`.

## T8 · Shared de acceso (backend · sonnet) ∥ T7
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/plan.md` (Contratos: shared), `packages/shared/src/acceso/*.spec.ts`, `packages/shared/src/{index.ts,auth/esquemas.ts}`.
- **Hacer**: `packages/shared/src/acceso/**` y exportar. Sin IO.
- **Hecho cuando**: `pnpm --filter @contapp/shared test` verde; build, typecheck y lint OK; esos archivos ≥ 90 % por archivo. Commit `feat(005): catálogo de permisos, roles de sistema y esquemas de acceso`.

## T9 · Guards y arranque (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/plan.md` (Contratos: Guards y decoradores, Backend; Decisiones: Orden, D3, CA-11, Clientes), pruebas de T3, `apps/backend/src/{app.ts,app.module.ts}`, `apps/backend/src/modules/auth/guards/*.ts`, `apps/backend/src/modules/auth/auth.service.ts` (lista de estudios), `apps/backend/src/modules/estudio/estudio.controller.ts`, `apps/backend/src/comun/filtro-errores.ts`, `packages/db/src/acceso/alcance.ts`.
- **Hacer**: `modules/acceso/guards/**` y `errores.ts`; registrar `PermisoGuard` y `ClienteScopeGuard` tras `CsrfGuard` en `crearApp`; `@SoloEstudio()` en `GET /estudio/actual`; `GET /auth/estudios`/`requiereEstudio` sin membresías desactivadas; módulos `acceso` y `clientes` vacíos registrados en `AppModule` (T10 y T11 no tocan `app.module.ts`); opción `cupoUsuarios` en `crearApp` con `CupoSinLimite` por defecto.
- **Hecho cuando**: pruebas de T3 de guards y rutas en verde; backend `test` y `test:int` de 004 en verde; typecheck y lint OK; esos archivos ≥ 90 %. Commit `feat(005): PermisoGuard y ClienteScopeGuard con denegación por defecto`.

## T10 · Usuarios e invitaciones (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/plan.md` (Contratos: HTTP de `/acceso`, `/usuarios`, `/invitaciones`, Backend; Decisiones: D3 y carreras, Escalada, Invitar a un miembro desactivado, Aceptación, Correos), `docs/specs/005-acceso/spec.md` (CA-2, 3, 4, 6, 9, 10, 14), `apps/backend/src/modules/acceso/*.int.spec.ts`, `apps/backend/src/modules/acceso/guards/decoradores.ts`, `apps/backend/src/modules/auth/contrasena/politica.ts`, `apps/backend/src/infra/correo/cola.ts`, `packages/db/src/acceso/{miembros,invitaciones}.ts`, `packages/db/src/auth/repositorio.ts`.
- **Hacer**: `yo.controller`, `usuarios.{controller,service}`, `invitaciones.{controller,service}`, `cupo/**` según el plan; sin SQL en el backend.
- **Hecho cuando**: las `*.int.spec.ts` de `acceso` y las unitarias en verde; typecheck y lint OK; `modules/acceso/**` ≥ 90 %. Commit `feat(005): miembros, roles e invitaciones`.

## T11 · Clientes y asignaciones (backend · sonnet) ∥ T10
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/plan.md` (Contratos: HTTP de `/clientes` y `/asignaciones`; Decisiones: Rol que pierde `sire.clasificar`, Clientes), `docs/specs/005-acceso/spec.md` (CA-5, 7, 8), `apps/backend/src/modules/clientes/*.int.spec.ts`, `apps/backend/src/modules/acceso/guards/decoradores.ts`, `packages/db/src/acceso/{alcance,asignaciones,clientes}.ts`.
- **Hacer**: `clientes.controller`, `asignaciones.{controller,service}`; listados solo con `filtroAlcance`; lotes deduplicados, todo o nada.
- **Hecho cuando**: las `*.int.spec.ts` de `clientes` en verde; typecheck y lint OK; `modules/clientes/**` ≥ 90 %. Commit `feat(005): clientes visibles y asignación individual y masiva`.

## T12 · Pantallas (frontend · sonnet) ∥ T7–T11
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/plan.md` (Contratos: HTTP; Decisiones: Aceptación), `docs/specs/005-acceso/spec.md` (CA-15), pruebas de T6, `apps/frontend/{next.config.ts,app/(app)/layout.tsx,lib/api.ts,lib/sesion.ts}`, `apps/frontend/app/(publico)/recuperar/nueva/page.tsx` (patrón del fragmento), `packages/shared/src/acceso/` (si aún no existe, usar el contrato y alinear al terminar T8).
- **Hacer**: páginas, `lib/acceso.ts`, menú y `next.config.ts` según el plan. Ocultar acciones sin permiso (el backend sigue siendo la barrera). Sin endpoints inventados.
- **Hecho cuando**: `pnpm --filter @contapp/frontend test` en verde; typecheck, lint y build OK. Commit `feat(005): pantallas de usuarios, invitación y asignación de clientes`.

## T13 · Integración (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/plan.md` (Contratos: HTTP), `package.json`.
- **Hacer**: correr `pnpm build`, `typecheck`, `lint`, `test`, `ci:db`, `cobertura:acceso`, `cobertura:auth`, `cobertura:db`. Prueba manual (backend `PORT=4000`, frontend `next build && next start`, `curl` vía `http://localhost:3000/api`): `uA` entra, `GET /acceso/yo` dice `dueno`; invita a un correo nuevo → el enlace aparece en el stdout del backend (no copiar el token al informe); `curl -I /invitacion` → `Referrer-Policy: no-referrer`; `uAB` (contador) en A ve solo su cliente asignado en `GET /clientes`.
- **Hecho cuando**: todos salen 0 (reportar conteos); la prueba manual da lo esperado; servidores parados; `git status` sin archivos ajenos agregados. Commit `chore(005): integración y checks completos` solo si cambió algún archivo.

## T14a · Ronda adversarial 1a: lista mínima (adversario · opus)
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/spec.md` (Criterios y "Ataques mínimos"), `docs/specs/005-acceso/plan.md` (Contratos). **Caja negra**: no leer implementación.
- **Hacer**: hasta ~8 pruebas en `apps/backend/src/modules/acceso/r1a.adv.int.spec.ts` y `tests/aislamiento/acceso-r1a.adv.spec.ts` sobre la lista mínima de la spec (asistente/lectura en gestión y asignación, desactivado con sesión viva, desasignado y rol cambiado durante la sesión, IDOR en URL/cuerpo/lotes, asignación masiva de campos, escalada, último Dueño y responsable en carrera, token de invitación en todas sus variantes, enumeración al invitar, oráculos 403/404, ruta sin declarar).
- **Instrucciones defensivas**: solo escribir `*.adv.spec.ts`/`*.adv.int.spec.ts`; no modificar producción, pruebas ajenas, migraciones ni `.env`; canarios, nunca contraseñas reales; cada prueba deja la BD como estaba (rollback o limpieza de lo que creó); aserción concreta; un fallo del entorno no es hallazgo.
- **Hecho cuando**: pruebas commiteadas; cada fallo en "Resultado" de esta tarea y en "Hallazgos adversariales abiertos" de `ESTADO.md` (archivo:línea, severidad, una línea). Commit `test(005): ronda adversarial 1a`.

## T14b · Ronda adversarial 1b: escenarios nuevos (adversario · opus) ∥ T14a
- **Contexto (leer solo esto)**: igual que T14a + `plan.md` (Decisiones, Riesgos); después (caja blanca) `apps/backend/src/modules/{acceso,clientes}/**`, `packages/db/src/acceso/**`, `packages/db/migrations/0011_acceso.sql`–`0013_acceso_auth.sql`.
- **Hacer**: hasta ~7 pruebas en `*-r1b.adv*.spec.ts`, distintas de T14a: funciones `SECURITY DEFINER` nuevas con `search_path` hostil o escritura fuera de lo previsto; `contapp_auth` creando usuarios o membresías indebidas; trigger del último Dueño por `DELETE`, `UPDATE` de `tenant_id` o desde el worker; carrera entre desactivar y aceptar una invitación del mismo usuario; carrera entre cambiar de rol y asignar como responsable (D18); `filtroAlcance` con asignaciones de otro estudio; correo de invitación con cabeceras o `Host` hostiles; riesgos del plan.
- **Instrucciones defensivas**: las de T14a.
- **Hecho cuando**: igual que T14a. Commit `test(005): ronda adversarial 1b`.

## T15 · Corregir ronda 1 (backend · opus; frontend · sonnet si aplica)
- **Contexto (leer solo esto)**: hallazgos de 005 en `ESTADO.md`, los `*.adv*.spec.ts` que fallan, los archivos que señalan, `plan.md` (Decisiones).
- **Hacer**: corregir en `src/` o con una migración nueva. Si un hallazgo pide cambiar la spec o aceptar un riesgo: `abierto · requiere usuario`, sin decidir.
- **Hecho cuando**: `pnpm test`, `pnpm ci:db`, `pnpm cobertura:acceso` en verde salvo lo marcado para el usuario; hallazgos `corregido (<commit>)`; `plan.md` actualizado si cambió un contrato. Commit `fix(005): hallazgos de la ronda adversarial 1`.

## T16a · Ronda 2a: regresión y reconversión (adversario · opus)
- **Contexto (leer solo esto)**: igual que T14b + `git diff <commit T14b>..HEAD -- apps packages`.
- **Hacer**: si la ronda 1 no tuvo fallos, marcar T16a, T16b y T17 `[x]` "omitida: ronda 1 sin fallos". Si no: reconvertir las pruebas de hallazgos aceptados por el usuario (con comentario) y hasta ~5 pruebas que reintenten cada corrección por otra vía.
- **Instrucciones defensivas**: las de T14a; además, comprobar que la prueba ataca la vía real de uso y que el hallazgo tiene arreglo posible.
- **Hecho cuando**: igual que T14a. Commit `test(005): ronda adversarial 2a`.

## T16b · Ronda 2b: ataques nuevos (adversario · opus) ∥ T16a
- **Contexto (leer solo esto)**: igual que T16a.
- **Hacer**: hasta ~10 pruebas nuevas en `*-r2b.adv*.spec.ts` contra las correcciones y huecos restantes. Omitida si la ronda 1 no tuvo fallos.
- **Instrucciones defensivas**: las de T16a.
- **Hecho cuando**: igual que T14a. Commit `test(005): ronda adversarial 2b`.

## T17 · Corregir ronda 2 (backend · opus; frontend · sonnet si aplica)
- **Contexto / Hacer / Hecho cuando**: igual que T15 con los hallazgos de T16a/T16b; omitida si no hubo. Commit `fix(005): hallazgos de la ronda adversarial 2`.

## T18 · Verificación (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/spec.md` (Criterios, "Cobertura"), `plan.md` (Contratos; Decisiones: Cobertura, Lint, HU-40), hallazgos de 005 en `ESTADO.md`.
- **Hacer**: evidencia por CA con comando y resultado: CA-1 a CA-10 y CA-14 (backend `test` + `test:int`); CA-11 (`rutas.spec.ts`); CA-12 (`hu40-api.int.spec.ts` dentro de `pnpm ci:db`); CA-13 (`test:aislamiento`, consulta propia a `pg_policy`/`has_table_privilege`/`has_function_privilege`, `pnpm lint`, `tests/limites`); CA-15 (`pnpm --filter @contapp/frontend test` + `curl -I /invitacion`); CA-16 (hallazgos cerrados o aceptados, `*.adv*` verdes); `pnpm cobertura:acceso` (4 métricas ≥ 90 % por archivo, listar el mínimo); `cobertura:auth` y `cobertura:db` en 0; migraciones desde cero en una base desechable.
- **Hecho cuando**: cada CA con evidencia en "Resultado"; ESTADO 005 → `verificada`. Commit `docs(005): verificación de criterios con evidencia`.

## T19 · Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `docs/specs/005-acceso/{spec,plan}.md`, "Resultado" de T18, `packages/db/migrations/0011_acceso.sql`–`0013_acceso_auth.sql`, `apps/backend/src/modules/acceso/guards/*.ts`, `apps/backend/src/modules/acceso/{usuarios,invitaciones}.service.ts`, `apps/backend/src/modules/clientes/asignaciones.service.ts`, `apps/backend/src/app.ts`.
- **Hacer**: contrastar cada CA, D1–D21 y el DoD A (04 §5) con su evidencia; listar faltantes y riesgos aceptados para informar al usuario.
- **Hecho cuando**: veredicto "aprobada" o lista de faltantes con tarea asignada. Sin commit si no cambia archivos.

## T20 · Cierre (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/ESTADO.md`, `docs/specs/005-acceso/tasks.md`, observaciones de T19.
- **Hacer**: marcar `[x]` las tareas hechas y las casillas CA de `spec.md`; ESTADO 005 → `hecha`, "Tarea actual" → `—`; hallazgos de 005 en su estado final; quitar de "Notas para specs futuras" las notas `[005]` resueltas y agregar las que deje 005 para 006/007/008.
- **Hecho cuando**: `git status` limpio salvo `docs/explorador/`, `.codex/`, `AGENTS.md`; `git log --oneline` muestra los commits de 005. Commit `chore(005): cierra spec 005`.
