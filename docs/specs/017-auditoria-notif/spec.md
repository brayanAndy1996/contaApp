# Spec 017 · Auditoría y notificaciones en la app

Estado: hecha (2026-11-11). Aprobada el 2026-11-11 (el usuario eligió la opción recomendada en P-1 a P-7, ver «Decisiones del usuario»). Rama `spec/017-auditoria-notif`. Plan: `plan.md` · tareas: `tasks.md`.
Nivel de riesgo: **B**, según el tablero, con ronda adversarial en tres puntos concretos (D-16). Por §2.1: (1) no, porque no calcula montos ni genera archivos; (2) sí, porque una notificación o una fila de auditoría mal filtrada muestra datos de otro cliente, usuario o estudio; (3) sí, porque una acción que no se audita no la nota nadie; (4) parcial, porque son muchos puntos de captura y hay carreras entre el hecho y el aviso. Con (2) y (3), la tabla de §2.1 da **A**; el usuario eligió **B** con una ronda adversarial dirigida (P-1, D-16).
Cubre: RF-150, RF-152, RF-160 (sin buzón), RF-026 (filtro de notificaciones), RNF-001, RNF-004, RNF-021 (auditoría) · HU-10 (notificación), parte de HU-40 · notas [017] de ESTADO (notificador real, «quién marcó revisado», «XML subido por», autor del Historial).

## Objetivo
Que el estudio tenga un registro de solo agregado de quién hizo qué (RF-150/152) y que cada usuario reciba en la app los avisos que le tocan (RF-160), sobre todo «la clave de un cliente dejó de funcionar» (HU-10). La entrega debe ser exactamente una vez y solo debe verse lo que el usuario puede ver. De paso, las pantallas muestran el nombre del autor en vez de un id corto.

## Alcance
- Tabla `auditoria` general, solo de agregado, que se llena en la misma transacción de cada acción del catálogo de D-3.
- Tabla `notificacion`, el notificador real que reemplaza a `NotificadorLog` de 008, la API de notificaciones del usuario, la campana y la página `notificaciones` en el frontend (nivel C por tarea).
- Autor con nombre (D-12) en «revisado por» (014/015 D-13), el Historial de 015, «XML subido por» (016) y las versiones de archivo de 012b.
- La consulta mínima de auditoría de P-2: lista paginada por fecha, sin filtros, solo con `auditoria.ver`.
- Migraciones desde la **0041**.

## Fuera de alcance
- Filtros de auditoría por usuario, cliente, acción y fechas (RF-151) y el historial por cliente de HU-39: **R2**.
- Mensaje crítico de buzón (RF-160, HU-33): **R2** (los buzones son R2). El catálogo deja el tipo reservado.
- Correo configurable (RF-161), correo de cualquier aviso y resumen diario (RF-162): **R2** (P-6). La cola `notificaciones` y `notificacion.enviar` quedan para entonces.
- Envíos a SUNAT (RF-104): **R2**. El catálogo deja reservada `sunat.envio`.
- Acceso de soporte del super-admin auditado (RNF-022): **R2**.
- Purga de auditoría con más de 5 años: tarea de mantenimiento futura (D-7).
- Cambios en el cifrado ni en `auditoria_descifrado` de 003 (D-6).

