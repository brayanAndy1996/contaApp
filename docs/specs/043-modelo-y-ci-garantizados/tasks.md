# Tareas 043 · Modelo y CI completo garantizados

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Pruebas del hook y del validador (rojo) | tester | sonnet | spec aprobada | ✓ | — | [ ] |
| T2 | Hook `modelo-tarea` y `settings.json` | devops | sonnet | T1 | ✓ | — | [ ] |
| T3 | Validador `specs:validar` | devops | sonnet | T1 ∥ T2 | ✓ | — | [ ] |
| T4 | CI: nivel 1 con hooks y validador; nivel 2 con `--filter "<paquete>..."` | devops | haiku | T2, T3, 029 en `main` | — | — | [ ] |
| T5 | Metodología, plantillas y prompt del orquestador | devops | haiku | T2 ∥ T4 | — | — | [ ] |
| T6 | Verificar CA-1 a CA-7 (sesión real + PR en borrador con CI completo) | tester | sonnet | T4, T5 | — | — | [ ] |
| T7 | Cierre: `tasks.md`, `cierre.md`, `ESTADO.md` y commit | devops | haiku | T6 | — | — | [ ] |

Escalamientos: —

## T1 · Pruebas (rojo)
- **Contexto**: `spec.md#criterios-de-aceptación`, `plan.md#contratos`.
- **Hacer**: `.claude/hooks/modelo.test.mjs` y `scripts/specs-validar.test.mjs` con `node:test`, con fixtures de CA-1 a CA-5 (incluidos el alias `claude-opus-*`, la celda `opus (sonnet)`, la tarea inexistente y la falta de `tool_input`).
- **Hecho cuando**: `node --test .claude/hooks scripts` falla solo porque faltan los módulos.

## T2 · Hook
- **Contexto**: `plan.md` (completo), pruebas de T1.
- **Hacer**: `lib/modelo.mjs` puro, `modelo-tarea.mjs` (stdin → `decidir` → registro → salida 0 o 2) y `.claude/settings.json`.
- **Hecho cuando**: las pruebas del hook pasan y `echo '<fixture>' | node .claude/hooks/modelo-tarea.mjs` sale con 2 y el mensaje del contrato.

## T3 · Validador
- **Contexto**: `plan.md#contratos`, pruebas de T1.
- **Hacer**: `scripts/specs-validar.mjs` y los scripts `specs:validar` y `hooks:test` en `package.json`.
- **Hecho cuando**: sus pruebas pasan y `pnpm specs:validar` pasa sobre `main`. Si falla por specs abiertas mal escritas, corregir solo su celda «Modelo» y anotarlo en `resultados.md`.

## T4 · CI
- **Contexto**: `.github/workflows/ci.yml` (pasos «Build de …» y job `ci`).
- **Hacer**: agregar `pnpm hooks:test` y `pnpm specs:validar` al job `ci`. Cambiar cada build parcial de nivel 2 por `pnpm --filter "<paquete>..." build`.
- **Hecho cuando**: el `ci.yml` es válido y el CI de nivel 1 pasa en la rama.

## T5 · Documentación
- **Contexto**: `04-metodologia.md` §3.1, §5 y §7 regla 14; `_plantilla/spec.md`, `_plantilla/tasks.md`; `prompt-orquestador.md` (pasos 5 y 8).
- **Hacer**: reflejar A1 a A4 y B2 con cambios puntuales, sin reescribir secciones.
- **Hecho cuando**: CA-7 (parte documental) se cumple y cada archivo cambia en 15 líneas o menos.

## T6 · Verificación
- **Contexto**: `spec.md#criterios-de-aceptación`.
- **Hacer**: en una sesión nueva, lanzar un `adversario` con `sonnet` sobre la fixture (debe bloquearse) y luego con `opus` (debe pasar). Revisar `agentes.log`. Abrir el PR en borrador y esperar el CI completo. Evidencia en `resultados.md`.
- **Hecho cuando**: CA-1 a CA-7 tienen evidencia y el CI completo está en verde.

## T7 · Cierre
- **Contexto**: plantilla `cierre.md`, `ESTADO.md`.
- **Hacer**: marcar las tareas, escribir `cierre.md` y actualizar la fila de `ESTADO.md`.
- **Hecho cuando**: el commit está en la rama y el PR pasa de borrador a listo.
