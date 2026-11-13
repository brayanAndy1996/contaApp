# Spec 022 · Rendimiento de R1 antes de buzones

Estado: aprobada (2026-11-13). Rama `spec/022-rendimiento` desde `main` (5b92562). Plan y tareas en `plan.md` y `tasks.md`. P-1 a P-4 decididas por el usuario el 2026-11-13.
Nivel de riesgo: **B** con ronda ADV solo en el despachador. Por §2.1: (1) no, porque el resultado de cada lectura, del previo y del archivo debe quedar idéntico (CA-6, CA-8, CA-11); (2) no, porque no cambia permisos ni RLS: CA-8 exige los mismos 404; (3) sí, porque una lista de pistas mal cerrada deja un trabajo invisible hasta el reconciliador (≤ 30 s) y una lectura lenta no se nota con 50 filas; (4) sí, porque el cierre de un estudio compite con el backend que publica trabajos en cualquier momento (H-018-1, H-018-2). Con (3) y (4) es B. La ronda ADV (máx. 1 ronda, ~15 pruebas, `*.adv.spec.ts`) cubre solo `despachador.ts`.
Cubre: RNF-031, RNF-034 (no debilitarlos) · notas [rendimiento] de `ESTADO.md` · no tiene RF ni HU propios.

## Objetivo
Quitar los costos que crecen con el volumen antes de 023 (buzones), que encolará cientos de RUCs por estudio. Cada punto lleva un volumen de prueba y un tiempo límite medibles. Regla de la spec: **no se sube ningún límite de tiempo existente** (se pueden bajar).

## Alcance (nota de origen → requisito)
| Nota de `ESTADO.md` | Requisito | Volumen de prueba y límite |
|---|---|---|
| [rendimiento] `ZRANGE 0 -1` del despachador en cada atención (018 T11c, antes DT-9) | **RP-1** `pistasPrevias` lee un tramo acotado (los K primeros) de la lista de pistas, no la lista entera, sin perder las garantías de `cerrarEstudioVacio` (G1–G4, abajo); el cierre limpia un tramo de K por ciclo (P-1 = b) | Estudio con N = 2.000 (`max_pendientes_tenant` actual) y N = 20.000 pistas: ≤ K elementos leídos por atención; atención con N = 20.000 ≤ 100 ms y ≤ 1,5 × la de N = 100 |
| [rendimiento] `leerExistentesCompras` con join plano O(n²) (012b T25) | **RP-2** Mismo `join lateral … offset 0` de `leerFilasReemplazo`/`bloquearCompras`, con resultado idéntico | Periodo de 20.000 compras (volumen de CA-13 de 012b) sin `ANALYZE`: ≤ 1,0 s; t(20.000) ≤ 5 × t(5.000) |
| [rendimiento] Excluir/restaurar venta lee todo el periodo (`exclusion.service.ts:91-95`) | **RP-3** `ventaDelPeriodo` lee la venta por id y por (cliente, periodo), sin traer el periodo | Periodo de 5.000 ventas: p95 < 300 ms (RNF-034) y mediana ≤ 2 × la de un periodo de 100 ventas |
| [rendimiento] `avisos[]` del previo sin tope (012b T25) | **RP-4** `avisos[]` conserva los primeros `MAX_ITEMS_PREVIO` (1.000, en el orden actual) y el resto se cuenta en `avisosOmitidos`, como `errores[]` y `excluidas[]` (P-2 = a) | Previo con 5.000 avisos: 1.000 en la lista, `avisosOmitidos` = 4.000 |
| [rendimiento] Ctrl+Z de la masiva sobre ~4.850 filas, 1,3–1,9 s (018 T9/T11) | **RP-5** Acelerar el deshacer/rehacer de una masiva grande sin cambiar el contrato ni el significado: medir el reparto y optimizar lo dominante (P-3 = a) | E-06 (`@volumen`, 5.000 compras, masiva de 4.850): mediana de 3 mediciones ≤ 1,0 s (P-3); tope de E-06 baja de 10 s a 3 s |
| [rendimiento] CA-13 de `generar-archivo.int.spec.ts`, mediana 3,4 s frente a 5 s | **RP-6** Ganar margen en la generación de 20.000 filas, sin tocar el límite de 5 s (P-4 = a) | 20.000 filas, mediana de compras ≤ 2,5 s sin carga (margen ≥ 50 %, P-4) |

