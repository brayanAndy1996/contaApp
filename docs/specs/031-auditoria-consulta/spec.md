# Spec 031 · Consulta de auditoría con filtros e historial por cliente

Estado: aprobada (2026-11-27)
Nivel de riesgo: B. (1) no; (2) sí (alcance); (3) sí; (4) no. §2.1 literal da A; se fija B porque la RLS entre estudios no cambia, con ADV acotado (D-8). Confirmado por el usuario.
Cubre: RF-151 · HU-39. Rama `spec/031-auditoria-consulta`, sobre 030.

## Objetivo
Que quien tenga `auditoria.ver` filtre la auditoría por usuario, cliente, acción y fechas, y vea el historial de un cliente (quién cambió qué, de → a, cada descifrado). Hoy (017 P-2) solo hay lista por fecha.

## Alcance
- `GET /auditoria` con `usuarioId`, `clienteId`, `accion` (varias), `desde` y `hasta`, combinados con AND, más el cursor de 017.
- `GET /auditoria/opciones` (D-6).
- Migración 0088 y filtros de `configuracion/auditoria` en la URL; historial por cliente según P-1.

## Fuera de alcance
- Exportar (P-4), la purga a 5 años (RNF-021), auditar la consulta y el texto libre sobre `datos`.
- Catálogo, triggers e inmutabilidad de 017; columnas, datos y grants de `auditoria_descifrado` (003).

## Decisiones
- D-1 Los filtros van en SQL fijo y parametrizado (ausente = `null`) en las dos ramas de la unión, antes de cada LIMIT. «¿Hay siguiente?» usa los mismos filtros. Cursor (ocurridaEn, id) sin estado; se reinicia al cambiar filtros.
- D-2 Zod en `shared`: ids UUID; hasta 10 acciones de `accionAuditoriaSchema` (catálogo vigente, 017 a 030). Las fechas `YYYY-MM-DD` son de Lima: de las 00:00 de `desde` a las 00:00 del día siguiente a `hasta`, con `desde` ≤ `hasta`. Lo desconocido o inválido da 400 sin tocar la BD.
- D-3 El alcance sale de `alcanceEfectivo` (030) y pasa a `filtroAlcance` (005 D5) sobre `cliente_id`. El mismo predicado va dentro de la función de descifrados, antes de su LIMIT. Rige aun sin filtros: cierra la brecha de 030 por la que un rol propio asignado con `auditoria.ver` ve todo el estudio. Sin asignaciones, nada. Las filas sin cliente siguen P-5. Un `clienteId` no visible da el 404 de uno inexistente (`clienteVisible`).
- D-4 El filtro de usuario compara con `usuario_id`; en el worker, es el `creado_por` del trabajo (P-6). No se valida pertenencia (la RLS acota). Los descifrados no guardan actor: nunca salen con `usuarioId`; la pantalla lo avisa.
- D-5 La salida no cambia (`paginaAuditoriaSchema`, lista blanca de 017 D-5).
- D-6 `/auditoria/opciones` pide `auditoria.ver` y devuelve miembros activos e inactivos `{id, nombre, activo}` y clientes visibles buscados por RUC o razón social (máx. 20, con archivados). Hace falta porque 030 U3 no exige `usuarios.ver` ni `clientes.ver`; el catálogo ya está en `shared`; los eliminados no salen.
- D-7 La migración 0088 reemplaza `auditoria_descifrado_listar`: quita la firma de 017 y agrega cliente, fechas y alcance, con el mismo dueño y `search_path` y EXECUTE solo para `contapp_backend`. Suma los índices que el plan justifique con EXPLAIN en `auditoria` (usuario, acción) y en `auditoria_descifrado` (hoy solo PK): solo índices, ampliando 017 D-6; el `date_trunc` no debe anularlos.
- D-8 ADV acotado al alcance en ambas ramas (asignado o no, sin asignaciones, dos estudios) y a que ningún filtro altere el SQL.

## Criterios de aceptación
- [ ] CA-1 (RF-151): cada filtro, solo y combinado, iguala a una consulta de referencia con descifrados.
- [ ] CA-2: con filtros, el cursor no repite ni salta filas entre ramas; «siguiente» es `null` solo al final. 23:59:59.999 de `hasta` (Lima) entra; 00:00 siguiente no.
- [ ] CA-3 (HU-39): con `clienteId` salen `cliente.editado` (antes → después), `periodo.estado_cambiado` y `asignacion.tipo_cambiado` (de → a), `credencial.*` con autor, `credencial.descifrada` como «Sistema» y `compra.operacion` (P-3). Sin cliente (p. ej. `miembro.rol_cambiado`) no salen.
- [ ] CA-4 (alcance): un rol propio asignado ve solo sus clientes en ambas ramas, con y sin filtros. Sin asignaciones, vacío; cliente no asignado, 404 de inexistente. Dueño y Administrador ven todo.
- [ ] CA-5 (RNF-001): con dos estudios, ni ids ajenos ni la función con la sesión de A devuelven filas del otro.
- [ ] CA-6: sin `auditoria.ver`, los dos endpoints dan 403. Prueba de tabla con rol propio con y sin el permiso.
- [ ] CA-7: un UUID mal formado, una acción fuera del catálogo, más de 10 acciones, una fecha inválida, `desde` > `hasta` o un parámetro desconocido dan 400. Comillas o `;` no alteran la consulta.
- [ ] CA-8: ninguna credencial centinela aparece en respuestas ni logs. La firma de 017 ya no existe y 017 CA-3 sigue verde.
- [ ] CA-9 (RNF-034): con 200 000 filas y 50 000 descifrados, el p95 es < 300 ms por filtro, con una acción rara y con un asignado a un cliente de pocas filas, y el plan usa los índices.
- [ ] CA-10 (frontend): los filtros sobreviven al recargar; inactivos marcados; vacío, error y 404 visibles en español; HU-39 según P-1.
- [ ] Casos reales aplicables: ninguno.

## Dependencias
- Specs: 017, 005 (`filtroAlcance`, `clienteVisible`), 030 (resolvedor; migraciones hasta 0087), 003.
- Externas: ninguna.

## Decisiones del usuario (2026-11-27)
- P-1 a) Filtro de cliente más enlace «Ver historial» en la ficha, que abre la pantalla filtrada.
- P-2 a) Abre con los últimos 30 días, editable, o «todo el historial».
- P-3 a) `compra.operacion`: tipo y cantidad, con enlace al Historial del periodo (015).
- P-4 a) Sin exportación.
- P-5 a) Con alcance asignado, las filas sin cliente no se ven.
- P-6 a) El filtro de usuario cubre lo que hizo él, con los trabajos que lanzó.
