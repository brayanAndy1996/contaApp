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
| 002-db-rls | contexto.adv.spec.ts:67 | H1 (alta): `set_config(...,false)` dentro de `withTenant` persiste en la conexión del pool y `withUsuario` ve datos de otro estudio | corregido (120db97) |
| 002-db-rls | escalada.adv.spec.ts:90 | H2 (alta, decide usuario): desde backend se pasa a `contapp_platform` con `SET LOCAL ROLE` y se modifican usuarios de cualquier estudio; worker puede pasar a backend | en corrección |
| 002-db-rls | contexto.adv.spec.ts:47 | H3 (media, decide usuario): `set_config` a mitad de transacción cambia de estudio | aceptado por el usuario |
| 002-db-rls | oraculos.adv.spec.ts:53 | H4 (media): la PK revela si un ID existe en otro estudio (`23505`) | aceptado por el usuario |
| 002-db-rls | oraculos.adv.spec.ts:77 | H5 (media): `ON CONFLICT DO NOTHING` revela si un ID existe en otro estudio | aceptado por el usuario |
| 002-db-rls | oraculos.adv.spec.ts:132 | H6 (media, decide usuario): dentro de `withTenant(A)` se leen todos los usuarios (email) y tenant de otros estudios | en corrección |
| 002-db-rls | escalada.adv.spec.ts:167 | H7 (media): el rol de login puede cambiar su propia configuración persistente (rol inicial, `row_security=off`, `PASSWORD NULL`) | en corrección |
| 002-db-rls | contexto.adv.spec.ts:102 | H8 (baja): `SET ROLE` dentro de `withTenant` devuelve la conexión al pool con otro rol (misma causa que H1) | corregido (120db97) |
| 002-db-rls | oraculos.adv.spec.ts:99 | H9 (baja): el worker averigua si un usuario existe por el error de FK (`23503`) | aceptado por el usuario |

## Decisiones pendientes del usuario
(ninguna)
