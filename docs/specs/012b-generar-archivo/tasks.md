# Tareas 012b · Generar el archivo SIRE: guardado, versiones, descarga y pantalla

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con las indicadas (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A (spec) con las pantallas como C por tarea (T14, T15: pruebas mínimas, sin TDD ni ADV). Flujo 04 §1.3: pruebas primero (rojo) → implementar (verde) → cobertura → atacar (2 rondas) → corregir (con pruebas del tester) → prueba manual → verificar → revisión de Opus → cerrar. Rama `spec/012b-generar-archivo`. CA, D y P = `spec.md`; contratos, supuestos S-1/S-2 y decisiones = `plan.md`.

| #   | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
| --- | ----- | --- | ------ | ---------- | --- | --- | ------ |
| T1  | Pruebas de dominio: ventas en `prevalidar`/`resumirCambios`/`generarTxt`, adaptadores y D7, huella, `prepararArchivo` (rojo) | tester | sonnet | — ∥ T2, T3, T4 | ✓ | — | [ ] |
| T2  | Pruebas de `shared/archivos` y del estado de ventas (rojo) | tester | sonnet | — ∥ T1, T3, T4 | ✓ | — | [ ] |
| T3  | Pruebas de `packages/storage`: ruta de archivos, hash y lectura verificada (rojo) | tester | sonnet | — ∥ T1, T2, T4 | ✓ | — | [ ] |
| T4  | Pruebas de BD: `venta_periodo`, `archivo_generado`, triggers y grants del worker, repositorios, limpiezas (rojo) | tester | sonnet | — ∥ T1–T3 | ✓ | — | [ ] |
| T5  | Pruebas del worker: catálogo y `archivo.generar` (CA-2 a CA-4, CA-6 a CA-8, CA-13, CA-14), descarga de ventas con `generado` (rojo) | tester | sonnet | T2 ∥ T6 | ✓ | — | [ ] |
| T6  | Pruebas HTTP: previo, generar, versiones, descarga, estado y 409 de ventas, HU-40 (rojo) | tester | sonnet | T2 ∥ T5 | ✓ | — | [ ] |
| T7  | Dominio: ventas en prevalidación y TXT, adaptadores, huella, `prepararArchivo`, `permiteProvisional` | backend | opus | T1 ∥ T8, T9, T10 | ✓ | — | [ ] |
| T8  | Esquemas y DTOs de `shared/archivos` y estado de ventas | backend | sonnet | T2 ∥ T7, T9, T10 | ✓ | — | [ ] |
| T9  | `packages/storage`: `rutaArchivo`, gramáticas, `sha256Hex`, `leerVerificado` | backend | sonnet | T3 ∥ T7, T8, T10 | ✓ | — | [ ] |
| T10 | Migraciones 0039–0040, esquema drizzle, `src/archivos/`, `src/ventas/{periodo,filas-reemplazo}.ts` | backend | opus | T4 ∥ T7–T9 | ✓ | — | [ ] |
| T11 | Worker: `archivo.generar`, cola `archivos`, descarga de ventas con estado | backend | opus | T5, T7, T9, T10 ∥ T12, T13 | ✓ | — | [ ] |
| T12 | Backend: módulo `archivos` (previo, generar, versiones, descarga) | backend | sonnet | T6, T7, T8, T9, T10 ∥ T11, T13 | ✓ | — | [ ] |
| T13 | Backend: estado del periodo de ventas y 409 en las escrituras de 013 | backend | sonnet | T6, T8, T10 ∥ T11, T12 | ✓ | — | [ ] |
| T14 | Panel lateral «Generar archivo» en compras (nivel C) | frontend | sonnet | T8 ∥ T9–T13 | — | — | [ ] |
| T15 | Ventas: estado del periodo, escrituras deshabilitadas y panel (nivel C) | frontend | sonnet | T14 | — | — | [ ] |
| T16 | Cobertura ≥ 90 % en CI: `cobertura:archivos` y carpetas nuevas | devops | haiku | T11, T12, T13 ∥ T14, T15 | — | — | [ ] |
| T17 | Ronda adversarial 1: TXT/ZIP, descarga y storage, aislamiento, permisos y privilegios del worker (≤ 15 pruebas) | adversario | opus | T16 | — | ✓ | [ ] |
| T18 | Pruebas de las correcciones de la ronda 1 (rojo) | tester | sonnet | T17 | ✓ | — | [ ] |
| T19 | Corregir los hallazgos de la ronda 1 | backend | opus | T18 | — | — | [ ] |
| T20 | Ronda adversarial 2: concurrencia, estados, huella y cola (≤ 15 pruebas) | adversario | opus | T19 | — | ✓ | [ ] |
| T21 | Pruebas de las correcciones de la ronda 2 (rojo) | tester | sonnet | T20 | ✓ | — | [ ] |
| T22 | Corregir los hallazgos de la ronda 2 | backend | opus | T21 | — | — | [ ] |
| T23 | Prueba manual contra el sistema completo | tester | sonnet | T15, T22 | — | — | [ ] |
| T24 | Verificar CA-1 a CA-14 con evidencia, suites completas y cobertura | tester | sonnet | T23 | — | — | [ ] |
| T25 | Revisión final contra la spec y 03 §7.3 | arquitecto | opus | T24 | — | — | [ ] |
| T26 | Cierre: `tasks.md`, `spec.md` y commit (el orquestador actualiza ESTADO) | devops | haiku | T25 | — | — | [ ] |

Paralelismo: T1 ∥ T2 ∥ T3 ∥ T4; luego T5 ∥ T6 (los dos contra los esquemas de T2). Implementación en cuatro carriles independientes: T7 (`domain`) ∥ T8 (`shared`) ∥ T9 (`storage`) ∥ T10 (`db`). Luego T11 (`apps/worker`) ∥ T12 (`apps/backend/src/modules/archivos` y `app.module.ts`) ∥ T13 (`apps/backend/src/modules/ventas`). El frontend (T14 → T15) corre en paralelo con T9–T13 contra el contrato de `shared` (sus pruebas simulan la API); T16 con T14–T15. Las rondas y sus correcciones van en serie (T17 → T19 → T20 → T22): la ronda 2 debe ver las correcciones de la 1. Si una ronda no deja fallos, se saltan sus dos tareas de corrección (se marcan `[x]` «sin hallazgos»).

Escalamientos: T7, T10 y T11 nacen en `opus` (formatos SUNAT, huella, RLS, triggers del worker y la transacción de D4; 04 §3.2). T12 o T13 pasan a `opus` si fallan 2 veces. T16 pasa a `sonnet` si `haiku` falla una vez. T17 y T20 son `opus` por regla; T19 y T22 en `opus` porque tocan formatos, BD y concurrencia. Si T23 encuentra defectos de pantalla se añade T23a (frontend · sonnet); si T25 encuentra defectos, T25a (pruebas en rojo) y T25b (corrección), como 014 T22a/T22b.

Reglas comunes:

- Un commit por tarea (Conventional Commits `test(012b): …`, `feat(012b): …`, `fix(012b): …`, `ci(012b): …`, `docs(012b): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push del subagente: el orquestador lo hace.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` ajenos: `git add <rutas>` explícitas, nunca `-A` ni `.`.
- **Nunca** imprimir ni commitear secretos ni el contenido de `.env`. Canarios (razón social, montos y serie únicos) que se buscan en respuestas, logs, errores y `resultado`. Ningún log ni mensaje con filas, montos, razones sociales, bytes del TXT/ZIP ni rutas de storage (D10).
- Checks: responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo. Correr solo las pruebas del paquete afectado; las suites completas en T24.
- El tester no toca código de producción; backend y frontend no editan `*.spec.ts` ajenos; solo T17 y T20 escriben `*.adv.spec.ts` / `*.adv.int.spec.ts`. Las pruebas de las correcciones las escribe el tester, no quien corrige. El frontend (nivel C) escribe sus propias pruebas mínimas.
- **Limpiezas de soporte**: toda prueba que siembre `archivo_generado` o `venta_periodo` usa un soporte cuyo `limpiar` los borra (con `session_replication_role = replica`, que salta el trigger de inmutabilidad) y vacía el `MockStorage` o el directorio temporal. Las tareas de pruebas (T4, T5, T6) actualizan los soportes del plan («Archivos»).
- **HU-40**: toda ruta nueva (las cuatro de archivos por libro y las dos de estado de ventas) tiene caso en `hu40-api.int.spec.ts`; la prueba «toda ruta tiene caso» debe seguir en verde.
- **Privilegios del worker**: ninguna tarea da al rol `contapp_worker` más que lo del plan (trigger acotado en los estados, `INSERT` en `archivo_generado`, `SELECT` en `venta_salto_justificado`). Cualquier otro grant es `requiere usuario`.
- Migraciones: 012b usa **0039** y **0040**; confirmar con `ls packages/db/migrations` y el diario antes de crear; nunca editar una aplicada. Las pruebas de 002–016 siguen en verde.
- Montos: `Money` en dominio, cadenas decimales en DTOs y pantallas, `NUMERIC(14,2)` en BD; ningún `number` para dinero. Toda consulta en `withTenant()`; nunca desactivar RLS. `apps/backend` nunca importa `@contapp/sunat`. Adaptadores en `mock` (`STORAGE=mock`).
- Sin dependencias nuevas. Si alguna tarea crea un paquete, lo agrega a la compilación de `ci:db`, `ci:cierre`, los `cobertura:*` y `ci.yml`.
- P-8 (ventas del SIRE con error), S-1 (`revisado` en ventas) y S-2 (código del rechazo del worker) están abiertos: se implementa el supuesto del plan; si el usuario decide otra cosa, el orquestador ajusta las tareas afectadas. Una ambigüedad nueva que cambie la spec no se decide: `requiere usuario`.

## T1 · [ ] Pruebas de dominio, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D1, D2, D5, D6, D7, P-2, P-5, P-6; CA-1, CA-5, CA-10, CA-11, CA-14; casos reales), `plan.md` (Contratos: Dominio), `packages/domain/src/prevalidacion/{tipos,entrada,prevalidar,resumen}.ts` (firmas), `packages/domain/src/formatos/{valores,serializar,provisional-rve}.ts`, `packages/domain/src/ventas/{columnas,layout}.ts`, `packages/domain/src/correlatividad/index.ts` (`analizarCorrelatividad`), `packages/domain/src/compras/fila-reemplazo.ts`, `packages/db/src/compras/tipos.ts` (forma de `CompraLeida`), `apps/backend/src/modules/compras/integracion-012.int.spec.ts:60-110` (modelo del adaptador), `fixtures/` de 009 y 013 que nombra la spec.
- **Hacer**: `packages/domain/src/archivos/*.spec.ts` y `prevalidacion/ventas*.spec.ts`. Ventas: venta cuadrada apta; descuadrada → `CUADRE` con la explicación de P-6; IGV 18 %/10 % sobre `baseGravada`; USD sin TC; duplicado; `SIN_FILAS`; `reglas` con ventas lanza; filas del otro libro lanzan; `ResumenCambiosVentas` (agregadas = manuales, impacto IGV total exacto, USD convertidas). `generarTxt` de ventas con el RVIE provisional: una línea por venta, campos en orden, montos con escala, consumidor final `-`. Boleta 291: `prepararArchivo` apto con aviso `SALTO_CORRELATIVIDAD` «Falta B001-291» y sin él si está justificado. Compras: CA-1 (mixta 21.48/1.61 con su error IGV y `filaId`; San Juan con R-ISC sin bloquear), CA-5 (conteos e impacto por destino y total), zapatilla excluida fuera del TXT y contada en el resumen. D7 (CA-11): 100, 101 y emoji en la posición 100; NBSP y `|` en el borde. Huella: determinista, cambia con cualquier campo del TXT o del resumen y con el formato, no cambia con avisos ni con el orden de entrada. `permiteProvisional`: `production` → falso; el resto → verdadero. Las pruebas de compras de 012 no se tocan.
- **Hecho cuando**: compilan contra las firmas del plan y fallan por «no implementado»; las demás de `domain` siguen verdes. Commit `test(012b): dominio de generación en rojo`.

## T2 · [ ] Pruebas de `shared`, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP), `packages/shared/src/compras/{esquemas,respuestas}.ts` (`estadoPeriodoSchema`, `reabrirPeriodoSchema`, `estadoPeriodoRespuestaSchema`, `resumenComprasSchema`), `packages/shared/src/ventas/` (índice y respuestas del resumen).
- **Hacer**: `packages/shared/src/archivos/*.spec.ts`: `generarArchivoSchema` estricto (`estadoVisto` solo `abierto|revisado`; huella hex de 64; `permitirProvisional`, `registro`, `libro` o cualquier clave extra → rechazo); `previoArchivoSchema` (montos solo como cadenas, `motivo` cerrado, ≤ 1.000 errores, `ultimaVersion` nullable); `versionArchivoSchema` (sin `ruta`, hashes hex de 64); códigos `prevalidacion_fallida`, `formato_no_oficial`, `resumen_cambiado`, `estado_invalido`, `periodo_generado`, `cliente_archivado`, `archivo_alterado`. Ventas: el resumen suma `estado`.
- **Hecho cuando**: fallan por «no implementado»; las de `shared` existentes siguen verdes. Commit `test(012b): esquemas de archivos en rojo`.

## T3 · [ ] Pruebas de `packages/storage`, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: Storage), `packages/storage/src/{ruta,puerto,errores}.ts`, `packages/storage/src/ruta.spec.ts` (modelo; no repetir).
- **Hacer**: `rutaArchivo` con tres uuid; `validarRuta` acepta `xml/…xml` y `archivos/…zip` y rechaza mezclas (`archivos/…xml`, `xml/…zip`), `..`, mayúsculas, absolutas, NUL y nombres libres; `MockStorage` y `LocalStorage` guardan y leen un `.zip`; `sha256Hex` de bytes y de texto (UTF-8) contra vectores conocidos; `leerVerificado` devuelve los bytes si coinciden y lanza `ArchivoAlteradoError` (sin ruta ni hash en el mensaje) si se alteró o truncó un byte.
- **Hecho cuando**: fallan por «no implementado»; las de 016 siguen verdes. Commit `test(012b): storage de archivos en rojo`.

## T4 · [ ] Pruebas de BD, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D3, D4, D5, D6; CA-6, CA-7, CA-9), `plan.md` (Contratos: BD y orden de bloqueo), `packages/db/migrations/{0033_compra_hallazgo_periodo,0038_compra_worker_sin_update}.sql` (modelo de grants y triggers), `packages/db/src/compras/{periodo,filas-reemplazo}.ts`, `packages/db/src/ventas/{lectura,justificados}.ts`, `tests/aislamiento/{compras-soporte,ventas-soporte,compras-periodo.spec,compras-xml-tablas.spec}.ts` (modelo; no repetir).
- **Hacer**: `tests/aislamiento/archivos-{tablas,versiones,concurrencia}.spec.ts`, `ventas-periodo.spec.ts` y `packages/db/src/archivos/*.spec.ts`. Catálogo: RLS `FORCE` en las dos tablas, grants exactos (backend sin `INSERT`/`UPDATE`/`DELETE` en `archivo_generado`; nadie actualiza ni borra, ni el dueño de la migración por el trigger), CHECK de ruta, hashes, huella, nombres e impactos por libro. Triggers con el rol del worker: `compra_periodo`/`venta_periodo` solo `abierto` al insertar y solo `abierto|revisado → generado` (marcar `revisado` o reabrir → 42501); `archivo_generado` exige periodo `generado` por el mismo usuario y `version = max + 1`; el worker puede `SELECT` en `venta_salto_justificado` y no `INSERT`. Repositorios: `ultimaVersion`, `insertarVersion`, `listarVersiones`, `leerVersion` con otro estudio, cliente, periodo o libro → nada; numeración independiente por cliente, periodo y libro; `leerFilasReemplazoVentas` (original = SIRE, vigente = todas). Concurrencia: generar contra una escritura de ventas y contra una acción de compras en ambos órdenes, sin interbloqueos (10 rondas). Las de 014 y 016 con el rol del worker siguen verdes (descarga con `FOR SHARE`). Actualizar `limpiar` de `tests/aislamiento/{compras,ventas}-soporte.ts` para borrar `archivo_generado` y `venta_periodo`.
- **Hecho cuando**: fallan por «no implementado»; las de 002–016 siguen verdes. Commit `test(012b): BD de archivos y estado de ventas en rojo`.

## T5 · [ ] Pruebas del worker, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D2, D4, D6, D10, D11; CA-2 a CA-4, CA-6 a CA-8, CA-13, CA-14), `plan.md` (Cola y worker), `packages/queue/src/catalogo.ts` (`XML_OBTENER` como modelo), `packages/queue/src/catalogo-016.spec.ts` (modelo), `apps/worker/src/trabajos/procesadores/{obtener-xml.int.spec.ts,descargar-propuesta.int.spec.ts}` (modelo), `apps/worker/test/{compras,ventas,xml}.ts`, `packages/sunat/src/formatos/empaquetar.ts` (firma).
- **Hacer**: `packages/queue/src/catalogo-012b.spec.ts` (forma exacta de `archivo.generar`). `apps/worker/src/trabajos/procesadores/generar-archivo{,.int}.spec.ts`: CA-2 (versión 1, `provisional`, hashes, ZIP en `archivos/{tenant}/{cliente}/{id}.zip`, TXT descomprimido con una línea por fila no excluida), compras y ventas; CA-3 (fila con error tras encolar → error sin reintento, estado anterior, sin versión ni ZIP); CA-4 (`NODE_ENV=production` → no genera, estado intacto); CA-7 (dos trabajos de la misma huella → una versión; reintento tras el commit → misma versión `nueva: false`; numeración por libro); CA-8 (huella cambiada → error, estado anterior); CA-14 (sin cambios → `nueva: false`); cliente archivado → error; falla de `insertarVersion` tras `guardar` → no queda ZIP; CA-13 (`resultado` y logs sin canarios ni rutas; no lee credenciales; 20.000 filas en < 5 s). Descarga de ventas con el periodo `generado` → `ErrorDatos` sin propuesta. Actualizar `limpiar` de `apps/worker/test/{compras,ventas}.ts` (y `bd.ts`/`despejar-bd.ts` si borran estudios).
- **Hecho cuando**: fallan por «no implementado». Commit `test(012b): worker de archivos en rojo`.

## T6 · [ ] Pruebas HTTP, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D1, D2, D5, D8, D9; CA-1, CA-3 a CA-6, CA-8 a CA-10, CA-12), `plan.md` (Contratos: HTTP), `apps/backend/src/modules/compras/{integracion-012,descarga}.int.spec.ts` y `apps/backend/src/modules/ventas/{agregar,descarga}.int.spec.ts` (modelo y soporte; no repetir), `apps/backend/test/{soporte-compras,soporte-ventas,soporte-acceso}.ts`, `apps/backend/src/aislamiento/hu40-api.int.spec.ts`.
- **Hacer**: `apps/backend/src/modules/archivos/{previo,generar,versiones,descarga}.int.spec.ts` y `apps/backend/src/modules/ventas/estado-periodo.int.spec.ts`. Previo (CA-1, CA-5, CA-10) de compras y ventas; `POST`: 202, 400 con claves extra, 403, 404 (asistente no asignado), 409 `cliente_archivado`, `estado_invalido`, `resumen_cambiado` (CA-8), 422 `formato_no_oficial` (CA-4) y `prevalidacion_fallida` sin encolar ni cambiar estado (CA-3), dos `POST` simultáneos → un trabajo (CA-7); versiones y descarga (bytes con SHA-256 = `sha256Zip`, cabeceras de D8, ZIP alterado → 500 sin bytes, CA-12); aislamiento (CA-9: `archivoId` de otro estudio, cliente, periodo o libro → 404); P-4 (asistente asignado ve previo, versiones y descarga). Compras `generado` → 409 al editar (CA-6). Ventas: revisar y reabrir (409 `estado_invalido` con estado visto viejo), y con `generado` descargar, importar, agregar, quitar, justificar y revertir → 409 `periodo_generado`; con `revisado`, S-1. Casos HU-40 de las seis rutas nuevas. Actualizar `limpiar` de `apps/backend/test/{soporte-acceso,soporte-compras,soporte-ventas}.ts`.
- **Hecho cuando**: fallan por «no implementado» (404 de ruta inexistente o módulo ausente); «toda ruta tiene caso» de HU-40 en rojo solo por las rutas nuevas. Commit `test(012b): API de archivos y estado de ventas en rojo`.

## T7 · [ ] Dominio (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: Dominio; Decisiones), `spec.md` (D1, D2, D6, D7), las pruebas de T1, los archivos de `domain` que cita T1, `eslint.config.mjs` (bloque «Dinero» y `GLOBALES_IO_DOMINIO`), `packages/domain/vitest.cobertura.config.mts`.
- **Hacer**: `FilaReemplazoVenta` y ventas en `prevalidar`/`resumirCambios` (sobrecargas por `cabecera.libro`) y en `generarTxt` (valores de ventas, sin `sinGenerarVentas`); `src/archivos/` (adaptadores con D7, `canonHuella`, `prepararArchivo`, `permiteProvisional`); exportar desde `src/index.ts` (si suma exports públicos, avisar al tester por la lista cerrada de `ronda2b.adv.spec.ts`); lint y cobertura en `src/archivos/**`.
- **Hecho cuando**: T1 en verde y las de 012 sin cambios en verde; `test`, `typecheck` y `lint` de `domain` limpios; `pnpm cobertura:dominio` ≥ 90 % por archivo. Commit `feat(012b): ventas en la prevalidación y armado del archivo`.

## T8 · [ ] Esquemas de `shared` (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP), las pruebas de T2, `packages/shared/src/compras/{esquemas,respuestas}.ts`, `packages/shared/src/ventas/index.ts` y sus respuestas.
- **Hacer**: `packages/shared/src/archivos/` (esquemas, DTOs y códigos) y `estado` en el resumen de ventas; exportar.
- **Hecho cuando**: T2 en verde; `test`, `typecheck`, `lint` y `build` de `shared` limpios. Commit `feat(012b): esquemas de archivos`.

## T9 · [ ] Storage (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: Storage), las pruebas de T3, `packages/storage/src/*.ts` (sin pruebas).
- **Hacer**: `rutaArchivo`, `validarRuta` con las dos gramáticas, `hash.ts` (`sha256Hex`, `leerVerificado`), `ArchivoAlteradoError`; exportar.
- **Hecho cuando**: T3 en verde y las de 016 en verde; `test`, `typecheck` y `lint` del paquete limpios; `pnpm cobertura:storage` ≥ 90 %. Commit `feat(012b): storage de archivos generados`.

## T10 · [ ] Migraciones y repositorios (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Archivos: migraciones; Contratos: BD y orden de bloqueo; Decisiones), `spec.md` (D3, D5, D6), las pruebas de T4, `packages/db/migrations/{0033_compra_hallazgo_periodo,0035_documento_xml,0038_compra_worker_sin_update}.sql` y `meta/_journal.json`, `packages/db/src/schema/{compras,ventas,index}.ts`, `packages/db/src/compras/{periodo,filas-reemplazo}.ts`, `packages/db/src/ventas/{lectura,tipos}.ts`, `packages/db/src/propuestas/repositorio.ts` (`bloquearPeriodoLibro`).
- **Hacer**: confirmar que 0039 sigue libre; `0039_venta_periodo.sql` (tabla, RLS, grants, trigger `periodo_worker_acotado` en las dos tablas de estado, `SELECT` de justificados al worker) y `0040_archivo_generado.sql` (tabla, CHECK, grants, triggers), con funciones `SECURITY INVOKER` o `DEFINER` de dueño `contapp_migrator`, `search_path` fijo y mensajes fijos, repetibles sentencia a sentencia como 0037/0038; esquema drizzle y diario; `src/ventas/{periodo,filas-reemplazo}.ts` y `src/archivos/`; exportar.
- **Hecho cuando**: T4 en verde; `pnpm test:aislamiento` y `pnpm --filter @contapp/db test` verdes (002–016 incluidas); `db:migrate` dos veces sin error; `pnpm cobertura:db` ≥ 90 % con `src/archivos/**`. Commit `feat(012b): archivo_generado y estado del periodo de ventas`.

## T11 · [ ] Worker (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Cola y worker; orden de bloqueo), `spec.md` (D2, D4, D6, D10, D11), las pruebas de T5, `packages/queue/src/catalogo.ts`, `apps/worker/src/trabajos/procesadores/{obtener-xml,descargar-propuesta}.ts` (modelo), `apps/worker/src/trabajos/persistidores/{compras,ventas}.ts`, `apps/worker/src/trabajos/iniciar.ts`, `apps/worker/src/adaptadores/adaptadores.module.ts`, `packages/sunat/src/formatos/empaquetar.ts`.
- **Hacer**: `ARCHIVO_GENERAR` en el catálogo; `generar-archivo.ts` con la secuencia del plan en una transacción y el borrado del ZIP si falla; registrar el procesador y la cola `archivos`; el persistidor de ventas lee `venta_periodo` con `FOR SHARE` y rechaza `generado`.
- **Hecho cuando**: T5 en verde; las de 013, 014 y 016 del worker siguen verdes; `test`, `test:int`, `typecheck` y `lint` de `queue` y `worker` limpios. Commit `feat(012b): generación del archivo en el worker`.

## T12 · [ ] Backend de archivos (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP; Dominio: `prepararArchivo`), `spec.md` (D1, D2, D8, D9), las pruebas de T6 (archivos, aislamiento y HU-40 de archivos), `apps/backend/src/modules/compras/{compras.controller,compras.service,xml.controller,xml.service,errores}.ts` (modelo de guards, `exigirCliente`, descarga con cabeceras), `apps/backend/src/modules/trabajos/encolador.ts`, `apps/backend/src/modules/storage/storage.module.ts`, `apps/backend/src/app.module.ts`.
- **Hacer**: módulo `archivos` con un controlador por libro sobre el mismo servicio; previo en `withTenant({ foto: true })` con `prepararArchivo` (`reglas` siempre en compras, justificados en ventas) y `permiteProvisional(NODE_ENV)`; `POST` con el orden de comprobaciones del plan y encolado con el `Encolador`; versiones; descarga con `leerVerificado`.
- **Hecho cuando**: las pruebas de T6 de archivos, descarga, P-4 y sus casos HU-40 pasan; las de 014 a 016 siguen verdes; `test`, `typecheck` y `lint` del backend limpios. Commit `feat(012b): previo, generación, versiones y descarga`.

## T13 · [ ] Backend de ventas (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP, estado de ventas, S-1; orden de bloqueo), `spec.md` (D5, P-1), las pruebas de T6 (estado y 409 de ventas, HU-40 de estado), `apps/backend/src/modules/ventas/{ventas.controller,ventas.service,importar-propuesta.service,errores}.ts`, `apps/backend/src/modules/compras/{periodo.service,compras-acciones.controller}.ts` (modelo de revisar y reabrir).
- **Hacer**: `estado.service.ts` y las rutas `estado/revisar` y `estado/reabrir`; en cada escritura de ventas, tras `bloquearPeriodoLibro`, leer `venta_periodo` con `FOR SHARE` y responder 409 `periodo_generado` (y S-1 con `revisado`); la descarga lo comprueba al encolar; `estado` en el resumen.
- **Hecho cuando**: las pruebas de T6 de ventas pasan; las de 013 siguen verdes; `test`, `typecheck` y `lint` del backend limpios. Commit `feat(012b): estado del periodo de ventas`.

## T14 · [ ] Panel «Generar archivo» en compras (frontend · sonnet; nivel C)
- **Contexto (leer solo esto)**: `plan.md` (Frontend), `spec.md` (D1, D2, D5, D9, P-4, P-7; CA-1, CA-9, CA-12), `apps/frontend/AGENTS.md`, `packages/shared/src/archivos/*` (de T8), `apps/frontend/lib/{compras,trabajos}.ts`, `apps/frontend/components/compras/{estado-periodo,grilla-compras}.tsx`, `apps/frontend/app/(app)/clientes/[clienteId]/compras/page.tsx`, `apps/frontend/pruebas/compras.ts`.
- **Hacer**: `lib/archivos.ts` y `components/archivos/{panel-generar,previo-archivo,versiones-archivo}.tsx`; integrarlos en la página de compras junto a `estado-periodo`; enlaces de error que ubican la fila en la grilla; «Generar» solo con permiso; recarga del previo ante 409 o trabajo en error; «Descargar»; montos como texto; sin `dangerouslySetInnerHTML`.
- **Hecho cuando**: un caso feliz y uno de error por comportamiento pasan (previo con errores y enlace, generar y seguir el trabajo, 409 `resumen_cambiado` recarga, sin permiso no hay botón, provisional marcado, descarga); la prueba estática de montos cubre los archivos nuevos; `test`, `typecheck` y `lint` del frontend limpios. Commit `feat(012b): panel para generar el archivo de compras`.

## T15 · [ ] Ventas: estado y panel (frontend · sonnet; nivel C)
- **Contexto (leer solo esto)**: `plan.md` (Frontend; S-1), `spec.md` (D5, P-1, P-6; CA-10), lo creado en T14, `apps/frontend/lib/ventas.ts`, `apps/frontend/components/ventas/{grilla-ventas,agregar-venta,justificar-salto,descarga-ventas,correlatividad-ventas}.tsx`, `apps/frontend/app/(app)/clientes/[clienteId]/ventas/{page,importar/page}.tsx`, `apps/frontend/components/compras/estado-periodo.tsx`.
- **Hacer**: `estado-periodo-ventas.tsx` (marcar revisado, reabrir con estado visto) reutilizando el de compras; deshabilitar descargar, importar, agregar, quitar, justificar y revertir con `generado` (y con `revisado` sin permiso) con mensaje de 409; el panel de T14 en ventas con la explicación de P-6 en los errores.
- **Hecho cuando**: un caso feliz y uno de error por flujo pasan (generar ventas con el aviso de la 291, descuadrada bloquea con la explicación, escrituras deshabilitadas con `generado`, reabrir); `test`, `typecheck` y `lint` limpios. Commit `feat(012b): estado y archivo de ventas`.

## T16 · [ ] Cobertura en CI (devops · haiku)
- **Contexto (leer solo esto)**: `package.json` (scripts `cobertura:*`, `ci:db`, `ci:cierre`), `.github/workflows/ci.yml` (pasos de cobertura), `apps/backend/vitest.cobertura-xml.config.mts` y `apps/worker/vitest.cobertura-xml.config.mts` (modelo), `packages/domain/vitest.cobertura.config.mts`, `packages/db/vitest.cobertura.config.mts`.
- **Hacer**: `vitest.cobertura-archivos.config.mts` en backend (`modules/archivos/**` y `modules/ventas/estado.service.ts`) y en worker (`generar-archivo.ts`), con el script raíz `cobertura:archivos` (compila `shared`, `storage`, `db`, `crypto`, `domain`, `sunat` y `queue` antes) en el job con Postgres y Redis; confirmar `src/archivos/**` en `domain` y en `db`; umbral 90 % por archivo.
- **Hecho cuando**: `cobertura:archivos`, `cobertura:dominio`, `cobertura:storage` y `cobertura:db` corren en local con ≥ 90 % (o se informa el archivo bajo el umbral, sin bajarlo); `ci.yml` válido. Commit `ci(012b): cobertura de archivos`.

## T17 · [ ] Ronda adversarial 1 (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (D2, D3, D7, D8, D9, D10; CA-4, CA-9, CA-11, CA-12; Ataques obligatorios), `plan.md` (Storage, BD, HTTP), 04 §2.3 (catálogos «Formatos TXT/ZIP», «Aislamiento», «Permisos y alcance»), las pruebas de T1 a T6 (para no repetir); en caja blanca, `packages/domain/src/archivos/`, `formatos/valores.ts`, `packages/storage/src/`, `packages/db/migrations/{0039,0040}_*.sql`, `apps/backend/src/modules/archivos/`.
- **Hacer**: caja negra y luego blanca, ≤ 15 pruebas. TXT/ZIP: razón social con `|`, saltos, ñ, pares sustitutos y NBSP en el borde de 100, campos vacíos, periodo de otro año, consumidor final, montos enormes y negativos (notas de crédito). Descarga: `archivoId`/`clienteId` cruzados entre estudios, libros y periodos, ZIP alterado o truncado, ruta con `../` o un uuid ajeno escrita directo en BD, nombre de archivo hostil. Permisos: asistente contra `POST`, cliente desasignado o archivado con sesión viva, `permitirProvisional`/`registro`/`NODE_ENV` en la petición. Privilegios del worker: con el rol `contapp_worker`, intentar reabrir o marcar `revisado`, insertar una versión sin `generado`, con otro usuario o saltando números, leer o escribir otras tablas de 012b. No escribe código de producción.
- **Hecho cuando**: cada prueba pasa (la defensa aguanta) o falla con un hallazgo `H-012b-n` (severidad, archivo y línea de la causa); informe al orquestador para «Hallazgos adversariales abiertos» de `ESTADO.md`.

## T18 · [ ] Pruebas de las correcciones de la ronda 1, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: el informe de T17, los `*.adv*.spec.ts` que fallan, `spec.md` (las D citadas en cada hallazgo).
- **Hacer**: una prueba propia (no adversarial) por hallazgo que fija el comportamiento correcto según la spec; si un hallazgo pide cambiar la spec, `requiere usuario`.
- **Hecho cuando**: las pruebas fallan por el defecto, no por sintaxis. Commit `test(012b): correcciones de la ronda 1 en rojo`.

## T19 · [ ] Corregir la ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: el informe de T17, las pruebas de T18, los archivos citados en cada hallazgo.
- **Hacer**: corregir la causa sin tocar pruebas; una migración nueva (0041 en adelante) si hace falta, nunca editar 0039/0040 si ya se aplicaron en otra rama.
- **Hecho cuando**: T18 y los `*.adv*` de T17 en verde; suites de los paquetes tocados verdes; cobertura ≥ 90 % sin cambios de umbral. Commit `fix(012b): hallazgos de la ronda 1`.

## T20 · [ ] Ronda adversarial 2 (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (D4, D5, D6, P-1, P-2, P-5; CA-3, CA-6 a CA-8, CA-14; Ataques obligatorios), `plan.md` (orden de bloqueo, Cola y worker), 04 §2.3 («Cola / despachador»), las pruebas de T4 a T6 (para no repetir); en caja blanca, `apps/worker/src/trabajos/procesadores/generar-archivo.ts`, `packages/db/src/{archivos,ventas}/`, `apps/backend/src/modules/{archivos,ventas}/`.
- **Hacer**: ≤ 15 pruebas. Doble clic y `POST` con huellas distintas a la vez; reintento después del commit; worker que muere tras `storage.guardar`; generar mientras otro edita compras, acepta en bloque, deshace, descarga, importa o agrega ventas, reabre o marca revisado (en ambos órdenes, varias rondas); fila mutada entre previo, encolado y worker; XML que llega durante la generación (016 D-7: la huella no cambia, el archivo tampoco); periodo sin filas o con todas excluidas (`SIN_FILAS`); compras y ventas del mismo periodo a la vez; un estudio con muchos trabajos `archivo.generar` frente a otro. Regresión de la ronda 1.
- **Hecho cuando**: igual que T17 (`H-012b-n` continúa la numeración).

## T21 · [ ] Pruebas de las correcciones de la ronda 2, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: el informe de T20, los `*.adv*` que fallan, `spec.md` (las D citadas).
- **Hacer** y **Hecho cuando**: como T18. Commit `test(012b): correcciones de la ronda 2 en rojo`.

## T22 · [ ] Corregir la ronda 2 (backend · opus)
- **Contexto (leer solo esto)**: el informe de T20, las pruebas de T21, los archivos citados.
- **Hacer** y **Hecho cuando**: como T19, más `pnpm test:aislamiento` verde. Commit `fix(012b): hallazgos de la ronda 2`.

## T23 · [ ] Prueba manual contra el sistema completo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-14), `docs/specs/016-lupa-xml/tasks.md` (T24, como modelo de entorno e informe), scripts `servicios:up`, `db:migrate`, `db:seed` y `dev` del `package.json` raíz.
- **Hacer**: BD y Redis propios (borrados al terminar), mocks, `STORAGE=local` en el scratchpad. Compras 202610 del cliente de fixtures: previo con errores (mixta) y enlaces, aceptar sugerencias, generar como Dueño, seguir el trabajo, descargar y descomprimir el ZIP (líneas, zapatilla fuera, hash), editar con `generado` (409), reabrir, corregir y versión 2, generar sin cambios (P-5), versión 1 aún descargable; asistente asignado (ve y descarga, no genera) y no asignado (404). Ventas: boleta 291, venta descuadrada (bloquea con la explicación), revisar, generar, escrituras con `generado`, reabrir. `NODE_ENV=production` con el formato provisional (backend y worker). Barrido de logs por canarios. Anotar cada defecto con pasos y archivo probable.
- **Hecho cuando**: informe de pasos con resultado; los defectos de pantalla van a T23a y los de servidor al orquestador. Sin commit si no hay cambios.

## T24 · [ ] Verificar criterios (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-14 y casos reales), los informes de T17, T20 y T23.
- **Hacer**: suites completas (`pnpm test`, `test:aislamiento`, `ci:db`), `cobertura:archivos`, `cobertura:dominio`, `cobertura:storage`, `cobertura:db` y los de siempre; por cada CA, la prueba o el comando que lo demuestra (`archivo:línea`) o «falta».
- **Hecho cuando**: tabla CA → evidencia en la sección «Resultado» de esta tarea; cobertura ≥ 90 % en `domain/archivos`, `storage`, `db/archivos`, el módulo de archivos del backend y `generar-archivo.ts`; ningún adversarial abierto. Commit `docs(012b): verificación de criterios`.

## T25 · [ ] Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, la tabla de T24, `git diff main...spec/012b-generar-archivo --stat` y los archivos que la tabla marque dudosos, `docs/03-arquitectura.md` §7.3.
- **Hacer**: verificar cada CA con su evidencia; comprobar capas, dinero, RLS, privilegios del worker y secretos; ratificar o rechazar los desvíos del plan; actualizar 03 §7.3 (previo, huella, transacción del worker, versiones); dejar las notas para ESTADO (cierra [012b]; abre [oficial] del RVIE y P-8 si sigue abierta).
- **Hecho cuando**: lista de lo que falta (vacía o convertida en T25a/T25b) y desvíos ratificados en `plan.md`. Commit `docs(012b): revisión final`.

## T26 · [ ] Cierre (devops · haiku)
- **Contexto (leer solo esto)**: este `tasks.md`, `git status`.
- **Hacer**: marcar las tareas, `Estado: hecha` en `spec.md` con la fecha y los CA en `[x]` según T24 y T25.
- **Hecho cuando**: `git status` limpio salvo lo ajeno. Commit `docs(012b): cierre`.
