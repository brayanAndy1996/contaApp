# Tareas 022 · Rendimiento de R1 antes de buzones

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con las indicadas (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel B (04 §2.1): TDD donde aplica, ronda ADV solo en el despachador. Flujo 04 §1.3: línea base → implementar con TDD → ADV → verificar → revisión → cerrar. Rama `spec/022-rendimiento`. RP, CA y P (decididas el 2026-11-13) = `spec.md`; archivos y decisiones D-n = `plan.md`. Las tareas marcadas **[021]** tocan `packages/db/src/compras` o la grilla de compras: hay riesgo de conflicto con la spec 021 en paralelo (tabla en `plan.md`).

| #   | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
| --- | ----- | --- | ------ | ---------- | --- | --- | ------ |
| T1  | Línea base de RP-1 a RP-6 y perfilado de Ctrl+Z y CA-13 (CA-1) | tester | sonnet | — | — | — | [ ] |
| T2  | RP-1: `pistasPrevias` acotada a `TRAMO_PISTAS` (CA-2, CA-4, CA-5) | backend | sonnet | T1 ∥ T5, T6, T7, T12 | sí | — | [ ] |
| T3  | RP-1: ronda ADV del despachador, G1 a G4 con N > K (CA-3) | adversario | opus | T2 | — | sí | [ ] |
| T4  | RP-1: corregir los hallazgos de T3 (solo si hay) | backend | sonnet | T3 | sí | — | [ ] |
| T5  | RP-2: `leerExistentesCompras` con `join lateral` **[021]** (CA-6, CA-7) | backend | sonnet | T1 ∥ T2, T6, T7, T12 | sí | — | [ ] |
| T6  | RP-3: venta por id en excluir/restaurar (CA-8, CA-9) | backend | sonnet | T1 ∥ T2, T5, T7, T12 | sí | — | [ ] |
| T7  | RP-4: `avisosOmitidos` en `shared` y en el previo (CA-10) | backend | sonnet | T1 ∥ T2, T5, T6, T12 | sí | — | [ ] |
| T8  | RP-4: «y N avisos más» en el panel del previo (CA-11) | frontend | sonnet | T7 ∥ T2, T5, T6, T9, T10, T12 | sí | — | [ ] |
| T9  | RP-5: Ctrl+Z, parte del servidor, si domina **[021]** (CA-12) | backend | sonnet | T1 ∥ T2, T6, T7, T10; después de T5 si comparten archivo | sí | — | [ ] |
| T10 | RP-5: Ctrl+Z, recarga y resumen del frontend, si domina **[021]** (CA-12) | frontend | sonnet | T1 ∥ T2, T5, T6, T7, T9, T12 | sí | — | [ ] |
| T11 | RP-5: E-06 con tope de 3 s y resultado final (CA-12) | tester | sonnet | T9, T10 | — | — | [ ] |
| T12 | RP-6: margen de CA-13 por la causa dominante **[021]** (CA-13) | backend | sonnet | T1 ∥ T2, T5, T6, T7, T9, T10 | — | — | [ ] |
| T13 | Verificar CA-1 a CA-15 | tester | sonnet | T4, T5, T6, T8, T11, T12 | — | — | [ ] |
| T14 | Revisión final contra la spec | arquitecto | opus | T13 | — | — | [ ] |
| T15 | Cierre: `tasks.md`, `spec.md`, notas de `ESTADO.md` y commit | devops | haiku | T14 | — | — | [ ] |

Paralelismo: tras T1 pueden ir juntas T2, T5, T6, T7, T9, T10 y T12 (T8 en cuanto termine T7). Cada una es dueña de sus archivos (columna «Archivos» de `plan.md`):
- T2/T3/T4: `packages/queue/src/despachador.ts` y `despachador-022*.spec.ts`. Ninguna otra tarea lo toca.
- T5: `packages/db/src/compras/existentes.ts` y su prueba.
- T6: `packages/db/src/ventas/lectura.ts`, `packages/db/src/index.ts` (solo la línea de exportación), `exclusion.service.ts` y sus pruebas.
- T7/T8: `packages/shared/src/archivos/respuestas.ts`, `previo.ts`, `previo-archivo.tsx`, `lib/archivos.ts` (solo el mensaje).
- T9: backend de compras y `packages/db/src/compras/{operaciones,versiones}.ts`. Si necesita un archivo de T5 o de T12, espera a que esa tarea haga commit.
- T10: `deshacer-compras.tsx`, `barra-masiva.tsx`, `grilla-compras.tsx`.
- T12: worker de `generar-archivo` y, si el perfilado lo exige, `filas-reemplazo.ts`.
- `packages/db/src/index.ts` lo editan T6 (y quizá T9); si se cruzan, hacen commit una tras otra.

T11 espera a T9 y T10. T3 espera a T2: el adversario ataca el código ya implementado. T4 solo existe si T3 deja hallazgos de producción; si no, se marca `[x]` «sin hallazgos». T5, T9, T10 y T12 hacen rebase sobre `main` antes de cerrar si 021 ya integró.

Escalamientos: T15 pasa a `sonnet` si `haiku` falla una vez. Una tarea que falle 2 veces por intermitencia pasa a `opus`. Una meta de tiempo que no se alcanza (T2, T5, T6, T9, T10, T12) es un hallazgo de rendimiento: se escala al orquestador con la medida; no se sube el límite, no se relaja la meta ni se reintenta.

Reglas comunes:
- Un commit por tarea (Conventional Commits `test(022): …`, `perf(022): …`, `feat(022): …`, `docs(022): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push del subagente: el orquestador lo hace.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` ajenos: `git add <rutas>` explícitas, nunca `-A` ni `.`. Nunca leer ni imprimir `.env`. Sin `reset`, `stash` ni `clean`. Sin tocar la BD de otras ramas.
- Sin `retry`, `skip`, `fixme` ni `test.only`. No se quita ninguna aserción ni se sube ningún límite de tiempo (CA-14). Las pruebas de tiempo usan `medirMediana` (≥ 3 muestras) y no comparan bajo `CONTAPP_COBERTURA=1`.
- TDD: la prueba nueva se escribe y se ve fallar antes del cambio (anotar el fallo en Resultado). Correr solo las pruebas del paquete tocado; la corrida completa con carga, en T13.
- El tester no toca código de producción. El frontend no edita `tests/e2e`. Ningún paquete gana dependencias.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo.
- Una ambigüedad nueva que cambie la spec no se decide: `requiere usuario`.

## T1 · [ ] Línea base y perfilado (tester · sonnet)
- **Contexto**: `spec.md` (alcance, CA-1, CA-12, CA-13), `plan.md` (tabla «Línea base», D-6, D-7), `packages/queue/src/despachador.ts` (`pistasPrevias`, `atenderEstudio`), `packages/queue/src/soporte-pruebas/int.ts`, `packages/db/src/compras/existentes.ts`, `apps/backend/src/modules/ventas/exclusion.service.ts:85-100`, `apps/backend/src/modules/archivos/previo.ts:120-260`, `tests/e2e/flujos/volumen.e2e.ts`, `apps/worker/src/trabajos/procesadores/generar-archivo.int.spec.ts` (bloque CA-13).
- **Hacer**: medir RP-1 a RP-6 en el volumen de `plan.md` (mediana de 3; RP-1 de 5), sin carga, con el código actual, usando arneses temporales fuera de `src/` (scratchpad o `*.medicion.int.spec.ts` sin commit). E-06: anotar por separado `tiempo-deshacer-llamada`, `tiempo-deshacer-recarga` y `tiempo-deshacer-total` (sin cambiar el tope; es la única edición que se confirma). Perfilar por fase el Ctrl+Z (servidor, recarga, render, resumen) y la generación de 20.000 filas (lectura, armado, serialización, ZIP, SHA-256, almacenamiento). Llenar la tabla «Línea base» de `plan.md`, nombrar la fase dominante de RP-5 y de RP-6 y recomendar si T9, T10 o ambas aplican.
- **Hecho cuando**: la tabla de `plan.md` no tiene «pendiente»; el reparto de RP-5 y de RP-6 está escrito con cifras; cada línea base ya cumple o no su objetivo (las que cumplen quedan como guarda de regresión); `volumen.e2e.ts` anota los tres tiempos y su único cambio es ese. Commit `test(022): línea base y tiempos separados de E-06`.

## T2 · [ ] RP-1 lectura acotada de pistas (backend · sonnet · TDD)
- **Contexto**: `spec.md` (RP-1, G1 a G4, CA-2, CA-4, CA-5; P-1 = b), `plan.md` (D-1, D-2), `packages/queue/src/despachador.ts` (`atenderEstudio`, `pistasPrevias`, `cerrarEstudioVacio`, `despuesDelCommit`), `packages/queue/src/despachador-t11c.int.spec.ts` y `despachador-t11c.adv.int.spec.ts` (arnés y Redis instrumentado), `packages/queue/src/soporte-pruebas/int.ts`.
- **Hacer**: escribir primero `despachador-022.int.spec.ts`: (a) con N = 2.000 y N = 20.000 pistas, una atención lee ≤ K elementos y hace ≤ K `leerTrabajo` (conteo de comandos); (b) convergencia: N = 20.000 restos con la BD sin `en_cola` queda vacía y fuera de `tenants` en ≤ ⌈N/K⌉ + 1 ciclos y sin bucle posterior; (c) CA-5 con Redis real, mediana de 5, ≤ 100 ms y ≤ 1,5 × (N = 100), solo sin cobertura. Verlas fallar. Luego definir `TRAMO_PISTAS = 500` y acotar `pistasPrevias` (D-1); `cerrarEstudioVacio` y el resto sin cambios.
- **Hecho cuando**: las pruebas nuevas pasan; `despachador-t11c.adv.int.spec.ts` (A1 a A11), `despachador-t11c.int.spec.ts`, `despachador-r1b.adv.int.spec.ts`, `despachador-r2a.adv.int.spec.ts`, `despacho.int.spec.ts` y `despachador.spec.ts` pasan sin cambiar ninguna aserción (`git diff` de esos archivos vacío); `grep -n '"0", "-1"' packages/queue/src/despachador.ts` vacío; typecheck y lint de `queue` limpios. Commit `perf(022): lectura acotada de pistas del despachador`.

## T3 · [ ] RP-1 ronda ADV del despachador (adversario · opus · ADV)
- **Contexto**: `spec.md` (G1 a G4, CA-3, CA-4), `plan.md` (D-1), `packages/queue/src/despachador.ts`, `despachador-t11c.adv.int.spec.ts` (para no repetir A1 a A11) y el arnés de `despachador-022.int.spec.ts`.
- **Hacer**: una ronda, ~15 pruebas en `despachador-022.adv.int.spec.ts` con N > K: G1 (publicación entre la lectura acotada y la lectura en BD no se borra, incluso con el id fuera del tramo y con el id ya dentro), G2 (un `ejecutando` que reintenta con el mismo id, dentro y fuera del tramo leído), G3 (nunca un trabajo en la lista con el estudio fuera de `tenants`, con publicación entre cada paso), G4 (sin bucle: resto no despachable, `ejecutando` que sigue así), cancelación entre ambas lecturas, fallo único del `ZRANGE` (devuelve `[]` y el estudio no se pierde), dos despachadores (líder que cambia) sobre la misma lista, tramo exactamente K, K + 1 y lista vacía. No se modifica código de producción: cada hallazgo se registra como `H-022-n` en `ESTADO.md` (sección de hallazgos) con severidad y prueba `archivo:línea`.
- **Hecho cuando**: las pruebas pasan o los hallazgos están listados con una prueba que falla marcada `it.fails`/anotada y su `archivo:línea` en el Resultado; sin `skip`/`retry`; sin quitar aserciones de otras suites. Commit `test(022): ronda adversarial del despachador`.

## T4 · [ ] RP-1 corregir hallazgos de la ronda ADV (backend · sonnet · TDD)
- **Contexto**: `tasks.md` (Resultado de T3), `despachador.ts` y la prueba del hallazgo.
- **Hacer**: por cada hallazgo de producción, la prueba de T3 ya falla; corregir con el cambio mínimo, sin cambiar K ni quitar garantías, y quitar la anotación de la prueba. Sin hallazgos, marcar `[x]` «sin hallazgos» y no hacer commit.
- **Hecho cuando**: todas las pruebas de `queue` (`pnpm --filter @contapp/queue test:int`) pasan y cada hallazgo figura como corregido en `ESTADO.md`. Commit `fix(022): hallazgos de la ronda adversarial del despachador`.

## T5 · [ ] RP-2 `leerExistentesCompras` con `join lateral` **[021]** (backend · sonnet · TDD)
- **Contexto**: `spec.md` (RP-2, CA-6, CA-7), `plan.md` (D-3, tabla de conflicto), `packages/db/src/compras/existentes.ts`, `packages/db/src/compras/filas-reemplazo.ts` (el `join lateral … offset 0` de `leerFilasReemplazo`), `packages/db/src/compras/repositorio.ts` (`UNION_ORIGINAL`), una prueba de `tests/aislamiento/` de compras para el arnés.
- **Hacer**: primero la prueba en `tests/aislamiento/`: equivalencia contra el oráculo `SQL_EXISTENTES_ANTERIOR` (mismo orden `clave, id`, mismos `campos`, versión 1, descartadas fuera) sobre un periodo con SIRE, agregadas, excluidas, descartadas, varias versiones y USD; y tiempo con 20.000 compras recién cargadas sin `ANALYZE` (mediana de 3 ≤ 1,0 s; t(20.000) ≤ 5 × t(5.000)). Verla fallar en tiempo. Luego reescribir solo el cuerpo de `SQL_EXISTENTES` con el mismo patrón que `leerFilasReemplazo`. Rebase sobre `main` antes de cerrar.
- **Hecho cuando**: equivalencia y tiempo pasan; `pnpm --filter @contapp/db test` y `pnpm test:aislamiento` en verde; las pruebas de `descarga` repetida (014) sin cambios y verdes; `git diff` de `existentes.ts` toca solo `SQL_EXISTENTES` (y su comentario); typecheck y lint limpios. Commit `perf(022): existentes de compras con join lateral`.

## T6 · [ ] RP-3 venta por id en excluir/restaurar (backend · sonnet · TDD)
- **Contexto**: `spec.md` (RP-3, CA-8, CA-9), `plan.md` (D-4), `apps/backend/src/modules/ventas/exclusion.service.ts`, `packages/db/src/ventas/lectura.ts` (`leerFilasVentas`, desde la línea 152), `exclusion.int.spec.ts`, `exclusion-r1.adv.int.spec.ts`.
- **Hacer**: primero las pruebas: espía que `leerFilasVentas` no se llama en excluir ni restaurar; 404 `no_encontrado` para id mal formado, de otro cliente, de otro periodo y de otro estudio (RLS); `no_excluida` al restaurar una no excluida; tiempo: periodo de 5.000 ventas, p95 de 20 repeticiones < 300 ms y mediana ≤ 2 × (100 ventas). Luego `leerFilaVenta` (D-4), su exportación y el cambio de `ventaDelPeriodo`.
- **Hecho cuando**: las pruebas nuevas y las de `exclusion*.spec.ts` (sin cambios) pasan; D12 (`tieneError`) y la auditoría no cambian (`git diff` solo en `ventaDelPeriodo` y `lectura.ts`/`index.ts`); typecheck y lint de `db` y `backend` limpios. Commit `perf(022): venta por id al excluir y restaurar`.

## T7 · [ ] RP-4 `avisosOmitidos` en el previo (backend · sonnet · TDD)
- **Contexto**: `spec.md` (RP-4, CA-10; P-2 = a), `plan.md` (D-5), `packages/shared/src/archivos/respuestas.ts` y `previo.spec.ts`, `apps/backend/src/modules/archivos/previo.ts` (líneas 195-260), `previo.int.spec.ts`.
- **Hacer**: primero las pruebas: previo con 5.000 avisos → `avisos.length` = 1.000 (los primeros, en el orden actual) y `avisosOmitidos` = 4.000; con ≤ 1.000, 0; el esquema acepta el campo y rechaza negativos; el TXT/ZIP y el SHA-256 del mismo periodo son idénticos antes y después. Luego el campo en el esquema y el corte en `previo.ts`.
- **Hecho cuando**: las pruebas pasan; `pnpm --filter @contapp/shared test` y `pnpm --filter @contapp/backend test` (archivos) en verde; `git diff` de `generar`/el worker vacío; typecheck y lint limpios. Commit `feat(022): tope de avisos del previo con avisosOmitidos`.

## T8 · [ ] RP-4 «y N avisos más» (frontend · sonnet · TDD)
- **Contexto**: `spec.md` (CA-11), `plan.md` (D-5), `apps/frontend/components/archivos/previo-archivo.tsx` (alrededor de la línea 106) y su prueba, `apps/frontend/lib/archivos.ts` (`M.erroresOmitidos`), `apps/frontend/pruebas/archivos.ts` (fixture del previo).
- **Hacer**: primero la prueba de componente: con `avisosOmitidos` > 0 se ve «y N avisos más»; con 0 no; el texto «Los avisos no impiden generar el archivo.» se conserva. Luego el mensaje y el render junto al de `erroresOmitidos`; actualizar el fixture con `avisosOmitidos: 0`.
- **Hecho cuando**: `pnpm --filter @contapp/frontend test` (archivos) verde; typecheck y lint limpios; sin dependencias nuevas. Commit `feat(022): aviso de avisos omitidos en el previo`.

## T9 · [ ] RP-5 Ctrl+Z, servidor **[021]** (backend · sonnet · TDD)
- **Contexto**: `spec.md` (RP-5, CA-12; P-3 = a), `plan.md` (D-6, tabla de conflicto), `plan.md` «Línea base» (reparto de T1), `apps/backend/src/modules/compras/masivas.service.ts`, `packages/db/src/compras/{operaciones,versiones}.ts`, `masivas.int.spec.ts`.
- **Hacer**: solo si T1 muestra que el servidor domina (si no, marcar `[x]` «no domina» con las cifras). Prueba de tiempo primero: `POST deshacer` de una masiva de 4.850 filas con la cota que T1 dejó como objetivo parcial (total ≤ 1,0 s con T10), sin cambiar el contrato HTTP; verla fallar. Luego optimizar lo dominante (p. ej. operaciones por lotes en vez de por fila) sin cambiar firmas públicas, estados ni la detección de `fila_cambiada`. Escribir la causa y el cambio en Resultado.
- **Hecho cuando**: la prueba de tiempo pasa; las pruebas de deshacer/rehacer de 014/015 (incluida `fila_cambiada`) pasan sin cambios; contrato HTTP idéntico (`git diff` de `packages/shared` vacío); typecheck y lint limpios. Commit `perf(022): deshacer masivo en el servidor`.

## T10 · [ ] RP-5 Ctrl+Z, recarga y resumen **[021]** (frontend · sonnet · TDD)
- **Contexto**: `spec.md` (RP-5, CA-12), `plan.md` (D-6), `plan.md` «Línea base», `apps/frontend/components/compras/{deshacer-compras,barra-masiva,grilla-compras}.tsx` y sus pruebas (`deshacer-compras.spec.tsx`, `grilla-compras*.spec.tsx`).
- **Hacer**: solo si T1 muestra que la recarga, el render o el resumen dominan (si no, `[x]` «no domina»). Primero una prueba que fije el comportamiento visible (las filas deshechas resaltadas igual y el resumen actualizado) y una que cuente recargas/renderizados evitables; verla fallar. Luego optimizar sin recargar solo la ventana visible (P-3 = b descartada) y sin cambiar el contrato ni el teclado de 015.
- **Hecho cuando**: las pruebas del frontend de compras pasan sin cambiar ninguna aserción; resaltado y resumen idénticos; `git diff` de `packages/shared` vacío; typecheck y lint limpios. Commit `perf(022): recarga del deshacer masivo en la grilla`.

## T11 · [ ] RP-5 E-06 con tope de 3 s (tester · sonnet)
- **Contexto**: `spec.md` (CA-12, CA-14), `tests/e2e/flujos/volumen.e2e.ts` (`TOPE_DESHACER_MS`, anotaciones de T1), `tests/e2e/README.md`.
- **Hacer**: correr `pnpm e2e:volumen` tres veces (a mano; sin carga) y registrar en Resultado llamada / recarga / total por corrida; si la mediana del total es > 1,0 s, parar y escalar (no tocar el tope). Si ≤ 1,0 s: bajar `TOPE_DESHACER_MS` de 10_000 a 3_000. No se sube ningún otro límite.
- **Hecho cuando**: mediana de 3 del total ≤ 1,0 s anotada; `TOPE_DESHACER_MS = 3_000`; `pnpm e2e` (suite normal) en verde; el diff del archivo es solo el tope. Commit `test(022): tope de E-06 del deshacer baja a 3 s`.

## T12 · [ ] RP-6 margen de CA-13 **[021]** (backend · sonnet)
- **Contexto**: `spec.md` (RP-6, CA-13; P-4 = a), `plan.md` (D-7, «Línea base»), `apps/worker/src/trabajos/procesadores/generar-archivo.ts`, `generar-archivo.int.spec.ts` (bloque CA-13, intacto), `packages/db/src/compras/filas-reemplazo.ts` (solo si T1 lo señala).
- **Hacer**: con el perfilado de T1, escribir en Resultado la causa dominante (fase y cifras) y optimizarla sin cambiar el contenido del TXT/ZIP ni el SHA-256 (comparar contra el de la línea base con el mismo periodo). Si 2,5 s exige reescribir el armado del archivo, parar y escalar con la medida; el límite de 5 s no se toca.
- **Hecho cuando**: mediana de compras de CA-13 ≤ 2,5 s (≥ 3 muestras, sin carga ni cobertura) con el límite de 5 s intacto; las suites `generar-archivo*.spec.ts` pasan sin cambiar aserciones; SHA-256 idéntico; causa escrita; typecheck y lint de `worker` limpios. Commit `perf(022): margen de la generación de archivo`.

## T13 · [ ] Verificar CA-1 a CA-15 (tester · sonnet)
- **Contexto**: `spec.md` (CA-1 a CA-15), `tasks.md` (Resultados de T1 a T12), `plan.md` (línea base), `package.json` (raíz: `ci:db`, `ci:cierre`, `e2e`, `e2e:volumen`).
- **Hacer**: tabla CA → evidencia (`archivo:línea` o comando). CA-3: las seis suites de `queue` sin diff de aserciones. CA-14: `git diff main..HEAD` con grep de límites de tiempo en `*.spec.ts`, `*.int.spec.ts` y `*.e2e.ts` (solo baja el de E-06) y grep de `retry`/`skip`/`only` en los archivos tocados. CA-15: suites de `queue`, `db`, `shared`, `backend`, `worker` y `frontend`, typecheck, lint, `pnpm ci:db`, `pnpm ci:cierre`, `pnpm e2e`; `pnpm e2e:volumen` una vez (resultado en `plan.md`). Tras el rebase sobre `main` (con 021 si ya integró), repetir CA-6 y CA-12. 3 corridas seguidas del CI (las lanza el orquestador).
- **Hecho cuando**: cada CA tiene evidencia o queda como faltante (CI pendiente se marca «pendiente: CI»). Un fallo vuelve a su tarea; no se reintenta. Commit `docs(022): verificación de criterios`.

## T14 · [ ] Revisión final contra la spec (arquitecto · opus)
- **Contexto**: `spec.md`, `plan.md`, `tasks.md` (Resultado de T13), `git diff main..HEAD --stat`.
- **Hacer**: comprobar con evidencia cada CA, que las decisiones P-1 a P-4 se cumplen tal cual (K acotado y un tramo por ciclo; primeros 1.000 + contador; Ctrl+Z ≤ 1,0 s y tope de 3 s; CA-13 ≤ 2,5 s con límite de 5 s), que ningún límite subió, que el despachador conserva G1 a G4 y que los cambios en las zonas de 021 son mínimos. Listar lo que falta.
- **Hecho cuando**: lista de faltantes vacía o cada faltante con tarea de corrección asignada. Commit `docs(022): revisión final`.

## T15 · [ ] Cierre (devops · haiku)
- **Contexto**: `tasks.md`, `spec.md` (CA-15), `docs/specs/ESTADO.md` (fila 022 y notas [rendimiento]).
- **Hacer**: marcar las casillas de `spec.md` según T13/T14; tachar las notas [rendimiento] con «(cerrada por 022)» y reescribir con su motivo las que no se cumplieron; fila 022 de `ESTADO.md` a «hecha» con la fecha; registrar los hallazgos H-022-n. `git add` con rutas explícitas.
- **Hecho cuando**: `ESTADO.md`, `spec.md` y `tasks.md` consistentes entre sí; sin cambios fuera de `docs/`. Commit `docs(022): cierre de la spec`.
