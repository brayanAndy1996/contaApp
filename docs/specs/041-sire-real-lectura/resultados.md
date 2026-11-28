# Resultados 041 · SIRE real de solo lectura

## T17 · Verificación final (tester · sonnet, 2026-11-28; tras T15g y la corrida de contrato del usuario)

Veredicto: **CA-1 a CA-15 cumplidos**. Sin datos reales en el repo. Ninguna prueba desactivada fuera de los `skipIf` condicionales listados al final; no queda ningún `it.todo`.

### Suites (BD `contapp_041t4`, Redis local, reporter `dot`; las largas con `nohup` y log)
| Paquete | Comando | Resultado |
|---|---|---|
| `packages/sunat` | `pnpm test` | 50 archivos, **1235 pruebas verdes** (`test:int` no existe en este paquete) |
| `packages/queue` | `pnpm test` / `pnpm test:int` | 32 archivos, **797** / 15 archivos, **123** verdes |
| `apps/worker` | `pnpm test` / `pnpm test:int` | 64 archivos, **630** / 72 archivos, **672** verdes |
| Todo el monorepo | `pnpm -r typecheck` · `pnpm -r lint` | sin errores ni advertencias (exit 0 ambos) |
| Prueba de contrato (servidor falso, sin credenciales) | `SIRE_CONTRATO=1 SIRE_CONTRATO_FALSO=1 pnpm --filter @contapp/sunat test:contrato` | 4 verdes + 1 omitida (diagnóstico, solo con `SIRE_CONTRATO_DIAGNOSTICO=1`) |
| Contrato sin `SIRE_CONTRATO=1` | `pnpm --filter @contapp/sunat test:contrato` | «No test files found»: no corre nada |

Los fallos conocidos del entorno (escalada.adv, correo-funciones, reglas-lote, credencial-r1a) no aparecieron en `apps/worker` ni en `queue`; esta corrida no tuvo fallos que atribuir.

### Cobertura de `packages/sunat/src/http` y `http/txt` (v8, solo pruebas unitarias; excluye `*.spec.ts` y `http/pruebas/`)
Comando: `pnpm exec vitest run --coverage.enabled --coverage.provider=v8 --coverage.include='src/http/**/*.ts' --coverage.exclude='**/*.spec.ts' --coverage.exclude='src/http/pruebas/**'` (corrida ad hoc, sin config nueva).
| Grupo | Sentencias | Ramas | Funciones | Líneas |
|---|---|---|---|---|
| `http/` | 95,95 % | 93,63 % | 95,58 % | 99,34 % |
| `http/txt/` | 97,91 % | 94,17 % | 100 % | 99,11 % |
| Total | 96,34 % | 93,75 % | 96,73 % | 99,29 % |

Por archivo todo queda sobre 90 % en sentencias y ramas, salvo `almacen-tickets.ts` (92,85 % sentencias, **80 % ramas**: es el almacén en memoria de pruebas, 37 líneas; la clase real de producción es `AlmacenTicketsRedis` y se prueba en `apps/worker`). Ningún `vitest.cobertura*.config.mts` mide `src/http` hoy: el umbral no está en CI, solo se verificó aquí.

