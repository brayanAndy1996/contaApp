# Cierre 005 · Roles, permisos, asignación y alcance

Spec `005-acceso` · nivel A · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 005-acceso | A | hecha | — | Hecha. Rama `spec/005-acceso` sin mergear (desde `spec/004-auth`). CI verde (1216e84). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 10 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `005-acceso`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [007b y siguientes] Toda escritura nueva sobre `membresia`, `cliente` o `asignacion` usa `filtroAlcance` y `ClienteScopeGuard` y sigue el orden global de bloqueo de 005: `bloquearMiembros` primero; después el último Dueño, los clientes por ID y, al final, asignaciones e invitaciones.
- [005] Riesgo aceptado (bajo): se rechazan ZWJ y ZWNJ (U+200D, U+200C, categoría `Cf`) en nombres de invitación; los usan algunos alfabetos (persa, índicos) y emojis compuestos. No afecta a nombres en español.
- [005] Riesgo aceptado (bajo): `invitacion_vigente` lee la membresía del invitador sin bloqueo; la aceptación se serializa con la revocación en la fila de la invitación (plan, T15).
