# Tablero de specs

Lo mantiene el **orquestador** (y lo cierra `devops` al terminar cada spec). Orden y roles: [04-metodologia.md §4](../04-metodologia.md).

Estados: `pendiente` · `borrador` · `aprobada` · `en curso` · `verificada` · `hecha` · `bloqueada`

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 001-fundaciones | D | hecha | — | Sin Docker (decisión del usuario). TypeScript 6.0.3. CI de GitHub sin ejecutar: el repo no tiene remoto. |
| 002-db-rls | A | en curso | T1 (plan.md y tasks.md listos) | Spec aprobada por el usuario (D1–D3, D5–D7). P7 resuelta en el plan. Rama `spec/002-db-rls` desde `spec/001-fundaciones`. |
| 003-cifrado | A | pendiente | — | Hereda de 002 (D3): permiso por columnas de `credencial`; backend no lee el cifrado. |
| 004-auth | A | pendiente | — | — |
| 005-acceso | A | pendiente | — | Hereda de 002 (D2): criterio de HU-40 "por API" (aislamiento entre estudios probado vía endpoints). |
| 006-planes | B | pendiente | — | — |
| 007-clientes | B | pendiente | — | — |
| 008-cola | A | pendiente | — | — |
| 009-adaptadores-mock | C | pendiente | — | — |
| 010-dominio-dinero | A | pendiente | — | — |
| 011-motor-reglas | A | pendiente | — | — |
| 012-prevalidacion-archivos | A | pendiente | — | — |
| 013-ventas | B | pendiente | — | — |
| 014-compras-backend | B | pendiente | — | — |
| 015-compras-frontend | C | pendiente | — | — |
| 016-lupa-xml | B | pendiente | — | — |
| 017-auditoria-notif | B | pendiente | — | — |
| 018-e2e-r1 | C | pendiente | — | — |

## Hallazgos adversariales abiertos
| Spec | Prueba | Hallazgo | Estado |
|---|---|---|---|

## Decisiones pendientes del usuario
- Ninguna.
