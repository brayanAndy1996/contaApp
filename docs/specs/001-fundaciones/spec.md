# Spec 001 · Fundaciones

Estado: aprobada
Nivel de riesgo: D — andamiaje y tooling: sin lógica de negocio, sin datos de clientes, credenciales ni llamadas a SUNAT.
Cubre: RNF-080, RNF-081 (**desviación aprobada: sin Docker**, decisión 1), RNF-084 · sin RF/HU (andamiaje técnico)

## Objetivo
Dejar el monorepo ContApp listo para que las specs 002–018 se construyan sobre él: workspace pnpm con apps y paquetes, tooling compartido (TypeScript, ESLint con reglas de límites, Turborepo), entorno local sin Docker (decisión 1) y CI base. Lo usa el equipo de desarrollo y los agentes; no entrega funcionalidad de negocio.

## Alcance
- Monorepo pnpm: `apps/frontend` (Next.js), `apps/backend` (NestJS HTTP) y `apps/worker` (NestJS standalone, sin procesadores), mínimas tipo "hola mundo". Solo se crea `packages/shared`; los demás `packages/*` de 03-arquitectura §11 los crea cada spec posterior (decisión 4).
- `packages/shared` con esquemas zod (RNF-080), importable desde las tres apps.
- Tooling compartido: tsconfig base, ESLint con reglas de límites y Prettier, en archivos de la raíz, sin `packages/config` (decisión 6). Turborepo (`turbo.json`) con tareas `dev`, `build`, `lint`, `typecheck` y `test`.
- Reglas de límites: `apps/frontend` solo importa `packages/shared`; `apps/backend` no importa `packages/sunat`; `packages/domain` no importa paquetes de IO (db, sunat, storage, queue, crypto).
- Sin Docker (decisión 1): no se crea `infra/docker-compose.yml`. Arranque local: `pnpm install && pnpm dev`. PostgreSQL y Redis los instala localmente el usuario (desde 002 y 008). Mailpit no entra en 001 (decisión 8).
- `.env.example` con las variables de adaptador que se necesiten, todas en `mock` (`XML_PROVIDER=mock`, etc.), y las URL de PostgreSQL y Redis apuntando a localhost (decisiones 1 y 5). `.gitignore` con `.env`, `secrets/` y `storage/`.
- CI base (RNF-084) en `.github/workflows/ci.yml` (GitHub Actions): instala dependencias y corre solo lint, typecheck y build (decisiones 2 y 3). Corre cuando el usuario suba el repo a GitHub.
- Repositorio git local en la raíz (`git init`; hoy no lo es) en la rama `spec/001-fundaciones`, sin remoto: el usuario lo sube a GitHub manualmente (decisión 2). Commits Conventional Commits.

## Fuera de alcance
- Modelo de datos, migraciones y RLS → 002-db-rls, incluida su prueba de aislamiento en CI (decisión 3).
- Dominio y dinero (`Money`, reglas) → 010 y 011. Adaptadores mock de SIRE, SOL y XML → 009; la fuente XML real la entrega el equipo.
- Autenticación, cifrado de credenciales y colas BullMQ → 004, 003 y 008.
- E2E con Playwright → 018-e2e-r1. Despliegue a producción: no definido aquí.

## Criterios de aceptación
- [ ] CA-1 (workspace): Dado un clon limpio con Node y pnpm, cuando se ejecuta `pnpm install`, entonces termina sin errores, `pnpm-workspace.yaml` incluye `apps/*` y `packages/*`, y las tres apps importan `packages/shared` sin error.
- [ ] CA-2 (tipos): `pnpm typecheck` termina con 0 errores en todo el workspace.
- [ ] CA-3 (lint): `pnpm lint` termina con 0 errores y 0 warnings.
- [ ] CA-4 (límites): Dado un import prohibido de prueba (p. ej. `apps/frontend` importando `packages/db`), cuando se ejecuta `pnpm lint`, entonces falla por la regla de límites; el import de prueba se revierte después.
- [ ] CA-5 (build): `pnpm build` genera frontend, backend y worker sin errores.
- [ ] CA-6 (la app levanta): Dado un clon limpio con Node y pnpm, cuando se ejecuta `pnpm install && pnpm dev`, entonces frontend y backend responden HTTP 200 en su ruta raíz y el worker arranca sin errores en consola.
- CA-7 (retirado): dependía de Docker y de `infra/docker-compose.yml`. Desviación aprobada de RNF-081 (decisión 1).
- [ ] CA-8 (mocks): Dado `.env.example`, cuando se revisa, entonces contiene exactamente las 7 variables de la tabla "Variables de `.env.example`", las 5 de adaptador (`SIRE_CLIENT`, `SOL_PORTAL`, `XML_PROVIDER`, `KEY_PROVIDER`, `STORAGE`) valen `mock`, las URL de PostgreSQL y Redis apuntan a localhost y ninguna variable contiene un secreto.
- [ ] CA-9 (secretos): Dado el repo, cuando se ejecuta `git check-ignore -v .env secrets/x storage/x`, entonces los tres quedan ignorados y `git ls-files` no los lista.
- [ ] CA-10 (CI, RNF-084): Dado el workflow `.github/workflows/ci.yml`, cuando corre sobre `spec/001-fundaciones` en GitHub, entonces ejecuta instalación, lint, typecheck y build, y termina en verde (integración y RLS: spec 002). Hasta que el usuario suba el repo, se verifica en local con los mismos comandos.
- [ ] CA-11 (git): `git branch --show-current` devuelve `spec/001-fundaciones` y el commit inicial sigue Conventional Commits.
- [ ] Casos reales aplicables: ninguno (sin lógica de negocio).

