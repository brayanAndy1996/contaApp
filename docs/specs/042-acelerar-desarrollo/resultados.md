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
