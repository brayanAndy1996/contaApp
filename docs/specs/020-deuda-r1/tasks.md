# Tareas 020 · Deuda técnica de R1

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con las indicadas (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel C (04 §2.1): sin TDD ni ADV. Flujo 04 §1.3: implementar (+ pruebas mínimas) → verificar → revisión → cerrar. Rama `spec/020-deuda-r1`. DT, CA y P (decididas el 2026-11-12) = `spec.md`; archivos y decisiones D-n = `plan.md`.

| #   | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
| --- | ----- | --- | ------ | ---------- | --- | --- | ------ |
| T1  | Tiempos del backend sin instrumentar: CA-15 de lectura y CA-8 de auth con inyección de 20 ms (DT-1) | tester | sonnet | — ∥ T2–T7 | — | — | [ ] |
| T2  | Tiempos y espera del worker: CA-13 y `ejecutor.int.spec.ts:523` (DT-1); `restaurarConfig` con las cuatro colas (DT-2) | tester | sonnet | — ∥ T1, T3–T7 | — | — | [ ] |
| T3  | Migración 0046: `notificacion.creada_en` a ms y CHECK validado (DT-8) | backend | sonnet | — ∥ T1, T2, T4–T7 | — | — | [ ] |
| T4  | Ficha de credenciales: refresco al terminar la verificación e «Inválida» en español (DT-3) | frontend | sonnet | — ∥ T1–T3, T5–T7 | — | — | [ ] |
| T5  | Panel de trabajos: relistar si el stream llega tarde (DT-7) y «Cancelar» solo con permiso (DT-3) | frontend | sonnet | — ∥ T1–T4, T6, T7 | — | — | [ ] |
| T6  | Panel «Generar archivo» sin tapar columnas a 1440 px (DT-4) | frontend | sonnet | — ∥ T1–T5, T7 | — | — | [ ] |
| T7  | Horas de Lima (DT-5) y versiones y mensajes del archivo (DT-6) | frontend | sonnet | — ∥ T1–T6 | — | — | [ ] |
| T8  | E2E: E-03 sin recargar (CA-5) y panel a 1440×900 (CA-6) | tester | sonnet | T4, T6 | — | — | [ ] |
| T9  | Verificar CA-1 a CA-11 | tester | sonnet | T1–T8 | — | — | [ ] |
| T10 | Revisión final contra la spec | arquitecto | sonnet | T9 | — | — | [ ] |
| T11 | Cierre: `tasks.md`, `spec.md`, notas de `ESTADO.md` y commit | devops | haiku | T10 | — | — | [ ] |

Paralelismo: T1 a T7 van en paralelo; cada una es dueña de sus archivos (columna «Archivos» de `plan.md`):
- T1: `apps/backend/test/tiempos.ts`, las dos pruebas del backend y `apps/backend/vitest.cobertura*.config.mts`.
- T2: `apps/worker/test/{tiempos,trabajos}.ts`, `generar-archivo.int.spec.ts`, `ejecutor.int.spec.ts`, `packages/queue/src/soporte-pruebas/int.ts`.
- T3: `packages/db/migrations/0046*`, `meta/`, `tests/aislamiento/notificacion-ms-0046.spec.ts`.
- T4: `components/credenciales-cliente.tsx`, `lib/credenciales.ts` y sus pruebas. Usa `lib/trabajos.ts` solo para importar constantes; si necesita cambiarlo, espera a T5.
- T5: `lib/trabajos.ts`, `app/(app)/trabajos/page.tsx` y sus pruebas.
- T6: `components/archivos/panel-generar.tsx`, `app/(app)/clientes/[clienteId]/compras/page.tsx`.
- T7: `lib/{fechas,acceso,lupa-compras,archivos}.ts`, `components/compras/historial-compra.tsx` (y los que usen `fechaLegibleUtc`), `components/archivos/{versiones-archivo,previo-archivo}.tsx`, `packages/shared/src/archivos/errores.ts`. No toca `panel-generar.tsx` (de T6) ni `credenciales-cliente.tsx` (de T4).

T8 espera a T4 y T6 (afirma su comportamiento en E2E). T1, T2 y T3 comparten la BD de pruebas al correr: si se cruzan, se corre en serie y se anota.

Escalamientos: T11 pasa a `sonnet` si `haiku` falla una vez. Una tarea que falle 2 veces por intermitencia pasa a `opus`. Una prueba de tiempo que falle sin instrumentar es un defecto de rendimiento: se escala al orquestador con la medida; no se sube el límite ni se reintenta.

Reglas comunes:

- Un commit por tarea (Conventional Commits `test(020): …`, `fix(020): …`, `feat(020): …`, `docs(020): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push del subagente: el orquestador lo hace.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` ajenos: `git add <rutas>` explícitas, nunca `-A` ni `.`. Nunca leer ni imprimir `.env`. Sin `reset`, `stash` ni `clean`.
- Sin `retry`, `skip`, `fixme` ni `test.only`. No se quita ninguna aserción para que una prueba pase. Los límites de CA-2 no cambian.
- Correr solo las pruebas del paquete tocado mientras se trabaja; la corrida completa con carga, en T9.
- El tester no toca código de producción. El frontend no edita `tests/e2e`. `apps/frontend` no gana dependencias.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo.
- P-1 a P-5 están decididas (spec, 2026-11-12). Una ambigüedad nueva que cambie la spec no se decide: `requiere usuario`.

## T1 · [ ] Tiempos del backend (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (DT-1, CA-1 a CA-3, P-4), `plan.md` (D-1, D-2), `apps/backend/src/modules/compras/lectura.int.spec.ts` (bloque CA-15), `apps/backend/src/modules/auth/auth.r1b.adv.int.spec.ts` (bloque CA-8, líneas 262-292, y el arnés `h` que usa), `apps/backend/vitest.cobertura*.config.mts`, `apps/worker/src/trabajos/procesadores/generar-archivo.int.spec.ts:945-950` (precedente de `CONTAPP_COBERTURA`).
- **Hacer**: crear `apps/backend/test/tiempos.ts` (`BAJO_COBERTURA`, `medirMediana(fn, n)`). CA-15: mediana de 3 lecturas del listado de 5.000 filas; el límite de 2 s solo con `!BAJO_COBERTURA`; la parte funcional (filas, orden, `siguiente`) siempre. CA-8: extraer `fugaPorTiempo(existe, noExiste)` con el mismo límite `max(5 ms, 10 %)` y no evaluarla bajo cobertura; prueba nueva en el mismo archivo que inyecta 20 ms solo en la rama de cuenta existente mediante un doble del arnés y espera que `fugaPorTiempo` la detecte (esta prueba también se omite bajo cobertura). Fijar `CONTAPP_COBERTURA = "1"` en `test.env` de cada `apps/backend/vitest.cobertura*.config.mts` que incluya estos archivos. Si la inyección exige tocar código de producción, parar y escalar.
- **Hecho cuando**: las dos pruebas pasan 10 veces seguidas con `pnpm --filter @contapp/backend test:int -- <archivo>`; la prueba de inyección pasa (detecta la fuga) 10 de 10; con el límite de CA-15 a la mitad de la mediana medida, falla (sin commit); `pnpm cobertura:auth` corre las pruebas sin comparar tiempos; `grep -n "retry" ` de ambos archivos vacío; typecheck y lint del backend limpios. Commit `test(020): tiempos del backend sin instrumentar y con medianas`.
- **Resultado**:

## T2 · [ ] Tiempos y espera del worker; `restaurarConfig` (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (DT-1, DT-2, CA-1 a CA-4), `plan.md` (D-1, D-3), `apps/worker/src/trabajos/procesadores/generar-archivo.int.spec.ts` (bloque CA-13, desde la línea 940), `apps/worker/src/trabajos/ejecutor.int.spec.ts` (la prueba que contiene la línea 523 y su `esperarHasta`), `apps/worker/test/trabajos.ts` (`fijarConfig`, `restaurarConfig`, `esperarHasta`), `packages/queue/src/soporte-pruebas/int.ts` (`restaurarConfig`), `packages/db/migrations/0017_trabajos.sql` y `0040_archivo_generado.sql` (solo los `INSERT` de `config_sistema`), `apps/worker/vitest.cobertura-archivos.config.mts`.
- **Hacer**: crear `apps/worker/test/tiempos.ts` (igual que el del backend). CA-13: quitar `FACTOR_COBERTURA`; un calentamiento y mediana de 3 generaciones de 20.000 filas; el límite de 5 s solo sin cobertura; la parte funcional siempre. `:523`: encontrar la causa (traza, `esperarHasta`, estado de `config_sistema` o del reconciliador que dejan otras suites) y escribirla en Resultado; el arreglo no quita aserciones ni sube topes a ciegas. DT-2: `restaurarConfig` de los dos archivos repone `sire`, `sol`, `xml` y `archivos` con los valores de sus migraciones; prueba mínima que cambia `archivos`, restaura y lee las cuatro filas.
- **Hecho cuando**: CA-13 y la prueba de `:523` pasan 10 veces seguidas (`pnpm --filter @contapp/worker test:int -- <archivo>`); con el límite de CA-13 a la mitad de la mediana, falla (sin commit); `pnpm cobertura:archivos` corre CA-13 sin comparar tiempo; la prueba de DT-2 pasa; `pnpm --filter @contapp/queue test:int` en verde; sin `retry`; typecheck y lint de `worker` y `queue` limpios. Commit `test(020): tiempos del worker, espera de ejecutor y restaurarConfig completo`.
- **Resultado**:

## T3 · [ ] Migración 0046 (backend · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (DT-8, CA-10), `plan.md` (D-4, Riesgos), `packages/db/migrations/0044_auditoria_notificacion_ms.sql`, `packages/db/migrations/0043_notificacion.sql` (líneas 20-95: tabla, RLS y trigger `notificacion_solo_leida`), `packages/db/migrations/0045_auditoria_ronda_r1.sql` (cabecera y forma), `packages/db/migrations/meta/_journal.json` (última entrada), `tests/aislamiento/notificaciones-lectura.spec.ts` y `tests/aislamiento/auditoria-soporte.ts` (cómo conectan y siembran).
- **Hacer**: `0046_notificacion_ms_validada.sql` según D-4 (bloque `DO`, solo el trigger `notificacion_solo_leida`, sin desactivar RLS; buscar antes en las migraciones un `UPDATE` de datos sobre una tabla con `FORCE ROW LEVEL SECURITY` y seguir ese patrón; si no lo hay, escalar). Entrada idx 46 en `_journal.json` y snapshot como en 0045. Prueba `tests/aislamiento/notificacion-ms-0046.spec.ts`: deja una notificación con µs (quitando el CHECK y volviéndolo a poner `NOT VALID` dentro de la prueba, como estaba antes de 0046), ejecuta el SQL de 0046, comprueba `convalidated = true`, que el trigger sigue habilitado y rechaza cambiar `creada_en` (42501), que marcar leída funciona y que el conteo y un resumen (`md5(string_agg(...))`) de `auditoria` no cambian.
- **Hecho cuando**: `pnpm db:migrate` dos veces en verde; `select convalidated from pg_constraint where conname = 'notificacion_creada_en_ms'` da `t`; la prueba nueva y `tests/aislamiento/notificaciones-lectura.spec.ts` pasan (`pnpm test:aislamiento -- <archivos>`); typecheck y lint limpios. Commit `fix(020): migración 0046 valida los milisegundos de notificacion`.
- **Resultado**:

## T4 · [ ] Ficha de credenciales (frontend · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (DT-3, CA-5), `plan.md` (D-5), `apps/frontend/components/credenciales-cliente.tsx`, `apps/frontend/lib/credenciales.ts`, `apps/frontend/lib/trabajos.ts:17-25` (constantes de espera), `packages/shared/src/credenciales/` (forma de `CredencialEstadoDto` y motivos), `apps/worker/src/trabajos/procesadores/verificar-credencial.ts` (solo los motivos que escribe).
- **Hacer**: refresco según D-5 (espera creciente mientras haya «Verificando», para en estado final y al desmontar). «Inválida» con el motivo traducido desde un mapa en `lib/credenciales.ts` y texto genérico en español para un motivo desconocido. Prueba de componente con temporizadores falsos: «Verificando» → «Verificada» y → «Inválida» sin recargar, el código crudo no aparece, y al desmontar no hay más lecturas.
- **Hecho cuando**: las pruebas nuevas pasan; `pnpm --filter @contapp/frontend test`, `typecheck`, `lint` y `next build` limpios. Commit `fix(020): la ficha de credenciales se refresca sola y traduce «Inválida»`.
- **Resultado**:

## T5 · [ ] Panel de trabajos (frontend · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (DT-3 «Cancelar», DT-7, CA-5, CA-9), `plan.md` (D-6, D-7), `apps/frontend/lib/trabajos.ts` (`seguirTrabajos`, líneas 159-230), `apps/frontend/lib/trabajos.spec.ts` (caso del tope), `apps/frontend/app/(app)/trabajos/page.tsx`, `apps/frontend/app/(app)/trabajos/page.spec.tsx` (líneas 300-330), `apps/frontend/lib/acceso.ts` (`usePuede`, rol de `Yo`), `packages/shared/src/trabajos/esquemas.ts` (`creadoPor`).
- **Hacer**: D-7 en `seguirTrabajos` (relistar una sola vez cuando el stream abre tras vencer el tope). D-6 en `page.tsx` (quitar el comentario «Cancelar no se oculta por permiso» y mostrar el botón solo a quien encoló, Dueño o Administrador). Pruebas: el stream abre a los 4 s y un trabajo que cambió entre el listado y la conexión se ve con su estado final (CA-9); con el stream a tiempo no hay segundo listado; «Cancelar» visible para el creador y el Administrador y oculto para otro rol que no encoló.
- **Hecho cuando**: las pruebas nuevas y las existentes de trabajos pasan; `pnpm --filter @contapp/frontend test`, `typecheck`, `lint` y `next build` limpios. Commit `fix(020): relistar trabajos con stream tardío y Cancelar según permiso`.
- **Resultado**:

## T6 · [ ] Panel «Generar archivo» a 1440 px (frontend · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (DT-4, CA-6), `plan.md` (D-10), `apps/frontend/components/archivos/panel-generar.tsx` (solo el contenedor y sus clases), `apps/frontend/app/(app)/clientes/[clienteId]/compras/page.tsx`, `apps/frontend/components/compras/grilla-compras.tsx` (solo el contenedor con desplazamiento), `tests/e2e/flujos/archivo.e2e.ts` (cómo se abre el panel; solo lectura).
- **Hacer**: disposición de D-10. Comprobar en local con la pila de `tests/e2e` a 1440×900 y 1366×768 (un script de Playwright en el scratchpad, sin commit) que ninguna cabecera de la grilla se cruza con el panel y que la última se alcanza con el desplazamiento horizontal. Las pruebas de componente existentes del panel y la grilla siguen en verde.
- **Hecho cuando**: la comprobación local da 0 cruces en ambos tamaños (anotar las cajas medidas en Resultado); `pnpm --filter @contapp/frontend test`, `typecheck`, `lint` y `next build` limpios. Commit `fix(020): el panel Generar archivo no tapa la grilla de compras`.
- **Resultado**:

## T7 · [ ] Horas de Lima y versiones del archivo (frontend · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (DT-5, DT-6, CA-7, CA-8, P-3), `plan.md` (D-8, D-9), `apps/frontend/lib/fechas.ts`, `apps/frontend/lib/acceso.ts:114-115` (`fechaCorta`) y `grep -rn "fechaCorta\|fechaLegibleUtc" apps/frontend` (consumidores), `apps/frontend/lib/lupa-compras.ts:250-260`, `apps/frontend/components/compras/historial-compra.tsx`, `apps/frontend/components/archivos/versiones-archivo.tsx`, `apps/frontend/lib/archivos.ts` (`MENSAJES_ARCHIVO`, `descargarVersionArchivo`), `apps/frontend/components/archivos/previo-archivo.tsx`, `packages/shared/src/archivos/errores.ts`, `packages/shared/src/archivos/respuestas.ts` (`versionArchivoSchema`), `packages/domain/src/archivos/tipos.ts` (catálogo de códigos de ventas).
- **Hacer**: D-8 (instantes con hora → `fechaHoraLima`; borrar `fechaLegibleUtc` y el formateador de `historial-compra.tsx`; `fechaCorta` distingue fecha pura e instante). D-9 (versiones con autor, fecha de Lima, SHA-256 del ZIP y nombre `_vN`; mensajes de `resumen_fuera_de_rango`, `CUADRE`, `USD_SIN_TC` y `SALTO_CORRELATIVIDAD`). Pruebas: `fechas.spec.ts` con `2026-10-20T15:00:00.000Z` → «20/10/26, 10:00 a. m.», un instante de las 23:30 de Lima sale con el día de Lima y `2026-10-20` (fecha pura) sale 20/10; componentes de lupa, Historial y versiones con la hora de Lima; los cuatro códigos con su texto; dos versiones descargan con nombres distintos.
- **Hecho cuando**: las pruebas pasan con `TZ=UTC` y con `TZ=Asia/Tokyo` (`TZ=… pnpm --filter @contapp/frontend test`); el grep de CA-7 solo encuentra el comentario de `lib/fechas.ts`; `pnpm --filter @contapp/shared test`, `typecheck` del backend y del frontend, `lint` y `next build` limpios. Commit `fix(020): horas en hora de Lima y versiones del archivo con autor, SHA-256 y nombre propio`.
- **Resultado**:

## T8 · [ ] E2E de la ficha y del panel (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-5, CA-6), `tasks.md` (Resultados de T4 y T6), `tests/e2e/README.md` (cómo correr), `tests/e2e/flujos/clientes.e2e.ts` (bloque de verificación, cerca de la línea 248), `tests/e2e/soporte/selectores/clientes.ts`, `tests/e2e/flujos/archivo.e2e.ts`, `tests/e2e/soporte/selectores/archivo.ts`.
- **Hacer**: E-03: tras «Verificar», la ficha pasa a «Verificada» sin `reload` (quitar la recarga si existe, sin otras aserciones menos). CA-6: prueba nueva en `archivo.e2e.ts` a 1440×900 que abre el panel y comprueba con cajas (selector solo en `selectores/archivo.ts`) que ninguna cabecera de columna se cruza con el panel y que la última se alcanza desplazando la grilla. Higiene de 018 (sin esperas fijas, localizadores por rol).
- **Hecho cuando**: `pnpm --filter @contapp/tests-e2e exec playwright test flujos/clientes.e2e.ts flujos/archivo.e2e.ts --repeat-each=5` con `E2E_CORREO=consola` sin fallos; `typecheck` y `lint` de `tests/e2e` limpios. Commit `test(020): E2E de la ficha sin recargar y del panel a 1440 px`.
- **Resultado**:

## T9 · [ ] Verificar criterios (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-11), `tasks.md` (Resultados de T1 a T8), `package.json` (raíz: `ci:db`, `cobertura:*`, `e2e`).
- **Hacer**: CA-1: las cuatro pruebas 20 veces seguidas con 4 suites en paralelo (backend int, worker int, queue int y aislamiento a la vez), 0 fallos; 3 corridas seguidas del CI (las lanza el orquestador con `workflow_dispatch`; ver con `gh run list --workflow ci.yml`). CA-2: grep de `retry`, la prueba de inyección 10 corridas (≥ 9 detectan) y la mitad del límite (sin commit). CA-3: `pnpm cobertura:auth` y `pnpm cobertura:archivos` no comparan tiempo; `pnpm ci:db` sí. CA-4 a CA-10: prueba `archivo:línea` de cada uno; CA-7 también con `TZ=UTC` y el grep. CA-11: suites de los paquetes tocados, typecheck, lint y `pnpm e2e`. Tabla CA → evidencia.
- **Hecho cuando**: cada CA tiene evidencia o queda listado como faltante (CI pendiente se marca «pendiente: CI»). Un fallo vuelve a su tarea; no se reintenta. Commit `docs(020): verificación de criterios`.
- **Resultado**:

## T10 · [ ] Revisión final (arquitecto · sonnet)
- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, `tasks.md` (Resultados), `git diff main...HEAD --stat` y el diff de los archivos de la columna «Archivos» de `plan.md`.
- **Hacer**: comprobar cada CA con su evidencia de T9; que ningún límite cambió, que no hay `retry`, `skip` ni aserciones quitadas (diff de las cuatro pruebas); que 0046 no desactiva RLS ni toca `auditoria` y deja el trigger habilitado; que ningún archivo fuera de alcance (`packages/queue/src/despachador.ts`, `reconciliador.ts`) cambió; que `apps/frontend` no ganó dependencias. Ratificar desvíos en `plan.md` («Desvíos ratificados») o abrir T10a/T10b.
- **Hecho cuando**: aprobada o lista de defectos con tareas nuevas. Commit `docs(020): revisión final`.
- **Resultado**:

## T11 · [ ] Cierre (devops · haiku)
- **Contexto (leer solo esto)**: `tasks.md`, `spec.md` (cabecera y criterios), `docs/specs/ESTADO.md` (fila 020 y sección de notas).
- **Hacer**: marcar tareas y CA y poner la spec en «verificada» (o «hecha» con «pendiente: CI» si falta CI). En `ESTADO.md`, tachar con «(cerrada por 020)» las notas cerradas: [pruebas] umbrales bajo cobertura (lectura CA-15 y auth CA-8), [pruebas] intermitentes por tiempo (CA-13 y `ejecutor:523`), la parte de `restaurarConfig` de la nota [pruebas] del worker, [clientes] ficha, [frontend] deuda de 007b, [frontend] panel «Generar archivo», [frontend] horas en UTC, [frontend] deuda de 012b (salvo el desborde a 390 px, que sigue abierto), [mantenimiento] T11e y [mantenimiento] 0044. Fila 020 en «hecha».
- **Hecho cuando**: `git status` limpio salvo lo ajeno a 020. Commit `docs(020): cierre`.
- **Resultado**:
