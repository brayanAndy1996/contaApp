# Tareas 041 · SIRE real de solo lectura

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: pruebas primero (rojo) → implementar (verde) → atacar (2 rondas) → corregir → prueba de contrato (usuario) → verificar → revisión de Opus → cerrar. Rama `spec/041-sire-real-lectura` desde `main`. Requiere P-1 a P-8 resueltas.

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Fixtures TXT sintéticos con el encabezado real + `LEEME.md` | tester | sonnet | — ∥ T2, T3 | ✓ | — | [x] (encabezado verificado byte a byte contra descargas reales: compras sin BOM, ventas con BOM) |
| T2 | Pruebas de `zip-seguro` y `txt/*` (lectura, encabezado, mapeo, límites) en rojo | tester | sonnet | T1 | ✓ | — | [x] |
| T3 | Pruebas de `HttpSireAuth` y `HttpSireApiClient` con el servidor falso (rojo) | tester | sonnet | — ∥ T1 | ✓ | — | [x] |
| T4 | Pruebas del worker: `SIRE_CLIENT=http`, almacén Redis, `claveReanudacion`, 401 → renovación (rojo) | tester | sonnet | — ∥ T1–T3 | ✓ | — | [x] |
| T5 | `zip-seguro.ts` y `txt/*` (lectura y mapeo) | backend | opus | T2 ∥ T6 | ✓ | — | [x] («el periodo de la ruta es el pedido» devuelta al tester: su TXT es de 202610 y pide 202601 → `respuesta_ajena`) |
| T6 | `endpoints`, `transporte`, `HttpSireAuth`, `HttpSireApiClient`, `ticket`, errores con `detalle` | backend | opus | T3 ∥ T5 | ✓ | — | [x] (21 pruebas del cliente esperan la lectura de T5; «otro periodo o libro…» devuelta al tester) |
| T7 | Worker: adaptadores, `almacen-tickets-redis`, `claves.ticketSire`, `TokenRechazadoError` desde sunat | backend | sonnet | T4, T6 | ✓ | — | [x] (las pruebas de `descargar-propuesta-041.int` que pasan por el lector TXT esperan a T5) |
| T8 | `vitest` modo `contrato`, script `test:contrato`, exclusión verificada, `.env.example`, `03-arquitectura` §4 | devops | haiku | T6 ∥ T7 | — | — | [x] (la tabla de adaptadores está en 03 §3; §4 es multitenancy) |
| T9 | Prueba de contrato manual `sire.contrato.spec.ts` + Postman 5.51/5.40 | tester | sonnet | T6, T8 | — | — | [x] (apagada sin `SIRE_CONTRATO=1`; verde contra el servidor falso; la ruta del 5.40 no está en el repo: va en `ruta_5_40`) |
| T10 | Ronda adversarial 1 (caja negra): ZIP, TXT, encabezados, filas ajenas, nombres hostiles, ticket ajeno, redirecciones, secretos | adversario | opus | T5, T6, T7 ∥ T9 | — | ✓ | [x] |
| T11 | Pruebas de las correcciones de la ronda 1 (rojo) — omitida: las pruebas del adversario cubren los 3 hallazgos | tester | sonnet | T10 | ✓ | — | [x] |
| T12 | Corregir hallazgos de la ronda 1 | backend | opus | T11 | — | — | [x] |
| T13 | Ronda adversarial 2 (caja blanca): timeouts, presupuesto, reanudación entre estudios, memoria, codificación, concurrencia | adversario | opus | T12 | — | ✓ | [x] |
| T14 | Pruebas de las correcciones de la ronda 2 (rojo) — omitida: las pruebas del adversario cubren los hallazgos | tester | sonnet | T13 | ✓ | — | [x] |
| T15 | Corregir hallazgos de la ronda 2 | backend | opus | T14 | — | — | [x] |
| T15b | Pruebas del registro presentado (P-3) | tester | sonnet | T15 | ✓ | — | [x] (20 pruebas en rojo en `registro-presentado.http.spec.ts`; `it.todo` de «SUNAT exige moneda»: el plan no fija la respuesta del servidor falso) |
| T15c | Implementar registro presentado (P-3) | backend | opus | T15b | — | — | [x] |
| T15d | Rediseño registro presentado (70 + PEN/USD) | backend | opus | T15c | ✓ | — | [x] tests rojos ✓ (3 testers) → verdes: sunat 1142, contrato falso 4 (+1 omitida), queue 797 + int 123, worker 630 + int 672; typecheck y lint OK |
| T15e | Lector de ZIP acepta la estructura real del registro | backend | opus | T15d | ✓ | ✓ | [x] backend: sunat 1232, queue 797 + int 123, worker 630 + int 672; typecheck y lint OK · ronda adversarial 3 hecha (`ronda3.adv.spec.ts`, 8 rojas) |
| T15f | Corregir hallazgos de la ronda adversarial 3 del lector de ZIP (H-041-3-1 a 3-8) | backend | sonnet | T15e | — | ✓ | [x] |
| T15g | Registro presentado con una sola solicitud (evidencia real) | tester → backend | sonnet | T15f | ✓ | — | [x] tester (rojo) + backend: una solicitud 70+PEN, clave `…:registro`; `sunat`, `queue` y `worker` verdes |
| T16 | Corrida de la prueba de contrato contra SUNAT (la ejecuta el **usuario**) y ajustes de P-5/P-6 | tester | sonnet | T9, T15 | — | — | [ ] |
| T17 | Verificar CA-1 a CA-15 con evidencia y suites de `sunat`, `queue` y `worker` | tester | sonnet | T16 | — | — | [x] CA-1 a CA-15 cumplidos (2026-11-28): sunat 1235, queue 797 + int 123, worker 630 + int 672; typecheck y lint OK; evidencia en `resultados.md` |
| T18 | Revisión final contra la spec | arquitecto | opus | T17 | — | — | [ ] |
| T19 | Cierre: `tasks.md`, `spec.md`, commit (el orquestador actualiza `ESTADO.md`) | devops | haiku | T18 | — | — | [ ] |

