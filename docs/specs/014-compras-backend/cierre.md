# Cierre 014 · Compras (backend): propuesta inmutable, versiones de fila, clasificación, exclusión y agregar

Spec `014-compras-backend` · nivel B · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 014-compras-backend | B | hecha | — | Mergeada en `main` (2bc3252). Compras inmutables con versiones por fila (`compra`, `compra_version`, `compra_operacion`, `compra_hallazgo`, `compra_periodo`), persistidor de compras sobre el modelo común de 013, clasificación, edición con vista previa (`calcular`), sugerencias de 011 (individuales y en bloque con hallazgo guardado), excluir/restaurar, agregar/descartar, deshacer/rehacer por usuario y periodo, estados abierto/revisado/generado con reabrir por estado visto, propuestas y diferencias, resumen y Excel de todo el periodo, y `leerFilasReemplazo`/`fijarEstadoPeriodo` para 012b. CA-1 a CA-20 con evidencia (T21); revisión T22 conforme (M-1 corregido). Ronda adversarial: H-014-1 a H-014-6 corregidos. Decisiones del usuario 2026-11-06/07: P-1–P-12 y DU-13–DU-26. Migraciones 0032–0034. CI verde (run 42423053549). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 6 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `014-compras-backend`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [015] Deshacer responde 409 `fila_cambiada` con los ids cuando otra persona cambió o descartó una fila de la última operación; la grilla debe mostrarlas (014 DU-26). La vista previa usa `POST …/calcular` más suma local con `decimal.js` (DU-10).
