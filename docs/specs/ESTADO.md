# Tablero de specs

Lo mantiene el **orquestador** (y lo cierra `devops` al terminar cada spec). Orden y roles: [04-metodologia.md §4](../04-metodologia.md).

Estados: `pendiente` · `borrador` · `aprobada` · `en curso` · `verificada` · `hecha` · `bloqueada`

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 001-fundaciones | D | hecha | — | Sin Docker (decisión del usuario). TypeScript 6.0.3. CI de GitHub sin ejecutar: el repo no tiene remoto. |
| 002-db-rls | A | hecha | — | Spec aprobada por el usuario (D1–D3, D5–D7). P7 resuelta en el plan. Rama `spec/002-db-rls` desde `spec/001-fundaciones`. |
| 003-cifrado | A | aprobada | T1 | Spec aprobada por el usuario ("todo recomendado": D1–D8; RNF-002 y 01 §5 corregidos, D4). Plan y tareas listos. Rama `spec/003-cifrado` desde `spec/002-db-rls` (002 sin mergear). Hereda de 002 (D3): permiso por columnas de `credencial` (CA-4c). |
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
| 003-cifrado | packages/crypto/src/ronda1b.adv.spec.ts | F1 (alta): la rotación acepta el proveedor `mock` como llave activa; con `KEY_PROVIDER=mock` (por defecto) `kek:rotar` re-envuelve DEKs reales con la KEK del fixture, cuya privada está en el repo (causa `packages/crypto/src/descifrado/reenvolver.ts:27` y `apps/worker/src/cli/kek-rotar.ts:101`) | corregido (1e11e8d) |
| 003-cifrado | apps/worker/src/ronda1b.adv.spec.ts | F2 (media, decide usuario): una sola `dek_envuelta` alterada (`IntegridadError`) aborta la rotación de todo el estudio en cada corrida; la KEK retirada nunca se puede jubilar (causa `apps/worker/src/credenciales/rotar-kek.ts:89`) | corregido (636410b; opción A elegida por el usuario: la rotación continúa, reporta corruptas por id, CLI sale con código 3; límite conocido: si solo quedan filas corruptas en una corrida posterior no se distingue de una KEK anterior equivocada y sale con 1; pendiente de que el usuario lo acepte como límite) |
| 003-cifrado | T14b (archivo no indicado) | F3 (baja): el CAS de `reemplazarDekEnvuelta` compara `dek_envuelta` pero no `kek_id = desde` (causa `packages/db/src/credenciales/repositorio.ts:81`) | corregido (1e11e8d) |
| 003-cifrado | T14b (archivo no indicado) | F4 (baja): el lint no detecta el import de `@contapp/crypto/descifrado` desde `apps/backend` con `require` o `import()` con plantilla, `createRequire` o `module.require` (causa `eslint.config.mjs:137-145`) | corregido (27f831d) |
| 003-cifrado | T14b (archivo no indicado) | F5 (baja): la guarda del RNG solo compara con el cifrado anterior; un RNG A, B, A repite DEK y nonce (causa `packages/crypto/src/comun/aleatorio.ts:29-32`) | corregido (1e11e8d) |
| 003-cifrado | T14b (archivo no indicado) | F6 (baja): si el logger falla tras el COMMIT, el `Secreto` ni se entrega ni se destruye (causa `apps/worker/src/credenciales/descifrar-credencial.ts:149-151`) | corregido (1e11e8d) |
| 003-cifrado | packages/crypto/src/ronda2a.adv.spec.ts:16 | R2a-1 (baja): la guarda del RNG solo recuerda las últimas 4096 huellas; un RNG de período 4097 repite (DEK, nonce) sin detectarlo (causa `packages/crypto/src/comun/aleatorio.ts:15` y `:64-67`) | abierto |
| 003-cifrado | packages/crypto/src/ronda2a.adv.spec.ts:58 | R2a-2 (baja): el lint de `apps/backend` no reporta 10 vías de cargar `@contapp/crypto/descifrado` (alias de `require`, `require.call`, `eval`, `new Function`, `(0, require)`, `module` desestructurado o aliasado, `module.constructor._load`, `require("module")._load`, `globalThis.process.mainModule`); mitigado: el backend no tiene la privada en `local` (causa `eslint.config.mjs:163-176`) | abierto |
| 003-cifrado | apps/worker/src/ronda2a.adv.int.spec.ts:94 | R2a-3 (baja): sin `kekAnterior`, el CAS de `reemplazarDekEnvuelta` no compara `kek_id` y pisa una re-etiquetación del backend (causa `packages/db/src/credenciales/repositorio.ts:83` y `:191`); la rotación siempre lo pasa, pero `tests/aislamiento/credencial.spec.ts` no | abierto |
| 003-cifrado | apps/worker/src/ronda2a.adv.int.spec.ts:116 | R2a-4 (baja): con un logger de rechazo asíncrono tras el COMMIT, el `Secreto` se entrega y el rechazo queda sin manejar; el síncrono sí se destruye y relanza (causa `apps/worker/src/credenciales/descifrar-credencial.ts:151-157`) | abierto |

## Decisiones pendientes del usuario
- [003] ¿aceptar el límite de F2 (código 1 vs 3 en corridas posteriores con solo filas corruptas)?

## Notas para specs futuras

No son decisiones tomadas ni pendientes del usuario: cada spec las resuelve al planificarse.

- [007] Decidir si la regla de lint relaja el veto a la plantilla `sql` de drizzle (manteniendo prohibidos `.raw` y `set_config`) o si se usan ayudantes/repositorios en `packages/db`. El veto actual solo mira `ImportSpecifier`, así que `import * as d` lo evita (O4 de T13).
- [004/008] El contexto anidado de `withTenant` alcanza a las tareas asíncronas lanzadas dentro de `fn`; si luego llaman a `withTenant`, fallan cerrado (`WithTenantAnidadoError`).
- [infra] Restringir con `pg_hba` que `contapp_app` no entre a otras bases del clúster (hoy `postgres` conserva `CONNECT` y `TEMP` para PUBLIC).
- [005] Heredar la prueba "por API" de HU-40 (D2).
- [003] Heredar el permiso por columnas de `credencial` (D3).
- [008] El job `kek.rotar` necesita la lista de estudios: el rol worker no ve otros tenants (D9 de 002). 003 entrega la rotación por estudio (`--tenant`); 008 decide cómo enumerarlos sin `BYPASSRLS` en el login.
- [007] Agregar la FK `credencial(tenant_id, cliente_id) → cliente(tenant_id, id)` y las columnas de estado (RF-034/035) con sus grants por columna; el backend guarda con el repositorio de 003 (`ON CONFLICT … DO UPDATE` con parámetros, nunca con `EXCLUDED`).