### CA → evidencia
| CA | Estado | Evidencia (pruebas verdes) |
|---|---|---|
| CA-1 | Cumplido | `apps/worker/src/adaptadores/adaptadores-041.spec.ts`: «CA-1 · SIRE_CLIENT=http» (http da `HttpSireAuth` + `HttpSireApiClient`; ausente/`mock`/`undefined` → mocks; valor ajeno → error que nombra la variable), «CA-1 · producción: http no cuenta como mock», «CA-1 · las URL de SUNAT no vienen del entorno». `adaptadores.module.spec.ts` y las suites de 009–026 siguen verdes (worker 630 + 672) |
| CA-2 | Cumplido | `sire-auth.http.spec.ts`: «petición» (formulario exacto de 6 campos, sin Authorization, solo host de seguridad), «respuesta» (`expiraEn` = ahora + `expires_in`), «errores HTTP» (400/401 → Credencial; 429/5xx/timeout/red → Transitorio; 3xx no se sigue), «client_id fuera de gramática» (sin llamar); `correcciones-r1.spec.ts` «H-041-1-2 · expires_in» (0, no entero, tope → Portal) |
| CA-3 | Cumplido | `txt/mapeo-compras.spec.ts` «fixture base (CA-3)»; `sire-api-client.http.spec.ts` «compras (RCE)» |
| CA-4 | Cumplido | `txt/mapeo-ventas.spec.ts` «fixture base con BOM (CA-4)» (`500`/`1837.5` → `500.00`/`1837.50`); `sire-api-client.http.spec.ts` «ventas (RVIE)» |
| CA-5 | Cumplido | `txt/mapeo-compras.spec.ts` y `mapeo-ventas.spec.ts` «encabezado por nombre (CA-5)»; `txt/encabezados.spec.ts` (normalización) |
| CA-6 | Cumplido | `mapeo-*.spec.ts` «filas ajenas (CA-6)» y «filas inválidas (CA-6): nunca se redondea»; `leer-txt.spec.ts` «filas con otro número de campos (CA-6)»; `correcciones-r1.spec.ts` «H-041-1-3» (espacios Unicode); registro: «fila con RUC o Periodo ajenos → respuesta_ajena sin filas» |
| CA-7 | Cumplido | `mapeo-compras.spec.ts` y `mapeo-ventas.spec.ts` «columnas sin equivalente (CA-7, P-2)» (`columna_no_soportada`, nunca en silencio) |
| CA-8 | Cumplido | `ticket.spec.ts` (estados 01/02/05, 04/06, 03, desconocido; «ticket ajeno (CA-8)» por `numTicket`; `planEsperaTicket`); `sire-api-client.http.spec.ts` «estados del ticket (CA-8)» y «ticket que no termina (P-4 c)»; `ronda2.adv.spec.ts` «el reintento retoma el ticket sin exportar de nuevo», «clave del almacén»; `packages/queue/src/claves-041.spec.ts` (estudio y cliente en la clave); `almacen-tickets-redis.int.spec.ts`; `descargar-propuesta-041.int.spec.ts` «CA-8: ticket que no termina» |
| CA-9 | Cumplido | `sire-api-client.http.spec.ts` «varias partes y nombres (CA-9)»; `correcciones-r1.spec.ts` «H-041-1-1 · parte repetida»; `ronda2.adv.spec.ts` «varias partes y memoria» y «codificación entre partes» |
| CA-10 | Cumplido | `zip-seguro.spec.ts` (estructura, bomba deflate 1 GiB con cabecera honesta y mentirosa, topes 32 MiB/64 MiB/200:1, cifrado, corrupto); `zip-seguro-registro.spec.ts` (estructura real de 3 entradas aceptada; variantes que siguen rechazadas; nombres hostiles también en las ignoradas; bomba y topes con carpeta); `zip-seguro-r3.spec.ts` y `ronda3.adv.spec.ts` (descriptor de datos, campo extra); `leer-txt.spec.ts` «codificación (P-6, CA-10)». Nota: la regla «más de 1 entrada» del texto de CA-10 pasa a «hasta 8 entradas con exactamente UNA con datos (`.txt` sin cifrar); se ignoran carpetas y entradas vacías, validando todos los nombres» por la evidencia real (T15e); el resto de CA-10 sin cambio |
| CA-11 | Cumplido | `sire-api-client.http.spec.ts` «códigos HTTP de la API (CA-11)»; `transporte.spec.ts` (mapeo de estados, red, tope de bytes); `ronda1.adv.spec.ts` «adv · HTTP»; `ronda2.adv.spec.ts` «presupuesto de la operación»; worker: `descargar-propuesta-041.int.spec.ts` «CA-11: 401 → una renovación del token» y «otros errores», `sire-http-r2.adv.int.spec.ts` |
| CA-12 | Cumplido | `sire-api-client.http.spec.ts` «secretos (CA-12)»; `sire-auth.http.spec.ts` «canarios»; `ronda1.adv.spec.ts` «adv · secretos»; `ronda3.adv.spec.ts` (canarios de fila sin fuga); worker: `descargar-propuesta-041.int.spec.ts` «CA-12: secretos» (logs, `job_registro`, Redis y tablas) y «cada petición va a su ruta»; el evento SSE es la vista pública, probado en `secretos.int.spec.ts` |
| CA-13 | Cumplido | `registro-presentado.http.spec.ts` (una sola solicitud 70+PEN, ticket único, clave `…:registro`, «sin datos» → `ErrorDatos`, filas PEN y USD en un archivo, re-solicitud única, presupuesto); `zip-seguro-registro.spec.ts`; worker: `importar-historial-041.int.spec.ts` «CA-13: importar historial con registro presentado y SIRE_CLIENT=http» (dos periodos, uno sin datos), `clave-reanudacion-041.spec.ts`, `almacen-tickets-redis.int.spec.ts` (rechaza `registro-pen`/`registro-usd`) |
| CA-14 | Cumplido | `txt/mapeo-compras.spec.ts` «volumen (CA-14)»: 20.000 filas, TXT < 64 MiB y «parseo y mapeo en menos de 3 s (mediana de 5)» |
| CA-15 | Cumplido | Excluida de `test`, `test:int` y los 5 `vitest.cobertura*.config.mts`: `src/vitest-contrato.spec.ts` (verde); `.github/workflows/ci.yml` no la menciona; sin `SIRE_CONTRATO=1` no corre nada. Contra el servidor falso: 4 verdes. Formas y contenido de lo impreso: `http/pruebas/contrato-sire.spec.ts` (solo formas, sin valores). **Corrida real del usuario (2026-11-28/29, 2 RUC, resultados favorables)**: solo formas, abajo |