## Dependencias
- Specs: ninguna previa; 001 es prerrequisito de 002–018.
- Externas: Node LTS y pnpm (versiones a fijar en tasks.md, T2, porque 001 no tiene plan.md). PostgreSQL y Redis: instalados localmente por el usuario, necesarios desde 002 y 008 (no bloquean 001). Repositorio en GitHub: lo sube el usuario manualmente (decisión 2); no bloquea 001. La fuente XML real no bloquea.

## Decisiones del usuario
Registradas por el usuario; la spec está aprobada con ellas. Entre paréntesis, la pregunta original que responde cada una.

1. **Sin Docker (pregunta 1).** Todo local; no se crea `docker-compose`. **Desviación de RNF-081 aprobada por el usuario:** RNF-081 pedía docker-compose con Postgres, Redis y Mailpit. PostgreSQL y Redis los instala localmente el usuario (Postgres desde 002, Redis desde 008). `.env.example` apunta a localhost. Arranque local: `pnpm install && pnpm dev`.
2. **Git y CI (pregunta 2).** `git init` local en la rama `spec/001-fundaciones`, sin remoto; el usuario sube el repo a GitHub manualmente. Se crea `.github/workflows/ci.yml` (GitHub Actions: lint, typecheck y build), que corre cuando el usuario suba el repo.
3. **RLS en CI (pregunta 3).** La prueba de aislamiento RLS se agrega al CI en la spec 002, no en 001. El CI de 001 solo corre lint, typecheck y build.
4. **Estructura (pregunta 4).** Se crean solo `apps/frontend`, `apps/backend` y `apps/worker` (mínimas, "hola mundo") y `packages/shared`. Los demás `packages/*` los crea cada spec posterior.
5. **Adaptadores en `.env.example` (pregunta 5).** Las variables de adaptador que se necesiten, todas en `mock` por defecto (`XML_PROVIDER=mock`, etc.), sin secretos reales.
6. **Tooling compartido (pregunta: ubicación del tooling compartido).** Viven en archivos de la raíz del repo (tsconfig base, ESLint y Prettier), sin `packages/config`.
7. **`fixtures/` y `tests/` (pregunta 4).** 001 no crea `fixtures/` ni `tests/`; los crean 009 y 018.
8. **Mailpit (pregunta: Mailpit).** No se incluye en 001: en desarrollo los correos salen a consola. Se puede sumar en 004.

## Variables de `.env.example` (resuelto por el arquitecto, derivado de la decisión 5)
Lista exacta; ninguna otra entra en 001. Todas con valor por defecto y sin secretos (CLAUDE.md: adaptadores en `mock` por defecto).

| Variable | Valor en `.env.example` | Tipo |
|---|---|---|
| `SIRE_CLIENT` | `mock` | adaptador |
| `SOL_PORTAL` | `mock` | adaptador |
| `XML_PROVIDER` | `mock` | adaptador |
| `KEY_PROVIDER` | `mock` | adaptador |
| `STORAGE` | `mock` | adaptador |
| `DATABASE_URL` | `postgresql://localhost:5432/contapp` | entorno |
| `REDIS_URL` | `redis://localhost:6379` | entorno |

- Quedan fuera: RUC y claves SOL (son datos por tenant, cifrados en BD, no variables de entorno), `PORT` (cada app tiene su puerto por defecto: 3000 y 4000), claves de cifrado, `client_secret` y tokens (secretos; los define 003/004, nunca en `.env.example`).
- **Contradicción resuelta (KEY_PROVIDER/STORAGE):** `docs/03-arquitectura.md` §3 listaba `KEY_PROVIDER=local|aws|vault` y `STORAGE=local|s3`; CA-8 exige `mock`. Prevalece CLAUDE.md: el valor por defecto de todo adaptador es `mock`. `mock` pasa a ser valor válido de ambas variables (§3 actualizado a `mock|local|aws|vault` y `mock|local|s3`); su semántica concreta (p. ej. llaves de desarrollo, almacenamiento en memoria o carpeta temporal) la fija la spec que implemente cada puerto (003 para llaves, la de storage para archivos), no 001. `local` queda como opción real posterior.
- El usuario debe sustituir `DATABASE_URL`/`REDIS_URL` en su `.env` local si su PostgreSQL pide usuario y contraseña; eso no entra en el ejemplo.

## Pendientes
- Ninguno.
