# Tareas 040 · Avisos de dependencias de `pnpm audit --prod`

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Spec y tareas (`docs(040)`) | devops | haiku | — | — | — | [x] |
| T2 | Auditoría: avisos, `why`, fechas de publicación y versiones | devops | haiku | T1 | — | — | [x] |
| T3 | Versiones en `package.json`, overrides y `pnpm install` | devops | haiku | T2 | — | — | [ ] |
| T4 | `pnpm audit --prod` limpio y regla de 2 semanas | devops | haiku | T3 | — | — | [ ] |
| T5 | Pruebas XML adversariales (UBL y lector-xlsx) | devops | haiku | T3 | — | — | [ ] |
| T6 | Typecheck, lint y unitarias de todos los paquetes | devops | haiku | T3 | — | — | [ ] |
| T7 | Integración de backend y worker, y `tests/aislamiento`, con BD `contapp_040` | devops | haiku | T3 | — | — | [ ] |
| T8 | Frontend con `TZ=America/Lima` y `TZ=UTC` | devops | haiku | T3 | — | — | [ ] |
| T9 | E2E completo y `@volumen` | devops | haiku | T4, T5, T6, T7, T8 | — | — | [ ] |
| T10 | Cerrar: estado, commit `chore(040)`, sin push | devops | haiku | T9 | — | — | [ ] |

Escalamientos: ninguno previsto. Si una comprobación falla una vez en la misma tarea, la tarea para y se reporta. Si una corrección exigiera una versión mayor, se reporta sin actualizar.

## T1 · Spec y tareas
- **Contexto (leer solo esto)**: `docs/specs/_plantilla/spec.md`, `docs/specs/_plantilla/tasks.md`, `docs/specs/039-actualizar-next/spec.md`
- **Hacer**: escribir `spec.md` y `tasks.md`. Commit `docs(040): spec y tareas`.
- **Hecho cuando**: ambos archivos están en `docs/specs/040-avisos-dependencias/` y el commit existe.
- **Resultado**: commit con el hash que consta en el mensaje de `chore(040)` (`docs(040): spec y tareas`).

## T2 · Auditoría
- **Contexto (leer solo esto)**: ninguno. Herramientas: `pnpm audit --prod --json`, `pnpm -r why <pkg>`, `pnpm view <pkg> time`.
- **Hacer**: por aviso, paquete, GHSA, rango vulnerable, versión parcheada, uso y si es directa o transitiva. Fecha de publicación de cada parche candidato. Confirmar qué módulos usan `fast-xml-parser` y `fflate`.
- **Hecho cuando**: la tabla de `spec.md` está completa.
- **Resultado**: `pnpm audit --prod` da 6 avisos en 4 paquetes: `multer` 2.4.0 (alta, GHSA-q7qp-rjg7-q26m), `nodemailer` 10.1.0 (3 moderadas: GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h), `fflate` 0.8.2 (moderada, GHSA-px8p-9vwx-vf98) y `fast-xml-parser` 5.11.2 (baja, GHSA-474x-hrwr-fgx4). Parches: multer 2.5.0, nodemailer 10.1.4, fflate 0.8.3, fast-xml-parser 5.12.0. Confirmado: `fast-xml-parser` lo usan `packages/domain/src/ubl/leer.ts` (016) y `apps/backend/src/modules/importacion/lector-xlsx.ts`. `fflate` es directa en `apps/backend` y también en `packages/sunat`. `multer` llega por `@nestjs/platform-express` 12.2.0. Detalle en `spec.md`.

## T3 · Versiones, overrides y `pnpm install`
- **Contexto (leer solo esto)**: `apps/backend/package.json`, `packages/sunat/package.json`, `packages/domain/package.json`, `pnpm-workspace.yaml`
- **Hacer**:
  1. `apps/backend/package.json`: `"fflate": "0.8.3"`, `"fast-xml-parser": "5.12.0"`, `"nodemailer": "10.1.4"`, `"@nestjs/platform-express": "^12.3.0"`.
  2. `packages/sunat/package.json`: `"fflate": "0.8.3"`. `packages/domain/package.json`: `"fast-xml-parser": "5.12.0"`.
  3. `pnpm-workspace.yaml`, `overrides`: `is-unsafe` pasa de `2.0.2` a `2.0.3` (5.12.0 exige `^2.0.3`) y se añade `fast-xml-builder: 1.3.1`. Cada uno con su comentario.
  4. Desde la raíz, `pnpm install`. No editar `pnpm-lock.yaml` a mano.
- **Hecho cuando**: `pnpm install` sale con 0 y el diff del lock solo toca los paquetes de la tabla de `spec.md` y sus transitivas.
- **Resultado**: pendiente.