### CA-15 · salida real de formas (corrida del usuario; sin RUC, ni nombres, ni montos, ni tickets)
- Token: obtenido, vida de **3600 s**.
- Propuesta de compras y de ventas: flujo exportar → ticket (estados 05, 06) → archivo; **80** y **40** columnas; encabezado idéntico al sintético.
- Registro presentado (5.51): **una sola solicitud** `codProceso` 70 + `codMoneda` PEN; ticket → archivo; ZIP de **3 entradas** (archivo `.txt` en carpeta + entrada vacía duplicada + carpeta), prefijo `PK\x07\x08`, sin descriptor de datos; legible. **80 columnas**; la diferencia de nombre del encabezado está solo en la columna 34 (no mapeada). Un RUC: 12 filas, Moneda USD 2 y PEN 10. El otro: 33 filas PEN con 1 nota de crédito negativa.
- P-5: nota de crédito con total negativo ✓; USD 4 de 4 con tipo de cambio ✓; boletas sin documento (40) ✓; **notas de débito: sin casos reales, no verificado**.
- P-6: 0 errores de codificación (UTF-8 estricto basta).
- Hallazgo de diseño (ya aplicado en T15d–T15g): `codMoneda` obligatorio (error 1061 si falta) y `codProceso` solo 70 válido (01/02/00 dan 1026); `codMoneda` **no filtra** el archivo. Por eso el registro es una sola operación.

### Revisiones pedidas
- **(a) Datos reales**: sin hallazgos en 041. Revisados `fixtures/sire/http/*` (todo texto con letras es «PRUEBA…» o numérico), `tools/sire-postman/` (sin valores de credenciales), `docs/specs/041-sire-real-lectura/`, `packages/sunat/src/http/` y `apps/worker/src/trabajos`. Los únicos RUC de 11 dígitos en fixtures, postman y `http/` son los de `fixtures/rucs-prueba.json` (más el canario `98765432101`, que no es un RUC). Sin nombres de archivo con RUC real ni filas de TXT reales; sin `.env` versionado (solo `.env.example`). Aparte: specs anteriores a 041 (021, 025) usan RUC de 11 dígitos fuera de `rucs-prueba.json` en `importar-historial.r1.spec.ts` y `persistidor-reglas.int.spec.ts`; no son de 041 y no se tocaron.
- **(b) Exclusión de la prueba de contrato**: `vitest-contrato.spec.ts` comprueba `test`, `test:int` y todos los `vitest.cobertura*.config.mts` presentes (verde); el script `test` y `test:int` no mencionan «contrato»; `ci.yml` no tiene ninguna referencia a `contrato` ni a `SIRE_CONTRATO`.
- **(c) Claves del almacén**: `registro-presentado.http.spec.ts` (claves de 5 partes que terminan en `:registro`; propuesta y registro del mismo periodo no comparten ticket), `claves-041.spec.ts` (formato `prefijo:sire:ticket:estudio:cliente:libro:periodo:operación`), `almacen-tickets-redis.int.spec.ts` (rechaza `registro-pen` y `registro-usd`).
- **(d) `correcciones-r1.spec.ts` y `zip-seguro-r3.spec.ts`** (escritas por backend): verdes y siguen correctas. La primera prueba H-041-1-1 (parte repetida), H-041-1-2 (`expires_in`) y H-041-1-3 (celdas ASCII); la segunda, el descriptor de datos que debe coincidir con la central (CRC y tamaños, deflate y stored), la entrada vacía ignorada con descriptor y el campo extra (ZIP64 rechazado, otro no). Son compatibles con la estructura real de 3 entradas y no relajan ningún tope.
- **(e) Pruebas desactivadas**: sin `.skip`, `xit`, `xdescribe`, `.only` ni **`it.todo`** en `packages/sunat`, `packages/queue` y `apps/worker` (el `it.todo` de T15b ya no existe). Solo quedan 5 `skipIf` condicionales por entorno: `sire.contrato.spec.ts` (`describe.skipIf(!activa)` = sin `SIRE_CONTRATO=1`; `it.skipIf(!diagnostico)`), `packages/queue/src/catalogo-r1b.adv.spec.ts` (sin `dist`), `apps/worker/src/trabajos/cierre-r1b.adv.int.spec.ts` y `cierre-r2a.adv.int.spec.ts` (sin `redis-server` o sin `main.js`; en esta corrida el entorno los tuvo y las suites quedaron verdes).

### Pendientes para otros roles
- T16 sigue `[ ]` en `tasks.md`: la corrida real la hizo el usuario y la salida de formas está arriba; marcarla y cerrar P-3, P-5, P-6 queda al orquestador.
- Notas de débito sin verificar con datos reales (P-5).
- Si se quiere el umbral de 90 % de `src/http` en CI, falta añadir un config de cobertura (hoy solo se midió ad hoc).
