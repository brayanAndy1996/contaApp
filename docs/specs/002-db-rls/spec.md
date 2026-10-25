# Spec 002 · Base de datos y RLS

Estado: aprobada
Nivel de riesgo: A — sí a (2) un fallo expone datos y credenciales de otro estudio; sí a (3) una fuga entre tenants no se nota a simple vista; sí a (4) pool de conexiones y transacciones concurrentes. (1) no aplica.
Cubre: RNF-001, RNF-082 · HU-40

## Objetivo
Garantizar en la base de datos que ningún estudio ve ni modifica datos de otro aunque el código olvide el filtro (RLS como red de seguridad, 01 §2 y 03 §4). Entrega a las specs siguientes `packages/db` con migraciones versionadas, roles PG, `withTenant()` y una prueba de aislamiento que bloquea el CI.

## Alcance
- `packages/db` (`@contapp/db`) con Drizzle (ADR-04) y migraciones versionadas en `packages/db/migrations`; las políticas RLS, roles y grants viven en las migraciones (RNF-082).
- Esquema mínimo para probar el aislamiento (D1): estudios, usuarios, membresías y una tabla de negocio de ejemplo, con `tenant_id` en toda tabla de negocio, PK `uuid` v7 y las convenciones de 03 §8. Cada spec posterior crea sus tablas con su propia migración y CA-3 las cubre.
- Roles `contapp_migrator`, `contapp_backend`, `contapp_worker` y `contapp_platform` según 03 §4.3, más un rol de login de la app (D7) sin `SUPERUSER`, `BYPASSRLS`, `CREATEROLE` ni `CREATEDB`, sin grants directos sobre tablas de negocio y con membresía `INHERIT FALSE, SET TRUE` solo en `contapp_backend`, `contapp_worker` y `contapp_platform`.
- Dos conexiones (D7): `DATABASE_URL` (rol de login de la app; la usan backend, worker y la suite de aislamiento) y `MIGRATIONS_DATABASE_URL` (superusuario local; solo la usan el comando de migraciones y el seed). `.env.example` pasa de 7 a 8 variables: la tarea de 002 agrega `MIGRATIONS_DATABASE_URL` y ajusta `DATABASE_URL` al rol de la app, ambas sin contraseña; esto reemplaza el "exactamente 7" de 001 CA-8. La contraseña del rol de login se genera o lee del `.env` local y nunca va en la spec, el plan, las migraciones versionadas, los logs ni el repo.
- RLS `ENABLE` + `FORCE` y política `tenant_isolation` (`USING` y `WITH CHECK` sobre `app.tenant_id`) en cada tabla de negocio.
- `withTenant(ctx, tx => …)`: transacción + `SET ROLE` del rol de login al rol de la app (D7) + `set_config('app.tenant_id'|'app.user_id', $n, true)` (03 §4.1).
- Seed mínimo de 2 estudios con datos en cada tabla de negocio (03 §10).
- Suite de aislamiento en `tests/aislamiento/` (03 §11) y job de CI con servicio PostgreSQL que la corre (decisión 3 de 001).

## Fuera de alcance
- Visibilidad por cliente asignado dentro del estudio (`ClientScopeGuard`) → 005.
- Cifrado de credenciales, `KeyProvider` y permiso por columnas de `credencial` (backend no lee el cifrado, 03 §4.3) → 003 (D3).
- Sesiones, login y endpoints HTTP → 004/005. La prueba "por API" de HU-40 la hereda 005 (D2); 002 prueba el aislamiento solo a nivel de base de datos.