Paralelismo: oleada 1 = T1 ∥ T3 ∥ T4 (y T2 tras T1); oleada 2 = T5 ∥ T6; luego T7 ∥ T8; T9 ∥ T10. Las rondas y sus correcciones van en serie. Si una ronda no deja fallos, sus dos tareas siguientes se marcan `[x]` «sin hallazgos».

Escalamientos: T5 y T6 nacen en `opus` (formato SUNAT, dinero y secretos; 04 §3.2). T7 pasa a `opus` si falla 2 veces. T8 y T19 pasan a `sonnet` si `haiku` falla una vez.

Reglas comunes:
- **Nunca** copiar a fixtures, pruebas, specs ni commits filas, RUC, razones sociales ni montos de los TXT reales del usuario; solo el encabezado. RUC solo de `fixtures/rucs-prueba.json`.
- Ninguna prueba normal sale a internet: todo contra `servidor-sire-falso` en 127.0.0.1. Ninguna prueba duerme: `dormir` y `ahora` inyectados.
- Canarios en `client_secret`, clave SOL y token; se buscan en errores, logs, `resultado`, eventos y Redis.
- Montos con `Money` / cadenas; nunca `number`. Sin migraciones.
- Un commit por tarea (`test(041): …`, `feat(041): …`, `fix(041): …`, `chore(041): …`) con el trailer del modelo que la ejecutó; sin push del subagente. `git add` con rutas explícitas.
- El tester no toca producción; backend no edita `*.spec.ts` ajenos; solo T10 y T13 crean `*.adv.spec.ts`.
- Checks: responder solo fallos (`archivo:línea · mensaje`) u «OK» + conteo. Una ambigüedad que cambie la spec: `requiere usuario`.

