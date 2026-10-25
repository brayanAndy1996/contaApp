# Tareas 002 · Base de datos y RLS

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: andamiaje → pruebas (rojo) → implementación (verde) → CI → adversario (máx. 2 rondas, ~15 pruebas c/u) → verificación → revisión final → cierre. CA = `spec.md`; contratos y decisiones = `plan.md`.

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Rama y andamiaje de `packages/db` y `tests/aislamiento` | devops | haiku | — | — | — | [x] |
| T2 | `.env.example` a 8 variables y `.env` local | devops | haiku | T1 | — | — | [x] |
| T3 | Pruebas unitarias de `@contapp/db` (rojo) | tester | sonnet | T1 ∥ | ✓ | — | [x] |
| T4 | Suite de aislamiento CA-2 a CA-7 (rojo) | tester | sonnet | T1 ∥ | ✓ | — | [x] |
| T5 | Esquema, migraciones, roles, RLS, `migrar` y seed | backend | opus | T2, T4 | ✓ | — | [x] |
| T6 | `createDb`, `withTenant`, `withUsuario`, SCRAM | backend | opus | T3, T4 ∥ | ✓ | — | [x] |
| T7 | Job de CI `aislamiento` y `pnpm ci:db` en local | devops | haiku | T5, T6 | — | — | [x] |
| T8 | Ronda adversarial 1 | adversario | opus | T7 | — | ✓ | [x] |
| T9 | Corregir hallazgos de la ronda 1 | backend | opus | T8 | — | — | [ ] |
| T9c | Regla de lint contra SQL crudo fuera de `packages/db` | devops | sonnet | — | — | — | [ ] |
| T10 | Ronda adversarial 2 (solo si T8 tuvo fallos) | adversario | opus | T9 | — | ✓ | [ ] |
| T11 | Corregir hallazgos de la ronda 2 | backend | opus | T10 | — | — | [ ] |
| T12 | Verificar CA-1 a CA-9 con evidencia | tester | sonnet | T11 | — | — | [ ] |
| T13 | Revisión final contra la spec | arquitecto | opus | T12 | — | — | [ ] |
| T14 | Cierre: ESTADO, tasks y commit | devops | haiku | T13 | — | — | [ ] |

Escalamientos:
- T5 → tester: `ruc-repetido.spec.ts` "todo indice UNIQUE…" falla por la prueba: `array_agg(a.attname)` es `name[]` y `pg` lo devuelve como texto `"{tenant_id,ruc}"` (`.sort` no existe y `.includes` compara subcadenas). Arreglo: `array_agg(a.attname::text …)`.
- T5 (desvíos menores del plan, informados): `GRANT USAGE ON SCHEMA public` también a `contapp_app` (sin él la consulta da 42P01, no el `permission denied` de CA-2/CA-4) y a `contapp_migrator` (las FK se comprueban como dueño); `ALTER ROLE contapp_app SET lc_messages TO 'C'` (el clúster local responde en español y las pruebas esperan `permission denied`).

Reglas comunes:
- Un commit por tarea (Conventional Commits, `feat(002): …`, `test(002): …`), con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin remoto.
- Nunca imprimir, registrar ni commitear contraseñas ni URLs con contraseña (`.env`, `DATABASE_URL`, `MIGRATIONS_DATABASE_URL`). Para comprobar el `.env`, imprimir solo booleanos o nombres de variables.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o "OK" + conteo. Correr solo las pruebas del paquete afectado.
- El tester no toca código de producción; backend no edita `*.spec.ts` ni `*.adv.spec.ts` ajenos; adversario solo escribe `*.adv.spec.ts`.
- Escalar según 04 §3.3 y anotar aquí.

