# Resultados 041 · SIRE real de solo lectura

Salida de las tareas de verificación; no la lee ningún agente para trabajar.

## T17 · Verificación (tester · sonnet, 2026-11-27)

Estado: **CA-1 a CA-12 y CA-14 cumplidos; CA-13 NO cumplido (depende de P-3); CA-15 pendiente (T16, la ejecuta el usuario)**. T17 queda `[ ]` en `tasks.md` hasta cerrar CA-13.

### Suites (BD `contapp_041t4`, Redis local, `SIRE_CLIENT=mock` salvo las pruebas que levantan el servidor falso)
| Comando | Resultado |
|---|---|
| `packages/sunat` `vitest run` (test) | 44 archivos, 1033 pasan, 1 `todo` (CA-13) |
| `packages/sunat` `vitest run --mode int` | sin archivos `*.int.spec.ts` (el paquete no tiene; sale 1 solo sin `--passWithNoTests`, el script sí lo lleva) |
| `packages/queue` test / test:int | 32 archivos, 796 pasan / 15 archivos, 123 pasan |
| `apps/worker` test / test:int | 64 archivos, 630 pasan / 71 archivos, 668 pasan |
| `pnpm -r typecheck` y `pnpm -r lint` | exit 0, 0 advertencias |
| `pnpm --filter @contapp/sunat test:contrato` sin `SIRE_CONTRATO=1` | «No test files found», exit 0 |

Fallos conocidos del entorno (escalada.adv 5, correo-funciones 1, reglas-lote 2, credencial-r1a MERGE…RETURNING 1): **no aparecieron** en esta corrida; ninguna suite falló, así que no hubo nada que comparar con la base.

### Cobertura de `packages/sunat/src/http` y `http/txt` (v8, solo pruebas unitarias; excluye `*.spec.ts`, `*.adv.spec.ts` y `http/pruebas/`)
Conjunto: 94,52 % sentencias · 91,54 % ramas · 94,66 % funciones · 98,19 % líneas (DoD de nivel A, ≥ 90 %: cumple).
Por archivo (los 100 % no se listan): `almacen-tickets` 92,9 / 80 / 80 / 100 · `sire-api-client.http` 92,9 / 95,5 / 83,3 / 96,3 · `sire-auth.http` 95,7 / 92,3 / 100 / 100 · `ticket` 98,0 / 92,6 / 100 / 100 · `transporte` 93,8 / 93,5 / 100 / 94,2 · `zip-seguro` 90,0 / 83,5 / 100 / 99,0 · `txt/encabezados` 100 / 92,9 / 100 / 100 · `txt/leer-txt` 97,3 / 96,4 / 100 / 100 · `txt/valores` 95,8 / 91,8 / 100 / 97,2. Bajo 90 % por archivo solo en ramas de `zip-seguro` (83,5) y `almacen-tickets` (80) y en funciones de `almacen-tickets` (80) y `sire-api-client.http` (83,3; incluye el rechazo fijo de `descargarRegistroPresentado`, líneas 121-123). Comando: `vitest run --coverage` con una config temporal fuera del repo (`/tmp/claude-0/t17/cov.config.mts`, include `src/http/**`).

