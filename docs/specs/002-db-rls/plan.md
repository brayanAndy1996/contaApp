# Plan 002 · Base de datos y RLS

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/db/` (`package.json`, `tsconfig.json`, `drizzle.config.ts`, `vitest.config.mts`) | paquete `@contapp/db`, CJS a `dist/` como `shared` |
| crear | `packages/db/src/schema/{plataforma,acceso,clientes,index}.ts` | tablas Drizzle (sin políticas) |
| crear | `packages/db/migrations/` (`0000_roles`, `0001_esquema_base`, `0002_rls_y_grants` + `meta/`) | roles, tablas, RLS y grants versionados (RNF-082) |
| crear | `packages/db/src/{client,with-tenant,scram,errores,index}.ts` | `createDb`, `withTenant`, `withUsuario`, verificador SCRAM |
| crear | `packages/db/src/cli/{migrar,seed}.ts` · `packages/db/src/seed/datos.ts` | únicos lectores de `MIGRATIONS_DATABASE_URL`; IDs fijos del seed |
| crear | `tests/aislamiento/` (`package.json` `@contapp/tests-aislamiento`, `vitest.config.mts`, `*.spec.ts`) | suite de aislamiento (03 §11) |
| modificar | `pnpm-workspace.yaml` (+`tests/*`), `package.json` raíz, `.env.example`, `.github/workflows/ci.yml` | workspace, scripts, 8 variables, job `aislamiento` |
| local (no repo) | `.env` | `MIGRATIONS_DATABASE_URL` (superusuario, valor actual) + `DATABASE_URL` del rol de login |

## Contratos
```ts
// @contapp/db
export type RolApp = 'contapp_backend' | 'contapp_worker';
export interface ContextoTenant { tenantId: string; userId?: string }   // UUID; se valida antes de abrir la transacción
export function createDb(o: { rolApp: RolApp; url?: string /* por defecto process.env.DATABASE_URL */; poolMax?: number }): ContappDb;
export interface ContappDb {
  withTenant<T>(ctx: ContextoTenant, fn: (tx: Tx) => Promise<T>): Promise<T>;   // BEGIN; SET LOCAL ROLE <rolApp>; set_config(..., true) x2
  withUsuario<T>(ctx: { userId: string }, fn: (tx: Tx) => Promise<T>): Promise<T>; // P7: solo app.user_id; app.tenant_id sin fijar
  pool: Pool;  // solo para pruebas (CA-6)
  close(): Promise<void>;
}
export class ContextoInvalidoError extends Error {}   // mensaje fijo, sin el valor recibido
export class WithTenantAnidadoError extends Error {}  // withTenant/withUsuario dentro de otro (AsyncLocalStorage)
export * as schema from './schema'; export { SEED } from './seed/datos';
```
Tablas (PK `id uuid DEFAULT uuid_v7()`, `created_at`/`updated_at timestamptz DEFAULT now()`):
- Plataforma, sin `tenant_id` (03 §8): `tenant(nombre)`, `usuario(email UNIQUE, nombre)`. Ambas con RLS `ENABLE` + `FORCE` y solo `tenant_isolation FOR SELECT` (sin políticas de escritura; `0003`, y `usuario` recreada en `0004` por H13). `tenant`: dentro de `withTenant`, el estudio actual; sin tenant (`withUsuario`), los estudios con membresía de `app.user_id` (la subconsulta respeta `membresia_por_usuario`). `usuario`: dentro de `withTenant`, solo los miembros del estudio actual; sin tenant, solo la propia fila (`app.user_id`). `contapp_platform` (BYPASSRLS) no se ve afectado.
- Negocio, con RLS: `membresia(tenant_id→tenant, usuario_id→usuario, rol text, UNIQUE(tenant_id, usuario_id))`; `cliente(tenant_id→tenant, ruc char(11) CHECK 11 dígitos, razon_social, UNIQUE(tenant_id, ruc), UNIQUE(tenant_id, id))` — tabla de negocio de ejemplo (D1); 007 la amplía con su migración.
- `tenant_id uuid NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid`.
- Política: `tenant_isolation FOR ALL USING/WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`. Solo en `membresia`, además: `membresia_por_usuario FOR SELECT USING (nullif(current_setting('app.tenant_id', true), '') IS NULL AND usuario_id = nullif(current_setting('app.user_id', true), '')::uuid)`.

Comandos raíz: `pnpm db:migrate` · `pnpm db:seed` (ambos con `MIGRATIONS_DATABASE_URL`) · `pnpm test:aislamiento` (solo `DATABASE_URL`) · `pnpm ci:db` = migrate, migrate otra vez, seed, suite (mismo comando en local y CI). Los scripts del paquete cargan el `.env` con `node --env-file-if-exists=../../.env`.

## Decisiones
- **Versiones** (npm, 2026-10-24, exactas con `-E`): `drizzle-orm` 0.45.4 (última estable; la 1.0 sigue en rc), `drizzle-kit` 0.31.11, `pg` 8.23.1, `@types/pg` 8.23.1, `vitest` y `@vitest/coverage-v8` 5.0.5. Sin `dotenv` ni `tsx`: Node 24 trae `--env-file-if-exists`; los CLI se compilan a `dist/cli`.
- **Rol de login: `contapp_app`** (`LOGIN NOINHERIT`, sin SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB). `GRANT contapp_backend, contapp_worker TO contapp_app WITH INHERIT FALSE, SET TRUE` (PG ≥16). Sin membresía en `contapp_platform`: `0000` la concede y `0003` la revoca (D8: el login solo pasa por `SET ROLE` a `contapp_backend` y `contapp_worker`). `contapp_migrator`, `contapp_backend`, `contapp_worker` NOLOGIN; `contapp_platform` NOLOGIN BYPASSRLS. Creación idempotente con `DO $$ … IF NOT EXISTS (pg_roles) … $$` (los roles son del clúster, CA-1).
- **Contraseña sin variable 9**: la contraseña vive solo dentro de `DATABASE_URL` del `.env` local. La migración crea el rol sin contraseña; `migrar.ts`, tras las migraciones y con la conexión de `MIGRATIONS_DATABASE_URL`, lee usuario y contraseña de `new URL(DATABASE_URL)` (usuario debe ser `contapp_app`), calcula en el cliente el verificador `SCRAM-SHA-256$4096:<sal>$<StoredKey>:<ServerKey>` (`node:crypto`, `scram.ts`) y ejecuta `ALTER ROLE contapp_app PASSWORD '<verificador>'`: la contraseña en claro no llega al servidor ni a sus logs. Si `pg_authid.rolpassword` ya corresponde a esa contraseña, no hace nada (idempotente). Sin contraseña en `DATABASE_URL` → error con mensaje fijo, sin valores. En el `.env` local, T2 la genera (24 bytes aleatorios en hex) sin imprimirla.
- **`.env.example` (8 variables)**: `DATABASE_URL=postgresql://contapp_app@localhost:5432/contapp` y `MIGRATIONS_DATABASE_URL=postgresql://postgres@localhost:5432/contapp`, sin contraseñas; las otras 6 sin cambios.
- **Dueño y privilegios**: las migraciones corren como superusuario; `0002` hace `ALTER TABLE … OWNER TO contapp_migrator` en cada tabla. `REVOKE ALL ON DATABASE <actual> FROM PUBLIC` (quita TEMP) y `GRANT CONNECT` a `contapp_app`; `REVOKE ALL ON SCHEMA public FROM PUBLIC` y `USAGE` en `public` para backend, worker y platform, y además para `contapp_app` (sin `CREATE` ni privilegios sobre tablas; sin `USAGE` daría `42P01` en vez de `permission denied`) y `contapp_migrator` (las FK se comprueban como dueño). Grants: backend y worker `SELECT, INSERT, UPDATE, DELETE` en `membresia` y `cliente`; backend `SELECT` en `tenant` y `usuario`; worker `SELECT` en `tenant`; platform `SELECT, INSERT, UPDATE` en `tenant` y `usuario` y nada en negocio. `contapp_app` sin grants sobre tablas. Migraciones `0003` y `0004`: RLS de solo lectura en `tenant` y `usuario` (línea 32) y `EXECUTE` de las funciones `lo_*` revocado a PUBLIC (`0004`, H10).
- **Migraciones**: Drizzle Kit genera `0001` desde el esquema; `0000` y `0002` son `drizzle-kit generate --custom`. Políticas, roles y FORCE fuera del esquema Drizzle (Kit no maneja FORCE). El journal de `drizzle-orm/node-postgres/migrator` da la idempotencia. `uuid_v7()` es una función SQL (`SECURITY INVOKER`) en `0000`; PG 17 no trae `uuidv7()`.
- **`withTenant`**: `SET LOCAL ROLE` con el rol de `createDb` (lista cerrada, nunca interpolado desde la entrada) y `set_config` con parámetros; al terminar la transacción la conexión vuelve a `contapp_app` sin contexto. `nullif(…, '')` evita el error de cast cuando la conexión del pool ya tuvo el GUC (devuelve `''`, no NULL) y deja el fallo en 0 filas (CA-4).
- **P7**: `withUsuario` + `membresia_por_usuario` (solo SELECT y solo sin tenant fijado). Sin funciones `SECURITY DEFINER`.
- **Conexión de las apps**: `createDb` lee solo `DATABASE_URL`. Conectar `apps/backend` y `apps/worker` queda para 004/008; CA-2b se verifica con búsqueda: `MIGRATIONS_DATABASE_URL` solo aparece en `packages/db/src/cli/`, `.env.example`, `ci.yml` y `docs/`.
- **Seed**: superusuario, idempotente (`ON CONFLICT DO NOTHING`), IDs fijos en `SEED`: tenants A y B; usuarios `uA` (A), `uB` (B), `uAB` (A y B); 3 clientes por tenant con un RUC repetido entre A y B (CA-7).
- **CI**: job `aislamiento` con `services.postgres` (`postgres:17`, `POSTGRES_DB=contapp`, `POSTGRES_HOST_AUTH_METHOD=trust`, sin contraseña en el repo); un paso genera `DATABASE_URL` con contraseña aleatoria (`openssl rand -hex 24`, `::add-mask::`) y la escribe en `$GITHUB_ENV`; luego `pnpm install --frozen-lockfile`, build de `@contapp/db` y `pnpm ci:db`. En local lo mismo contra PG 17 (D6).

## Riesgos
- Código con `tx` que llama `set_config('app.tenant_id', …)` a mitad de la transacción cambia de tenant: RLS confía en el GUC. Se mitiga con `WithTenantAnidadoError` y revisión; si el adversario lo marca, se acepta o corrige con el usuario (CA-9).
- PK o UNIQUE como oráculo: insertar un `id` que existe en otro tenant da `duplicate key`. Lo ataca el adversario; arreglo candidato: grants por columna sin `id` o PK siempre por defecto.
- `membresia_por_usuario` deja ver las membresías de cualquier `app.user_id` que fije el código: equivale al riesgo del GUC de tenant; solo SELECT.
- `drizzle-kit` regenera diferencias por políticas o FORCE: se evita dejándolos fuera del esquema; T5 corre `drizzle-kit generate` y debe salir "No schema changes".
- Pool reutiliza conexión con contexto: CA-6 lo prueba con `poolMax: 1`.