## T1 · Rama y andamiaje (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/002-db-rls/plan.md` (Archivos; Decisiones: Versiones, comandos raíz), `packages/shared/package.json`, `packages/shared/tsconfig.json`, `package.json`, `pnpm-workspace.yaml`, `turbo.json`.
- **Hacer**: (1) `git checkout -b spec/002-db-rls spec/001-fundaciones`; ESTADO 002 → `en curso`. (2) `packages/db` como `shared` (CJS, `dist/`), con `drizzle-orm`, `pg` y dev `drizzle-kit`, `@types/pg`, `vitest`, `@vitest/coverage-v8` en las versiones exactas del plan (`pnpm add -E`); scripts `build`, `typecheck`, `lint`, `test` (`vitest run`, sin BD), `db:migrate` y `db:seed` (`node --env-file-if-exists=../../.env dist/cli/<x>.js`), `db:generate`; `drizzle.config.ts` (dialect postgresql, `schema ./src/schema`, `out ./migrations`, sin `dbCredentials`: `generate` no se conecta); `src/index.ts` vacío exportable. (3) `tests/aislamiento` como paquete `@contapp/tests-aislamiento` (deps `@contapp/db: workspace:*`, `pg`, dev `vitest`), script `test:aislamiento` (no `test`, para que `pnpm test` no pida BD), `vitest.config.mts` que carga `../../.env` si existe con `process.loadEnvFile` y corre en un solo hilo; agregar `tests/*` a `pnpm-workspace.yaml`. (4) Scripts raíz `db:migrate`, `db:seed`, `test:aislamiento`, `ci:db` según el plan. Sin código de negocio.
- **Hecho cuando**: `git branch --show-current` = `spec/002-db-rls`; `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint` sin errores; `pnpm --filter @contapp/db test` sale 0 sin pruebas (`--passWithNoTests`). Commit `chore(002): andamiaje de packages/db y tests/aislamiento`.

## T2 · Variables de entorno (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/002-db-rls/plan.md` (Decisiones: Contraseña sin variable 9, `.env.example`), `.env.example`. No leer ni mostrar el contenido de `.env`.
- **Hacer**: (1) `.env.example`: `DATABASE_URL` y `MIGRATIONS_DATABASE_URL` exactamente como el plan; 8 líneas. (2) `.env` local con un script de Node que no imprime valores: renombrar la clave `DATABASE_URL` actual a `MIGRATIONS_DATABASE_URL` (mismo valor) y agregar `DATABASE_URL=postgresql://contapp_app:<hex de 24 bytes de crypto.randomBytes>@localhost:5432/contapp`.
- **Hecho cuando**: `.env.example` tiene 8 variables y ninguna contraseña; un script imprime solo `{ vars: 8, appUser: 'contapp_app', appTienePassword: true, migraTienePassword: <bool> }` del `.env`; `git status` no lista `.env`. Commit `chore(002): .env.example con DATABASE_URL del rol de app y MIGRATIONS_DATABASE_URL`.

## T3 · Pruebas unitarias de @contapp/db, rojo (tester · sonnet) ∥ T2
- **Contexto (leer solo esto)**: `docs/specs/002-db-rls/plan.md` (Contratos; Decisiones: Contraseña, `withTenant`), `docs/specs/002-db-rls/spec.md` (CA-6 y ataques sobre `app.tenant_id`).
- **Hacer**: `packages/db/src/*.spec.ts` sin BD: `scram.spec.ts` (verificador con vector fijo: misma contraseña + sal + 4096 iteraciones da el mismo verificador; formato `SCRAM-SHA-256$4096:…$…:…`; `verificaPassword(verificador, password)` true/false); `with-tenant.spec.ts` (`tenantId`/`userId` vacío, `null`, no-UUID o con `'; DROP …` lanzan `ContextoInvalidoError` sin abrir conexión y con mensaje que no contiene el valor; `rolApp` fuera de la lista lanza; anidado lanza `WithTenantAnidadoError`). Pool falso o inyectado para no tocar BD.
- **Hecho cuando**: `pnpm --filter @contapp/db test` falla por falta de implementación (no por errores de la prueba); lista de pruebas en el commit. Commit `test(002): pruebas unitarias de withTenant y scram (rojo)`.

