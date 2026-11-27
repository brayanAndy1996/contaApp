# Tareas 031 · Consulta de auditoría con filtros e historial por cliente

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` en paralelo con las indicadas (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel B con ADV acotado (D-8). Flujo 04 §1.3: pruebas (rojo) → implementar (verde) → 1 ronda adversarial → corregir → verificar (revisión de Sonnet contra la spec, DoD B) → cerrar. CA, D y P = `spec.md`; contratos = `plan.md`. Rama `spec/031-auditoria-consulta` sobre 030. Migración 0088 (T5); 0089 solo en T10 si hace falta SQL.

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Pruebas de BD: función nueva, filtros, alcance, dos estudios, índices, escala (rojo) | tester | sonnet | — ∥ T2, T3, T4 | ✓ | — | [ ] |
| T2 | Pruebas puras de `shared`: zod de consulta y opciones, `rangoLima` (rojo) | tester | sonnet | — ∥ T1, T3, T4 | ✓ | — | [ ] |
| T3 | Pruebas HTTP: `/auditoria` con filtros, `/opciones`, 400/403/404, centinelas (rojo) | tester | sonnet | — ∥ T1, T2, T4 | ✓ | — | [ ] |
| T4 | Pruebas del frontend y E2E `auditoria.e2e.ts` (rojo) | tester | sonnet | — ∥ T1, T2, T3 | ✓ | — | [ ] |
| T5 | Migración 0088, drizzle, `lectura.ts`, `opciones.ts`, inventarios | backend | opus | T1 ∥ T6 | ✓ | — | [x] |
| T6 | `shared`: `consulta.ts` (zod, `rangoLima`) | backend | sonnet | T2 ∥ T5 | ✓ | — | [x] |
| T7 | Backend: lector de consulta, servicio, `/auditoria/opciones` | backend | sonnet | T3, T5, T6 ∥ T8 | ✓ | — | [x] |
| T8 | Pantalla de auditoría con filtros y enlace de la ficha | frontend | sonnet | T4, T6 ∥ T7 | ✓ | — | [x] |
| T9 | Ronda adversarial acotada: alcance en ambas ramas y SQL inalterable (~15 pruebas) | adversario | opus | T7 | — | ✓ | [ ] |
| T10 | Corregir hallazgos de T9 | backend | opus (SQL) / sonnet (servicio) | T9 | — | — | [ ] |
| T11 | Verificar CA-1 a CA-10 con evidencia y revisión contra la spec | tester | sonnet | T10, T8 | — | — | [ ] |
| T12 | Cierre: `tasks.md`, `spec.md`, `cierre.md` y commit (el orquestador actualiza `ESTADO.md`) | devops | haiku | T11 | — | — | [ ] |

Paralelismo: oleada 1 = T1 (`tests/aislamiento/auditoria-consulta*.spec.ts`, `packages/db/src/auditoria/{consulta,opciones}.spec.ts`) ∥ T2 (`packages/shared/src/auditoria/consulta.spec.ts`) ∥ T3 (`apps/backend/src/modules/auditoria/auditoria-consulta.int.spec.ts`, `auditoria.int.spec.ts`, `apps/backend/test/soporte-auditoria.ts`) ∥ T4 (`apps/frontend/**/*.filtros.spec.tsx`, `*.historial.spec.tsx`, `tests/e2e/flujos/auditoria.e2e.ts`). Oleada 2 = T5 (`packages/db/**` sin specs de T1, `escalada.adv.spec.ts`, `catalogo.spec.ts`) ∥ T6 (`packages/shared/src` sin specs). Oleada 3 = T7 (`apps/backend/src/modules/auditoria/` sin specs) ∥ T8 (`apps/frontend` sin specs). El resto en serie.

Escalamientos: T5 nace en `opus` (`SECURITY DEFINER`, alcance dentro de la función, índices; 04 §3.2). T6, T7 y T8 pasan a `opus` si fallan 2 veces; T12 sube a `sonnet` si falla una vez. Ronda 2 solo si T10 corrige un hallazgo media/alta: el orquestador agrega T10a (adversario opus) y T10b.

Reglas comunes:
- **BD propia**: base `contapp_031tN` (N = número de tarea) con el script de entorno que indique el orquestador (no imprimirlo); recrear solo esa base y migrar. **Nunca** `DROP` ni `TRUNCATE` de `contapp` ni `contapp_e2e`. PG 16.
- Un commit por tarea (`test(031)`, `feat(031)`, `fix(031)`, `chore(031)`) con `git add <rutas>` explícitas y el trailer del modelo; sin `stash`, `reset`, `clean` ni push.
- El tester no toca producción; backend y frontend no editan `*.spec.ts`, **salvo** T5, dueño de `escalada.adv.spec.ts` y `catalogo.spec.ts`. Solo T9 escribe `*.adv*.spec.ts` nuevos. Quien rompe una suite existente la ajusta sin quitar aserciones.
- **Migraciones**: solo T5 (0088) y T10 (0089, si hace falta). Si otra tarea necesita SQL, para y lo reporta. Nunca editar una migración aplicada.
- **SQL**: texto fijo; todo valor como `$n`; sin concatenar filtros. Alcance siempre de `alcanceDe(acceso)`.
- **Rendimiento** (CA-9): `*.rendimiento.spec.ts`, razón ¼ contra completo con tiempo de CPU (plan §Decisiones), rondas intercaladas como `medirEscala`, sin topes de reloj; no se sube un tope para que pase.
- Tareas largas con `nohup … > log 2>&1 &`. Reportes: solo fallos (`archivo:línea · mensaje`) o «OK» + conteo; evidencias a `resultados.md`.

## T1 · Pruebas de BD (tester · sonnet · BD 1)
- **Contexto**: `plan.md#contratos` (DB) y `#decisiones`; spec D-1–D-4, D-7, CA-1–CA-5, CA-8, CA-9; `tests/aislamiento/{auditoria-operacion,auditoria-tablas}.spec.ts`, `auditoria-soporte.ts`, `roles-soporte.ts`, `roles.rendimiento.spec.ts`; `packages/db/src/auditoria/lectura.spec.ts`; `packages/domain/tests/ayudas/rendimiento.ts`.
- **Hacer**: `auditoria-consulta.spec.ts` (función: cada filtro y combinación contra consulta de referencia, cursor entre ramas, bordes de ms, `p_global` true/false/null, sin asignaciones, dos estudios, firma de 017 inexistente, grants); `packages/db/src/auditoria/{consulta,opciones}.spec.ts` (`listarAuditoria` con P-5 y P-6, opciones con archivados, inactivos y `q` con `%`/`_`); `auditoria-consulta.rendimiento.spec.ts` (200 000 + 50 000, CA-9, EXPLAIN por filtro).
- **Hecho cuando**: rojo por falta de 0088/exportaciones (no por error de la prueba); suites existentes de auditoría siguen verdes.

## T2 · Pruebas puras de shared (tester · sonnet)
- **Contexto**: `plan.md#contratos` (Shared); spec D-2, CA-2, CA-7; `packages/shared/src/auditoria/{esquemas,acciones}.ts`.
- **Hacer**: `auditoria/consulta.spec.ts`: UUID mal formado, acción fuera del catálogo, 11 acciones, repetidas, `accion` única como lista, fecha inexistente (`2026-02-30`), `desde > hasta`, clave desconocida, comillas y `;`; `rangoLima` (00:00 Lima de `desde`, día siguiente a `hasta`, cambio de mes y año); opciones (`q` 1–60, estricto).
- **Hecho cuando**: rojo por módulo ausente; cada caso de CA-7 tiene su prueba.

## T3 · Pruebas HTTP (tester · sonnet · BD 3)
- **Contexto**: `plan.md#contratos` (HTTP) y `#decisiones`; spec CA-1–CA-8, P-5, P-6; `apps/backend/src/modules/auditoria/auditoria.int.spec.ts`; `apps/backend/test/{auditoria-rutas,soporte-roles,soporte-acceso}.ts`.
- **Hacer**: `auditoria-consulta.int.spec.ts`: filtros solos y combinados con descifrados, cursor con filtros, HU-39 (CA-3), rol propio asignado con y sin filtros (404 de no asignado, vacío sin asignaciones), Dueño y Administrador ven todo, tabla 403 con y sin `auditoria.ver` en ambos endpoints, 400 de CA-7 sin tocar la BD, centinelas en respuestas y logs, `/opciones`. Ajustar en `auditoria.int.spec.ts` la prueba de consulta estricta (`usuarioId`/`clienteId` no UUID → 400; `tenantId`, `limite` → 400).
- **Hecho cuando**: rojo por rutas o filtros ausentes; ninguna aserción existente quitada.

## T4 · Pruebas del frontend y E2E (tester · sonnet)
- **Contexto**: `plan.md#decisiones` (Pantalla); spec CA-10, P-1–P-3; `apps/frontend/app/(app)/configuracion/auditoria/page.spec.tsx`, `apps/frontend/app/(app)/clientes/[clienteId]/page.spec.tsx`; `tests/e2e/flujos/notificaciones.e2e.ts`, `tests/e2e/soporte/siembra.ts`.
- **Hacer**: `configuracion/auditoria/page.filtros.spec.tsx` (URL ↔ filtros al recargar, 30 días por defecto y «todo el historial», inactivo marcado, aviso de descifrados con filtro de usuario, vacío/error/404 en español, enlace de `compra.operacion` solo con `compras.ver`); `clientes/[clienteId]/page.historial.spec.tsx` («Ver historial» solo con `auditoria.ver`); `tests/e2e/flujos/auditoria.e2e.ts` (ficha → Ver historial → editar cliente → aparece antes → después).
- **Hecho cuando**: rojo por componentes ausentes; `playwright test --list` lista el flujo y tipa.

## T5 · Migración 0088 y repositorio (backend · opus · BD 5)
- **Contexto**: `plan.md#contratos` (DB) y `#riesgos`; spec D-1, D-3, D-4, D-7; migraciones 0005 y 0041; `packages/db/src/auditoria/lectura.ts`, `acceso/alcance.ts`, `schema/{auditoria,credenciales}.ts`, `acceso/miembros.ts`; pruebas de T1.
- **Hacer**: 0088 (`DROP` de la firma de 017, función nueva con alcance falla cerrado, índices con expresión inmutable), drizzle, `lectura.ts` con filtros y `LIMIT` por rama, `opciones.ts`, exportaciones; firma nueva en `escalada.adv.spec.ts`; `catalogo.spec.ts` sin cambios salvo que aparezca una tabla. EXPLAIN de cada filtro en `resultados.md`.
- **Hecho cuando**: T1 verde en BD 5 recién migrada; `test:aislamiento` y `pnpm --filter @contapp/db test` sin fallas nuevas.

## T6 · Shared (backend · sonnet)
- **Contexto**: `plan.md#contratos` (Shared); spec D-2; pruebas de T2; `packages/shared/src/auditoria/{esquemas,acciones}.ts`, `packages/shared/src/index.ts`.
- **Hacer**: `auditoria/consulta.ts` con `consultaAuditoriaSchema`, `consultaOpcionesAuditoriaSchema`, `opcionesAuditoriaSchema` y `rangoLima`; exportar.
- **Hecho cuando**: `pnpm --filter @contapp/shared test` verde (T2 incluida) y `build` sin errores.

## T7 · Backend (backend · sonnet · BD 7)
- **Contexto**: `plan.md#contratos` (HTTP) y `#decisiones`; spec D-3–D-6; `apps/backend/src/modules/auditoria/auditoria.{controller,service}.ts`, `notificaciones/cursor.ts`, `clientes/contexto.ts`, `acceso/guards/cliente-scope.guard.ts`; pruebas de T3.
- **Hacer**: `auditoria/consulta.ts` (zod de T6 + `decodificarCursor`, 400 antes de `withTenant`); servicio con alcance, `clienteVisible` (404), filtros en página y «siguiente»; `GET /auditoria/opciones` con `@Permiso("auditoria.ver")`.
- **Hecho cuando**: T3 y las suites de `auditoria` y `notificaciones` verdes en BD 7; `typecheck` sin errores.

## T8 · Frontend (frontend · sonnet)
- **Contexto**: `plan.md#decisiones` (Pantalla) y `#contratos` (HTTP); spec CA-10, P-1–P-3; `apps/frontend/app/(app)/configuracion/auditoria/page.tsx`, `apps/frontend/lib/{auditoria,api,acceso,fechas}.ts`, `apps/frontend/app/(app)/clientes/[clienteId]/page.tsx`; pruebas de T4.
- **Hacer**: `components/auditoria/filtros-auditoria.tsx` (usuario, cliente con búsqueda en `/opciones`, acciones del catálogo de `shared`, fechas, «todo el historial»), filtros en la URL, avisos y estados; enlace de `compra.operacion` y «Ver historial».
- **Hecho cuando**: pruebas de T4 (sin la E2E) verdes; `pnpm --filter @contapp/frontend typecheck` y `lint` sin errores.

## T9 · Ronda adversarial acotada (adversario · opus · BD 9)
- **Contexto**: spec D-1, D-3, D-8, CA-4, CA-5, CA-7; `plan.md#contratos`; primero solo la interfaz pública; luego `packages/db/src/auditoria/lectura.ts`, `opciones.ts` y `0088_auditoria_consulta.sql`.
- **Hacer**: ~15 pruebas en `tests/aislamiento/auditoria-consulta.adv.spec.ts` y `apps/backend/src/modules/auditoria/auditoria-consulta.adv.int.spec.ts`: alcance en ambas ramas (asignado, desasignado durante la sesión, sin asignaciones, dos estudios, `clienteId` ajeno), función con `p_global`/`p_usuario` hostiles, y que ningún filtro altere el SQL (comillas, `;`, `%`, arreglos y objetos de `qs`, UUID en mayúsculas).
- **Hecho cuando**: hallazgos con severidad en `resultados.md`; las que pasan quedan como regresión.

## T10 · Corregir (backend · opus si toca SQL o la función, sonnet si solo el servicio · BD 10)
- **Contexto**: hallazgos de T9 en `resultados.md` y sus pruebas; archivos que nombren.
- **Hacer**: hacer pasar los `*.adv*.spec.ts` sin editarlos; 0089 solo si hace falta SQL.
- **Hecho cuando**: T9 verde; T1, T3 y suites de auditoría verdes.

## T11 · Verificar (tester · sonnet · BD 11)
- **Contexto**: spec completa (CA-1–CA-10, P-1–P-6); `plan.md`; `resultados.md`.
- **Hacer**: suites de `db`, `shared`, `backend` (auditoría, notificaciones), `frontend`, `test:aislamiento` y `auditoria.e2e.ts`; anotar evidencia (prueba o comando) por criterio y la escala de CA-9.
- **Hecho cuando**: cada CA con evidencia en `resultados.md`; lo que falte, listado como pendiente.

## T12 · Cierre (devops · haiku)
- **Contexto**: `tasks.md`, `resultados.md`, `docs/specs/_plantilla/cierre.md`.
- **Hacer**: estados `[x]`, spec a «verificada», `cierre.md`, commit `chore(031)`.
- **Hecho cuando**: commit hecho y `git status` limpio en las rutas de 031; la corrida de CI en verde (PR) la gestiona el orquestador.
