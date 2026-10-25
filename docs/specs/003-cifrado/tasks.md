# Tareas 003 · Cifrado de credenciales

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: rama y andamiaje → pruebas (rojo) → implementación (verde, con cobertura desde el diseño) → integración → adversario (máx. 2 rondas, ~15 pruebas c/u, cada ronda en dos piezas) → verificación → revisión final → cierre. CA = `spec.md`; contratos y decisiones = `plan.md`.

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Rama `spec/003-cifrado` y commit de los docs de la spec | devops | haiku | — | — | — | [x] |
| T2 | Andamiaje de `packages/crypto`, vitest en `apps/worker`, `tests/limites` | devops | haiku | T1 | — | — | [x] |
| T3 | Comando `cobertura:crypto` (umbral 90 %), `ci:db` y CI | devops | sonnet | T2 | — | — | [x] |
| T4 | `.env.example` a 11 variables, `.env` local y fixture `mock` | devops | haiku | T2 ∥ T3 | — | — | [x] |
| T5 | Pruebas unitarias de `@contapp/crypto` (rojo) | tester | sonnet | T3, T4 | ✓ | — | [x] |
| T6 | Pruebas de BD de `credencial` y auditoría (rojo) | tester | sonnet | T3 ∥ T5 | ✓ | — | [x] |
| T7 | Pruebas del servicio del worker y la rotación (rojo) | tester | sonnet | T3, T4 ∥ T6 | ✓ | — | [x] |
| T8 | Pruebas de lint y de llaves en el repo (rojo) | tester | sonnet | T2, T4 ∥ T7 | ✓ | — | [x] |
| T9 | Implementar `packages/crypto` y `kek:generar` | backend | opus | T5 | ✓ | — | [x] |
| T10 | Esquema, migraciones 0005/0006 y repositorios en `packages/db` | backend | opus | T6 ∥ T9 | ✓ | — | [x] |
| T11 | Regla de lint contra el descifrado en `apps/backend` | devops | sonnet | T8 ∥ T10 | ✓ | — | [x] |
| T12 | Servicio `descifrarCredencial`, rotación y `kek:rotar` en el worker | backend | opus | T7, T9, T10 | ✓ | — | [x] |
| T13 | Integración: scripts raíz y checks completos | devops | haiku | T11, T12 | — | — | [x] |
| T14a | Ronda adversarial 1a: lista mínima de la spec (caja negra) | adversario | opus | T13 | — | ✓ | [x] |
| T14b | Ronda adversarial 1b: ataques nuevos (caja blanca) | adversario | opus | T13 ∥ T14a | — | ✓ | [x] |
| T15 | Corregir hallazgos de la ronda 1 | backend | opus | T14a, T14b | — | — | [x] |
| T16a | Ronda adversarial 2a: regresión de correcciones y reconversión de aceptados | adversario | opus | T15 | — | ✓ | [ ] |
| T16b | Ronda adversarial 2b: ataques nuevos contra las correcciones | adversario | opus | T15 ∥ T16a | — | ✓ | [ ] |
| T17 | Corregir hallazgos de la ronda 2 | backend | opus | T16a, T16b | — | — | [ ] |
| T18 | Verificar CA-1 a CA-12 y cobertura con evidencia | tester | sonnet | T17 | — | — | [ ] |
| T19 | Revisión final contra la spec | arquitecto | opus | T18 | — | — | [ ] |
| T20 | Cierre: ESTADO, tasks y commit | devops | haiku | T19 | — | — | [ ] |

Escalamientos: (ninguno aún)

