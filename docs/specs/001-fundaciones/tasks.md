# Tareas 001 · Fundaciones

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel D: sin `plan.md`; este archivo hace de plan. Los CA citados son los de `spec.md`.

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Repo git `spec/001-fundaciones` y `.gitignore` | devops | haiku | — | — | — | [x] |
| T2 | Decidir versiones de Node y pnpm | arquitecto | opus | T1 | — | — | [ ] |
| T3 | Workspace raíz: pnpm, Turborepo, `pnpm install` | devops | haiku | T2 | — | — | [ ] |
| T4 | Tooling raíz: tsconfig base, ESLint con límites, Prettier | devops | haiku | T3 | — | — | [ ] |
| T5 | `packages/shared` con esquema zod mínimo | devops | haiku | T4 | — | — | [ ] |
| T6 | `apps/backend` (NestJS HTTP, puerto 4000) | devops | haiku | T5 | — | — | [ ] |
| T7 | Decidir arranque del worker en 001 | arquitecto | opus | T6 | — | — | [ ] |
| T8 | `apps/worker` (NestJS standalone) | devops | haiku | T7 | — | — | [ ] |
| T9 | `apps/frontend` (Next.js, puerto 3000) | devops | haiku | T8 | — | — | [ ] |
| T10 | `.env.example` con adaptadores en `mock` | devops | haiku | T9 | — | — | [ ] |
| T11 | CI base: `.github/workflows/ci.yml` | devops | haiku | T9 ∥ | — | — | [ ] |
| T12 | Verificación de CA-1 a CA-11 en clon limpio | devops | haiku | T10, T11 | — | — | [ ] |
| T13 | Cierre: ESTADO a `hecha` y commit de cierre | devops | haiku | T12 | — | — | [ ] |

Escalamientos: (ninguno al planificar)

Reglas comunes:
- Scaffolding con CLI o generador (`nest new`, `create-next-app`, `pnpm`, `turbo`); sin boilerplate escrito a mano.
- No crear `fixtures/`, `tests/`, `test/`, `*.spec.ts`, `plan.md`, `infra/docker-compose.yml`, `packages/config` ni Mailpit (decisiones 1, 6, 7 y 8 de `spec.md`).
- Checks (lint, tipos, build, pruebas): responder solo fallos (`archivo:línea · mensaje`); si todo pasa, "OK" + conteo.
- Al cerrar cada tarea: marcar `[x]` aquí y hacer commit Conventional Commits con el trailer `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`. Identidad git: la global existente, sin cambiarla. Sin remoto.
- Las tareas ∥ no comparten archivos; sus commits se hacen uno tras otro (índice de git).
- Si falla una vez en la misma tarea: detenerse, anotar en Escalamientos y escalar (`docs/04-metodologia.md` §3.3).

## T1 · Repo git y .gitignore
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Alcance: repositorio git; CA-9, CA-11), `docs/04-metodologia.md` §6.
- **Hacer**: (1) `git init -b spec/001-fundaciones` en la raíz, sin remoto. (2) `.gitignore` con `node_modules/`, `.env`, `.env.*`, `!.env.example`, `secrets/`, `storage/`, `dist/`, `.next/`, `.turbo/`, `*.log` y `.claude/settings.local.json`. (3) En `docs/specs/ESTADO.md`, 001 → `en curso`. (4) `git add` de lo existente tras revisar `git status`: sin secretos ni `node_modules`.
- **Hecho cuando**: `git branch --show-current` = `spec/001-fundaciones`; `git check-ignore -v .env secrets/x storage/x` lista los tres; `git check-ignore .env.example` no devuelve nada. Commit `chore(001): inicializa repo git y .gitignore`.

