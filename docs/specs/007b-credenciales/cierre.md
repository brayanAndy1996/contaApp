# Cierre 007b · Credenciales, importación Excel y panel de trabajos

Spec `007b-credenciales` · nivel B · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 007b-credenciales | B | hecha | — | Mergeada en `main` (87326d4). Parte 2 de la antigua 007: credenciales SOL/SIRE (solo escritura, cifradas en el backend, verificadas por el worker), importación masiva CSV/XLSX con vista previa y cupo, consulta RUC con mock y panel de trabajos con SSE. CA-1 a CA-10 con evidencia (T19); revisión T20 aprobada sin bloqueantes. 4 hallazgos H-007b corregidos (T17); defectos D-1/D-2 de la prueba manual corregidos (T18a). Decisiones del usuario 2026-11-04: P1/P2, H-007b-4 (exigir permiso vigente) y D-3 (aceptar ~2 trabajos/s en R1). CI verde (run 41904743049). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 4 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `007b-credenciales`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [real] Velocidad de la cola `xml` aceptada en R1 (decisión del usuario 2026-11-04, 007b D-3): ~2 trabajos/s por estudio (~8,5 min por 1.000 consultas RUC). Revisarla con la consulta RUC real.
- [dependencias] 007b agregó `fast-xml-parser` 5.11.2 y `fflate` al backend, con el override `is-unsafe: 2.0.2` en `pnpm-workspace.yaml`.
- ~~[frontend] Deuda menor de 007b: la ficha de credenciales no se refresca sola al terminar la verificación, el estado «Inválida» muestra el código crudo (`credenciales-cliente.tsx:82`) y «Cancelar» se ve aunque el usuario no pueda cancelar (recibe 403).~~ (cerrada por 020)