## T4 · Suite de aislamiento, rojo (tester · sonnet) ∥ T3
- **Contexto (leer solo esto)**: `docs/specs/002-db-rls/spec.md` (Criterios CA-2 a CA-7), `docs/specs/002-db-rls/plan.md` (Contratos; Decisiones: Rol de login, Dueño y privilegios, P7, Seed).
- **Hacer**: en `tests/aislamiento/`, solo con `DATABASE_URL` y `@contapp/db` (`createDb`, `SEED`): `roles.spec.ts` (CA-2 con `pg_roles`, `pg_auth_members`, dueños en `pg_class`; `contapp_platform` con `permission denied` en `membresia` y `cliente`); `catalogo.spec.ts` (CA-3: toda tabla con `tenant_id` tiene `relrowsecurity`, `relforcerowsecurity`, política `tenant_isolation` y solo políticas de la lista permitida `{tenant_isolation, membresia_por_usuario}`; toda tabla de `public` es de `contapp_migrator`); `falla-cerrado.spec.ts` (CA-4, ambos roles y el rol de login); `aislamiento.spec.ts` (CA-5 simétrico, por ID y en lote, UPDATE/DELETE 0 filas, INSERT y cambio de `tenant_id` rechazados; cambios dentro de transacciones con rollback); `contexto.spec.ts` (CA-6 con `poolMax: 1` tras commit, rollback y excepción; 50 pares concurrentes A/B con `pg_sleep`); `ruc-repetido.spec.ts` (CA-7); `usuario.spec.ts` (P7: `withUsuario(uAB)` ve 2 membresías, `uA` ve 1, sin usuario 0; con tenant fijado no aplica).
- **Hecho cuando**: `pnpm test:aislamiento` falla por ausencia de esquema/implementación (no por errores de la prueba); `grep MIGRATIONS_DATABASE_URL tests/` vacío. Commit `test(002): suite de aislamiento entre estudios (rojo)`.

## T5 · Esquema, migraciones y seed (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/002-db-rls/plan.md` (todo), `docs/specs/002-db-rls/spec.md` (Alcance, CA-1, CA-2, CA-2b, CA-3, CA-7), `tests/aislamiento/{roles,catalogo,ruc-repetido}.spec.ts`, `packages/db/package.json`, `packages/db/drizzle.config.ts`.
- **Hacer**: `src/schema/*`; migraciones `0000_roles` (custom), `0001_esquema_base` (generada), `0002_rls_y_grants` (custom) según el plan; `src/cli/migrar.ts` (migraciones + sincronizar contraseña con `scram.ts` de T6; si aún no existe, usar su contrato) y `src/cli/seed.ts` + `src/seed/datos.ts`. No tocar `src/index.ts`, `client.ts` ni `with-tenant.ts` (T6).
- **Hecho cuando**: `pnpm db:migrate` dos veces seguidas sale 0 y la segunda no aplica nada; `pnpm --filter @contapp/db db:generate` dice que no hay cambios; `pnpm db:seed` dos veces sale 0; `psql` con `DATABASE_URL` entra como `contapp_app`; `roles`, `catalogo` y `ruc-repetido` en verde. Commit `feat(002): esquema base, roles, RLS y seed`.

## T6 · Acceso con contexto de tenant (backend · opus) ∥ T5
- **Contexto (leer solo esto)**: `docs/specs/002-db-rls/plan.md` (Contratos; Decisiones: `withTenant`, P7, Contraseña), `packages/db/src/*.spec.ts`, `tests/aislamiento/{falla-cerrado,aislamiento,contexto,usuario}.spec.ts`.
- **Hacer**: `src/errores.ts`, `src/scram.ts`, `src/client.ts` (`createDb`), `src/with-tenant.ts` (`withTenant`, `withUsuario`, detección de anidado con `AsyncLocalStorage`) y `src/index.ts` (exporta contratos, `schema` y `SEED`). Sin logs de contexto ni de URL. No tocar `schema/`, `migrations/` ni `cli/` (T5).
- **Hecho cuando**: `pnpm --filter @contapp/db test` en verde; con T5 terminado, `pnpm test:aislamiento` todo en verde; build, typecheck y lint OK. Commit `feat(002): createDb, withTenant y withUsuario`.