## T2 · Decidir versiones de Node y pnpm (arquitecto)
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Dependencias: Node LTS y pnpm). Máquina observada: Node v24.1.0, pnpm 10.12.1, git 2.49.0.
- **Hacer**: decidir la versión de Node (la LTS vigente a 2026-10-24; no es obvio cuál es), la de pnpm, y cómo se fijan (`engines` y `.nvmrc`; `packageManager` para corepack). Escribir el resultado en "Resultado". No cambiar código.
- **Hecho cuando**: "Resultado" tiene versiones exactas y mecanismo. Commit `docs(001): fija versiones de Node y pnpm`.
- **Resultado** (verificado el 2026-10-24 contra nodejs.org/dist/index.json y el registro npm):
  - **Node 24 (Krypton, LTS activa)**; último parche 24.22.1 (2026-10-20). Node 26 existe (26.12.1) pero aún no es LTS, por eso no se usa. Máquina: 24.1.0, compatible.
  - **pnpm 10.12.1** (exacto): es el instalado; la línea 10 sigue mantenida (10.34.8) y no hay motivo para saltar a 11/12 en 001.
  - Mecanismo: `package.json` raíz `"packageManager": "pnpm@10.12.1"` y `"engines": { "node": ">=24.1.0 <25", "pnpm": ">=10.12.1 <11" }`; `.nvmrc` con `24`; CI (T11) usa `node-version-file: .nvmrc` y la versión de `packageManager` para pnpm. No se fija el parche de Node para no romper la máquina (24.1.0) ni el CI.
  - Subir a Node 26 cuando sea LTS: decisión futura, fuera de 001.

## T3 · Workspace raíz
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Alcance: monorepo y Turborepo; CA-1), `docs/03-arquitectura.md` §11 (solo el árbol de `apps/` y `packages/`), "Resultado" de T2.
- **Hacer**:
  - `pnpm-workspace.yaml` con `apps/*` y `packages/*`.
  - `package.json` raíz: `name: "contapp"`, `private: true`, `packageManager` y `engines` según T2; scripts `dev`, `build`, `lint`, `typecheck` y `test` = `turbo run <tarea>`; `turbo` en devDependencies.
  - `turbo.json` (Turborepo v2, clave `tasks`): `dev` (persistent, sin caché, `dependsOn: ["^build"]`); `build` (`dependsOn: ["^build"]`, outputs `dist/**`, `.next/**`, `!.next/cache/**`); `typecheck` (`dependsOn: ["^build"]`); `lint`; `test`.
  - `pnpm install` (commitear `pnpm-lock.yaml`).
- **Hecho cuando**: `pnpm install` sin errores; `pnpm-workspace.yaml` incluye `apps/*` y `packages/*` (CA-1 parcial). Commit `chore(001): workspace pnpm y turbo`.

## T4 · Tooling compartido en la raíz
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Alcance: tooling compartido y reglas de límites; decisión 6; CA-2, CA-3, CA-4), `docs/03-arquitectura.md` §2 (matriz de dependencias).
- **Hacer**:
  - `tsconfig.base.json`: `strict`, `skipLibCheck`, `isolatedModules`, `target` ES2022. No fijar `module`; lo fija cada app según su framework.
  - `eslint.config.mjs` (flat config): `typescript-eslint` recomendado sin type-check, `eslint-config-prettier`, y `ignores` para `**/dist/**`, `**/.next/**` y `**/node_modules/**`.
  - Límites con `no-restricted-imports` (`patterns`) en bloques `files` por carpeta, que bloquean tanto la ruta (`packages/<x>`) como el nombre (`@contapp/<x>`): `apps/frontend/**` solo importa `@contapp/shared`; `apps/backend/**` no importa `sunat`; `packages/domain/**` no importa `db`, `sunat`, `storage`, `queue` ni `crypto`.
  - `.prettierrc` y `.prettierignore` en la raíz; `prettier` en devDependencies.
  - Script `lint` de cada paquete: `eslint . --max-warnings=0`.
- **Hecho cuando**: `pnpm typecheck` y `pnpm lint` sin errores ni warnings (CA-2 y CA-3 parciales). La regla de límites se prueba en T12 (CA-4). Commit `chore(001): tooling compartido (tsconfig, eslint, prettier)`.

