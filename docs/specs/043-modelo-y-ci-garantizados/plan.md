# Plan 043 · Modelo y CI completo garantizados

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `.claude/settings.json` | Hook `PreToolUse` con matcher `Agent\|Task` → `node "$CLAUDE_PROJECT_DIR/.claude/hooks/modelo-tarea.mjs"` |
| crear | `.claude/hooks/modelo-tarea.mjs` | Entrada del hook: lee el JSON de stdin, llama a `decidir()`, escribe el registro y sale con 0 o 2 |
| crear | `.claude/hooks/lib/modelo.mjs` | Funciones puras: `referenciaTarea`, `modeloDeFila`, `modeloEfectivo`, `decidir` |
| crear | `.claude/hooks/modelo.test.mjs` | Pruebas con `node:test` de CA-1 a CA-4 y fixtures |
| crear | `scripts/specs-validar.mjs` (+ `.test.mjs`) | Validador A4 |
| modificar | `package.json` (raíz) | `specs:validar` y `hooks:test` |
| modificar | `.github/workflows/ci.yml` | Nivel 1: `pnpm hooks:test` y `pnpm specs:validar`. Nivel 2: builds con `--filter "<paquete>..."` |
| modificar | `docs/04-metodologia.md` | §3.1 (hook y registro), §5 DoD (CI completo), §7 regla 14 |
| modificar | `docs/specs/_plantilla/{spec,tasks}.md` | Línea «Áreas críticas», modelo de una palabra, verificación con PR en borrador |
| modificar | `docs/prompt-orquestador.md` | Formato `Tarea: docs/specs/NNN-*/tasks.md#Tn` y `model` siempre explícito |
| modificar | `docs/specs/ESTADO.md` | Fila de la 043 |

## Contratos
**Entrada del hook** (stdin, JSON de Claude Code): `{ tool_name, tool_input: { subagent_type, model?, effort?, prompt, description } }`.

**Salida**: código 0 para permitir. Código 2 para bloquear, con un mensaje de una línea en stderr, por ejemplo: `043: T12 de 029 exige opus; pediste sonnet. Relanza con model: "opus".`

**Referencia de tarea**: expresión regular `Tarea:\s*(docs/specs/[\w.-]+)/tasks\.md#(T[\w]+)`. La fila de la tarea es la de la tabla cuya primera celda es exactamente `Tn`.

**Celda «Modelo»**: la primera palabra que coincide con `opus|sonnet|haiku` es el modelo exigido. Un `(x)` entre paréntesis corresponde al rol secundario y se ignora.

**Modelo efectivo**: `tool_input.model` si existe, si no el `model:` del frontmatter de `.claude/agents/<subagent_type>.md`. Los alias se normalizan: `claude-opus-*` → opus, y así con los demás.

**Línea del registro** (`agentes.log`, separada por tabuladores): `ISO-8601  Tn  rol  modelo  effort  permitido|bloqueado|escalado`.

## Decisiones
- La lógica vive en un módulo puro y probado; la entrada solo hace IO. Así las pruebas no simulan stdin.
- El registro se escribe también al bloquear, para que quede el intento.
- `specs:validar` toma el estado de `ESTADO.md` (el `Estado:` de las specs antiguas está desactualizado) y revisa solo las carpetas cuya fila no está `hecha`; las cerradas no se reescriben. Las pruebas usan textos en línea en vez de archivos de fixture.
- `--filter "@contapp/db..."` incluye las dependencias del espacio de trabajo en orden topológico; ya es lo que hace `pnpm build` en el nivel 1.

## Riesgos
- **El formato de entrada del hook cambia en una versión de Claude Code.** Las pruebas usan un fixture con el formato actual. Si falta `tool_input`, el hook permite el lanzamiento y escribe `formato desconocido` en el registro, para no frenar todo el trabajo. CA-7 lo prueba en una sesión real.
- **Una variable de entorno fija el modelo de los subagentes** (por ejemplo `CLAUDE_CODE_SUBAGENT_MODEL`) y el modelo real difiere del calculado. El hook registra esa variable si existe y se documenta en §3.1.
- **Falso bloqueo por una celda mal escrita.** El validador A4 la detecta en el CI antes de ejecutar las tareas.
