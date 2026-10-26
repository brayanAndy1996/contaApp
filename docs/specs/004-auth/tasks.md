# Tareas 004 · Autenticación, sesión y multi-estudio

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3: rama y andamiaje → pruebas (rojo) → implementación (verde, cobertura por archivo desde el diseño) → integración → adversario (máx. 2 rondas, cada una en dos piezas) → verificación → revisión final → cierre. CA = `spec.md`; contratos y decisiones = `plan.md`.
| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Rama `spec/004-auth` desde 010 cerrada y commit de los docs | devops | haiku | 010 `hecha` | — | — | [x] |
| T2 | Andamiaje: deps, vitest en backend/shared/frontend, prueba humo de Nest | devops | haiku | T1 | — | — | [x] |
| T3 | `cobertura:auth` (90 % por archivo), `ci:db` y CI | devops | sonnet | T2 | — | — | [ ] |
| T4 | `.env.example`, `.env` local y `comunes.txt` | devops | haiku | T2 ∥ T3 | — | — | [ ] |
| T5 | Pruebas de BD del esquema `auth` y de `withAuth` (rojo) | tester | sonnet | T3 | ✓ | — | [ ] |
| T6 | Pruebas unitarias de shared y backend sin BD, y de lint (rojo) | tester | sonnet | T3, T4 ∥ T5 | ✓ | — | [ ] |
| T7 | Pruebas de integración HTTP del backend (rojo) | tester | sonnet | T3 ∥ T6 | ✓ | — | [ ] |
| T8 | Pruebas del frontend (rojo) | tester | sonnet | T2 ∥ T7 | ✓ | — | [ ] |
| T9 | Migración `0007_auth`, `AuthRepo`, `withAuth` y seed | backend | opus | T5 | ✓ | — | [ ] |
| T10 | `shared/auth`, entorno, puerto `Correo`, `Hasher` y política | backend | sonnet | T6 ∥ T9 | ✓ | — | [ ] |
| T11 | Núcleo de sesión: `AuthService`, recuperación, tokens, CSRF y guards | backend | opus | T7, T9, T10 | ✓ | — | [ ] |
| T12 | Controladores, módulo, filtro de errores y `crearApp` | backend | sonnet | T11 | ✓ | — | [ ] |
| T13 | Pantallas: login, recuperación, selector y menú de estudio | frontend | sonnet | T8 ∥ T9–T12 | ✓ | — | [ ] |
| T14 | Integración: scripts, checks completos y prueba manual de punta a punta | devops | haiku | T12, T13 | — | — | [ ] |
| T15a | Ronda adversarial 1a: lista mínima (caja negra) | adversario | opus | T14 | — | ✓ | [ ] |
| T15b | Ronda adversarial 1b: escenarios nuevos (caja blanca) | adversario | opus | T14 ∥ T15a | — | ✓ | [ ] |
| T16 | Corregir hallazgos de la ronda 1 | backend (+frontend) | opus / sonnet | T15a, T15b | — | — | [ ] |
| T17a | Ronda adversarial 2a: regresión y reconversión | adversario | opus | T16 | — | ✓ | [ ] |
| T17b | Ronda adversarial 2b: ataques nuevos contra las correcciones | adversario | opus | T16 ∥ T17a | — | ✓ | [ ] |
| T18 | Corregir hallazgos de la ronda 2 | backend (+frontend) | opus / sonnet | T17a, T17b | — | — | [ ] |
| T19 | Verificar CA-1 a CA-13 y cobertura con evidencia | tester | sonnet | T18 | — | — | [ ] |
| T20 | Revisión final contra la spec | arquitecto | opus | T19 | — | — | [ ] |
| T21 | Cierre: ESTADO, tasks y commit | devops | haiku | T20 | — | — | [ ] |

Escalamientos: T2 haiku→sonnet (haiku se detuvo antes de cerrar la tarea; sonnet revisó, corrigió el lint de `humo.spec.ts`, subió `testTimeout` y fijó versiones con 14 días de publicadas).

