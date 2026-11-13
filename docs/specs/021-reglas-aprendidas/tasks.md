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
| T15 | Cobertura ≥ 90 %: `domain/reglas`, `db/reglas`, módulo `reglas`, persistidor de compras; en CI | devops | haiku | T10, T11, T12 ∥ T14 | — | — | [ ] |
| T16 | Ronda adversarial 1: aislamiento, permisos, funciones acotadas y concurrencia (≤ 15 pruebas) | adversario | opus | T10, T11, T12, T15 ∥ T14 | — | ✓ | [ ] |
| T17 | Pruebas de las correcciones de la ronda 1 (rojo) | tester | sonnet | T16 | ✓ | — | [ ] |
| T18 | Corregir los hallazgos de la ronda 1 (migración 0050 si hace falta) | backend | opus | T17 | — | — | [ ] |
| T19 | Ronda adversarial 2: dinero con R-HIS, aceptaciones y confirmaciones, interruptores, baja lógica (≤ 15 pruebas) | adversario | opus | T18 | — | ✓ | [ ] |
| T20 | Pruebas de las correcciones de la ronda 2 (rojo) | tester | sonnet | T19 | ✓ | — | [ ] |
| T21 | Corregir los hallazgos de la ronda 2 (migración 0051 si hace falta) | backend | opus | T20 | — | — | [ ] |
| T22 | E2E prioridad 1: «Recordar» → descarga siguiente → «Según historial» → revertir | tester | sonnet | T14, T10 ∥ T16–T21 | — | — | [ ] |
| T23 | Prueba manual contra el sistema completo | tester | sonnet | T21, T22 | — | — | [ ] |
| T24 | Verificar CA-1 a CA-14 con evidencia, suites completas, `db:migrate` ×2 y cobertura | tester | sonnet | T23 | — | — | [ ] |
| T25 | Revisión final contra la spec | arquitecto | opus | T24 | — | — | [ ] |
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

## T15 · [ ] Cobertura (devops · haiku)
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

## T23 · [ ] Prueba manual (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA), `docs/specs/019-docker-local/` (cómo levantar el sistema local, solo la sección de arranque).
- **Hacer**: con el sistema completo y adaptadores en `mock`: el flujo de T22 a mano, la pantalla de reglas (editar, desactivar, eliminar, volver a recordar), el interruptor de R-HIS y de R-NEW, pasar el periodo a `revisado` y ver `aceptada`. Defectos de pantalla → T23a.
- **Hecho cuando**: resultado con pasos, lo visto y los defectos (o «sin defectos»).

## T24 · [ ] Verificar (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-14), `tasks.md` (resultados), `package.json` (scripts).
- **Hacer**: cada CA con su evidencia (prueba o comando); suites de `domain`, `shared`, `db`, `backend`, `worker`, `frontend`, `test:aislamiento`, typecheck, lint, `pnpm db:migrate` ×2, `pnpm cobertura:reglas`, `pnpm ci:db` y `pnpm e2e`.
- **Hecho cuando**: tabla CA → evidencia → OK/falta en el resultado; todo en verde o la lista de lo que falta.

## T25 · [ ] Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, resultado de T24, `git diff main...HEAD --stat` y los archivos que la revisión necesite.
- **Hacer**: contrastar cada CA y D-n con la evidencia; ratificar o rechazar desvíos del plan (sección «Desvíos ratificados» en `plan.md`).
- **Hecho cuando**: veredicto con lo que falta; si hay defectos, T25a y T25b.

## T26 · [ ] Cierre (devops · haiku)
- **Contexto (leer solo esto)**: resultado de T25, `tasks.md`, `spec.md` (estado y CA).
- **Hacer**: marcar tareas y CA, estado de la spec «hecha (fecha)». Commit `docs(021): cierre` con rutas explícitas. El orquestador actualiza `ESTADO.md`.
- **Hecho cuando**: `git status` limpio en los archivos de 021 y el commit hecho.