## T4 · `pnpm audit --prod` limpio y regla de 2 semanas
- **Contexto (leer solo esto)**: `docs/specs/040-avisos-dependencias/spec.md` (tabla de avisos)
- **Hacer**: `pnpm audit --prod` debe salir sin avisos. `pnpm -r why` de `multer`, `fflate`, `nodemailer`, `fast-xml-parser`, `is-unsafe` y `fast-xml-builder`: ninguna versión vulnerable en ningún workspace, incluido `apps/worker`. Para cada paquete que cambia o entra en el lock, `pnpm view <pkg>@<versión> time` (≥ 2 semanas respecto del 2026-11-17).
- **Hecho cuando**: CA-1 y CA-2 cumplidos. La lista de versiones con su fecha va en el resultado.
- **Resultado**: pendiente.

## T5 · Pruebas XML adversariales
- **Contexto (leer solo esto)**: `packages/domain/src/ubl/seguridad.spec.ts`, `packages/domain/src/ubl/ronda1.adv.spec.ts`, `apps/backend/src/modules/importacion/lector-xlsx.adv.spec.ts`, `apps/backend/src/modules/importacion/lector-ventas.adv.spec.ts`
- **Hacer**: `set -a && . ./.env && set +a`, luego `pnpm --filter @contapp/domain exec vitest run src/ubl` y `pnpm --filter @contapp/backend exec vitest run src/modules/importacion`. Responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo.
- **Hecho cuando**: ambos comandos salen con 0. Conteo de pruebas de `ubl/` y de `importacion/` en el resultado.
- **Resultado**: pendiente.

## T6 · Typecheck, lint y unitarias
- **Contexto (leer solo esto)**: `package.json` raíz (scripts `typecheck`, `lint`, `test`)
- **Hacer**: desde la raíz, `set -a && . ./.env && set +a` y luego `pnpm typecheck`, `pnpm lint`, `pnpm test`. Responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo por paquete.
- **Hecho cuando**: los tres comandos salen con 0.
- **Resultado**: pendiente.

## T7 · Integración y aislamiento con `contapp_040`
- **Contexto (leer solo esto)**: `package.json` raíz (scripts `db:migrate`, `db:seed`, `test:aislamiento`), `apps/worker/package.json`, `apps/backend/package.json`
- **Hacer**:
  1. Crear la BD nueva `contapp_040` con el rol de superusuario local. No hacer DROP de `contapp` ni borrar filas.
  2. Por comando: `set -a && . ./.env && set +a`, y después `DATABASE_URL` y `MIGRATIONS_DATABASE_URL` apuntando a `contapp_040`. No imprimir el `.env`.
  3. `pnpm db:migrate`, `pnpm db:seed`, `pnpm test:aislamiento`, `pnpm --filter @contapp/worker test:int`, `pnpm --filter @contapp/backend test:int`.
  4. No ejecutar `ci:cierre` (su script `despejar-bd.ts` limpia la BD).
- **Hecho cuando**: los cinco comandos salen con 0.
- **Resultado**: pendiente.

## T8 · Frontend en Lima y UTC
- **Contexto (leer solo esto)**: `apps/frontend/package.json`
- **Hacer**: `pnpm --filter @contapp/frontend typecheck`, `pnpm --filter @contapp/frontend lint`, `TZ=America/Lima pnpm --filter @contapp/frontend test` y `TZ=UTC pnpm --filter @contapp/frontend test`. Responder solo fallos o «OK» + conteo.
- **Hecho cuando**: los cuatro comandos salen con 0.
- **Resultado**: pendiente.

## T9 · E2E completo y `@volumen`
- **Contexto (leer solo esto)**: `tests/e2e/package.json`. El `.env` se carga en el shell y no se imprime.
- **Hacer**: `set -a && . ./.env && set +a && E2E_CORREO=consola flock /tmp/contapp-e2e.lock pnpm e2e --trace off`, y después `pnpm e2e:volumen --trace off`. No ejecutar `playwright install`. No hacer DROP ni borrar filas. Si no responden los servicios: `pg_ctlcluster 17 main start` y `cd /tmp && redis-server --daemonize yes --dir /tmp`.
- **Hecho cuando**: ambos comandos salen con 0.
- **Resultado**: pendiente.

## T10 · Cerrar
- **Contexto (leer solo esto)**: `docs/specs/040-avisos-dependencias/tasks.md`, `docs/specs/040-avisos-dependencias/spec.md`
- **Hacer**: marcar T3 a T9 como `[x]` con su resultado, poner la spec en `verificada` y anotar el hash de T1. Commitear con `git add` de rutas explícitas: `apps/backend/package.json`, `packages/sunat/package.json`, `packages/domain/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `docs/specs/040-avisos-dependencias/spec.md` y `docs/specs/040-avisos-dependencias/tasks.md`. Mensaje `chore(040): avisos de dependencias`. Sin push. Línea para `ESTADO.md` en el informe final.
- **Hecho cuando**: el commit existe y el informe incluye la línea para `ESTADO.md`.
- **Resultado**: pendiente.