## Decisiones
- D-1 **`auditoria`.** Columnas: `tenant_id`, `ocurrida_en`, `actor_tipo` (`usuario` | `trabajo` | `sistema`), `usuario_id`, `trabajo_id`, `accion` (catálogo cerrado `dominio.verbo` con CHECK), `cliente_id` (nullable), `entidad` y `entidad_id`, y `datos` jsonb de hasta 4 KB. RLS forzada por `tenant_id`, PK uuid v7 e índices (tenant, ocurrida_en desc) y (tenant, cliente_id, ocurrida_en desc).
- D-2 **Solo agregado (RF-152).** Los roles de la app (`contapp_backend`, `contapp_worker`, `contapp_app` y `contapp_platform`) no tienen INSERT, UPDATE, DELETE ni TRUNCATE sobre `auditoria`. Solo escribe una función `SECURITY DEFINER` (`auditoria_registrar`), a la que llaman los triggers y las funciones `auth.*`. Hay triggers que rechazan UPDATE, DELETE y TRUNCATE incluso al dueño de la tabla. La lectura es solo SELECT dentro de `withTenant`, y la ruta exige `auditoria.ver`.
- D-3 **Captura por triggers en la misma transacción**, que falla cerrado como 003 D3: si no se puede auditar, la acción se revierte. Así ningún módulo puede olvidarse de auditar. El actor sale del contexto de la transacción (`app.user_id`; en el worker, el trabajo y su `creado_por`), nunca del cuerpo de la petición. Catálogo R1:
  - Sesión: `sesion.ingreso`, al fijar el estudio activo (login o cambio de estudio). Los intentos fallidos no tienen estudio y siguen en `intento_login` de 004.
  - Acceso (005): `invitacion.creada`, `invitacion.revocada`, `miembro.alta`, `miembro.rol_cambiado`, `miembro.desactivado`, `miembro.reactivado`, `asignacion.agregada`, `asignacion.quitada`.
  - Clientes (007a): `cliente.creado` (con `origen`: manual o importación), `cliente.editado` (campos de cliente y de perfil fiscal, antes → después), `cliente.archivado`, `cliente.reactivado`.
  - Credenciales (007b/008): `credencial.guardada`, `credencial.verificada`, `credencial.invalidada`. Solo llevan el tipo y el estado (D-5).
  - Libros (013/014/016/012b): `propuesta.cargada` (descarga o importación), `compra.operacion` (D-4), `venta.agregada`, `venta.excluida`, `venta.restaurada`, `venta.salto_justificado`, `xml.subido`, `periodo.estado_cambiado` (libro, de → a) y `archivo.generado` (versión y SHA-256).