## T5 · packages/shared
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Alcance: packages/shared; decisión 4; CA-1), `docs/02-requerimientos.md` (RNF-080), `docs/03-arquitectura.md` §2 (paquetes).
- **Hacer**: paquete `@contapp/shared` con `private: true`, `main` y `types` → `dist/index.js` y `dist/index.d.ts`. `tsconfig.json` extiende la base y compila a `dist/` en CJS (lo consumen Nest y Next). `src/index.ts` con un esquema zod mínimo: `saludoSchema = z.object({ mensaje: z.string() })` y su tipo `Saludo`. Dependencia `zod`. Scripts `build`, `typecheck` y `lint`. Sin lógica de negocio.
- **Hecho cuando**: `pnpm --filter @contapp/shared build` genera `dist/index.d.ts`; typecheck y lint sin errores. Commit `feat(001): packages/shared con esquema zod mínimo`.

## T6 · apps/backend (NestJS HTTP)
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Alcance: apps; CA-1, CA-5, CA-6), `docs/03-arquitectura.md` §10 (puerto 4000).
- **Hacer**:
  1. `nest new` en `apps/backend` con `--package-manager pnpm --skip-git --skip-install` (ver `--help`); nombre `@contapp/backend`.
  2. Quitar lo que duplica la raíz: ESLint y Prettier propios, `.gitignore` del app. `tsconfig.json` extiende `tsconfig.base.json`; conservar `tsconfig.build.json`.
  3. Quitar pruebas: carpeta `test/`, `*.spec.ts`, script `test`, jest y supertest.
  4. Dependencia `"@contapp/shared": "workspace:*"`; usar `saludoSchema` en `AppService` (p. ej. para validar el texto de `GET /`).
  5. Escucha en `process.env.PORT ?? 4000`. Scripts: `dev` (`nest start --watch`), `build` (`nest build`), `typecheck` (`tsc --noEmit`), `lint` (según T4).
- **Hecho cuando**: `build`, `typecheck` y `lint` del paquete sin errores. `GET /` = 200 se valida en T12. Commit `feat(001): apps/backend mínimo (NestJS)`.

## T7 · Arranque del worker en 001 (arquitecto)
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Alcance: `apps/worker` standalone sin procesadores; CA-6), `docs/03-arquitectura.md` §10 (worker: `pnpm dev`, sin puerto).
- **Hacer**: decidir qué hace el worker de 001 al arrancar: (a) queda activo hasta SIGINT y registra su arranque, o (b) arranca y termina con código 0. Fijar qué cuenta como "arranca sin errores en consola" (CA-6) para el worker. Escribir el resultado en "Resultado". No cambiar código.
- **Hecho cuando**: "Resultado" fijado. Commit `docs(001): decide arranque del worker`.
- **Resultado**: _pendiente_

## T8 · apps/worker (NestJS standalone)
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Alcance: apps; CA-1, CA-5, CA-6), "Resultado" de T7.
- **Hacer**: `nest new` en `apps/worker` como en T6 (pasos 1 a 3), nombre `@contapp/worker`, sin HTTP. `src/main.ts` con `NestFactory.createApplicationContext` (sin `listen`). Sin procesadores ni módulos de negocio. Usar `saludoSchema` en un servicio (CA-1). Arranque según T7. Scripts `dev`, `build`, `typecheck` y `lint` como en T6.
- **Hecho cuando**: `build`, `typecheck` y `lint` sin errores; arranque local sin errores según T7. Commit `feat(001): apps/worker mínimo (NestJS standalone)`.

## T9 · apps/frontend (Next.js)
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Alcance: apps; CA-1, CA-5, CA-6), `docs/03-arquitectura.md` §9 (App Router, Tailwind) y §10 (puerto 3000).
- **Hacer**:
  1. `create-next-app` en `apps/frontend` (ver `--help`): TypeScript, App Router, Tailwind, `--no-eslint`, sin git, sin install; nombre `@contapp/frontend`.
  2. `tsconfig.json` extiende la base y conserva lo que exige Next.
  3. Quitar el script `lint` y la config de ESLint generados (lint según T4). Quitar `next/font/google` del layout: el build no debe depender de red.
  4. Usar `saludoSchema` de `@contapp/shared` en `app/page.tsx`.
  5. No añadir shadcn, TanStack ni React Hook Form: llegan con las specs que los necesitan.
