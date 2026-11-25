# Tareas 042 · Acelerar el desarrollo

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Spec, plan y tareas | arquitecto | opus | — | — | — | [x] |
| T2 | Método y plantillas (B2, B3, B4) | devops | sonnet | T1 | — | — | [x] |
| T3 | Línea base para CA-2: lista de pruebas y cobertura actuales | devops | haiku | 028 en `main` | — | — | [ ] |
| T4 | Config única de cobertura en backend y worker (A1) | devops | sonnet | T3 | — | — | [ ] bloqueada |
| T5 | `ci.yml`: jobs paralelos, paths-ignore, concurrency, dos niveles (A2–A5) | devops | sonnet | T4 | — | — | [ ] bloqueada |
| T6 | Reporter compacto (B5) y regla A6 en el método | devops | haiku | T4 | — | — | [ ] bloqueada |
| T7 | Migrar `ESTADO.md` (B1, B6) | devops | sonnet | 028 en `main` ∥ | — | — | [ ] |
| T8 | Verificar CA-1 a CA-6 y cerrar | devops | sonnet | T5–T7 | — | — | [ ] bloqueada |

## T2 · Método y plantillas
- **Contexto**: `docs/04-metodologia.md` (§1.3, §2.3, §5, §7), `docs/specs/_plantilla/`, `spec.md#alcance` (B2–B4).
- **Hecho cuando**: el método y las plantillas reflejan B2, B3 y B4 (CA-6 parcial).

## T3 · Línea base (CA-2)
- **Contexto**: `plan.md#parte-a`, scripts `cobertura:*` de `package.json`, `apps/{backend,worker}/vitest.cobertura-*.config.mts`, tablas de cobertura de T23 de 028 (las da el orquestador).
- **Hacer**: en `linea-base/`: por cada config de cobertura de backend y worker y por `test:aislamiento`, `test:int` de backend y worker y `test:int:cierre`, la lista ordenada de archivos de prueba (`vitest list --filesOnly`); la tabla por archivo de cobertura (de los logs de T23) en TSV; y los umbrales y `coverage.include` de cada config.
- **Hecho cuando**: `linea-base/` tiene listas, tablas y umbrales, y `resultados.md` la resume. Sin cambios de código.

## T4 · Config única de cobertura (A1)
- **Contexto**: `plan.md#parte-a` (A1), `linea-base/`, las configs `vitest.cobertura-*.config.mts` de backend y worker.
- **Hacer**: `vitest.cobertura.config.mts` único por app (unión de `test.include` y `coverage.include`, umbrales por glob iguales), borrar las por spec, scripts raíz `cobertura:backend` y `cobertura:worker` (los de `packages/*` siguen). Correr ambas con BD propia y comparar con `linea-base/` (mismos archivos de prueba, ningún archivo bajo su umbral).
- **Hecho cuando**: las dos pasan; diferencias con la línea base explicadas en `resultados.md`; un archivo bajo 90 % se informa y no se baja el umbral (D1).

## T5 · `ci.yml` (A2–A5)
- **Contexto**: `plan.md#parte-a` (A2–A5), `.github/workflows/ci.yml`, resultado de T4.
- **Hacer**: jobs paralelos `aislamiento`, `cobertura-backend`, `cobertura-worker`, `cobertura-paquetes`, `cierre` con su PostgreSQL y Redis; `paths-ignore`; `concurrency`; en push a `spec/**` solo el job `ci` con unitarias, el resto en `pull_request`, push a `main` y `workflow_dispatch`. E2E igual que hoy.
- **Hecho cuando**: `actionlint` (o validación YAML) limpio y los pasos equivalen a los de antes (ninguna suite perdida).

## T6 · Reporter compacto y regla A6
- **Contexto**: `plan.md#parte-b` (B5), `docs/04-metodologia.md` §7.
- **Hacer**: reporter `dot` en los scripts `test`/`test:int` y en el CI; regla A6 en §7; `prompt-orquestador.md` menciona B2–B5.
- **Hecho cuando**: las suites unitarias corren con salida compacta y siguen verdes.

## T7 · Migrar `ESTADO.md` (B1, B6)
- **Contexto**: `plan.md#parte-b` (B1/B6), `docs/specs/ESTADO.md`, `docs/specs/_plantilla/cierre.md`.
- **Hacer**: por cada fila de spec, `docs/specs/NNN-*/cierre.md` con el texto completo de su fila (si ya existe, se añade); la tabla queda con nota ≤ 200 caracteres; hallazgos cerrados (no «abierto»/«pendiente») a `docs/specs/HALLAZGOS.md` tal cual; notas para specs futuras ≤ 2 líneas cada una (el texto largo va al `cierre.md` de la spec que la originó o a `HALLAZGOS.md`).
- **Hecho cuando**: `ESTADO.md` < 3.000 palabras y un script de comprobación muestra que cada fila y hallazgo anterior está, íntegro, en un `cierre.md` o en `HALLAZGOS.md`.

## T8 · Verificar y cerrar
- **Contexto**: `spec.md#criterios-de-aceptación`, `resultados.md`.
- **Hacer**: medir CA-1 (dos corridas en `main`), CA-3 (push de docs, dos pushes seguidos), CA-4 (rama `spec/*`), CA-2 (comparación con la línea base), CA-5, CA-6; marcar CA y tareas.
- **Hecho cuando**: CA-1 a CA-6 con evidencia en `resultados.md`.
