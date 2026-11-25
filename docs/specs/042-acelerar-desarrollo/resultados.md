# Resultados 042 · Acelerar el desarrollo

## T2 (2026-11-24)
- `docs/04-metodologia.md`: §1.3 paso 6 y §2.3 con 1 ronda adversarial por defecto y modelo según el área; §5 «Todos» con una corrida de CI en verde; §7 reglas 12 a 15 (presupuesto, topes de tamaño, una corrida en verde, ESTADO liviano).
- `docs/specs/_plantilla/`: topes en `spec.md`, `plan.md` y `tasks.md`; nuevas `resultados.md` y `cierre.md`.

## T3 (2026-11-25)
- `linea-base/`: 26 archivos, uno por config (22 de cobertura: 12 backend y 10 worker; `backend-int`, `worker-int`, `worker-int-cierre`, `aislamiento`). Cada uno trae configuración, lista de `vitest list --filesOnly` en HEAD 68a9e68 y tabla por archivo en TSV (T23, 60cf6b8).
- Umbrales: las 22 configs de cobertura usan `perFile` con 90 % en sentencias, ramas, funciones y líneas. En las tablas ningún archivo queda bajo 90 %; el mínimo es `worker-gastos` · `ciiu.ts`, con 90 % de ramas (justo en el umbral).
- Conteos: HEAD y T23 coinciden en 17 configs; en 5 configs worker (cola, correo, aprendizaje, reglas, xml) HEAD tiene +1, `apps/worker/src/trabajos/procesadores/enviar-correo-t24.spec.ts` (nuevo tras 60cf6b8, que la tabla no refleja). Todos los runs de T23 pasaron.
- Desde 60cf6b8: además de `consola.ts` y los 2 specs nuevos, `package.json` solo cambia `ci:db` y `ci:cierre` (añaden `@contapp/correo build`); los `cobertura:*` no cambian y `consola.ts` no entra en ninguna config de backend o worker.
- Discrepancia con `plan.md`: dice 19 configs de cobertura; el inventario en HEAD tiene 22 (12 backend, 10 worker). Corregir antes de A1.
- Hallazgo para A1: `worker` aprendizaje, reglas y xml miden 1 o 2 archivos cada una, pero ejecutan la misma suite de trabajos (112 archivos y 1095 pruebas en T23, unos 590 s cada una).
- Tablas: vitest omite los archivos al 100 % y trunca nombres. Cada nombre se resolvió contra el universo de su config (include menos exclude en HEAD): 0 sin asignar y 6 filas por orden alfabético (mismo nombre en el mismo directorio). `backend-reglas` no tiene tabla (todo al 100 %).
- Método: cada run de T23 se asigna por el orden de comandos de su script y su conteo de archivos cuadra con `vitest list` en las 22 configs (salvo el +1 de arriba).
- Tiempo: los runs de vitest de los 13 logs suman 96,2 min en secuencia (sin builds); los más largos son `backend-acceso` (950 s) y `backend-cobertura` (942 s). Referencia de CI antes de 042: 2 h 46 min (run 45552022936, 05:13–07:59 UTC).
- Sin cambios de código; `ESTADO.md` sin tocar; no se corrieron pruebas.

