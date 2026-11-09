# Tareas 016 · Lupa del comprobante y XML

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con las indicadas (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A (spec P-1) con la lupa del frontend como C por tarea (T15, T16: pruebas mínimas, sin TDD ni ADV). Flujo 04 §1.3: andamiaje → pruebas primero (rojo) → implementar (verde) → cobertura → atacar (2 rondas) → corregir (con pruebas del tester) → prueba manual → verificar → revisión de Opus → cerrar. Rama `spec/016-lupa-xml`. CA, D y P = `spec.md`; contratos y decisiones = `plan.md`.

| #   | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
| --- | ----- | --- | ------ | ---------- | --- | --- | ------ |
| T1  | Andamiaje: `packages/storage`, `fast-xml-parser` en `domain`, variables y `.gitignore` | devops | haiku | — | — | — | [ ] |
| T2  | Pruebas del parser UBL y del dominio: CA-1 a CA-5, mapeo, identidad, lotes, evaluar con XML (rojo) | tester | sonnet | — ∥ T1 | ✓ | — | [ ] |
| T3  | Pruebas de `packages/storage` (rojo) | tester | sonnet | T1 ∥ T2, T4, T5 | ✓ | — | [ ] |
| T4  | Pruebas de los esquemas de `shared/xml` (rojo) | tester | sonnet | — ∥ T2, T3, T5 | ✓ | — | [ ] |
| T5  | Pruebas de BD: tablas, RLS, backfill, evaluación numerada, re-evaluación concurrente (rojo) | tester | sonnet | — ∥ T2–T4 | ✓ | — | [ ] |
| T6  | Pruebas del worker: catálogo, `xml.obtener`, lotes tras la descarga: CA-6, CA-10, CA-11 (rojo) | tester | sonnet | T4 ∥ T7 | ✓ | — | [ ] |
| T7  | Pruebas HTTP: detalle, obtener, subir, descargar, desde XML, aceptar y masiva con XML (rojo) | tester | sonnet | T4 ∥ T6 | ✓ | — | [ ] |
| T8  | Parser UBL, `aResumenXml`, identidad, lotes, `crearEvaluarCompras` con XML y lint | backend | opus | T1, T2 | ✓ | — | [ ] |
| T9  | `packages/storage`: puerto, `MockStorage`, `LocalStorage` | backend | sonnet | T1, T3 ∥ T8, T10, T11 | ✓ | — | [ ] |
| T10 | Esquemas y DTOs de `shared/xml` | backend | sonnet | T4 ∥ T8, T9, T11 | ✓ | — | [ ] |
| T11 | Migraciones 0035–0036, esquema drizzle, `packages/db/src/xml/` y evaluación numerada en 014 | backend | opus | T5 ∥ T8–T10 | ✓ | — | [ ] |
| T12 | Worker: `xml.obtener`, procesador, storage y lotes tras la descarga | backend | sonnet | T6, T8, T9, T11 ∥ T13 | ✓ | — | [ ] |
| T13 | Backend de lectura: detalle, descargar XML, obtener y módulo de storage | backend | sonnet | T7, T8, T9, T10, T11 ∥ T12 | ✓ | — | [ ] |
| T14 | Backend de escritura: subir XML, agregar desde XML, XML en aceptar y masiva | backend | sonnet | T13 | ✓ | — | [ ] |
| T15 | Lupa: modal, cabecera, ítems, comparación, historial, acciones y teclado (nivel C) | frontend | sonnet | T10 ∥ T11–T14 | — | — | [ ] |
| T16 | Subir XML en la lupa y «Agregar desde XML» (nivel C) | frontend | sonnet | T15 | — | — | [ ] |
| T17 | Cobertura ≥ 90 %: `ubl/`, `storage`, módulos XML de backend y worker, en CI | devops | haiku | T12, T14 ∥ T15, T16 | — | — | [ ] |
| T18 | Ronda adversarial 1: parser y subida (caja negra, luego blanca; ≤ 15 pruebas) | adversario | opus | T12, T14, T17 | — | ✓ | [ ] |
| T19 | Pruebas de las correcciones de la ronda 1 (rojo) | tester | sonnet | T18 | ✓ | — | [ ] |
| T20 | Corregir los hallazgos de la ronda 1 | backend | opus | T19 | — | — | [ ] |
| T21 | Ronda adversarial 2: re-evaluación y aceptación en bloque (≤ 15 pruebas) | adversario | opus | T20 | — | ✓ | [ ] |
| T22 | Pruebas de las correcciones de la ronda 2 (rojo) | tester | sonnet | T21 | ✓ | — | [ ] |
| T23 | Corregir los hallazgos de la ronda 2 | backend | opus | T22 | — | — | [ ] |
| T24 | Prueba manual contra el sistema completo | tester | sonnet | T16, T23 | — | — | [ ] |
| T25 | Verificar CA-1 a CA-18 con evidencia, suites completas y cobertura | tester | sonnet | T24 | — | — | [ ] |
| T26 | Revisión final contra la spec | arquitecto | opus | T25 | — | — | [ ] |
| T27 | Cierre: `tasks.md` y commit (el orquestador actualiza ESTADO) | devops | haiku | T26 | — | — | [ ] |

Paralelismo: T1 ∥ T2 ∥ T4 ∥ T5 (T3 espera el paquete de T1); T6 ∥ T7. Implementación en cuatro carriles independientes: T8 (`domain`) ∥ T9 (`storage`) ∥ T10 (`shared`) ∥ T11 (`db`). Luego T12 (`apps/worker`) ∥ T13 (`apps/backend`); T14 va tras T13 porque comparten `compras.module.ts` y `app.ts`. El frontend (T15 → T16) corre en paralelo con T11–T14 contra el contrato de `shared` (sus pruebas simulan la API) y T17 con T15–T16. Las rondas y sus correcciones van en serie (T18 → T20 → T21 → T23): la ronda 2 debe ver las correcciones de la 1. Si una ronda no deja fallos, se saltan sus dos tareas de corrección (se marcan `[x]` «sin hallazgos»).

Escalamientos: T8 y T11 nacen en `opus` (dinero, parser hostil, RLS y orden de bloqueo; 04 §3.2). T12 o T14 pasan a `opus` si fallan 2 veces (re-evaluación concurrente). T1 y T17 pasan a `sonnet` si `haiku` falla una vez. T18 y T21 son `opus` por regla. T20 y T23 en `opus` porque tocan parser y re-evaluación. Si T24 encuentra defectos de pantalla se añade T24a (frontend · sonnet) con el precedente de 015 T12; si T26 encuentra defectos, T26a (pruebas en rojo) y T26b (corrección), como 014 T22a/T22b.

Reglas comunes:

- Un commit por tarea (Conventional Commits `test(016): …`, `feat(016): …`, `fix(016): …`, `chore(016): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push del subagente: el orquestador lo hace.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` ajenos: `git add <rutas>` explícitas, nunca `-A` ni `.`.
- **Nunca** imprimir ni commitear secretos ni el contenido de `.env`. Las pruebas usan canarios (cadenas únicas en glosas, razón social y montos) que se buscan en respuestas, logs, errores y `resultado`. Ningún `console.log` ni mensaje con XML, montos, glosas, razones sociales ni rutas de storage (D-11).
- Checks: responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo. Correr solo las pruebas del paquete afectado; las suites completas en T25.
- El tester no toca código de producción; backend y frontend no editan `*.spec.ts` ajenos; solo T18 y T21 escriben `*.adv.spec.ts` / `*.adv.int.spec.ts`. Las pruebas de las correcciones las escribe el tester, no quien corrige. El frontend (nivel C) escribe sus propias pruebas mínimas.
- Migraciones: 016 usa **0035** y **0036**; confirmar con `ls packages/db/migrations` y el diario antes de crear; nunca editar una aplicada. Si 012b llega antes a `main`, renumerar las de 016 (plan, «Archivos»). Las pruebas de 002–015 siguen en verde.
- Montos: cadenas decimales / `Money`; ningún `number` para dinero en `ubl/`, repositorios, DTOs ni pantallas. Toda consulta de negocio dentro de `withTenant()`; nunca desactivar RLS. `apps/backend` nunca importa `@contapp/sunat`. Adaptadores en `mock` (`XML_PROVIDER=mock`, `STORAGE=mock`).
- Dependencias nuevas con versión exacta y ≥ 2 semanas publicadas: solo `fast-xml-parser` 5.11.2 en `domain` (T1, ya está en el lockfile por el backend).
- P-9 (USD en «agregar desde XML») decidida (a): en USD se pide el tipo de cambio además del destino; T7, T14 y T16 cubren PEN y USD (plan, «Decisión P-9»). Una ambigüedad nueva que cambie la spec no se decide: `requiere usuario` y se informa al orquestador.

## T1 · [ ] Andamiaje (devops · haiku)
- **Contexto (leer solo esto)**: `plan.md` (Archivos; Storage), `packages/crypto/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.mts}` (modelo de paquete), `packages/domain/package.json`, `apps/backend/package.json` (línea de `fast-xml-parser`), `eslint.config.mjs` (solo `POLITICAS` y las líneas que nombran `storage`), `.env.example`, `.gitignore`, `pnpm-workspace.yaml`.
- **Hacer**: crear `packages/storage` (`@contapp/storage`, depende solo de `@contapp/shared`; scripts `build`, `typecheck`, `lint`, `test`, `test:cobertura`; `src/index.ts` vacío exportable) y confirmar que la política de límites de `eslint.config.mjs` le aplica (solo `shared`). `pnpm --filter @contapp/domain add --save-exact fast-xml-parser@5.11.2`. Agregar a `.env.example` `STORAGE=mock`, `STORAGE_DIR=./storage` y `XML_SIMULADO_EN_REGLAS=1` (con comentario: por defecto el código la toma como `0`); `storage/` en `.gitignore`.
- **Hecho cuando**: `pnpm install --frozen-lockfile`, `typecheck`, `lint` y `build` OK; el lockfile solo cambia en el importador de `domain` (ninguna versión nueva). Commit `chore(016): paquete storage y dependencias`.

## T2 · [ ] Pruebas del parser UBL y del dominio, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-1, D-2, D-3, D-6, D-7, P-4, P-5; CA-1 a CA-6, CA-9, CA-10, CA-16), `plan.md` (Contratos: Dominio, Parser seguro), `fixtures/xml/*.xml`, `packages/domain/src/reglas/tipos.ts` (`ResumenXml`), `packages/domain/src/compras/evaluar.ts`, `packages/domain/src/dinero/index.ts` (`redondearSunat`), `packages/domain/src/texto/codificar.ts`, `packages/sunat/src/mock/ubl-sintetico.ts` (solo la forma que genera).
- **Hacer**: `packages/domain/src/ubl/*.spec.ts` y `compras/{obtencion,evaluar-xml}.spec.ts`. Casos: los cinco fixtures con sus montos de CA-3 a CA-5; 2056 re-codificado en ISO-8859-1 con otros prefijos de espacio de nombres (generado en la prueba con `codificar`); el UBL sintético de 009 con y sin ISC; nota de crédito negativa; `currencyID` mezclado → `monedaUnica = false`; 3 decimales → `redondearSunat`; totales fuera de NUMERIC(14,2) y sin `PayableAmount` ni `TaxInclusiveAmount`; 9995/9996 no suman; glosa > 500 recortada y con `<script>` intacta como texto. Seguridad (CA-1, CA-2): XXE a `file:///etc/passwd`, entidad externa HTTP, «billion laughs», `<!DOCTYPE` dentro de un comentario, UTF-16, byte NUL, codificación no admitida, 1 MiB + 1, 2.001 ítems, profundidad 33; cada uno `xml_invalido` en < 100 ms y el mensaje no contiene el canario de la entrada. `compararIdentidad` (RUC, serie con minúsculas, número con ceros, receptor). `planificarObtencionXml` (orden con hallazgos primero, lotes de 100, omite guardados, `pendiente`, `no_encontrado`, `credencial`). `crearEvaluarCompras` con XML: R-MIX exacto 8.97 / 12.51 sin confirmación (CA-6), R-ISC 770.00 (CA-7), PEN con XML USD → sin sugerencias del XML (CA-9), simulado con la bandera apagada = como sin XML (CA-16).
- **Hecho cuando**: las pruebas compilan contra las firmas del plan y fallan por «no implementado»; las demás de `domain` siguen verdes. Commit `test(016): parser UBL y dominio en rojo`.

## T3 · [ ] Pruebas de `packages/storage`, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Storage), `packages/storage/package.json` (de T1), `packages/sunat/src/mock/ruta-fixture.spec.ts` (modelo de pruebas de rutas).
- **Hacer**: `packages/storage/src/*.spec.ts`: ida y vuelta en `MockStorage` y `LocalStorage` (directorio temporal), `rutaXml` con uuid; rechazo de `..`, ruta absoluta, NUL, barras invertidas, nombre libre y enlace simbólico que sale de la raíz; `leer` de lo inexistente lanza un error propio sin la ruta; `eliminar` idempotente; escritura atómica (no queda archivo parcial si falla); `mock` en producción sin `PERMITIR_ADAPTADORES_MOCK` no arranca.
- **Hecho cuando**: fallan por «no implementado». Commit `test(016): storage en rojo`.

## T4 · [ ] Pruebas de `shared/xml`, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP, `DetalleCompraDto`), `packages/shared/src/xml/origen.ts`, `packages/shared/src/compras/{esquemas,respuestas}.ts` (forma de hallazgos, `agregarCompraSchema`, `FilaCompraVista`).
- **Hacer**: `packages/shared/src/xml/*.spec.ts`: `origenDocumentoXmlSchema`; `detalleCompraSchema` (montos solo como cadenas decimales, `xml` como unión discriminada con sus cuatro estados y códigos, `items` ≤ 2.000, glosa ≤ 500); `vistaPreviaDesdeXmlSchema`; destino de `desde-xml`; códigos `xml_invalido`, `xml_incompleto`, `xml_ajeno {campos}`, `xml_existente`. `origenXmlSchema` no cambia.
- **Hecho cuando**: fallan por «no implementado»; las de `shared` existentes siguen verdes. Commit `test(016): esquemas de XML en rojo`.

## T5 · [ ] Pruebas de BD, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-4, D-5, D-10; CA-6, CA-8, CA-10), `plan.md` (Contratos: BD, packages/db, orden de bloqueo), `tests/aislamiento/compras-soporte.ts`, `tests/aislamiento/compras-tablas.spec.ts` y `compras-versiones.spec.ts` (modelo; no repetir), `packages/db/src/compras/repositorio.ts` (`evaluarYGuardar`, `escribirVersiones`), `packages/db/src/compras/lectura.ts` (líneas de `compra_hallazgo`).
- **Hacer**: `tests/aislamiento/compras-xml-{tablas,evaluacion,concurrencia}.spec.ts` y `packages/db/src/xml/*.spec.ts`. Catálogo: RLS `FORCE`, grants (sin `UPDATE`/`DELETE` salvo `documento_xml_obtencion`), CHECK de `origen`/`subido_por`/`tamano`, FK compuestas, otro estudio no ve nada. Backfill: hallazgos sembrados antes de 0036 quedan en la evaluación 1. Evaluación numerada: re-evaluar la misma versión inserta `n = 2` sin choque; vigentes = última; listado `con_hallazgos` y detalle las usan; versión nueva → evaluación 1 con el XML vigente. `guardarDocumentoXml`: P-6 (simulado → subido sí; subido → 409), `n` correlativo con dos subidas simultáneas. Concurrencia (CA-8): edición y llegada del XML en ambos órdenes y 10 rondas → la versión final evaluada con XML; sin interbloqueos con masiva y deshacer.
- **Hecho cuando**: fallan por «no implementado»; las de 002–015 siguen verdes. Commit `test(016): BD de XML y evaluación numerada en rojo`.

## T6 · [ ] Pruebas del worker, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-7, D-11, P-4, P-7; CA-6, CA-10, CA-11, CA-17), `plan.md` (Cola y worker), `packages/queue/src/catalogo.ts` (`CLIENTE_CONSULTAR_RUC` como modelo), `packages/queue/src/catalogo-013.spec.ts` (modelo), `apps/worker/src/trabajos/procesadores/{consultar-ruc.int.spec.ts,descargar-propuesta.int.spec.ts}` (modelo), `packages/sunat/src/mock/xml-provider.mock.ts` (centinelas e `inyectar`), `apps/worker/src/trabajos/persistidores/tipos.ts`.
- **Hacer**: `packages/queue/src/catalogo-016.spec.ts` (forma exacta de `xml.obtener`: cola `xml`, canal `ninguno`, credencial `null`, 1–100 uuid). `apps/worker/src/trabajos/procesadores/obtener-xml{,.int}.spec.ts`: CA-10 (tras la descarga de fixtures se encolan lotes, primero con hallazgos; repetir no duplica trabajos ni `documento_xml`; el registro del mock no muestra lo ya guardado), CA-11 (centinelas 8, 7, 9 → `no_encontrado`, reintento de 008, `credencial` sin reintento y sin tocar la credencial del cliente), CA-6 con `XML_SIMULADO_EN_REGLAS=1` (evaluación nueva con R-MIX exacto, versión intacta) y con `0` (sin evaluación), XML inyectado hostil o ajeno → no se guarda nada en storage ni BD, `resultado` solo con conteos y sin canarios.
- **Hecho cuando**: fallan por «no implementado». Commit `test(016): worker de XML en rojo`.

## T7 · [ ] Pruebas HTTP, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-3, D-6, D-7, D-8, D-9, D-11, P-6, P-9; CA-2, CA-6 a CA-9, CA-12 a CA-18), `plan.md` (Contratos: HTTP y `DetalleCompraDto`), `apps/backend/src/modules/compras/{lectura,acciones,masivas}.int.spec.ts` (modelo y soporte; no repetir), `apps/backend/src/modules/importacion/importacion.adv.int.spec.ts` (cuerpo crudo).
- **Hacer**: `apps/backend/src/modules/compras/{detalle,xml,desde-xml}.int.spec.ts`. Detalle de F001-2056 con cabecera, ítems, comparación y explicación de R-MIX (CA-14) y < 500 ms p95 con 500 ítems (CA-18); `xml` en sus cuatro estados; subir el mismo comprobante (CA-12), ajeno por cada campo (422 con el campo), no XML, 1 MiB + 1 → 413 sin nada en storage ni BD (CA-2), P-6 (simulado → subido 200; subido → 409); descarga con `attachment` y `nosniff`; aislamiento 404 en las cuatro rutas (CA-17); obtener → 202 e idempotente; desde XML: vista previa sin escribir, alta con destino, 409 `duplicado {id}` (CA-13), USD (F001-4062) con tipo de cambio → 201 con el TC guardado, USD sin TC o PEN con TC → 400 sin nada en storage ni BD, vista previa con `requiereTipoCambio` (P-9); masiva acepta R-MIX tras el XML y no ofrece las de un XML en otra moneda (CA-6, CA-9); aceptar una sugerencia evaluada antes del XML que ya no sale → 409 `revisar_de_nuevo` (CA-8); acciones desde la lupa con los mismos 409/422 de 014 (CA-15); ningún log contiene canarios (CA-17).
- **Hecho cuando**: fallan por «no implementado» (404 de ruta inexistente o módulo ausente). Commit `test(016): API de detalle y XML en rojo`.

## T8 · [ ] Parser UBL y dominio (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Dominio, Parser seguro), `spec.md` (D-1, D-2, D-3, D-6), las pruebas de T2, `packages/domain/src/reglas/{tipos,entrada}.ts` (solo `ResumenXml` y `leerXml`), `packages/domain/src/compras/evaluar.ts`, `packages/domain/src/dinero/index.ts`, `packages/domain/src/texto/codificar.ts`, `eslint.config.mjs` (bloque «Dinero» y `GLOBALES_IO_DOMINIO`), `packages/domain/vitest.cobertura.config.mts`.
- **Hacer**: `packages/domain/src/ubl/` según el plan (escaneo antes de todo, `decodificar` puro, `fast-xml-parser` con las opciones del plan, mapeo con `Money`), `compras/obtencion.ts`, `CompraEvaluable.xml` y la bandera en `crearEvaluarCompras`; exportar desde `src/index.ts` (si suma exports públicos, avisar al tester para la lista de `ronda2b.adv.spec.ts`). Ampliar el lint de dinero y «sin IO» a `ubl/` y la cobertura a `src/ubl/**`.
- **Hecho cuando**: las pruebas de T2 pasan; `pnpm --filter @contapp/domain test`, `typecheck` y `lint` limpios; `pnpm cobertura:dominio` ≥ 90 % por archivo. Commit `feat(016): parser UBL y XML en las reglas`.

## T9 · [ ] `packages/storage` (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Storage), las pruebas de T3, `packages/sunat/src/mock/ruta-fixture.ts` (modelo de rutas seguras), `apps/worker/src/adaptadores/adaptadores.module.ts` (cómo se elige un adaptador y la guarda de producción).
- **Hacer**: puerto, `MockStorage`, `LocalStorage` (temporal + `rename`, `realpath` dentro de la raíz), `rutaXml`, `crearStorage(env)`.
- **Hecho cuando**: las pruebas de T3 pasan; `test`, `typecheck` y `lint` del paquete limpios. Commit `feat(016): storage mock y local`.

## T10 · [ ] Esquemas de `shared/xml` (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP y `DetalleCompraDto`), las pruebas de T4, `packages/shared/src/xml/origen.ts`, `packages/shared/src/compras/{esquemas,respuestas,index}.ts`.
- **Hacer**: `origenDocumentoXmlSchema`, `detalleCompraSchema`, `vistaPreviaDesdeXmlSchema`, destino y códigos; exportar.
- **Hecho cuando**: las pruebas de T4 pasan; `test`, `typecheck`, `lint` y `build` de `shared` limpios. Commit `feat(016): esquemas de detalle y XML`.

## T11 · [ ] Migraciones y repositorios de XML (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Archivos: migraciones; Contratos: BD, packages/db, orden de bloqueo), `spec.md` (D-4, D-5, D-10), las pruebas de T5, `packages/db/migrations/{0032_compra,0033_compra_hallazgo_periodo,0034_compra_puntero_vigente}.sql` y `meta/_journal.json`, `packages/db/src/schema/compras.ts`, `packages/db/src/compras/{repositorio,lectura,versiones,periodo}.ts`.
- **Hacer**: confirmar que 0035 sigue libre; `0035_documento_xml.sql` y `0036_compra_evaluacion.sql` (con backfill y cambio de la única de `compra_hallazgo`), esquema drizzle y diario; `packages/db/src/xml/` según el plan; `evaluarYGuardar` inserta la evaluación 1 y pasa el XML vigente leído tras el bloqueo; lecturas de hallazgos vigentes por la última evaluación. Respetar el orden de bloqueo del plan.
- **Hecho cuando**: las pruebas de T5 pasan; `pnpm test:aislamiento` y `pnpm --filter @contapp/db test` verdes (002–015 incluidas); `pnpm cobertura:db` ≥ 90 %. Commit `feat(016): documento_xml y evaluación numerada`.

## T12 · [ ] Worker de XML (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Cola y worker), `spec.md` (D-7, D-11, P-4, P-7), las pruebas de T6, `packages/queue/src/catalogo.ts`, `apps/worker/src/trabajos/procesadores/{consultar-ruc,descargar-propuesta}.ts`, `apps/worker/src/trabajos/persistidores/{tipos,compras}.ts`, `apps/worker/src/trabajos/iniciar.ts` (mapa de procesadores), `apps/worker/src/adaptadores/adaptadores.module.ts`, `apps/backend/src/modules/trabajos/encolador.ts` (modelo de encolar + publicar).
- **Hacer**: `XML_OBTENER` en el catálogo; `obtener-xml.ts`; `encolar-xml.ts`; `trasConfirmar` opcional en `PersistidorLibro`, su llamada en `descargar-propuesta.ts` y su implementación en compras; storage y bandera P-4 en el worker.
- **Hecho cuando**: las pruebas de T6 pasan; las de 013 y 014 del worker siguen verdes; `test`, `typecheck` y `lint` de `queue` y `worker` limpios. Commit `feat(016): obtención de XML en el worker`.

## T13 · [ ] Backend de lectura (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP, `DetalleCompraDto`, Storage), `spec.md` (D-6, D-8, D-9, D-11), las pruebas de T7 (bloques de detalle, descarga, obtener y aislamiento), `apps/backend/src/modules/compras/{compras.controller,compras.service,compras.module,historial.service,vistas}.ts`, `apps/backend/src/modules/trabajos/encolador.ts`.
- **Hacer**: `detalle.controller.ts`, `detalle.service.ts` (comparación por columna con regla y explicación, aviso de moneda, historial del proveedor), `GET xml` con las cabeceras del plan, `POST xml/obtener` (fija `pendiente` y encola interactivo), `modules/storage/storage.module.ts`.
- **Hecho cuando**: las pruebas de T7 de lectura, descarga, obtener y aislamiento pasan, CA-18 incluido; las de 014 siguen verdes. Commit `feat(016): detalle del comprobante y descarga del XML`.

## T14 · [ ] Backend de escritura (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP; Decisiones), `spec.md` (D-3, D-5, D-7, D-8, P-6), las pruebas de T7 (subir, desde XML, aceptar y masiva), `apps/backend/src/app.ts` (cuerpo crudo de importación), `apps/backend/src/modules/compras/{escritura,transformar,acciones.service,masivas.service}.ts`, lo creado en T13.
- **Hacer**: cuerpo crudo de 1 MiB para las rutas XML; `xml.service.ts` (parsear, identidad, P-6, storage, `guardarDocumentoXml` y `reevaluarCompra` en una transacción, borrar el archivo si falla); `desde-xml.service.ts` (vista previa sin escribir; alta con `agregarCompra` de 014 y el XML en una transacción; `tipoCambio` de la query validado con `agregarCompraSchema`, P-9); XML vigente en el entorno de aceptar y de la masiva.
- **Hecho cuando**: todas las pruebas de T7 pasan, USD incluido; las de 014 siguen verdes; `test`, `typecheck` y `lint` del backend limpios. Commit `feat(016): subir XML y agregar desde XML`.

## T15 · [ ] Lupa (frontend · sonnet; nivel C)
- **Contexto (leer solo esto)**: `plan.md` (Frontend; `DetalleCompraDto`), `spec.md` (D-6, D-8, D-9, P-8; CA-9, CA-11, CA-14 a CA-17), `apps/frontend/AGENTS.md`, `packages/shared/src/xml/*` (de T10), `apps/frontend/lib/{compras,montos-compras,trabajos}.ts`, `apps/frontend/components/compras/{grilla-compras,historial-compra,aceptar-sugerencia,acciones-fila-compras,excluir-compra}.tsx`, `apps/frontend/pruebas/compras.ts`.
- **Hacer**: `lib/lupa-compras.ts`, `lupa-compra.tsx`, `cabecera-lupa.tsx`, `items-xml.tsx`, `comparacion-xml.tsx`, `estado-xml.tsx`; habilitar la lupa en `grilla-compras.tsx` pasando el orden de la grilla; teclado ← → Enter Esc; acciones de 015 y deshabilitadas según `soloLectura`; sin PDF ni «Recordar».
- **Hecho cuando**: un caso feliz y uno de error por comportamiento pasan (abrir con XML, navegar, aceptar con 409, estados del XML, simulado/subido, aviso de moneda, `<script>` como texto); la prueba estática de montos de 015 cubre los archivos nuevos; `test`, `typecheck` y `lint` del frontend limpios. Commit `feat(016): lupa del comprobante`.

## T16 · [ ] Subir XML y agregar desde XML (frontend · sonnet; nivel C)
- **Contexto (leer solo esto)**: `plan.md` (Frontend), `spec.md` (CA-12, CA-13), `lib/lupa-compras.ts` y `estado-xml.tsx` (de T15), `apps/frontend/components/compras/agregar-compra.tsx`.
- **Hacer**: `subir-xml.tsx` (arrastrar o elegir, tope en el navegador, mensajes de `xml_ajeno` con el campo, `xml_invalido`, `xml_existente`); usarlo en la lupa (completa el modal sin recargar) y en «Agregar compra» (vista previa, prellenado, solo destino, 409 con enlace a la existente; en USD pide también el tipo de cambio, P-9).
- **Hecho cuando**: un caso feliz y uno de error por flujo pasan, más USD con tipo de cambio y USD sin él (no envía); `test`, `typecheck` y `lint` limpios. Commit `feat(016): subir XML y agregar desde XML`.

## T17 · [ ] Cobertura en CI (devops · haiku)
- **Contexto (leer solo esto)**: `package.json` (scripts `cobertura:*`), `.github/workflows/ci.yml` (pasos de cobertura), `packages/domain/vitest.cobertura.config.mts`, `apps/backend/vitest.cobertura.config.mts` y `apps/worker/vitest.cobertura-cola.config.mts` (modelos), `packages/storage/package.json`.
- **Hacer**: `cobertura:storage` (umbral 90 % por archivo, sin servicios: va en el job de `cobertura:dominio`); `vitest.cobertura-xml.config.mts` en backend (`detalle*`, `xml*`, `desde-xml*` de `modules/compras`) y en worker (`obtener-xml.ts`, `encolar-xml.ts`) con el script raíz `cobertura:xml` en el job con Postgres y Redis; confirmar que `src/ubl/**` está en la de `domain` y `src/xml/**` en la de `db`.
- **Hecho cuando**: los cuatro comandos corren en local con ≥ 90 % (o se informa el archivo bajo el umbral, sin bajarlo); `ci.yml` válido. Commit `ci(016): cobertura de XML y storage`.

## T18 · [ ] Ronda adversarial 1: parser y subida (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (D-1 a D-4, D-8, D-11; CA-1, CA-2, CA-12, CA-17), `plan.md` (Parser seguro, Storage, HTTP), 04 §2.3 (catálogo), las pruebas de T2, T3 y T7 (para no repetir); en caja blanca, `packages/domain/src/ubl/`, `packages/storage/src/`, `apps/backend/src/modules/compras/{xml,desde-xml}.service.ts`, `app.ts`.
- **Hacer**: caja negra y luego blanca, ≤ 15 pruebas. Parser: entidades en todas sus formas (parámetro, anidadas, en atributos, `<!doctype` en minúsculas, tras BOM), declaración de codificación engañosa, CDATA y comentarios con montos falsos, `TaxTotal` y `LegalMonetaryTotal` duplicados o en orden inverso, prefijos distintos para el mismo espacio, montos `1e3`, `-0`, `0.005`, `0.015`, con coma o espacios, `currencyID` ausente, ítems al tope exacto. Subida: `Content-Encoding: gzip` y cuerpo fragmentado para saltar el tope, tipos de contenido raros, `xml_ajeno` con ceros y minúsculas, receptor con DNI, dos subidas simultáneas (P-6), `compraId` ajeno, ruta de storage manipulada, glosa con HTML, canarios en logs. No escribe código de producción.
- **Hecho cuando**: cada prueba pasa (la defensa aguanta) o falla con un hallazgo `H-016-n` (severidad, archivo y línea de la causa); informe al orquestador para «Hallazgos adversariales abiertos» de `ESTADO.md`.

## T19 · [ ] Pruebas de las correcciones de la ronda 1, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: el informe de T18, los `*.adv*.spec.ts` que fallan, `spec.md` (las D citadas en cada hallazgo).
- **Hacer**: una prueba propia (no adversarial) por hallazgo que fija el comportamiento correcto según la spec; si un hallazgo pide cambiar la spec, `requiere usuario`.
- **Hecho cuando**: las pruebas fallan por el defecto, no por sintaxis. Commit `test(016): correcciones de la ronda 1 en rojo`.

## T20 · [ ] Corregir la ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: el informe de T18, las pruebas de T19, los archivos citados en cada hallazgo.
- **Hacer**: corregir la causa sin tocar pruebas.
- **Hecho cuando**: T19 y los `*.adv*` de T18 en verde; suites de `domain`, `storage` y backend de compras verdes; cobertura ≥ 90 % sin cambios de umbral. Commit `fix(016): hallazgos de la ronda 1`.

## T21 · [ ] Ronda adversarial 2: re-evaluación y aceptación en bloque (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (D-5, D-6, D-7, P-2, P-4; CA-6 a CA-9, CA-16), `plan.md` (BD, orden de bloqueo, Decisiones), 014 `spec.md` (D-9, D-14, D-15), las pruebas de T5, T6 y T7 (para no repetir); en caja blanca, `packages/db/src/xml/`, `packages/db/src/compras/repositorio.ts`, `apps/worker/src/trabajos/procesadores/obtener-xml.ts`, `apps/backend/src/modules/compras/{escritura,transformar,masivas.service,xml.service}.ts`.
- **Hacer**: ≤ 15 pruebas. Re-evaluación: llegada del XML contra edición, deshacer, rehacer, masiva y descarga repetida (en ambos órdenes, varias rondas); dos llegadas del mismo XML (worker y subida); bandera P-4 cambiada entre evaluar y aceptar; periodo `revisado`/`generado` durante la llegada; XML de una versión descartada y vuelta a agregar; interbloqueos con el advisory por comprobante. Aceptación en bloque: 5.000 filas mezclando hallazgos previos al XML, XML en otra moneda, notas de crédito, simulados con la bandera apagada y filas cambiadas por otro; lo aplicado coincide con lo que la lupa mostraba o es 409/rechazo, nunca un monto distinto. Regresión de la ronda 1.
- **Hecho cuando**: igual que T18 (`H-016-n` continúa la numeración).

## T22 · [ ] Pruebas de las correcciones de la ronda 2, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: el informe de T21, los `*.adv*` que fallan, `spec.md` (las D citadas).
- **Hacer** y **Hecho cuando**: como T19. Commit `test(016): correcciones de la ronda 2 en rojo`.

## T23 · [ ] Corregir la ronda 2 (backend · opus)
- **Contexto (leer solo esto)**: el informe de T21, las pruebas de T22, los archivos citados.
- **Hacer** y **Hecho cuando**: como T20, más `pnpm test:aislamiento` verde. Commit `fix(016): hallazgos de la ronda 2`.

## T24 · [ ] Prueba manual contra el sistema completo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-6, CA-9 a CA-16), `docs/specs/015-compras-frontend/tasks.md` (T11, como modelo), `README` o scripts `servicios:up` y `dev` del `package.json` raíz.
- **Hacer**: con `servicios:up`, mocks y `XML_SIMULADO_EN_REGLAS=1`: descargar 202610 del cliente de fixtures, ver encolarse los XML, abrir la lupa de F001-2056 y F001-1040 (aceptar R-MIX y R-ISC), navegar con el teclado, centinelas 7, 8 y 9 con «Reintentar» y «Subir XML», subir uno ajeno, agregar desde XML (nuevo en PEN, nuevo en USD con tipo de cambio y duplicado), descargar el XML, F001-4062; repetir con la bandera en `0`. Anotar cada defecto con pasos y archivo probable.
- **Hecho cuando**: informe de pasos con resultado; los defectos de pantalla van a T24a y los de servidor al orquestador. Sin commit si no hay cambios.

## T25 · [ ] Verificar criterios (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-18 y casos reales), los informes de T18, T21 y T24.
- **Hacer**: suites completas (`pnpm test`, `test:aislamiento`, `ci:db`), los `cobertura:*` de 016 y los de siempre; por cada CA, la prueba o el comando que lo demuestra (`archivo:línea`) o «falta».
- **Hecho cuando**: tabla CA → evidencia en la sección «Resultado» de esta tarea; cobertura ≥ 90 % en `ubl/`, `storage`, `db/xml` y los módulos XML de backend y worker; ningún adversarial abierto. Commit `docs(016): verificación de criterios`.

## T26 · [ ] Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, la tabla de T25, `git diff main...spec/016-lupa-xml --stat` y los archivos que la tabla marque dudosos, `docs/03-arquitectura.md` §7.2.
- **Hacer**: verificar cada CA con su evidencia, ratificar o rechazar los desvíos del plan (cuerpo crudo en vez de multipart, `trasConfirmar`), actualizar 03 §7.2 (el `GET` del detalle no encola; D-8) y dejar las notas para ESTADO (lupa de ventas, proveedor real, P-9 si sigue abierta).
- **Hecho cuando**: lista de lo que falta (vacía o convertida en T26a/T26b) y desvíos ratificados en `plan.md`. Commit `docs(016): revisión final`.

## T27 · [ ] Cierre (devops · haiku)
- **Contexto (leer solo esto)**: este `tasks.md`, `git status`.
- **Hacer**: marcar las tareas, `Estado: hecha` en `spec.md` con la fecha y los CA en `[x]` según T25 y T26.
- **Hecho cuando**: `git status` limpio salvo lo ajeno. Commit `docs(016): cierre`.