Reglas comunes:
- Un commit por tarea (Conventional Commits `feat(003): …`, `test(003): …`), con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin remoto.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` (cambios ajenos): usar `git add <rutas>` explícitas, nunca `git add -A`/`.`.
- Nunca imprimir, registrar ni commitear llaves privadas (salvo el fixture `mock`), contraseñas ni URLs con contraseña. Para comprobar `.env`, imprimir solo nombres de variables o booleanos. Las pruebas usan secretos canario, nunca claves reales.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o "OK" + conteo. Correr solo las pruebas del paquete afectado.
- El tester no toca código de producción; backend no edita `*.spec.ts` ni `*.adv.spec.ts`; adversario solo escribe `*.adv.spec.ts`.
- Migraciones: nunca editar una ya aplicada (0000–0004 ni, tras T10, 0005/0006); corregir con una nueva.
- Escalar según 04 §3.3 y anotar aquí.

## T1 · Rama y commit de la spec (devops · haiku)
- **Contexto (leer solo esto)**: esta sección; `git status`.
- **Hacer**: (1) `git checkout -b spec/003-cifrado spec/002-db-rls` (002 aún no está en `main`); los cambios sin commitear de `docs/explorador/`, `.codex/` y `AGENTS.md` viajan en el árbol de trabajo y **no se tocan ni se agregan**. (2) `git add docs/specs/003-cifrado/ docs/specs/ESTADO.md docs/02-requerimientos.md docs/01-definiciones-base.md`. Si `git diff --cached docs/specs/ESTADO.md` muestra cambios que no son de la fila 003 ni de las notas [007]/[008], parar y avisar.
- **Hecho cuando**: `git branch --show-current` = `spec/003-cifrado`; `git show --stat HEAD` lista solo esas 6 rutas; `git status` sigue mostrando sin commitear `docs/explorador/`, `.codex/`, `AGENTS.md`. Commit `docs(003): spec aprobada, plan y tareas de cifrado`.

## T2 · Andamiaje (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/plan.md` (Archivos; Decisiones: Estructura, Versiones), `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/vitest.config.mts`, `apps/worker/package.json`, `tests/aislamiento/package.json`, `pnpm-workspace.yaml`.
- **Hacer**: (1) `packages/crypto` como `@contapp/db` (CJS, `module node16`, `dist/`), `exports` `"."` y `"./descifrado"` (con `types`), sin dependencias de producción; dev `vitest` y `@vitest/coverage-v8` 5.0.5 (`-E`); scripts `build`, `typecheck`, `lint`, `test` (`vitest run --passWithNoTests`, `testTimeout` 30 s por la generación de RSA 4096), `kek:generar` (`node dist/cli/kek-generar.js`); `src/index.ts` y `src/descifrado.ts` vacíos exportables. (2) `apps/worker`: deps `@contapp/db` y `@contapp/crypto` `workspace:*`, dev `vitest` 5.0.5; `vitest.config.mts` con `test` = unitarias (`src/**/*.spec.ts` sin `*.int.spec.ts`) y script `test:int` (solo `*.int.spec.ts`, carga `../../.env` y luego `./.env` con `process.loadEnvFile` si existen, un hilo). (3) `tests/limites` como `@contapp/tests-limites` (dev `vitest`, `eslint` del workspace), script `test`.
- **Hecho cuando**: `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` sin errores; `node -e "require.resolve('@contapp/crypto/descifrado')"` desde `apps/worker` resuelve. Commit `chore(003): andamiaje de packages/crypto, vitest del worker y tests/limites`.

## T3 · Cobertura y CI (devops · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/plan.md` (Decisiones: Cobertura), `docs/specs/003-cifrado/spec.md` ("Cobertura"), `packages/db/vitest.cobertura.config.mts` (patrón), `package.json`, `.github/workflows/ci.yml` (job `aislamiento`).
- **Hacer**: (1) `packages/crypto/vitest.cobertura.config.mts` con `root` en la raíz del repo y proyectos: `crypto` (`packages/crypto/src/**/*.spec.ts`), `aislamiento-credencial` (`tests/aislamiento/credencial*.spec.ts`) y `worker` (`apps/worker/src/**/*.spec.ts`, incluidas `.int`), con alias `@contapp/db` → `packages/db/src/index.ts`, `@contapp/crypto` → `src/index.ts` y `@contapp/crypto/descifrado` → `src/descifrado.ts`; carga `.env` y `apps/worker/.env` si existen (sin nombrar variables); sin paralelismo entre suites con BD; v8 `include` exactamente la lista del plan, `exclude` solo pruebas, `thresholds` 90 en `lines`, `statements`, `functions`, `branches`. (2) Script `test:cobertura` en `@contapp/crypto`; raíz `cobertura:crypto` = build de `@contapp/db` y `@contapp/crypto` + `test:cobertura`. (3) `ci:db` += `pnpm --filter @contapp/worker test:int`. (4) CI, job `aislamiento`: build de `@contapp/crypto` y paso `pnpm cobertura:crypto` tras `pnpm ci:db`; `KEY_PROVIDER=mock` en `env`.
- **Hecho cuando**: `pnpm cobertura:crypto` corre (sale ≠ 0 por umbral o "no tests", nunca por error de configuración); `pnpm ci:db` sigue en verde (177 de 002); `prettier --check .github/workflows/ci.yml` OK. Commit `test(003): comando cobertura:crypto con umbral 90 %`.

