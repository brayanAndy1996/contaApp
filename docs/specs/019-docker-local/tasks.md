# Tareas 019 · Entorno local con Docker

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Compose y scripts raíz | devops | haiku | — | — | — | [x] |
| T2 | `.env.example` y docs | devops | haiku | T1 | — | — | [x] |
| T3 | Prueba real: compose, migraciones, seed, `ci:db`, `down -v` | devops | haiku | T1, T2 | — | — | [x] |
| T4 | Cierre: tareas marcadas y commits | devops | haiku | T3 | — | — | [x] |

Escalamientos: ninguno

## T1 · Compose y scripts raíz
- **Contexto (leer solo esto)**: `docs/specs/019-docker-local/plan.md#contratos`, `.github/workflows/ci.yml` (job `aislamiento`)
- **Hacer**: crear `docker-compose.yml` en la raíz según el contrato. Añadir `servicios:up` y `servicios:down` a `package.json`.
- **Hecho cuando**: `docker compose config -q` sin errores (con `POSTGRES_PASSWORD` de prueba en la línea de comando) y `pnpm servicios:up` levanta los tres servicios.
- **Resultado**: hecho. `docker-compose.yml` en la raíz con `name: contapp`, `postgres:17`, `redis:7` y `axllent/mailpit:v1.33.0`; healthchecks; volúmenes `postgres-data`, `redis-data` y `mailpit-data`; puertos publicados en `127.0.0.1`. Valida con `docker compose --env-file <vacío> config -q`. Scripts `servicios:up` y `servicios:down` en `package.json`. Commit `d24cf7f`.

## T2 · `.env.example` y docs
- **Contexto (leer solo esto)**: `docs/specs/019-docker-local/plan.md#decisiones`, `.env.example`, `docs/03-arquitectura.md` (§10 y árbol), `docs/01-definiciones-base.md` (§6), `apps/worker/README.md`
- **Hacer**: `.env.example` con las URLs del compose, las variables de puertos y la contraseña de desarrollo, sin secretos reales. Actualizar los docs citados.
- **Hecho cuando**: CA-5 y CA-6 cumplidos. Ninguna referencia a `infra/docker-compose.yml` queda en los docs.
- **Resultado**: hecho. `.env.example` con las URLs del compose (superusuario para migrar, rol de app con contraseña, Redis y SMTP de Mailpit) y las variables de puertos y de contraseña de desarrollo. `docs/03-arquitectura.md` §10: tabla, flujo de primera vez, y `pnpm setup:local` marcado como planeado; en el árbol, `docker-compose.yml` pasa a la raíz y sale de `infra/`. `docs/01-definiciones-base.md` §6 y `apps/worker/README.md` actualizados. `.env` no se tocó. Commit `becd0ae`.

## T3 · Prueba real
- **Contexto (leer solo esto)**: `docs/specs/019-docker-local/spec.md#criterios-de-aceptación`, `docs/specs/019-docker-local/plan.md#contratos`
- **Hacer**: `POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose up -d --wait`. Después `db:migrate` ×2, `db:seed` y `ci:db`, con `DATABASE_URL`, `MIGRATIONS_DATABASE_URL` y `REDIS_URL` apuntando a esos puertos en la línea de comando. Comprobar la persistencia tras `down`. Hacer `down -v`, subir de nuevo y confirmar la BD limpia. Dejar el compose parado con `down -v`. No se toca `.env` ni los PostgreSQL y Redis nativos.
- **Hecho cuando**: CA-1 a CA-4 cumplidos. `ci:db` pasa, con los números en Resultado, o el fallo queda anotado con detalle.
- **Resultado**: hecho, sin fallos. Node 22.22.0 (en esta máquina no hay Node 24, que pide el repo). PostgreSQL 17.11 (`postgres:17`), con `und-x-icu` presente. Puertos 55432 y 56379; healthchecks de PostgreSQL, Redis y Mailpit en `healthy`. `db:migrate` 1.ª vez: contraseña de `contapp_app` actualizada; 2.ª vez: sin cambios. `db:seed` OK (2 tenants). `ci:db` OK: `test:aislamiento` 39 archivos y 1393 pruebas; worker `test:int` 17 y 102; backend `test:int` 46 y 742; en total 2237 pruebas en verde. Persistencia: tras `down` sin `-v`, siguen 13 tablas, 7 roles `contapp_*` y la clave de Redis. Tras `down -v` y subir de nuevo, BD vacía (0 tablas, 0 roles) y Redis vacío. Puertos por variable comprobados: `POSTGRES_PORT`, `REDIS_PORT` y `MAILPIT_SMTP_PORT`/`MAILPIT_UI_PORT` (21025/28025); por defecto, 5432, 6379, 1025 y 8025. Docker Hub devolvió 429 (100 pulls por hora, IP compartida) en varios intentos; `postgres:17` se descargó al reintentar unos 10 minutos después. Compose dejado parado con `down -v`. Los PostgreSQL y Redis nativos ya estaban parados al empezar; no se arrancaron ni se tocaron.

## T4 · Cierre
- **Hacer**: marcar T1–T4 con `[x]` y Resultado. Commits Conventional con trailer. Sin push. No se toca `docs/specs/ESTADO.md`.
- **Hecho cuando**: commits en `spec/019-docker-local` y árbol de trabajo limpio salvo lo excluido.
- **Resultado**: hecho. Commits `ab99e54` (spec, plan y tareas), `d24cf7f` (compose y scripts), `becd0ae` (`.env.example` y docs) y el commit de cierre que añade este resultado. Sin push. `docs/specs/ESTADO.md` sin tocar.