## T1 · Fixtures sintéticos (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (Hallazgos del layout real, P-2, P-5), `plan.md` (Mapeo), `fixtures/LEEME.md`, `fixtures/rucs-prueba.json`. Encabezados reales: solo la primera línea de cada TXT que el orquestador indique (`head -1`); nada más de esos archivos.
- **Hacer**: `fixtures/sire/http/compras-propuesta-202610.txt` (80 columnas, UTF-8 sin BOM, LF, `|` final en filas) y `ventas-propuesta-202610.txt` (40 columnas, con BOM): facturas PEN, USD con TC 3.300, NC `07` negativa, boleta a consumidor final, mixta DG+DGNG, ICBPER, exonerada, inafecta; montos de ventas sin formato fijo (`500`, `1837.5`). Variantes: columnas permutadas, columna extra, columna faltante, encabezado distinto entre partes, fila de otro RUC y de otro periodo. Tabla en `LEEME.md`.
- **Hecho cuando**: los archivos existen, sus RUC están en `rucs-prueba.json`, el encabezado coincide byte a byte con el real y `LEEME.md` los describe. Commit `test(041): fixtures sintéticos del SIRE real`.

## T2 · Pruebas de ZIP y TXT, rojo (tester · sonnet)
- **Contexto**: `spec.md` (CA-3 a CA-7, CA-10, CA-14), `plan.md` (Contratos, Mapeo, Decisiones), `fixtures/sire/http/*`, `packages/sunat/src/puertos.ts` (tipos de fila), `packages/sunat/src/mock/sire-api-client.mock.ts` (`generarFilasComprasVolumen` para CA-14).
- **Hacer**: `packages/sunat/src/http/{zip-seguro,txt/leer-txt,txt/encabezados,txt/mapeo-compras,txt/mapeo-ventas}.spec.ts`. ZIP armados con `fflate` en la prueba, incluida una bomba deflate (1 KiB → 1 GiB) y razón > 200:1.
- **Hecho cuando**: fallan por módulo ausente; las de `sunat` existentes siguen verdes. Commit `test(041): lectura del TXT y ZIP en rojo`.

## T3 · Pruebas del cliente HTTP, rojo (tester · sonnet)
- **Contexto**: `spec.md` (CA-2, CA-8, CA-9, CA-11 a CA-13), `plan.md` (Contratos, Endpoints, Decisiones), `packages/sunat/src/errores.ts`, `packages/sunat/src/mock/sire-auth.mock.spec.ts` (modelo), `tools/sire-postman/sire.postman_collection.json` (forma de token y ticket, incluido `codTipoAchivoReporte`).
- **Hacer**: `packages/sunat/src/http/pruebas/servidor-sire-falso.ts` (guion por ruta: estado, cuerpo, demora, 3xx) y `packages/sunat/src/http/{sire-auth.http,sire-api-client.http,ticket,transporte}.spec.ts`: formulario exacto, cabeceras, estados 01–06, ticket ajeno en `registros`, varias partes, todos los códigos HTTP de CA-11, presupuesto, reanudación con `AlmacenTicketsMemoria`, canarios.
- **Hecho cuando**: fallan por «no implementado»; el servidor falso tiene su propia prueba verde. Commit `test(041): cliente HTTP del SIRE en rojo`.

## T4 · Pruebas del worker, rojo (tester · sonnet)
- **Contexto**: `spec.md` (CA-1, CA-8, CA-11, CA-12), `plan.md` (Archivos del worker), `apps/worker/src/adaptadores/adaptadores.module.ts` y `adaptadores.module.spec.ts`, `apps/worker/src/trabajos/token-sire/cache-token.ts` y `cache-token.int.spec.ts`, `packages/queue/src/claves.ts`.
- **Hacer**: `adaptadores-041.spec.ts`, `token-sire/almacen-tickets-redis.int.spec.ts`, `claves-041.spec.ts` en `queue`; `descargar-propuesta-041.int.spec.ts` con `HttpSireApiClient` contra el servidor falso (401 → una renovación; clave de ticket con estudio y cliente).
- **Hecho cuando**: fallan por lo que falta; las del worker existentes siguen verdes. Commit `test(041): worker con SIRE http en rojo`.