## T4 · Entorno y fixture mock (devops · haiku) ∥ T3
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/plan.md` (Decisiones: mock, Entorno local), `.env.example`, `.gitignore`. No leer ni mostrar `.env`.
- **Hacer**: (1) `.env.example`: agregar `KEK_ID=mock`, `KEK_PUBLIC_KEY_PATH=./secrets/kek-public.pem`, y bajo el comentario `# Solo apps/worker (en local: apps/worker/.env)` `KEK_PRIVATE_KEY_PATH=./secrets/kek-private.pem`; 11 variables. (2) `.env` local: agregar `KEK_ID` y `KEK_PUBLIC_KEY_PATH` (script de Node, sin imprimir valores); crear `apps/worker/.env` con `KEK_PRIVATE_KEY_PATH`. (3) Fixture: script temporal de Node (no se commitea) con `generateKeyPairSync('rsa', { modulusLength: 4096 })` → `packages/crypto/fixtures/mock-kek/SOLO-PRUEBAS-kek-mock-{public,private}.pem` + `LEEME.md` ("par de PRUEBA, público a propósito; prohibido en producción; `local` lo rechaza por huella").
- **Hecho cuando**: `.env.example` con 11 variables y sin secretos; un script imprime solo `{ raiz: [...nombres], worker: ['KEK_PRIVATE_KEY_PATH'] }`; `git check-ignore apps/worker/.env secrets/kek-private.pem` confirma ambos; `openssl rsa -in <fixture privada> -noout -text | head -1` dice 4096 bit. Commit `chore(003): variables KEK en .env.example y par fijo de prueba para mock`.

## T5 · Pruebas unitarias de @contapp/crypto, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/spec.md` (CA-1, CA-2, CA-3, CA-4a, CA-7, CA-9, CA-10, CA-11), `docs/specs/003-cifrado/plan.md` (Contratos; Decisiones: Algoritmos, Envoltorio, AAD, Secreto, Estructura, Fábricas y entorno, mock, `kek:generar`).
- **Hacer**: `packages/crypto/src/**/*.spec.ts`, sin BD ni red; pares RSA 4096 generados una vez por archivo (`beforeAll`) en un directorio temporal. Cubrir: ida y vuelta `sol`/`sire_api` con unicode y largo máximo; vacío, campo > 256 B, total > 1024 B, sustituto suelto y tipo de plano ≠ `ctx.tipo` rechazados (CA-1); 10 000 cifrados con nonces, DEKs y ciphertexts distintos, y nonce ≠ 12 / tag 15, 4 o 0 B rechazados con `SobreInvalidoError` sin llamar a `unwrap` (espía) (CA-2); bit-flip en cada campo, cada campo del AAD, orden tenant↔cliente, otro cliente/tipo/estudio, UUID en mayúsculas o sin guiones, `tipo` fuera del enum, `|` → error tipado y nunca texto parcial (CA-3); `crearKeyWrapper` no expone `unwrap`, con `local` abre solo la pública (`leerArchivo` espía), falla con `KEK_PRIVATE_KEY_PATH` presente o si la pública contiene una privada (CA-4a); llave faltante/ilegible/corrupta, timeout y error del mock → `KeyProviderError` reintentable, sin fallback (CA-7); canario ausente de `message`, `stack`, `cause`, `JSON.stringify` y `util.inspect` de errores, sobres y `Secreto`, y `Secreto` redactado (CA-9); `KEY_PROVIDER` vacío/desconocido, variable faltante, `mock` con `NODE_ENV=production`, sobre `mock` en `local` y viceversa, llave del fixture en `local`, llave < 4096 (CA-10); `generarKek` crea el par con permisos, no sobrescribe e imprime sin material de llave (CA-11). Prueba de estructura: `dist/index.js` no requiere (transitivamente) `descifrado`.
- **Hecho cuando**: `pnpm --filter @contapp/crypto test` falla solo por falta de implementación (import o firma), no por errores de la prueba; lista de pruebas en el commit. Commit `test(003): pruebas unitarias de packages/crypto (rojo)`.