## T4 (2026-11-25)
- Config única (A1): `apps/backend/vitest.cobertura.config.mts` (la de 004 más `aislamiento/acceso*`, `db/src/acceso` y sus globs medidos) y `apps/worker/vitest.cobertura.config.mts` (la de 008 más `adaptadores/*.spec.ts` y `adaptadores.module.ts`). `projects` como las bases; `coverage.include` y `thresholds` salen de una sola lista `medidos`: un bloque `perFile` 90/90/90/90 por glob. `git rm` de las 21 configs por spec (11 backend, 10 worker).
- Scripts: `cobertura:backend` y `cobertura:worker` (builds en unión: shared, storage, correo, db, crypto, domain, sunat, queue) y `test:cobertura` en el worker. Fuera: los `test:cobertura:*` de las dos apps y `cobertura:auth`, `acceso`, `cola`, `xml`, `archivos`, `auditoria`. Siguen los de `packages/*` (`dominio`, `storage`, `sunat`, `db`, `crypto`).
- Valores iguales: las 22 configs usaban `perFile` 90 en las cuatro métricas (sin conflictos), `testTimeout` 30 s, `fileParallelism: false` y `maxWorkers: 1`; ninguna tenía `setupFiles` ni `poolOptions`. Cambios: reporter `text` + `json-summary` (las bases tenían `html`); `hookTimeout` por defecto (solo las de `correo` tenían 30 s; pasa sin él); `CONTAPP_COBERTURA` como en las bases (backend en todo, worker en `worker-int`): las suites que leen la marca ya corrían así en ellas.
- Listas: `vitest list --filesOnly` da 377 (backend) y 228 (worker) archivos, idénticos a la unión (dedup) de `linea-base/`. Universo medido (include − exclude): 211 y 80 archivos, igual a la unión de lo que medían las configs, y todos caen en un bloque de umbral (comprobado con picomatch; un archivo sin bloque no se exigiría).
- Corridas (BD y Redis propios, Node 22.22, 4 vCPU, **las dos a la vez**, así que las duraciones son cotas altas): backend `pnpm cobertura:backend` 26,4 min (vitest 1556 s, builds ~30 s): 377 archivos, 10.319 pruebas OK y 1 omitida; worker, parte vitest de `cobertura:worker` 19,7 min (1182 s): 228 archivos, 3.233 pruebas OK (la cadena completa del script se probó aparte con `--project aislamiento-trabajos`). Línea base en serie: 12 configs = 2519 s (42 min, 822 ejecuciones de archivo) y 10 = 2960 s (49 min, 621); T23 solas: 942 s y 867 s.
- Cobertura: ningún archivo bajo 90 % ni métrica por debajo de la línea base (57 y 36 filas de sus tablas). Mínimos: backend ramas 90,9 % (`buzon/lectura.service.ts`), sentencias 95 %, funciones 94,9 %, líneas 94,3 %; worker ramas 91,4 % (`trabajos.service.ts`), sentencias 95,1 %, funciones 94,4 %, líneas 94,3 %. Sin casos D1.
- `ci.yml` (T5), pasos rotos porque su script ya no existe (6): `cobertura:auth`, `acceso`, `cola`, `xml`, `archivos`, `auditoria`. Parciales (7): `cobertura:reglas`, `buzon`, `bandeja`, `aprendizaje`, `prorrata`, `gastos`, `correo` siguen, pero ya sin backend ni worker; T5 debe agregar `cobertura:backend` y `cobertura:worker`. Sin cambio: `dominio`, `storage`, `sunat`, `db`, `crypto`.
- A decidir en T5 (el plan no lo cubre): esos 7 scripts eran los únicos que corrían 20 configs por spec de `packages/*` (domain 6, sunat 4, db 7, correo, queue y shared 1 cada una; las de db usan PostgreSQL). Se dejaron sus pasos para no perder cobertura (A1: «las de `packages/*` se mantienen»); T5 debe correrlos en algún job o unirlas por paquete.

## T5 (2026-11-25)
- `ci.yml`: `paths-ignore` (`docs/**`, `**/*.md`) en push y PR, `workflow_dispatch` sin filtro; `concurrency` `ci-${{ github.ref }}` con cancelación salvo en `main`. `ci` corre siempre; `aislamiento`, `cobertura-backend`, `cobertura-worker`, `cobertura-paquetes`, `cierre` y `e2e` solo en `pull_request`, push a `main` y dispatch, en paralelo (sin `needs`; `e2e` idéntico).
- Cada job con BD: `postgres:17`, `redis:7`, `env` y `DATABASE_URL` por corrida iguales a los de `aislamiento` de antes. Los 4 nuevos suman «Build de shared y db» + `pnpm db:migrate && pnpm db:seed` (lo hacía `ci:db`; `db` solo importa `shared`); `cierre` además construye crypto, domain y sunat (el worker compilado los necesita) e instala `redis-server`. `CORREO_PROVIDER` y `APP_ORIGIN` solo en los pasos que los tenían.

