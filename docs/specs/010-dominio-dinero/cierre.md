# Cierre 010 · Dominio de dinero

Spec `010-dominio-dinero` · nivel A · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 010-dominio-dinero | A | hecha | — | Rama `spec/010-dominio-dinero` sin mergear (desde `spec/003-cifrado`). Caso real USD diferido, sin cifras (pendiente no bloqueante; CA-13 sintético cubre D7). Los 3 límites del lint de `packages/domain` fueron aceptados por el usuario (D10 de la spec). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 11 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `010-dominio-dinero`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [013] Columnas de ventas: 010 no las trae (D4); 013 reutiliza `Money` y un `verificarCuadre` genérico sobre su propia lista de componentes.
- [diferido] Caso real USD sin cifras: al llegar, agregarlo en `tests/casos-reales/` (dinero y reglas); si contradice D7 de 010, reabrir D7 y D-6 con el usuario.