## T5 · ZIP y TXT (backend · opus)
- **Contexto**: `plan.md` (Contratos, Mapeo, Decisiones), pruebas de T2, `packages/sunat/src/formatos/empaquetar.ts` (uso de `fflate`), `packages/domain/src/dinero/money.ts` (API pública).
- **Hacer**: `zip-seguro.ts` y `txt/*` hasta verde.
- **Hecho cuando**: pruebas de T2 verdes; `pnpm --filter @contapp/sunat typecheck lint` OK. Commit `feat(041): lectura segura del TXT del SIRE`.

## T6 · Cliente HTTP (backend · opus)
- **Contexto**: `plan.md`, pruebas de T3, `packages/sunat/src/{errores,puertos,index}.ts`.
- **Hacer**: `endpoints`, `transporte`, `ticket`, `almacen-tickets`, `sire-auth.http`, `sire-api-client.http`; `TokenRechazadoError` y subclases en `errores.ts`; `claveReanudacion?` en `puertos.ts`; exports.
- **Hecho cuando**: pruebas de T3 verdes y las de `sunat` siguen verdes. Commit `feat(041): adaptadores HTTP del SIRE`.

## T7 · Worker (backend · sonnet)
- **Contexto**: `plan.md` (Archivos del worker), pruebas de T4, archivos que esas pruebas importan.
- **Hacer**: lo listado en el plan para `apps/worker` y `packages/queue`.
- **Hecho cuando**: pruebas de T4 verdes; `test` y `test:int` del worker y de `queue` verdes. Commit `feat(041): worker con SIRE_CLIENT=http`.

## T8 · Configuración (devops · haiku)
- **Contexto**: `plan.md` (Decisiones: contrato), `packages/sunat/{package.json,vitest.config.mts}`, `.github/workflows/ci.yml` (solo para confirmar que no usa `--mode contrato`), `.env.example`, `docs/03-arquitectura.md` §4.
- **Hacer**: modo `contrato` y exclusión; `vitest-contrato.spec.ts` que falla si el patrón entra en `test` o `test:int`; `.env.example` y la tabla de adaptadores.
- **Hecho cuando**: `pnpm --filter @contapp/sunat test` no lista `*.contrato.spec.ts`; `test:contrato` sin `SIRE_CONTRATO=1` sale sin pruebas ejecutadas. Commit `chore(041): modo contrato del SIRE`.

## T9 · Prueba de contrato (tester · sonnet)
- **Contexto**: `spec.md` (CA-15, P-3, P-5, P-7), `plan.md` (Endpoints), `tools/sire-postman/README.md`.
- **Hacer**: `sire.contrato.spec.ts`: token → exportar → ticket → archivo de compras y ventas del periodo dado, con aserciones de forma (columnas requeridas presentes, tipos, estados) y salida solo de formas y tiempos; peticiones 5.51 y 5.40 en Postman. Guía de 5 líneas en el `README.md` de Postman.
- **Hecho cuando**: con `SIRE_CONTRATO` ausente no corre; contra el servidor falso (`urlsDePrueba`) pasa. Commit `test(041): prueba de contrato manual del SIRE`.

## T10 · Ronda adversarial 1 (adversario · opus)
- **Contexto**: `spec.md`, `plan.md` (Contratos), interfaz pública de `@contapp/sunat`; sin leer la implementación. Catálogo 04 §2.3 (Formatos TXT/ZIP, Cifrado: secretos en logs).
- **Hacer**: ≤ 15 pruebas en `packages/sunat/src/http/ronda1.adv.spec.ts`.
- **Hecho cuando**: cada fallo queda como hallazgo `H-041-1-n` en el resultado de la tarea. Commit `test(041): ronda adversarial 1`.