**Garantías de `cerrarEstudioVacio` (comentario de `despachador.ts`, a conservar)**
- **G1** Solo se quitan de la lista los ids leídos *antes* de la lectura en BD; un id publicado después nunca se borra.
- **G2** Un id que la lectura vio `ejecutando` y volvió a `en_cola` con el mismo id (reintento) se vuelve a publicar.
- **G3** Nunca queda un trabajo en la lista con el estudio fuera de `tenants`.
- **G4** Sin bucle de ciclos vacíos: un resto que no se puede despachar no hace que el estudio se atienda para siempre.
- Restricción: sin Lua ni transacción de Redis (tolera el Redis falso de las pruebas de T11c).

## Fuera de alcance
- Subir cualquier límite o factor de holgura de una prueba de tiempo, `retry`, o comparar tiempos bajo `CONTAPP_COBERTURA=1` (regla de 020 P-4: la aserción de tiempo solo corre en `pnpm ci:db`, con mediana de ≥ 3 muestras).
- Cambiar `max_pendientes_tenant`, la ventana de candidatos (`VENTANA_CANDIDATOS = 20`) o la lógica de justicia de 008.
- El `SADD` sin `ZADD` de `contarPendientes` (límite aceptado, 020 P-1), la purga de auditoría, el desborde duplicado `[refactor]` y las observaciones de [013] T22 que no sean la lectura por id.
- Cambios de contrato HTTP distintos de `avisosOmitidos` (campo nuevo, aditivo). Sin pantallas ni reglas nuevas.
- Migraciones: no se prevén. Si el plan descubre un índice necesario, usa 0052–0054 (reservadas) y lo justifica con `EXPLAIN` en el plan.
- La cola de buzones y su volumen (023).

