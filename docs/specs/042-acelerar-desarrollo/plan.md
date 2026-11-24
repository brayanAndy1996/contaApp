# Plan 042 · Acelerar el desarrollo

## Fases
- **Fase 1 (ya, sin conflicto con 028):** B2, B3 y B4 en `docs/04-metodologia.md` y `docs/specs/_plantilla/`. Solo documentos que 028 no toca.
- **Fase 2 (justo después de fusionar 028, entre specs):** A1–A6, B1, B5 y B6. Tocan `ci.yml`, las configuraciones de cobertura, los `package.json` y `ESTADO.md`, que cada spec en curso modifica.

## Parte A · contrato
- A1: `apps/backend/vitest.cobertura.config.mts` y `apps/worker/vitest.cobertura.config.mts` únicos. `coverage.include` = unión de los `include` de las 19 configuraciones actuales; `coverage.thresholds` = un bloque por glob con los mismos valores (90 % por archivo) de la config que hoy mide ese glob. `test.include` = unión de las suites. Se borran las configuraciones por spec y sus scripts `test:cobertura:*`. Los scripts raíz `cobertura:*` se reemplazan por `cobertura:backend` y `cobertura:worker`.
- A2: jobs paralelos en `ci.yml`, cada uno con servicios `postgres:17` y `redis:7`: `aislamiento` (`ci:db`), `cobertura-backend`, `cobertura-worker`, `cobertura-paquetes` (db y crypto), `cierre` (008). `ci` (lint, tipos, build, dominio, storage, sunat) sigue como está.
- A3: `on.push.paths-ignore` y `on.pull_request.paths-ignore`: `docs/**`, `**/*.md`.
- A4: `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: ${{ github.ref != 'refs/heads/main' }} }`.
- A5: en push a ramas `spec/**` solo corre `ci` con pruebas unitarias. Los jobs con base de datos, la cobertura y E2E corren en `pull_request`, push a `main` y `workflow_dispatch`.
- A6: regla en §7 del método: una spec agrega sus globs a la config única, no un paso de CI.
- Verificación de CA-2: antes y después se guarda la lista de archivos de prueba ejecutados (`--reporter=json`) y la tabla de cobertura por archivo; deben coincidir.

## Parte B · contrato
- B1/B6: `ESTADO.md` = tabla `| Spec | Nivel | Estado | Tarea actual | Nota (≤ 200 caracteres) |` + hallazgos **abiertos** + decisiones pendientes + notas para specs futuras (cada una ≤ 2 líneas). Por spec cerrada, `docs/specs/NNN-*/cierre.md` con el texto completo de su fila. Hallazgos cerrados a `docs/specs/HALLAZGOS.md`, tal cual.
- B5: reporter `dot` en los scripts `test` y en el CI; en caso de fallo, solo la lista de fallos.

## Riesgos
- Unir configuraciones puede revelar un archivo bajo el 90 % que antes se medía con otra suite (D1): se informa al usuario.
- Paralelizar suites con base de datos: cada job tiene su propio PostgreSQL, así que no comparten estado.
