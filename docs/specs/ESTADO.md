# Tablero de specs

Lo mantiene el **orquestador** (y lo cierra `devops` al terminar cada spec). Orden y roles: [04-metodologia.md §4](../04-metodologia.md).

Estados: `pendiente` · `borrador` · `aprobada` · `en curso` · `verificada` · `hecha` · `bloqueada`

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 001-fundaciones | D | hecha | — | Sin Docker (decisión del usuario). TypeScript 6.0.3. CI de GitHub sin ejecutar: el repo no tiene remoto. |
| 002-db-rls | A | hecha | — | Spec aprobada por el usuario (D1–D3, D5–D7). P7 resuelta en el plan. Rama `spec/002-db-rls` desde `spec/001-fundaciones`. |
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
| 002-db-rls | escalada.adv.spec.ts:90 | H2 (alta, decide usuario): desde backend se pasa a `contapp_platform` con `SET LOCAL ROLE` y se modifican usuarios de cualquier estudio; worker puede pasar a backend | corregido (28375cb) |
| 002-db-rls | contexto.adv.spec.ts:47 | H3 (media, decide usuario): `set_config` a mitad de transacción cambia de estudio | aceptado por el usuario |
| 002-db-rls | oraculos.adv.spec.ts:53 | H4 (media): la PK revela si un ID existe en otro estudio (`23505`) | aceptado por el usuario |
| 002-db-rls | oraculos.adv.spec.ts:77 | H5 (media): `ON CONFLICT DO NOTHING` revela si un ID existe en otro estudio | aceptado por el usuario |
| 002-db-rls | oraculos.adv.spec.ts:132 | H6 (media, decide usuario): dentro de `withTenant(A)` se leen todos los usuarios (email) y tenant de otros estudios | corregido (28375cb) |
| 002-db-rls | escalada.adv.spec.ts:167 | H7 (media): el rol de login puede cambiar su propia configuración persistente (rol inicial, `row_security=off`, `PASSWORD NULL`) | corregido/mitigado, límite aceptado por el usuario (D11) |
| 002-db-rls | contexto.adv.spec.ts:102 | H8 (baja): `SET ROLE` dentro de `withTenant` devuelve la conexión al pool con otro rol (misma causa que H1) | corregido (120db97) |
| 002-db-rls | oraculos.adv.spec.ts:99 | H9 (baja): el worker averigua si un usuario existe por el error de FK (`23503`) | aceptado por el usuario |
| 002-db-rls | ronda2.adv.spec.ts:284 | H10 (media): los objetos grandes (`lo_from_bytea`/`lo_get`) permiten leer datos de A desde `withTenant(B)`: almacén fuera de RLS | corregido (1ab1976) |
| 002-db-rls | ronda2.adv.spec.ts:206 | H11 (baja): la limpieza no hace `DEALLOCATE` (causa `packages/db/src/with-tenant.ts:99-100`); un `PREPARE` dentro de un `DO` lleva ids de A a `withTenant(B)` | corregido (1ab1976) |
| 002-db-rls | ronda2.adv.spec.ts:266 | H12 (baja): si la conexión vuelve al pool con transacción abierta, `BEGIN` solo avisa y `fn` corre dentro de esa transacción ajena (causa `packages/db/src/with-tenant.ts:145-146`) | corregido (1ab1976) |
| 002-db-rls | ronda2.adv.spec.ts:119 | H13 (baja): `withTenant({A, userId: uB})` ve a `uB` sin ser miembro de A; contradice D9 (causa `packages/db/migrations/0003_rls_plataforma_y_roles.sql:33`) | corregido (1ab1976) |

## Decisiones pendientes del usuario
(ninguna)

## Notas para specs futuras

No son decisiones tomadas ni pendientes del usuario: cada spec las resuelve al planificarse.

- [007] Decidir si la regla de lint relaja el veto a la plantilla `sql` de drizzle (manteniendo prohibidos `.raw` y `set_config`) o si se usan ayudantes/repositorios en `packages/db`. El veto actual solo mira `ImportSpecifier`, así que `import * as d` lo evita (O4 de T13).
- [004/008] El contexto anidado de `withTenant` alcanza a las tareas asíncronas lanzadas dentro de `fn`; si luego llaman a `withTenant`, fallan cerrado (`WithTenantAnidadoError`).
- [infra] Restringir con `pg_hba` que `contapp_app` no entre a otras bases del clúster (hoy `postgres` conserva `CONNECT` y `TEMP` para PUBLIC).
- [005] Heredar la prueba "por API" de HU-40 (D2).
- [003] Heredar el permiso por columnas de `credencial` (D3).
