# Tareas 039 · Actualizar Next.js (parche de seguridad en 16.x)

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Spec y tareas (`docs(039)`) | devops | haiku | — | — | — | [x] |
| T2 | `next` a 16.4.5 y lockfile regenerado (`pnpm install`) | devops | haiku | T1 | — | — | [x] |
| T3 | Aviso de auditoría y build en frío (dos ejecuciones) | devops | haiku | T2 | — | — | [x] |
| T4 | Typecheck, lint y pruebas con `TZ=America/Lima` y `TZ=UTC` | devops | haiku | T2 | — | — | [x] |
| T5 | E2E completo y `@volumen` | devops | haiku | T3, T4 | — | — | [x] |
| T6 | Cerrar: estado, commit `chore(039)`, sin push | devops | haiku | T5 | — | — | [x] |

Escalamientos: ninguno. Si la corrección exigiera una versión mayor, la tarea para y se reporta sin actualizar.

## T1 · Spec y tareas
- **Contexto (leer solo esto)**: `docs/specs/_plantilla/spec.md`, `docs/specs/_plantilla/tasks.md`
- **Hacer**: escribir `spec.md` y `tasks.md`. Commit `docs(039): spec y tareas`.
- **Hecho cuando**: ambos archivos están en `docs/specs/039-actualizar-next/` y el commit existe.
- **Resultado**: commit `9a77e62` (`docs(039): spec y tareas`).

## T2 · `next` a 16.4.5 y lockfile regenerado
- **Contexto (leer solo esto)**: `apps/frontend/package.json`
- **Hacer**: cambiar `"next": "16.4.3"` por `"next": "16.4.5"` (exacta). Desde la raíz, `pnpm install`. No editar `pnpm-lock.yaml` a mano.
- **Hecho cuando**: `pnpm install` sale con 0 y el diff de `pnpm-lock.yaml` solo toca `next` y sus `@next/*` transitivos.
- **Resultado**: `pnpm install` sale con 0 (pnpm 10.12.1, Node 22.22.0). El diff del lock son 82 líneas (41 + y 41 −): `next` y 9 `@next/*` (`env` y 8 `swc`) de 16.4.3 a 16.4.5, sin otra dependencia. `apps/frontend/node_modules/next` queda en 16.4.5.

## T3 · Aviso de auditoría y build en frío
- **Contexto (leer solo esto)**: ninguno.
- **Hacer**:
  1. `pnpm audit --prod`: GHSA-mfr8-8qww-v76h no debe aparecer.
  2. Borrar `apps/frontend/.next` y ejecutar `pnpm --filter @contapp/frontend build`.
  3. Repetir el build con la caché limpia, más de 5 minutos después del primero.
- **Hecho cuando**: el audit no lista el aviso de `next`, y los dos builds salen con 0 en el primer intento.
- **Resultado**: `pnpm audit --prod` ya no lista ningún aviso de `next`. Quedan 6 avisos de otras dependencias, fuera de alcance (`fflate`, `multer`, `nodemailer` x3, `fast-xml-parser`). Build 1 (inicio 15:59:25, caché limpia): exit 0. Build 2 (inicio 16:05:26, caché limpia, 6 min después): exit 0. `SecurityFatalError` en ambos: 0.

## T4 · Typecheck, lint y pruebas
- **Contexto (leer solo esto)**: `apps/frontend/package.json`
- **Hacer**: `pnpm --filter @contapp/frontend typecheck`, `pnpm --filter @contapp/frontend lint`, `TZ=America/Lima pnpm --filter @contapp/frontend test` y `TZ=UTC pnpm --filter @contapp/frontend test`. Responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo.
- **Hecho cuando**: los cuatro comandos salen con 0.
- **Resultado**: typecheck OK; lint OK (`--max-warnings=0`). Pruebas: `America/Lima` OK, 112 archivos y 1001 tests; `UTC` OK, 112 archivos y 1001 tests.

## T5 · E2E completo y `@volumen`
- **Contexto (leer solo esto)**: `tests/e2e/package.json`. El `.env` se carga en el shell; no se imprime.
- **Hacer**: `set -a && . ./.env && set +a && E2E_CORREO=consola flock /tmp/contapp-e2e.lock pnpm e2e --trace off`, y después lo mismo con `pnpm e2e:volumen --trace off`. No ejecutar `playwright install`. No hacer DROP ni borrar filas.
- **Hecho cuando**: ambos comandos salen con 0.
- **Resultado**: `pnpm e2e` exit 0: 88 passed (1.1 min). Las 4 pruebas `test.fail()` de la vigilancia (`flujos/soporte.e2e.ts`) salen con ✘ en la lista y cuentan como esperadas. `pnpm e2e:volumen` exit 0: 2 passed (9.7 s).

## T6 · Cerrar
- **Contexto (leer solo esto)**: `docs/specs/039-actualizar-next/tasks.md`, `docs/specs/039-actualizar-next/spec.md`
- **Hacer**: marcar T2 a T5 como `[x]`, poner el estado de la spec y commitear con `git add` de rutas explícitas (`apps/frontend/package.json`, `pnpm-lock.yaml`, `docs/specs/039-actualizar-next/*`). Mensaje `chore(039): next a 16.4.5`. Sin push. Línea para `ESTADO.md` en el resultado.
- **Hecho cuando**: el commit existe y el resultado incluye la línea para `ESTADO.md`.
- **Resultado**: commit `chore(039): next a 16.4.5` con las rutas explícitas. Sin push. Línea para `ESTADO.md` en el informe final.
