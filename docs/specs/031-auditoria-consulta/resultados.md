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

## T9 — ronda adversarial 1

Commit probado: `474318b`. `auditoria-consulta.adv.int.spec.ts`: 54 casos (35 BD, 19 HTTP), 2 hallazgos bajos (abiertos en `docs/specs/ESTADO.md` para T10). Sin fallos en alcance.

- Cubierto: inyección por filtros, RLS entre estudios, `auditoria_ms` y 017 CA-3.
- Hallazgos bajos: `/auditoria/opciones?q=%00` responde 500 en vez de 400; cursor con fecha imposible (2026-02-30) responde 200 en vez de 400 (código de 017, compartido).

## T11 · Verificación contra la spec (tester · BD `contapp_031t1`, 0088 aplicada)

Commit de partida: `07657a2` (pruebas de 017 adaptadas al contrato de alcance, aprobado por el usuario, 12 cambios: `auditoria-operacion.spec.ts` 10 casos
y `lectura.spec.ts` 2). Una línea de comentario del contrato en `tests/aislamiento/auditoria-soporte.ts:23` (opcional) actualizada.

### Suites corridas (completas)
| Suite | Resultado |
|---|---|
| `packages/shared` `src/auditoria` | 8 archivos, 223 pruebas, verde |
| `packages/db` `src/auditoria` | 5 archivos, 40 pruebas, verde |
| `tests/aislamiento` `auditoria*`, `escalada.adv`, `catalogo` | 11 archivos, 367 pruebas: 362 verde y 5 rojas (todas de `escalada.adv`, del entorno; ver abajo) |
| `apps/backend` `auditoria` + `notificaciones`, unitarias | 4 archivos, 81 pruebas, verde |
| `apps/backend` `auditoria` + `notificaciones`, `--mode int` | 7 archivos, 184 pruebas, verde (sin Redis arriba en esa corrida: la cola degrada y el reconciliador repone) |
| `apps/frontend` `auditoria` + `clientes` | 31 archivos, 356 pruebas, verde |
| E2E `auditoria.e2e.ts` (`E2E_CONSERVAR_BD=1`, `E2E_CORREO=consola`, `--trace off`) | 2 de 2 verde, tras corregir 2 defectos de la propia prueba (ver «Hallazgos») |

### Fallos del entorno (aparte, comparados con la base)
- `escalada.adv.spec.ts`, 5 pruebas (SECURITY DEFINER fuera de esquemas del sistema; funciones de 025, 026, 027 y 028): la única diferencia es el rol
  `contapp_pruebas` (superusuario del entorno) en la lista de roles con EXECUTE. Corrida de **la versión de la base** (`f907478`) de esa suite contra
  `contapp_031t3` (sin 0088: función de 3 argumentos, sin `auditoria_ms`): **los mismos 5 fallan**. No los causa 031; 0088 no toca esas funciones.
- No entraron en las suites de T11 y no se corrieron: `correo-funciones` (1), `reglas-lote` (2), `credencial-r1a` MERGE…RETURNING (1).

### Criterios (evidencia)
- **CA-1 cumplido.** `auditoria-consulta.spec.ts` «CA-1 · cada filtro, solo y combinado, iguala a la consulta de referencia» (alcance global, páginas de 7, incluye usuario
  inexistente, cliente de otro estudio, acción sin filas, rango vacío, usuario + `credencial.descifrada`), P-6 y filtro de `credencial.descifrada`; HTTP: `auditoria-consulta.int.spec.ts` «CA-1»;
  `consulta.spec.ts` de `db` y `consulta.spec.ts` de `shared`.
- **CA-2 cumplido.** `auditoria-consulta.spec.ts` «CA-2» (unión de páginas igual a la referencia, empates de ms entre ramas, 23:59:59.999 entra y 00:00 siguiente no, `desde` inclusivo, 50 máx.);
  `auditoria-consulta.int.spec.ts` «CA-2» (50 exactas → `siguiente` null; 51 → otra página; bordes de ms); ADV-H4 (cursores forjados).
- **CA-3 cumplido.** `auditoria-consulta.int.spec.ts` «CA-3 (HU-39)» (cliente.editado antes → después, periodo.estado_cambiado, asignacion.tipo_cambiado, credencial.* con autor, descifrado como Sistema,
  compra.operacion; sin cliente no salen) y «editar un cliente por la API aparece primero en su historial»; E2E «ficha → Ver historial → editar el cliente → el cambio aparece con antes y después».
- **CA-4 cumplido.** `auditoria-consulta.spec.ts` «CA-4» y `auditoria_descifrado_listar: filtros, alcance en la función y falla cerrado`; HTTP «CA-4 · alcance» (rol propio asignado, 404 idéntico para
  no asignado/otro estudio/inexistente, sin asignaciones, quitar la asignación en sesión, Dueño/Administrador/rol global ven todo); ADV-1 a ADV-3 y ADV-H3; E2E segundo caso (404 en español).
- **CA-5 cumplido.** `auditoria-consulta.spec.ts` «CA-5 · dos estudios» (5 pruebas, incluye usuario miembro de ambos y motivo del descifrado) y «con la sesión de Y no sale ningún descifrado de X»; HTTP «CA-5»;
  `auditoria-operacion.spec.ts` «CA-7» (017) con la firma nueva.
- **CA-6 cumplido.** `auditoria-consulta.int.spec.ts` «CA-6» (tabla con y sin `auditoria.ver`: 200/403 en los dos endpoints, el permiso se evalúa antes que los filtros, 401 sin sesión).
- **CA-7 cumplido.** `auditoria-consulta.int.spec.ts` «CA-7» (UUID mal formado, acción fuera del catálogo, más de 10, fecha inválida, `desde` > `hasta`, parámetro desconocido: 400 sin tocar la BD;
  comillas y `;` no alteran la consulta), `consulta.spec.ts` de `shared`, ADV-2 y ADV-H1, H2, H5 (el 500 por `q` con NUL y el cursor con fecha imposible de T9 quedaron corregidos en `9c49632`).
