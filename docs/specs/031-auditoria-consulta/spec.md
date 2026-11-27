# Spec 031 · Consulta de auditoría con filtros e historial por cliente

Estado: borrador (pendiente de resolver las preguntas abiertas)
Nivel de riesgo: B (§2.1): (1) no, sin montos ni archivos; (2) sí, un filtro o alcance mal aplicado muestra auditoría de clientes no visibles o de otro estudio; (3) parcial, un filtro que omite filas pasa inadvertido; (4) no, lectura más migración aditiva. TDD en todas las tareas; una ronda adversarial acotada (D-8).
Cubre: RF-151 · HU-39 (apoya RF-150/152 de 017). Rama `spec/031-auditoria-consulta`, sobre 030.

## Objetivo
Que Dueño, Administrador o un rol propio con `auditoria.ver` filtre la auditoría por usuario, cliente, acción y fechas, y vea el historial de un cliente (quién cambió qué, antes → después, cada uso de sus credenciales por el sistema). Hoy (017 P-2) solo hay lista paginada por fecha.

## Alcance
- `GET /auditoria` con filtros combinables (AND): `usuarioId`, `clienteId`, `accion` (una o varias), `desde`, `hasta`, `cursor`. Esquemas Zod en `packages/shared`.
- `GET /auditoria/filtros` (`auditoria.ver`): miembros `{id, nombre, activo}`, búsqueda de clientes visibles por RUC o razón social (máx. 20) y catálogo de acciones; sin exigir `usuarios.ver` ni `clientes.ver`.
- Migración **0088** (primera libre tras 030) y pantalla `configuracion/auditoria` con filtros en la URL; historial por cliente según P-1.

## Fuera de alcance
- Exportar (P-4), purga de más de 5 años (037, RNF-021), auditar la propia consulta, texto libre sobre `datos`.
- Cambios al catálogo, los triggers, la inmutabilidad o `auditoria_descifrado` (017).

## Decisiones
- D-1 **Filtros en SQL, antes del LIMIT y en las dos ramas** de la unión (`auditoria` y descifrados de 003); filtrar después de paginar rompe páginas y cursor. Todo parametrizado.
- D-2 **Validación:** UUID en `usuarioId` y `clienteId`; `accion` del catálogo de 017 más `credencial.descifrada` (máx. 10); `desde`/`hasta` como `YYYY-MM-DD` en America/Lima, `hasta` inclusive, `desde` ≤ `hasta`. Lo inválido da 400 sin tocar la BD.
- D-3 **Cursor sin estado** (ocurridaEn, id) como en 017; el cliente reenvía los filtros y reinicia el cursor al cambiarlos.
- D-4 **Alcance (005 D5, 030):** permisos efectivos del resolvedor de 030 y `filtroAlcance`, nunca `rol IN (...)`. Alcance asignado ve solo filas de sus clientes asignados; las filas sin cliente (ingresos, miembros, roles) no. Un `clienteId` fuera de alcance da el mismo 404 que uno inexistente o de otro estudio.
- D-5 **Filtro por usuario** = `usuario_id` de la fila (en el worker, quien lanzó el trabajo). Los descifrados de 003 son actor `sistema`: no salen al filtrar por usuario y sí por cliente, acción o fechas (HU-39). Un miembro desactivado sigue filtrable, «(inactivo)».
- D-6 **Migración 0088:** índices (tenant, `usuario_id`, `ocurrida_en` desc) y (tenant, `accion`, `ocurrida_en` desc); `auditoria_descifrado_listar` con cliente, fechas y clientes permitidos. No concede INSERT, UPDATE, DELETE ni TRUNCATE.
- D-7 **Salida sin cambios** (`filaAuditoriaSchema` de 017); `datos` ya sale de lista blanca (017 D-5). El frontend solo depende de `packages/shared`.
- D-8 **Adversarial acotado, un punto:** la nueva función SQL de descifrados y el alcance asignado (aislamiento entre estudios y entre clientes asignados y no; ningún parámetro altera el SQL). El resto sin ADV.

## Criterios de aceptación
- [ ] CA-1 (RF-151): usuario, cliente, acción y fechas filtran por separado y combinados; el resultado iguala a una consulta de referencia sobre datos sembrados, descifrados incluidos.
- [ ] CA-2 (paginación y fechas): recorrer con cursor no repite ni salta filas aun mezclando ambas ramas; `hasta` incluye todo el día en hora de Lima (23:59 entra, 00:00 siguiente no).
- [ ] CA-3 (HU-39): con `clienteId` se ve cada acción con usuario (o «Sistema»), fecha y de → a donde 017 lo guarda (`cliente.editado`, `periodo.estado_cambiado`, `miembro.rol_cambiado`), más cada `credencial.descifrada` y las operaciones de compra.
- [ ] CA-4 (alcance): rol propio con `auditoria.ver` y alcance asignado ve solo filas de sus clientes y ninguna sin cliente; un cliente no asignado da 404 idéntico al inexistente. Dueño y Administrador ven todo.
- [ ] CA-5 (aislamiento, RNF-001): con dos estudios, ningún filtro (ids ajenos, SQL directo con la sesión de A) devuelve filas del otro.
- [ ] CA-6 (permiso): sin `auditoria.ver`, ambos endpoints dan 403 sin datos; prueba de tabla con rol propio con y sin el permiso.
- [ ] CA-7 (validación): UUID mal formado, acción fuera de catálogo, más de 10 acciones y fecha inválida dan 400; comillas o `;` en un filtro no alteran la consulta.
- [ ] CA-8 (secretos y solo agregado): con centinelas en credenciales, ninguno aparece en respuestas ni logs; las pruebas de 017 CA-3 siguen verdes tras 0088.
- [ ] CA-9 (RNF-034): con 200 000 filas en un estudio, p95 < 300 ms filtrando por cliente, usuario y acción, con los índices en el plan.
- [ ] CA-10 (frontend): filtros en la URL (recargar los conserva), inactivos marcados, vacío y error visibles, español sin códigos crudos; HU-39 cumplible según P-1.
- [ ] Casos reales aplicables: ninguno.

## Dependencias
- Specs: 017 (tabla, catálogo, consulta mínima), 005 (`filtroAlcance`), 030 (permisos efectivos; migraciones hasta 0087), 003 (descifrados).
- Externas: ninguna.

## Preguntas abiertas
- P-1 ¿Dónde se ve el historial por cliente (HU-39)?
  - (a) (Recom.) Filtro de cliente en la pantalla de auditoría y enlace «Ver historial» en la ficha del cliente que la abre ya filtrada.
  - (b) Solo el filtro de cliente en la pantalla de auditoría.
  - (c) Pestaña «Historial» en la ficha del cliente, con vista propia.
- P-2 ¿Qué rango de fechas muestra la pantalla al abrirla?
  - (a) (Recom.) Últimos 30 días, editable, con opción «todo el historial».
  - (b) Todo el historial, sin rango inicial.
- P-3 ¿Cómo se ve el antes → después de cada compra en `compra.operacion`?
  - (a) (Recom.) Tipo y cantidad en la fila, con enlace al Historial del periodo de 015, que ya lo trae desde `compra_version`.
  - (b) Expandir la fila aquí con el antes → después de cada compra (más trabajo).
- P-4 ¿Se exporta el resultado filtrado?
  - (a) (Recom.) No en esta spec; RF-151 pide consultar.
  - (b) CSV del filtro actual, con tope de filas y el mismo alcance.