## T7 · CI y comando local (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/002-db-rls/plan.md` (Decisiones: CI; comandos raíz), `docs/specs/002-db-rls/spec.md` (CA-8), `.github/workflows/ci.yml`, `package.json`.
- **Hacer**: en `ci.yml`, job `aislamiento` según el plan (mismas acciones y versiones que el job `ci`; `postgres:17` con healthcheck `pg_isready`); `MIGRATIONS_DATABASE_URL` en `env` del job sin contraseña; paso que genera `DATABASE_URL` con `::add-mask::`. Sin `secrets.`.
- **Hecho cuando**: YAML válido (`prettier --check`); en local `pnpm ci:db` sale 0; forzando una prueba roja (cambio temporal, luego revertido) sale ≠ 0; `git grep -n "MIGRATIONS_DATABASE_URL"` solo en `packages/db/src/cli/`, `.env.example`, `ci.yml` y `docs/`. Commit `ci(002): job de aislamiento con PostgreSQL 17`.

## T8 · Ronda adversarial 1 (adversario · opus)
- **Contexto (leer solo esto)**: `docs/specs/002-db-rls/spec.md` (Criterios y "Ataques mínimos"), `docs/specs/002-db-rls/plan.md` (Contratos, Riesgos); después (caja blanca) `packages/db/src/`, `packages/db/migrations/`.
- **Hacer**: hasta ~15 pruebas en `tests/aislamiento/*.adv.spec.ts`, solo con `DATABASE_URL`, que cubran como mínimo la lista de ataques de la spec más los riesgos del plan (oráculo de PK/UNIQUE, `set_config` a mitad de transacción). Primero caja negra, luego caja blanca. No modificar producción.
- **Hecho cuando**: pruebas commiteadas; cada fallo anotado en "Hallazgos adversariales abiertos" de `ESTADO.md` (archivo de prueba + una línea). Commit `test(002): ronda adversarial 1`.
- **Resultado**: 16 pruebas en `tests/aislamiento/{oraculos,escalada,contexto}.adv.spec.ts`; 7 pasan (regresión: migrator/superusuario/RESET ROLE desde withTenant, DDL contra RLS y SECURITY DEFINER/vistas/TEMP/esquemas/extensiones, `row_security=off` y `session_replication_role`, catálogo sin SECURITY DEFINER, orden RLS vs. expresiones que lanzan error, tx filtrada tras su withTenant, `app.tenant_id` inválido o con inyección). 9 fallan (ataques que funcionan):
  - H1 · alta · `contexto.adv.spec.ts:67` — `set_config('app.tenant_id', B, false)` dentro de `withTenant(A)` sobrevive en la conexión del pool (no hay reset al liberar) y un `withUsuario(uA)` posterior ve los 3 clientes de B: `withUsuario` no fija `app.tenant_id` local a `''` (`with-tenant.ts` `ajusteUsuario`). Rompe CA-6.
  - H2 · alta · requiere usuario (D7) · `escalada.adv.spec.ts:90` — desde un rol de app, `SET LOCAL ROLE contapp_platform` funciona (la membresía `SET TRUE` es del rol de login, no del rol actual) y permite `UPDATE usuario` de cualquier estudio (p. ej. email de uB); igual worker → backend lee `usuario`. La separación backend/worker/platform no existe en la BD frente a inyección o código defectuoso.
  - H3 · media · requiere usuario (riesgo del plan) · `contexto.adv.spec.ts:47` — `set_config('app.tenant_id', B, true)` a mitad de `withTenant(A)` cambia de tenant y lee los clientes de B.
  - H4 · media · `oraculos.adv.spec.ts:53` — PK como oráculo: `INSERT` en A con el `id` de un cliente/membresía de B da `23505`; con un id libre, 1 fila.
  - H5 · media · `oraculos.adv.spec.ts:77` — `ON CONFLICT (id) DO NOTHING` devuelve 0 filas si el id existe en B (oráculo silencioso, sin error) y `DO UPDATE` da `42501` frente a éxito.
  - H6 · media · requiere usuario (diseño del plan) · `oraculos.adv.spec.ts:132` — dentro de `withTenant(A)`, backend lee todo `usuario` (incluye uB, solo de B, con email) y backend/worker todo `tenant`: tablas de plataforma sin RLS exponen otros estudios si el código olvida el filtro (HU-40).
  - H7 · media · `escalada.adv.spec.ts:167` — el rol de login puede `ALTER ROLE contapp_app SET role = 'contapp_platform'`, `SET row_security = off` y `PASSWORD NULL` (persistente para conexiones nuevas: arranque como platform o denegación de servicio). `SET app.tenant_id` sí es rechazado. Probado dentro de ROLLBACK.
  - H8 · baja · `contexto.adv.spec.ts:102` — `SET ROLE contapp_platform` (de sesión) dentro de `withTenant` persiste: la conexión vuelve al pool como `contapp_platform`, no `contapp_app` (misma causa que H1: sin reset al liberar).
  - H9 · baja · `oraculos.adv.spec.ts:99` — FK como oráculo: worker (sin SELECT en `usuario`) distingue usuarios existentes (1 fila) de inexistentes (`23503`) insertando en `membresia`.