- **Hecho cuando**: `build`, `typecheck` y `lint` sin errores; el puerto 3000 se valida en T12. Commit `feat(001): apps/frontend mínimo (Next.js)`.

## T10 · .env.example
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Alcance: `.env.example`; CA-8; sección "Variables de `.env.example`").
- **Desbloqueada**: la lista y la contradicción `local`/`mock` quedaron resueltas en la spec (sección "Variables de `.env.example`").
- **Hacer**: `.env.example` con exactamente las 7 variables de la tabla de la spec (`SIRE_CLIENT`, `SOL_PORTAL`, `XML_PROVIDER`, `KEY_PROVIDER`, `STORAGE` = `mock`; `DATABASE_URL=postgresql://localhost:5432/contapp`; `REDIS_URL=redis://localhost:6379`), sin otras variables, credenciales ni secretos.
- **Hecho cuando**: CA-8 cumplido en revisión. Commit `chore(001): .env.example con adaptadores en mock`.

## T11 · CI base (GitHub Actions)
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (CA-10; decisiones 2 y 3), "Resultado" de T2.
- **Hacer**: `.github/workflows/ci.yml` con disparadores `push` y `pull_request`, runner `ubuntu-latest` y pasos: checkout; pnpm (versión de `packageManager`); Node (versión de T2); `pnpm install --frozen-lockfile`; `pnpm lint`; `pnpm typecheck`; `pnpm build`. Sin tests, sin servicios (Postgres y Redis llegan con 002) y sin secretos. Acciones en su versión mayor vigente.
- **Hecho cuando**: YAML válido y los comandos coinciden con los locales (CA-10 en local). Commit `ci(001): workflow de CI con lint, typecheck y build`.

## T12 · Verificación de CA-1 a CA-11
- **Contexto (leer solo esto)**: `docs/specs/001-fundaciones/spec.md` (Criterios de aceptación; decisiones 1, 6, 7 y 8).
- **Hacer**: en un clon limpio de la rama (`git clone` del repo de trabajo a una carpeta del scratchpad; el repo de trabajo no se toca salvo ESTADO):
  1. CA-1: `pnpm install`; las tres apps importan `@contapp/shared`.
  2. CA-2: `pnpm typecheck`.
  3. CA-3: `pnpm lint`.
  4. CA-4: en `apps/frontend`, crear un import prohibido de prueba hacia `packages/db`; `pnpm lint` debe fallar por la regla de límites; borrar el archivo.
  5. CA-5: `pnpm build`.
  6. CA-6: `pnpm dev` en segundo plano; `GET` a `http://localhost:3000/` y `http://localhost:4000/` = 200; el worker sin errores según T7. Detener los procesos.
  7. CA-8: revisar `.env.example`.
  8. CA-9: `git check-ignore -v .env secrets/x storage/x`; `git ls-files` sin esas rutas.
  9. CA-10: `ci.yml` frente a los comandos locales.
  10. CA-11: `git branch --show-current`; mensajes de commit en Conventional Commits.
  11. Alcance: no existen `fixtures/`, `tests/`, `test/`, `infra/docker-compose.yml`, `packages/config` ni `plan.md`; en `apps/*` no hay `*.spec.ts`.
- **Salida**: solo fallos (`archivo:línea · mensaje`) o "OK" + conteo. Si un check falla, no corregir aquí: reportar y escalar.
- **Hecho cuando**: CA-1 a CA-11 en verde con evidencia (CA-7 retirado). En el repo de trabajo, ESTADO 001 → `verificada`. Commit `docs(001): verificación de CA en verde`.

## T13 · Cierre
- **Contexto (leer solo esto)**: `docs/specs/ESTADO.md`, `docs/specs/001-fundaciones/tasks.md`, `docs/04-metodologia.md` §1.3 (paso 10).
- **Hacer**: marcar `[x]` todas las tareas; ESTADO 001 → `hecha` y "Tarea actual" → `—`; commit de cierre.
- **Hecho cuando**: `git status` limpio; `git log --oneline` muestra los commits de 001. Commit `chore(001): cierra spec 001`.