## Criterios de aceptación
- [ ] CA-1 (línea base): antes de cambiar código, `plan.md` registra la medición actual de RP-1 a RP-6 (mediana de 3, sin carga) en el volumen indicado. Los objetivos de la tabla son el piso de la spec; si una línea base ya los cumple, la prueba queda como guarda de regresión.
- [ ] CA-2 (RP-1, lectura acotada): con N = 2.000 y N = 20.000 pistas en un estudio, una atención lee como máximo K elementos de la lista (K fijo, constante nueva con nombre definida en el plan, `TRAMO_PISTAS`; no es `VENTANA_CANDIDATOS`, que acota los candidatos de la BD) y hace como máximo K lecturas de `leerTrabajo`. Se comprueba contando comandos en el Redis instrumentado de las pruebas, no por tiempo. Ningún `zrange` con `"0", "-1"` en `despachador.ts` (grep).
- [ ] CA-3 (RP-1, garantías): `despachador-t11c.adv.int.spec.ts` (A1 a A11) y `despachador-t11c.int.spec.ts`, `despachador-r1b.adv.int.spec.ts`, `despachador-r2a.adv.int.spec.ts`, `despacho.int.spec.ts` y `despachador.spec.ts` pasan sin cambiar ni quitar ninguna aserción. La ronda ADV añade pruebas para G1 a G4 con N > K: publicación entre la lectura acotada y la lectura en BD, un `ejecutando` que reintenta fuera del tramo leído, cancelación entre ambas, y fallo único del `ZRANGE`.
- [ ] CA-4 (RP-1, convergencia; P-1 = b): cada cierre quita como máximo un tramo de K ids y repone al estudio en `tenants` mientras la lista no quede vacía. Con N = 20.000 restos (ids sin trabajo `en_cola` en BD) y la BD vacía de `en_cola`, la lista queda vacía y el estudio fuera de `tenants` en ≤ ⌈N / K⌉ + 1 ciclos, cada ciclo dentro de CA-5, y sin bucle posterior (G4). No hay lectura ni borrado de más de K ids por ciclo, ni `ZCARD` con alerta (P-1 = c no se adopta).
- [ ] CA-5 (RP-1, tiempo): mediana de 5 atenciones con N = 20.000 ≤ 100 ms y ≤ 1,5 × la mediana con N = 100, con Redis real, en `pnpm ci:db` (sin instrumentar).
- [ ] CA-6 (RP-2, equivalencia): sobre un periodo con compras SIRE, agregadas, excluidas, descartadas, varias versiones y USD con tipo de cambio, `leerExistentesCompras` devuelve exactamente la misma lista (mismo orden `clave, id` y mismos `campos`, siempre de la versión 1) que la consulta actual. Las descartadas no salen. `descarga` repetida (014) da el mismo informe `nuevas/iguales/distintas`.
- [ ] CA-7 (RP-2, tiempo): periodo de 20.000 compras recién cargado, sin `ANALYZE`, mediana de 3 ≤ 1,0 s, y t(20.000) ≤ 5 × t(5.000).
- [ ] CA-8 (RP-3, equivalencia): excluir y restaurar una venta responde igual que hoy, incluido el 404 (`no_encontrado`) para id mal formado, de otro cliente, de otro periodo y de otro estudio (RLS), y `no_excluida` al restaurar una no excluida. Una prueba espía que `leerFilasVentas` ya no se llama en ese camino. La regla D12 (`tieneError`) y la auditoría no cambian.
- [ ] CA-9 (RP-3, tiempo): periodo de 5.000 ventas, excluir y restaurar una: p95 de 20 repeticiones < 300 ms y mediana ≤ 2 × la de un periodo de 100 ventas.
- [ ] CA-10 (RP-4, tope): un previo con 5.000 avisos devuelve `avisos.length` = `MAX_ITEMS_PREVIO` y `avisosOmitidos` = 4.000; con ≤ 1.000 avisos, `avisosOmitidos` = 0. El orden y el contenido de los 1.000 primeros no cambian (P-2 = a); no se agrega muestra por código. El esquema de `packages/shared` valida el campo nuevo y rechaza negativos.
- [ ] CA-11 (RP-4, uso): el panel del previo muestra «y N avisos más» cuando `avisosOmitidos` > 0 (prueba de componente, junto a `erroresOmitidos`). El texto actual «Los avisos no impiden generar el archivo.» se conserva. El TXT/ZIP y el SHA-256 generados con el mismo periodo son idénticos antes y después.
- [ ] CA-12 (RP-5, Ctrl+Z): E-06 mide por separado la llamada `POST deshacer`, la recarga de filas y el total; el total, mediana de 3, baja de 1,3–1,9 s y queda en ≤ 1,5 s (P-3 revisada por el usuario el 2026-11-13: se acepta ~1,5 s porque bajar de ~1,1 s la llamada exige cambiar el esquema o dejar de re-evaluar hallazgos; la meta de ≤ 1,0 s no se cumple), sin cambiar el contrato HTTP ni cargar solo las filas visibles. Las pruebas de deshacer/rehacer de 014/015 (incluida `fila_cambiada`) pasan sin cambios. Las filas deshechas se ven resaltadas igual y el resumen se actualiza. El tope de E-06 baja a 3 s; no sube.
- [ ] CA-13 (RP-6, margen): `generar-archivo.int.spec.ts` CA-13 (012b) mantiene su límite de 5 s y su mediana de compras sin carga queda ≤ 2,5 s (P-4 = a; no se relaja a 3,0 s), con ≥ 3 muestras y sin evaluar tiempo bajo cobertura. La causa dominante (perfilado) queda escrita en `tasks.md`.
- [ ] CA-14 (no se debilita nada): `git diff` contra `main` no sube ningún número de límite de tiempo en `*.spec.ts`, `*.int.spec.ts` ni `*.e2e.ts` (revisión con grep de los límites de 020: 2 s CA-15, 5 s CA-13, 10 s E-06 solo baja), y ningún archivo tocado lleva `retry`.
- [ ] CA-15: las suites de los paquetes tocados (`queue`, `db`, `shared`, `backend`, `worker`, `frontend`), typecheck, lint, `pnpm ci:db`, `pnpm ci:cierre` y `pnpm e2e` quedan en verde; `pnpm e2e:volumen` se corre a mano una vez y su resultado va en el plan. CI verde en 3 corridas seguidas. Las notas [rendimiento] de `ESTADO.md` se tachan con «(cerrada por 022)»; las que queden por P-n se reescriben con su motivo.
- [ ] Casos reales aplicables: ninguno.

