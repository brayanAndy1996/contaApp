# Tareas 021 · Reglas aprendidas (R-HIS)

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con las indicadas (no comparten archivos) | `⚠022` toca archivos que también cambia `spec/022-rendimiento` | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A (spec). Flujo 04 §1.3: pruebas primero (rojo) → implementar (verde) → cobertura → atacar (2 rondas) → corregir (con pruebas del tester) → prueba manual → verificar → revisión de Opus → cerrar. Rama `spec/021-reglas-aprendidas`. CA, D y P (decididas el 2026-11-13) = `spec.md`; contratos y decisiones = `plan.md`. Migraciones 0047–0049 (T9) y 0050–0051 (T18, T21).

| #   | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
| --- | ----- | --- | ------ | ---------- | --- | --- | ------ |
| T1  | Pruebas de dominio: `planificarHistorial`, interruptores, P-6, catálogo, RUC aportable (rojo) | tester | sonnet | — ∥ T2, T3 | ✓ | — | [x] |
| T2  | Pruebas de `shared/reglas` y de los cambios en `shared/compras` y auditoría (rojo) | tester | sonnet | — ∥ T1, T3 | ✓ | — | [x] |
| T3  | Pruebas de BD: tablas, RLS, grants, funciones acotadas, aceptaciones, confirmaciones, auditoría, concurrencia (rojo) | tester | sonnet | — ∥ T1, T2 | ✓ | — | [x] |
| T4  | Pruebas del worker: descarga con R-HIS, `resultado`, interruptores en `xml.obtener` (rojo) | tester | sonnet | T2 ∥ T5, T6 | ✓ | — | [x] |
| T5  | Pruebas HTTP: reglas del cliente, motor del estudio, listado y detalle «Según historial», interruptores en aceptar y masiva (rojo) | tester | sonnet | T2 ∥ T4, T6 | ✓ | — | [x] |
| T6  | Pruebas de componentes: aviso «Recordar», pantallas de reglas, etiqueta y filtro (rojo) | tester | sonnet | T2 ∥ T4, T5 | ✓ | — | [x] |
| T7  | Dominio: `r-his.ts`, `catalogo.ts`, `reglasApagadas` y `crearEvaluarCompras` | backend | opus | T1 ∥ T8, T9 | ✓ | — | [x] |
| T8  | `shared`: esquemas, DTOs, códigos, `historial`, filtro y acciones de auditoría | backend | sonnet | T2 ∥ T7, T9 | ✓ | — | [x] |
| T9  | Migraciones 0047–0049, esquema drizzle, `packages/db/src/reglas/` e `insertarCompras` con historial | backend | opus | T3 ∥ T7, T8 | ✓ | — | [x] |
| T10 | Worker: R-HIS en la descarga, `segunHistorial` en el `resultado`, interruptores en `xml.obtener` | backend | sonnet | T4, T7, T9 ∥ T11, T12, T13 | ✓ | — | [x] |
| T11 | Backend: módulo `reglas` (cliente y estudio) | backend | sonnet | T5, T7, T8, T9 ∥ T10, T12, T13 | ✓ | — | [x] |
| T12 | Backend de compras: «Según historial» en listado, filtro y detalle; interruptores en `entornoDeReglas` ⚠022 | backend | sonnet | T5, T7, T8, T9 ∥ T10, T11, T13 | ✓ | — | [x] |
| T13 | Frontend: `lib/reglas.ts`, pantalla de reglas del cliente y reglas del motor | frontend | sonnet | T6, T8 ∥ T9–T12 | ✓ | — | [x] |
| T14 | Frontend: grilla, masiva, filtro, lupa e historial («Según historial» y «Recordar») ⚠022 | frontend | sonnet | T6, T13 y merge de 022 RP-5 | ✓ | — | [x] |
| T15 | Cobertura ≥ 90 %: `domain/reglas`, `db/reglas`, módulo `reglas`, persistidor de compras; en CI | devops | haiku | T10, T11, T12 ∥ T14 | — | — | [x] |
| T16 | Ronda adversarial 1: aislamiento, permisos, funciones acotadas y concurrencia (≤ 15 pruebas) | adversario | opus | T10, T11, T12, T15 ∥ T14 | — | ✓ | [x] |
| T17 | Pruebas de las correcciones de la ronda 1 (rojo) | tester | sonnet | T16 | ✓ | — | [x] |
| T18 | Corregir los hallazgos de la ronda 1 (migración 0050 si hace falta) | backend | opus | T17 | — | — | [x] |
| T19 | Ronda adversarial 2: dinero con R-HIS, aceptaciones y confirmaciones, interruptores, baja lógica (≤ 15 pruebas) | adversario | opus | T18 | — | ✓ | [x] |
| T20 | Pruebas de las correcciones de la ronda 2 (rojo) | tester | sonnet | T19 | ✓ | — | [x] |
| T21 | Corregir los hallazgos de la ronda 2 (migración 0051 si hace falta) | backend | opus | T20 | — | — | [x] |
| T22 | E2E prioridad 1: «Recordar» → descarga siguiente → «Según historial» → revertir | tester | sonnet | T14, T10 ∥ T16–T21 | — | — | [x] |
| T23 | Prueba manual contra el sistema completo | tester | sonnet | T21, T22 | — | — | [x] |
| T24 | Verificar CA-1 a CA-14 con evidencia, suites completas, `db:migrate` ×2 y cobertura | tester | sonnet | T23 | — | — | [x] |
| T25 | Revisión final contra la spec | arquitecto | opus | T24 | — | — | [x] |
| T26 | Cierre: `tasks.md`, `spec.md` y commit (el orquestador actualiza `ESTADO.md`) | devops | haiku | T25 | — | — | [ ] |

Paralelismo: T1 ∥ T2 ∥ T3; luego T4 ∥ T5 ∥ T6 (necesitan los nombres de `shared` de T2). Implementación en tres carriles independientes: T7 (`domain`) ∥ T8 (`shared`) ∥ T9 (`db`). Luego T10 (`apps/worker`) ∥ T11 (`apps/backend/src/modules/reglas`) ∥ T12 (`apps/backend/src/modules/compras` y `db/compras/lectura.ts`). T11 y T12 comparten solo `app.module.ts` (T11 lo toca y T12 no). T13 corre en paralelo con T9–T12 contra el contrato de `shared` (sus pruebas simulan la API). T14 va último en el frontend (ver «Orden frente a 022»). T15 ∥ T14. La ronda 1 (T16) puede empezar con T14 en curso porque ataca BD, backend y worker; las rondas y sus correcciones van en serie (T16 → T18 → T19 → T21). T22 ∥ T16–T21. Si una ronda no deja fallos, se saltan sus dos tareas de corrección (se marcan `[x]` «sin hallazgos»).

Orden frente a 022 (plan, «Cruce con 022»): 021 no toca `despachador.ts`, `existentes.ts`, `exclusion.service.ts` de ventas ni el previo de archivos. Tres tareas pueden chocar:
- **T14 ⚠022** (grilla, masiva, filtros, lupa, `lib/compras.ts`) choca con el Ctrl+Z de la masiva (RP-5). No empieza hasta que RP-5 esté en `main` y el orquestador haya integrado `main` en esta rama (merge, sin rebase de lo publicado). Si 022 se atrasa, T13, T15, T16 y T22 (hasta donde no dependa de T14) avanzan, y T14 espera.
- **T12 ⚠022** (`packages/db/src/compras/lectura.ts`, `apps/backend/src/modules/compras/escritura.ts`): antes de empezar, `git diff main...spec/022-rendimiento --stat -- <esos archivos>`. Vacío: sigue. Con cambios: espera al merge de 022 o se limita a añadir sin mover código ajeno, y lo anota.
- **T10** (`persistidores/compras.ts`): el mismo `git diff` sobre ese archivo; 022 solo cambia `existentes.ts`, que T10 no edita.