- **CA-8 cumplido.** `auditoria-consulta.spec.ts` «existe UNA sola firma, de 8 argumentos; la de 017 ya no existe», grants y salida sin datos de la credencial; HTTP «CA-8» (centinelas en respuestas y logs, también con
  filtros y datos inválidos); 017 CA-3 y 003 en ADV-5 y `auditoria-tablas.spec.ts`; `escalada.adv` de la función de 0088 en verde.
- **CA-9 cumplido por la medida del plan** (escala, sin tope de reloj): `auditoria-consulta.rendimiento.spec.ts`, 22 pruebas verdes con 200 000 filas y 50 000 descifrados: «escala como índice» (razón ≤ 2) en los 7 filtros,
  «cada filtro usa el índice esperado» (`pg_stat_user_indexes`/`pg_stat_user_tables`, 7 de 7) y EXPLAIN por filtro de T5 (arriba). p95 informativo, esta corrida (ms): acción rara 0,8 · usuario raro 0,9 · cliente chico 1,3 ·
  asignado 1,9 · solo descifrados 1,4 · ventana 1,6 · sin filtros 1,4 (todos < 300). Nota: el p95 es del motor con la BD local, no de HTTP.
- **CA-10 cumplido.** `page.filtros.spec.tsx` (P-2 30 días y `todo=1`; filtros de la URL sobreviven al recargar y se repintan; cambiar un filtro descarta el cursor; inactivo marcado; aviso de descifrados sin autor; vacío, 404, 400 y 500
  en español; enlace de compras solo con `compras.ver`), `page.historial.spec.tsx` (P-1: «Ver historial» solo con `auditoria.ver`) y la E2E (recarga con el filtro puesto, 404 sin código crudo).
- Casos reales aplicables: ninguno (spec).

### Revisión de `auditoria.service.spec.ts` (editada por T7)
Comparada contra la base: (1) todas las llamadas a `listar` pasan ahora `GLOBAL` y los `toEqual` de `listarAuditoria` suman `alcance` y `filtros` (`SIN_FILTROS`), es decir comprueban **más**, no menos; (2) «una clave ajena» pasó de
`usuarioId` a `tenantId` porque `usuarioId` es ahora un filtro legítimo, y se **agregó** «un usuarioId que no es UUID» que da 400; `limite`, cursor mal formado, cursor no texto y consulta no objeto siguen dando 400 sin abrir la BD; (3) ninguna aserción se
eliminó ni se relajó. Limitación señalada: el unitario solo usa alcance global; el alcance asignado y los filtros reales los cubren las pruebas de BD y HTTP de CA-4. No se debilita ninguna verificación.

### Hallazgos
1. **Defectos de la E2E `auditoria.e2e.ts` (de T4, corregidos aquí; no hay defecto de producción):** (a) `getByLabel("Cliente")` por subcadena resolvía a 12 elementos (el combobox y 11 casillas «… un cliente»): ahora `{ exact: true }`; (b) esperaba un historial
   vacío antes de editar, pero la siembra del cliente deja la fila «Creó un cliente» (actor Sistema), así que la pantalla correctamente no estaba vacía: ahora comprueba esa fila y que aún no hay «Editó un cliente». El vacío con filtros sigue cubierto en `page.filtros.spec.tsx`.
2. Aviso `PG_INVALID_DATE` de `pg` en `auditoria-consulta.adv.spec.ts` (entrada hostil deliberada de la prueba, no un camino de producción); informativo.
3. Entorno E2E: Node 22 (el repo pide ≥ 24.1) y sin Mailpit: se usó `E2E_CORREO=consola` (modo documentado en `tests/e2e/README.md`); Chromium de `/opt/pw-browsers`.

### Pendiente
Ninguno de los CA. Fuera de T11: la corrida de CI en PR la gestiona el orquestador; los 4 fallos conocidos de otras suites quedan sin correr aquí.

## Corrección post-T11

Corrección posterior al cierre (7258f29): el enlace de `compra.operacion` usaba el permiso inexistente `compras.ver`; ahora `clientes.ver`. La verificación de T11 no lo detectó porque la prueba simulaba el permiso.

Commits: `be13de3` (prueba) y `7258f29` (corrección).

## Corrección post-CI

La métrica de CA-9 pasó de tiempo de CPU del backend de PG leído por `/proc/<pid>/stat` a buffers (shared hit + read) de `EXPLAIN (ANALYZE, BUFFERS)` sobre la misma consulta y parámetros de `listarAuditoria`. Motivo: en CI Postgres 17 es un contenedor de servicio y su pid no existe en el `/proc` del runner (`ENOENT`, 7 casos «escala»); además `medirEscala` mide CPU del proceso de Node y no de PG, así que no sirve para esta consulta. Los buffers son deterministas (no dependen de la carga ni de la caché) y miden «escala como índice» sin tope de reloj. Se conserva el criterio: razón carga completa / un cuarto ≤ 2 (piso de 10 buffers), los asserts de índice esperado y sin recorrido secuencial, y el p95 solo informativo. Razones obtenidas (cuarto → completa): acción rara 43 → 43 · usuario raro 43 → 43 · cliente chico 88 → 87 · asignado 91 → 90 · solo descifrados 8 → 7 · ventana 10 → 11 · sin filtros 11 → 9 (todas ≈ 1,0). Sin lectura de `/proc` en ninguna ruta de la prueba.