## Criterios de aceptación
- [x] CA-1 (migraciones): Dado un PostgreSQL vacío, cuando se corren las migraciones con `MIGRATIONS_DATABASE_URL` (superusuario local, D7), entonces se crea todo el esquema con roles, grants y políticas; correrlas otra vez no cambia nada ni falla.
- [x] CA-2 (roles): `contapp_backend` y `contapp_worker` no son dueños de tablas ni tienen `BYPASSRLS`/`SUPERUSER`; `contapp_platform` tiene `BYPASSRLS` y recibe `permission denied` en toda tabla de negocio. El rol de login de `DATABASE_URL` tiene `rolsuper`, `rolbypassrls`, `rolcreaterole` y `rolcreatedb` en false, no es dueño de ningún objeto y sus membresías son `INHERIT FALSE` (verificado con `pg_roles`, `pg_auth_members` y consultas reales).
- [x] CA-2b (conexiones, D7): Solo el comando de migraciones/seed lee `MIGRATIONS_DATABASE_URL` (verificado con búsqueda en el código); backend, worker y la suite se conectan con `DATABASE_URL`, y `.env.example` contiene las 8 variables sin contraseñas.
- [x] CA-3 (catálogo): Una prueba recorre `pg_catalog` y falla si alguna tabla con columna `tenant_id` no tiene `relrowsecurity` y `relforcerowsecurity` en true y la política `tenant_isolation`. Agregar una tabla nueva sin RLS rompe la prueba.
- [x] CA-4 (falla cerrado): Con `contapp_backend` o `contapp_worker` y sin `withTenant`, un `SELECT` sobre cada tabla de negocio devuelve 0 filas y un `INSERT` es rechazado. Con el rol de login de `DATABASE_URL` sin `SET ROLE`, toda consulta a tablas de negocio recibe `permission denied`.
- [x] CA-5 (aislamiento, HU-40): Dados los estudios A y B con datos en cada tabla de negocio, dentro de `withTenant(A)` y para ambos roles: leer filas de B por ID o en lote devuelve 0; `UPDATE`/`DELETE` sobre filas de B afectan 0 filas; `INSERT` con `tenant_id = B` y `UPDATE` que cambia `tenant_id` a B son rechazados por `WITH CHECK`. La prueba es simétrica (B contra A).
- [x] CA-6 (contexto no se filtra): Tras `commit`, `rollback` o una excepción dentro de `withTenant(A)`, la misma conexión del pool queda sin `app.tenant_id`; dos `withTenant` concurrentes (A y B) nunca ven datos cruzados.
- [x] CA-7 (mismo RUC en dos estudios, 01 §2): las restricciones `UNIQUE` de negocio incluyen `tenant_id`; insertar en B un valor ya usado en A no falla ni revela su existencia.
- [x] CA-8 (CI): `.github/workflows/ci.yml` tiene un job con servicio PostgreSQL que corre migraciones y la suite de aislamiento; si una prueba falla, el build falla. En local, el mismo comando corre contra `MIGRATIONS_DATABASE_URL` (migraciones/seed) y `DATABASE_URL` (suite) en localhost; el CI define ambas sin secretos reales. Mientras el repo no tenga remoto, CA-8 se verifica en local con esos comandos (D6).
- [x] CA-9 (adversario): `adversario` ejecuta hasta 2 rondas (04 §2.3) con al menos los ataques de la lista siguiente; todo hallazgo queda corregido o aceptado por el usuario, y las pruebas `*.adv.spec.ts` quedan como regresión.
- [ ] Casos reales aplicables: ninguno (sin montos ni clasificación).

**Cobertura (DoD nivel A, 04 §5), qué se mide:** módulo = `packages/db/src/**/*.ts` (incluye `cli/`, `schema/` y `seed/`); solo se excluyen los archivos de prueba (`*.spec.ts`, `*.adv.spec.ts`, `*.int.spec.ts`). Medido con `pnpm cobertura:db` (v8): unitarias + integración de `cli/` + suite de aislamiento importando `@contapp/db` desde la fuente. Umbral global ≥ 90 % en líneas, sentencias, funciones y ramas; el comando falla por debajo. Lo que solo se ejerce desde `dist` (p. ej. en `ci:db`) no cuenta.

**Ataques mínimos del adversario:** transacción sin `set_config`; `set_config` de otro tenant; `set_config` con `is_local = false` que sobrevive en el pool; `app.tenant_id` vacío, `NULL`, no-UUID o con inyección SQL (debe fallar cerrado y sin revelar datos en el error); lotes que mezclan IDs de A y B; `withTenant` anidado o cambio de tenant a mitad de la transacción; claves foráneas hacia filas de otro tenant (la FK ignora RLS y puede revelar existencia); errores de `UNIQUE` como oráculo de existencia; `SET ROLE`, `ALTER TABLE … DISABLE/NO FORCE ROW LEVEL SECURITY` o `ALTER POLICY` desde los roles de app; vistas o funciones `SECURITY DEFINER` que esquiven RLS; `contapp_platform` leyendo tablas de negocio; escalar desde la conexión de `DATABASE_URL` (D7): `RESET ROLE` tras `SET ROLE contapp_backend` solo vuelve al rol de login (sin acceso a tablas de negocio), y `SET ROLE`/`SET SESSION AUTHORIZATION` hacia el superusuario o `contapp_migrator` fallan con `permission denied`.