### CA → evidencia
| CA | Estado | Evidencia |
|---|---|---|
| CA-1 | cumplido | `apps/worker/src/adaptadores/adaptadores-041.spec.ts` («CA-1 · SIRE_CLIENT=http», «producción: http no cuenta como mock», «las URL de SUNAT no vienen del entorno»); `adaptadores.module.spec.ts` (valor inválido nombra la variable); `descargar-propuesta-041.int.spec.ts` «CA-1/CA-2 descarga completa con SIRE_CLIENT=http»; las suites de 009–026 del worker siguen verdes (630 + 668) |
| CA-2 | cumplido | `sire-auth.http.spec.ts` («petición» formulario exacto de 6 campos, «respuesta» `expiraEn`, «errores HTTP» 400/401/5xx/429/timeout/red, `client_id` fuera de gramática sin llamar, canarios); `correcciones-r1.spec.ts` `expires_in` |
| CA-3 | cumplido | `txt/mapeo-compras.spec.ts` «fixture base (CA-3)»; `sire-api-client.http.spec.ts` «compras (RCE)» |
| CA-4 | cumplido | `txt/mapeo-ventas.spec.ts` «fixture base con BOM (CA-4)»; `sire-api-client.http.spec.ts` «ventas (RVIE)» |
| CA-5 | cumplido | `txt/encabezados.spec.ts`; `mapeo-compras.spec.ts` y `mapeo-ventas.spec.ts` «encabezado por nombre (CA-5)» (permutadas, extra, faltante, duplicada → `ErrorPortalSire` `encabezado`) |
| CA-6 | cumplido | `mapeo-*.spec.ts` «filas ajenas (CA-6)» y «filas inválidas (CA-6)»; `leer-txt.spec.ts` «otro número de campos (CA-6)»; `correcciones-r1.spec.ts` espacios Unicode |
| CA-7 | cumplido | `mapeo-compras.spec.ts` y `mapeo-ventas.spec.ts` «columnas sin equivalente (CA-7, P-2)» |
| CA-8 | cumplido | `ticket.spec.ts` (estados, ticket ajeno, plan de espera); `sire-api-client.http.spec.ts` «estados del ticket (CA-8)» y «ticket que no termina (P-4 c)»; `ronda2.adv.spec.ts` «clave del almacén» (5 partes); `packages/queue/src/claves-041.spec.ts`; `almacen-tickets-redis.int.spec.ts`; `descargar-propuesta-041.int.spec.ts` «CA-8 ticket que no termina» (verde con la espera corregida en el paso 1) |
| CA-9 | cumplido | `sire-api-client.http.spec.ts` «varias partes y nombres (CA-9)»; `correcciones-r1.spec.ts` «parte repetida»; `ronda1.adv.spec.ts` |
| CA-10 | cumplido | `zip-seguro.spec.ts` (estructura, cifrado, corrupto, bomba de 1 GiB con cabecera honesta y mentirosa, topes 32/64 MiB, razón 200:1); `leer-txt.spec.ts` «codificación (P-6, CA-10)» |
| CA-11 | cumplido | `transporte.spec.ts`; `sire-api-client.http.spec.ts` «códigos HTTP de la API (CA-11)»; `cache-token.int.spec.ts` «CA-11 401, errores y valores alterados»; `descargar-propuesta-041.int.spec.ts` «CA-11 401 → una renovación del token» y «otros errores de la API»; `sire-http-r2.adv.int.spec.ts` |
| CA-12 | cumplido | `sire-auth.http.spec.ts` «canarios»; `sire-api-client.http.spec.ts` «secretos (CA-12)»; `descargar-propuesta-041.int.spec.ts` «CA-12 secretos» y «cada petición va a su ruta»; `almacen-tickets-redis.int.spec.ts` «CA-12 en Redis solo queda el número de ticket» |
| CA-13 | **NO cumplido** | `HttpSireApiClient.descargarRegistroPresentado` (`sire-api-client.http.ts:120-124`) rechaza siempre con `ErrorPortalSire("respuesta_inesperada")` sin llamar a la red: P-3 (c) dejó el servicio pendiente de la respuesta real de Postman 5.51/5.40. La prueba queda como `it.todo` (`sire-api-client.http.spec.ts:676`). Con `SIRE_CLIENT=http`, la importación de historial (025) falla en el primer periodo. Se cierra con T16 + decisión de P-3 |
| CA-14 | cumplido | `mapeo-compras.spec.ts` «volumen (CA-14)»: 20.000 filas, mediana de 5 < 3 s, TXT < 64 MiB, ZIP → TXT → filas |
| CA-15 | pendiente (T16, la ejecuta el usuario) | Parte automática verificada: `vitest-contrato.spec.ts` (excluida de `test` y `test:int`; sin `SIRE_CONTRATO=1` no corre; con él corre solo `*.contrato.spec.ts`) y `pnpm --filter @contapp/sunat test:contrato` sin variable → sin pruebas. `sire.contrato.spec.ts` verde contra el servidor falso (T9). La corrida real no se ejecutó nunca |

### Revisiones pedidas
- **(a) `correcciones-r1.spec.ts`** (7 casos de T12): correcto y no debilita nada. Parte repetida con otra mayúscula (+ control de dos partes), `expires_in` (9 valores inválidos, tope 86 400 s aceptado) y espacios Unicode (NBSP, U+2007, U+202F, U+3000, U+FEFF, U+200B) en monto, tipo de cambio, fecha y, de extremo a extremo, `BI Gravado DG` y `Periodo`. Cada aserción falla si se vuelve a `String#trim`. Observación menor: el tope de 86 400 s de `expires_in` no figura en la spec ni en el plan (decisión de T12); y la variante `fecha` solo prueba el espacio a la derecha.
- **(b) Clave de 5 partes y `claveReanudacion`**: cubiertas. `claveReanudacion` = `{tenant}:{cliente}` en `clave-reanudacion-041.spec.ts` (propuesta y registro del historial) y en `sire-api-client.http.spec.ts` (con almacén sin clave no guarda); clave de 5 partes en `ronda2.adv.spec.ts` y `claves-041.spec.ts`. **Hueco encontrado y cubierto**: `AlmacenTicketsRedis` rechazaba claves de 4 o 6 partes, libro u operación desconocidos y estudio vacío (H-041-2-4) sin prueba; se agregó en `almacen-tickets-redis.int.spec.ts` (10/10 verdes).
- **(c) Datos reales**: sin hallazgos en 041. Revisados `fixtures/sire/http/*`, `fixtures/LEEME.md`, `tools/sire-postman/`, `docs/specs/041-sire-real-lectura/` y `packages/sunat/src/http/` (+ los dos archivos del worker de 041): todo RUC de 11 dígitos sale de `fixtures/rucs-prueba.json`, salvo el marcador `20100000001` dentro de `servidor-sire-falso.spec.ts` (nombre de usuario ficticio de una prueba). Todas las razones sociales de las filas empiezan con «PRUEBA». Aparte, fuera de 041 hay RUC con forma de reales en `docs/curso/`, `docs/guia/` y algunos `tasks.md` antiguos (p. ej. 20100070970, 20131312955, 20100047218); no se revisó si son ejemplos públicos; quedan fuera de este alcance.