## T11–T12 · Correcciones de la ronda 1
- **Contexto**: hallazgos de T10, archivos que señalan. **Hecho cuando**: `ronda1.adv.spec.ts` y las pruebas de T11 verdes. Commits `test(041): …` y `fix(041): …`.

## T13 · Ronda adversarial 2 (adversario · opus)
- **Contexto**: igual que T10 más la implementación (caja blanca) y `apps/worker/src/trabajos/token-sire/*`.
- **Hacer**: ≤ 15 pruebas en `packages/sunat/src/http/ronda2.adv.spec.ts` y `apps/worker/src/trabajos/sire-http-r2.adv.int.spec.ts`.
- **Hecho cuando**: igual que T10. Commit `test(041): ronda adversarial 2`.

## T14–T15 · Correcciones de la ronda 2
- Igual que T11–T12.

## T15b · Pruebas del registro presentado (P-3) (tester · sonnet)
- **Contexto**: `plan.md` («P-3 · Registro presentado», fila «Registro» de Endpoints), `fixtures/sire/http/compras-registro-202610*.txt`, `packages/sunat/src/http/pruebas/ayudas-http.ts`, `sire-api-client.http.spec.ts` (modelo).
- **Hacer**: las 11 pruebas de `registro-presentado.http.spec.ts` (la 12, del contrato, es de T16) con P-3a (01 y, si no hay datos, UNA vez 02) y P-3b (sin `codMoneda`); fixtures `compras-registro-202610.txt` y `-solo-encabezado.txt`; `RUTAS.solicitarRegistro`; paso 5 de Postman corregido.
- **Hecho cuando**: fallan solo porque `descargarRegistroPresentado` aún rechaza siempre; el resto de `sunat` sigue verde. Commit `test(041): registro presentado del SIRE en rojo`.

## T15c · Implementar registro presentado (P-3) (backend · opus)
- **Contexto**: `plan.md` («P-3», Decisiones), `registro-presentado.http.spec.ts`, `endpoints.ts`, `sire-api-client.http.ts`.
- **Hacer**: `rutaRegistroPresentado`, `parametrosRegistro`, `COD_PROCESO_REGISTRO`; `exportar` y `obtenerTicketListo` con URL y `operacion`; `descargarRegistroPresentado` hasta verde.
- **Hecho cuando**: `registro-presentado.http.spec.ts` verde, el resto de `sunat` verde, `typecheck` y `lint` OK. Commit `feat(041): registro presentado del SIRE`.

## T15d · Rediseño registro presentado (70 + PEN/USD) (backend · opus)
- **Contexto**: `plan.md` («P-3 · Registro presentado», H-4/H-5/H-7), `registro-presentado.http.spec.ts`, `transporte.spec.ts`, `errores-sire.spec.ts`, `endpoints.spec.ts`, `endpoints.ts`, `errores.ts`, `transporte.ts`, `sire-api-client.http.ts`, `packages/queue/src/claves.ts`, `AlmacenTicketsRedis`.
- **Hacer**: `COD_PROCESO_REGISTRO = "70"`, `MONEDAS_REGISTRO`, `COD_SIN_DATOS_REGISTRO`, `parametrosRegistro(per, moneda)`; `ErrorPortalSire("solicitud_rechazada")` con `codigosSunat`; transporte con cuerpo de error en la solicitud 5.51; dos solicitudes (PEN→USD) con un ticket cada una, claves `registro-pen`/`registro-usd`, un presupuesto de 90 s y un acumulado de 256 MiB, unión de filas (moneda, encabezado, comprobante repetido).
- **Hecho cuando**: las pruebas rojas de T15d verdes en `sunat`, `queue` y `worker`; `typecheck` y `lint` OK. Commit `feat(041): registro presentado con codProceso 70 y monedas PEN/USD`.

