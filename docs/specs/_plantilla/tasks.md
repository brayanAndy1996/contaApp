# Tareas NNN · <nombre>

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Pruebas de <…> (rojo) | tester | sonnet | — | ✓ | — | [ ] |
| T2 | Implementar <…> | backend | opus | T1 | ✓ | — | [ ] |
| T3 | Pantalla <…> | frontend | sonnet | contrato del plan ∥ | — | — | [ ] |
| T4 | Ronda adversarial de <…> (1 ronda; 2.ª solo con hallazgos media/alta) | adversario | opus | T2 | — | ✓ | [ ] |
| T5 | Corregir hallazgos | backend | opus | T4 | — | — | [ ] |
| T6 | Verificar criterios + PR en borrador con CI completo en verde | tester | sonnet | T5, T3 | — | — | [ ] |
| T7 | Cerrar: commit + estado | devops | haiku | T6 | — | — | [ ] |

Escalamientos: <tarea · de modelo X a Y · motivo>

<!-- Modelo: una palabra (opus, sonnet, haiku; rol secundario entre paréntesis). ADV y revisión final en opus si spec.md declara un área crítica; si no, sonnet. Lo valida `pnpm specs:validar` y lo exige el hook de 043. -->

<!-- Cada tarea: 6 líneas o menos. Resultados y evidencias van a resultados.md, no aquí (04-metodologia §7 regla 13). -->

## T1 · <título>
- **Contexto (leer solo esto)**: `ruta/a/archivo.ts`, `docs/specs/NNN/plan.md#contratos`
- **Hacer**: <instrucción concreta>
- **Hecho cuando**: <verificable: prueba X pasa / comando Y sin errores / CA-n cumplido>

## T2 · …
