# Plan 003 · Cifrado de credenciales

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/crypto/` (`package.json`, `tsconfig.json`, `vitest.config.mts`, `vitest.cobertura.config.mts`) | `@contapp/crypto`, CJS a `dist/` como `db`; `exports` con **dos** entradas: `.` → `dist/index.js` (cifrado) y `./descifrado` → `dist/descifrado.js` |
| crear | `packages/crypto/src/comun/{aad,sobre,secreto-plano,errores,config,rsa,plazo}.ts` | AAD v1, validación de sobre, serialización del par (D8), errores tipados, lectura de entorno, envolver/desenvolver RSA-OAEP, timeout |
| crear | `packages/crypto/src/cifrado/{cifrar,fabrica,local,mock}.ts` · `src/index.ts` | lado backend: `cifrarCredencial`, `crearKeyWrapper` (solo llave pública) |
| crear | `packages/crypto/src/descifrado/{descifrar,secreto,fabrica,local,mock,reenvolver}.ts` · `src/descifrado.ts` | lado worker: `descifrarSobre`, `Secreto`, `crearKeyUnwrapper`, `crearKeyUnwrapperAnterior`, `reenvolverDek` |
| crear | `packages/crypto/src/cli/kek-generar.ts` | `generarKek(opts, deps)` + `main(argv)` |
| crear | `packages/crypto/fixtures/mock-kek/{SOLO-PRUEBAS-kek-mock-public.pem,SOLO-PRUEBAS-kek-mock-private.pem,LEEME.md}` | par fijo de `mock` (D1), RSA 4096, marcado |
| crear | `packages/db/src/schema/credenciales.ts` · `packages/db/migrations/0005_credencial.sql` (generada) · `0006_credencial_rls_y_grants.sql` (custom) | tablas `credencial` y `auditoria_descifrado`, RLS, grants por columna |
| crear | `packages/db/src/credenciales/{repositorio,errores}.ts` | repositorios con `Pick<Tx,"query">` inyectable |
| crear | `apps/worker/src/credenciales/{descifrar-credencial,rotar-kek}.ts` · `apps/worker/src/cli/kek-rotar.ts` · `apps/worker/vitest.config.mts` | servicio de descifrado con auditoría, rotación por estudio y su comando |
| crear | `tests/aislamiento/credencial.spec.ts` · `tests/limites/` (`@contapp/tests-limites`: `limites.spec.ts`, `secretos.spec.ts`) | CA-4c/CA-5/CA-8 en BD; CA-4b (lint) y CA-11 (búsqueda) |
| modificar | `packages/db/src/{schema/index,index}.ts`, `eslint.config.mjs`, `.env.example`, `package.json` raíz, `pnpm-workspace.yaml` (ya incluye `tests/*`), `apps/worker/package.json`, `.github/workflows/ci.yml` | exportar, regla de lint, 11 variables, scripts `kek:generar`, `kek:rotar`, `cobertura:crypto`, `ci:db` |
| local (no repo) | `.env` (+3 variables, `KEY_PROVIDER=mock`), `apps/worker/.env` (`KEK_PRIVATE_KEY_PATH`) | ver Decisiones: entorno |

## Contratos
```ts
// @contapp/crypto (cifrado; lo usa el backend)
export type TipoCredencial = 'sol' | 'sire_api';
export type CredencialSol = { usuario: string; clave: string };
export type CredencialSireApi = { clientId: string; clientSecret: string };
export interface ContextoAad { tenantId: string; clienteId: string; tipo: TipoCredencial } // UUID minúsculas canónicas
export interface Sobre { ciphertext: Buffer; nonce: Buffer; tag: Buffer; dekEnvuelta: Buffer; kekId: string; version: 1 }
export interface KeyWrapper { readonly kekId: string; wrap(dek: Buffer): Promise<Buffer>; verificar(): Promise<void> }
export function crearKeyWrapper(env: Record<string, string | undefined>, o?: { plazoMs?: number }): KeyWrapper;
export function cifrarCredencial(w: KeyWrapper, ctx: ContextoAad, valor: CredencialSol | CredencialSireApi): Promise<Sobre>;
export class CryptoError extends Error { codigo: string; reintentable: boolean } // mensaje fijo, sin valores ni cause externo
// subclases: SecretoInvalidoError, ContextoAadInvalidoError, SobreInvalidoError, IntegridadError (no reintentables);
// KeyProviderError, KekDesconocidaError (reintentables); ConfiguracionKeyProviderError (arranque, no reintentable)

// @contapp/crypto/descifrado (solo worker)
export interface KeyUnwrapper { readonly kekId: string; unwrap(dekEnvuelta: Buffer, kekId: string): Promise<Buffer>; verificar(): Promise<void> }
export function crearKeyUnwrapper(env, o?): KeyUnwrapper & KeyWrapper;          // llave activa (KEK_ID); la pública se deriva de la privada
// (el worker no usa crearKeyWrapper: esa fábrica rechaza un entorno con KEK_PRIVATE_KEY_PATH)
export function crearKeyUnwrapperAnterior(o: { kekId: string; rutaPrivada: string }): KeyUnwrapper; // solo rotación
export function descifrarSobre<T extends TipoCredencial>(u: KeyUnwrapper, ctx: ContextoAad & { tipo: T }, s: Sobre): Promise<Secreto<T>>;
export function reenvolverDek(s: Sobre, anterior: KeyUnwrapper, activa: KeyUnwrapper & KeyWrapper): Promise<Pick<Sobre,'dekEnvuelta'|'kekId'>>;
export class Secreto<T> { usar<R>(fn: (v: ValorDe<T>) => R): R; destruir(): void; toJSON(): '[REDACTADO]' } // inspect/toString redactados
```
`packages/db` (`src/credenciales/repositorio.ts`, `tx: Pick<Tx,"query">`): `guardarSobre(tx, {clienteId, tipo, sobre}) → {id}` · `estadoCredenciales(tx, clienteId)` (columnas de estado) · `leerSobre(tx, id)` · `listarParaReenvolver(tx, kekId, limite)` · `reemplazarDekEnvuelta(tx, {id, dekAnterior, dekNueva, kekNuevo}) → boolean` · `registrarDescifrado(tx, {credencialId, clienteId?, tipo?, motivo, resultado})`. Errores de `pg` → `CredencialRepoError` con solo el SQLSTATE.

Worker: `crearServicioCredenciales({ db, unwrapper, logger }).descifrarCredencial(ctx, credencialId, motivo) → Promise<Secreto>` · `rotarKekTenant({ db, anterior, activa, tenantId, desde, lote }) → { reenvueltas, omitidas }`. Comandos: `pnpm kek:generar -- --salida ./secrets` · `pnpm kek:rotar -- --desde <kekId> --privada-anterior <ruta> --tenant <uuid>…`.

Tablas (dueño `contapp_migrator`, RLS `ENABLE`+`FORCE`, política `tenant_isolation FOR ALL` como 002):
- `credencial(id uuid_v7, tenant_id DEFAULT GUC → tenant, cliente_id uuid NOT NULL sin FK (D2), tipo text CHECK IN ('sol','sire_api'), ciphertext bytea CHECK 1–1100 B, nonce bytea CHECK =12, tag bytea CHECK =16, dek_envuelta bytea CHECK 1–1024 B, kek_id text CHECK '^[a-z0-9][a-z0-9-]{0,62}$', version smallint CHECK =1, created_at, updated_at, UNIQUE(tenant_id, cliente_id, tipo))`.
- `auditoria_descifrado(id, tenant_id DEFAULT GUC → tenant, credencial_id uuid NOT NULL, cliente_id uuid NULL, tipo text NULL, motivo text CHECK '^[A-Za-z0-9._:-]{1,120}$', resultado text CHECK IN ('ok','no_encontrada','integridad','formato','llave'), created_at)`.
- Grants por columna, **sin** `SELECT` de tabla: `contapp_backend` `SELECT (id, tenant_id, cliente_id, tipo, created_at, updated_at)`, `INSERT (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)`, `UPDATE (ciphertext, nonce, tag, dek_envuelta, kek_id, version, updated_at)`. `contapp_worker` `SELECT` de todas las columnas y `UPDATE (dek_envuelta, kek_id, updated_at)` (la rotación no puede tocar `ciphertext`/`nonce`/`tag`: lo impone la BD). Auditoría: `contapp_worker` solo `INSERT (credencial_id, cliente_id, tipo, motivo, resultado)`; nadie más. `contapp_platform` nada. Sin `DELETE` (lo decide 007).

## Decisiones
- **Algoritmos**: DEK 32 B y nonce 12 B de `crypto.randomBytes` (sin RNG inyectable en la API pública); AES-256-GCM con `authTagLength: 16` explícito en cifrar y descifrar; nonce ≠ 12 B, tag ≠ 16 B, `version` ≠ 1 o `kek_id` mal formado → `SobreInvalidoError` antes de tocar la llave. El texto plano solo se devuelve tras `final()` correcto; los búferes parciales, la DEK y el plano se ponen a cero en `finally`. Guarda contra RNG atascado: si la DEK o el nonce repiten el del cifrado anterior del proceso o la DEK es todo ceros, se lanza.
- **Envoltorio**: RSA-OAEP 4096, `oaepHash: 'sha256'`, `oaepLabel = "contapp-kek|v1|<kekId>"` (ata la DEK envuelta a su `kek_id`); salida 512 B. La DEK desenvuelta debe medir 32 B o es `IntegridadError`. Todo fallo de descifrado (tag, AAD, llave equivocada) da el mismo `IntegridadError`, sin distinguir causa.
- **AAD**: `v1|tenant|cliente|tipo` en UTF-8; UUID solo en forma canónica minúscula (regex estricta), `tipo` del enum; se valida al cifrar y al descifrar. En el worker el tenant es `ctx.tenantId` de `withTenant` y además debe coincidir con `tenant_id` de la fila leída.
- **Secreto (D8)**: JSON canónico con orden fijo (`{"usuario","clave"}` / `{"clientId","clientSecret"}`), cada campo de 1 a 256 B UTF-8 y bien formado (`isWellFormed`, sin sustitutos sueltos), sin normalizar; total ≤ 1024 B. El tipo del plano debe coincidir con `ctx.tipo`.
- **Estructura**: `comun/` sin llaves privadas; `cifrado/` nunca importa `descifrado/` (lo vigila la regla de lint y una prueba que inspecciona los `require` de `dist/index.js`). Cada adaptador recibe por opción sus dependencias (`leerArchivo`, `plazoMs`, reloj) para probar fallas sin tocar disco; `MockKeyProvider` acepta `falla: 'timeout' | 'error' | 'corrupta'` solo por constructor (nunca por entorno).
- **Fábricas y entorno**: `KEY_PROVIDER` es obligatoria (`mock|local`; vacía o desconocida → `ConfiguracionKeyProviderError` síncrono al crear). `crearKeyWrapper` lee solo `KEY_PROVIDER`, `KEK_ID`, `KEK_PUBLIC_KEY_PATH`, `NODE_ENV`, y **falla si el entorno trae `KEK_PRIVATE_KEY_PATH`** (CA-4a). La llave se carga perezosamente en el primer uso (o con `verificar()` al arrancar, que 007/008 llaman): faltante, ilegible o corrupta → `KeyProviderError` reintentable, sin cachear el fallo; archivo de la pública que contiene una privada, llave no RSA o < 4096 bits, o la llave del fixture `mock` usada en `local` (huella SHA-256 del SPKI) → `ConfiguracionKeyProviderError`. En POSIX, una privada legible por grupo/otros se rechaza. Timeout por operación (5 s por defecto) → `KeyProviderError`. Nunca hay fallback de proveedor.
- **mock (D1)**: `kek_id = "mock"` (reservado: `local` no lo acepta como `KEK_ID`); fixture en `packages/crypto/fixtures/mock-kek/`, leído por ruta desde `__dirname` (el lado de cifrado solo abre la pública). `NODE_ENV=production` → no arranca. `mock` rechaza sobres con otro `kek_id` y `local` rechaza `kek_id = mock` (`KekDesconocidaError`).
- **Entorno local**: los procesos no deben compartir `KEK_PRIVATE_KEY_PATH`; en local va en `apps/worker/.env` (el worker carga `../../.env` y luego `.env`), y `.env.example` lista las 11 variables con esa nota. Valores: `KEY_PROVIDER=mock`, `KEK_ID=mock`, rutas `./secrets/kek-public.pem` y `./secrets/kek-private.pem`.
- **`kek:generar`**: crea `kek-public.pem` (0644) y `kek-private.pem` (0600) en `--salida` (por defecto `./secrets/`); **no sobrescribe** archivos existentes (perder la privada pierde todas las credenciales); imprime solo rutas y huella pública.
- **Rotación (D6)**: el worker normal solo conoce la llave activa; `kek:rotar` recibe la anterior por argumento (`crearKeyUnwrapperAnterior`) y re-envuelve con la activa del entorno (rechaza `desde` = activa). Por estudio, en lotes (`withTenant` por lote, `ORDER BY id LIMIT n`): `unwrap` con la anterior, `wrap` con la activa, comprobación `unwrap` activa == DEK, y `UPDATE … SET dek_envuelta, kek_id WHERE id = $1 AND kek_id = $desde AND dek_envuelta = $anterior` (CAS): una escritura concurrente del backend gana y la fila se cuenta como omitida. Idempotente y reanudable (los lotes confirmados quedan; un fallo del proveedor revierte solo el lote en curso). No descifra el `ciphertext`. Enumerar estudios queda para 008 (el worker no ve otros tenants).
- **Descifrado y auditoría (D3)**: `withTenant(ctx)` → `leerSobre` → `descifrarSobre` → `registrarDescifrado('ok')`; la función de la transacción **no lanza**: devuelve éxito o error tipado, y se lanza fuera tras el `COMMIT`, para que los fallos queden auditados. Si el registro o el `COMMIT` fallan, el `Secreto` se destruye y no se entrega. Fila de otro estudio = `no_encontrada`. El logger inyectado recibe solo ids, `codigo` y resultado.
- **Backend sin `EXCLUDED`**: `guardarSobre` usa `INSERT … ON CONFLICT (tenant_id, cliente_id, tipo) DO UPDATE SET col = $n` con parámetros y `RETURNING id`; leer `EXCLUDED.<sobre>` exige `SELECT` y da `permission denied` (CA-4c).
- **Lint (CA-4b)**: `no-restricted-imports` en `apps/backend/**` con `@contapp/crypto/descifrado`, `@contapp/crypto/dist/**`, `@contapp/crypto/src/**`, `**/packages/crypto/src/descifrado*`, `**/packages/crypto/dist/descifrado*`; la regla local de imports relativos pasa a admitir rutas prohibidas por subcarpeta y además mira `require("…")` literal. Se prueba con `ESLint#lintText` y `filePath` ficticio en `apps/backend/src/` (`tests/limites/limites.spec.ts`): import estático, dinámico, `export … from`, `require`, rutas relativas a `src` y `dist` fallan; `@contapp/crypto` pasa; el mismo código en `apps/worker/` pasa.
- **CA-11**: `tests/limites/secretos.spec.ts` corre `git check-ignore secrets/kek-private.pem` y `git grep -lE "-----BEGIN ([A-Z]+ )?PRIVATE KEY-----"` y exige como única coincidencia el fixture `SOLO-PRUEBAS-kek-mock-private.pem`; las pruebas arman ese encabezado por concatenación.
- **Cobertura (DoD A)**: `pnpm cobertura:crypto` = build de `@contapp/db` y `@contapp/crypto` + vitest con proyectos (unitarias de crypto; `tests/aislamiento/credencial*.spec.ts` y `apps/worker/src/**/*.spec.ts` con alias de `@contapp/db` y `@contapp/crypto` a `src`); v8 con `include` explícito: `packages/crypto/src/**`, `packages/db/src/credenciales/**`, `packages/db/src/schema/credenciales.ts`, `apps/worker/src/credenciales/**`, `apps/worker/src/cli/kek-rotar.ts`; umbral 90 en las 4 métricas. Los CLI exponen funciones con dependencias inyectadas (como 002 T12c) desde el primer día. `ci:db` agrega `pnpm --filter @contapp/worker test:int`.
- **Versiones**: sin dependencias nuevas de producción (`node:crypto`); `vitest`/`@vitest/coverage-v8` 5.0.5 exactas en `crypto` y `worker`.

## Riesgos
- Durante una rotación, los sobres aún con la KEK anterior dan `KekDesconocidaError` (reintentable) hasta re-envolverlos: ventana corta por estudio, documentada en la salida de `kek:rotar`.
- Una fila borrada y recreada con el mismo `(tenant, cliente, tipo)` acepta un sobre antiguo (AAD sin id de fila, D7): requiere escritura en BD, que el backend ya tiene; se acepta.
- Los `string` de JS no se pueden borrar de memoria: `Secreto.destruir()` limpia el búfer, no las copias que haga `usar`.
- La huella del fixture `mock` en `local` evita reutilizarlo, pero no otra llave débil copiada; lo cubre el mínimo de 4096 bits y el adversario.
- Si `pg` incluye valores en el `detail` de un error (fila fallida), el repositorio lo descarta: lo verifica CA-9.