## T15e · Lector de ZIP acepta la estructura real del registro (tester rojo → backend opus → adversario acotado)
- **Contexto**: `spec.md` (CA-10, CA-13), `packages/sunat/src/http/zip-seguro.ts`, `zip-seguro-registro.spec.ts`, `pruebas/zip-manual.ts` (`zipRegistroReal`), `registro-presentado.http.spec.ts`, `apps/worker/test/sire-http.ts` (`zipRegistroRealDe`).
- **Estructura real (corrida de contrato, 2 RUC)**: `PK\x07\x08` al inicio, EOCD al final, sin ZIP64/cifrado/descriptor, banderas 0x0800, 3 entradas: `LE#/LE#.txt` con datos (deflate), OTRA `LE#/LE#.txt` vacía (stored, tamaños 0, CRC 0) y la carpeta `LE#/`.
- **Decisión de lectura**: (a) se ignoran carpetas (nombre en `/`, tamaño 0, método 0) y archivos vacíos (comprimido 0, descomprimido 0, CRC 0, método 0); (b) exactamente UNA entrada con datos y extensión `.txt`; (c) se valida el NOMBRE de TODAS las entradas (sin `..`, ruta absoluta, `\`, `:`, NUL ni controles, un solo nivel de carpeta, ≤ 255 bytes, y la carpeta es prefijo del archivo con datos); (d) ≤ 8 entradas en el directorio central; (e) siguen topes 64 MiB/256 MiB/200:1, CRC, métodos 0 y 8, sin cifrado ni ZIP64, duplicados CON datos rechazados.
- **Tester (hecho, rojo)**: `zip-seguro-registro.spec.ts` (12 rojas de 78: lectura de la estructura real con y sin firma, 8 entradas, 255 bytes, 64 MiB, tope acumulado; 66 verdes que deben seguir rechazando: hostiles en cada entrada, 9 entradas, CRC y tamaños falsos, bomba de 1 GiB y topes con carpeta); `registro-presentado.http.spec.ts`, `contrato-sire.spec.ts` (5.51) y `importar-historial-041.int.spec.ts` sirven el ZIP del registro con la estructura real y quedan rojas solo por `zip_invalido`.
- **Hacer (backend) [x] hecho**: `zip-seguro.ts` según la decisión (plan «Decisiones de la ronda 3 · ZIP del registro»); `estructura-zip.ts` (diagnóstico de pruebas) puede quedar igual: solo se usa si el lector rechaza.
- **Hecho cuando**: las pruebas rojas de T15e verdes en `sunat` y `worker`; `typecheck` y `lint` OK. Commit `fix(041): el lector de ZIP acepta la estructura real del registro presentado`. Luego una ronda adversarial acotada al lector.

## T15f · Hallazgos de la ronda adversarial 3 del lector de ZIP (backend · sonnet) [x]
- **Contexto**: plan «Decisiones de la ronda 3 · ZIP del registro» (incluye H-041-3-1 a 3-8), `zip-seguro.ts`, `ronda3.adv.spec.ts`.
- **Hecho**: `ronda3.adv.spec.ts` verde sin editar; `zip-seguro-r3.spec.ts` cubre descriptor de datos y campo extra; siguen verdes las demás de `sunat`, `worker` y `queue`. Commit `fix(041): hallazgos de la ronda adversarial 3 del lector de ZIP`.

## T15g · Registro presentado con una sola solicitud (evidencia real) (tester → backend)
- **Evidencia (corrida real de contrato, 2 RUC: uno con NC en 202610 y otro con 2 comprobantes USD en 202506)**: `codMoneda` NO FILTRA en el 5.51. Con `codMoneda=PEN` el archivo trae TODOS los comprobantes (12 filas: Moneda USD 2 y PEN 10 en el RUC con USD) y con USD devuelve el mismo archivo. El ZIP real es de 3 entradas y ya se lee (T15e/T15f). El encabezado real difiere del de la propuesta solo en la columna 34: `ID Proyecto Operadores/Partícipes` (no se mapea).
- **Diseño (decisión técnica del orquestador, sustituye lo de dos solicitudes de «P-3»; el backend actualiza `plan.md`)**: UNA solicitud al 5.51 por periodo con `codProceso=70` y `codMoneda=PEN` (obligatorio, sin efecto de filtro); un ticket, un archivo. NO hay dos solicitudes ni unión de monedas. NO se verifica la columna `Moneda` de cada fila (cada una conserva PEN o USD; solo se valida la forma como en la propuesta: RUC y Periodo propios, encabezado igual entre partes, valores). Un comprobante repetido dentro del archivo → `ErrorPortalSire("respuesta_inesperada")`. «Sin datos» = 422 con cod 1070 (o 400 con 1070) o TXT solo con encabezado → `ErrorDatosSire("sin_datos")`; cualquier otro 400/422 → `ErrorPortalSire("solicitud_rechazada")` con `codigosSunat`. Clave del ticket: de vuelta a `registro` (5 partes `{tenant}:{cliente}:compras:{periodo}:registro`; ya no existen `registro-pen` ni `registro-usd`). Ticket guardado una vez tras solicitar y borrado solo al validar; si SUNAT ya no lo lista se solicita una vez más; transitorios y 401 lo conservan; un presupuesto de 90 s y 256 MiB acumulados entre las partes.
- **Contexto**: `spec.md` (CA-13), `plan.md` «P-3 · Registro presentado» (describe el diseño anterior), `registro-presentado.http.spec.ts`, `endpoints.spec.ts`, `endpoints.ts`, `sire-api-client.http.ts`, `packages/queue/src/claves.ts`, `AlmacenTicketsRedis`, `pruebas/contrato-sire.ts`.
- **Tester `sunat` (hecho, rojo)**: `registro-presentado.http.spec.ts` reescrito para una sola solicitud (parámetros, ticket único, reanudación con `…:registro`, re-solicitud única si ya no se lista, transitorios/401, `sin_datos`, `solicitud_rechazada`, comprobante repetido, filas PEN y USD mezcladas, 90 s y 256 MiB); `endpoints.spec.ts` (`parametrosRegistro(per)` con `codMoneda` PEN fijo, `COD_PROCESO_REGISTRO="70"`, `MONEDA_SOLICITUD_REGISTRO="PEN"`, `MONEDAS_REGISTRO` desaparece); fixtures: se queda `compras-registro-202610-mixto.txt` (8 PEN + 1 USD, encabezado real) y `-solo-encabezado.txt`, se eliminan `-pen.txt` y `-usd.txt`; prueba de contrato (`contrato-sire.ts`, `sire.contrato.spec.ts`, `contrato-sire.spec.ts`): una solicitud, informe plano (sin `porMoneda`, sin «archivo pendiente», sin verificación de «moneda pedida»), `diferencia` de encabezado (`ninguna` / `solo_no_mapeadas` / `mapeadas`) y servidor falso con el ZIP real de 3 entradas.
- **Hacer (backend)**: en `endpoints.ts`, `parametrosRegistro(per)` sin moneda (siempre `MONEDA_SOLICITUD_REGISTRO="PEN"`) y quitar `MONEDAS_REGISTRO`/`MonedaRegistro`; en `sire-api-client.http.ts`, una solicitud, un ticket, clave `registro`, sin verificación de moneda ni unión; `claves.ts` y `AlmacenTicketsRedis` vuelven a `registro`; actualizar `plan.md` y las pruebas de `queue` y `worker` (otro tester) y `ronda2.adv.spec.ts` (clave `registro-pen`/`-usd`).
- **Hecho cuando**: las pruebas rojas de T15g verdes en `sunat`, `queue` y `worker`; `typecheck` y `lint` OK. Commit `feat(041): el registro presentado usa una sola solicitud (codMoneda no filtra)`.

## T16 · Contrato real (tester · sonnet; lo ejecuta el usuario)
- **Contexto**: `tools/sire-postman/README.md`, `sire.contrato.spec.ts`, P-3/P-5/P-6.
- **Hacer**: pasar al usuario el comando; recibir solo la salida de formas; si muestra diferencias (encabezado, NC, consumidor final, codificación, servicio de registro) proponer el ajuste y anotarlo como `requiere usuario`.
- **Hecho cuando**: la salida está pegada en el resultado de esta tarea y P-3, P-5 y P-6 quedan cerradas por el usuario.

## T17 · Verificación (tester · sonnet)
- **Contexto**: `spec.md` (CA), resultados de T1–T16.
- **Hacer**: evidencia por CA (prueba o comando); suites `test` y `test:int` de `sunat`, `queue`, `worker`; `pnpm -r typecheck lint`.
- **Hecho cuando**: cada CA marcado con su evidencia o listado como faltante.

## T18 · Revisión final (arquitecto · opus) · T19 · Cierre (devops · haiku)
- Revisión contra la spec con evidencia; cierre con commit `docs(041): cierre`.

## T20 · Hallazgos de la revisión final H-1, H-2, H-3 (tester rojo → backend)
- **H-1 (media)** `apps/worker/src/trabajos/procesadores/importar-historial.ts` (~l.170): hoy todo `ErrorDatos` cuenta como «periodo sin datos». Regla: solo el `ErrorDatos` plano (mock) y `ErrorDatosSire("sin_datos")` cuentan en `periodos_sin_datos` y sigue; cualquier otro `ErrorDatosSire` (`fila_invalida`, `columna_no_soportada`, `respuesta_ajena`, `ticket_con_errores`) hace FALLAR el trabajo (`error/datos_invalidos`, importación `fallida` con ese motivo) sin leer los demás periodos, sin marcar el periodo como sin datos y sin secretos.
- **H-2 (baja)** `packages/sunat/src/http/transporte.ts` (~l.84): el 404 es transitorio solo en la DESCARGA del archivo (5.32). Las pruebas asumen un nuevo valor `"descarga"` en `ContextoHttp` (el cliente lo usa en `descargarParte`); en `"api"` (exportar, ticket) y `"solicitud-registro"` (5.51) un 404 es `ErrorPortalSire` permanente (sin reintento). `["api", 404]` de `transporte.spec.ts` pasó de transitorio a `ErrorPortalSire`.
- **H-3 (baja)** `transporte.ts` (~l.189-196, `codigosDeError`): si la lectura del cuerpo de un 400/422 de la solicitud 5.51 se corta (timeout o red) el resultado es `ErrorTransitorioSire` (`timeout`/`red`), no `solicitud_rechazada` con 0 códigos; un cuerpo legible sin códigos o ilegible por contenido sigue siendo `solicitud_rechazada` con `[]`.
- **Tester (hecho, rojo)**: H-1 `importar-historial-041.errores-datos.spec.ts` (8 rojas de 11, sin BD; las 3 de «sin datos» verdes) y `importar-historial-041.int.spec.ts` (4 rojas: columna `IMB` ≠ 0, fila de otro periodo, monto ilegible, ticket `03`; hoy el trabajo termina `completado` leyendo el periodo anterior); H-2 `transporte.spec.ts`, `sire-api-client.http.spec.ts`, `registro-presentado.http.spec.ts` (7 rojas; las de `descarga` y el 404 del archivo ya verdes como guarda); H-3 `transporte.spec.ts` (5 rojas).
- **Hacer (backend)**: según las reglas de arriba; en `sire-api-client.http.ts` `descargarParte` usa `contexto: "descarga"`. No editar las pruebas ni `ronda*.adv.spec.ts`.
- **Hecho cuando**: las pruebas rojas de T20 verdes en `sunat` y `worker` (`test` y `test:int`); `typecheck` y `lint` OK. Commit `fix(041): hallazgos H-1, H-2 y H-3 de la revisión final`.

