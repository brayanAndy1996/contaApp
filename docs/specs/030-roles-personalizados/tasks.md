# Tareas 030 · Roles personalizados

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` en paralelo con las indicadas (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: pruebas (rojo, con cobertura y E2E planificadas) → implementar (verde) → 1 ronda adversarial (Opus) → corregir → cobertura → E2E → verificar → revisión de Opus → cerrar. CA, D y U = `spec.md`; contratos = `plan.md`. Parte de la rama de 029 (sin mergear). Migraciones: 0082 (T6) y 0083 (T13, solo si hace falta).

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Pruebas de BD: tablas, `CHECK`, funciones, escalada en BD, concurrencia, inventario de funciones, rendimiento (rojo) | tester | sonnet | — ∥ T2, T3, T4, T5 | ✓ | — | [x] |
| T2 | Pruebas puras de `shared`: resolvedor, U3, `puedeGestionar`, zod, casos TS/SQL (rojo) | tester | sonnet | — ∥ T1, T3, T4, T5 | ✓ | — | [x] |
| T3 | Pruebas HTTP: `/roles`, asignación, tabla por permiso, escalada, TOTP, auditoría (rojo) | tester | sonnet | — ∥ T1, T2, T4, T5 | ✓ | — | [x] |
| T4 | Pruebas del frontend: Roles, selector de rol, avisos (rojo) | tester | sonnet | — ∥ T1, T2, T3, T5 | ✓ | — | [x] |
| T5 | E2E `roles.e2e.ts` con login, invitación (Mailpit) y TOTP (rojo) | tester | sonnet | — ∥ T1, T2, T3, T4 | ✓ | — | [x] |
| T6 | Migración 0082, drizzle, repositorio, soportes y catálogos | backend | opus | T1, T2 ∥ T7 | ✓ | — | [x] |
| T7 | Núcleo en `shared`: resolvedor, combinación, `puedeGestionar`, esquemas, casos | backend | opus | T2 ∥ T6 | ✓ | — | [x] |
| T8 | Núcleo del backend: guards, alcance, escalada al asignar, TOTP, `/yo` | backend | opus | T3, T6, T7 ∥ T9, T10 | ✓ | — | [ ] |
| T9 | Módulo `/roles` (CRUD, asignables, impacto, errores, auditoría) | backend | sonnet | T3, T6, T7 ∥ T8, T10 | ✓ | — | [ ] |
| T10 | Pantallas «Equipo → Roles» y selector de rol | frontend | sonnet | T4, T7 ∥ T8, T9 | ✓ | — | [x] |
| T11 | Ronda 1a (caja negra, HTTP y UI) | adversario | opus | T8, T9, T10 ∥ T12 | — | ✓ | [ ] |
| T12 | Ronda 1b (caja blanca, SQL, RLS, bloqueos) | adversario | opus | T8, T9 ∥ T11 | — | ✓ | [ ] |
| T13 | Corregir hallazgos de la ronda | backend (+frontend) | opus (sonnet) | T11, T12 | — | — | [ ] |
| T14 | Cobertura ≥ 90 % por archivo | devops (+tester) | sonnet | T13 | — | — | [ ] |
| T15 | E2E con Mailpit y `pnpm e2e` completo | tester | sonnet | T13 ∥ T14 | — | — | [ ] |
| T16 | Verificar CA-1 a CA-12 con evidencia | tester | sonnet | T14, T15 | — | — | [ ] |
| T17 | Revisión final contra la spec | arquitecto | opus | T16 | — | — | [ ] |
| T18 | Cierre: `tasks.md`, `spec.md`, `cierre.md` y commit (el orquestador actualiza `ESTADO.md`) | devops | haiku | T17 | — | — | [ ] |

Paralelismo: oleada 1 = T1 (`tests/aislamiento/roles-*.spec.ts`, `packages/db/src/**/*.spec.ts`) ∥ T2 (`packages/shared/**/*.spec.ts`, `factor-exigido.casos.ts`, `efectivos.casos.ts`) ∥ T3 (`apps/backend/src/modules/**/*.int.spec.ts`, `apps/backend/test/fakes-auth.ts`) ∥ T4 (`apps/frontend/**/*.spec.tsx`) ∥ T5 (`tests/e2e/flujos/roles.e2e.ts`, `tests/e2e/soporte/siembra-roles.ts`). Oleada 2 = T6 (`packages/db/**` sin specs nuevas, soportes y catálogos) ∥ T7 (`packages/shared/src` sin specs). Oleada 3 = T8 (`guards/`, `auth/totp/exigencia.ts`, `usuarios.service.ts`, `invitaciones.service.ts`, `yo.controller.ts`) ∥ T9 (`acceso/roles/`, `acceso.module.ts`, `errores.ts`, `mensajes.ts`) ∥ T10 (`apps/frontend`). T11 ∥ T12; T14 (`vitest.cobertura.config.mts`, specs de cobertura) ∥ T15 (`tests/e2e/`). El resto en serie.

Escalamientos: T6, T7, T8 nacen en `opus` (permisos, escalada, RLS, `SECURITY DEFINER`, bloqueos; 04 §3.2). T9, T10 pasan a `opus` si fallan 2 veces; T14 y T18 suben un nivel si fallan una vez. Ronda 2 (CA-12 permite ≤ 2) solo si T13 corrige un hallazgo alto o la corrección toca bloqueos o RLS: el orquestador agrega T13a (adversario opus) y T13b.

Reglas comunes:
- **BD propia**: `source /tmp/claude-0/-home-user-contaApp/6eb10b06-0f9d-5a3e-bcbb-c7cda980cf63/scratchpad/env-029.sh; usar_bd N` (no imprimir el archivo). N por tarea: T1=1, T3=3, T6=6, T8=8, T9=9, T11=11, T12=12, T13=13, T14=14, T16=16, T17=17. Antes de empezar, recrear solo `contapp_029tN` y migrar. **Nunca** `DROP` ni `TRUNCATE` de `contapp` ni `contapp_e2e`; la E2E migra `contapp_e2e` sin borrarla. PG 16: sin `MERGE … RETURNING`.
- Un commit por tarea (`test(030)`, `feat(030)`, `fix(030)`, `chore(030)`) con `git add <rutas>` explícitas y el trailer del modelo; sin `stash`, `reset`, `clean` ni push.
- El tester no toca producción; backend y frontend no editan `*.spec.ts`, **salvo** T6, dueño de `escalada.adv.spec.ts`, `catalogo.spec.ts` y los soportes. Solo T11 y T12 escriben `*.adv*.spec.ts`. Quien rompe una suite existente la ajusta sin quitar aserciones.
- **Migraciones**: solo T6 (0082) y T13 (0083). Si otra tarea necesita SQL, para y lo reporta. Nunca editar una migración aplicada.
- **Bloqueos** (D4, orden fijo en todo camino): advisory `acceso.roles:<tenant>` → `bloquearMiembros` → `rol` `FOR UPDATE` → asignaciones → invitaciones → advisory `acceso.duenos` (disparador de 005). Nadie toma uno anterior tras uno posterior.
- **Funciones**: `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, `REVOKE ALL … FROM PUBLIC` y de cada rol antes del `GRANT` justo, SQLSTATE y mensaje fijos.
- **Cobertura planificada**: cada tarea de pruebas lista los archivos nuevos que cubre y apunta a ≥ 90 % de líneas y ramas por archivo; T14 solo mide y rellena huecos.
- **Rendimiento** (CA-11): `medirEscala`, ≥ 5 corridas intercaladas, en `*.rendimiento.spec.ts` fuera de cobertura; no se sube un tope para que pase.
- Tareas largas (`pnpm e2e`, `test:aislamiento`, coberturas) con `nohup … > log 2>&1 &`. Reportes: solo fallos (`archivo:línea · mensaje`) o «OK» + conteo.
- **Mailpit**: `/tmp/mailpit-bin/x/mailpit`; si el contenedor se reinició, reinstalarlo está autorizado.

## T1 · Pruebas de BD (tester · sonnet · BD 1)
- **Contexto**: `plan.md#contratos` (BD) y `#decisiones`; spec CA-1, CA-2, CA-5–CA-11, U2–U9; `tests/aislamiento/{acceso-funciones,acceso-r1b.adv,auth-totp-cuenta}.spec.ts`, `acceso-soporte.ts`; `packages/db/src/acceso/repositorios.spec.ts`, `schema/acceso.spec.ts`.
- **Hacer**: `tests/aislamiento/roles-{tablas,funciones,concurrencia}.spec.ts` (RLS `FORCE`, FK compuestas, `CHECK`, sin escritura directa, `rol_guardar`/`rol_eliminar` con U1–U5/U9, disparador de asignación, `permisos_membresia` con `CASOS_EFECTIVOS`, `totp_desactivar` con propios, aceptar invitación con rol editado/eliminado, 20 concurrentes para CA-8/CA-10/U9, sin interbloqueos); `roles-funciones-rol.spec.ts` (inventario cerrado de `pg_proc` con `rol`, conteo por clase U10/resolvedor); repositorio `acceso/roles.spec.ts` + `roles.rendimiento.spec.ts`; ajustar `schema/acceso.spec.ts` a `'propio'`.
- **Hecho cuando**: rojo por falta de 0082/repositorio (no por error de la prueba); las suites existentes siguen verdes; lista de archivos a cubrir en el mensaje del commit.

## T2 · Pruebas puras de shared (tester · sonnet)
- **Contexto**: `plan.md#contratos` (Shared); spec U2–U4, U8; `packages/shared/src/acceso/{roles,permisos,esquemas}.spec.ts`, `auth/factor-exigido.casos.ts`, `auth/seguridad.spec.ts`.
- **Hacer**: `acceso/{efectivos,combinacion,roles-propios}.spec.ts`, `efectivos.casos.ts` (sistema ×5, propio global/asignado, vacío, cada permiso con sus requisitos); `puedeGestionar` por conjuntos y `puedeGestionarRol` (contención, alcance, rol propio del actor); todo rol de sistema pasa `validarCombinacion`; filas de propios en `CASOS_FACTOR_EXIGIDO`; zod de `RolAsignado`; acciones `rol.*`. `efectivos.casos.ts` es solo datos y tipos existentes (T6 lo usa sin esperar a T7).
- **Hecho cuando**: rojo por módulos ausentes; casos cubren las 23 reglas de U3 y cada permiso sensible de U2/029.

## T3 · Pruebas HTTP (tester · sonnet · BD 3)
- **Contexto**: `plan.md#contratos` (HTTP); spec CA-1–CA-12; `apps/backend/src/modules/acceso/{permisos,miembros,invitaciones}.int.spec.ts`, `auth/totp.exigencia.int.spec.ts`, `auditoria/auditoria.int.spec.ts`; `apps/backend/test/{soporte-acceso,fakes-auth,auditoria-rutas}.ts`.
- **Hacer**: `acceso/roles/*.int.spec.ts`: CRUD, 422/409/403/404 con códigos, `asignables`, `impacto`; tabla por permiso (CA-4) con rol que solo lo tiene vs sin él; alcance asignado → 404; edición aplica en la siguiente petición; escalada (U2, U4); TOTP exigido tras ganar permiso sensible; 5 roles × endpoints sigue verde; auditoría antes/después; `roles.rendimiento.int.spec.ts` (guard y listado, CA-11).
- **Hecho cuando**: rojo por rutas o módulos ausentes; ninguna aserción existente quitada.

## T4 · Pruebas del frontend (tester · sonnet)
- **Contexto**: `plan.md#contratos`; spec Alcance, U5, U6, U8; `apps/frontend/app/(app)/usuarios/{page,plan}.spec.tsx`, `layout-acceso.spec.tsx`.
- **Hacer**: `usuarios/roles/*.spec.tsx`: lista (sistema solo lectura), crear desde base, sin `plan.gestionar`, requisitos U3 en el formulario, aviso de impacto (U6, U8) antes de guardar, 409 en uso y límite; selector de rol con propios en invitar y cambiar rol; menú visible solo con `roles.gestionar`.
- **Hecho cuando**: rojo por componentes ausentes; los archivos a cubrir están listados.

## T5 · E2E en rojo (tester · sonnet)
- **Contexto**: spec CA-1, CA-4, CA-6, CA-7; `tests/e2e/flujos/{equipo,cuenta-segura}.e2e.ts`, `tests/e2e/soporte/{siembra,correo,segundo-paso,totp}.ts`.
- **Hacer**: `roles.e2e.ts`: Dueño (TOTP) crea «Practicante» asignado → invita (Mailpit) → aceptación con login → ve solo asignados (404 en otro) → Dueño agrega `usuarios.gestionar` → el practicante queda exigido de TOTP y enrola → eliminar en uso da 409; `siembra-roles.ts`.
- **Hecho cuando**: `pnpm --filter @contapp/tests-e2e exec playwright test --list` lista el flujo y tipa; falla solo por la funcionalidad ausente.

## T6 · Migración 0082 y repositorio (backend · opus · BD 6)
- **Contexto**: `plan.md#contratos` (BD) y `#decisiones`; spec D1–D4, U2–U9; migraciones 0012, 0015, 0016, 0081; `packages/db/src/acceso/{miembros,invitaciones}.ts`; pruebas de T1 y `efectivos.casos.ts` de T2.
- **Hacer**: 0082 completa (tablas, `CHECK`, funciones, disparador, nuevas versiones, auditoría), drizzle y `acceso/roles.ts`; ampliar `escalada.adv.spec.ts`, `catalogo.spec.ts` y los soportes (borrar `rol_permiso`/`rol` en réplica y lanzar si queda algo).
- **Hecho cuando**: T1 verde en BD 6 recién migrada; `test:aislamiento` sin fallas nuevas (las conocidas de PG 16 aparte); `pnpm --filter @contapp/db test` verde.

## T7 · Núcleo en shared (backend · opus)
- **Contexto**: `plan.md#contratos` (Shared); spec U2–U4, U8; pruebas de T2; `packages/shared/src/acceso/roles.ts`, `auth/seguridad.ts`.
- **Hacer**: `efectivos.ts`, `combinacion.ts`, `roles-propios.ts`; `puedeGestionar` por conjuntos sin romper sus llamadas; `rolAsignadoSchema` en `invitarSchema`/`cambiarRolSchema`; acciones `rol.*`; exportar en `index.ts`.
- **Hecho cuando**: `pnpm --filter @contapp/shared test` verde (T2 incluida) y `build` sin errores.

## T8 · Núcleo del backend (backend · opus · BD 8)
- **Contexto**: `plan.md#contratos` y `#decisiones`; spec CA-3–CA-8, D4; `guards/{permiso,cliente-scope}.guard.ts`, `auth/totp/exigencia.ts`, `usuarios.service.ts`, `invitaciones.service.ts`, `yo.controller.ts`; pruebas de T3 sobre guard, asignación y TOTP.
- **Hacer**: `Efectivo` en el guard desde `miembroActual` (una consulta), alcance efectivo, `puedeSerResponsable`, `factorExigido` con permisos efectivos; invitar y cambiar rol con `{rolId}` (404 ajeno, escalada); `/yo` con efectivos; sin tocar `errores.ts`/`mensajes.ts` (de T9; códigos en shared por T7).
- **Hecho cuando**: sus pruebas de T3 verdes; `acceso*`, `permisos.int`, `totp.*.int` y `auditoria*.int` sin regresiones.

## T9 · Módulo /roles (backend · sonnet · BD 9)
- **Contexto**: `plan.md#contratos` (HTTP); spec CA-1, CA-2, CA-5, CA-6, U5, U6, U9; `acceso/{invitaciones.controller,errores,mensajes,acceso.module}.ts`; pruebas `acceso/roles/*.int.spec.ts` de T3.
- **Hacer**: `roles.controller.ts` y `roles.service.ts` sobre `acceso/roles.ts` dentro de `withTenant`; códigos de error del plan; `impacto` sin escribir.
- **Hecho cuando**: `acceso/roles/*.int.spec.ts` y el rendimiento de listado verdes.

## T10 · Pantallas (frontend · sonnet)
- **Contexto**: `plan.md#contratos`; spec Alcance, U3, U5, U6, U8; pruebas de T4; `apps/frontend/app/(app)/usuarios/page.tsx`, `layout.tsx`.
- **Hacer**: `usuarios/roles/` (lista, formulario por módulo con requisitos U3, partir de base, aviso de impacto) y selector de rol con `GET /roles/asignables`; solo `packages/shared`.
- **Hecho cuando**: pruebas de T4 verdes; `pnpm --filter @contapp/frontend lint` y `typecheck` sin errores.

## T11 · Ronda 1a caja negra (adversario · opus · BD 11)
- **Contexto**: `spec.md`, `plan.md#contratos`; código de T8–T10 solo como referencia.
- **Hacer**: atacar por HTTP: escalada (propio, lateral, alcance), `plan.gestionar`, ids ajenos, evadir TOTP, último Dueño, avisos indebidos (U10), carreras; `*.adv.int.spec.ts`.
- **Hecho cuando**: hallazgos con severidad, prueba roja que los reproduce y ruta; o «sin hallazgos» con lo intentado.

## T12 · Ronda 1b caja blanca (adversario · opus · BD 12)
- **Contexto**: `0082_roles_propios.sql`, `packages/db/src/acceso/roles.ts`, `plan.md#decisiones`, spec D4.
- **Hacer**: atacar en BD: RLS, `SECURITY DEFINER`, disparador, orden de bloqueo, funciones con `rol` fuera del inventario, `CASOS_EFECTIVOS` vs SQL; `tests/aislamiento/roles-r1b.adv.spec.ts`.
- **Hecho cuando**: como T11.

## T13 · Corregir (backend opus · frontend sonnet · BD 13)
- **Contexto**: hallazgos de T11/T12 y sus pruebas rojas; solo los archivos que nombran.
- **Hacer**: corregir media/alta (y bajas baratas); SQL solo en 0083; los bajos aceptados van a `HALLAZGOS.md` para decisión del usuario.
- **Hecho cuando**: pruebas adversariales verdes (o `it.fails` aceptada) y suites de T6–T10 sin regresiones.

## T14 · Cobertura (devops · sonnet · BD 14)
- **Contexto**: archivos nuevos listados por T1–T4; `apps/backend/vitest.cobertura.config.mts`; scripts `cobertura:*` del `package.json` raíz.
- **Hacer**: agregar globs; correr `cobertura:db`, `cobertura:backend` y la del frontend; si un archivo queda < 90 %, el tester agrega pruebas (no se excluye código).
- **Hecho cuando**: cada archivo nuevo o tocado ≥ 90 % de líneas y ramas, con la tabla en `resultados.md`.

## T15 · E2E (tester · sonnet)
- **Contexto**: `tests/e2e/flujos/roles.e2e.ts`, `tests/e2e/soporte/pila/`; Mailpit.
- **Hacer**: levantar la pila (`contapp_e2e` migrada, sin borrar), correr `roles.e2e` y luego `pnpm e2e` completo; defectos de producción se devuelven como T15a.
- **Hecho cuando**: `pnpm e2e` verde (con las `test.fail` conocidas), conteo en `resultados.md`.

## T16 · Verificar (tester · sonnet · BD 16)
- **Contexto**: `spec.md` (CA-1–CA-12), `resultados.md`.
- **Hacer**: por criterio, la prueba o comando que lo demuestra; correr `test:aislamiento`, backend, shared y frontend en BD 16 limpia.
- **Hecho cuando**: cada CA con evidencia en `resultados.md` o con el faltante listado.

## T17 · Revisión final (arquitecto · opus · BD 17)
- **Contexto**: `spec.md`, `plan.md`, `resultados.md`, diff de la rama contra 029.
- **Hacer**: revisar cada CA, U y D contra código y evidencia; defectos como T17a…
- **Hecho cuando**: veredicto «aprobada» o lista de faltantes.

## T18 · Cierre (devops · haiku)
- **Contexto**: `resultados.md`, veredicto de T17, plantilla `_plantilla/cierre.md`.
- **Hacer**: marcar tareas, `spec.md` a «hecha», `cierre.md` (siguiente migración libre), commit `chore(030)`.
- **Hecho cuando**: `git status` limpio salvo lo ajeno a 030.
