# Cierre 007a · Clientes, perfil fiscal, archivado y listado

Spec `007a-clientes` · nivel B · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 007a-clientes | B | hecha | — | Mergeada en `main` (5a61f83). Parte 1 de la antigua 007 (decisiones del usuario 2026-11-03: P1–P7 y razón social provisional; 2026-11-04: responsable al crear sin `clientes.asignar` y sin shadcn). CA-1 a CA-9 con evidencia (T12); revisión T13 aprobada con 3 defectos de frontend corregidos (T13a/T13b). CI verde (run 41822187470). |

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [lint] Resuelto en 007a (T10): las consultas van en repositorios de `packages/db`; el lint también veta `sql` a través de `import * as` de `drizzle-orm`.
