# Plan 022 · Rendimiento de R1 antes de buzones

Nivel B. Sin migraciones previstas (0052–0054 reservadas; se usan solo con `EXPLAIN` que lo justifique, D-3) y un único cambio de contrato HTTP, aditivo: `avisosOmitidos`. RP-n, CA-n y P-n (decididas el 2026-11-13) son los de `spec.md`. Ronda ADV solo en `packages/queue/src/despachador.ts`.

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| modificar | `packages/queue/src/despachador.ts` · crear `despachador-022.int.spec.ts` y `despachador-022.adv.int.spec.ts` | RP-1: `TRAMO_PISTAS`, `pistasPrevias` acotada (D-1) |
| modificar | `packages/db/src/compras/existentes.ts` (**conflicto 021**) · prueba en `tests/aislamiento/` (equivalencia y tiempo) | RP-2 (D-3) |
| modificar | `packages/db/src/ventas/lectura.ts`, `packages/db/src/index.ts` · `apps/backend/src/modules/ventas/exclusion.service.ts` y sus pruebas | RP-3: `leerFilaVenta` por id (D-4) |
| modificar | `packages/shared/src/archivos/respuestas.ts` · `apps/backend/src/modules/archivos/previo.ts` y sus pruebas · `apps/frontend/components/archivos/previo-archivo.tsx`, `lib/archivos.ts` (mensaje) y su prueba | RP-4: `avisosOmitidos` (D-5) |
| modificar | según el perfilado de T1: `apps/backend/src/modules/compras/masivas.service.ts`, `packages/db/src/compras/{operaciones,versiones}.ts` (**conflicto 021**) · `apps/frontend/components/compras/{deshacer-compras,barra-masiva,grilla-compras}.tsx` (**conflicto 021**) | RP-5 (D-6) |
| modificar | `tests/e2e/flujos/volumen.e2e.ts` | RP-5: tres tiempos por separado (T1); tope 10 s → 3 s (T11) |
| modificar | según el perfilado: `apps/worker/src/trabajos/procesadores/generar-archivo.ts`, `packages/db/src/compras/filas-reemplazo.ts` (**conflicto 021**), `packages/archivos` o equivalente | RP-6 (D-7) |
| modificar | `docs/specs/ESTADO.md` (notas [rendimiento]) | cierre (T15) |

## Decisiones técnicas
- **D-1 RP-1, tramo de pistas (P-1 = b).** Constante exportada `TRAMO_PISTAS = 500` (K; independiente de `VENTANA_CANDIDATOS = 20`). `pistasPrevias` usa `zrange(pend, "0", String(TRAMO_PISTAS - 1))`. `previos` solo se usa con la ventana vacía y sin `en_cola` (ver `atenderEstudio`), así que `cerrarEstudioVacio` queda igual salvo que `previos` y `ejecutando` valen como mucho K: ≤ K `zrem` y ≤ K `leerTrabajo`. El paso 4 (`zcard > 0` → `sadd tenants`) repone al estudio y el siguiente ciclo toma otro tramo: N = 20.000 converge en ≤ 41 ciclos. Se mantiene la restricción sin Lua ni transacción. G1 se cumple porque solo se borra lo leído antes de la BD; G2 porque la relectura de `ejecutando` está acotada por el mismo tramo; G4 porque lo `ejecutando` leído sale de la lista aunque no se republique. K sube o baja solo si T1 muestra que 500 incumple CA-5, y se anota aquí.
- **D-2 RP-1, cómo se prueba CA-2.** Redis instrumentado de las pruebas (contador de comandos por nombre y por argumentos) + contador de llamadas a `leerTrabajo`; sin tiempos. CA-5 corre con Redis real sin instrumentar y solo en `pnpm ci:db`, con `medirMediana` de 020 (`apps/*/test/tiempos.ts`; si el despachador vive en `queue`, se crea el mismo helper de 8 líneas en `packages/queue/src/soporte-pruebas/`).
- **D-3 RP-2.** `leerExistentesCompras` adopta el `join lateral … offset 0` de `leerFilasReemplazo`/`bloquearCompras` sobre la versión 1; mismas columnas, mismo `order by c.clave, c.id`, mismos `where` (periodo, cliente, `descartada_en is null`). Equivalencia: la prueba conserva la consulta anterior como oráculo (`SQL_EXISTENTES_ANTERIOR`, solo en la prueba) y compara ambas listas sobre un periodo con SIRE, agregadas, excluidas, descartadas, varias versiones y USD. Sin `ANALYZE` en la prueba de tiempo. Si hace falta un índice, `EXPLAIN` en este plan y migración 0052.
- **D-4 RP-3.** Nueva `leerFilaVenta(tx, clienteId, periodo, ventaId)` en `packages/db/src/ventas/lectura.ts`: el mismo `select` de `leerFilasVentas` más `and v.id = $3`; `null` si no hay fila. `ventaDelPeriodo` la usa; `idDe` sigue dando 404 al id mal formado sin consultar. RLS no cambia (`withTenant`). `leerFilasVentas` se conserva para otros usos.
- **D-5 RP-4.** `avisosOmitidos` entero ≥ 0 en el esquema del previo (`packages/shared`), calculado en `previo.ts` como `errores` y `excluidas` (`slice(0, MAX_ITEMS_PREVIO)` y `Math.max(0, total − MAX_ITEMS_PREVIO)`). Solo se corta el DTO del previo, no la lista que usa `generar`: el TXT/ZIP y el SHA-256 no cambian (CA-11). Mensaje «y N avisos más» junto al de `erroresOmitidos`.
- **D-6 RP-5, método (P-3 = a).** T1 mide con el contrato actual el reparto de la masiva de 4.850 filas: `POST deshacer`, consulta/transacción del servidor, recarga de filas, render y resumen. T9 (servidor) y T10 (frontend) atacan solo lo dominante; el que no domina se cierra sin cambios con una nota. No se recarga solo la ventana visible (P-3 = b descartada) ni se cambia el contrato.
- **D-7 RP-6, método (P-4 = a).** T1 mide por fase (lectura de filas, armado de líneas, serialización TXT, ZIP, SHA-256, almacenamiento) las 20.000 filas; T12 ataca la dominante. Si 2,5 s exige reescribir el armado del archivo, T12 se detiene y escala con la medida: no se relaja a 3,0 s sin decisión del usuario.
- **D-8 Tiempos.** Aserciones de tiempo solo sin cobertura (`!BAJO_COBERTURA`), con mediana de ≥ 3 muestras, sin `retry` y sin subir ningún límite (CA-14). El único límite que se mueve es el de E-06, hacia abajo (T11).