## T6 · Pruebas de BD, rojo (tester · sonnet) ∥ T5
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/spec.md` (CA-4c, CA-5, CA-8), `docs/specs/003-cifrado/plan.md` (Contratos: repositorios y Tablas; Decisiones: Backend sin `EXCLUDED`), `tests/aislamiento/soporte.ts`, `tests/aislamiento/catalogo.spec.ts` (patrón).
- **Hacer**: `tests/aislamiento/credencial.spec.ts` (solo `DATABASE_URL`, `createDb`, `SEED`, repositorios; sobres sintéticos de bytes aleatorios, sin `@contapp/crypto`): matriz de `information_schema.column_privileges` y `has_table_privilege` por rol según el plan; con `contapp_backend` `permission denied` en `SELECT` directo, `*`, fila completa, `RETURNING`, `row_to_json`, `WHERE`/`ORDER BY`, `COPY (SELECT …) TO STDOUT` y `ON CONFLICT DO UPDATE SET ciphertext = EXCLUDED.ciphertext`; `guardarSobre` (insert y actualización) y `estadoCredenciales` funcionan (CA-4c); `contapp_platform` sin acceso; `contapp_worker` no actualiza `ciphertext`/`nonce`/`tag`; RLS simétrica A/B por id y en lote (CA-5); auditoría: worker inserta, nadie lee/actualiza/borra/trunca, backend no inserta (CA-8); `CredencialRepoError` sin `detail` ni valores. Cambios dentro de transacciones con rollback.
- **Hecho cuando**: `pnpm test:aislamiento` falla solo en `credencial.spec.ts` y por falta de tablas/repositorios; los 177 de 002 siguen verdes. Commit `test(003): permisos por columna y aislamiento de credencial (rojo)`.

## T7 · Pruebas del worker, rojo (tester · sonnet) ∥ T6
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/spec.md` (CA-1, CA-5, CA-6, CA-7, CA-8, CA-9), `docs/specs/003-cifrado/plan.md` (Contratos: worker y repositorios; Decisiones: Rotación, Descifrado y auditoría).
- **Hacer**: `apps/worker/src/credenciales/*.int.spec.ts` y `src/cli/kek-rotar.int.spec.ts` (con BD; `KEY_PROVIDER=mock` salvo rotación, que usa pares `local` temporales k1/k2) y `*.spec.ts` sin BD (servicio con `db` falso). Cubrir: guardar con `contapp_backend` + `@contapp/crypto` y descifrar con el servicio devuelve el par exacto (CA-1); `withTenant(A)` no descifra la de B (`no_encontrada`, auditada en A), simétrico, y el AAD usa `ctx.tenantId` (CA-5); rotación k1→k2: solo cambian `dek_envuelta`/`kek_id`, segunda corrida 0 cambios, interrupción por proveedor caído a mitad y reanudación, nuevos cifrados con k2, `kek_id` desconocido/retirado falla cerrado, `UPDATE` del backend entre la lectura y el CAS gana (CA-6); proveedor caído → error reintentable, nada marcado (CA-7); cada descifrado ok/fallido deja una fila sin secreto y si el registro falla (`db` falso o permiso revocado en tx) el secreto no se entrega (CA-8); logger y errores (`pg` incluidos) sin canario ni DEK (CA-9). `kek-rotar`: argumentos inválidos, `desde` = activa, salida solo con conteos.
- **Hecho cuando**: `pnpm --filter @contapp/worker test` y `test:int` fallan solo por falta de implementación. Commit `test(003): servicio de descifrado y rotación del worker (rojo)`.

## T8 · Pruebas de lint y llaves, rojo (tester · sonnet) ∥ T7
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/spec.md` (CA-4b, CA-11), `docs/specs/003-cifrado/plan.md` (Decisiones: Lint, CA-11), `eslint.config.mjs` (líneas 1–95 y 255–312).
- **Hacer**: `tests/limites/limites.spec.ts` con `new ESLint({ cwd: <raíz> }).lintText(código, { filePath: "apps/backend/src/__prueba__.ts" })`: los 7 casos del plan fallan con el mensaje de la regla; `import "@contapp/crypto"` pasa; el mismo código con `filePath` en `apps/worker/` pasa; un archivo de `packages/crypto/src/cifrado/` que importa `../descifrado/…` falla. `tests/limites/secretos.spec.ts` según el plan (CA-11).
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` falla solo en los casos que la regla nueva debe cubrir; `secretos.spec.ts` ya pasa (fixture de T4). Commit `test(003): pruebas de la regla de lint y de llaves en el repo (rojo)`.

## T9 · packages/crypto (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/plan.md` (todo), `docs/specs/003-cifrado/spec.md` (Alcance, CA-1 a CA-4a, CA-7, CA-9 a CA-11), `packages/crypto/src/**/*.spec.ts`, `packages/crypto/package.json`.
- **Hacer**: `comun/`, `cifrado/`, `descifrado/`, `cli/kek-generar.ts` e índices según el plan, con dependencias inyectables (`leerArchivo`, `plazoMs`, `escribir`). Sin logs. No tocar `packages/db` ni `apps/` (T10, T12).
- **Hecho cuando**: `pnpm --filter @contapp/crypto test` en verde; build, typecheck y lint OK; en `pnpm cobertura:crypto`, `packages/crypto/src/**` ≥ 90 % en las 4 métricas (si una rama es imposible de cubrir, escalar al arquitecto; no excluir). Commit `feat(003): cifrado híbrido y KeyProvider mock/local`.

