# Tareas 019 · Entorno local con Docker

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Compose y scripts raíz | devops | haiku | — | — | — | [ ] |
| T2 | `.env.example` y docs | devops | haiku | T1 | — | — | [ ] |
| T3 | Prueba real: compose, migraciones, seed, `ci:db`, `down -v` | devops | haiku | T1, T2 | — | — | [ ] |
| T4 | Cierre: tareas marcadas y commits | devops | haiku | T3 | — | — | [ ] |

Escalamientos: ninguno

## T1 · Compose y scripts raíz
- **Contexto (leer solo esto)**: `docs/specs/019-docker-local/plan.md#contratos`, `.github/workflows/ci.yml` (job `aislamiento`)
- **Hacer**: crear `docker-compose.yml` en la raíz según el contrato. Añadir `servicios:up` y `servicios:down` a `package.json`.
- **Hecho cuando**: `docker compose config -q` sin errores (con `POSTGRES_PASSWORD` de prueba en la línea de comando) y `pnpm servicios:up` levanta los tres servicios.
- **Resultado**: pendiente

## T2 · `.env.example` y docs
- **Contexto (leer solo esto)**: `docs/specs/019-docker-local/plan.md#decisiones`, `.env.example`, `docs/03-arquitectura.md` (§10 y árbol), `docs/01-definiciones-base.md` (§6), `apps/worker/README.md`
- **Hacer**: `.env.example` con las URLs del compose, las variables de puertos y la contraseña de desarrollo, sin secretos reales. Actualizar los docs citados.
- **Hecho cuando**: CA-5 y CA-6 cumplidos. Ninguna referencia a `infra/docker-compose.yml` queda en los docs.
- **Resultado**: pendiente

## T3 · Prueba real
- **Contexto (leer solo esto)**: `docs/specs/019-docker-local/spec.md#criterios-de-aceptación`, `docs/specs/019-docker-local/plan.md#contratos`
- **Hacer**: `POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose up -d --wait`. Después `db:migrate` ×2, `db:seed` y `ci:db`, con `DATABASE_URL`, `MIGRATIONS_DATABASE_URL` y `REDIS_URL` apuntando a esos puertos en la línea de comando. Comprobar la persistencia tras `down`. Hacer `down -v`, subir de nuevo y confirmar la BD limpia. Dejar el compose parado con `down -v`. No se toca `.env` ni los PostgreSQL y Redis nativos.
- **Hecho cuando**: CA-1 a CA-4 cumplidos. `ci:db` pasa, con los números en Resultado, o el fallo queda anotado con detalle.
- **Resultado**: pendiente

## T4 · Cierre
- **Hacer**: marcar T1–T4 con `[x]` y Resultado. Commits Conventional con trailer. Sin push. No se toca `docs/specs/ESTADO.md`.
- **Hecho cuando**: commits en `spec/019-docker-local` y árbol de trabajo limpio salvo lo excluido.
- **Resultado**: pendiente