## Riesgo de conflicto con 021 (reglas aprendidas: motor de reglas, compras, grilla y lupa)
021 trabaja en paralelo y toca la descarga (`apps/worker/.../persistidores/compras.ts`, consumidor de `leerExistentesCompras`), `packages/db/src/compras` (versión 2 `historial`, reglas) y la grilla y la lupa del frontend.
| Tarea 022 | Zona compartida | Riesgo | Mitigación |
|---|---|---|---|
| T5 (RP-2) | `packages/db/src/compras/existentes.ts` | alto: 021 aplica reglas a compras nuevas dentro de la descarga y puede leer o cambiar `leerExistentesCompras` | tocar solo el cuerpo de `SQL_EXISTENTES`; commit pequeño; rebase sobre `main` antes de la verificación |
| T9 (RP-5 servidor) | `packages/db/src/compras/{operaciones,versiones}.ts`, `masivas.service.ts` | medio: 021 añade un tipo de acción (`historial`) a las versiones | sin cambiar firmas ni tipos; si T9 necesita cambiar una firma, parar y consultar |
| T10 (RP-5 frontend) | `deshacer-compras.tsx`, `barra-masiva.tsx`, `grilla-compras.tsx` | alto: 021 añade «Recordar» a la grilla y la lupa | cambios mínimos y locales (recarga/estado); sin tocar el teclado de 015 |
| T12 (RP-6) | `packages/db/src/compras/filas-reemplazo.ts` si el perfilado lo señala | medio | preferir cambios en el worker o en `packages/archivos` |
| T11 (E-06) | `volumen.e2e.ts` y selectores de la grilla | bajo: depende de la grilla de 021 | selectores existentes, sin selectores nuevos |
Orden de integración: el orquestador integra 021 primero si termina antes; 022 hace rebase sobre `main` antes de T13, y T13 repite las pruebas de equivalencia (CA-6, CA-12) tras el rebase. T2 a T4, T6 a T8 no tocan estas zonas.

## Riesgos
- **Un cierre más lento de restos masivos.** N = 20.000 tarda ~40 ciclos en limpiarse (P-1 = b, aceptado): cada ciclo es corto, y mientras queden restos el estudio sigue en `tenants` sin bloquear a otros (ventana de 20 y justicia de 008).
- **Equivalencia silenciosa.** Una consulta más rápida que cambia el orden o la versión 1 no se nota con pocas filas: por eso CA-6 y CA-8 comparan contra el oráculo anterior.
- **Las metas de RP-5 y RP-6 pueden no alcanzarse** con cambios locales (≤ 1,0 s; ≤ 2,5 s): se escala con la medida; no se relajan los límites.
- **Pruebas de tiempo con carga.** Se miden sin carga y sin cobertura; en `pnpm ci:db` corren con la BD compartida (como 020, se corre en serie si se cruzan).

## Línea base (CA-1) — a completar por T1, antes de tocar código
Mediana de 3 (RP-1: de 5), sin carga, HEAD de `spec/022-rendimiento` al medir.
| RP | Medida | Volumen | Línea base | Objetivo |
|---|---|---|---|---|
| RP-1 | comandos Redis por atención; ms | N = 100 / 2.000 / 20.000 | pendiente (T1) | ≤ K elementos; ≤ 100 ms y ≤ 1,5 × (N = 100) |
| RP-2 | ms de `leerExistentesCompras` | 5.000 / 20.000 compras | pendiente (T1) | ≤ 1,0 s; t(20.000) ≤ 5 × t(5.000) |
| RP-3 | p95 y mediana de excluir/restaurar | 100 / 5.000 ventas | pendiente (T1) | p95 < 300 ms; mediana ≤ 2 × (100) |
| RP-4 | longitud de `avisos[]`; bytes de la respuesta | 5.000 avisos | pendiente (T1) | 1.000 + `avisosOmitidos` = 4.000 |
| RP-5 | llamada / recarga / total del Ctrl+Z (E-06) | masiva de 4.850 | pendiente (T1) | total ≤ 1,0 s |
| RP-6 | ms por fase; total de compras | 20.000 filas | pendiente (T1) | compras ≤ 2,5 s |
