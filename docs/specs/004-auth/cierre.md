# Cierre 004 · Autenticación, sesión y multi-estudio

Spec `004-auth` · nivel A · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 004-auth | A | hecha | — | Hecha. Rama `spec/004-auth` sin mergear (desde `spec/010-dominio-dinero`). O-2 y límites de T20a aceptados por el usuario. CI en rojo hasta 1216e84 de 005: faltaba compilar shared. |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 11 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `004-auth`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [004] Límites conocidos de la corrección O-1 (T20a, `0010_auth_final.sql`): dos logins simultáneos del mismo usuario con re-hash pendiente → el segundo da 401 y el reintento entra; login o cambio de estudio más cambio de contraseña con la misma cookie pueden interbloquearse → 500 genérico, sin sesión indebida. Aceptados por el usuario con O-2.