Reglas comunes:
- Un commit por tarea (Conventional Commits `feat(004): …`, `test(004): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin remoto.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` (cambios ajenos): `git add <rutas>` explícitas, nunca `git add -A`/`.`. El árbol es compartido con 010: no tocar archivos de 010.
- Nunca imprimir, registrar ni commitear contraseñas reales, tokens, `SMTP_URL` ni el contenido de `.env` (solo nombres de variables o booleanos). Las pruebas usan canarios; la única contraseña versionada es `SEED.contrasenaDesarrollo`.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o "OK" + conteo. Correr solo las pruebas del paquete afectado.
- El tester no toca código de producción; backend y frontend no editan `*.spec.ts` ni `*.adv.spec.ts`; el adversario solo escribe `*.adv.spec.ts` (`*.adv.int.spec.ts` si usa BD).
- Migraciones: nunca editar una aplicada (0000–0006 ni, tras T9, 0007); corregir con una nueva.
- Si la cobertura de un archivo no llega a 90 % en alguna métrica: no excluir ni bajar el umbral; crear subtareas tester (ramas faltantes) y backend (inyección).
- Escalar según 04 §3.3 y anotar arriba.

## T1 · Rama y commit de los docs (devops · haiku)
- **Contexto (leer solo esto)**: esta sección; `git status`; `git log --oneline -3 spec/010-dominio-dinero`; fila 010 de `docs/specs/ESTADO.md`.
- **Hacer**: (1) Solo si la fila 010 dice `hecha` y su último commit existe: `git checkout -b spec/004-auth spec/010-dominio-dinero` (no desde `spec/003-cifrado`). Si 010 no está cerrada, parar y avisar. Los cambios sin commitear de `docs/explorador/`, `.codex/` y `AGENTS.md` viajan en el árbol y **no se tocan ni se agregan**. (2) `git add docs/specs/004-auth/ docs/specs/ESTADO.md`. Si `git diff --cached docs/specs/ESTADO.md` trae cambios que no son de la fila 004, parar y avisar.
- **Hecho cuando**: `git branch --show-current` = `spec/004-auth`; `git merge-base --is-ancestor spec/010-dominio-dinero HEAD` sale 0; `git show --stat HEAD` lista solo `docs/specs/004-auth/{spec,plan,tasks}.md` y `docs/specs/ESTADO.md`; `git status` sigue mostrando sin commitear `docs/explorador/`, `.codex/`, `AGENTS.md`. Commit `docs(004): spec aprobada, plan y tareas de autenticación`.

## T2 · Andamiaje (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/004-auth/plan.md` (Archivos; Decisiones: Argon2, Correo, Nest y pruebas, Frontend), `apps/backend/package.json`, `apps/backend/tsconfig.json`, `apps/worker/vitest.config.mts` (patrón), `apps/worker/package.json`, `packages/shared/package.json`, `apps/frontend/package.json`.
- **Hacer**: (1) `apps/backend`: deps `@contapp/db` `workspace:*`, `@node-rs/argon2` 2.0.2 y `nodemailer` (exactas, `-E`); dev `vitest` y `@vitest/coverage-v8` 5.0.5, `supertest`, `@types/supertest`, `@types/nodemailer` (exactas). `vitest.config.mts` como el del worker (unitarias / `--mode int`); scripts `test`, `test:int`. Prueba humo `src/humo.spec.ts`: un módulo Nest con un proveedor inyectado con `@Inject(TOKEN)` resuelve bajo vitest y `require('@node-rs/argon2').hash` corre en este Windows. Si la inyección falla, configurar `unplugin-swc` y anotarlo. (2) `packages/shared`: dev `vitest` 5.0.5, script `test`. (3) `apps/frontend`: dev `vitest` 5.0.5, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `@vitejs/plugin-react` (exactas); `vitest.config.mts` con `environment: 'jsdom'`; script `test`.
- **Hecho cuando**: `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` sin errores; la prueba humo pasa; `pnpm ls -r @node-rs/argon2` muestra 2.0.2 solo en `@contapp/backend`. Commit `chore(004): andamiaje de pruebas y dependencias de autenticación`.
- **Resultado**: pnpm install --frozen-lockfile, build, typecheck, lint, `pnpm test` y la humo del backend en verde (2 pruebas: `@Inject(TOKEN)` resuelve bajo vitest sin `unplugin-swc`; `@node-rs/argon2` carga y produce argon2id en este Windows). `pnpm ls -r @node-rs/argon2`: 2.0.2 solo en `@contapp/backend`. `humo.spec.ts` importa `@node-rs/argon2` de forma estática (la regla `limites/imports-relativos` de 003 se mantiene estricta). `testTimeout` 30 s en `tests/limites/vitest.config.mts` (nuevo) y `packages/domain/vitest.config.mts`: las pruebas de lint y una de `ronda1a.adv.spec.ts` superaban los 5 s solo bajo la carga paralela de `turbo run test` (pasan solas en ~2 s, sin aserción fallida). Versiones exactas (`-E`) y fecha de publicación (≥ 14 días antes del 2026-10-26): nodemailer 10.1.0 (2026-10-10; la 10.2.1 era de hace 4 días), @types/nodemailer 8.0.2 (2026-09-15), supertest 7.3.1 (2026-10-02), @types/supertest 7.2.1 (2026-07-14), @testing-library/react 16.3.3 (2026-08-27), @testing-library/user-event 14.6.7 (2026-09-02; la 14.6.8 era de hace 13 días), jsdom 30.1.2 (2026-10-04; la 30.1.3 era de hace 11 días), @vitejs/plugin-react 6.1.2 (2026-10-05), @node-rs/argon2 2.0.2 (2024-12-05). Excepción: vitest y @vitest/coverage-v8 5.0.5 (2026-10-15, 11 días) son la versión que fija la tarea y la que ya usa el resto del monorepo.

## T3 · Cobertura y CI (devops · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/004-auth/plan.md` (Decisiones: Cobertura), `docs/specs/004-auth/spec.md` ("Cobertura"), `packages/crypto/vitest.cobertura.config.mts` (patrón), `package.json`, `.github/workflows/ci.yml` (job `aislamiento`).
- **Hacer**: (1) `apps/backend/vitest.cobertura.config.mts` con `root` en la raíz y los proyectos e `include` exactos del plan; alias `@contapp/db` → `packages/db/src/index.ts` y `@contapp/shared` → `packages/shared/src/index.ts`; carga `.env` si existe (sin nombrar variables); `thresholds` con `perFile: true` y 90 en `lines`, `statements`, `functions`, `branches`; `exclude` solo pruebas. (2) Script `test:cobertura` en backend; raíz `cobertura:auth` = build de `@contapp/shared` y `@contapp/db` + `test:cobertura`. (3) `ci:db` += `pnpm --filter @contapp/backend test:int`. (4) CI, job `aislamiento`: paso `pnpm cobertura:auth` tras `pnpm ci:db`, con `CORREO_PROVIDER=consola` y `APP_ORIGIN` en `env`.
- **Hecho cuando**: `pnpm cobertura:auth` corre y sale ≠ 0 por umbral o "sin pruebas", nunca por error de configuración; un archivo de prueba temporal con un archivo incluido al 50 % hace fallar el comando por ese archivo (comprobación de `perFile`, revertida); `pnpm ci:db` sigue en verde; `prettier --check .github/workflows/ci.yml` OK. Commit `test(004): comando cobertura:auth con umbral 90 % por archivo`.

## T4 · Entorno y lista de comunes (devops · haiku) ∥ T3
- **Contexto (leer solo esto)**: `docs/specs/004-auth/plan.md` (Decisiones: Entorno, Política), `.env.example`, `.gitignore`. No leer ni mostrar `.env`.
- **Hacer**: (1) `.env.example`: las 10 variables del plan, sin secretos (`SMTP_URL=` vacío con comentario "solo con CORREO_PROVIDER=smtp; secreto"). (2) `.env` local: agregar las mismas con un script de Node que no imprime valores. (3) `apps/backend/src/modules/auth/contrasena/comunes.txt` armada a mano (unos cientos de entradas comunes, sin descargas; UTF-8, una por línea, minúsculas, sin duplicados, solo 12–128 puntos de código) y `LEEME.md` con origen (lista propia), fecha y criterio de filtro.
- **Hecho cuando**: `.env.example` con 21 variables; un script imprime solo los nombres que tiene `.env`; `comunes.txt` sin líneas fuera de 12–128 ni duplicadas (script de comprobación, salida: conteo). Commit `chore(004): variables de autenticación y lista local de contraseñas comunes`.

## T5 · Pruebas de BD, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/004-auth/spec.md` (CA-3, CA-6, CA-8, CA-9, CA-11), `docs/specs/004-auth/plan.md` (Contratos: packages/db, Esquema `auth`, Funciones; Decisiones: BD, Seed), `tests/aislamiento/soporte.ts`, `tests/aislamiento/catalogo.spec.ts`, `tests/aislamiento/credencial.spec.ts` (patrón de privilegios), `packages/db/src/with-tenant.spec.ts` (patrón).
- **Hacer**: `tests/aislamiento/auth.spec.ts` (privilegios), `auth-funciones.spec.ts` (comportamiento) y `packages/db/src/auth/repositorio.spec.ts` (tx falsa). Cubrir: con `contapp_backend`, `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`COPY`/`TRUNCATE` en las 5 tablas → 42501; `EXECUTE` en cada función solo para `contapp_backend` (`has_function_privilege`), no `PUBLIC`/worker/platform; funciones `prosecdef`, `proconfig` con `search_path`, dueño `contapp_auth` NOLOGIN sin `BYPASSRLS` ni superusuario; RLS forzada en las 5 tablas y aún en `usuario`/`tenant`/`membresia`; `catalogo.spec.ts` ajustado para admitir `auth_definer` solo como en el plan (CA-11). `login_preparar`: hash solo con el correo exacto (mayúsculas, espacios, `%`, `_` → sin hash); 5.º fallo bloquea 15 min; ventana vencida reinicia; 20 llamadas concurrentes → exactamente 5 `permitido` (CA-3); `login_exito` reinicia y rechaza un estudio sin membresía. `sesion_validar`: revocada, inactiva 2 h o absoluta 12 h (marcas movidas con la conexión de migraciones) → cero filas; `ultimo_uso` se actualiza solo pasados 5 min; membresía borrada → `estudio_revocado` y estudio en NULL (CA-9). `sesion_rotar` conserva la absoluta y revoca la anterior. `recuperacion_*`: un solo uso, 30 min, pedir otro invalida el anterior, dos consumos concurrentes → uno solo, consumir revoca sesiones y borra `intento_login` (CA-8). Solo hashes de 32 B en BD (CA-6). `withAuth`: rechaza `contapp_worker`, no anida, GUC vacíos. `AuthRepoError` sin `detail`.
- **Hecho cuando**: `pnpm test:aislamiento` falla solo en los archivos nuevos y por falta de esquema/funciones; los de 002 y 003 siguen verdes (salvo el ajuste de `catalogo.spec.ts`, que falla solo porque falta la política). Commit `test(004): esquema auth, funciones y privilegios (rojo)`.

## T6 · Pruebas unitarias y de lint, rojo (tester · sonnet) ∥ T5
- **Contexto (leer solo esto)**: `docs/specs/004-auth/spec.md` (CA-4, CA-7, CA-10, CA-11, D11), `docs/specs/004-auth/plan.md` (Contratos: Backend; Decisiones: Argon2, Token y cookie, CSRF, IP, Política, Correo, Sin fugas, Lint), `tests/limites/limites.spec.ts` (patrón).
- **Hacer**: `packages/shared/src/auth/*.spec.ts` (`normalizarCorreo`: trim, mayúsculas, NFC; esquemas; 12–128 puntos de código con emojis y combinantes) y `apps/backend/src/**/*.spec.ts` sin BD: `Hasher` (PHC argon2id con m ≥ 19456, t ≥ 2, p ≥ 1, sal única en dos hashes de la misma contraseña; `necesitaRehash` con parámetros viejos; no-argon2id → falso; > 128 rechazada sin llamar a la librería, espía) (CA-4); entorno: parámetros bajo el piso, `CORREO_PROVIDER` desconocido o `consola` con `production`/`Production`/` production ` → error de arranque (D11); cookie con los flags exactos de D5 y `Max-Age`; token base64url de 43; CSRF derivado y comparación en tiempo constante (espía de `timingSafeEqual`); `OrigenGuard` con la matriz `Origin`/`Sec-Fetch-Site` del plan (CA-7); sujeto de IP (IPv4, IPv6 /64, mapeada); política (larga, corta, común en mayúsculas); `consola` escribe en stdout y no en el logger; `smtp` con transporte inyectado; `ColaCorreo` no espera al envío y traga errores; canario ausente de `message`/`stack`/`cause`/`JSON.stringify`/`inspect` de los errores de auth y del filtro (CA-10). `tests/limites/auth.spec.ts`: casos de lint del plan (CA-11).
- **Hecho cuando**: `pnpm --filter @contapp/shared test`, `pnpm --filter @contapp/backend test` y `pnpm --filter @contapp/tests-limites test` fallan solo por falta de implementación (import o firma) o de la regla; lista de pruebas en el commit. Commit `test(004): unitarias de autenticación y lint (rojo)`.

## T7 · Pruebas de integración HTTP, rojo (tester · sonnet) ∥ T6
- **Contexto (leer solo esto)**: `docs/specs/004-auth/spec.md` (CA-1 a CA-3, CA-5 a CA-11, "Ataques mínimos"), `docs/specs/004-auth/plan.md` (Contratos: HTTP, Backend; Decisiones: Flujo de login, Umbral de tiempos, Token y cookie, CSRF, Recuperación, Multi-estudio, Guard y contexto, Nest y pruebas, Seed).
- **Hacer**: `apps/backend/src/modules/auth/*.int.spec.ts` con `crearApp({ correo: CorreoMemoria, hasher: espía })`, `supertest`, BD de desarrollo y `SEED`. Cubrir: login correcto → 200, cookie D5, en BD solo el hash; `uA` entra con estudio, `uAB` sin estudio, `uSin` sin estudio y lista vacía (CA-1, P7); inexistente / errónea / bloqueada → mismo código, cuerpo y cabeceras salvo `Date`, sin `Set-Cookie`, y una verificación por rama (real o ficticia) (CA-2); `auth.tiempo.int.spec.ts` con el umbral del plan; 5 fallos bloquean y la correcta se rechaza, éxito reinicia, 20 concurrentes → ≤ 5 verificaciones reales, inexistentes acumulan, 21.º intento por IP → 429, aviso de bloqueo en `CorreoMemoria`, uno solo por cuenta en 24 h (CA-3, P3, P13); hash viejo se re-calcula en el login (CA-4); cookie previa no promovida, rotación al cambiar de estudio y de contraseña con la anterior en 401, plazos del servidor, logout y cerrar-todas → 401 (CA-5, P2); `token_hash` copiado como cookie → 401; restablecer revoca todo (CA-6); sin CSRF, CSRF de otra sesión, `Origin` ajeno o `Sec-Fetch-Site: cross-site` → 403, login/logout/recuperación con `Origin` ajeno → 403, ningún GET cambia estado (CA-7); recuperación igual con correo existente o no, token de un uso, vencido, alterado, truncado, de otro usuario y dos consumos concurrentes, aviso P9 (CA-8); estudios vía `withUsuario`, `GET /estudio/actual` devuelve solo el elegido, estudio ajeno/inexistente → mismo 403, membresía revocada → 403 `estudio_requerido`, `X-Estudio` distinto → 409 (CA-9); canarios en logs capturados, respuestas y errores (CA-10); un `Correo` de prueba que llama a `db.withUsuario` no recibe `WithTenantAnidadoError` (CA-11).
- **Hecho cuando**: `pnpm --filter @contapp/backend test:int` falla solo por falta de implementación. Commit `test(004): integración HTTP de autenticación (rojo)`.

## T8 · Pruebas del frontend, rojo (tester · sonnet) ∥ T7
- **Contexto (leer solo esto)**: `docs/specs/004-auth/spec.md` (CA-12, P3, P7), `docs/specs/004-auth/plan.md` (Contratos: HTTP; Decisiones: Frontend), `apps/frontend/next.config.ts`.
- **Hacer**: `apps/frontend/**/*.spec.tsx` con `fetch` simulado: login muestra el mismo mensaje para 401 (sea cual sea la causa) y otro para 429; tras el login va a `/` con un estudio, a `/estudios` con varios (último usado resaltado) y muestra "No perteneces a ningún estudio activo" sin estudios; `recuperar` muestra el mismo mensaje siempre; `recuperar/nueva` lee `#t=`, lo borra con `replaceState`, lo envía por POST y no lo pone en la URL ni en `console`; `next.config` devuelve `Referrer-Policy: no-referrer` para `/recuperar/nueva` y el rewrite `/api`; el cliente envía `X-CSRF-Token` y `X-Estudio`, ante 409 recarga la sesión, ante 403 `csrf_invalido` reintenta una vez; el cambio de estudio desde el menú hace POST y recarga los datos.
- **Hecho cuando**: `pnpm --filter @contapp/frontend test` falla solo por falta de implementación. Commit `test(004): pantallas de autenticación (rojo)`.

## T9 · BD de autenticación (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/004-auth/plan.md` (Contratos: packages/db, Esquema `auth`, Funciones; Decisiones: BD, Guard y contexto, Seed), `tests/aislamiento/auth*.spec.ts`, `packages/db/src/auth/repositorio.spec.ts`, `packages/db/src/{client,with-tenant,index}.ts`, `packages/db/migrations/0006_credencial_rls_y_grants.sql` (patrón), `packages/db/src/seed/datos.ts`, `packages/db/src/cli/seed.ts`.
- **Hacer**: `drizzle-kit generate --custom` → `0007_auth.sql` (rol, esquema, tablas, RLS, políticas, funciones con el bloqueo/reserva atómicos y el consumo de tokens del plan, grants y `REVOKE`, CHECK e índice de `usuario.email`); `auth/{repositorio,errores}.ts`; `withAuth` en `client.ts`/`with-tenant.ts` sin cambiar el comportamiento de `withTenant`/`withUsuario`; seed con `uSin`, contraseña de desarrollo y su PHC (calculado una vez con `@node-rs/argon2` desde un script temporal no versionado). No tocar `apps/`.
- **Hecho cuando**: `pnpm db:migrate` ×2 (2.ª sin cambios) y `pnpm db:seed` ×2; `drizzle-kit generate` sin cambios; `pnpm test:aislamiento` todo verde (002, 003 y 004); `pnpm --filter @contapp/db test` verde; `pnpm cobertura:db` sale 0; archivos de `packages/db/src/auth/**` ≥ 90 % por archivo en `cobertura:auth`; lint OK. Commit `feat(004): esquema auth con funciones SECURITY DEFINER y withAuth`.

## T10 · Shared, entorno, correo, hash y política (backend · sonnet) ∥ T9
- **Contexto (leer solo esto)**: `docs/specs/004-auth/plan.md` (Contratos: Backend; Decisiones: Argon2, Política, Correo, Sin fugas, Entorno), `packages/shared/src/auth/*.spec.ts`, los `*.spec.ts` de `apps/backend/src/{config,infra,modules/auth/contrasena}/`, `packages/shared/src/index.ts`, `packages/crypto/src/comun/config.ts` (`esProduccion`, patrón).
- **Hacer**: `packages/shared/src/auth/**` y exportar; `apps/backend/src/config/entorno.ts`; `infra/correo/**`; `modules/auth/contrasena/{hasher,politica}.ts` (incluida `fijarContrasena` para 005). Sin tocar `packages/db` (T9) ni guards/servicios (T11).
- **Hecho cuando**: las pruebas de esos archivos en verde (`shared` y backend unitarias); build, typecheck y lint OK; esos archivos ≥ 90 % por archivo. Commit `feat(004): esquemas de auth, entorno, correo, Argon2id y política de contraseña`.

## T11 · Núcleo de sesión (backend · opus)
- **Contexto (leer solo esto)**: `docs/specs/004-auth/plan.md` (todo), `docs/specs/004-auth/spec.md` (CA-1 a CA-11), `apps/backend/src/modules/auth/**/*.spec.ts` e `*.int.spec.ts`, `packages/db/src/auth/repositorio.ts`, `apps/backend/src/modules/auth/contrasena/{hasher,politica}.ts`, `apps/backend/src/infra/correo/{correo,cola}.ts`.
- **Hacer**: `auth.service.ts` (login con una sola verificación, logout, cambio de estudio, cerrar todas, cambiar contraseña), `recuperacion.service.ts`, `sesion/{token,cookie,csrf}.ts`, `guards/*` y `decoradores.ts`, `limites/ip.ts`, `errores.ts`, según el plan. Sin SQL en el backend; sin `withTenant` en guards.
- **Hecho cuando**: unitarias de esos archivos en verde; los `*.int.spec.ts` que no dependen de controladores en verde; typecheck y lint OK; esos archivos ≥ 90 % por archivo. Commit `feat(004): sesión por cookie, bloqueo, recuperación y guards`.

## T12 · Controladores y arranque (backend · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/004-auth/plan.md` (Contratos: HTTP, Backend; Decisiones: IP, Sin fugas, Nest y pruebas), `apps/backend/src/modules/auth/*.int.spec.ts`, `apps/backend/src/modules/auth/{auth.service,recuperacion.service}.ts`, `apps/backend/src/modules/auth/guards/decoradores.ts`, `apps/backend/src/{main,app.module}.ts`.
- **Hacer**: `auth.controller.ts`, `auth.module.ts`, `modules/estudio/**`, `comun/filtro-errores.ts`, `infra/db.ts`, `app.ts` (`crearApp`: guards globales en el orden del plan, `trust proxy`, límite de body, `x-powered-by` off, `no-store`) y `main.ts` (solo `crearApp` + `listen(PORT)`).
- **Hecho cuando**: `pnpm --filter @contapp/backend test` y `test:int` en verde (incluido `auth.tiempo.int.spec.ts`); `pnpm cobertura:auth` sale 0; build, typecheck y lint OK. Commit `feat(004): endpoints de autenticación y estudio`.

## T13 · Pantallas (frontend · sonnet) ∥ T9–T12
- **Contexto (leer solo esto)**: `docs/specs/004-auth/plan.md` (Contratos: HTTP; Decisiones: Frontend), `docs/specs/004-auth/spec.md` (CA-12, P3, P7), `apps/frontend/**/*.spec.tsx`, `apps/frontend/{next.config.ts,app/layout.tsx}`, `packages/shared/src/auth/esquemas.ts` (si aún no existe, usar los contratos del plan y alinear al terminar T10).
- **Hacer**: páginas, `lib/{api,sesion}.ts` y `next.config.ts` según el plan, con el formulario de cambio de contraseña. Mensajes genéricos (P3: el de bloqueo es el de credenciales inválidas). Sin lógica de negocio ni endpoints inventados.
- **Hecho cuando**: `pnpm --filter @contapp/frontend test` en verde; `typecheck`, `lint` y `build` OK. Commit `feat(004): pantallas de login, recuperación y selector de estudio`.

## T14 · Integración (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/004-auth/plan.md` (Contratos: HTTP; Decisiones: Entorno), `package.json`.
- **Hacer**: correr `pnpm build`, `typecheck`, `lint`, `test`, `ci:db`, `cobertura:auth`, `cobertura:db`, `cobertura:crypto`. Prueba manual: backend (`PORT=4000`) y frontend (`next build && next start`); con `curl` a través de `http://localhost:3000/api`: login de `uAB` con `Origin` correcto → 200 y cookie `__Host-`; `curl -I /recuperar/nueva` → `Referrer-Policy: no-referrer`; `POST /api/auth/recuperar` → el enlace aparece en el stdout del backend (no imprimir el token en el informe: solo "aparece").
- **Hecho cuando**: todos los comandos salen 0 (reportar conteos); la prueba manual da lo esperado; `git status` sin archivos ajenos agregados. Commit `chore(004): integración y checks completos` (solo si cambió algún archivo).

## T15a · Ronda adversarial 1a: lista mínima (adversario · opus)
- **Contexto (leer solo esto)**: `docs/specs/004-auth/spec.md` (Criterios y "Ataques mínimos"), `docs/specs/004-auth/plan.md` (Contratos). **Caja negra**: no leer implementación.
- **Hacer**: hasta ~8 pruebas en `apps/backend/src/r1a.adv.int.spec.ts` y `tests/aislamiento/auth-r1a.adv.spec.ts` sobre la lista mínima: fijación; reuso de cookie tras logout, restablecer y cambio de estudio; fuerza bruta y carrera contra el contador; enumeración por mensaje, código, cabeceras, cookies o tiempo con variantes de mayúsculas y espacios; token de recuperación reusado, vencido, concurrente, truncado o ajeno; estudio sin membresía, revocado o ajeno; CSRF de login y `Origin` falsificado; flags de cookie; Argon2 bajo el piso y contraseñas gigantes; lectura directa de `auth.*` con el rol del backend.
- **Instrucciones defensivas**: solo escribir `*.adv.spec.ts`/`*.adv.int.spec.ts`; no modificar producción, pruebas ajenas, migraciones ni `.env`; usar canarios, nunca contraseñas reales; no lanzar carga contra servicios externos; cada prueba deja la BD como estaba (transacción con rollback o limpieza de `intento_login`/`limite_tasa`/sesiones creadas); prueba con aserción concreta (no "no lanza"); una prueba que falla por error del entorno no es hallazgo.
- **Hecho cuando**: pruebas commiteadas; cada fallo en "Hallazgos adversariales abiertos" de `ESTADO.md` (archivo:línea, severidad y una línea). Commit `test(004): ronda adversarial 1a`.

## T15b · Ronda adversarial 1b: escenarios nuevos (adversario · opus) ∥ T15a
- **Contexto (leer solo esto)**: igual que T15a + `plan.md` (Decisiones, Riesgos); después (caja blanca) `apps/backend/src/modules/auth/**`, `apps/backend/src/{app.ts,comun,infra}/**`, `packages/db/src/auth/**`, `packages/db/migrations/0007_auth.sql`.
- **Hacer**: hasta ~7 pruebas en `apps/backend/src/r1b.adv.int.spec.ts` y `tests/aislamiento/auth-r1b.adv.spec.ts`, distintas de T15a: `X-Forwarded-For` falsificado y rotación IPv6 contra el límite por IP; varias cookies o cookie con otro prefijo; correos no ASCII (JS frente a `lower()` de PG); `search_path`/objetos en `pg_temp` contra las funciones `SECURITY DEFINER`; worker que pasa a backend (riesgo aceptado: confirmar alcance, no es hallazgo); rotación que extiende la caducidad absoluta; `X-Estudio` ausente o con mayúsculas; carrera entre cambio de estudio y revocación de membresía; aviso de bloqueo como spam; fugas en errores de `pg`; riesgos del plan.
- **Instrucciones defensivas**: las de T15a.
- **Hecho cuando**: igual que T15a. Commit `test(004): ronda adversarial 1b`.

## T16 · Corregir ronda 1 (backend · opus; frontend · sonnet si el hallazgo es del frontend)
- **Contexto (leer solo esto)**: hallazgos de 004 en `docs/specs/ESTADO.md`, los `*.adv*.spec.ts` que fallan, los archivos de producción que señalan, `plan.md` (Decisiones). Si el hallazgo está solo en archivos de T10/T12, puede hacerlo backend · sonnet.
- **Hacer**: corregir en `src/` o con una migración nueva. Si un hallazgo pide cambiar la spec o aceptar un riesgo, no decidir: `abierto · requiere usuario`.
- **Hecho cuando**: `pnpm test`, `pnpm ci:db`, `pnpm cobertura:auth` en verde salvo lo marcado para el usuario; hallazgos en `corregido (<commit>)`. Commit `fix(004): hallazgos de la ronda adversarial 1`.

## T17a · Ronda 2a: regresión y reconversión (adversario · opus)
- **Contexto (leer solo esto)**: igual que T15b + `git diff <commit T15b>..HEAD -- apps packages`.
- **Hacer**: si T15a y T15b no tuvieron fallos, marcar T17a, T17b y T18 `[x]` "omitida: ronda 1 sin fallos". Si no: reconvertir las pruebas de hallazgos aceptados por el usuario para que fijen el comportamiento aceptado (con comentario) y hasta ~5 pruebas que reintenten cada hallazgo corregido por otra vía.
- **Instrucciones defensivas**: las de T15a; además, antes de anotar un hallazgo, comprobar que la prueba ataca la vía real de uso (no llamadas que el código nunca hace) y que tiene arreglo posible.
- **Hecho cuando**: igual que T15a. Commit `test(004): ronda adversarial 2a`.

## T17b · Ronda 2b: ataques nuevos (adversario · opus) ∥ T17a
- **Contexto (leer solo esto)**: igual que T17a.
- **Hacer**: hasta ~10 pruebas nuevas en `*-r2b.adv*.spec.ts` contra las correcciones y huecos restantes. Omitida si la ronda 1 no tuvo fallos.
- **Instrucciones defensivas**: las de T17a.
- **Hecho cuando**: igual que T15a. Commit `test(004): ronda adversarial 2b`.

## T18 · Corregir ronda 2 (backend · opus; frontend · sonnet si aplica)
- **Contexto / Hacer / Hecho cuando**: igual que T16 con los hallazgos de T17a/T17b; omitida si no hubo. Commit `fix(004): hallazgos de la ronda adversarial 2`.

## T19 · Verificación (tester · sonnet)
- **Contexto (leer solo esto)**: `docs/specs/004-auth/spec.md` (Criterios, "Cobertura"), `plan.md` (Contratos; Decisiones: Umbral de tiempos, Cobertura, Lint), hallazgos de 004 en `docs/specs/ESTADO.md`.
- **Hacer**: evidencia por CA con comando y resultado: CA-1 a CA-10 (`pnpm --filter @contapp/backend test` + `test:int`, incluidas medianas medidas del umbral); CA-11 (`pnpm test:aislamiento`, consulta propia a `has_table_privilege`/`has_function_privilege` y `pg_proc`, `pnpm lint`, `tests/limites`); CA-12 (`pnpm --filter @contapp/frontend test` + `curl -I` de T14); CA-13 (hallazgos cerrados o aceptados, `*.adv*.spec.ts` verdes); cobertura con `pnpm cobertura:auth` (por archivo, 4 métricas ≥ 90 %, listar el mínimo); `cobertura:db` y `cobertura:crypto` siguen en 0; migraciones desde cero en una base desechable.
- **Hecho cuando**: cada CA con evidencia en "Resultado" de esta tarea; ESTADO 004 → `verificada`. Commit `docs(004): verificación de criterios con evidencia`.

## T20 · Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `docs/specs/004-auth/{spec,plan}.md`, "Resultado" de T19, `packages/db/migrations/0007_auth.sql`, `apps/backend/src/modules/auth/{auth.service,recuperacion.service}.ts`, `apps/backend/src/modules/auth/guards/*.ts`, `apps/backend/src/app.ts`.
- **Hacer**: contrastar cada CA, D1–D12 y P1–P10 con su evidencia y el DoD A (04 §5); listar faltantes y riesgos aceptados para informar al usuario.
- **Hecho cuando**: veredicto "aprobada" o lista de faltantes con tarea asignada. Sin commit si no cambia archivos.

## T21 · Cierre (devops · haiku)
- **Contexto (leer solo esto)**: `docs/specs/ESTADO.md`, `docs/specs/004-auth/tasks.md`, observaciones de T20.
- **Hacer**: marcar `[x]` las tareas hechas y las casillas CA de `spec.md`; ESTADO 004 → `hecha`, "Tarea actual" → `—`; hallazgos de 004 en su estado final; notas para 005/008 (purga de tablas de `auth`, `fijarContrasena` para invitaciones) en "Notas para specs futuras".
- **Hecho cuando**: `git status` limpio salvo `docs/explorador/`, `.codex/`, `AGENTS.md`; `git log --oneline` muestra los commits de 004. Commit `chore(004): cierra spec 004`.
