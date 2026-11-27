# Resultados 031 · Consulta de auditoría

## T5 · Migración 0088 y repositorio (BD 5)

### EXPLAIN por filtro (CA-9, D-7)
Carga del caso de CA-9 (200 000 filas de `auditoria` y 50 000 descifrados en 39 días, un estudio), sembrada y analizada dentro de una
transacción que se revierte. Página: `listarAuditoria` con `contapp_backend` y `limite = 50`. Rama de descifrados: el texto de la función
(`RETURN QUERY EXECUTE`) con los mismos valores, como su dueño. `EXPLAIN (ANALYZE, BUFFERS)`; solo los nodos de lectura. Ningún caso
recorre `auditoria` ni `auditoria_descifrado` en secuencia (el `Seq Scan` de `asignacion` es de la tabla de 3 filas de la siembra).

| Filtro | Rama `auditoria` | Rama de descifrados |
|---|---|---|
| acción rara (una) | `auditoria_accion_idx`, Index Cond `accion = …` (en orden, sin Sort interno) | LIMIT 0 (sin consultar) |
| dos acciones | `auditoria_fecha_idx` + Filter `accion = ANY(…)` (elección del planificador: una acción es 1/3 de las filas) | LIMIT 0 |
| usuario raro | `auditoria_usuario_idx`, Index Cond `usuario_id = …` | LIMIT 0 (D-4) |
| cliente de pocas filas | `auditoria_cliente_idx`, Index Cond `cliente_id = …` | `auditoria_descifrado_cliente_idx`, Index Cond `cliente_id = …` |
| asignado a un cliente de pocas filas | LATERAL por asignación: `auditoria_cliente_idx`, Index Cond `cliente_id IS NOT NULL AND cliente_id = asg.cliente_id` + semijoin de `filtroAlcance` | LATERAL por asignación: `auditoria_descifrado_cliente_idx` |
| solo `credencial.descifrada` | `auditoria_accion_idx` (0 filas) | `auditoria_descifrado_fecha_idx` |
| ventana de una hora | `auditoria_fecha_idx`, Index Cond `ocurrida_en >= … AND < …` | `auditoria_descifrado_fecha_idx`, Index Cond `auditoria_ms(created_at) >= … AND < …` |
| sin filtros (primera página) | `auditoria_fecha_idx` | `auditoria_descifrado_fecha_idx` |
| sin filtros, página profunda (cursor al medio) | `auditoria_fecha_idx`, Index Cond `ROW(ocurrida_en, id) < ROW(…)` | `auditoria_descifrado_fecha_idx`, Index Cond `ROW(auditoria_ms(created_at), id) < ROW(…)` |

Notas del plan:
- `date_trunc` no es LEAKPROOF: con la RLS FORCE de `auditoria_descifrado`, `date_trunc('milliseconds', created_at …) < $n` quedaba como
  `Filter` (probado: el índice daba el orden pero recorría desde el principio del estudio). `public.auditoria_ms` (IMMUTABLE, LEAKPROOF,
  con `SET search_path` para que no se expanda en línea) vuelve esas comparaciones condiciones del índice. Se ejecuta con el rol que
  inserta (la expresión del índice): EXECUTE solo para `contapp_worker`. Va en `public` porque 017 R1 prohíbe EXECUTE de la app sobre `interno`.
- Los índices de 017 son `DESC NULLS LAST`: el ORDER BY de cada rama lo repite (con `desc` a secas el índice no da el orden).
- Una sola acción viaja como igualdad (`$12`) y no como arreglo: `= ANY` sobre la 2.ª columna del índice no da orden en PG 16.
- La función se planifica en cada llamada con sus valores (`EXECUTE … USING`, texto fijo): los filtros ausentes se pliegan.

### Escala (CA-9, razón de CPU, tope ≤ 2)
`auditoria-consulta.rendimiento.spec.ts`: los 7 casos de «escala como índice» en verde tras los índices (corrida aislada y suite completa).
p95 informativo con la carga completa (ms): acción rara 1,0 · usuario raro 0,6 · cliente chico 0,9 · asignado 1,2 · solo descifrados 2,2 ·
ventana 1,0 · sin filtros 0,7.

### Pruebas que no pasan y no son de la implementación (para el tester)
- `auditoria-consulta.rendimiento.spec.ts` «cada filtro usa el índice esperado» (5 de 7): las estadísticas de una consulta hecha por
  `withTenant` se ven ~10 s después (medido: 9 995–10 079 ms), porque `LIMPIAR_SESION` vuelca las pendientes justo antes del `BEGIN` y el
  `COMMIT` cae dentro de `PGSTAT_MIN_INTERVAL` (1 s), así que PG difiere el volcado a `PGSTAT_IDLE_INTERVAL` (10 s). La prueba espera
  1,5 s + 5 s: cada caso ve los contadores del caso anterior (por eso pasan «asignado» y «sin filtros», que repiten los índices del
  anterior). Los planes de arriba usan exactamente los índices esperados. Arreglo sugerido: `select pg_stat_force_next_flush()` dentro de
  la transacción medida, o esperar ≥ 11 s.
- `auditoria-consulta.spec.ts` CA-8: espera la firma con `", "` entre tipos; `regprocedure::text` los separa con `","` (como en
  `escalada.adv.spec.ts`).
- Suites de 017 con el contrato anterior: `auditoria-operacion.spec.ts` (10: `listarAuditoria` sin `alcance`, que ahora falla cerrado, y
  la firma de 3 argumentos) y `packages/db/src/auditoria/lectura.spec.ts` (2: `valores` exactamente `[antes, id, límite]`; además no
  tipa sin `alcance`). Basta pasar `alcance: { tipo: "global" }`, la firma de 8 argumentos y comparar `valores.slice(0, 3)`.
