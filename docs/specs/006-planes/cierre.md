# Cierre 006 · Planes, registro de estudio y límites

Spec `006-planes` · nivel B · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 006-planes | B | hecha | — | Hecha. Mergeada en `main` (5a9fd7a). CA-1 a CA-14 con evidencia (T14); revisión T15 aprobada con 2 defectos corregidos en T15a/T15b (cupo al aceptar con sesión, `reservar` inválido). 10 hallazgos H-006 corregidos. Decisiones del usuario 2026-11-03: D14, D15, lock en proceso, CLI de alta de super-admin (`pnpm db:plataforma-alta`) y P-T15-2 (dejar así en R1). CI verde (run 41664504503). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 10 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `006-planes`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [006] D4 de la spec dice `FOR UPDATE`; prevalece el bloqueo advisory `plan.cupo:<tenant>` de `plan.md` (ratificado en T15).