## T9 · Corregir ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de 002 en `docs/specs/ESTADO.md`, los `*.adv.spec.ts` que fallan, los archivos de producción que señalan, `docs/specs/002-db-rls/plan.md` (Decisiones).
- **Hacer**: corregir con una migración nueva (nunca editar una migración ya aplicada) o en `src/`. Si un hallazgo pide cambiar la spec o aceptar un riesgo, no decidir: dejarlo `abierto · requiere usuario`.
- **Hecho cuando**: `pnpm ci:db` en verde con los `*.adv.spec.ts`, salvo los marcados para el usuario; hallazgos en `cerrado`. Commit `fix(002): hallazgos de la ronda adversarial 1`.
- **Avance (parte 1: H1, H7, H8)**:
  - H1 y H8 · cerrados en `src/with-tenant.ts`: `LIMPIAR_SESION` (`CLOSE ALL; RESET ROLE; RESET ALL; UNLISTEN *; SELECT pg_advisory_unlock_all()`) se envía junto con `BEGIN` y otra vez al liberar; si la limpieza falla, la conexión se destruye. `RESET ROLE` va aparte porque `RESET ALL` no incluye `role`. No se usa `DISCARD ALL` para no invalidar las sentencias preparadas con nombre que cachea `pg`. También cierra cursores `WITH HOLD` abiertos en un tenant y leídos desde otro. `withUsuario` no fija `app.tenant_id = ''` en el texto porque `with-tenant.spec.ts:252` exige que no aparezca `app.tenant_id`; el valor queda vacío gracias a la limpieza previa a `BEGIN`. Pasan `contexto.adv.spec.ts:67` y `:102`; 62 unitarias y 145 de aislamiento siguen en verde (154/161; fallan solo H2–H7 y H9).
  - H7 · `abierto · requiere usuario` (no se puede cerrar con SQL en PG 17.5; comprobado dentro de ROLLBACK): cualquier rol LOGIN puede cambiar su propia contraseña (`PASSWORD NULL` incluido) y sus valores por defecto de sesión (`ALTER ROLE self [IN DATABASE d] SET <USERSET>`). Los event triggers no admiten `ALTER ROLE` (0A000, objeto compartido). `REVOKE SET ON PARAMETER ... FROM PUBLIC` no tiene efecto en parámetros USERSET. No hay triggers sobre `pg_db_role_setting`. `passwordcheck` no ve `PASSWORD NULL`. Impacto real tras H1/H8: `role=contapp_platform` por defecto queda anulado dentro de withTenant por `SET LOCAL ROLE` (la escalada a platform ya es H2); `row_security=off` falla cerrado (42501); el resto (contraseña, `statement_timeout`, etc.) es denegación de servicio persistente. Mitigaciones posibles (decisión del usuario): (a) `migrar` repara en cada despliegue (`ALTER ROLE contapp_app RESET ALL` + `lc_messages`, igual que ya resincroniza la contraseña); (b) event trigger `ON login` (PG 17, lo crea el superusuario de migraciones) que rechaza la conexión si `pg_db_role_setting` de `contapp_app` no coincide con lo esperado (convierte la manipulación en falla cerrada, con riesgo de bloqueo; se desactiva con `event_triggers=off`); (c) alerta de monitoreo sobre `pg_db_role_setting`/`rolpassword`; (d) aceptar el riesgo residual de denegación de servicio.