## T10 · packages/db (backend · opus) ∥ T9
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/plan.md` (Contratos: repositorios y Tablas; Decisiones: Backend sin `EXCLUDED`, Rotación), `tests/aislamiento/credencial.spec.ts`, `packages/db/src/schema/{comun,clientes,index}.ts`, `packages/db/migrations/0002_rls_y_grants.sql` (patrón), `packages/db/src/index.ts`.
- **Hacer**: `schema/credenciales.ts` (bytea con `customType`, CHECK del plan); `drizzle-kit generate` → `0005_credencial`; `drizzle-kit generate --custom` → `0006_credencial_rls_y_grants` (dueño, RLS ENABLE+FORCE, `tenant_isolation`, grants por columna); `credenciales/{repositorio,errores}.ts` con SQL estático parametrizado; exportar desde `index.ts`. No tocar `with-tenant.ts` ni migraciones previas.
- **Hecho cuando**: `pnpm db:migrate` ×2 (2.ª sin cambios); `drizzle-kit generate` sin cambios; `pnpm test:aislamiento` todo en verde (incluido `catalogo.spec.ts` con las tablas nuevas); `pnpm --filter @contapp/db test` verde; lint OK; archivos de 003 en `packages/db` ≥ 90 % en `pnpm cobertura:crypto`. Commit `feat(003): tabla credencial con permisos por columna y auditoría de descifrado`.

## T11 · Regla de lint (devops · sonnet) ∥ T10
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/plan.md` (Decisiones: Lint), `eslint.config.mjs`, `tests/limites/limites.spec.ts`.
- **Hacer**: patrones de `no-restricted-imports` para `apps/backend/**` y para `packages/crypto/src/cifrado/**`; `reglaImportsRelativos` con rutas prohibidas por subcarpeta (`packages/crypto/src/descifrado`, `packages/crypto/dist/descifrado`) y con `require("…")` literal. Sin tocar la regla `sql-crudo`.
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` en verde; `pnpm lint` en verde en todo el repo; agregar a mano `import "@contapp/crypto/descifrado"` en `apps/backend/src/main.ts` rompe `pnpm lint` (revertido). Commit `feat(003): lint impide que apps/backend importe el descifrado`.

## T12 · Worker (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/plan.md` (Contratos: worker; Decisiones: Rotación, Descifrado y auditoría), `apps/worker/src/**/*.spec.ts`, `packages/crypto/src/descifrado.ts`, `packages/db/src/credenciales/repositorio.ts`, `packages/db/src/index.ts`.
- **Hacer**: `credenciales/descifrar-credencial.ts`, `credenciales/rotar-kek.ts` y `cli/kek-rotar.ts` (`main(argv, env, deps)` exportada; solo conteos en la salida). Funciones puras con dependencias inyectadas; el módulo Nest se conecta en 008.
- **Hecho cuando**: `pnpm --filter @contapp/worker test` y `test:int` en verde; build, typecheck y lint OK; archivos del worker ≥ 90 % y `pnpm cobertura:crypto` sale 0. Commit `feat(003): descifrado auditado y rotación de KEK en el worker`.

## T13 · Integración (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/plan.md` (Contratos: comandos), `package.json`.
- **Hacer**: scripts raíz `kek:generar` y `kek:rotar` (filtran al paquete; el de rotación carga `.env` y `apps/worker/.env`). Correr `pnpm build`, `typecheck`, `lint`, `test`, `ci:db`, `cobertura:crypto`; con `KEY_PROVIDER=local` y un par en un directorio temporal, `kek:generar` ahí y una ida y vuelta por la suite `test:int`.
- **Hecho cuando**: todos los comandos salen 0 (reportar conteos); `git status` sin `secrets/` ni llaves. Commit `chore(003): scripts kek:generar y kek:rotar`.