Escalamientos: T7 y T9 nacen en `opus` (dinero, RLS, funciones `SECURITY DEFINER`, orden de bloqueo; 04 §3.2). T10, T11 o T12 pasan a `opus` si fallan 2 veces. T15 y T26 pasan a `sonnet` si `haiku` falla una vez. T16 y T19 son `opus` por regla; T18 y T21 en `opus` porque tocan funciones acotadas y dinero. Si T23 encuentra defectos de pantalla se añade T23a (frontend · sonnet); si T25 encuentra defectos, T25a (pruebas en rojo) y T25b (corrección), como en 014 y 016.

Reglas comunes:

- Un commit por tarea (Conventional Commits `test(021): …`, `feat(021): …`, `fix(021): …`, `chore(021): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push del subagente: el orquestador lo hace.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` ajenos: `git add <rutas>` explícitas, nunca `-A` ni `.`. Nunca leer ni imprimir `.env`. Sin `reset`, `stash` ni `clean`.
- Ningún log, error ni `resultado` con montos, razón social ni RUC (D-10). Las pruebas usan canarios en razón social, número de documento y montos, y los buscan en respuestas de error, logs, `resultado` y `auditoria.datos`.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo. Correr solo las pruebas del paquete afectado; las suites completas, en T24.
- El tester no toca código de producción; backend y frontend no editan `*.spec.ts` ajenos; solo T16 y T19 escriben `*.adv.spec.ts` / `*.adv.int.spec.ts`. Las pruebas de las correcciones las escribe el tester, no quien corrige.
- Migraciones: 021 usa **0047–0049** y, si hacen falta, **0050–0051**; confirmar con `ls packages/db/migrations` y el diario antes de crear; nunca editar una aplicada. 0052–0054 son de 022. Las pruebas de 002–020 siguen en verde.
- Montos: `Money` / cadenas decimales; ningún `number` para dinero. Toda consulta de negocio dentro de `withTenant()`; nunca desactivar RLS. `apps/backend` no escribe versiones `historial` ni importa `@contapp/sunat`. Sin dependencias nuevas.
- Una ambigüedad nueva que cambie la spec no se decide: `requiere usuario` y se informa al orquestador.

## T1 · [ ] Pruebas de dominio, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-7, P-3, P-5, P-6, P-8, P-10; CA-2, CA-4, CA-8, CA-11, CA-12), `plan.md` (Contratos: Dominio; Decisiones técnicas), `packages/domain/src/reglas/{tipos,motor,r-new}.ts`, `packages/domain/src/comprobante/cambiar-destino.ts`, `packages/domain/src/compras/evaluar.ts` (`crearEvaluarCompras`), `packages/domain/src/reglas/r-new.spec.ts` (modelo de fixtures).
- **Hacer**: `packages/domain/src/reglas/{r-his,catalogo,interruptores}.spec.ts` y `compras/evaluar-reglas.spec.ts`. `planificarHistorial`: proveedor con regla DNG → montos de `cambiarDestino` (fixture de 01 §7 regla 3); documento normalizado (espacios, minúsculas); otro proveedor, BI total 0, destino ya igual o sin reglas → nada; nota de crédito negativa; USD con tipo de cambio; mezcla DG + DGNG consolidada; R-HIS apagado → nada. `evaluarReglas` con `reglasApagadas`: cada código de 011 apagado no sale y los demás sí; entrada con un código desconocido → `EntradaReglasInvalidaError`. P-6 (CA-11): fila con R-ISC 770.00 (San Juan) y con la mixta 21.48/1.61 movidas por R-HIS a DG: los hallazgos sobre la versión movida y `aplicarSugerencia` dan los mismos montos que la fila clasificada a mano en DG. `crearEvaluarCompras` con `proveedoresConRegla` → sin R-NEW. `CATALOGO_REGLAS_MOTOR`: seis códigos, descripción no vacía, sin «prevalidación». `esRucAportable`: `6`/20… sí; `6`/10…, `1`/DNI, `0` no.
- **Hecho cuando**: compilan contra las firmas del plan y fallan por «no implementado»; las demás de `domain` siguen verdes. Commit `test(021): dominio de reglas aprendidas en rojo`.

## T2 · [ ] Pruebas de `shared`, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP), `packages/shared/src/compras/{respuestas,filtros}.ts`, `packages/shared/src/auditoria/acciones.ts`, `packages/shared/src/xml/detalle.ts` (forma del detalle).
- **Hacer**: `packages/shared/src/reglas/*.spec.ts`: `reglaVistaSchema` (destino DG|DGNG|DNG, `version` ≥ 1, `aplicada`/`aceptada` enteros ≥ 0, sin campos de RUC fuera de `proveedor`), `recordarReglaSchema` (`compraIds` 1..5000 únicos, `versionBase` entero o `null`), `editarReglaSchema` (al menos uno de `destino`/`activa`), `reglasMotorSchema`, códigos `regla_cambiada`, `proveedores_distintos`. En `shared/compras`: `historial` en `ACCIONES_VERSION`; `segunHistorial` en la fila y el detalle (`{reglaId: uuid} | null`); filtro `segunHistorial`. Acciones de auditoría nuevas de `plan.md` (BD).
- **Hecho cuando**: fallan por «no implementado»; las de `shared` existentes siguen verdes. Commit `test(021): esquemas de reglas en rojo`.

## T3 · [ ] Pruebas de BD, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-2, D-3, D-5 a D-8, P-1, P-4, P-5, P-9, P-10; CA-4 a CA-7, CA-9, CA-10, CA-13), `plan.md` (Contratos: BD, orden de bloqueo, packages/db), `packages/db/migrations/0038_compra_worker_sin_update.sql` (patrón de función acotada), `tests/aislamiento/compras-soporte.ts`, `tests/aislamiento/compras-xml-tablas.spec.ts` (modelo; no repetir), `tests/aislamiento/auditoria-soporte.ts`.
- **Hacer**: `tests/aislamiento/reglas-{tablas,funciones,revisado,concurrencia}.spec.ts` y `packages/db/src/reglas/*.spec.ts`. Catálogo: RLS `FORCE`, grants del plan (sin `DELETE`; el worker sin escritura directa sobre `regla_*`; nadie de la app lee `regla_confirmacion`), única parcial con baja lógica (eliminar y volver a crear funciona). Aislamiento (CA-5, CA-6): dos estudios y dos clientes con el mismo RUC; sin `withTenant` no se ve nada. Funciones (CA-10): `aplicar_regla_historial` rechaza con 42501 compra no creada en la transacción, `n ≠ 2`, compra con versión 2, regla de otro cliente o proveedor, inactiva, eliminada, `periodo_aprendido` ≥ periodo (P-5), R-HIS apagado y `p_datos` que no son la consolidación; el worker sigue sin `UPDATE` en `compra`; el backend no puede insertar `accion = historial`. `reglas_historial_vigentes` filtra por cliente, periodo y estado. Revisado (P-1, P-4, P-10): al pasar a `revisado`, aceptaciones de las filas que siguen en el destino y no de las corregidas; confirmación solo RUC 20 con aporte encendido; reabrir y volver a revisar no duplica. `recordarRegla`: crea, actualiza con versión, 409 con versión vieja, reactiva una inactiva, confirmación `recordar`. Auditoría de cada acción y `compra.historial` con actor `sistema` y sin RUC. Concurrencia (CA-9): dos `recordarRegla` simultáneos → una regla y un `regla_cambiada`; PATCH durante la descarga en 10 rondas → todas las filas con el mismo destino y sin interbloqueos.
- **Hecho cuando**: fallan por «no implementado» (tablas o funciones ausentes); las de 002–020 siguen verdes. Commit `test(021): BD de reglas aprendidas en rojo`.

## T4 · [ ] Pruebas del worker, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-1, D-7, D-10; CA-2, CA-4, CA-9, CA-13), `plan.md` (Contratos: Worker, packages/db), `apps/worker/src/trabajos/persistidores/persistidor-compras.int.spec.ts` (modelo y arnés), `apps/worker/src/trabajos/procesadores/descargar-propuesta.ts` (`ResultadoDescarga`), `apps/worker/src/trabajos/procesadores/obtener-xml.ts` (líneas 230–260).
- **Hacer**: `apps/worker/src/trabajos/persistidores/persistidor-reglas.int.spec.ts` y `procesadores/obtener-xml-interruptores.int.spec.ts`. CA-2: regla DNG del proveedor X aprendida en 202609; la descarga de 202610 deja sus compras con versión 2 `historial`, destino DNG, `regla_aplicacion` y la versión 1 idéntica a la propuesta (comparación por columnas y `md5` de la fila). CA-4: cada exclusión de la lista (inactiva, eliminada, R-HIS apagado, BI 0, destino igual, periodo 202609 o anterior, descarga repetida que no trae filas nuevas). `resultado.segunHistorial` con el conteo y sin canarios (CA-13). Versión 2 evaluada sin R-NEW. Interruptores: R-MIX apagado → `xml.obtener` no guarda R-MIX.
- **Hecho cuando**: fallan por «no implementado»; las del worker siguen verdes. Commit `test(021): R-HIS en la descarga en rojo`.

## T5 · [ ] Pruebas HTTP, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-5, D-9, P-2, P-3, P-7, P-8, P-9; CA-1, CA-3, CA-5 a CA-9, CA-12, CA-13), `plan.md` (Contratos: HTTP, Backend), `apps/backend/src/modules/compras/detalle.int.spec.ts` y `masivas.int.spec.ts` (modelo de arnés), `apps/backend/test/` (sembrado de compras y sesiones).
- **Hacer**: `apps/backend/src/modules/reglas/{reglas-cliente,reglas-motor}.int.spec.ts` y `apps/backend/src/modules/compras/historial.int.spec.ts`. Rutas del plan con 200/403/404/409/422: sin `reglas.gestionar` → 403 en escrituras (CA-1); cliente o regla de otro estudio o no visible → 404 idéntico al inexistente (CA-5); `recordar` con proveedores mezclados → 422 (P-2), sin crear versiones (D-5); `versionBase` vieja → 409 (CA-9); `DELETE` deja de listarla y la siguiente descarga no la aplica (P-9); `GET` con `aplicada`/`aceptada`; interruptor sin rol global → 403, código de prevalidación → 404. Compras: `segunHistorial` en listado y detalle; filtro; clasificar de nuevo una fila «Según historial» (una y masiva por el filtro) quita la etiqueta y el resumen ve el destino nuevo (CA-3); tras corregir, aceptar y masiva no traen R-HIS (CA-12); con R-GP apagado, aceptar y masiva no lo ven (CA-8). Errores sin canarios.
- **Hecho cuando**: fallan por «no implementado» (404 de ruta o campo ausente); las del backend siguen verdes. Commit `test(021): rutas de reglas en rojo`.

## T6 · [ ] Pruebas de componentes, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1, CA-3, CA-7, CA-8, P-2, P-3), `plan.md` (Contratos: Frontend), `apps/frontend/components/compras/foco-grilla.ts` (atajos existentes), `apps/frontend/components/compras/barra-masiva.spec.tsx` y `lupa-compra.spec.tsx` (modelo de simulación de la API).
- **Hacer**: `apps/frontend/components/reglas/{recordar-proveedor,tabla-reglas-cliente,reglas-motor}.spec.tsx` y `components/compras/{grilla-compras,barra-masiva,lupa-compra}.historial.spec.tsx` (archivos nuevos: no editar los `*.spec.tsx` existentes). El aviso no toma el foco, se acepta con el atajo y el foco sigue en la celda (CA-1); no aparece sin `reglas.gestionar` ni si ya hay regla con ese destino; en masiva solo con un proveedor (P-2); tras corregir una fila «Según historial» se ofrece con el destino nuevo (P-3). Etiqueta «Según historial» como texto y filtro. Pantalla del cliente: columnas de CA-7, editar, desactivar, activar y eliminar con confirmación y 409 con mensaje. Motor: seis interruptores, sin prevalidación, deshabilitados sin rol global, interruptor del aporte.
- **Hecho cuando**: fallan por componente ausente; las del frontend siguen verdes. Commit `test(021): pantallas de reglas en rojo`.

## T7 · [ ] Dominio (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: Dominio; Decisiones técnicas), pruebas de T1, `packages/domain/src/reglas/{tipos,motor,entrada,r-new,index}.ts`, `packages/domain/src/comprobante/cambiar-destino.ts`, `packages/domain/src/compras/evaluar.ts`, `packages/domain/src/index.ts`.
- **Hacer**: `reglas/r-his.ts` (`planificarHistorial`), `reglas/catalogo.ts` (`CATALOGO_REGLAS_MOTOR`, `CodigoReglaMotor`, `esRucAportable`), `reglasApagadas?` en `ContextoReglas` validado en `entrada.ts` y aplicado en `motor.ts`, `OpcionesEvaluar` con `reglasApagadas` y `proveedoresConRegla`. Exportar por la lista cerrada de `index.ts`. Sin IO, sin `number` para dinero.
- **Hecho cuando**: las de T1 y todas las de `domain` pasan; typecheck y lint limpios. Commit `feat(021): R-HIS e interruptores en el dominio`.

## T8 · [ ] `shared` (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP), pruebas de T2, `packages/shared/src/compras/{respuestas,filtros,index}.ts`, `packages/shared/src/auditoria/acciones.ts`, `packages/shared/src/index.ts`.
- **Hacer**: `packages/shared/src/reglas/` (esquemas, respuestas, errores, index); `historial` en `ACCIONES_VERSION`; `segunHistorial` en fila, detalle y filtro; acciones de auditoría nuevas.
- **Hecho cuando**: las de T2 y todas las de `shared` pasan; `build` de `shared` y typecheck de los consumidores limpios (un `switch` exhaustivo que falle por `historial` se anota para T12/T14, no se arregla aquí). Commit `feat(021): contratos de reglas en shared`.

## T9 · [ ] Migraciones y `packages/db` (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: BD, orden de bloqueo, packages/db; Riesgos), pruebas de T3, `packages/db/migrations/0038_compra_worker_sin_update.sql`, `0042_auditoria_capturas.sql` (una función de captura y su trigger, p. ej. `xml.subido`), `0045_auditoria_ronda_r1.sql` (CHECK de acciones), `0046_notificacion_ms_validada.sql` (cabecera), `meta/_journal.json` (última entrada), `packages/db/src/schema/{compras,xml,index}.ts`, `packages/db/src/compras/{versiones,repositorio}.ts` (`insertarCompras`, `insertarVersiones`, `evaluarYGuardar`), `packages/db/src/xml/documentos.ts` (modelo de repositorio).
- **Hacer**: 0047–0049 según el plan (repetibles: `CREATE OR REPLACE`, `DROP … IF EXISTS`, `GRANT`/`REVOKE`; DDL de drizzle para las tablas), entradas 47–49 del diario y snapshots, `schema/reglas.ts`, `src/reglas/*.ts` e `insertarCompras` con `historial` opcional (sin él, idéntico a hoy). No tocar `compras/existentes.ts` (022).
- **Hecho cuando**: `pnpm db:migrate` dos veces en verde; las de T3 pasan (`pnpm test:aislamiento -- tests/aislamiento/reglas-*` y `pnpm --filter @contapp/db test`); las de 002–020 siguen verdes; typecheck y lint limpios. Commit `feat(021): tablas, funciones acotadas y repositorio de reglas`.

## T10 · [ ] Worker (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: Worker), pruebas de T4, `apps/worker/src/trabajos/persistidores/{compras,compras-evaluar,tipos}.ts`, `apps/worker/src/trabajos/procesadores/descargar-propuesta.ts`, `apps/worker/src/trabajos/procesadores/obtener-xml.ts` (líneas 230–260), exports de `packages/db/src/reglas/index.ts`.
- **Hacer**: antes, `git diff main...spec/022-rendimiento --stat -- apps/worker/src/trabajos/persistidores/compras.ts` (vacío: sigue; si no, avisar). `insertar` lee reglas e interruptores en la transacción, arma `historial` con `planificarHistorial` y devuelve el conteo; `ResultadoDescarga.segunHistorial` (opcional, ventas no lo informa); `crearEvaluarCompras` del worker con `reglasApagadas` y `proveedoresConRegla`; `obtener-xml.ts` lee los interruptores. Medir la descarga de 5.000 compras con y sin reglas y anotarlo (plan, Riesgos: Volumen).
- **Hecho cuando**: las de T4 y todas las del worker pasan (`pnpm --filter @contapp/worker test` y `test:int`); typecheck y lint limpios. Commit `feat(021): R-HIS al cargar compras`.

## T11 · [ ] Backend: módulo `reglas` (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP), pruebas de T5 (`modules/reglas/`), `apps/backend/src/modules/compras/{compras.controller,compras.service,errores,apoyo}.ts` (guard, `exigirCliente`, mapeo de errores), `apps/backend/src/modules/estudio/estudio.controller.ts` (rol de alcance global), `apps/backend/src/app.module.ts`.
- **Hacer**: `apps/backend/src/modules/reglas/` con las rutas del plan; validación con `shared`; `Cache-Control: no-store`; 404 uniforme; escrituras en `withTenant`, con el advisory exclusivo del interruptor. Registrar el módulo.
- **Hecho cuando**: las de T5 de `modules/reglas/` pasan; las del backend siguen verdes; typecheck y lint limpios. Commit `feat(021): rutas de reglas del cliente y del estudio`.

## T12 · [ ] Backend de compras: «Según historial» e interruptores ⚠022 (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP y Backend; «Cruce con 022»), pruebas de T5 (`modules/compras/historial.int.spec.ts`), `packages/db/src/compras/lectura.ts` (listado, filtros y `leerDetalleCompra`), `apps/backend/src/modules/compras/{escritura,vistas,detalle}.ts`.
- **Hacer**: antes, `git diff main...spec/022-rendimiento --stat -- packages/db/src/compras/lectura.ts apps/backend/src/modules/compras/escritura.ts` (con cambios: avisar al orquestador y añadir sin mover código ajeno). `segunHistorial` y filtro en el listado (join con `regla_aplicacion` sobre la versión vigente) y en el detalle; `entornoDeReglas` lee los interruptores y no pasa reglas aprendidas (P-3).
- **Hecho cuando**: las de T5 de `modules/compras/` pasan; las de 014–016 siguen verdes, incluido el tiempo de CA-15 de `lectura.int.spec.ts`; typecheck y lint limpios. Commit `feat(021): según historial en el listado y la lupa`.

## T13 · [ ] Frontend: pantallas de reglas (frontend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP, Frontend), pruebas de T6 (`components/reglas/`), `apps/frontend/lib/api.ts`, `apps/frontend/lib/compras.ts` (patrón de llamadas, sin editarlo), `apps/frontend/app/(app)/configuracion/auditoria/page.tsx` (modelo de página), `apps/frontend/app/(app)/clientes/[clienteId]/page.tsx`, `apps/frontend/lib/auditoria.ts`.
- **Hacer**: `lib/reglas.ts`, `components/reglas/{tabla-reglas-cliente,reglas-motor,recordar-proveedor}.tsx`, las dos páginas, el enlace en la ficha del cliente y los textos de las acciones de auditoría nuevas en `lib/auditoria.ts`. Mensajes de 409/422 en español.
- **Hecho cuando**: las de T6 de `components/reglas/` pasan; las del frontend siguen verdes; typecheck y lint limpios. Commit `feat(021): pantallas de reglas del cliente y del motor`.

## T14 · [ ] Frontend: grilla, masiva, filtro y lupa ⚠022 (frontend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: Frontend; «Cruce con 022»), pruebas de T6 (`components/compras/*.historial.spec.tsx`), `apps/frontend/components/compras/{grilla-compras,barra-masiva,filtros-compras,lupa-compra,historial-compra,foco-grilla}.tsx|ts`, `apps/frontend/lib/compras.ts`, `components/reglas/recordar-proveedor.tsx` (de T13).
- **Hacer**: solo después de que RP-5 de 022 esté en `main` y el orquestador lo haya integrado (si no, parar y avisar). Etiqueta «Según historial» en la fila y en la lupa, filtro, `historial` en el historial de versiones, aviso «Recordar» tras clasificar en la fila, la lupa (habilita el botón de 016 P-8) y la masiva de un solo proveedor. Lo nuevo en `components/reglas/`; en la grilla solo el enganche.
- **Hecho cuando**: las de T6 de `components/compras/` pasan; las de la grilla y E-06 siguen verdes; typecheck y lint limpios. Commit `feat(021): según historial y recordar en la grilla y la lupa`.

## T15 · [x] Cobertura (devops · haiku)
- **Contexto (leer solo esto)**: `package.json` (raíz: scripts `cobertura:*`), `.github/workflows/ci.yml`, `packages/domain/vitest.cobertura.config.mts`, `apps/backend/vitest.cobertura*.config.mts` (modelo).
- **Hacer**: `cobertura:reglas` (domain `src/reglas/r-his.ts` y `catalogo.ts`, `packages/db/src/reglas/`, `apps/backend/src/modules/reglas/`, `apps/worker/src/trabajos/persistidores/compras.ts`), umbral 90 % en líneas y ramas, paso en CI.
- **Hecho cuando**: `pnpm cobertura:reglas` ≥ 90 % (o lista de lo que falta, sin bajar el umbral) y el paso aparece en `ci.yml`. Commit `chore(021): cobertura de reglas aprendidas`.

## T16 · [ ] Ronda adversarial 1 (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (completo), `plan.md` (Contratos), 04 §2.3 (catálogo: aislamiento, permisos y alcance, cola). Caja negra primero (rutas y funciones públicas); luego caja blanca (`packages/db/migrations/0047–0049`, `packages/db/src/reglas/`, `apps/backend/src/modules/reglas/`, `apps/worker/src/trabajos/persistidores/compras.ts`).
- **Hacer**: ≤ 15 pruebas `*.adv.spec.ts` / `*.adv.int.spec.ts`: `clienteId`/`reglaId`/`compraIds` de otro estudio o cliente en URL y cuerpo; cliente desasignado con sesión viva; asistente sin `reglas.gestionar`; llamar a las funciones con `set_config` de otro estudio, sin estudio o con compras mezcladas; el worker que intenta `historial` fuera de la función o con datos alterados en 0.01; el backend que inserta `accion = historial`; dos «Recordar» y un PATCH contra una descarga; leer `regla_confirmacion` desde cada rol; canarios en errores y `resultado`.
- **Hecho cuando**: las pruebas están en el repo; cada fallo es un hallazgo `H-021-1-n` con severidad en el resultado de la tarea. Commit `test(021): ronda adversarial 1`.

## T17 · [ ] Pruebas de las correcciones de la ronda 1, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: resultado de T16 (hallazgos), sus pruebas, `spec.md` (los CA citados).
- **Hacer**: una prueba normal (no adversarial) por hallazgo que fije el comportamiento esperado por la spec.
- **Hecho cuando**: fallan por el defecto; commit `test(021): correcciones de la ronda 1 en rojo`.

## T18 · [ ] Corregir la ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de T16, pruebas de T16 y T17, solo los archivos que señalan.
- **Hacer**: corregir sin quitar aserciones. Un cambio de BD va en **0050** (repetible). Un hallazgo que exija cambiar la spec se escala: `requiere usuario`.
- **Hecho cuando**: las de T16 y T17 pasan; las suites de los paquetes tocados siguen verdes. Commit `fix(021): hallazgos de la ronda 1`.

## T19 · [ ] Ronda adversarial 2 (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (completo), `plan.md`, 04 §2.3 (catálogo: dinero y reglas), resultado de T16–T18. Caja negra y luego blanca (`packages/domain/src/reglas/r-his.ts`, 0048–0050, `packages/db/src/reglas/`).
- **Hacer**: ≤ 15 pruebas: montos 0, negativos (NC), 0.005, enormes cerca de NUMERIC(14,2), USD con tipo de cambio de 3 decimales, IGV 10 % y 18 %, base 0 con IGV ≠ 0, R-ISC y R-MIX con regla (P-6), consolidación de tres destinos; reabrir y volver a revisar; corregir y volver a la regla con deshacer; apagar R-HIS a mitad de la descarga; eliminar y volver a recordar; RUC 20 contra 10 y otros tipos de documento (P-10); aporte apagado.
- **Hecho cuando**: igual que T16 (`H-021-2-n`). Commit `test(021): ronda adversarial 2`.

## T20 · [ ] Pruebas de las correcciones de la ronda 2, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: resultado de T19, sus pruebas, `spec.md` (los CA citados).
- **Hacer / Hecho cuando**: como T17. Commit `test(021): correcciones de la ronda 2 en rojo`.

## T21 · [ ] Corregir la ronda 2 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de T19, pruebas de T19 y T20, solo los archivos que señalan.
- **Hacer / Hecho cuando**: como T18; un cambio de BD va en **0051**. Commit `fix(021): hallazgos de la ronda 2`.

## T22 · [ ] E2E prioridad 1 (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-3, CA-14), `tests/e2e/flujos/{descarga-compras,grilla-compras}.e2e.ts` (modelo, sin editarlos), `tests/e2e/soporte/` (sembrado y selectores).
- **Hacer**: `tests/e2e/flujos/reglas.e2e.ts` y `soporte/selectores/reglas.ts`: clasificar una fila de X en DNG con el teclado → «Recordar» con el atajo → descargar el periodo siguiente (mock) → filas de X con «Según historial» → filtro → masiva a DG → etiqueta fuera y resumen actualizado. No tocar E-06 (022).
- **Hecho cuando**: `pnpm e2e -- reglas` pasa 3 veces seguidas, sin `retry` ni `test.only`. Commit `test(021): e2e de reglas aprendidas`.

## T23 · [x] Prueba manual (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA), `docs/specs/019-docker-local/` (cómo levantar el sistema local, solo la sección de arranque).
- **Hacer**: con el sistema completo y adaptadores en `mock`: el flujo de T22 a mano, la pantalla de reglas (editar, desactivar, eliminar, volver a recordar), el interruptor de R-HIS y de R-NEW, pasar el periodo a `revisado` y ver `aceptada`. Defectos de pantalla → T23a.
- **Hecho cuando**: resultado con pasos, lo visto y los defectos (o «sin defectos»).

**Resultado (2026-11-16, rama `spec/021-reglas-aprendidas`, Node 22.22.0, Chromium de Playwright 1440×900 y 390×844, es-PE)**

*Entorno.* Sin Docker: PostgreSQL 17 y Redis ya estaban activos; Mailpit no se usó (`CORREO_PROVIDER=consola`). BD nueva `contapp_021m` (migrada dos veces y sembrada), Redis índice 13, adaptadores en `mock`, `XML_SIMULADO_EN_REGLAS=1`, backend `:4210`, worker y frontend `:3210` (build de producción). Un estudio con un Dueño y cinco clientes (mixta, contribuyente de prueba y tres con RUC sin fixture, que reciben el conjunto genérico). Credenciales SOL y SIRE guardadas por la pantalla del cliente; descargas por el botón «Descargar»; todo lo demás por la interfaz. Capturas fuera del repo, en el scratchpad `t23/`.

*Pasos y lo visto (todo en español, sin errores de consola salvo los 409 y 400 que se citan).*
1. Flujo de T22 a mano (CA-1 a CA-3). 202610: F001-6010 y F001-6012 llegan en DG con alerta R-NEW y «Proveedor nuevo». Clasificar F001-6010 en DNG con teclado (menú con flechas): «Compra clasificada.» y aviso «¿Recordar para este proveedor en este cliente?» sin quitar el foco de la celda; el botón declara `aria-keyshortcuts="Alt+R"`; Alt+R guarda («Regla guardada. Se aplicará en las próximas descargas de este proveedor.») y el aviso desaparece. La compra del mismo periodo no se mueve. Descarga de 202611: dos filas en DNG con «Según historial» y Base DNG 0 → 280,00 (+280,00 aumenta); filtro «Según historial» deja las 2; panel «Historial» muestra «Versión 2 … Según historial». Masiva a DG sobre las 2: «2 aplicadas», sin etiqueta, resumen sin cambio. Otro «Recordar» hecho con clic (no Alt+R) también guarda.
2. Reglas del cliente. Editar (DNG → DGNG) con «Guardar»; desactivar → «Inactiva»; activar → «Activa»; eliminar abre la confirmación (foco en «Cancelar», Esc la cierra y devuelve el foco al botón) y al confirmar queda «Este cliente aún no tiene reglas aprendidas.». Volver a recordar desde la grilla crea la regla de nuevo (Aplicada 0, Aceptada 0). Con dos pestañas, editar una regla ya desactivada en la otra da el 409: «La regla cambió mientras tanto. Revisa las reglas del cliente e inténtalo de nuevo.» y la tabla se recarga.
3. Reglas del motor. R-HIS apagada (persiste al recargar): la descarga siguiente (202610 en un cliente con regla aprendida en 202609) llega en DG y sin etiqueta; encendida de nuevo, 202611 llega «Según historial». R-NEW apagada: la descarga de un cliente nuevo no trae alerta R-NEW ni «Proveedor nuevo»; lo ya guardado en otro cliente se conserva. Aporte al catálogo: sin fila → apagado (`aportar_catalogo=false`); con él apagado un «Recordar» no deja fila en `regla_confirmacion` (3 → 3), encendido sí (3 → 4).
4. Periodo a `revisado` (confirmación «¿Marcar el periodo como revisado?…»): en la tabla de reglas, Aceptada pasa de 0 a 2 y aparecen 2 confirmaciones `aceptada` en `regla_confirmacion`.
5. Corregir una fila «Según historial» (F001-6010 de DGNG a DG): la etiqueta sale y el resumen se actualiza; Ctrl+Z («Se deshizo la operación (1 compras).») devuelve DGNG y la etiqueta; Ctrl+Shift+Z la quita; otro Ctrl+Z la devuelve.
6. R-GP con XML subido (F001-5070, zapatilla): se subió `fixtures/xml/20700000070-01-F001-5070.xml` por «Subir XML» de la lupa («XML subido por …»), «Aceptar sugerencias» → «Aceptar R-GP» → «Confirmar»: «Sugerencia aceptada.», la compra pasa a Excluidas. Defecto corregido: sí, da 200.
7. Teclado y foco: menú de acciones, aviso, confirmaciones y atajos funcionan; los hallazgos de foco están en T23a. Sin desborde horizontal de página a 1440 ni a 390; sí problemas de la grilla a 390 (T23a-1).

*Observaciones que no son defecto de 021.* (a) Con el filtro «Según historial» puesto, una fila corregida sigue en el listado, ya sin etiqueta, hasta recargar. (b) El panel «Historial» de la compra (016/017, `historial-compra.tsx`, un `aside` sin foco inicial) no se cierra con Esc. (c) Tras aceptar R-GP la lupa sigue mostrando los hallazgos ya aceptados. (d) Pedir 202612 y 202701 (posteriores al mes actual) da 400 y no se investigó la causa; por eso los periodos siguientes se armaron aprendiendo en un periodo anterior.

*Defectos de pantalla (T23a, frontend · sonnet).*
- **T23a-1 · media.** A 390 px la grilla de compras solo deja ver «Total y acciones»: la columna fija derecha cubre Comprobante, Proveedor y Destino, y las filas no se pueden identificar. `apps/frontend/components/compras/grilla-compras.tsx` (columnas `sticky` de los extremos, ~líneas 665, 1001 y 1019). Capturas `49-grilla-390.png`, `50-grilla-390-scroll.png`.
- **T23a-2 · media.** La versión que crea R-HIS (sin usuario) se rotula «Versión 2 · SIRE» en el historial de la compra; debería indicar el sistema o la regla. `apps/frontend/components/compras/historial-compra.tsx:142` (`ver.usuarioId ? etiquetaAutor(...) : M.autorSire`; distinguir `accion === "historial"`). Captura `12-historial-versiones.png`.
- **T23a-3 · baja.** Pantalla de reglas del cliente: «Editar» con Enter deja el foco en «Guardar» (React reutiliza el botón) en lugar del selector de destino, y Esc no cancela; tras guardar, activar, desactivar o eliminar el foco cae a `body`; ninguna de esas acciones anuncia un estado. `apps/frontend/components/reglas/tabla-reglas-cliente.tsx`. Capturas `17-editar.png`, `18-editada.png`.
- **T23a-4 · baja.** Los interruptores de «Reglas del motor» y del aporte no anuncian el cambio (sin `role="status"`), y el aviso «Recordar» no muestra «Alt+R» a quien no usa lector de pantalla. `apps/frontend/components/reglas/reglas-motor.tsx`, `recordar-tras-clasificar.tsx`. Capturas `24-reglas-motor.png`, `08-clasificada-aviso.png`.
- **T23a-5 · baja.** A 390 px la tabla de reglas del cliente corta «Aplicada» y esconde Aceptada, Actualizada y las acciones tras un desplazamiento interno sin pista visual (`min-w-[44rem]` en `overflow-x-auto`). `tabla-reglas-cliente.tsx:116-117`. Captura `48-reglas-cliente-390.png`.

*Cierre.* Procesos detenidos (backend, worker, frontend); Redis índice 13 vaciado; `contapp_021m` se deja sin borrar. No se tocó código de producción ni `contapp` ni `contapp_021`.

## T24 · [x] Verificar (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-14), `tasks.md` (resultados), `package.json` (scripts).
- **Hacer**: cada CA con su evidencia (prueba o comando); suites de `domain`, `shared`, `db`, `backend`, `worker`, `frontend`, `test:aislamiento`, typecheck, lint, `pnpm db:migrate` ×2, `pnpm cobertura:reglas`, `pnpm ci:db` y `pnpm e2e`.
- **Hecho cuando**: tabla CA → evidencia → OK/falta en el resultado; todo en verde o la lista de lo que falta.

**Resultado (2026-11-16, rama `spec/021-reglas-aprendidas`, merge 410b584 con 022, Node 22.22.0)**

*Entorno.* BD nueva `contapp_021v` (migrada dos veces y sembrada), Redis índice 14 (13 para la E2E), adaptadores en `mock`. Tras el merge hizo falta `pnpm install --frozen-lockfile` (la 038 trajo `@fontsource-variable/*`; sin eso `pnpm build` falla en el frontend) y recompilar los `dist`. Sin Docker ni Mailpit: la E2E corrió con `E2E_CORREO=consola` (README de `tests/e2e`). La E2E usa su propia BD fija `contapp_e2e`. No se tocó código de producción ni `contapp`.

*Suites.*
| Suite | Resultado |
| --- | --- |
| `pnpm typecheck` | OK (18/18) |
| `pnpm lint` | **FALLA** en `domain` (F-1); los otros 10 paquetes limpios (`turbo run lint --continue`) |
| Unitarias: crypto 291, shared 2033, domain 2577 (+3 todo ajenos a 021), db 961, storage 192, sunat 262, queue 462, backend 1244, worker 410, tests/limites 329 | OK |
| Integración queue 116 · worker 365 | OK |
| Integración backend | 2833 de 2834 OK (116 archivos), **1 falla** (F-2) |
| `tests/aislamiento` completo | OK (92 archivos, 2694 pruebas) |
| Frontend `TZ=America/Lima` y `TZ=UTC` | OK, 104 archivos y 970 pruebas en cada una |
| `pnpm e2e` | 88/88 con `E2E_CORREO=consola`; la primera corrida (Mailpit por defecto) dio 8 fallos por `ECONNREFUSED 127.0.0.1:8025` (F-3) |
| `pnpm e2e:volumen` | OK (2/2) |
| `pnpm cobertura:reglas` | OK: domain 98,5 % líneas / 97,2 % ramas; db 100 % / 98,3 %; backend 100 % / 100 %; worker 100 % / 93,2 %; todos sobre el 90 % |
| `pnpm db:migrate` ×2 (al inicio y de nuevo al final) | OK, 52 migraciones y sin cambios en la segunda |

*Criterios.*
| CA | Evidencia (archivo:línea) | Estado |
| --- | --- | --- |
| CA-1 | `apps/frontend/components/reglas/recordar-proveedor.spec.tsx:61,97,140` · `components/compras/grilla-compras.historial.spec.tsx:160,193` · `lupa-compra.historial.spec.tsx:141` · `apps/backend/src/modules/reglas/reglas-cliente.int.spec.ts:217-235` (403 sin `reglas.gestionar`, 200 con él) · `tests/e2e/flujos/reglas.e2e.ts:38` (teclado y Alt+R) | OK |
| CA-2 | `apps/worker/src/trabajos/persistidores/persistidor-reglas.int.spec.ts:243,297` (versión 2 `historial`, versión 1 idéntica con md5) · `apps/backend/src/modules/compras/historial.int.spec.ts:92` · `grilla-compras.historial.spec.tsx:117` · `lupa-compra.historial.spec.tsx:92` · `reglas.e2e.ts:38` | OK |
| CA-3 | `historial.int.spec.ts:217,245,258` (una, en masa por filtro, resumen) · `barra-masiva.historial.spec.tsx:189` · `reglas.e2e.ts:38` (masiva a DG) | OK |
| CA-4 | `persistidor-reglas.int.spec.ts:481-609` (regla inactiva/eliminada, BI 0, destino igual, R-HIS apagado, descarga repetida, fila preexistente) · `tests/aislamiento/reglas-funciones.spec.ts:300,450,465,485` · `packages/domain/src/reglas/r-his.spec.ts:125` | OK |
| CA-5 | `tests/aislamiento/reglas-tablas.spec.ts:579` (dos estudios, sin `withTenant`) · `reglas-vigentes.spec.ts:87` · `reglas-cliente.int.spec.ts:182,192,360,585,699` (404 idéntico) · `historial.int.spec.ts:152` · `persistidor-reglas.int.spec.ts:609` · `reglas-r1.adv.int.spec.ts:113` | OK |
| CA-6 | `reglas-repositorio.spec.ts:181,192` · `reglas-revisado.spec.ts:262-352` · `reglas-tablas.spec.ts:390,404,647` (ningún rol lee, sin UPDATE/DELETE, dos estudios) · `reglas-cliente.int.spec.ts:459`. Ninguna ruta de 021 lee `regla_confirmacion`: lo garantiza el grant (`reglas-tablas.spec.ts:404`) | OK |
| CA-7 | `reglas-cliente.int.spec.ts:111,512,639,735` · `tabla-reglas-cliente.spec.tsx:78` · `reglas-revisado.spec.ts:163` (aplicada y aceptada) · `reglas-repositorio.spec.ts:485` (auditoría anterior/nuevo) | OK |
| CA-8 | `reglas-motor.int.spec.ts:58,74,113` · `historial.int.spec.ts:349` · `obtener-xml-interruptores.int.spec.ts:133` · `domain/src/reglas/interruptores.spec.ts:28` · `reglas-tablas.spec.ts:449` (prevalidación no) · `reglas-motor.spec.tsx:57` · `reglas-apagadas-022.int.spec.ts:90` | OK |
| CA-9 | `tests/aislamiento/reglas-concurrencia.spec.ts:77,142,205` · `reglas-cliente.int.spec.ts:321,444` · `persistidor-reglas.int.spec.ts:449` | OK |
| CA-10 | `reglas-funciones.spec.ts:300,321,342` (42501, sin UPDATE sobre `compra`) · `reglas-r1.adv.spec.ts:77` | OK |
| CA-11 | `packages/domain/src/reglas/r-his.spec.ts:165` y `compras/evaluar-reglas.spec.ts:131` (San Juan y mixta: mismos montos que a mano) · `reglas-funciones.spec.ts:657` | OK |
| CA-12 | `historial.int.spec.ts:294,313,325` · `r-his.spec.ts:218` · `grilla-compras.historial.spec.tsx:239` | OK |
| CA-13 | `persistidor-reglas.int.spec.ts:631` (resultado, logs, auditoría) · `historial.int.spec.ts:200` · `reglas-cliente.int.spec.ts:43` · `reglas-r1.adv.int.spec.ts:157` · `reglas-funciones.spec.ts:764` · `reglas-r1.adv.spec.ts:222` | OK |
| CA-14 | Suites, typecheck, `db:migrate` ×2, E2E y cobertura en verde, salvo lint (F-1) y la prueba de rutas de HU-40 (F-2) | **No cumplido** |

*Cruce con 022 (punto 3).* `evaluarPorPeriodo` (lazy: `leerProveedoresConocidos` y `leerReglasMotor` en la primera llamada) con `escribirVersiones` solapando `evaluar` y las escrituras: sin diferencias. Prueba nueva `apps/backend/src/modules/compras/reglas-apagadas-022.int.spec.ts` (2 pruebas, verdes): fixture de 009 sin historial más 60 filas de volumen; la masiva a DG y su Ctrl+Z dejan los mismos hallazgos (regla, sugerencia, lecturas, confirmación) en las versiones 2 y 3 que la acción fila por fila, con todas las reglas encendidas (control: salen R-ISC y R-NEW) y con R-ISC y R-NEW apagadas (no salen; R-MIX sigue). `deshacer-masivo-022.int.spec.ts` (equivalencia con 1.230 filas y 4.850 filas en ≤ 1.200 ms) pasa suelta y en la suite completa. Queda sin cubrir un lote de más de 500 filas con reglas apagadas (la prueba de 022 cubre los lotes con todas encendidas).

*Diseños a 390 px (T23a), Chromium de `/opt/pw-browsers`, capturas en el scratchpad `t24/` (`021v-*.png`; script `zz-t24-angosto.e2e.ts`, no versionado).*
- Tabla de reglas apilada: OK. Fila `flex` en columna, 7 celdas con su `data-etiqueta` entre x = 25 y 365, sin ancestro con scroll interior, sin desborde de página, encabezado oculto, botones Editar, Desactivar y Eliminar dentro de la ventana (`021v-reglas-390.png`).
- Grilla sin columnas fijas: cumple lo estructural (ningún `data-col` ni encabezado `sticky` lateral; sin desborde de página; Comprobante visible de 129 a 285 px), pero **tiene un defecto** (F-4).

*Fallos y clasificación (no se reintentó ninguno).*
- **F-1 · lint · baja · defecto de 021 (prueba).** `packages/domain/src/reglas/r-his-entrada.spec.ts:131-132` · `'_m'` y `'_p'` asignadas sin usar (`@typescript-eslint/no-unused-vars`); entró en 367445d (T15). Corrige tester o backend.
- **F-2 · integración backend · media · faltante de 021.** `apps/backend/src/aislamiento/hu40-api.int.spec.ts:1796` · la prueba de cobertura de rutas de HU-40 no tiene caso para las 7 rutas nuevas: `GET`, `POST …/recordar`, `PATCH` y `DELETE` de `/clientes/:clienteId/reglas` y `GET`, `PUT /:codigo` y `PUT /aporte` de `/estudio/reglas-motor`. El 404 de cada una ya está en `reglas-cliente.int.spec.ts` (CA-5); falta registrarlas en HU-40.
- **F-3 · E2E · entorno, sin defecto.** 8 pruebas que leen correo (`alta`, `equipo`, `soporte:33`) fallan con Mailpit apagado; con `E2E_CORREO=consola` pasan 88/88.
- **F-4 · frontend · media · regresión de T23a-1.** A 390 px, al desplazar la grilla a la derecha las filas quedan en blanco: con `scrollLeft` ≥ ~1.000 px se ven los encabezados (DG, DGNG, … Total, Acciones) pero ninguna celda de datos (barrido en `angosto.log`: `fila=[]` desde x = 1200; a 1440 px siempre hay celdas). Causa probable: sin columnas fijas la celda activa por defecto (columna `seleccionar`, índice 0) va en `centro` y `conIndices` la mete en el rango virtual; `margenIzq` (`grilla-compras.tsx:~683`) se calcula con `columnasVisibles[0].start` (= 0), no se pone el espaciador y las columnas visibles se pintan pegadas a la primera, fuera de la ventana. Con 1440 px la columna 0 está fijada y no entra en `centro`. Capturas `021v-grilla-390-derecha.png` y `021v-grilla-390-medio.png`. Requiere T24a (frontend) con una prueba que desplace la grilla angosta.

## T25 · [x] Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, resultado de T24, `git diff main...HEAD --stat` y los archivos que la revisión necesite.
- **Hacer**: contrastar cada CA y D-n con la evidencia; ratificar o rechazar desvíos del plan (sección «Desvíos ratificados» en `plan.md`).
- **Hecho cuando**: veredicto con lo que falta; si hay defectos, T25a y T25b.

**Resultado (2026-11-16, `git diff origin/main...HEAD`, 157 archivos, cabeza a224dbd)**

*Veredicto: aprobada, sin defectos bloqueantes.* CA-1 a CA-13 se sostienen con la evidencia de T24 y el código; CA-14 queda en verde salvo una corrida pendiente (abajo). Desvíos: 14 ratificados en `plan.md` («Desvíos ratificados»); ninguno rechazado.

*Lo revisado.*
- **Migraciones 0047–0051.** Las seis tablas con RLS `ENABLE` + `FORCE` y `tenant_isolation` `FOR ALL` (USING y WITH CHECK); ninguna desactiva RLS. Se revoca todo a cada rol antes de conceder. `regla_aprendida`: backend `SELECT`, `INSERT` y `UPDATE` de columnas, sin `DELETE`; worker nada. `regla_aplicacion` y `regla_aceptacion`: solo `SELECT` del backend. `regla_confirmacion`: solo `INSERT` del backend (nadie la lee; `SQL_CONFIRMAR` no usa `RETURNING`). Worker: `SELECT` en `estudio_regla_motor` y `estudio_reglas_config` y `EXECUTE` en las dos funciones acotadas; sin `SELECT` en `regla_aplicacion` ni en `regla_confirmacion`. Todas las `SECURITY DEFINER` con `search_path = pg_catalog, pg_temp`, nombres calificados y `REVOKE … FROM PUBLIC`. 0050 y 0051 son `CREATE OR REPLACE` con la misma firma, dueño y grants.
- **Confirmaciones (P-1, P-4, P-10, excluidas, H-021-2-1).** `recordarRegla` y `regla_aceptar_periodo` exigen `doc_tipo = '6'`, `^20[0-9]{9}$` (y el CHECK `regla_confirmacion_ruc_20`) y el aporte encendido (sin fila = encendido). La aceptación exige vigente no excluida, con base gravada, en el destino de la regla, y la versión `historial` en ese destino; `ON CONFLICT` evita duplicar al re-revisar. El trigger fija `app.tenant_id` al estudio de la fila que el propio RLS ya dejó actualizar, así que no cruza estudios.
- **Dinero en R-HIS.** `planificarHistorial` y `planificarHistorialDescarga` usan `Money`/`MontosComprobante` y cadenas; ningún `number` para montos. El desborde de NUMERIC(14,2) (`MontoFueraDeRangoError`) deja la fila en su versión 1 y las demás siguen (H-021-2-4). La BD recalcula la consolidación en NUMERIC y falla cerrado.
- **Integración con 022 (punto 3 de T24).** Correcto y sin cambio necesario. `evaluarPorPeriodo` solo se usa en `reevaluarComprobante` (`xml.service.ts:121`, `desde-xml.service.ts:199`), donde `await f.evaluarDe(periodo)` termina antes de `guardarEvaluaciones` de esa compra: no se solapa con escrituras. `escribirVersiones` recibe siempre el `evaluar` de `entornoDeReglas`, leído con `await` antes de escribir (`acciones.service.ts:292`, `masivas.service.ts:187`), y ese `evaluar` es dominio puro, sin IO. Además las lecturas (`estudio_regla_motor` y compras de otros periodos) no dependen de las filas que se escriben. No hace falta adelantar la lectura.
- **R-GP con XML (0cfcadc).** `conReevaluacion` pasa el XML vigente con la misma bandera P-4 y sigue pasando por `aplicarSugerencia` y `sigueVigente`; la masiva lo sigue rechazando como `no_masiva`.
- **Higiene del diff.** Sin `.env`, `dump.rdb`, `docs/explorador/`, `.codex/` ni `AGENTS.md`; sin `.only`, `.skip`, `.fails`, `.todo` ni `retry` nuevos. `apps/frontend` no importa `domain`/`db`; `apps/backend` no importa `@contapp/sunat`.
- **Fallos de T24.** F-1: corregido en fc80de0 (`pnpm --filter @contapp/domain lint` limpio, corrido aquí). F-4: corregido en fa25064 (`grilla-compras.angosta.spec.tsx` 3/3, corrido aquí). F-2: 7 rutas añadidas a HU-40 en a224dbd (typecheck del backend y eslint del archivo limpios); **no se corrió** porque necesita la BD.

*Hallazgos (no bloqueantes).*
- **H-T25-1 · baja.** `packages/domain/src/compras/aceptar.ts:166-170`: la re-evaluación de aceptar arma `contexto` sin `reglasApagadas`. Un hallazgo guardado antes de apagar R-ISC, R-MIX, R-RED o R-NEW, en una fila **sin XML**, se puede aceptar con la regla apagada (`sigueVigente` devuelve `true` sin XML, `apps/backend/src/modules/compras/transformar.ts:117`). Con XML (y R-GP, que siempre lo tiene) sí da `revisar_de_nuevo`. Choca con el comentario de `motor.ts` («su sugerencia queda obsoleta») y con el título de `historial.int.spec.ts` («no llega a aceptar»), aunque CA-8 solo habla de evaluaciones siguientes y de no borrar lo guardado. Opciones para el usuario: (a) ratificarlo (aceptar algo ya guardado y visible es decisión del contador) o (b) T25a/T25b: `reglasApagadas` en `EntradaAceptar` desde `entornoDeReglas`, con prueba de aceptar R-NEW guardada y R-NEW apagada → 409.
- **H-T25-2 · baja (proceso).** La medición de volumen de T10 (5.000 compras con y sin reglas; plan, Riesgos: «Volumen») no quedó anotada. `insertarCompras` llama a `aplicar_regla_historial` fila por fila (`packages/db/src/compras/versiones.ts:279-292`). Conviene medirlo antes del cierre o dejarlo como nota en `ESTADO.md`.

*Pendiente para el cierre (T26 u orquestador).* Correr `apps/backend/src/aislamiento/hu40-api.int.spec.ts` (F-2) contra la BD de pruebas para dar CA-14 por cumplido, y decidir H-T25-1 y H-T25-2.

## T26 · [ ] Cierre (devops · haiku)
- **Contexto (leer solo esto)**: resultado de T25, `tasks.md`, `spec.md` (estado y CA).
- **Hacer**: marcar tareas y CA, estado de la spec «hecha (fecha)». Commit `docs(021): cierre` con rutas explícitas. El orquestador actualiza `ESTADO.md`.
- **Hecho cuando**: `git status` limpio en los archivos de 021 y el commit hecho.