- D-4 **Cambios en filas.** Se registra una fila de auditoría por operación de 014 (`compra_operacion`: clasificar, editar, excluir, restaurar, agregar, descartar, aceptar sugerencia, deshacer, rehacer), con su tipo, la cantidad de filas y el id de la operación, no una fila por compra. El antes → después de cada compra se reconstruye desde `compra_version`, que es inmutable (ADR-09, 014 D-12). Una masiva de 5.000 filas deja un registro y no se duplican montos. Exclusiones y restauraciones entran aquí.
- D-5 **Qué entra en `datos`.** Una lista blanca por acción, nunca una lista negra. Nunca entran cifrados, DEK, nonce, hashes de contraseña, tokens ni el contenido del XML (RNF-004). Tampoco montos: los de las filas se leen de `compra_version` (D-4).
- D-6 **Descifrados.** `auditoria_descifrado` de 003 (nivel A, ya probada) no se toca ni se migra. Es la acción `credencial.descifrada` y la consulta (P-2) la une a `auditoria`. Con esto, 017 «la integra» (003 D3).
- D-7 **Retención de auditoría.** 5 años (RNF-021). R1 no purga, porque la app no tiene esa antigüedad, y la purga queda como nota en ESTADO.
- D-8 **`notificacion`.** Columnas: `tenant_id`, `usuario_id` (destinatario), `tipo` (catálogo con CHECK: `credencial_invalida`, `trabajo_terminado`, `plan_limite`, `buzon_critico` reservado R2), `cliente_id` y `trabajo_id` (nullables), `params` jsonb de hasta 1 KB (solo códigos e ids), `clave_dedupe` única por (tenant, usuario), `creada_en` y `leida_en`. RLS por tenant más una política de lectura y de UPDATE de `leida_en` solo para `usuario_id = app.user_id`. El backend no hace INSERT ni DELETE. El worker solo hace INSERT de columnas acotadas.
- D-9 **Entrega exactamente una vez.** La notificación se inserta en la misma transacción que el hecho: `marcarCredencialInvalida` que devuelve `true`, la transición terminal ganadora del trabajo (008 D2) o el cambio de uso del plan. Así reemplaza a `NotificadorLog`: si el hecho se confirma, la notificación existe, y si se revierte, no. Después del commit, el puerto `Notificador` solo publica en `eventos:{tenantId}` un aviso sin contenido, y el SSE se lo reenvía únicamente al destinatario. Si ese aviso se pierde, la campana se actualiza al recargar la página o al reconectar.
- D-10 **Visibilidad al leer (RF-026).** Una notificación con cliente solo se lista y cuenta si el cliente sigue visible para el usuario según `filtroAlcance` de 005. La de otro usuario o de otro estudio da el mismo 404 que una inexistente.
- D-11 **API y pantalla.** `GET /notificaciones` (cursor, máx. 50, de la más nueva a la más vieja), `GET /notificaciones/no-leidas` (conteo, con tope que se muestra «99+»), `POST /notificaciones/:id/leida` (idempotente) y `POST /notificaciones/leidas` (marca todas hasta un instante dado). El texto en español se arma en el frontend a partir del `tipo` y los `params`, con enlace al cliente o al trabajo. La campana va en la barra superior.
- D-12 **Autor con nombre.** El backend devuelve `autor { id, nombre, activo }` y lo resuelve por `membresia` del mismo estudio unida a `usuario`. Un id que no es miembro del estudio da «Usuario desconocido», sin el nombre. Un miembro desactivado sale como «Nombre (inactivo)». Lo ve quien ya ve la fila (`clientes.ver`), porque es un compañero del mismo estudio. Cierra las tres notas [017] y la deuda «versiones sin usuario» de 012b.
- D-13 **Migraciones** desde la 0041, con RLS forzada en las dos tablas y la prueba de aislamiento de 002 ampliada a ellas.
- D-14 **Trazas.** Ni `datos`, ni `params`, ni razones sociales en logs (RNF-004/083). Solo ids y códigos.
- D-15 **Rendimiento.** El trigger hace un solo INSERT por acción. RNF-034 (p95 < 300 ms) se mide en las rutas de compras con la auditoría activa.
- D-16 **Adversarial acotado (nivel B).** Una ronda sobre (a) aislamiento y visibilidad de notificaciones y auditoría, (b) inmutabilidad y actor no falsificable y (c) ausencia de secretos en `datos` y `params`.

## Criterios de aceptación
- [x] CA-1 (catálogo, RF-150): cada acción de D-3 deja exactamente una fila en `auditoria`, en la misma transacción, con actor, cliente, entidad y `datos` según D-5. Hay una prueba por acción.
- [x] CA-2 (falla cerrado): si el INSERT de auditoría falla (simulado), la acción se revierte y no queda ni la acción ni el registro.
- [x] CA-3 (solo agregado, RF-152): con los roles del backend y del worker, el INSERT directo, el UPDATE, el DELETE y el TRUNCATE sobre `auditoria` dan `permission denied`. Con el dueño de la tabla, el UPDATE y el DELETE los rechaza el trigger.
- [x] CA-4 (actor): un `usuarioId` que llega en el cuerpo o la consulta se ignora y el actor es el de la sesión. Las acciones del worker registran `trabajo_id` y `creado_por`.
- [x] CA-5 (filas, D-4): una masiva de 300 compras deja una fila `compra.operacion` con `filas = 300`, y una consulta probada devuelve el antes → después de cada compra desde `compra_version`.
- [x] CA-6 (sin secretos): tras guardar, verificar, invalidar y descifrar credenciales con valores centinela, ningún valor centinela aparece en `auditoria`, `notificacion`, logs ni respuestas.
- [x] CA-7 (aislamiento, RNF-001/HU-40): con dos estudios, ni la API ni el SQL directo con la sesión de A devuelven auditoría o notificaciones de B.
- [x] CA-8 (HU-10): un `ErrorCredencial` crea una notificación `credencial_invalida` para cada destinatario de P-4. Si la transacción se revierte, no la crea. Un fallo repetido con la credencial aún inválida no crea otra. Tras reemplazar la credencial, una nueva invalidación sí la crea. Si el worker muere después del commit y antes del aviso, la notificación existe.
- [x] CA-9 (trabajo terminado): se notifica según P-3, una vez por trabajo, aunque haya reintentos.
- [x] CA-10 (plan): se notifica según P-5, una vez por cruce de umbral, y vuelve a avisar solo si el uso baja del umbral y lo cruza otra vez.
- [x] CA-11 (visibilidad, RF-026): un Asistente desasignado del cliente deja de ver y de contar su notificación. Leer o marcar como leída una notificación ajena da 404 y no la cambia.
- [x] CA-12 (API): el orden, el cursor, el conteo y «leer todas» funcionan, y marcar como leída es idempotente. El SSE solo avisa al destinatario y sin contenido.
- [x] CA-13 (autor, D-12): las cuatro pantallas muestran el nombre. Un miembro desactivado sale «(inactivo)». Un id de otro estudio sale «Usuario desconocido».
- [x] CA-14 (consulta, P-2): solo con `auditoria.ver` (Dueño y Administrador); sin el permiso da 403. Incluye los descifrados de 003.
- [x] CA-15 (retención): las notificaciones siguen P-7 y la auditoría no se purga.
- [x] CA-16 (frontend, nivel C): la campana muestra el conteo, el panel marca como leída y navega, y el texto sale en español sin códigos crudos.
- [ ] Casos reales aplicables: ninguno.