## T10 · Ronda adversarial 2 (adversario · opus)
- **Contexto (leer solo esto)**: igual que T8 + diff de T9 (`git diff <commit T8>..HEAD -- packages/db`).
- **Hacer**: si T8 no tuvo fallos, marcar `[x]` con "omitida: ronda 1 sin fallos". Si no, hasta ~15 pruebas nuevas contra las correcciones y huecos restantes.
- **Hecho cuando**: igual que T8. Commit `test(002): ronda adversarial 2`.

## T11 · Corregir ronda 2 (backend · opus)
- **Contexto / Hacer / Hecho cuando**: igual que T9 con los hallazgos de T10; omitida si T10 no tuvo fallos. Commit `fix(002): hallazgos de la ronda adversarial 2`.

## T12 · Verificación (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/002-db-rls/spec.md` (Criterios), `docs/specs/002-db-rls/plan.md` (comandos raíz), `docs/specs/ESTADO.md` (hallazgos de 002).
- **Hacer**: evidencia por CA: CA-1 base vacía nueva (`createdb contapp_ca1` con el superusuario; migrar dos veces y comparar `pg_dump --schema-only` de ambas corridas; luego `dropdb`); CA-2 a CA-7 salida de `pnpm test:aislamiento`; CA-2b búsqueda de T7 y `.env.example`; CA-3 crear a mano una tabla `zz_sin_rls(tenant_id uuid)` como superusuario, ver `catalogo` en rojo y borrarla; CA-8 `pnpm ci:db` y la prueba roja de T7; CA-9 hallazgos cerrados o aceptados. Cobertura de `packages/db/src` ≥ 90 % (unitarias + suite).
- **Hecho cuando**: cada CA con comando y resultado en "Resultado" de esta tarea; ESTADO 002 → `verificada`. Commit `docs(002): verificación de CA con evidencia`.

## T13 · Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `docs/specs/002-db-rls/spec.md`, `docs/specs/002-db-rls/plan.md`, "Resultado" de T12, `packages/db/migrations/*.sql`, `packages/db/src/with-tenant.ts`.
- **Hacer**: contrastar cada CA con su evidencia y el DoD de nivel A (04 §5); listar faltantes y riesgos aceptados para informar al usuario.
- **Hecho cuando**: veredicto "aprobada" o lista de faltantes con tarea asignada. Sin commit si no cambia archivos.

## T14 · Cierre (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/ESTADO.md`, `docs/specs/002-db-rls/tasks.md`.
- **Hacer**: marcar `[x]` todas las tareas; ESTADO 002 → `hecha`, "Tarea actual" → `—`; anotar en 003 y 005 las herencias que sigan vigentes.
- **Hecho cuando**: `git status` limpio; `git log --oneline` muestra los commits de 002. Commit `chore(002): cierra spec 002`.
