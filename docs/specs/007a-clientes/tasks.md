# Tareas 007a · Clientes, perfil fiscal, archivado y listado

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel B, sin ronda adversarial (spec D9). Flujo 04 §1.3: pruebas primero (rojo) → implementar (verde) → verificar → revisión contra la spec → cerrar. Rama `spec/007a-clientes` (desde `main`; los docs de 007a están commiteados). CA y D = `spec.md`; contratos y decisiones = `plan.md`. Se implementa sobre `main` con 005, 006 y 008 ya integradas.

| #    | Tarea                                                                                      | Rol        | Modelo | Depende de        | TDD | ADV | Estado |
| ---- | ------------------------------------------------------------------------------------------ | ---------- | ------ | ----------------- | --- | --- | ------ |
| T1   | Pruebas de BD: esquema de `cliente`, cupo de activos, revalidación y carreras (rojo)       | tester     | sonnet | —                 | ✓   | —   | [x]    |
| T2   | Pruebas unitarias: `validarRuc`, esquemas de shared y repositorios con tx falsa (rojo)     | tester     | sonnet | — ∥ T1            | ✓   | —   | [x]    |
| T3   | Pruebas de integración HTTP: rutas de clientes, cupo, alcance y archivado (rojo)           | tester     | sonnet | T1 ∥ T2           | ✓   | —   | [x]    |
| T4   | Pruebas del frontend y de la regla de lint `sql` (rojo)                                    | tester     | sonnet | — ∥ T3            | ✓   | —   | [x]    |
| T5   | Migración 0026, esquema de `cliente` y conteo de activos en `cupo`/`uso`                   | backend    | sonnet | T1                | ✓   | —   | [x] |
| T6   | `shared/clientes`: `validarRuc` y esquemas                                                 | backend    | sonnet | T2 ∥ T5           | ✓   | —   | [x]    |
| T7   | Repositorios `packages/db/clientes`: crear, editar, archivar, reactivar, leer, filtros     | backend    | sonnet | T2, T5, T6        | ✓   | —   | [x]    |
| T8   | Revalidación de 008 con «no archivado» y 409 al asignar archivados                         | backend    | sonnet | T1, T5 ∥ T7       | ✓   | —   | [ ]    |
| T9   | Servicio y controlador de clientes: cupo, orden de bloqueo, errores y auditoría de rutas   | backend    | sonnet | T3, T6, T7, T8    | ✓   | —   | [ ]    |
| T10  | Regla de lint: cerrar `import * as d from "drizzle-orm"`                                   | backend    | sonnet | T4 ∥ T5–T9        | ✓   | —   | [x] |
| T11a | Frontend: cliente HTTP y listado con filtros                                               | frontend   | sonnet | T4 ∥ T5–T10       | ✓   | —   | [x]    |
| T11b | Frontend: alta, detalle con datos fiscales y archivar/reactivar                            | frontend   | haiku  | T4, T11a          | ✓   | —   | [ ]    |
| T12  | Verificar CA-1 a CA-9 con evidencia (suites completas)                                     | tester     | sonnet | T9, T10, T11b     | —   | —   | [ ]    |
| T13  | Revisión contra la spec                                                                    | arquitecto | sonnet | T12               | —   | —   | [ ]    |
| T14  | Cierre: tasks y commit (el orquestador actualiza ESTADO)                                   | devops     | haiku  | T13               | —   | —   | [ ]    |

Escalamientos: ninguno previsto. T9 concentra el orden de bloqueo y las carreras de CA-7: si falla 2 veces nace de nuevo en `opus` (04 §3.3) y se anota aquí. T11b puede escalar a `sonnet` si `haiku` falla una vez.

Reglas comunes:

- Un commit por tarea (Conventional Commits `test(007a): …`, `feat(007a): …`, `fix(007a): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push del subagente: el orquestador lo hace tras cada tarea.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` (cambios ajenos): `git add <rutas>` explícitas, nunca `git add -A`/`.`.
- Nunca imprimir ni commitear secretos reales ni el contenido de `.env`. Las pruebas usan canarios.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo. Correr solo las pruebas del paquete afectado; la suite completa en T12.
- El tester no toca código de producción; backend y frontend no editan `*.spec.ts`; no hay `*.adv.spec.ts` en esta spec.
- Migraciones: la última aplicada es 0025; 007a empieza en **0026**. Confirmar con `ls packages/db/migrations` antes de crear. Nunca editar una aplicada. Las pruebas de 002–008 siguen en verde; si una contradice 007a (p. ej. el conteo de `contarRucs` de 006) se ajusta solo en la tarea de pruebas que lo diga, con comentario.
- Orden de bloqueo obligatorio (`plan.md`, Decisiones): `bloquearMiembros` → `CupoRucs.reservar` → `cliente` → `asignacion`.
- Escalar según 04 §3.3 y anotar arriba. Una ambigüedad que cambie la spec no se decide: `requiere usuario` y se informa al orquestador.

## T1 · Pruebas de BD, rojo (tester · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (D1, D4, D5; CA-2, CA-5, CA-7), `docs/specs/007a-clientes/plan.md` (Contratos: BD; Decisiones), `tests/aislamiento/{soporte,acceso-soporte,planes-soporte}.ts`, `tests/aislamiento/{catalogo,planes-carreras,ruc-repetido}.spec.ts` (patrones de catálogo y carreras con dos conexiones), `packages/db/src/planes/cupo.ts`, `packages/db/src/trabajos/registro.ts` (`SQL_REVALIDAR`, solo lectura).
- **Hacer**: `tests/aislamiento/clientes.spec.ts` (catálogo, CHECK, defaults, índice parcial, RLS intacta) y `clientes-funciones.spec.ts` (comportamiento). Cubrir: columnas y CHECK de D1 (régimen, zona, moneda fuera del catálogo, largos de `razon_social`, estado y condición); `contarRucs` y `usoDelEstudio` ignoran archivados; `revalidarEncolado` da `acceso_retirado` con el cliente archivado (también sin `creadoPor`, caso `programado`) y `ok` al reactivarlo; carreras con dos conexiones: dos altas simultáneas con un solo cupo libre dejan activos ≤ máximo; reactivar + crear con un cupo libre; archivar + reactivar + asignar sobre los mismos clientes sin `40P01`; RUC repetido en carrera (un solo ganador). Ajustar con comentario lo existente que dependa del conteo total.
- **Hecho cuando**: `pnpm test:aislamiento` falla solo en lo nuevo y por falta de esquema o de cambios; lo previo sigue verde. Lista de pruebas en el commit. Commit `test(007a): esquema de cliente, cupo de activos, revalidación y carreras (rojo)`.
- **Resultado**: 95 pruebas nuevas en `tests/aislamiento/clientes.spec.ts` (56: columnas y defaults de D1, CHECK de régimen/zona/moneda/estado/condición/razón social, índice parcial, UNIQUE con archivados, RLS y grants de tabla intactos, seed) y `clientes-funciones.spec.ts` (39: `contarRucs`/`usoDelEstudio` solo activos, cupo lleno/archivar/reactivar, `revalidarEncolado` con archivado también `programado`, carreras de dos o más conexiones de crear/reactivar/archivar/asignar sin 40P01, RUC repetido). Rojo: 80 fallan (columna `archivado_at` ausente, CHECK/índice sin crear, conteo y revalidación sin filtrar); las otras 39 son guardas que ya pasan. `test:aislamiento` previo sigue verde (39 archivos). Validadas contra un esquema 0026 provisional en una BD aparte: 95/95 verdes. Ninguna prueba previa dependía del conteo total.

## T2 · Pruebas unitarias, rojo (tester · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (D1, D2, D7; CA-1, CA-4, CA-6), `docs/specs/007a-clientes/plan.md` (Contratos: shared, packages/db), `packages/shared/src/planes/{esquemas,esquemas.spec}.ts` (patrón de zod), `packages/db/src/planes/planes.spec.ts` (patrón de tx falsa).
- **Hacer**: `packages/shared/src/clientes/{ruc,esquemas}.spec.ts` y `packages/db/src/clientes/{repositorio,filtros}.spec.ts`. Cubrir: `validarRuc` con RUC válidos de cada prefijo (10/15/16/17/20), dígito verificador errado, prefijo 11/12/30, longitud 10 y 12, letras, espacios, cadena vacía y entradas no string; esquemas (claves desconocidas descartadas, catálogos, `q` ≤ 100, `responsable=ninguno`); los filtros generan SQL con parámetros (sin el texto del usuario dentro del SQL), escapan `%`, `_` y `\`, y se combinan con `filtroAlcance`; repositorios con tx falsa (orden de llamadas, `archivar` idempotente).
- **Hecho cuando**: las pruebas fallan solo por falta de código. Commit `test(007a): validarRuc, esquemas y repositorios de clientes (rojo)`.
- **Resultado**: 126 pruebas en rojo (shared 92: `ruc.spec` y `esquemas.spec`; db 34: `repositorio.spec` y `filtros.spec`), todas por stubs que lanzan «no implementado» (`shared/src/clientes/{ruc,esquemas}.ts`, `db/src/clientes/{repositorio,errores}.ts`; T6/T7 los reemplazan). Contratos fijados en los comentarios de cada spec: `clienteCrearSchema`, `clienteEditarSchema`, `perfilFiscalSchema`, `filtrosClientesSchema`; `crearCliente(tx, tenantId, datos)`, `editarCliente/archivarCliente/reactivarCliente/leerClienteDto(tx, id…)`, `listarClientesFiltrado(tx, alcance, filtros)` en `repositorio.ts`. `tsc` y `eslint` limpios.

## T3 · Pruebas de integración HTTP, rojo (tester · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (D3–D7; CA-1 a CA-7), `docs/specs/007a-clientes/plan.md` (Contratos: HTTP; Decisiones), `apps/backend/test/{soporte,soporte-acceso,soporte-cupo}.ts`, `apps/backend/src/modules/clientes/clientes.int.spec.ts` y `apps/backend/src/modules/planes/cupo-rucs.int.spec.ts` (patrones).
- **Hacer**: `apps/backend/src/modules/clientes/clientes-crud.int.spec.ts`, `clientes-archivado.int.spec.ts`, `clientes-filtros.int.spec.ts`. Cubrir: CA-1 (400 por RUC, 201, razón social provisional, `responsableId` válido e inválido); CA-2 (cupo lleno al crear y reactivar sin escribir nada, archivar libera, `/plan/uso` solo activos, `ruc_duplicado` también contra un archivado); CA-3 (asistente 15 de 120: listado, búsqueda y URL ajena con el mismo 404 en `GET`, `PATCH`, `archivar` y `reactivar`; inexistente y no-uuid también 404); CA-4; CA-5 (409 `cliente_archivado` en `PATCH` y asignar, oculto del listado salvo `archivados=1`, credenciales intactas); CA-6 (cada filtro y combinaciones, alcance, `q` con comodines); CA-7 (carreras HTTP sin 500). Permisos: sin `clientes.crear`/`editar`/`archivar` → 403; `lectura` no escribe.
- **Hecho cuando**: las pruebas fallan solo por falta de rutas o de lógica. Commit `test(007a): rutas de clientes, cupo, alcance y archivado (rojo)`.
- **Resultado**: [x] 140 pruebas en `clientes-{crud,archivado,filtros}.int.spec.ts` + `apps/backend/test/soporte-clientes.ts` (RUC válidos, siembra por SQL, credenciales sintéticas). 133 en rojo por falta de rutas/filtros/DTO; 7 verdes son guardas de lo ya hecho (404 uniforme del GET, asignar a archivado 409, lista de `lectura`, orden, parámetros desconocidos, NUL en `q`, Admin = Dueño). Decisiones de prueba (T9 puede objetarlas): `archivados=1` añade archivados a los activos; `responsableId` no asignable = 409 `miembro_no_asignable` y de otro estudio/inexistente = 404 `no_encontrado` (como 005); PATCH/archivar/reactivar de un rol sin permiso dan 403 antes del 404 (solo Dueño/Admin tienen esos permisos y son de alcance global, así que el 404 uniforme de esas rutas se prueba con ellos).

## T4 · Pruebas del frontend y de lint, rojo (tester · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (D2, D8; CA-8, CA-9), `docs/specs/007a-clientes/plan.md` (Contratos: shared, HTTP), `apps/frontend/app/(app)/clientes/{page,[clienteId]/page}.spec.tsx` y `apps/frontend/app/(app)/usuarios/page.spec.tsx` (patrones), `tests/limites/auth-lint.spec.ts` (patrón de la regla `sql-crudo`).
- **Hacer**: pruebas del listado (los cuatro filtros llaman a la API con los parámetros de D7; acciones según permiso), del alta (error de RUC en línea con `validarRuc`, 409 `cupo_rucs` con el uso del plan, 409 `ruc_duplicado`), del detalle (datos fiscales: carga, edición, 400 del catálogo; archivar y reactivar con confirmación; archivado en solo lectura) en `apps/frontend/app/(app)/clientes/**`; y en `tests/limites/` el caso de lint: `import * as d from "drizzle-orm"` con `d.sql(...)` falla en `apps/backend`, sin romper lo permitido en `packages/db`.
- **Hecho cuando**: fallan solo por falta de pantallas y de regla. Commit `test(007a): pantallas de clientes y lint de sql (rojo)`.
- **Resultado**: 52 pruebas frontend en `clientes/{listado,[clienteId]/fiscal,nuevo/page}.spec.tsx` (32 en rojo por falta de pantallas; el stub `nuevo/page.tsx` solo compila) + `apps/frontend/pruebas/clientes.ts` (contrato de textos) + 12 de lint en `tests/limites/sql-namespace-lint.spec.ts` (5 en rojo; el resto guarda lo permitido). Las dos specs previas de `/clientes` siguen verdes.

## T5 · Migración y conteo de activos (backend · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/plan.md` (Archivos; Contratos: BD), `packages/db/src/schema/clientes.ts`, `packages/db/src/planes/{cupo,uso}.ts`, `packages/db/migrations/0023_planes_rls.sql` (solo el estilo), `tests/aislamiento/clientes.spec.ts`.
- **Hacer**: ampliar `cliente` en el esquema drizzle; `drizzle-kit generate` → `0026_clientes_perfil.sql` (CHECK, defaults, índice parcial); `contarRucs` y `usoDelEstudio` cuentan `archivado_at IS NULL`.
- **Hecho cuando**: `pnpm db:migrate` dos veces sin error; las partes de T1 sobre esquema y conteo en verde; `pnpm --filter @contapp/db test` verde. Commit `feat(007a): migración 0026 y conteo de RUCs activos`.
- **Resultado**: `0026_clientes_perfil.sql` (drizzle-kit; columnas, 6 CHECK, índice parcial `cliente_tenant_activos_idx`) + esquema `cliente` ampliado; `contarRucs` y `usoDelEstudio` cuentan `archivado_at IS NULL`. `db:migrate` x2 OK. `test:aislamiento`: todo verde salvo 7 de `revalidarEncolado` (T8); `@contapp/db test`: quedan en rojo solo `clientes/{filtros,repositorio}.spec.ts` (stubs de T7).

## T6 · `shared/clientes` (backend · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/plan.md` (Contratos: shared), `packages/shared/src/planes/{esquemas,index}.ts` (patrón), `packages/shared/src/index.ts`, `packages/shared/src/clientes/*.spec.ts`.
- **Hacer**: `ruc.ts` (`validarRuc`), `esquemas.ts` (zod y tipos de D1/D7), `index.ts`; exportar desde `packages/shared`.
- **Hecho cuando**: `pnpm --filter @contapp/shared test` y `build` verdes. Commit `feat(007a): validarRuc y esquemas de clientes en shared`.
- **Resultado**: `shared/src/clientes/{ruc,esquemas,index}.ts` reemplazan los stubs; exportado desde `shared/src/index.ts` (incluye `EstadoCredencial`, `PerfilFiscal`, `ClienteDto`, etc.). `pnpm --filter @contapp/shared test` 554/554 y `build` OK, eslint limpio.

## T7 · Repositorios de clientes (backend · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (D1, D4, D5, D7), `docs/specs/007a-clientes/plan.md` (Contratos: packages/db; Decisiones), `packages/db/src/acceso/{clientes,alcance,errores}.ts`, `packages/db/src/index.ts`, `packages/db/src/clientes/*.spec.ts`.
- **Hacer**: `repositorio.ts`, `filtros.ts`, `errores.ts` (`RucDuplicadoError`, `ClienteArchivadoError`); SQL estático con parámetros (`ILIKE … ESCAPE`); `listarClientesFiltrado` con `filtroAlcance`; exportar desde `src/index.ts`. Sin `sql` fuera de `packages/db`.
- **Hecho cuando**: `pnpm --filter @contapp/db test` verde (T2) y las partes de T1 sobre listado y repos. Commit `feat(007a): repositorios de clientes con filtros`.
- **Resultado**: `clientes/{repositorio,filtros,errores}.ts` reemplazan los stubs y se exportan desde `src/index.ts`. `crearCliente` devuelve el id; `editarCliente` devuelve false si no existe y lanza `ClienteArchivadoError` si está archivado (UPDATE con `archivado_at is null`); archivar/reactivar idempotentes. `q`: prefijo de RUC siempre; fragmento de razón social solo si `q` tiene una letra o son solo dígitos (lo exige `filtros.spec` con `50%_\`). `@contapp/db` test 623/623, tsc y eslint limpios; humo contra PG real OK (alta, duplicado, edición, filtros, archivar/reactivar, alcance).

## T8 · Revalidación de 008 y asignar archivados (backend · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (D5; CA-5), `packages/db/src/trabajos/registro.ts` (`SQL_REVALIDAR`, `revalidarEncolado`), `packages/queue/src/despachador.ts` (líneas del descarte `acceso_retirado`), `packages/queue/src/soporte-pruebas/bd-falsa.ts`, `packages/db/src/acceso/asignaciones.ts`, `apps/backend/src/modules/clientes/asignaciones.service.ts`.
- **Hacer**: agregar `c.archivado_at is null` a `SQL_REVALIDAR`; ajustar `bd-falsa` si imita la revalidación; asignar sobre un archivado → `ClienteArchivadoError` (409 `cliente_archivado`) después de bloquear miembros.
- **Hecho cuando**: las partes de T1 sobre revalidación en verde; `pnpm --filter @contapp/queue test` y `@contapp/db test` verdes; las pruebas de 008 y 005 de asignación siguen verdes. Commit `feat(007a): el despacho y la asignación excluyen clientes archivados`.

## T9 · Servicio y controlador de clientes (backend · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (D3–D7; CA-1 a CA-7), `docs/specs/007a-clientes/plan.md` (Contratos: HTTP; Decisiones), `apps/backend/src/modules/clientes/{clientes.controller,clientes.module,asignaciones.service,contexto}.ts`, `apps/backend/src/modules/planes/cupo/cupo-rucs.ts`, `apps/backend/src/modules/acceso/{errores.ts,guards/cliente-scope.guard.ts}`, `apps/backend/test/auditoria-rutas.ts`.
- **Hacer**: `clientes.service.ts` (crear con `bloquearMiembros` → `reservar` → insertar → asignar responsable; reactivar igual; editar, archivar), rutas de `plan.md` con `@Permiso` y `ClienteScopeGuard` en las de `:clienteId`; mapeo de errores a 409 `cupo_rucs`, `ruc_duplicado`, `cliente_archivado`, `sin_plan`; el listado y el detalle usan los repos de T7; registrar las rutas en la auditoría.
- **Hecho cuando**: `pnpm --filter @contapp/backend test` y `test:int` de clientes y planes verdes (T3, CA-1 a CA-7); la auditoría de rutas verde; sin 500 en las carreras. Commit `feat(007a): API de clientes con cupo, alcance y archivado`.

## T10 · Regla de lint (backend · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (D8; CA-8), `eslint.config.mjs` (regla `sql-crudo/sin-sql-crudo`, modo «fuera»), `tests/limites/auth-lint.spec.ts`.
- **Hacer**: rechazar fuera de `packages/db` el `import * as d from "drizzle-orm"` y el uso de `d.sql` (reportar el especificador de espacio de nombres o el acceso `.sql`); mantener `.raw`, `.unsafe` y `set_config` prohibidos y el permiso dentro de `packages/db`.
- **Hecho cuando**: la prueba de T4 en verde; `pnpm lint` sin hallazgos nuevos en el repo. Commit `feat(007a): lint rechaza import * de drizzle-orm con sql`.
- **Resultado**: [x] `eslint.config.mjs` (`reglaSqlCrudo`, modo «fuera»): reporta `d.sql`, `d["sql"]` y `const { sql } = d` cuando `d` es `import * as` de `drizzle-orm*`. `sql-namespace-lint.spec.ts` 12/12, `tests/limites` 287/287, `pnpm lint` 9/9 verde.

## T11a · Frontend: listado con filtros (frontend · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (D7, D10; CA-9), `docs/specs/007a-clientes/plan.md` (Contratos: shared, HTTP), `apps/frontend/app/(app)/clientes/page.tsx` y su spec, `apps/frontend/lib/{api,acceso,planes}.ts`, `apps/frontend/components/uso-plan.tsx`.
- **Hacer**: `lib/clientes.ts` (llamadas y tipos desde `@contapp/shared`); `components/filtros-clientes.tsx` (responsable, estado de credencial, archivados, búsqueda); listado con filtros, estado de credenciales (solo texto de estado) y acciones según permiso. Conserva la asignación masiva de 005. Solo depende de `packages/shared`.
- **Hecho cuando**: las pruebas del listado (T4) en verde; `pnpm --filter @contapp/frontend test`, `lint` y `typecheck` verdes. Commit `feat(007a): listado de clientes con filtros`.
- **Resultado**: `lib/clientes.ts` (listar/obtener/crear/editar/archivar/reactivar, `ETIQUETA_ESTADO`), `components/filtros-clientes.tsx` y listado con filtros, credenciales y acciones; `clientes/listado.spec.tsx` 8/8 verde, `lint` y `typecheck` limpios. Pendiente para el tester: `clientes/page.spec.tsx` (005) tiene 2 aserciones que contradicen D7 (`queryAllByRole("combobox")` y `getAllByRole("checkbox")` con 3 sin permiso de asignar: ahora hay filtros y «Mostrar archivados»); ajustarlas con comentario. Las otras 24 rojas son de T11b.
- **Ajuste del tester (T11a)**: `clientes/page.spec.tsx` (005) acota sus 2 aserciones a la tabla y a los selects «Usuario»/«Tipo»/«Responsable anterior» (D7: los filtros agregan selects y «Mostrar archivados»); fixtures `responsable` alineadas a `ClienteDto` de shared (`{id, nombre}`) en `pruebas/clientes.ts`, `page.spec.tsx` y `listado.spec.tsx`; ninguna aserción usaba `usuarioId` de `responsable`. Frontend: 223 verdes, 24 rojas (T11b), tsc y lint limpios.

## T11b · Frontend: alta, detalle y archivado (frontend · haiku)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (D1, D2; CA-1, CA-4, CA-9), `docs/specs/007a-clientes/plan.md` (Contratos: shared, HTTP), `apps/frontend/app/(app)/clientes/[clienteId]/page.tsx` y su spec, `apps/frontend/lib/clientes.ts`, `apps/frontend/components/uso-plan.tsx`.
- **Hacer**: `clientes/nuevo/page.tsx` (RUC con error en línea por `validarRuc`, razón social opcional, responsable, datos fiscales); `components/datos-fiscales.tsx`; detalle con datos fiscales editables, archivar/reactivar con confirmación, solo lectura si está archivado, mensajes de 409 (`cupo_rucs` con el uso del plan, `ruc_duplicado`).
- **Hecho cuando**: pruebas de T4 en verde; `pnpm --filter @contapp/frontend test`, `lint` y `typecheck` verdes. Commit `feat(007a): alta, datos fiscales y archivado de clientes`.

## T12 · Verificar CA-1 a CA-9 (tester · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/spec.md` (CA-1 a CA-9), `docs/specs/007a-clientes/tasks.md` (esta lista), `package.json` (scripts `ci:db`, `test`, `lint`).
- **Hacer**: correr `pnpm ci:db`, `pnpm lint`, `pnpm typecheck` y las pruebas del frontend; por cada CA anotar en esta tarea el comando o la prueba que lo demuestra y su resultado; probar a mano contra servicios locales (`pnpm servicios:up`, `db:migrate`, `db:seed`): alta con RUC válido e inválido, cupo lleno, archivar/reactivar, asistente con alcance parcial. No tocar código de producción: un fallo se informa con `archivo:línea`.
- **Hecho cuando**: tabla CA → evidencia completa y todo en verde, o la lista de lo que falta. Commit `test(007a): verificación de CA-1 a CA-9` (solo si se agregan pruebas).

## T13 · Revisión contra la spec (arquitecto · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/{spec,plan}.md`, la tabla de evidencia de T12, `git diff origin/main...HEAD --stat` y los archivos del plan que importen para D4 y D5 (`apps/backend/src/modules/clientes/clientes.service.ts`, `packages/db/src/clientes/repositorio.ts`, `packages/db/src/trabajos/registro.ts`).
- **Hacer**: verificar cada CA con la evidencia (prueba o comando), que se respeta el orden de bloqueo, que ninguna ruta devuelve secretos ni filtra existencia, y que lo de 007b no se coló. Listar lo que falte; las ambigüedades de producto se devuelven como pregunta al orquestador.
- **Hecho cuando**: dictamen «aprobada» o lista de defectos; si hay defectos, el orquestador añade tareas T13a (pruebas en rojo) y T13b (corrección) con el precedente de 006 T15a/T15b. Commit `docs(007a): revisión contra la spec`.

## T14 · Cierre (devops · haiku)

- **Contexto (leer solo esto)**: `docs/specs/007a-clientes/tasks.md`, `git status`.
- **Hacer**: marcar `[x]` en esta tabla, poner `Estado: hecha` en `spec.md`, commit final y avisar al orquestador, que actualiza `ESTADO.md` (007a hecha; 007b pasa a planificar). Sin `git add -A`.
- **Hecho cuando**: árbol limpio salvo cambios ajenos y `tasks.md` al día. Commit `docs(007a): tareas hechas y spec cerrada`.