| Paso del CI viejo | Ahora |
|---|---|
| `ci:db` · `ci:cierre` | jobs `aislamiento` · `cierre` |
| `cobertura:auth`, `acceso`, `cola`, `xml`, `archivos`, `auditoria` (scripts borrados en T4) | `cobertura:backend` · `cobertura:worker` |
| `cobertura:reglas`, `buzon`, `bandeja`, `aprendizaje`, `prorrata`, `gastos`, `correo` | partes backend y worker en los dos de arriba; partes `packages/*` en `cobertura-paquetes` (mismos scripts y orden) |
| `cobertura:db`, `cobertura:crypto` | `cobertura-paquetes` (al final) |
| lint, typecheck, build, `cobertura:dominio/storage/sunat`, `e2e` | sin cambio (`ci` suma `pnpm test`) |

- Verificación: YAML válido (`yaml.safe_load`); `actionlint` no está instalado. Script de comprobación (no versionado): cada `pnpm X` existe en el `package.json` raíz, `e2e` idéntico, `env` y `services` de los 4 jobs nuevos iguales a `aislamiento` anterior; de las invocaciones de vitest del CI viejo solo desaparecen las 21 configs por spec de backend/worker (las cubren las 2 únicas de T4) y las 25 de `packages/*` siguen.
- **`pnpm test` local falla** (Node 22.22, 4 vCPU, `CI=true`, sin variables de BD): (1) `@contapp/db`: 25 de 104 archivos (`aprendizaje/*`, `buzon/{bandeja,indicador}`, `correo/*`, `gastos/*`, `prorrata/*`, todos `.spec.ts` sin `.int.`) lanzan «Faltan variables de entorno» y `ci` no tiene BD; (2) con las suites en paralelo (turbo por defecto y `--concurrency=2`) falla `frontend` `compras/page.integracion.spec.tsx` («Editar» en la lupa, foco; pasa sola y con turbo solo, 175 s) y una vez `backend` `lector-ventas.adv.spec.ts` adv-l1 (< 3 s; tardó 8 s bajo carga). Sin `db` y en serie, `pnpm exec turbo run test --filter='!@contapp/db' --concurrency=1` pasa 11 de 11 en 5 min 9 s. El paso quedó como `pnpm test` hasta decidir: dejar `db` fuera del nivel 1 o mover esos 25 archivos a `.int.spec.ts`, y serializar.

## T6 (2026-11-25)
- Forma elegida: `reporters: ["dot"]` en el bloque `test` de las 13 configs de suites sin cobertura (apps frontend, backend y worker; packages correo, crypto, db, domain, queue, shared, storage y sunat; tests aislamiento y limites). Sin cambios en scripts, `ci.yml`, `include` ni umbrales: el CI hereda el reporter vía `pnpm test`, `test:int` y `test:aislamiento`.
- `docs/04-metodologia.md` §7: la regla 6 menciona `dot`; regla 16 nueva (A6, con el CI de dos niveles de A5). `docs/prompt-orquestador.md`: 4 líneas en REGLAS (B2–B5, A5/A6).
- `turbo run test --filter='!@contapp/db' --concurrency=1`: 11/11 OK en 5 min 10 s; 702 archivos, 13.906 pruebas OK y 3 todo, 0 fallos.
- `pnpm lint`: 12/12 OK, 0 problemas ESLint. `pnpm typecheck`: 20/20 OK, 0 errores TS.
- Pendiente (decisión): las corridas de cobertura (`cobertura:*` y `test:cobertura`, 27 configs) mantienen el reporter por defecto; pasarlas a `dot` es un cambio aparte.