## Casos de abuso que se prueban
Cada uno con una prueba en CA-3, CA-4, CA-6, CA-7 o CA-11:
- Leer la auditoría o las notificaciones de otro estudio por id o por SQL.
- Leer o marcar las notificaciones de otro usuario del mismo estudio.
- Ver la notificación de un cliente que ya no está asignado.
- Abrir la consulta de auditoría sin `auditoria.ver`.
- Falsificar el actor.
- Borrar o editar la auditoría con los roles de la app.
- Colar secretos en `datos` o `params`.
- Inundar las notificaciones: se evita con la deduplicación por transición, por trabajo y por cruce de umbral.
- Inyectar HTML desde `params`: el frontend lo muestra como texto.

## Dependencias
- Specs: 002, 003, 004, 005, 006, 007a, 007b, 008, 012b, 013, 014, 015 y 016 (todas hechas).
- Externas: ninguna.

## Decisiones del usuario (2026-11-11)
Eligió en todas la opción recomendada:
- P-1 → (a) **Nivel B** con una ronda adversarial dirigida a aislamiento, inmutabilidad de la auditoría (con actor no falsificable) y secretos (D-16).
- P-2 → (a) Consulta de auditoría en R1: **lista paginada por fecha, sin filtros**, en `configuracion/auditoria`, solo para Dueño y Administrador (`auditoria.ver`). Los filtros de RF-151 quedan para R2.
- P-3 → (a) Avisan al terminar, con éxito o con error, **los trabajos que un usuario lanzó desde la pantalla** (prioridad interactiva y `creado_por`). Los programados, los lotes de `xml.obtener` tras la descarga, los de sistema y los cancelados no avisan.
- P-4 → (a) «Credencial inválida» va al **responsable del cliente**; si el cliente no tiene responsable, a los **Dueños y Administradores** activos.
- P-5 → (a) Límite del plan: aviso a los **Dueños** al llegar al **90 %** y al **100 %** de RUCs o de usuarios.
- P-6 → (a) **Sin correo en R1**: solo la app. El correo queda para R2 (RF-161).
- P-7 → (a) Las notificaciones **se purgan a los 90 días** de creadas, leídas o no. El usuario no las borra, solo las marca como leídas.
- Preguntas del plan (2026-11-11), recomendada en ambas: si aceptar una invitación cruza el 90 % o el 100 % de usuarios, el aviso se guarda pero **no se empuja en vivo** (la campana lo muestra al recargar); si el super-admin cambia los límites de un plan, **no se avisa al momento**: el aviso sale en el siguiente cambio de uso del estudio.
