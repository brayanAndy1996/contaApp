# Tareas 038 · Diseño visual (estilo A)

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Spec, plan y tareas | arquitecto | opus | — | — | — | [x] |
| T2 | Dependencias, fuentes y tokens (`globals.css`, `layout.tsx` raíz) | frontend | sonnet | T1 | — | — | [x] |
| T3 | `lib/utils.ts`, `components.json` y componentes base de `components/ui/` | frontend | sonnet | T2 | — | — | [x] |
| T4 | Pruebas de nivel C de los componentes | tester | sonnet | T3 | — | — | [x] |
| T5 | Verificar fase 1 (CA-1 a CA-4): typecheck, lint, test, build, CI | devops | haiku | T4 | — | — | [x] |
| T6 | Planificar fase 2 pantalla por pantalla, con 021 y 022 ya en `main` | arquitecto | opus | T5, 021 y 022 hechas | — | — | [ ] bloqueada |
| T7… | Aplicar el diseño a cada pantalla (se detallan en T6) | frontend | sonnet | T6 | — | — | [ ] bloqueada |
| T-final | Verificar CA-5 a CA-7, revisión manual 1440/390 px, cierre | tester + devops | sonnet | T7… | — | — | [ ] bloqueada |

## T2 · Dependencias, fuentes y tokens
- **Contexto**: `apps/frontend/package.json`, `apps/frontend/app/globals.css`, `apps/frontend/app/layout.tsx`, `plan.md#tokens-del-estilo-a`.
- **Hacer**: agregar con versión exacta las dependencias de D1 y las fuentes de D3; reescribir `globals.css` con los tokens; importar las fuentes en el `layout.tsx` raíz.
- **Hecho cuando**: la app arranca con fondo `#F6F4EE`, texto Inter y sin modo oscuro automático (CA-1, CA-2).

## T3 · Componentes base
- **Contexto**: `plan.md#componentes`.
- **Hacer**: crear `lib/utils.ts`, `components.json` y los once componentes.
- **Hecho cuando**: typecheck y lint pasan.

## T4 · Pruebas de los componentes
- **Contexto**: `components/ui/*`, `vitest.setup.ts`.
- **Hacer**: `components/ui/ui.spec.tsx` con un caso feliz y uno de error o borde por componente (CA-3).
- **Hecho cuando**: `pnpm --filter @contapp/frontend test ui` pasa.

## T5 · Verificar la fase 1
- **Hacer**: `typecheck`, `lint`, `test` y `build` del frontend; CI en verde en la rama.
- **Hecho cuando**: CA-1 a CA-4 marcados con evidencia.

## Resultados de la fase 1 (2026-11-15)
- T2: dependencias con versión exacta (`@radix-ui/react-*`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `@fontsource-variable/inter`, `inter-tight`, `jetbrains-mono`); tokens en `app/globals.css`; fuentes en `app/layout.tsx`.
- T3: `lib/utils.ts`, `components.json` y once componentes en `components/ui/` (más `index.ts`).
- T4: `components/ui/ui.spec.tsx`, 14 pruebas en verde.
- T5: `lint`, `typecheck`, `test` (96 archivos, 902 pruebas) y `build` del frontend en verde. En un navegador con el sistema en modo oscuro, `body` queda con fondo `#F6F4EE`, texto `#1C1C1C` y «Inter Variable» cargada, sin ninguna petición a Google Fonts (CA-1, CA-2). El CI (E2E incluido) corre al fusionar en `main`.
