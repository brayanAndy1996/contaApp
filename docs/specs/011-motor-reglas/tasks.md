# Tareas 011 · Motor de reglas

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la indicada (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: andamiaje → pruebas (rojo) → implementación (verde, cobertura por archivo desde el diseño) → integración → adversario (máx. 2 rondas, cada una en dos piezas) → verificación → revisión final → cierre. La rama `spec/011-motor-reglas` ya existe (desde `main`) y los docs aprobados están commiteados. CA = `spec.md`; contratos y decisiones = `plan.md`. **011 se implementa primero (011 → 008 → 006) y no toca la BD**: ninguna tarea crea migraciones ni usa `withTenant`; las pruebas corren sin PostgreSQL.

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Andamiaje: cobertura de `reglas/` y `texto/` | devops | haiku | — | — | — | [ ] |
| T2 | Pruebas del lint de dinero en `reglas/` (rojo) | tester | sonnet | — ∥ T1 | ✓ | — | [ ] |
| T3 | Pruebas de `texto/` (rojo) | tester | sonnet | — ∥ T2 | ✓ | — | [ ] |
| T4 | Pruebas de R-ISC, R-MIX, rango y precedencia (rojo) | tester | sonnet | — ∥ T3 | ✓ | — | [ ] |
| T5 | Pruebas de R-RED, R-NEW, R-GP, motor y aplicar (rojo) | tester | sonnet | — ∥ T4 | ✓ | — | [ ] |
| T6 | Casos reales de reglas (rojo) | tester | sonnet | — ∥ T5 | ✓ | — | [ ] |
| T7 | Lint de dinero en `reglas/` | devops | sonnet | T2 ∥ T8 | ✓ | — | [ ] |
| T8 | Implementar `texto/` | backend | sonnet | T1, T3 | ✓ | — | [ ] |
| T9 | Implementar tipos, entrada, rango, R-ISC y R-MIX | backend | opus | T1, T4 ∥ T8 | ✓ | — | [ ] |
| T10 | Implementar R-RED, R-NEW, R-GP, motor y aplicar | backend | opus | T5, T6, T8, T9 | ✓ | — | [ ] |
| T11 | Integración: checks completos | devops | haiku | T7, T10 | — | — | [ ] |
| T12a | Ronda 1a: lista mínima de la spec (caja negra) | adversario | opus | T11 | — | ✓ | [ ] |
| T12b | Ronda 1b: escenarios nuevos (caja blanca) | adversario | opus | T11 ∥ T12a | — | ✓ | [ ] |
| T13 | Corregir hallazgos de la ronda 1 | backend | opus | T12a, T12b | — | — | [ ] |
| T14a | Ronda 2a: regresión de correcciones | adversario | opus | T13 | — | ✓ | [ ] |
| T14b | Ronda 2b: escenarios nuevos contra las correcciones | adversario | opus | T13 ∥ T14a | — | ✓ | [ ] |
| T15 | Corregir hallazgos de la ronda 2 | backend | opus | T14a, T14b | — | — | [ ] |
| T16 | Verificar CA-1 a CA-13 y cobertura con evidencia | tester | sonnet | T15 | — | — | [ ] |
| T17 | Revisión final contra la spec | arquitecto | opus | T16 | — | — | [ ] |
| T18 | Cierre: ESTADO, tasks y commit | devops | haiku | T17 | — | — | [ ] |

Escalamientos: —

Decisiones del usuario: 2026-10-27, "Apruebo las specs 006, 008 y 011 con todo lo recomendado por el arquitecto en cada P. Continúa con plan y tareas." (P-1–P-3 → D-5–D-7 de la spec).

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

## T2 · Pruebas del lint en reglas/, rojo (tester · sonnet) ∥ T1
- **Contexto (leer solo esto)**: `docs/specs/011-motor-reglas/spec.md` (CA-13), `plan.md` (Decisiones: Lint y cobertura), `tests/limites/dominio.spec.ts` (patrón `lintText`, primeras 60 líneas).
- **Hacer**: `tests/limites/dominio-reglas.spec.ts`: con `filePath` `packages/domain/src/reglas/__prueba__.ts` fallan `let x: number`, `parseFloat("1")`, `Number("1")`, `Math.round(1)`, `+s`, `d.toNumber()`, `import Decimal from "decimal.js"`; el mismo código en `…/reglas/__prueba__.spec.ts` pasa; en `packages/domain/src/texto/__prueba__.ts` `let i: number = 0` pasa, pero `import "node:fs"` y `fetch("x")` fallan (lint de IO de 010).
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` falla solo en los casos de `reglas/` que cubrirá T7; los demás archivos siguen verdes. Commit `test(011): lint contra number en reglas (rojo)`.

## T3 · Pruebas de texto/, rojo (tester · sonnet) ∥ T2
- **Contexto (leer solo esto)**: `spec.md` (CA-12, D-5), `plan.md` (Contratos: `texto/`; Decisiones: R-GP).
- **Hacer**: `packages/domain/src/texto/{normalizar,diccionario}.spec.ts` contra `../index`: tildes y mayúsculas ("ZAPATILLAS", "Zapatíllas"), plural `s`/`es`, abreviatura "zapat." (prefijo, ≥ 4 letras, solo con punto), "zapata de concreto" y "zap." no coinciden, separadores (`|`, saltos de línea, tabulaciones, NBSP), cadena vacía, `DiccionarioGlosas.desde` rechaza palabras vacías, con espacios o < 3 letras, orden determinista de `buscar`, `DICCIONARIO_GLOSAS_BASE` congelado, glosa de 1 MB en < 1 s.
- **Hecho cuando**: `pnpm --filter @contapp/domain test` falla solo por falta de implementación. Commit `test(011): normalización de glosas y diccionario (rojo)`.

## T4 · Pruebas de R-ISC, R-MIX, rango y precedencia, rojo (tester · sonnet) ∥ T3
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-5, CA-10, D-1–D-3, D-7), `plan.md` (Contratos: `reglas/`; Decisiones: Evaluación por destino, R-ISC, Rango de R-MIX), `packages/domain/tests/ayudas/comprobante.ts`.
- **Hacer**: `packages/domain/tests/ayudas/filas.ts` (constructores de `FilaEvaluable`, `ResumenXml` y contexto vacío) y `packages/domain/src/reglas/{r-isc,r-mix,rango}.spec.ts` vía `evaluarReglas`/`aplicarSugerencia` públicos: R-ISC sin y con XML, XML sin ISC, proveedor marcado con IGV ≠ 0 (sin y con XML), varios destinos; R-MIX con explicación exacta, rango, estimado acotado, `exacto` con XML a 18 % y a 10 %, XML con IGV distinto, rango vacío (BI 0 con IGV, IGV > 18 % de la BI, signos distintos); CA-4 como propiedad con oráculo de centavos enteros (semilla fija, 1000 corridas, notas de crédito incluidas); CA-5 completo; CA-10 en USD y negativos.
- **Hecho cuando**: igual que T3. Commit `test(011): R-ISC, R-MIX y rango del gravado (rojo)`.

## T5 · Pruebas de R-RED, R-NEW, R-GP, motor y aplicar, rojo (tester · sonnet) ∥ T4
- **Contexto (leer solo esto)**: `spec.md` (CA-6 a CA-9, CA-11, CA-12, D-4–D-6), `plan.md` (Contratos; Decisiones: R-RED, R-NEW, R-GP, XML ajeno, Obsolescencia, Entrada estricta), `packages/domain/tests/ayudas/filas.ts` (de T4; si aún no existe, crearlo con la misma forma y coordinar en el commit).
- **Hacer**: `packages/domain/src/reglas/{r-red,r-new,r-gp,motor,aplicar}.spec.ts`: R-RED con diferencia dentro y fuera del umbral, con XML que señala una columna, con `origenUsd` (valores sintéticos: PEN que no coincide con `convertirAPen`), origen descuadrado, montos al borde del rango; R-NEW con documento con espacios/minúsculas, otro tipo, conocido; R-GP con y sin XML; CA-8 (sin mutación, determinismo, permutación); CA-11 (`XML_AJENO`, `XML_MONEDA`); entrada inválida (ids repetidos, objeto falso en `montos`, claves extra, `__proto__` en el contexto); CA-9 (conservación del total salvo R-RED, `SugerenciaObsoletaError`, dos R-ISC seguidas en la misma fila, masivo con rechazos `requiere_dato` y encadenado por fila, confirmación fuera de rango).
- **Hecho cuando**: igual que T3. Commit `test(011): R-RED, R-NEW, R-GP, motor y aplicación (rojo)`.

## T6 · Casos reales de reglas, rojo (tester · sonnet) ∥ T5
- **Contexto (leer solo esto)**: `spec.md` (CA-1, CA-2, CA-3, CA-6, CA-12, Casos reales), `docs/01-definiciones-base.md` (puntos 9, 10, 11 y 15 de la lista que empieza en "Reglas de negocio nuevas"), `docs/02-requerimientos.md` (HU-23 y HU-24, solo esas).
- **Hacer**: `packages/domain/tests/casos-reales/reglas.spec.ts`: San Juan 770 (sin y con XML, explicación textual, aplicar); mixta 21.48/1.61 sin XML (rango 8.92–8.97, estimado 8.94, explicación "1.61 no es 18 % ni 10 % de 21.48", aplicar con 8.97 → 8.97 + 12.51) y con XML (exacta 8.97/12.51); zapatilla ("ZAPATILLAS URBANAS T-42", "zapat. dep."; "zapata de concreto" no); `it.todo("redondeo USD: caso real diferido, sin cifras")`. No inventar cifras. Boleta 291 no va aquí (013).
- **Hecho cuando**: igual que T3. Commit `test(011): casos reales de reglas (rojo)`.

## T7 · Lint de dinero en reglas/ (devops · sonnet) ∥ T8
- **Contexto (leer solo esto)**: `plan.md` (Decisiones: Lint y cobertura), `eslint.config.mjs` (bloque "Dinero (spec 010, CA-1)"), `tests/limites/dominio-reglas.spec.ts`.
- **Hacer**: agregar `packages/domain/src/reglas/**` a `files` de ese bloque; mensajes que digan "spec 010/011". No tocar otros bloques.
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` en verde (todos los archivos); `pnpm lint` en verde. Commit `feat(011): lint contra number en reglas`.

## T8 · Implementar texto/ (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: `texto/`; Decisiones: R-GP), `packages/domain/src/texto/*.spec.ts`.
- **Hacer**: `texto/{normalizar,diccionario,index}.ts` y reexportación en `src/index.ts`. Algoritmo lineal, sin regex con retroceso, sin IO, sin importar `dinero/`.
- **Hecho cuando**: pruebas de `src/texto/` en verde; `build`, `typecheck`, `lint` del paquete OK; cada archivo de `texto/` ≥ 90 % en `pnpm cobertura:dominio`. Commit `feat(011): normalización de glosas y diccionario`.

## T9 · Implementar tipos, entrada, rango, R-ISC y R-MIX (backend · opus) ∥ T8
- **Contexto (leer solo esto)**: `plan.md` (todo), `spec.md` (CA-1 a CA-5, CA-10, D-1–D-3, D-7), `packages/domain/src/reglas/{r-isc,r-mix,rango}.spec.ts`, `packages/domain/src/dinero/index.ts`, `packages/domain/src/comprobante/index.ts`.
- **Hacer**: `reglas/{tipos,errores,entrada,explicaciones,rango,r-isc,r-mix}.ts` y un `motor.ts`/`aplicar.ts` mínimos que hagan pasar esas pruebas (T10 los completa). Solo API pública de 010.
- **Hecho cuando**: pruebas de `r-isc`, `r-mix` y `rango` en verde; `build`, `typecheck`, `lint` OK. Commit `feat(011): R-ISC, R-MIX y rango del gravado`.

## T10 · Implementar R-RED, R-NEW, R-GP, motor y aplicar (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (todo), `spec.md` (CA-6 a CA-12, D-4–D-6), `packages/domain/src/reglas/*.spec.ts`, `packages/domain/tests/casos-reales/reglas.spec.ts`, `packages/domain/src/reglas/*.ts` (de T9), `packages/domain/src/texto/index.ts`.
- **Hacer**: `reglas/{r-red,r-new,r-gp,motor,aplicar,index}.ts` y reexportación en `src/index.ts`.
- **Hecho cuando**: `pnpm --filter @contapp/domain test` en verde (queda solo el `it.todo` USD de 010 y de 011); `build`, `typecheck`, `lint` OK; `pnpm cobertura:dominio` sale 0. Commit `feat(011): R-RED, R-NEW, R-GP, evaluarReglas y aplicación`.

## T11 · Integración (devops · haiku)
- **Contexto (leer solo esto)**: `package.json` raíz.
- **Hacer**: `pnpm build`, `typecheck`, `lint`, `test`, `cobertura:dominio`, `--filter @contapp/tests-limites test` y `git grep -nE "parseFloat|parseInt|Number\(|toNumber\(|:\s*number\b|Math\.|Date|random" -- packages/domain/src/reglas ":!*.spec.ts"`.
- **Hecho cuando**: todo sale 0 (reportar conteos) y el grep está vacío. Sin commit si no cambia archivos.

## T12a · Ronda 1a: lista mínima (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (Criterios, Decisiones, "Ataques obligatorios"), `plan.md` (Contratos). **Caja negra**: no leer `packages/domain/src/{reglas,texto}/*.ts` que no sean pruebas.
- **Hacer**: hasta **8** pruebas (un `it.each` cuenta como una) en `packages/domain/src/reglas/ronda1a.adv.spec.ts`, solo contra `@contapp/domain` público, sobre la lista obligatoria de la spec y el catálogo de dinero/reglas de 04 §2.3.
- **Defensas**: solo adversario · opus (si la ejecuta otro rol, parar y avisar); solo crear ese archivo; no modificar producción, configuración ni otras pruebas; no corregir. Cada prueba exige un comportamiento escrito en un CA o una D (citarlo en un comentario); si exige cambiar la spec, marcarla `decide usuario`. Deterministas (semilla fija, sin reloj). Verificar que el valor esperado sale de la spec antes de reportar. Al llegar al presupuesto, parar.
- **Hecho cuando**: pruebas commiteadas; cada fallo anotado en "Hallazgos adversariales abiertos" de `ESTADO.md` (releer antes; archivo:línea + una línea + severidad) y en "Resultado" de esta tarea. Commit `test(011): ronda adversarial 1a`.

## T12b · Ronda 1b: escenarios nuevos (adversario · opus) ∥ T12a
- **Contexto (leer solo esto)**: igual que T12a + `plan.md` (Decisiones, Riesgos); después (caja blanca) `packages/domain/src/{reglas,texto}/*.ts`.
- **Hacer**: hasta **7** pruebas en `packages/domain/src/reglas/ronda1b.adv.spec.ts` y `packages/domain/src/texto/ronda1b.adv.spec.ts`, **distintas** de T12a: bordes de la vecindad acotada del rango, reglas cruzadas y obsolescencia parcial, masivo con la misma fila repetida, `lecturas` manipuladas o hallazgos falsificados pasados a `aplicarSugerencia`, XML con identidad parecida (ceros a la izquierda, minúsculas), explicaciones con texto del proveedor, Unicode y homoglifos en glosas, riesgos del plan. Mismas defensas que T12a.
- **Hecho cuando**: igual que T12a. Commit `test(011): ronda adversarial 1b`.

## T13 · Corregir ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de 011 en `ESTADO.md`, `packages/domain/src/{reglas,texto}/ronda1*.adv.spec.ts`, los archivos de producción que citan.
- **Hacer**: corregir hasta que las pruebas adversariales pasen sin editarlas. Lo marcado `decide usuario` no se corrige: se informa al orquestador con opciones.
- **Hecho cuando**: `pnpm --filter @contapp/domain test` y `cobertura:dominio` en verde; cada hallazgo `corregido (<commit>)` en `ESTADO.md`. Commit `fix(011): hallazgos de la ronda adversarial 1`.

## T14a · Ronda 2a: regresión (adversario · opus)
- **Contexto (leer solo esto)**: igual que T12b + diff de T13 (`git show <commit>`).
- **Hacer**: hasta **8** pruebas en `packages/domain/src/reglas/ronda2a.adv.spec.ts`: variantes de cada hallazgo corregido. Mismas defensas que T12a. Si no hay fallos nuevos, se reporta y se termina la ronda.
- **Hecho cuando**: igual que T12a. Commit `test(011): ronda adversarial 2a`.

## T14b · Ronda 2b: escenarios nuevos contra las correcciones (adversario · opus) ∥ T14a
- **Contexto (leer solo esto)**: igual que T14a.
- **Hacer**: hasta **7** pruebas en `packages/domain/src/reglas/ronda2b.adv.spec.ts` contra lo que T13 introdujo. Mismas defensas.
- **Hecho cuando**: igual que T12a. Commit `test(011): ronda adversarial 2b`.

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
