# Tareas 010 · Dominio de dinero

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la indicada (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: rama y andamiaje → cobertura y CI desde el diseño → pruebas (rojo) → implementación (verde) → integración → adversario (máx. 2 rondas, cada una en dos piezas) → verificación → revisión final → cierre. CA = `spec.md`; contratos y decisiones = `plan.md`. **010 se implementa entera antes que 004** en el árbol compartido (plan, Decisiones).

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Rama `spec/010-dominio-dinero` y commit de los docs | devops | haiku | — | — | — | [x] |
| T2 | Andamiaje de `packages/domain` | devops | haiku | T1 | — | — | [ ] |
| T3 | Cobertura por archivo (90 %), script raíz y CI | devops | sonnet | T2 | — | — | [ ] |
| T4 | Pruebas de lint de dinero e IO (rojo) | tester | sonnet | T1 ∥ T3 | ✓ | — | [ ] |
| T5 | Pruebas de `dinero/` (rojo) | tester | sonnet | T2 ∥ T3, T4 | ✓ | — | [ ] |
| T6 | Pruebas de `comprobante/` y casos reales (rojo) | tester | sonnet | T2 ∥ T5 | ✓ | — | [ ] |
| T7 | Reglas de lint de dinero e IO | devops | sonnet | T4 ∥ T8 | ✓ | — | [ ] |
| T8 | Implementar `dinero/` | backend | opus | T3, T5 | ✓ | — | [ ] |
| T9 | Implementar `comprobante/` | backend | opus | T6, T8 | ✓ | — | [ ] |
| T10 | Integración: checks completos | devops | haiku | T7, T9 | — | — | [ ] |
| T11a | Ronda 1a: lista mínima de la spec (caja negra) | adversario | opus | T10 | — | ✓ | [ ] |
| T11b | Ronda 1b: escenarios nuevos (caja blanca) | adversario | opus | T10 ∥ T11a | — | ✓ | [ ] |
| T12 | Corregir hallazgos de la ronda 1 | backend | opus | T11a, T11b | — | — | [ ] |
| T13a | Ronda 2a: regresión de correcciones | adversario | opus | T12 | — | ✓ | [ ] |
| T13b | Ronda 2b: escenarios nuevos contra las correcciones | adversario | opus | T12 ∥ T13a | — | ✓ | [ ] |
| T14 | Corregir hallazgos de la ronda 2 | backend | opus | T13a, T13b | — | — | [ ] |
| T15 | Verificar CA-1 a CA-13 y cobertura con evidencia | tester | sonnet | T14 | — | — | [ ] |
| T16 | Revisión final contra la spec | arquitecto | opus | T15 | — | — | [ ] |
| T17 | Cierre: ESTADO, tasks y commit | devops | haiku | T16 | — | — | [ ] |

Escalamientos: (ninguno aún)

Reglas comunes:
- Un commit por tarea (Conventional Commits `feat(010): …`, `test(010): …`), con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin remoto.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/`, `AGENTS.md` ni `docs/specs/004-auth/` (cambios ajenos): `git add <rutas>` explícitas, nunca `git add -A`/`.`. No cambiar de rama durante 010.
- `docs/specs/ESTADO.md` lo edita otro agente en paralelo (fila 004): releerlo justo antes de cada edición y tocar solo filas de 010.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o "OK" + conteo. Correr solo las pruebas de `@contapp/domain` y `@contapp/tests-limites`.
- El tester no toca código de producción; backend no edita `*.spec.ts` ni `*.adv.spec.ts`; adversario solo escribe `*.adv.spec.ts`.
- Ningún `number` para montos fuera de pruebas. En pruebas, usar `x as unknown as string` (no `as any`: lo prohíbe el lint).
- Nunca bajar el umbral de cobertura ni excluir archivos para llegar a él: escalar al arquitecto.
- Escalar según 04 §3.3 y anotar aquí.

## T1 · Rama y commit de la spec (devops · haiku)
- **Contexto (leer solo esto)**: esta sección; `git status`.
- **Hacer**: (1) `git checkout -b spec/010-dominio-dinero spec/003-cifrado` (003 aún no está en `main`); los cambios sin commitear de `docs/explorador/`, `.codex/`, `AGENTS.md` y `docs/specs/004-auth/` viajan en el árbol y **no se tocan ni se agregan**. (2) Releer `docs/specs/ESTADO.md` y agregarlo **completo** (incluye los cambios de la fila 004, es lo esperado): `git add docs/specs/010-dominio-dinero/ docs/specs/ESTADO.md`.
- **Hecho cuando**: `git branch --show-current` = `spec/010-dominio-dinero`; `git show --stat HEAD` lista solo `docs/specs/010-dominio-dinero/{spec,plan,tasks}.md` y `docs/specs/ESTADO.md`; `git status` sigue mostrando sin commitear `docs/explorador/`, `.codex/`, `AGENTS.md`, `docs/specs/004-auth/`. Commit `docs(010): spec aprobada, plan y tareas de dominio de dinero`.

## T2 · Andamiaje (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/plan.md` (Archivos; Decisiones: Estructura, decimal.js aislado, Versiones), `packages/crypto/{package.json,tsconfig.json,vitest.config.mts}`, `tsconfig.base.json`.
- **Hacer**: `packages/domain` como `@contapp/crypto`: `package.json` (`@contapp/domain`, `exports` `"."` con `types`; dependencia `decimal.js` exacta; dev `vitest`, `@vitest/coverage-v8` 5.0.5 y `fast-check` exacta; scripts `build` (`tsc -p tsconfig.build.json`), `typecheck`, `lint`, `test` (`vitest run --passWithNoTests`)); `tsconfig.json` con `types: []`, `lib: ["ES2023"]`, `include: ["src", "tests"]`, `noEmit`; `tsconfig.build.json` (`rootDir src`, `outDir dist`, `declaration`, excluye `**/*.spec.ts`); `vitest.config.mts` con `include: ["src/**/*.spec.ts", "tests/**/*.spec.ts"]`; `src/index.ts`, `src/dinero/index.ts`, `src/comprobante/index.ts` vacíos exportables. No crear otros archivos de `src/`.
- **Hecho cuando**: `pnpm install`, `pnpm --filter @contapp/domain build`, `typecheck`, `lint`, `test` salen 0; `pnpm-lock.yaml` actualizado; versiones elegidas en el mensaje del commit. Commit `chore(010): andamiaje de packages/domain`.

## T3 · Cobertura y CI (devops · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/plan.md` (Decisiones: Cobertura), `docs/specs/010-dominio-dinero/spec.md` (CA-12), `packages/crypto/vitest.cobertura.config.mts` (patrón), `package.json` raíz, `.github/workflows/ci.yml` (job `ci`).
- **Hacer**: (1) `packages/domain/vitest.cobertura.config.mts`: mismas pruebas que `vitest.config.mts`; v8, `include` exactamente `src/dinero/**/*.ts` y `src/comprobante/**/*.ts`, `exclude` solo `**/*.spec.ts` y `**/*.adv.spec.ts`, `reporter: ["text", "json-summary"]`, `thresholds: { perFile: true, lines: 90, statements: 90, functions: 90, branches: 90 }`. (2) Script `test:cobertura` en `@contapp/domain`; raíz `cobertura:dominio`. (3) CI, job `ci`: paso `pnpm cobertura:dominio` tras `pnpm build`. No tocar el job `aislamiento`.
- **Hecho cuando**: `pnpm cobertura:dominio` corre y sale 0 sin pruebas o ≠ 0 solo por umbral, nunca por error de configuración; con un archivo temporal `src/dinero/__tmp.ts` sin pruebas el umbral `perFile` lo reporta (borrarlo después); `prettier --check .github/workflows/ci.yml` OK. Commit `test(010): comando cobertura:dominio con umbral 90 % por archivo`.

## T4 · Pruebas de lint, rojo (tester · sonnet) ∥ T3
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/spec.md` (CA-1, CA-12), `docs/specs/010-dominio-dinero/plan.md` (Decisiones: Lint de dinero, Lint de IO), `tests/limites/limites.spec.ts` (líneas 1–40, patrón `lintText`).
- **Hacer**: `tests/limites/dominio.spec.ts` (archivo nuevo; no tocar los existentes). Con `filePath` ficticio `packages/domain/src/dinero/__prueba__.ts` y `…/comprobante/__prueba__.ts`, fallan: `let x: number`, `(m: number) => m`, `parseFloat("1")`, `parseInt("1")`, `Number("1")`, `new Number(1)`, `d.toNumber()`, `Math.round(1)`, `+s`, `import Decimal from "decimal.js"`, `Decimal.set({})`. El mismo código en `…/__prueba__.spec.ts` pasa; `import Decimal from "decimal.js"` en `packages/domain/src/dinero/decimal.ts` pasa. En `packages/domain/src/cualquiera/__prueba__.ts` fallan `import "node:fs"`, `import fs from "fs"`, `import "pg"`, `import "drizzle-orm"`, `import "@nestjs/common"`, `import "axios"`, `import "@contapp/sunat"`, `import "@contapp/db"`, `fetch("x")`, `process.env.X`, `Buffer.from("")`; `import "@contapp/shared"` pasa. Exigir `ruleId` y que el mensaje mencione `packages/domain`.
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` falla solo en los casos nuevos que la regla de T7 debe cubrir (los de `@contapp/{sunat,db}` ya pasan); los demás archivos de `tests/limites` siguen verdes. Commit `test(010): pruebas del lint de dinero e IO en packages/domain (rojo)`.

## T5 · Pruebas de dinero/, rojo (tester · sonnet) ∥ T3, T4
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/spec.md` (Alcance, CA-1 a CA-6, CA-11, Decisiones D1, D2, D3, D5, D7, D8), `docs/specs/010-dominio-dinero/plan.md` (Contratos: parte de `dinero/`; Decisiones: decimal.js aislado, Gramáticas, Inmutabilidad, Propiedades).
- **Hacer**: `packages/domain/src/dinero/{money,redondeo,igv,cuadre,factor}.spec.ts` contra la API pública (`../index`). Cubrir: CA-1; los 10 rechazos de CA-2 y además `null`, `undefined`, `new String("1.00")`, objeto con `toString`, `"+1"`, `"01.00"`, `".5"`, `"5."`, dígitos árabes y NBSP → `MontoInvalidoError`; CA-3 en suma, resta, negación del mínimo y `redondearSunat` de un producto; CA-4 con `MontoExacto`/`por` y además con `Decimal.set({ rounding: ROUND_HALF_EVEN, precision: 5 })` llamado **antes** de cargar el módulo (`vi.resetModules` + `import()` dinámico) y **después**; CA-5; CA-6 con fast-check (semilla fija, ≥ 1000 casos, negativos incluidos); CA-11 con fast-check; `MonedaDistintaError` al operar PEN con USD; `Object.isFrozen`; `JSON.stringify(m)` sin `number` y `desdeJSON` ida y vuelta; `MontoExacto` no serializa; `a < b`, `+a`, `` `${a}` `` (este sí funciona); `igvEsperado` y `igvCuadra` con ±0.01 (D2) y las dos tasas; `Factor`/`TipoCambio` inválidos (> 3 decimales, cero, negativo); `entre` por cero; `verificarCuadre` genérico con un `Cuadrable` de prueba (CA-10 con signo `total − suma`).
- **Hecho cuando**: `pnpm --filter @contapp/domain test` falla solo por falta de implementación (import o firma), no por errores de las pruebas; lista de pruebas en el commit. Commit `test(010): pruebas de Money, redondeo, IGV y cuadre (rojo)`.

## T6 · Pruebas de comprobante/ y casos reales, rojo (tester · sonnet) ∥ T5
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/spec.md` (CA-7 a CA-10, CA-13, Casos reales, Decisiones D2, D4, D6, D7), `docs/specs/010-dominio-dinero/plan.md` (Contratos: parte de `comprobante/`; Decisiones: Movimientos, Conversión), `docs/01-definiciones-base.md` (puntos 9 y 10 de la lista que contiene "Proveedores con error conocido").
- **Hacer**: `packages/domain/src/comprobante/{montos-comprobante,cambiar-destino,mover-monto,convertir}.spec.ts` y `packages/domain/tests/casos-reales/dinero.spec.ts`. Cubrir: CA-7 (`sumar` y `moverMonto` con otra moneda); CA-8 y consolidación de varios destinos con `consolidados`; CA-9 con positivos y con notas de crédito (saldo negativo: monto negativo válido, positivo inválido, |monto| > |saldo| inválido), saldo 0, y conservación de `Σ columnas` con fast-check (semilla fija) en cadenas de `cambiarDestino`/`moverMonto`; CA-10 sobre `MontosComprobante`; CA-13 exacto; clave desconocida en `desde`; `toJSON` sin `number`. Casos reales: mixta 21.48/1.61 y San Juan 770 tal como los escribe la spec (San Juan: BI DG 770.00, IGV DG 0.00, total 770.00). Dejar en el archivo de casos reales un `it.todo("redondeo USD: caso real diferido, sin cifras")`; no inventar cifras.
- **Hecho cuando**: igual que T5. Commit `test(010): pruebas de MontosComprobante, movimientos, conversión y casos reales (rojo)`.

## T7 · Reglas de lint (devops · sonnet) ∥ T8
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/plan.md` (Decisiones: Lint de dinero, Lint de IO), `eslint.config.mjs`, `tests/limites/dominio.spec.ts`.
- **Hacer**: bloques nuevos para `packages/domain/**` según el plan, sin alterar las reglas de `apps/*`, `packages/crypto` ni `sql-crudo`. `builtinModules` se importa de `node:module` en `eslint.config.mjs`. Mensajes que mencionen `packages/domain` y la spec 010.
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` en verde (todos los archivos); `pnpm lint` en verde en todo el repo. Commit `feat(010): lint contra number para dinero e IO en packages/domain`.

## T8 · Implementar dinero/ (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/plan.md` (todo), `docs/specs/010-dominio-dinero/spec.md` (Alcance, CA-1 a CA-6, CA-11, Decisiones), `packages/domain/src/dinero/*.spec.ts`, `packages/domain/package.json`.
- **Hacer**: los archivos de `dinero/` del plan y su reexportación en `src/index.ts`. Sin IO, sin `number` para montos, `decimal.js` solo en `dinero/decimal.ts`. No tocar `comprobante/` (T9) ni `eslint.config.mjs` (T7).
- **Hecho cuando**: pruebas de `src/dinero/` en verde; `build`, `typecheck` y `lint` del paquete OK; en `pnpm cobertura:dominio` cada archivo de `dinero/` ≥ 90 % en las 4 métricas (si una rama no se puede cubrir, escalar al arquitecto). Commit `feat(010): Money, redondeo SUNAT, IGV y cuadre`.

## T9 · Implementar comprobante/ (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/plan.md` (Contratos, Decisiones: Inmutabilidad, Movimientos, Conversión), `docs/specs/010-dominio-dinero/spec.md` (CA-7 a CA-10, CA-13, Casos reales, D4, D6, D7), `packages/domain/src/comprobante/*.spec.ts`, `packages/domain/tests/casos-reales/dinero.spec.ts`, `packages/domain/src/dinero/index.ts`.
- **Hacer**: los archivos de `comprobante/` del plan usando solo la API pública de `dinero/` (nunca `decimal.js`). No tocar `dinero/` salvo un error demostrado por una prueba (anotarlo aquí).
- **Hecho cuando**: `pnpm --filter @contapp/domain test` en verde (el `it.todo` de USD queda pendiente); `build`, `typecheck`, `lint` OK; `pnpm cobertura:dominio` sale 0. Commit `feat(010): MontosComprobante, cambio de destino, movimientos y conversión a PEN`.

## T10 · Integración (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/plan.md` (Contratos: comando), `package.json` raíz.
- **Hacer**: correr `pnpm build`, `typecheck`, `lint`, `test`, `cobertura:dominio` y `git grep -nE "parseFloat|parseInt|Number\(|toNumber\(|:\s*number\b" -- packages/domain/src/dinero packages/domain/src/comprobante ":!*.spec.ts"`.
- **Hecho cuando**: todos los comandos salen 0 (reportar conteos) y el grep no devuelve nada. Sin commit si no cambia archivos.

## T11a · Ronda 1a: lista mínima (adversario · opus)
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/spec.md` (Criterios, Decisiones, "Ataques obligatorios"), `docs/specs/010-dominio-dinero/plan.md` (Contratos). **Caja negra**: no leer `packages/domain/src/**/*.ts` que no sean pruebas.
- **Hacer**: hasta **8** pruebas (un `it.each` cuenta como una) en `packages/domain/src/dinero/ronda1a.adv.spec.ts` y `packages/domain/src/comprobante/ronda1a.adv.spec.ts`, solo contra `@contapp/domain` público, sobre la lista obligatoria de la spec: límite de NUMERIC(14,2) y sumas largas, medio centavo exacto positivo y negativo, notación científica, coma, espacios, `+`, ceros a la izquierda, Unicode, `number` disfrazado, cero negativo, conmutatividad/asociatividad, cuadre ±0.01, conservación del total encadenada, mutación, `Decimal.set` global, ida y vuelta NUMERIC y JSON.
- **Defensas**: solo adversario · opus (si la ejecuta otro rol, parar y avisar al orquestador); solo crear esos dos archivos; no modificar producción, configuración, otras pruebas ni `eslint.config.mjs`; no corregir nada. Cada prueba debe exigir un comportamiento escrito en un CA o una D (citarlo en un comentario) y tener un arreglo posible sin cambiar la spec; si exige cambiar la spec, marcarla `decide usuario`. Pruebas deterministas (fast-check con semilla fija, sin reloj ni red). Antes de reportar un fallo, comprobar que no es un error de la prueba (que el valor esperado sale de la spec). Al llegar al presupuesto, parar.
- **Hecho cuando**: pruebas commiteadas; cada fallo anotado en "Hallazgos adversariales abiertos" de `ESTADO.md` (releer antes; archivo:línea + una línea + severidad) y en "Resultado" de esta tarea. Commit `test(010): ronda adversarial 1a`.

## T11b · Ronda 1b: escenarios nuevos (adversario · opus) ∥ T11a
- **Contexto (leer solo esto)**: igual que T11a + `plan.md` (Decisiones, Riesgos); después (caja blanca) `packages/domain/src/dinero/*.ts`, `packages/domain/src/comprobante/*.ts`, `eslint.config.mjs` (bloques de `packages/domain`).
- **Hacer**: hasta **7** pruebas en `packages/domain/src/dinero/ronda1b.adv.spec.ts`, `packages/domain/src/comprobante/ronda1b.adv.spec.ts` y, solo para evasión del lint, `tests/limites/dominio-r1b.adv.spec.ts`, **distintas** de la lista de T11a: divisiones (`igv / 0.18`) y TC de 3 decimales seguidos de redondeo, valores a 1 ulp del límite tras `por`/`entre`, `Symbol.toPrimitive` y coerciones, acceso a internos (`#d`, prototipo, `Object.getOwnPropertyDescriptors`, subclases), `clone` heredando configuración global, `consolidados` con signos mezclados, `convertirAPen` con columnas negativas, gramáticas con longitudes extremas, evasión del lint contra `number` (alias de tipo, `Number` aliasado, `globalThis.parseFloat`) y riesgos del plan.
- **Defensas**: igual que T11a; además, no reportar como hallazgo lo que el plan ya declara como riesgo aceptado (Riesgos) salvo que lleve a un monto incorrecto.
- **Hecho cuando**: igual que T11a. Commit `test(010): ronda adversarial 1b`.

## T12 · Corregir ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de 010 en `docs/specs/ESTADO.md`, los `*.adv.spec.ts` que fallan, los archivos de producción que señalan, `plan.md` (Decisiones).
- **Hacer**: corregir en `packages/domain/src/` (o en `eslint.config.mjs` si el hallazgo es de lint). No editar pruebas. Si un hallazgo pide cambiar la spec o aceptar un riesgo, no decidir: `abierto · requiere usuario`.
- **Hecho cuando**: `pnpm --filter @contapp/domain test`, `pnpm --filter @contapp/tests-limites test`, `pnpm lint` y `pnpm cobertura:dominio` en verde salvo lo marcado para el usuario; hallazgos en `corregido (<commit>)`. Si la ronda 1 no tuvo fallos, marcar T12, T13a, T13b y T14 `[x]` "omitida: ronda 1 sin fallos". Commit `fix(010): hallazgos de la ronda adversarial 1`.

## T13a · Ronda 2a: regresión (adversario · opus)
- **Contexto (leer solo esto)**: igual que T11b + `git diff <commit de T11b>..HEAD -- packages/domain eslint.config.mjs`.
- **Hacer**: hasta **5** pruebas en `packages/domain/src/ronda2a.adv.spec.ts`: reintentar cada hallazgo corregido por otra vía y reconvertir las pruebas de hallazgos aceptados por el usuario para que fijen el comportamiento aceptado (con comentario que cite la decisión).
- **Defensas**: igual que T11a; no reabrir hallazgos descartados sin una vía nueva.
- **Hecho cuando**: igual que T11a. Commit `test(010): ronda adversarial 2a`.

## T13b · Ronda 2b: escenarios nuevos (adversario · opus) ∥ T13a
- **Contexto (leer solo esto)**: igual que T13a.
- **Hacer**: hasta **10** pruebas nuevas en `packages/domain/src/ronda2b.adv.spec.ts` contra las correcciones de T12 y los huecos que queden; ninguna repite una de T11a, T11b o T13a.
- **Defensas**: igual que T11b.
- **Hecho cuando**: igual que T11a. Commit `test(010): ronda adversarial 2b`.

## T14 · Corregir ronda 2 (backend · opus)
- **Contexto / Hacer / Hecho cuando**: igual que T12 con los hallazgos de T13a/T13b; omitida si no hubo. No hay ronda 3: lo que quede abierto pasa al usuario. Commit `fix(010): hallazgos de la ronda adversarial 2`.

## T15 · Verificación (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/spec.md` (Criterios, Pendientes), `plan.md` (Contratos: comando), hallazgos de 010 en `docs/specs/ESTADO.md`.
- **Hacer**: evidencia por CA con comando y resultado: CA-1 (prueba + `tests/limites/dominio.spec.ts` + el `git grep` de T10 vacío + `import Decimal from "decimal.js"` temporal en `comprobante/` rompe `pnpm lint`, revertido); CA-2 a CA-11 y CA-13 (`pnpm --filter @contapp/domain test`, nombre de la prueba por CA); CA-12 (`pnpm cobertura:dominio` con `json-summary`: mínimo por archivo y métrica; lint de IO); casos reales; `*.adv.spec.ts` verdes; el caso USD sigue `it.todo` (pendiente no bloqueante). Si la cobertura no llega, crear subtareas tester/backend; no bajar el umbral.
- **Hecho cuando**: cada CA con evidencia en "Resultado" de esta tarea; ESTADO 010 → `verificada`. Commit `docs(010): verificación de CA con evidencia`.

## T16 · Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `docs/specs/010-dominio-dinero/{spec,plan}.md`, "Resultado" de T15, `packages/domain/src/dinero/{decimal,money,redondeo}.ts`, `packages/domain/src/comprobante/{mover-monto,cambiar-destino,convertir}.ts`, bloques de `packages/domain` en `eslint.config.mjs`.
- **Hacer**: contrastar cada CA y D1–D8 con su evidencia y el DoD A (04 §5); listar faltantes, riesgos aceptados y el pendiente USD para informar al usuario.
- **Hecho cuando**: veredicto "aprobada" o lista de faltantes con tarea asignada. Sin commit si no cambia archivos.

## T17 · Cierre (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/ESTADO.md`, `docs/specs/010-dominio-dinero/tasks.md`, veredicto de T16.
- **Hacer**: marcar `[x]` las tareas hechas y las casillas CA de `spec.md` (el caso USD queda sin marcar, diferido); ESTADO 010 → `hecha`, "Tarea actual" → `—`, nota "caso real USD diferido"; hallazgos de 010 en su estado final. Releer ESTADO antes de editar.
- **Hecho cuando**: `git status` limpio salvo `docs/explorador/`, `.codex/`, `AGENTS.md`, `docs/specs/004-auth/`; `git log --oneline` muestra los commits de 010. Commit `chore(010): cierra spec 010`.
