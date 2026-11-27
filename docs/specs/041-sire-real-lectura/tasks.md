# Tareas 041 · SIRE real de solo lectura

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: pruebas primero (rojo) → implementar (verde) → atacar (2 rondas) → corregir → prueba de contrato (usuario) → verificar → revisión de Opus → cerrar. Rama `spec/041-sire-real-lectura` desde `main`. Requiere P-1 a P-8 resueltas.

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Fixtures TXT sintéticos con el encabezado real + `LEEME.md` | tester | sonnet | — ∥ T2, T3 | ✓ | — | [x] (encabezado pendiente de verificar; requiere usuario) |
| T2 | Pruebas de `zip-seguro` y `txt/*` (lectura, encabezado, mapeo, límites) en rojo | tester | sonnet | T1 | ✓ | — | [ ] |
| T3 | Pruebas de `HttpSireAuth` y `HttpSireApiClient` con el servidor falso (rojo) | tester | sonnet | — ∥ T1 | ✓ | — | [x] |
| T4 | Pruebas del worker: `SIRE_CLIENT=http`, almacén Redis, `claveReanudacion`, 401 → renovación (rojo) | tester | sonnet | — ∥ T1–T3 | ✓ | — | [ ] |
| T5 | `zip-seguro.ts` y `txt/*` (lectura y mapeo) | backend | opus | T2 ∥ T6 | ✓ | — | [ ] |
| T6 | `endpoints`, `transporte`, `HttpSireAuth`, `HttpSireApiClient`, `ticket`, errores con `detalle` | backend | opus | T3 ∥ T5 | ✓ | — | [ ] |
| T7 | Worker: adaptadores, `almacen-tickets-redis`, `claves.ticketSire`, `TokenRechazadoError` desde sunat | backend | sonnet | T4, T6 | ✓ | — | [ ] |
| T8 | `vitest` modo `contrato`, script `test:contrato`, exclusión verificada, `.env.example`, `03-arquitectura` §4 | devops | haiku | T6 ∥ T7 | — | — | [ ] |
| T9 | Prueba de contrato manual `sire.contrato.spec.ts` + Postman 5.51/5.40 | tester | sonnet | T6, T8 | — | — | [ ] |
| T10 | Ronda adversarial 1 (caja negra): ZIP, TXT, encabezados, filas ajenas, nombres hostiles, ticket ajeno, redirecciones, secretos | adversario | opus | T5, T6, T7 ∥ T9 | — | ✓ | [ ] |
| T11 | Pruebas de las correcciones de la ronda 1 (rojo) | tester | sonnet | T10 | ✓ | — | [ ] |
| T12 | Corregir hallazgos de la ronda 1 | backend | opus | T11 | — | — | [ ] |
| T13 | Ronda adversarial 2 (caja blanca): timeouts, presupuesto, reanudación entre estudios, memoria, codificación, concurrencia | adversario | opus | T12 | — | ✓ | [ ] |
| T14 | Pruebas de las correcciones de la ronda 2 (rojo) | tester | sonnet | T13 | ✓ | — | [ ] |
| T15 | Corregir hallazgos de la ronda 2 | backend | opus | T14 | — | — | [ ] |
| T16 | Corrida de la prueba de contrato contra SUNAT (la ejecuta el **usuario**) y ajustes de P-5/P-6 | tester | sonnet | T9, T15 | — | — | [ ] |
| T17 | Verificar CA-1 a CA-15 con evidencia y suites de `sunat`, `queue` y `worker` | tester | sonnet | T16 | — | — | [ ] |
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