## T14a · Ronda adversarial 1a: lista mínima (adversario · opus)
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/spec.md` (Criterios y "Ataques mínimos"), `docs/specs/003-cifrado/plan.md` (Contratos). Caja negra: no leer implementación.
- **Hacer**: hasta ~8 pruebas en `packages/crypto/src/ronda1a.adv.spec.ts` y `tests/aislamiento/credencial-r1a.adv.spec.ts` sobre la lista mínima: tag truncado/vacío, bit-flip por campo, AAD cruzada y con `|`/orden alterado, `kek_id` ajeno o retirado, sobre `mock` en `local`, backend leyendo el sobre por cualquier vía SQL (vistas, funciones, oráculos `WHERE`), descifrado entre estudios, canario en logs y errores.
- **Hecho cuando**: pruebas commiteadas; cada fallo en "Hallazgos adversariales abiertos" de `ESTADO.md` (archivo:línea + una línea). Commit `test(003): ronda adversarial 1a`.
- **Resultado (2026-10-25)**: 10 pruebas (45 casos con `it.each`), todas en verde; **0 hallazgos**.
  - `packages/crypto/src/ronda1a.adv.spec.ts` (7): tag vacío/truncado (0–15 B, 17 B) y nonce de otra longitud se rechazan sin llamar a `unwrap`; tipos confusos y `kek_id` ajeno (`__proto__`, `constructor`, `MOCK`, `mock\0`, `k1`, con `|`, `version` 0/2/"1") dan `CryptoError` sin canario; TOCTOU con un tag que mide 16 B al validarse y 4 B al usarse no descifra; la llave `mock` re-codificada (PKCS#1, CRLF, líneas en blanco) con nombre neutro no arranca en `local` (backend y worker); la rotación no blanquea sobres `mock` hacia `local` (`kek_id` mock o re-etiquetado); `Secreto` sin canario por `inspect` (incl. `customInspect:false`/`showHidden`), `%o`, `structuredClone`, `v8.serialize`, spread y propiedades propias.
  - `tests/aislamiento/credencial-r1a.adv.spec.ts` (3): catálogo sin vistas/matviews/funciones `SECURITY DEFINER`/reglas que expongan el sobre al backend; `MERGE` (ON, WHEN MATCHED AND, SET, RETURNING), `EXPLAIN`, `EXPLAIN ANALYZE`, `TABLE`, comparación de fila completa y `DECLARE CURSOR` dan 42501; tras `ANALYZE`, `pg_stats` no muestra al backend columnas ni bytes del sobre.

## T14b · Ronda adversarial 1b: ataques nuevos (adversario · opus) ∥ T14a
- **Contexto (leer solo esto)**: igual que T14a + `plan.md` (Decisiones, Riesgos); después (caja blanca) `packages/crypto/src/`, `packages/db/src/credenciales/`, `packages/db/migrations/0006_*.sql`, `apps/worker/src/`.
- **Hacer**: hasta ~7 pruebas en `apps/worker/src/ronda1b.adv.spec.ts` y `packages/crypto/src/ronda1b.adv.spec.ts`, distintas de T14a: RNG forzado/atascado, rotación concurrente con `UPDATE` del backend, proveedor caído a mitad de la rotación, auditoría que falla tras descifrar, importación del descifrado por vías no previstas (alias, `exports`, `dist`), llave débil o pública con privada, errores de `pg` con valores, riesgos del plan.
- **Hecho cuando**: igual que T14a. Commit `test(003): ronda adversarial 1b`.
- **Resultado (2026-10-25)**: 7 pruebas (`packages/crypto/src/ronda1b.adv.spec.ts` 3, `apps/worker/src/ronda1b.adv.spec.ts` 4, esta con BD de desarrollo: carga `../../.env` y `./.env`); **1 pasa, 6 fallan** (hallazgos abiertos para T15; no se anotaron en `ESTADO.md` por indicación del orquestador):
  - **Alta** · `packages/crypto/src/descifrado/reenvolver.ts:27` y `apps/worker/src/cli/kek-rotar.ts:101`: la rotación acepta como activa el proveedor `mock`; con `KEY_PROVIDER=mock` (valor por defecto) `kek:rotar` re-envuelve DEKs reales con la KEK del fixture, cuya privada está en el repo (downgrade; contradice CA-10 y "nunca fallback a mock").
  - **Media** · `apps/worker/src/credenciales/rotar-kek.ts:89`: una sola `dek_envuelta` alterada (`IntegridadError`) aborta la rotación de todo el estudio en cada corrida; la KEK retirada no se puede jubilar. Requiere usuario: omitir y contar, o fallar cerrado.
  - **Baja** · `packages/db/src/credenciales/repositorio.ts:81` (y firma en `:173`): el CAS compara `dek_envuelta` pero no `kek_id = desde` (lo pide plan, Decisiones · Rotación); un `UPDATE` del backend que cambia solo `kek_id` queda pisado (CA-6).
  - **Baja** · `eslint.config.mjs:137` y `:138-145`: `require`/`import()` con plantilla sin expresiones, `createRequire(...)(…)` y `module.require(…)` importan `@contapp/crypto/descifrado` desde `apps/backend` sin que el lint lo reporte (CA-4b; mitigado porque el backend no tiene la privada en `local`).
  - **Baja** · `packages/crypto/src/comun/aleatorio.ts:29-32`: la guarda de RNG solo compara con el cifrado anterior; un RNG en ciclo A, B, A repite (DEK, nonce) en GCM.
  - **Baja** · `apps/worker/src/credenciales/descifrar-credencial.ts:149-151`: si `logger.log` lanza tras el COMMIT, el `Secreto` ni se entrega ni se destruye.
  - Pasa: un CHECK violado en el CAS (pg con la fila en `detail`) se reduce a `PersistenciaCredencialError` sin DEK ni bytes del sobre y revierte el lote.

## T15 · Corregir ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de 003 en `docs/specs/ESTADO.md`, los `*.adv.spec.ts` que fallan, los archivos de producción que señalan, `plan.md` (Decisiones).
- **Hacer**: corregir en `src/` o con una migración nueva. Si un hallazgo pide cambiar la spec o aceptar un riesgo, no decidir: `abierto · requiere usuario`.
- **Hecho cuando**: `pnpm test`, `pnpm ci:db` y `pnpm cobertura:crypto` en verde salvo lo marcado para el usuario; hallazgos en `corregido (<commit>)`. Commit `fix(003): hallazgos de la ronda adversarial 1`.
- **Avance (2026-10-25, parte 1, commit `1e11e8d`)**: corregidos F1, F3, F5 y F6; F2 (fila corrupta en la rotación) sigue `abierto · requiere usuario`; F4 (lint) lo hace otro agente.
  - F1 (alta): `RotacionConMockError` (`rotacion_mock`, en ambas entradas). `rotarKekTenant` y `kek:rotar` rechazan activa o anterior `mock` antes de tocar la BD; `reenvolverDek` rechaza la activa `mock` tras el `wrap` (para no romper la prueba existente "proveedor activo caído → KeyProviderError", que usa un `MockKeyProvider` caído como activa) y borra la DEK envuelta.
  - F3 (baja): CAS `... and ($5::text is null or kek_id = $5)`; `kekAnterior` es opcional para respetar el contrato de `tests/aislamiento/credencial.spec.ts` (no lo pasa); la rotación siempre pasa `desde`.
  - F5 (baja): ventana FIFO de 4096 huellas SHA-256 de DEK y de nonce (`VENTANA_HUELLAS`).
  - F6 (baja): si `logger.log` lanza tras el COMMIT, el `Secreto` se destruye y se relanza el error del logger.
  - Pruebas: crypto 268 ✓; db 202 ✓; worker unit 71 ✓; `ci:db` aislamiento 348 ✓ y worker `test:int` 28/29 (falla solo F2); limites 64 ✓; typecheck, lint y build ✓. Cobertura (sin la prueba de F2): crypto 98.26/96.96/96.05/98.44, db 98.13/96.55/98.64/99.29. Sin cambios de esquema.
- **Resultado (2026-10-25, parte 2)**: F4 corregido en `27f831d`; F2 corregido con la decisión del usuario (opción A). T15 cerrada.
  - F2: `rotarKekTenantDetalle` (nuevo) devuelve `{ reenvueltas, omitidas, corruptas: string[] }`; una fila con `IntegridadError`/`SobreInvalidoError` no aborta: queda en `desde`, cuenta en `omitidas` y su id va a `corruptas`. `rotarKekTenant` mantiene el contrato de T7 (`{ reenvueltas, omitidas }`). Otro error (proveedor caído, mock) sigue abortando el lote sin escribir. Si ninguna fila abre en toda la corrida y hubo fallos de integridad → `AnteriorNoAbreError` (`anterior_no_abre`, sin escribir): necesario para la prueba de T7 "llave anterior equivocada → rechaza".
  - `kek:rotar`: línea por estudio y total con `corruptas N`; ids de las corruptas a stderr; sale con `CODIGO_CORRUPTAS = 3` y el aviso "la KEK anterior sigue siendo necesaria (no la jubile)". Códigos documentados en la cabecera: 0 ok, 1 error, 2 uso, 3 corruptas.
  - Límite conocido: si en una corrida solo quedan filas corruptas (p. ej. reejecución tras rotar las sanas), no se distingue de una llave equivocada → código 1 `anterior_no_abre` (también con el aviso de que la KEK sigue necesaria), no 3.
  - Pruebas nuevas: `apps/worker/src/cli/kek-rotar-corruptas.int.spec.ts` (3). worker unit 71 ✓, `test:int` 32/32 ✓ (incluye F2); `ci:db` ✓ (aislamiento 348); limites 64 ✓; typecheck, lint y build ✓. Cobertura: crypto 98.34/97.14/96.12/98.52, db 98.13/96.55/98.64/99.29.

## T16a · Ronda 2a: regresión y reconversión (adversario · opus)
- **Contexto (leer solo esto)**: igual que T14b + `git diff <commit T14b>..HEAD -- packages apps`.
- **Hacer**: si T14a y T14b no tuvieron fallos, marcar T16a, T16b y T17 `[x]` "omitida: ronda 1 sin fallos". Si no: reconvertir las pruebas de hallazgos aceptados por el usuario para que fijen el comportamiento aceptado (con comentario) y hasta ~5 pruebas que reintenten cada hallazgo corregido por otra vía.
- **Hecho cuando**: igual que T14a. Commit `test(003): ronda adversarial 2a`.

## T16b · Ronda 2b: ataques nuevos (adversario · opus) ∥ T16a
- **Contexto (leer solo esto)**: igual que T16a.
- **Hacer**: hasta ~10 pruebas nuevas en `*-r2b.adv.spec.ts` contra las correcciones y huecos restantes. Omitida si la ronda 1 no tuvo fallos.
- **Hecho cuando**: igual que T14a. Commit `test(003): ronda adversarial 2b`.

## T17 · Corregir ronda 2 (backend · opus)
- **Contexto / Hacer / Hecho cuando**: igual que T15 con los hallazgos de T16a/T16b; omitida si no hubo. Commit `fix(003): hallazgos de la ronda adversarial 2`.

## T18 · Verificación (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/spec.md` (Criterios, "Cobertura"), `plan.md` (Contratos: comandos), hallazgos de 003 en `docs/specs/ESTADO.md`.
- **Hacer**: evidencia por CA con comando y resultado: CA-1 a CA-3, CA-7, CA-9, CA-10 (`pnpm --filter @contapp/crypto test` + `test:int`); CA-4a/b (unitarias + `tests/limites` + import manual temporal); CA-4c, CA-5, CA-8 (`pnpm test:aislamiento`, consulta a `column_privileges`); CA-6 (`test:int` + corrida manual de `kek:rotar` con pares temporales, dos veces); CA-11 (`git check-ignore`, `git grep`); CA-12 (hallazgos cerrados o aceptados, `*.adv.spec.ts` verdes); cobertura con `pnpm cobertura:crypto` (global y por archivo, 4 métricas ≥ 90 %). `.env.example` con 11 variables. Si la cobertura no llega, crear subtareas tester (ramas faltantes) y backend (inyección), como 002 T12a–T12e; no bajar el umbral ni excluir.
- **Hecho cuando**: cada CA con evidencia en "Resultado" de esta tarea; ESTADO 003 → `verificada`. Commit `docs(003): verificación de CA con evidencia`.

## T19 · Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `docs/specs/003-cifrado/{spec,plan}.md`, "Resultado" de T18, `packages/db/migrations/0006_*.sql`, `packages/crypto/src/{cifrado,descifrado}/*.ts`, `apps/worker/src/credenciales/*.ts`, `eslint.config.mjs` (cambios de T11).
- **Hacer**: contrastar cada CA y D1–D8 con su evidencia y el DoD A (04 §5); listar faltantes y riesgos aceptados para informar al usuario.
- **Hecho cuando**: veredicto "aprobada" o lista de faltantes con tarea asignada. Sin commit si no cambia archivos.

## T20 · Cierre (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/ESTADO.md`, `docs/specs/003-cifrado/tasks.md`, observaciones de T19.
- **Hacer**: marcar `[x]` las tareas hechas y las casillas CA de `spec.md`; ESTADO 003 → `hecha`, "Tarea actual" → `—`; hallazgos de 003 en su estado final; notas heredadas para 007/008 vigentes.
- **Hecho cuando**: `git status` limpio salvo `docs/explorador/`, `.codex/`, `AGENTS.md`; `git log --oneline` muestra los commits de 003. Commit `chore(003): cierra spec 003`.