## Dependencias
- Specs: 001 a 020 (hechas). Toca código de 008 (`packages/queue`), 012b (`archivos`, `generar-archivo`), 013 (ventas), 014/015 (compras) y 018 (E-06). Va antes de 023 y en paralelo con 021 (reglas aprendidas: motor de reglas, compras, grilla y lupa). **Riesgo de conflicto con 021** en `packages/db/src/compras` (RP-2, y RP-5/RP-6 si lo tocan), `apps/worker/src/trabajos/persistidores/compras.ts` (consumidor de `leerExistentesCompras`) y la grilla de compras del frontend (RP-5); el plan marca las tareas afectadas y el orden de integración.
- Externas: Postgres y Redis locales (`pnpm servicios:up`). Ninguna fuente real.

## Decisiones del usuario (2026-11-13)
Respondidas con la opción recomendada en las cuatro.
- **P-1 = b · Cierre con más de K restos (RP-1).** Un tramo de K por ciclo: el paso 4 de `cerrarEstudioVacio` ya repone al estudio en `tenants` si la lista no quedó vacía, así que converge en ⌈N / K⌉ ciclos, cada uno acotado. G1 se cumple porque solo se borra lo leído antes de la BD; la ronda ADV se centra en G2 y G4. Descartadas: (a) vaciar por tramos en un solo ciclo; (c) `ZCARD` con alerta.
- **P-2 = a · Avisos pasado el tope (RP-4).** Los primeros 1.000 en el orden actual y `avisosOmitidos` con el resto, igual que `errores[]` y `excluidas[]`. Descartadas: (b) muestra por código; (c) solo contador.
- **P-3 = a · Ctrl+Z (RP-5).** Medir primero el reparto (servidor, recarga de 4.850 filas, resumen) y optimizar lo dominante sin cambiar el contrato. Objetivo: mediana de 3 ≤ 1,0 s; el tope de E-06 baja de 10 s a 3 s. Descartadas: (b) recarga parcial de la ventana virtual; (c) no tocarlo.
- **P-4 = a · Margen de CA-13 (RP-6).** Mediana de compras ≤ 2,5 s (margen ≥ 50 %) con el límite de 5 s intacto. Descartadas: (b) 3,0 s; (c) solo documentar.

## Preguntas abiertas
Ninguna de producto. Las decisiones técnicas que quedan (valor de `TRAMO_PISTAS`, forma del arreglo de RP-5 y de RP-6 según el perfilado) están en `plan.md`.

## Decisión posterior del usuario (2026-11-13)

- **P-3 revisada:** T9 bajó la llamada `POST deshacer` de 1,23 s a 1,09 s (meta parcial 550 ms). Lo que queda es SQL por fila (FK, índices, triggers, `uuid_v7()`). El usuario aceptó ~1,5 s de total sin cambios de esquema; el tope de E-06 baja igual de 10 s a 3 s. La prueba de tiempo de T9 pasa a vigilar la regresión del servidor (≤ 1.200 ms) en lugar de 550 ms.
