# Cierre 022 · Rendimiento de R1 antes de buzones

Spec `022-rendimiento` · nivel B · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 022-rendimiento | B | hecha | — | Mergeada en `main` (8c6ffef). RP-1 despachador por tramos de 100 (`TRAMO_PISTAS`), 20.000 restos en ~20 ms por atención (antes 2,3–3,3 s), con ronda ADV (H-022-1 a 3 corregidos). RP-2 `leerExistentesCompras` con `join lateral` (20.000: 64 s → 0,1–0,3 s). RP-3 venta por id. RP-4 avisos con tope 1.000 + `avisosOmitidos` y «Y N avisos más». RP-5 Ctrl+Z de la masiva 1,83 → 1,37 s (P-3 revisada por el usuario: ~1,5 s aceptado; E-06 tope 3 s). RP-6 archivo de compras 20.000 filas 3,1 → ~2,4 s (P-4 revisada: CI vigila ≤ 3,5 s; límite 5 s intacto). CI verde en 3 corridas seguidas (dispatch 43776630495 con E2E). Sin migraciones (0052–0054 liberadas). Desvíos ratificados en `plan.md` (T14). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 4 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `022-rendimiento`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [pruebas] Pruebas de tiempo sobre una BD reutilizada se degradan (sin estadísticas recientes `deshacer-masivo-022` midió 10,8 s frente a 1,2 s): medir siempre en BD nueva o tras `ANALYZE` de las tablas usadas (022 T13, f3a9d62).
- [mantenimiento] `escribirVersiones` (022 T9) solapa `evaluar` con las escrituras: correcto solo mientras `Evaluar` no lea de la BD. Si una spec lo hace leer, volver al orden secuencial. El comentario de `packages/db/src/compras/tipos.ts:97` aún dice «con la versión nueva ya escrita».
- [rendimiento] Aceptado por el usuario (022): Ctrl+Z de la masiva ~1,4 s (bajar de ~1,1 s la llamada exige cambiar el esquema o dejar de re-evaluar) y archivo de compras de 20.000 filas ~2,4 s (más exige reescribir el armado con `decimal.js`).
