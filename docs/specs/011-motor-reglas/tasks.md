# Tareas 011 · Motor de reglas

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la indicada (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: andamiaje → pruebas (rojo) → implementación (verde, cobertura por archivo desde el diseño) → integración → adversario (máx. 2 rondas, cada una en dos piezas) → verificación → revisión final → cierre. La rama `spec/011-motor-reglas` ya existe (desde `main`) y los docs aprobados están commiteados. CA = `spec.md`; contratos y decisiones = `plan.md`. **011 se implementa primero (011 → 008 → 006) y no toca la BD**: ninguna tarea crea migraciones ni usa `withTenant`; las pruebas corren sin PostgreSQL.

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Andamiaje: cobertura de `reglas/` y `texto/` | devops | haiku | — | — | — | [x] |
| T2 | Pruebas del lint de dinero en `reglas/` (rojo) | tester | sonnet | — ∥ T1 | ✓ | — | [x] |
| T3 | Pruebas de `texto/` (rojo) | tester | sonnet | — ∥ T2 | ✓ | — | [x] |
| T4 | Pruebas de R-ISC, R-MIX, rango y precedencia (rojo) | tester | sonnet | — ∥ T3 | ✓ | — | [x] |
| T5 | Pruebas de R-RED, R-NEW, R-GP, motor y aplicar (rojo) | tester | sonnet | — ∥ T4 | ✓ | — | [x] |
| T6 | Casos reales de reglas (rojo) | tester | sonnet | — ∥ T5 | ✓ | — | [x] |
| T6b | Pruebas de la ratificación del arquitecto (rojo) | tester | sonnet | T6 | ✓ | — | [x] |
| T7 | Lint de dinero en `reglas/` | devops | sonnet | T2 ∥ T8 | ✓ | — | [x] |
| T8 | Implementar `texto/` | backend | sonnet | T1, T3 | ✓ | — | [x] |
| T9 | Implementar tipos, entrada, rango, R-ISC y R-MIX | backend | opus | T1, T4, T6b ∥ T8 | ✓ | — | [x] |
| T10 | Implementar R-RED, R-NEW, R-GP, motor y aplicar | backend | opus | T5, T6, T6b, T8, T9 | ✓ | — | [x] |
| T11 | Integración: checks completos | devops | haiku | T7, T10 | — | — | [x] |
| T12a | Ronda 1a: lista mínima de la spec (caja negra) | adversario | opus | T11 | — | ✓ | [ ] |
| T12b | Ronda 1b: escenarios nuevos (caja blanca) | adversario | opus | T11 ∥ T12a | — | ✓ | [ ] |
| T13 | Corregir hallazgos de la ronda 1 | backend | opus | T12a, T12b | — | — | [[x] |
| T14a | Ronda 2a: regresión de correcciones | adversario | opus | T13 | — | ✓ | [ ] |
| T14b | Ronda 2b: escenarios nuevos contra las correcciones | adversario | opus | T13 ∥ T14a | — | ✓ | [ ] |
| T15 | Corregir hallazgos de la ronda 2 | backend | opus | T14a, T14b | — | — | [ ] |
| T16 | Verificar CA-1 a CA-13 y cobertura con evidencia | tester | sonnet | T15 | — | — | [ ] |
| T17 | Revisión final contra la spec | arquitecto | opus | T16 | — | — | [ ] |
| T18 | Cierre: ESTADO, tasks y commit | devops | haiku | T17 | — | — | [ ] |

Escalamientos: —

Decisiones del usuario: 2026-10-27, "Apruebo las specs 006, 008 y 011 con todo lo recomendado por el arquitecto en cada P. Continúa con plan y tareas." (P-1–P-3 → D-5–D-7 de la spec). Ratificación técnica de los contratos fijados por T2–T6: `plan.md`, Decisiones, "Ratificación de contratos" (arquitecto, 2026-10-27).

Reglas comunes:
- Un commit por tarea (Conventional Commits `feat(011): …`, `test(011): …`, `fix(011): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md`: `git add <rutas>` explícitas, nunca `git add -A`/`.`.
- `docs/specs/ESTADO.md` lo mantiene el orquestador en `main`; en esta rama solo lo tocan T12a–T14b (hallazgos, releyendo antes) y T18.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o "OK" + conteo. Correr solo `@contapp/domain` y `@contapp/tests-limites`; la suite completa en T11 y T16.
- El tester no toca código de producción; backend no edita `*.spec.ts` ni `*.adv.spec.ts` (si necesita una prueba, la pide); el adversario solo escribe `*.adv.spec.ts`.
- Ningún `number` para montos fuera de pruebas; en pruebas, `x as unknown as string` (no `as any`). Montos solo con la API pública de 010; nunca `decimal.js` fuera de `dinero/decimal.ts`.
- No modificar `dinero/` ni `comprobante/` salvo un error de 010 demostrado por una prueba (anotarlo en la tarea y avisar al orquestador). Las pruebas de 010 siguen en verde.
- Nunca bajar el umbral de cobertura ni excluir archivos: subtareas tester (ramas faltantes) y backend.
- Escalar según 04 §3.3 y anotar arriba. Una ambigüedad que cambie la spec no se decide: `requiere usuario` y se informa al orquestador.

## T1 · Andamiaje de cobertura (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/011-motor-reglas/plan.md` (Decisiones: Lint y cobertura), `packages/domain/vitest.cobertura.config.mts`.
- **Hacer**: agregar `src/reglas/**/*.ts` y `src/texto/**/*.ts` al `include` de cobertura; actualizar el comentario (010 y 011). Nada más.
- **Hecho cuando**: `pnpm cobertura:dominio` sale 0 (las carpetas aún no existen); un `src/reglas/__tmp.ts` sin pruebas hace fallar por ese archivo (borrarlo). Commit `test(011): cobertura de reglas y texto con umbral 90 % por archivo`.
- **Resultado**: `packages/domain/vitest.cobertura.config.mts` incluye `src/reglas/**/*.ts` y `src/texto/**/*.ts` en `include` (comentario a 010 y 011). `pnpm install --frozen-lockfile` en el worktree sin cambios de lockfile. `pnpm cobertura:dominio` sale 0 sin las carpetas: 20 archivos de prueba, 505 pasan, 1 todo. Con `src/reglas/__tmp.ts` sin pruebas sale 1 por ese archivo (`Coverage for lines (0%) ... for src/reglas/__tmp.ts`); archivo y carpeta borrados. `pnpm --filter @contapp/domain lint` OK y Prettier OK. Sin BD ni migraciones.

## T2 · Pruebas del lint en reglas/, rojo (tester · sonnet) ∥ T1
- **Contexto (leer solo esto)**: `docs/specs/011-motor-reglas/spec.md` (CA-13), `plan.md` (Decisiones: Lint y cobertura), `tests/limites/dominio.spec.ts` (patrón `lintText`, primeras 60 líneas).
- **Hacer**: `tests/limites/dominio-reglas.spec.ts`: con `filePath` `packages/domain/src/reglas/__prueba__.ts` fallan `let x: number`, `parseFloat("1")`, `Number("1")`, `Math.round(1)`, `+s`, `d.toNumber()`, `import Decimal from "decimal.js"`; el mismo código en `…/reglas/__prueba__.spec.ts` pasa; en `packages/domain/src/texto/__prueba__.ts` `let i: number = 0` pasa, pero `import "node:fs"` y `fetch("x")` fallan (lint de IO de 010).
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` falla solo en los casos de `reglas/` que cubrirá T7; los demás archivos siguen verdes. Commit `test(011): lint contra number en reglas (rojo)`.
- **Resultado** (4ffb961): `tests/limites/dominio-reglas.spec.ts` (7 pruebas). Ratificado sin cambios; T7 las dejó en verde.

## T3 · Pruebas de texto/, rojo (tester · sonnet) ∥ T2
- **Contexto (leer solo esto)**: `spec.md` (CA-12, D-5), `plan.md` (Contratos: `texto/`; Decisiones: R-GP).
- **Hacer**: `packages/domain/src/texto/{normalizar,diccionario}.spec.ts` contra `../index`: tildes y mayúsculas ("ZAPATILLAS", "Zapatíllas"), plural `s`/`es`, abreviatura "zapat." (prefijo, ≥ 4 letras, solo con punto), "zapata de concreto" y "zap." no coinciden, separadores (`|`, saltos de línea, tabulaciones, NBSP), cadena vacía, `DiccionarioGlosas.desde` rechaza palabras vacías, con espacios o < 3 letras, orden determinista de `buscar`, `DICCIONARIO_GLOSAS_BASE` congelado, glosa de 1 MB en < 1 s.
- **Hecho cuando**: `pnpm --filter @contapp/domain test` falla solo por falta de implementación. Commit `test(011): normalización de glosas y diccionario (rojo)`.
- **Resultado** (f8b74a3): `texto/{normalizar,diccionario}.spec.ts` (51 pruebas). Fijan `Coincidencia`, singular normalizado, abreviatura con punto y ≥ 4 letras, "gana la primera glosa y dentro de ella la primera palabra del diccionario", base congelada. Ratificado; T8 las dejó en verde.

## T4 · Pruebas de R-ISC, R-MIX, rango y precedencia, rojo (tester · sonnet) ∥ T3
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-5, CA-10, D-1–D-3, D-7), `plan.md` (Contratos: `reglas/`; Decisiones: Evaluación por destino, R-ISC, Rango de R-MIX), `packages/domain/tests/ayudas/comprobante.ts`.
- **Hacer**: `packages/domain/tests/ayudas/filas.ts` (constructores de `FilaEvaluable`, `ResumenXml` y contexto vacío) y `packages/domain/src/reglas/{r-isc,r-mix,rango}.spec.ts` vía `evaluarReglas`/`aplicarSugerencia` públicos: R-ISC sin y con XML, XML sin ISC, proveedor marcado con IGV ≠ 0 (sin y con XML), varios destinos; R-MIX con explicación exacta, rango, estimado acotado, `exacto` con XML a 18 % y a 10 %, XML con IGV distinto, rango vacío (BI 0 con IGV, IGV > 18 % de la BI, signos distintos); CA-4 como propiedad con oráculo de centavos enteros (semilla fija, 1000 corridas, notas de crédito incluidas); CA-5 completo; CA-10 en USD y negativos.
- **Hecho cuando**: igual que T3. Commit `test(011): R-ISC, R-MIX y rango del gravado (rojo)`.
- **Resultado** (7093a3f): `tests/ayudas/filas.ts`, `reglas/{r-isc,r-mix,rango}.spec.ts` (62 pruebas) y stubs provisionales `reglas/{tipos,errores,motor,aplicar,index}.ts` y `texto/index.ts`. Ratificado: "XML sin ISC: revisar" es un hallazgo R-ISC sin sugerencia (no un aviso); exacto a 10 % con min/max a 18 %; orden por regla y luego DG, DGNG, DNG. El orden de min/max en notas de crédito lo fija T6b (numérico).

## T5 · Pruebas de R-RED, R-NEW, R-GP, motor y aplicar, rojo (tester · sonnet) ∥ T4
- **Contexto (leer solo esto)**: `spec.md` (CA-6 a CA-9, CA-11, CA-12, D-4–D-6), `plan.md` (Contratos; Decisiones: R-RED, R-NEW, R-GP, XML ajeno, Obsolescencia, Entrada estricta), `packages/domain/tests/ayudas/filas.ts` (de T4; si aún no existe, crearlo con la misma forma y coordinar en el commit).
- **Hacer**: `packages/domain/src/reglas/{r-red,r-new,r-gp,motor,aplicar}.spec.ts`: R-RED con diferencia dentro y fuera del umbral, con XML que señala una columna, con `origenUsd` (valores sintéticos: PEN que no coincide con `convertirAPen`), origen descuadrado, montos al borde del rango; R-NEW con documento con espacios/minúsculas, otro tipo, conocido; R-GP con y sin XML; CA-8 (sin mutación, determinismo, permutación); CA-11 (`XML_AJENO`, `XML_MONEDA`); entrada inválida (ids repetidos, objeto falso en `montos`, claves extra, `__proto__` en el contexto); CA-9 (conservación del total salvo R-RED, `SugerenciaObsoletaError`, dos R-ISC seguidas en la misma fila, masivo con rechazos `requiere_dato` y encadenado por fila, confirmación fuera de rango).
- **Hecho cuando**: igual que T3. Commit `test(011): R-RED, R-NEW, R-GP, motor y aplicación (rojo)`.
- **Resultado** (3e0ceec): `tests/ayudas/filas-motor.ts`, `reglas/{r-red,r-new,r-gp,motor,aplicar}.spec.ts` (107 pruebas). Ratificado: R-RED con XML ajusta la columna sin umbral (lectura de D-6 en el plan); `origenUsd` con `requiereConfirmacion = false`; XML ajeno o de otra moneda = sin XML; contexto estricto; rechazos de `aplicarMasivo` = `codigo` del error de `aplicarSugerencia`, salvo `requiere_dato`. Faltantes que cubre T6b.

## T6 · Casos reales de reglas, rojo (tester · sonnet) ∥ T5
- **Contexto (leer solo esto)**: `spec.md` (CA-1, CA-2, CA-3, CA-6, CA-12, Casos reales), `docs/01-definiciones-base.md` (puntos 9, 10, 11 y 15 de la lista que empieza en "Reglas de negocio nuevas"), `docs/02-requerimientos.md` (HU-23 y HU-24, solo esas).
- **Hacer**: `packages/domain/tests/casos-reales/reglas.spec.ts`: San Juan 770 (sin y con XML, explicación textual, aplicar); mixta 21.48/1.61 sin XML (rango 8.92–8.97, estimado 8.94, explicación "1.61 no es 18 % ni 10 % de 21.48", aplicar con 8.97 → 8.97 + 12.51) y con XML (exacta 8.97/12.51); zapatilla ("ZAPATILLAS URBANAS T-42", "zapat. dep."; "zapata de concreto" no); `it.todo("redondeo USD: caso real diferido, sin cifras")`. No inventar cifras. Boleta 291 no va aquí (013).
- **Hecho cuando**: igual que T3. Commit `test(011): casos reales de reglas (rojo)`.
- **Resultado** (449edd8): `tests/casos-reales/reglas.spec.ts` (19 pruebas, con el `it.todo` USD). Ratificado sin cambios.

## T6b · Pruebas de la ratificación, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Decisiones: "Ratificación de contratos"), `packages/domain/src/reglas/{r-red,r-mix}.spec.ts`, `packages/domain/tests/ayudas/{filas,filas-motor}.ts`.
- **Hacer**: agregar (sin cambiar las existentes salvo la línea indicada) en `reglas/r-mix.spec.ts`: en la nota de crédito −21.48/−1.61, `min` = "-8.97" y `max` = "-8.92" exactos (reemplaza el `.sort()`), y aplicar con −8.92 y −8.97 válido, −8.91 y −8.98 inválido. En `reglas/r-red.spec.ts`: (a) XML válido con `xml.total ≠ total` y `Σ = xml.total` (p. ej. 100.00 + 18.00, total SIRE 118.01, XML 118.00) → `ajustar { total: 118.00 }` y `requiereConfirmacion = false`; (b) XML válido con `xml.total = total`, diferencia 0.01 y ningún grupo que la explique → sin sugerencia (el umbral no aplica con XML); (c) ajuste por umbral sin XML → `requiereConfirmacion = true`; (d) XML que respalda una columna → `requiereConfirmacion = false`; (e) explicaciones exactas de R-RED, R-ISC sin XML y R-MIX rango vacío según el catálogo del plan.
- **Hecho cuando**: las nuevas fallan solo por falta de implementación; las demás no cambian. Commit `test(011): pruebas de la ratificación de contratos (rojo)`.
- **Resultado**: `r-mix.spec.ts` (+1 prueba; `.sort()` reemplazado por min "-8.97" / max "-8.92") y `r-red.spec.ts` (+9: precedencia y confirmación a-d, y 5 explicaciones exactas del catálogo: R-RED sin respaldo, negativa, con sufijo XML, R-ISC sin XML, R-MIX rango vacío). Rojo: fallan por "no implementado" (stubs); no se probó la explicación de `origenUsd` (formato de TC no fijado).

## T7 · Lint de dinero en reglas/ (devops · sonnet) ∥ T8
- **Contexto (leer solo esto)**: `plan.md` (Decisiones: Lint y cobertura), `eslint.config.mjs` (bloque "Dinero (spec 010, CA-1)"), `tests/limites/dominio-reglas.spec.ts`.
- **Hacer**: agregar `packages/domain/src/reglas/**` a `files` de ese bloque; mensajes que digan "spec 010/011". No tocar otros bloques.
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` en verde (todos los archivos); `pnpm lint` en verde. Commit `feat(011): lint contra number en reglas`.
- **Resultado**: `eslint.config.mjs`: `packages/domain/src/reglas/**` agregado a `files` del bloque "Dinero" (mensajes "spec 010/011, CA-1"). `pnpm --filter @contapp/tests-limites test` OK: 11 archivos, 275 pruebas. `pnpm --filter @contapp/domain lint`: sin errores de `number`; solo `no-unused-vars` en los stubs `reglas/aplicar.ts` y `reglas/motor.ts` (T2), que T9/T10 reemplazan.

## T8 · Implementar texto/ (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: `texto/`; Decisiones: R-GP), `packages/domain/src/texto/*.spec.ts`.
- **Hacer**: `texto/{normalizar,diccionario,index}.ts` y reexportación en `src/index.ts`. Algoritmo lineal, sin regex con retroceso, sin IO, sin importar `dinero/`.
- **Hecho cuando**: pruebas de `src/texto/` en verde; `build`, `typecheck`, `lint` del paquete OK; cada archivo de `texto/` ≥ 90 % en `pnpm cobertura:dominio`. Commit `feat(011): normalización de glosas y diccionario`.
- **Resultado**: 74/74 pruebas de `src/texto/` en verde; `build` y lint de `texto/` OK; cobertura `texto/` 98 % (diccionario.ts 97 %). `typecheck` del paquete aún falla solo por `reglas/` (T9/T10).

## T9 · Implementar tipos, entrada, rango, R-ISC y R-MIX (backend · opus) ∥ T8
- **Contexto (leer solo esto)**: `plan.md` (todo), `spec.md` (CA-1 a CA-5, CA-10, D-1–D-3, D-7), `packages/domain/src/reglas/{r-isc,r-mix,rango}.spec.ts`, `packages/domain/src/dinero/index.ts`, `packages/domain/src/comprobante/index.ts`.
- **Hacer**: `reglas/{tipos,errores,entrada,explicaciones,rango,r-isc,r-mix}.ts` y un `motor.ts`/`aplicar.ts` mínimos que hagan pasar esas pruebas (T10 los completa). Solo API pública de 010.
- **Hecho cuando**: pruebas de `r-isc`, `r-mix` y `rango` en verde; `build`, `typecheck`, `lint` OK. Commit `feat(011): R-ISC, R-MIX y rango del gravado`.
- **Fijado por las pruebas** (plan, "Ratificación de contratos"): reemplazar los stubs `tipos.ts` y `errores.ts` del tester conservando nombres, forma y `codigo` (`ENTRADA_INVALIDA`, `SUGERENCIA_OBSOLETA`, `CONFIRMACION_INVALIDA`); explicaciones del catálogo (San Juan con XML: texto exacto); "XML sin ISC: revisar" como hallazgo R-ISC sin sugerencia; rango con `min ≤ max` numérico (NC: −8.97…−8.92); exacto a 10 % solo con XML, con min/max/estimado a 18 %; `requiereConfirmacion` false solo si lo respalda el XML; `dato: "gravado"` si no hay exacto; `lecturas` = BI e IGV del destino; orden por id → regla → DG, DGNG, DNG.
- **Resultado**: `reglas/{tipos,errores}.ts` reemplazados (mismos nombres y `codigo`; tipos con nombre para cada sugerencia, sin tipos indexados por el lint); nuevos `entrada.ts` (validación estricta de filas y contexto con marcas de 010 vía API pública, normalización de documentos, avisos `XML_AJENO`/`XML_MONEDA`, `PARES_DESTINO` y `crearHallazgo` internos), `explicaciones.ts` (catálogo completo, incluido R-RED/R-NEW/R-GP para T10), `rango.ts`, `r-isc.ts`, `r-mix.ts`; `motor.ts` (validación, R-ISC/R-MIX por destino, orden) y `aplicar.ts` (mover y separar probados; ajustar, clasificar, excluir y `aplicarMasivo` escritos según el plan, sin pruebas en verde aún) mínimos. `r-isc`, `r-mix`, `rango`: 70/70 verde; `build` y `lint` OK. Paquete: 717 verde, 67 rojo, todos de T10 (R-RED/R-NEW/R-GP; `tests/casos-reales/reglas.spec.ts` y `typecheck` fallan solo porque `src/index.ts` aún no reexporta `reglas/`) más `ronda2b.adv.spec.ts` R2b-1 (superficie pública fijada en 24 nombres; ya fallaba por los 3 de `texto/` de T8 y fallará también con los de `reglas/`: el orquestador decide si se actualiza esa lista). Cobertura: `rango`, `r-isc` 100 %, `r-mix` 95/94 %, `motor` 100/92 %, `entrada` 94/90 %; `aplicar` 68 % y `explicaciones` 75 % de funciones quedan para T10. Notas: `rangoGravado` devuelve null si igvEsperado(|BI|) = |IGV| (no hay mezcla; R-MIX nunca lo llama así). El catálogo no tiene sufijo para "XML con varios destinos con BI ≠ 0" e IGV igual: ese caso queda sin sufijo (si el IGV difiere, usa el de IGV distinto); la marca de ISC con XML de ISC 0 usa "Proveedor emisor de ISC: revisar con el XML". Un XML con montos en otra moneda (o mezclados) da `XML_MONEDA`, no `ENTRADA_INVALIDA` (lo pide `motor.spec.ts`).

## T10 · Implementar R-RED, R-NEW, R-GP, motor y aplicar (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (todo), `spec.md` (CA-6 a CA-12, D-4–D-6), `packages/domain/src/reglas/*.spec.ts`, `packages/domain/tests/casos-reales/reglas.spec.ts`, `packages/domain/src/reglas/*.ts` (de T9), `packages/domain/src/texto/index.ts`.
- **Hacer**: `reglas/{r-red,r-new,r-gp,motor,aplicar,index}.ts` y reexportación en `src/index.ts`.
- **Hecho cuando**: `pnpm --filter @contapp/domain test` en verde (queda solo el `it.todo` USD de 010 y de 011); `build`, `typecheck`, `lint` OK; `pnpm cobertura:dominio` sale 0. Commit `feat(011): R-RED, R-NEW, R-GP, evaluarReglas y aplicación`.
- **Fijado por las pruebas** (plan, "Ratificación de contratos"): R-RED con precedencia `origenUsd` → XML válido (columna sin umbral, o total si `Σ = xml.total`) → umbral; diferencia con signo `total − Σ` en la explicación; `MontoFueraDeRangoError` → sin sugerencia; XML ajeno/otra moneda = sin XML + aviso; contexto estricto sin resultados parciales; R-NEW con `Map` y clave normalizada (`CONSTRUCTOR` es un documento más); R-GP solo con XML y explicación sin texto del XML; `aplicarSugerencia` con hallazgo sin sugerencia o falsificado → `EntradaReglasInvalidaError`; `aplicarMasivo` encadena por fila, `requiere_dato` si falta el dato y, si no, el `codigo` del error; resultados congelados; reemplazar los stubs `motor.ts`, `aplicar.ts` e `index.ts`.
- **Resultado**: nuevos `reglas/{r-red,r-new,r-gp}.ts`; `motor.ts` agrega R-RED, R-NEW y R-GP por fila; `reglas/index.ts` (barrel definitivo) y `src/index.ts` reexporta `reglas/`. `aplicar.ts` sin cambios (ya cumplía; ahora probado al 100 %). Pruebas agregadas (sin tocar las existentes): `reglas/{r-red-bordes,aplicar-validacion,explicaciones-t10}.spec.ts` (24). `@contapp/domain`: 807 verde + 2 `it.todo`; solo falla `ronda2b.adv.spec.ts` R2b-1 (superficie fijada en 24 nombres; no se editó). Nombres públicos nuevos (runtime) para actualizar R2b-1: `ConfirmacionInvalidaError`, `DICCIONARIO_GLOSAS_BASE`, `DiccionarioGlosas`, `EntradaReglasInvalidaError`, `ORDEN_REGLAS`, `ReglasError`, `SugerenciaObsoletaError`, `aplicarMasivo`, `aplicarSugerencia`, `evaluarReglas`, `tokensDeGlosa` (24 + 11 = 35). `typecheck`, `build`, `lint` OK; `tests-limites` 275 verde. Cobertura: todo `reglas/` y `texto/` ≥ 90 % por archivo (`r-red` 95/91/100/94, `aplicar` 100, `r-isc` 100); `pnpm cobertura:dominio` sale 1 solo por R2b-1. **Para revisión del arquitecto** (decisiones de T10 fuera del catálogo): (1) R-MIX con XML y varios destinos con BI ≠ 0: nuevo sufijo `; el XML no separa por destino: confirma el monto`, evaluado antes de comparar IGV (el IGV del XML es total, no por destino). (2) Proveedor marcado con XML de ISC 0: `Proveedor emisor de ISC: el XML indica ISC 0.00`, sin sugerencia (la entrada "marca con XML" del catálogo; "revisar con el XML" queda solo sin XML). (3) XML con montos en otra moneda o mezclados: `XML_MONEDA` (se mantiene; lo fijan `motor.spec`/`r-red.spec`, cuyos XML USD traen montos PEN por defecto). (4) R-RED con Σ fuera de NUMERIC(14,2): texto nuevo `La suma de componentes no es igual al total y excede el rango de montos: revisar`, sin sugerencia. (5) `origenUsd` descuadrado: explicación `red()` con las cifras del origen (USD), sin sugerencia; conversión fuera de rango: `redUsd` sin sugerencia. (6) TC en la explicación con tres decimales (`3.750`), relleno de ceros sobre el texto exacto de 1.00 × tc. (7) R-GP y R-NEW con `requiereConfirmacion = true` (la palabra es indicio, no prueba). (8) R-RED con XML: el grupo BI/IGV "cae en una columna" solo si exactamente una columna del grupo es ≠ 0.

## T11 · Integración (devops · haiku)
- **Contexto (leer solo esto)**: `package.json` raíz.
- **Hacer**: `pnpm build`, `typecheck`, `lint`, `test`, `cobertura:dominio`, `--filter @contapp/tests-limites test` y `git grep -nE "parseFloat|parseInt|Number\(|toNumber\(|:\s*number\b|Math\.|Date|random" -- packages/domain/src/reglas ":!*.spec.ts"`.
- **Hecho cuando**: todo sale 0 (reportar conteos) y el grep está vacío. Sin commit si no cambia archivos.
- **Resultado**: `pnpm build` 0 (7/7 tareas); `pnpm typecheck` 0 (10/10); `pnpm lint` 0 (7/7); `pnpm test` 0 (8/8 en turbo, 6 desde caché): domain 808 pasan + 2 todo (34 archivos), tests-limites 275 (11), db 410 (23), backend 500 (40), frontend 134 (17), crypto 290 + 1 omitida (16), shared 228 (5), worker 95 (7). `pnpm --filter @contapp/tests-limites test` 0: 11 archivos, 275 pruebas. `pnpm --filter @contapp/domain test` sin caché 0: 34 archivos, 808 pruebas, 2 todo. `pnpm cobertura:dominio` 0: All files 98.44 % sentencias, 97.22 % ramas, 100 % funciones, 99.06 % líneas. Los 13 archivos de `reglas/` y los 3 de `texto/` pasan el umbral de 90 % por archivo en las cuatro métricas (mínimos: `entrada.ts` ramas 91.48, `motor.ts` ramas 92.59, `r-red.ts` líneas 93.54, `diccionario.ts` líneas 97.22). `texto/normalizar.ts` 100/100/100/100: el reporte `text` no lo lista por estar completo; confirmado en `packages/domain/coverage/coverage-summary.json`. Grep de `reglas/` (13 archivos sin spec): vacío (exit 1); control positivo sobre `tests/limites/dominio-reglas.spec.ts` sí coincide. `ci:db`: no pedido en T11 (no aplica: 011 sin BD). Sin cambios de código ni migraciones.

## T12a · Ronda 1a: lista mínima (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (Criterios, Decisiones, "Ataques obligatorios"), `plan.md` (Contratos). **Caja negra**: no leer `packages/domain/src/{reglas,texto}/*.ts` que no sean pruebas.
- **Hacer**: hasta **8** pruebas (un `it.each` cuenta como una) en `packages/domain/src/reglas/ronda1a.adv.spec.ts`, solo contra `@contapp/domain` público, sobre la lista obligatoria de la spec y el catálogo de dinero/reglas de 04 §2.3.
- **Defensas**: solo adversario · opus (si la ejecuta otro rol, parar y avisar); solo crear ese archivo; no modificar producción, configuración ni otras pruebas; no corregir. Cada prueba exige un comportamiento escrito en un CA o una D (citarlo en un comentario); si exige cambiar la spec, marcarla `decide usuario`. Deterministas (semilla fija, sin reloj). Verificar que el valor esperado sale de la spec antes de reportar. Al llegar al presupuesto, parar.
- **Hecho cuando**: pruebas commiteadas; cada fallo anotado en "Hallazgos adversariales abiertos" de `ESTADO.md` (releer antes; archivo:línea + una línea + severidad) y en "Resultado" de esta tarea. Commit `test(011): ronda adversarial 1a`.
- **Resultado**: `reglas/ronda1a.adv.spec.ts`, 8 pruebas (41 casos con los `it.each`), todas en verde; sin hallazgos. Cubre: rango de R-MIX con IGV a ±0.01–0.06 del 18 %/10 % contra un oráculo de centavos (min/max/estimado exactos, ±0.01 fuera rechazado, total conservado; PEN/USD, NC, BI hasta 5·10¹¹; 1000 corridas, semilla fija) · rango vacío (BI 0 con IGV ±, IGV > BI, IGV > 18 %, en los tres destinos) · fila con todos los tributos y tres destinos (R-ISC DG + R-MIX DGNG + R-RED, encadenadas en ambos órdenes, R-RED antes o después, R-ISC repetida obsoleta) · `origenUsd` con TC 3.759 (coincide, columna/total ±0.01, +1.00) · XML ajeno por RUC, tipo de doc, serie, número y tipo de comprobante · XML que no suma (toda sugerencia R-RED deja la fila cuadrada) · R-NEW con espacios/minúsculas, otro tipo, ceros extra y orden por unidades de código · R-GP con NFD, ancho completo, ñ, NBSP, plurales, falsos prefijos y glosas de 1 MB.

## T12b · Ronda 1b: escenarios nuevos (adversario · opus) ∥ T12a
- **Contexto (leer solo esto)**: igual que T12a + `plan.md` (Decisiones, Riesgos); después (caja blanca) `packages/domain/src/{reglas,texto}/*.ts`.
- **Hacer**: hasta **7** pruebas en `packages/domain/src/reglas/ronda1b.adv.spec.ts` y `packages/domain/src/texto/ronda1b.adv.spec.ts`, **distintas** de T12a: bordes de la vecindad acotada del rango, reglas cruzadas y obsolescencia parcial, masivo con la misma fila repetida, `lecturas` manipuladas o hallazgos falsificados pasados a `aplicarSugerencia`, XML con identidad parecida (ceros a la izquierda, minúsculas), explicaciones con texto del proveedor, Unicode y homoglifos en glosas, riesgos del plan. Mismas defensas que T12a.
- **Hecho cuando**: igual que T12a. Commit `test(011): ronda adversarial 1b`.
- **Resultado**: `reglas/ronda1b.adv.spec.ts` (6 pruebas) y `texto/ronda1b.adv.spec.ts` (1 `it.each`): 20 casos, 6 verdes y 14 rojos; 6 hallazgos (por orden del orquestador se anotan solo aquí, no en `ESTADO.md`):
  - **[011/R1b-1] alta** · `packages/domain/src/reglas/r-isc.ts:54` · R-ISC con XML calcula `xml.isc − isc` pero sus `lecturas` omiten `isc`: si `isc` cambia (el contador lo corrige o R-RED con XML lo ajusta), la sugerencia sigue vigente y duplica el ISC; ambas son `requiereConfirmacion = false`, así que `aplicarMasivo` [R-RED, R-ISC] deja biDg 0 e isc 1540 con un XML de gravado 770 e ISC 770 (CA-9). Pruebas R1b-1, R1b-2. Toca el plan ("R-ISC: BI e IGV del destino"): el arquitecto ratifica agregar `isc` cuando la sugerencia sale del XML (no rompe las dos R-ISC seguidas: con XML solo hay un destino con sugerencia).
  - **[011/R1b-2] media** · `packages/domain/src/reglas/aplicar.ts:88` · `mover` falsificado con forma válida se aplica: destino `igvDg`/`noGravado` en vez de `isc`, monto parcial que no es la BI leída, `destino` del hallazgo distinto del origen (Ratificación, Aplicar: falsificado → `EntradaReglasInvalidaError`). Prueba R1b-3.
  - **[011/R1b-3] media** · `packages/domain/src/reglas/aplicar.ts:140` · `lecturas: {}` desactiva la obsolescencia: R-ISC y R-MIX se aplican sobre otra BI (1000.00, 500.00). Falta exigir las columnas que la regla lee. Prueba R1b-4.
  - **[011/R1b-4] media-alta** · `packages/domain/src/reglas/aplicar.ts:97-102` · R-MIX con `exacto` inventado (1.00) se aplica sin confirmación (y `dato: null` lo deja pasar en masivo) y un `min` ensanchado a 0.01 habilita confirmar 1.00: el rango y el exacto no se contrastan con `rangoGravado` de las lecturas (CA-2, D-3). Prueba R1b-5.
  - **[011/R1b-5] baja · decide usuario** · `packages/domain/src/reglas/entrada.ts:205` · XML con serie en minúsculas (`f001`) lanza `EntradaReglasInvalidaError` y aborta todo el lote (otras filas pierden sus hallazgos), en vez de ignorarse con `XML_AJENO` o normalizarse (spec, Alcance: "se ignora y se informa"; el plan la declara inválida). Ceros a la izquierda y RUC con espacios: OK. Prueba R1b-6.
  - **[011/R1b-6] media · decide usuario** · `packages/domain/src/texto/diccionario.ts:37` (y `normalizar.ts:9`) · un punto pegado convierte el token en "abreviatura": `ZAPATILLAS.`, `PERFUMES.` (plural al final de una oración) y `ZAPAT.DEP.` (abreviaturas sin espacio) no disparan R-GP (D-5: plural simple y abreviaturas; el plan, al pie de la letra, no los cubre). Ancho completo, İ turca, negrita matemática y 500 000 marcas combinantes: OK. Prueba R1b-7.
  - Sin hallazgo: explicaciones (solo catálogo y palabra del diccionario, nunca texto del XML); vecindad del rango (el estimado siempre es miembro y el ancho ≤ 10 céntimos < 12 pasos).

## T13 · Corregir ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de 011 en `ESTADO.md`, `packages/domain/src/{reglas,texto}/ronda1*.adv.spec.ts`, los archivos de producción que citan.
- **Hacer**: corregir hasta que las pruebas adversariales pasen sin editarlas. Lo marcado `decide usuario` no se corrige: se informa al orquestador con opciones.
- **Hecho cuando**: `pnpm --filter @contapp/domain test` y `cobertura:dominio` en verde; cada hallazgo `corregido (<commit>)` en `ESTADO.md`. Commit `fix(011): hallazgos de la ronda adversarial 1`.
- **Resultado**: las 6 + 1 pruebas de `ronda1b.adv.spec.ts` (reglas y texto) y las de `ronda1a` en verde sin editarlas. Hallazgos (anotados aquí, como en T12b):
  - [011/R1b-1] · corregido (ff94d08): con el ISC del XML las lecturas de R-ISC incluyen `isc` y las BI de los otros destinos; `aplicarMasivo` [R-RED, R-ISC, R-ISC] aplica solo R-RED.
  - [011/R1b-2] · corregido (ff94d08): `mover` solo desde la BI del destino del hallazgo a `isc`; sin XML monto = toda la BI con IGV 0 y confirmación; con XML monto ≠ 0, del signo de la BI, ≤ |BI|, otras BI en 0 y sin confirmación.
  - [011/R1b-3] · corregido (ff94d08): faltan lecturas que la regla lee (R-ISC/R-MIX: BI e IGV del destino; R-RED: todas y total) → `SugerenciaObsoletaError`.
  - [011/R1b-4] · corregido (ff94d08): `min`/`max`/`estimado` de R-MIX = `rangoGravado` a 18 % de las lecturas; `exacto` solo con `dato` null y sin confirmación, dentro del rango a 18 % o a 10 %; `exacto` null exige `dato: "gravado"`.
  - [011/R1b-5] · corregido (ff94d08), decisión del usuario: serie `^[0-9A-Za-z]{1,4}$` comparada en mayúsculas; serie del XML fuera de gramática → `XML_AJENO` sin abortar el lote.
  - [011/R1b-6] · corregido (ff94d08), decisión del usuario: un punto seguido de letra cierra el token (`zapat.dep.` → `zapat.`, `dep.`; `1.50` se conserva) y un token con punto final coincide también como palabra completa o plural (`zapatillas.`). Sin contradicción con las pruebas de T3 (`texto/*.spec.ts` sin cambios).
  - Pruebas propias: `reglas/correcciones-t13.spec.ts` (28) y `texto/correcciones-t13.spec.ts`. Prueba propia cambiada: `aplicar-validacion.spec.ts` "separar con gravado igual a toda la BI" usaba un `max` falsificado (21.48); ahora espera `EntradaReglasInvalidaError` (la rama `resto = 0` de `separar` era inalcanzable y se quitó). Para T14a: ninguna adversarial contradice las decisiones.
  - Contrato cambiado (lecturas de R-ISC, validación de aplicar, serie, texto): anotado en `plan.md` como "Cambios de T13", pendiente de ratificación del arquitecto en T17.
  - Checks: `pnpm --filter @contapp/domain test` 39 archivos, 904 + 2 todo; `cobertura:dominio` 0 (All files 98.45/97.41/100/99.13; `aplicar.ts` 99.49/99.45/100/100, `entrada.ts` ramas 91.75); `tests-limites` 275; `typecheck` 10/10, `lint` 7/7, `build` 7/7; grep de `reglas/` vacío.

## T14a · Ronda 2a: regresión (adversario · opus)
- **Contexto (leer solo esto)**: igual que T12b + diff de T13 (`git show <commit>`).
- **Hacer**: hasta **8** pruebas en `packages/domain/src/reglas/ronda2a.adv.spec.ts`: variantes de cada hallazgo corregido. Mismas defensas que T12a. Si no hay fallos nuevos, se reporta y se termina la ronda.
- **Hecho cuando**: igual que T12a. Commit `test(011): ronda adversarial 2a`.

## T14b · Ronda 2b: escenarios nuevos contra las correcciones (adversario · opus) ∥ T14a
- **Contexto (leer solo esto)**: igual que T14a.
- **Hacer**: hasta **7** pruebas en `packages/domain/src/reglas/ronda2b.adv.spec.ts` contra lo que T13 introdujo. Mismas defensas.
- **Hecho cuando**: igual que T12a. Commit `test(011): ronda adversarial 2b`.
- **Resultado**: `reglas/ronda2b.adv.spec.ts`, 7 pruebas (16 casos), 4 verdes y 12 rojos; 5 hallazgos (anotados solo aquí, como en T12b):
  - **[011/R2b-1] media** · `packages/domain/src/reglas/r-mix.ts:47` · R-MIX usa el exacto del XML solo con "único destino con BI ≠ 0" (lee las otras BI), pero sus lecturas son solo BI e IGV del destino: si después aparece otra BI (p. ej. biDgng 100.00) la reevaluación da `exacto: null`, pero la sugerencia vieja se aplica, y en masivo sin confirmación (`dato` null) (CA-9; mismo patrón que R1b-1, corregido solo en R-ISC). Requiere ratificación del arquitecto (lecturas de R-MIX con exacto). Pruebas R2b-1 (2).
  - **[011/R2b-2] baja** · `packages/domain/src/reglas/entrada.ts:185` (`textoId`, antes del `SERIE` de la línea 212) · una serie del XML de más de 64 caracteres aborta el lote con `EntradaReglasInvalidaError` en vez de dar `XML_AJENO` (Cambios de T13, Serie; decisión del usuario sobre R1b-6). "F0011" y "F 01": OK. Prueba R2b-2.
  - **[011/R2b-3] baja · decide usuario** · `packages/domain/src/reglas/entrada.ts:209-211` y `:195` · número (9 dígitos significativos, "F001-123"), tipo ("1") o RUC ("20.100.000.001") del XML fuera de gramática abortan todo el lote; CA-11 dice "otro RUC, serie o número se ignora" y la decisión del usuario solo cubrió la serie. Prueba R2b-3.
  - **[011/R2b-4] baja** · `packages/domain/src/texto/diccionario.ts:46-53` · puntos suspensivos no se tratan como separador: "ZAPATILLAS...", "PERFUMES…" (U+2026 → "...") y "ZAPAT... DEP" no disparan R-GP (`coincide` quita un solo punto). Decisión del usuario sobre R1b-7: un punto al final de una palabra completa separa y las abreviaturas con punto valen. "ZAPATILLAS." sigue en verde. Prueba R2b-4.
  - **[011/R2b-5] baja** · `packages/domain/src/texto/normalizar.ts:37` · el punto solo separa si le sigue una letra: "ZAPATILLAS.38" y "PERFUME.100ML" (punto al final de una palabra completa seguido de un dígito) no disparan R-GP. Para conservar "1.50" basta exigir un dígito antes del punto. Prueba R2b-5.
  - Sin hallazgo: la validación de T13 no rechaza lo que produce `evaluarReglas` en notas de crédito (R-MIX exacto −8.94 y R-ISC con ISC del XML −70.00 en masivo); serie del XML "F0011"/"F 01" → `XML_AJENO` sin abortar. Prueba R2b-6.

## T15 · Corregir ronda 2 (backend · opus)
- **Contexto (leer solo esto)**: igual que T13 con `ronda2*.adv.spec.ts`.
- **Hacer**: igual que T13. Si no hubo fallos, se marca hecha sin commit.
- **Hecho cuando**: igual que T13. Commit `fix(011): hallazgos de la ronda adversarial 2`.

## T16 · Verificación (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (Criterios, Decisiones), `plan.md` (Contratos), hallazgos de 011 en `ESTADO.md`.
- **Hacer**: evidencia por CA con comando y resultado: CA-1 a CA-12 (nombre de la prueba por CA en `pnpm --filter @contapp/domain test`); CA-13 (`pnpm cobertura:dominio` con `json-summary`, mínimo por archivo y métrica de `reglas/` y `texto/`; `tests/limites/dominio-reglas.spec.ts`; grep de T11 vacío); casos reales; `*.adv.spec.ts` verdes; caso USD `it.todo`; ninguna migración ni archivo de `packages/db`/`apps/*` en `git diff main --stat`. Si la cobertura no llega, subtareas; no bajar el umbral.
- **Hecho cuando**: cada CA con evidencia en "Resultado" de esta tarea. Commit `docs(011): verificación de CA con evidencia`.

## T17 · Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, "Resultado" de T16, `packages/domain/src/reglas/{rango,r-mix,r-red,aplicar}.ts`, bloque "Dinero" de `eslint.config.mjs`.
- **Hacer**: contrastar cada CA y D-1–D-7 con su evidencia y el DoD A (04 §5); escribir en `spec.md` "Límites conocidos" (USD diferido, falsos positivos de R-GP, re-evaluación tras aplicar a cargo de 014) y la lista de lo que 014/016 deben respetar.
- **Hecho cuando**: veredicto "aprobada" o lista de faltantes con tarea asignada. Commit `docs(011): revisión final` si cambia `spec.md`.

## T18 · Cierre (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/ESTADO.md`, este archivo, veredicto de T17.
- **Hacer**: marcar `[x]` tareas y casillas CA de `spec.md` (el caso USD queda sin marcar, diferido); ESTADO 011 → `hecha`, "Tarea actual" → `—`; hallazgos en su estado final; nota en "Notas para specs futuras": [014] re-evaluar la fila tras aplicar una sugerencia y persistir `lecturas`. Releer ESTADO antes de editar.
- **Hecho cuando**: `git status` limpio salvo `docs/explorador/`, `.codex/`, `AGENTS.md`; `git log --oneline` muestra los commits de 011. Commit `chore(011): cierra spec 011`.
