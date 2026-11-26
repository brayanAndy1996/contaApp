# Cierre 013 · Ventas (RVIE): descarga, importación, grilla y correlatividad

Spec `013-ventas` · nivel B · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 013-ventas | B | hecha | — | Mergeada en `main` (9ea92b2). Modelo común de propuesta (`propuesta`, `propuesta_diferencia`, tipo `sire.propuesta.descargar` con `libro` y registro de persistidores por libro), ventas RVIE inmutables con descarga complementaria (D16/D18) e importación TXT/Excel en dos fases con layout provisional, grilla, resumen en soles, correlatividad con saltos justificados, venta agregada, «No cuadra» y advertencias de importación. CA-1 a CA-14 con evidencia (T21); prueba manual T20 con 2 defectos corregidos (T20a); revisión T22 aprobada (T22a/T22b). Ronda adversarial: H-013-1 a H-013-8 corregidos. Decisiones del usuario 2026-11-06/07: P-1–P-11, D18–D26, Q-1. Migraciones 0028–0031. CI verde (run 42371198519). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 8 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `013-ventas`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [014] Contrato real del persistidor común (plan de 013, «Contrato real del persistidor»): `PersistidorLibro { preparar, leerExistentes, insertar }` en el worker más `aplicarComplemento` (`packages/db`, `planificar` inyectado); reutilizar `claveNormalizada` y `planificarComplemento`; en `propuesta_diferencia` el origen `agregada` pasa a `manual`; columna `creada_en`; bloqueo advisory `(cliente, periodo, libro)` antes que `compra_periodo`; la ruta de descarga de 013 responde 202 `{ trabajoId }`.
- [oficial] Sustituir el layout provisional de importación de ventas (`LAYOUT_VENTAS_PROVISIONAL`) y el RVIE `oficial: false` por los oficiales; `validarFilaVenta` no valida fecha dentro del periodo ni catálogo de tipos (lo fija el layout oficial, 013 D25).
- [pruebas] Pruebas sensibles a la carga (013 T22a): adv-l2/adv-l3/adv-c4 con 3 s y `retry: 2`; el frontend usa `asyncUtilTimeout: 5000`. Si vuelven a fallar en CI, valorar `turbo run test --concurrency=2`.
- [013] Observaciones no bloqueantes de la revisión T22: `leerFilasVentas` sin tope de filas del periodo tras D19; el worker no revisa si el cliente fue archivado después de encolar.