## Dependencias
- Specs: 001 (hecha).
- Externas: PostgreSQL 17 local (sin Docker, decisión 1 de 001), puerto 5432, base `contapp` ya creada; el `.env` local ya tiene la conexión del superusuario (pasa a `MIGRATIONS_DATABASE_URL`) y la tarea agrega la del rol de login en `DATABASE_URL`. En GitHub Actions, servicio `postgres` en el workflow.

## Decisiones del usuario
- D1 (ex P1): 002 crea solo las tablas mínimas para probar el aislamiento (estudios, usuarios, membresías y una tabla de negocio de ejemplo); cada spec posterior crea las suyas.
- D2 (ex P2): 002 prueba el aislamiento solo a nivel de base de datos. La prueba "por API" de HU-40 pasa a 005 como criterio heredado (anotado en `ESTADO.md`).
- D3 (ex P3): el permiso por columnas de `credencial` (backend no lee el cifrado) queda en 003 (anotado en `ESTADO.md`).
- ~~D4 (ex P4): una sola `DATABASE_URL` del superusuario.~~ Reemplazada por D7.
- D5 (ex P5): PostgreSQL local 17.5 (`psql`); instancia confirmada: PG 17, puerto 5432, base `contapp` existente; el CI usa 17. El usuario de conexión para migraciones es el superusuario local (vía `MIGRATIONS_DATABASE_URL`, D7); los roles de la app se crean en las migraciones. La spec, el plan y el código no contienen contraseñas.
- D6 (ex P6): el CI se verifica en local (sin remoto), como en 001.
- D7 (reemplaza D4): dos variables. `DATABASE_URL` conecta con un rol de login de la app sin superusuario ni `BYPASSRLS`, que solo puede hacer `SET ROLE` hacia roles de menor privilegio y no puede volver al superusuario con `RESET ROLE`; `MIGRATIONS_DATABASE_URL` conecta como superusuario local y solo la usa el comando de migraciones/seed. `.env.example` queda con 8 variables. Las contraseñas de los roles de la app nunca van en la spec ni en el repo: se generan o leen del `.env` local.
- D8 (H2 de la ronda adversarial 1, opción A): `contapp_platform` queda fuera del alcance del login de la app; se acepta que el worker pase a `contapp_backend`.
- D9 (H6 de la ronda adversarial 1): corregir. Dentro de `withTenant(A)` solo se ven los usuarios con membresía en A y el tenant A, no los de otros estudios.
- D10 (H7 de la ronda adversarial 1, opción A): `migrar` repara en cada ejecución la configuración del rol `contapp_app` (`ALTER ROLE … RESET ALL` y `lc_messages`, opción (a) de T9).

## Riesgos aceptados
Aceptados por el usuario en la ronda adversarial 1 (estado en `ESTADO.md`):
- H3 (media): un `set_config` a mitad de `withTenant(A)` puede cambiar de estudio. Compensación: consultas parametrizadas y regla de lint contra SQL crudo fuera de `packages/db` (T9c en `tasks.md`).
- H4 (media), H5 (media) y H9 (baja): oráculos de existencia por ID (PK `23505`, `ON CONFLICT (id)` y FK `23503`). Motivo: IDs UUID aleatorios, así que el oráculo exige conocer un ID de otro estudio; UNIQUE de RUC compuesto por estudio (CA-7).

Decisión del usuario aceptada (D11), ronda adversarial 2: límites residuales de H7, H10 y H11.
- H7 (media, mitigada): hasta el siguiente `migrar` cabe una denegación de servicio por alteración del rol de login (contraseña o ajustes persistentes de `contapp_app`); no expone datos. PostgreSQL 17 no lo impide desde SQL; `migrar` repara la configuración en cada ejecución (D10).
- H10 (media, corregida en `0004`): `pg_largeobject_metadata` sigue legible; solo expone OID y dueño.
- H11 (baja, corregida): el arreglo depende de la caché interna `parsedStatements` de `pg` (con guarda; `pg` fijado en 8.23.1). Si esa caché cambia, el efecto es un error, no una fuga.

## Preguntas abiertas
- P7 (diseño, se informa): con RLS en `membresia`, listar los estudios de un usuario antes de que elija uno (01 §2) necesita un camino acotado (función restringida o política por `app.user_id`). Resuelto en `plan.md` (política `membresia_por_usuario` + `withUsuario`), sin cambio de alcance.
- Riesgo cerrado: la app conectada como superusuario (podía saltarse RLS con `RESET ROLE`), señalado como decisión previa al plan, queda resuelto por D7.
