# Spec 024 · Bandeja de buzones

Estado: aprobada (2026-11-20). Rama `spec/024-bandeja-buzones` (desde la punta de 023). Plan: `plan.md` · tareas: `tasks.md`.
Nivel de riesgo: **B** con una ronda adversarial (P-10). Por 04 §2.1: (1) no: no calcula montos ni genera archivos, y nada se marca como leído en SUNAT (todo lo que toca el portal sigue en 023); (2) sí: la bandeja junta mensajes de muchos clientes en una sola consulta, y un fallo de alcance mostraría mensajes de un cliente no asignado o de otro estudio; (3) a medias: un mensaje que falta en la bandeja o un «atendido» que no le toca no se nota sin abrir el cliente; (4) sí: muchas combinaciones de filtros, paginación por cursor sobre ~100 000 mensajes y dos personas que atienden el mismo mensaje. La regla daría A; el usuario eligió B porque 024 no toca SUNAT, credenciales, storage ni el worker, y reutiliza RLS, `ClienteScopeGuard` y las rutas de 023, con una ronda adversarial concreta (D-11).
Cubre: RF-121, RF-124, RF-125 · HU-32, HU-34 · resaltado en rojo de RF-122 / HU-33 que 023 dejó para 024 · HU-08 (la bandeja solo muestra clientes visibles) · RNF-034 (p95), RNF-071 (buzón usable en móvil).

## Objetivo
Que el contador vea en una sola pantalla los mensajes del buzón SOL de todos sus clientes visibles, con los críticos resaltados, los filtre y marque como atendidos los que su equipo ya gestionó, y que el listado de clientes le diga cuáles tienen mensajes nuevos.

## Alcance
- **Bandeja unificada** (`/buzon`): mensajes de los clientes visibles con cliente, asunto, remitente, fecha, categoría (crítico en rojo con texto), leído en SUNAT y estado de atención; filtros, orden y paginación por cursor (D-2 a D-4).
- **Atendido** interno por mensaje, con comentario, usuario y fecha, independiente del leído en SUNAT; deshacer, historial y auditoría (D-5 a D-8). Marcar, individual y en lote; deshacer, individual.
- **Históricos** de la primera sincronización (D-12) y **permiso** `buzon.atender` (D-13).
- **Indicador de nuevos** por cliente en el listado de clientes, con filtro y enlace (D-9).
- **Detalle** en la bandeja con el `detalle-mensaje.tsx` de 023 (contenido, adjuntos, «Abrir en SUNAT») más el bloque de atención e historial; `/clientes/:id/buzon` (023) pasa a ser la bandeja fijada en ese cliente (D-10).
- La campana (`buzon_critico`) ya enlaza a `/clientes/:id/buzon?mensaje=`, que con D-10 abre el mensaje en la bandeja: su destino no cambia (D-14).
- Migraciones desde **0059** (023 llegó a 0058); la 0061, reservada para la ronda adversarial.

## Fuera de alcance
- Captura, clasificación, «Revisar buzón ahora», «Abrir en SUNAT», adjuntos y aviso crítico: 023, sin cambios de comportamiento.
- Correo y resumen diario (RF-161, RF-162): 028.
- Otros buzones distintos del SOL (casilla de otras entidades): la columna «Buzón» de RF-121 no se muestra mientras solo exista SOL (D-1).
- Búsqueda por texto del asunto, exportar la bandeja a Excel, asignar un mensaje a una persona, deshacer en lote y actualización en vivo de la bandeja (se refresca al recargar o al volver a la pestaña). Quedan como nota.
- Roles personalizados (030): 024 solo añade el permiso al catálogo y a los roles de sistema (D-13).
- Borrado del historial de atención: lo hace 037 con el cliente.

## Decisiones de diseño
- **D-1 · Un solo buzón.** Todo mensaje de `buzon_mensaje` es del buzón SOL; la bandeja no tiene columna ni filtro «Buzón». Si llega otro buzón, se añade por spec.
- **D-2 · Alcance (P-5).** Solo clientes visibles para el usuario (asignados, o todos con rol de alcance global; 01 §4) y con `buzon.ver`. Por defecto, solo clientes no archivados; «incluir archivados» los suma y «solo donde soy responsable» deja los clientes en que el usuario tiene la asignación `responsable` (también para Dueño y Administrador). Elegir un cliente lleva a su bandeja fijada (D-10): no visible, de otro estudio o inexistente da 404 igual, y uno archivado se muestra aunque «incluir archivados» esté apagado. Todo dentro de `withTenant()`; la RLS sigue forzada.
- **D-3 · Filtros.** Cliente (uno, por la bandeja fijada), «solo donde soy responsable», categoría (cualquiera de `CATEGORIAS_BUZON` o «todos los críticos»), leído en SUNAT (sí, no), estado de atención (pendientes, atendidos, históricos, todos), fecha del mensaje desde y hasta (días de Lima, inclusive) e «incluir archivados». Se combinan con Y. Parámetros desconocidos o inválidos dan 400.
- **D-4 · Orden, vista por defecto y cursor (P-6).** Orden fijo por fecha del mensaje descendente e id descendente. La pantalla abre en «Pendientes» y ofrece el filtro rápido «Críticos pendientes»; la API, sin el filtro de atención, devuelve todos (como en 023). Cursor opaco por valor (fecha, id) ligado a la huella de los filtros: con otros filtros da 400 `cursor_invalido`; nunca amplía el alcance. Página de 50 (límite ≤ 100). Como el cursor es por valor, atender mensajes mientras se pagina no salta ni repite filas.
- **D-5 · Estado e historial (P-2).** Cada marca y cada deshacer es un evento solo inserción (mensaje, acción, comentario, usuario, fecha) con RLS forzada y FK compuesta al mensaje del mismo cliente y estudio. El estado vigente (atendido, por quién, cuándo) vive en el mensaje para filtrar rápido y solo lo cambia una función acotada que escribe el evento en la misma transacción. Nadie tiene `UPDATE` directo ni `DELETE`; el worker no lo toca y una captura nueva no lo cambia (independiente del leído en SUNAT). Cualquiera con `buzon.atender` sobre el cliente puede deshacer, no solo quien marcó.
- **D-6 · Concurrencia y lote (P-3).** Marcar exige que el mensaje no esté atendido y deshacer que lo esté (compare-and-set): si otra persona se adelantó, 409 `atencion_cambiada` con el estado vigente. El lote marca hasta 100 ids seleccionados con un mismo comentario, todo en una transacción: un id no visible o inexistente da 404 a todo el lote; los que ya estaban atendidos se informan como omitidos.
- **D-7 · Comentario (P-3).** Opcional al marcar un mensaje no crítico y obligatorio al marcar un crítico (en lote, obligatorio si alguno es crítico: 400 `comentario_requerido` a todo el lote); opcional al deshacer. Texto plano de 1 a 500 caracteres tras recortar espacios, sin controles ni bidi, nunca interpretado como HTML. Visible para quien vea el mensaje. No viaja en logs, notificaciones ni `datos` de auditoría.
- **D-8 · Auditoría (017).** Acciones nuevas `buzon.atendido` y `buzon.atencion_deshecha` (una por mensaje, también en lote), actor usuario, `datos` solo con ids, si hubo comentario y si fue en lote. Atender no exige haber abierto el contenido ni llama a SUNAT.
- **D-9 · Indicador (P-7).** El listado de clientes trae por cliente el número de nuevos y, aparte, el de críticos nuevos (en rojo, con texto), en la misma respuesta y calculados en una sola consulta agregada sobre un índice parcial de pendientes (no una consulta por cliente); solo si el usuario tiene `buzon.ver`. Filtro «con mensajes nuevos» y enlace a la bandeja fijada en el cliente. Si no alcanza la meta de CA-9, se pasa a un contador por cliente mantenido en BD (Riesgos).
- **D-10 · Interfaz (P-9, estilo A de 038).** Página `/buzon` con entrada «Buzones» en el menú lateral y en la barra inferior; `/clientes/:id/buzon` muestra la misma bandeja fijada en ese cliente (con «Revisar buzón ahora» de 023), con los mismos componentes. Solo `components/ui` y tokens; crítico con `--color-error` y texto «Crítico · Coactiva» (no solo color); a 390 px, filas como tarjetas, filtros en un `Dialog` y el detalle a pantalla completa con «Volver»; en escritorio, tabla y detalle al costado.
- **D-11 · Ronda adversarial (P-10).** Una ronda, ≤ 15 pruebas, solo sobre alcance y aislamiento de la bandeja, el lote de atención, el cursor y el indicador.
- **D-12 · Nuevo e histórico (P-1).** «Nuevo» = pendiente: no atendido por nadie del equipo y no histórico. Un mensaje es histórico si entra cuando su cliente aún no tiene `sincronizado_en` y su fecha es de hace más de 30 días (la misma regla y el mismo reloj de BD del aviso de 023, P-5 y 0058). Lo decide la BD al insertar, no el worker. Los históricos se listan en «Históricos» y «Todos» y se pueden atender, pero no salen en «Pendientes» ni en «Críticos pendientes» ni cuentan en el indicador. Los mensajes ya guardados por 023 se clasifican igual en la migración.
- **D-13 · Permiso (P-4).** Permiso nuevo `buzon.atender` en Asistente, Contador, Administrador y Dueño (no Lectura), separado de `buzon.marcar_leido`.
- **D-14 · Campana (P-8).** La campana sigue igual: leída o no es de cada persona (017) y su enlace abre el mensaje en la bandeja. Atender no marca, borra ni crea notificaciones.

## Criterios de aceptación
- [ ] CA-1 (RF-121, HU-32, D-2): con dos estudios y un usuario Contador asignado a 15 de 120 clientes, la bandeja muestra solo mensajes de esos 15; Dueño y Administrador ven los 120; Lectura ve los de sus asignados; sin `buzon.ver`, 403. Los archivados no salen salvo con «incluir archivados» o en su bandeja fijada; «solo donde soy responsable» deja solo esos clientes, también para el Dueño. Desasignar un cliente lo saca de la siguiente página pedida.
- [ ] CA-2 (D-3, D-4): cada filtro y cada combinación de la tabla de casos devuelve exactamente las filas esperadas (prueba contra un oráculo en memoria), en orden fecha desc e id desc; recorrer todas las páginas da cada fila una vez, también si se atienden filas a mitad del recorrido; un cursor alterado, de otros filtros o de otro estudio da 400 o no amplía el resultado. La pantalla abre en «Pendientes» y «Críticos pendientes» filtra en un toque.
- [ ] CA-3 (RF-122, HU-33): un crítico se ve en rojo con su categoría en texto en la bandeja, el detalle y el listado de clientes, a 1440 y 390 px.
- [ ] CA-4 (RF-124, HU-34, D-7): marcar como atendido deja usuario, fecha y comentario visibles en el detalle, y el mensaje sale de «Pendientes»; marcar un crítico sin comentario da 400 `comentario_requerido`; el leído en SUNAT no cambia y una captura posterior del mismo mensaje no cambia la atención; el `MockSolPortal` no registra llamadas.
- [ ] CA-5 (D-5, D-8): deshacer, por quien marcó o por otra persona con el permiso, devuelve el mensaje a «Pendientes» (a «Históricos» si era histórico, U-2); el historial muestra todos los eventos en orden; cada evento deja su acción de auditoría sin el texto del comentario; la BD rechaza `UPDATE` y `DELETE` del historial y cambiar el estado sin evento, para los roles de la app.
- [ ] CA-6 (D-13): Asistente, Contador, Administrador y Dueño marcan y deshacen; Lectura recibe 403 y no ve los botones; sobre un cliente no visible o de otro estudio, 404 igual que inexistente.
- [ ] CA-7 (D-6, D-7): dos personas que marcan el mismo mensaje a la vez dejan un solo evento y la segunda recibe 409 `atencion_cambiada`; un lote de 100 con un id ajeno da 404 y no cambia nada; uno de 101 da 400; un lote con mensajes ya atendidos los informa como omitidos; un lote con un crítico y sin comentario da 400 y no cambia nada.
- [ ] CA-8 (RF-125, D-9, D-12): el listado de clientes muestra por cliente los nuevos y, en rojo, los críticos nuevos; atender o deshacer cambia el número al recargar; los históricos de la primera sincronización no cuentan; el filtro «con mensajes nuevos» funciona y el enlace abre la bandeja fijada; sin `buzon.ver` el indicador no viaja.
- [ ] CA-9 (rendimiento, RNF-034): con 2.000 clientes y 100 000 mensajes en un estudio (70 % pendientes), p95 < 300 ms en la primera y en la página 20 de la bandeja (usuario global, asignado a 15 y asignado a 500; sin filtros, «Pendientes» y «Críticos pendientes») y en el listado de clientes con indicador, medidos en CI; ningún plan de ejecución hace un barrido secuencial de `buzon_mensaje`.
- [ ] CA-10 (aislamiento): con RLS forzada, una consulta sin `withTenant()` no ve filas del historial; ids cruzados (mensaje de A en la ruta del cliente B) dan 404; el historial no se puede insertar para un mensaje de otro estudio ni de otro cliente; prueba de catálogo de 002 con la tabla nueva; caso HU-40 de cada ruta nueva; las funciones `SECURITY DEFINER` nuevas en `escalada.adv.spec.ts`.
- [ ] CA-11 (D-10, RNF-071): bandeja, filtros, detalle y atención usables a 390 px sin desborde horizontal, con objetivos de 44 px, foco visible y contraste AA; entrada «Buzones» en el menú lateral y en la barra inferior; `diseno.estatico.spec.ts` en verde; el contenido y el comentario nunca se pintan con `dangerouslySetInnerHTML`.
- [ ] CA-12 (D-14): la notificación `buzon_critico` abre el mensaje en la bandeja; atender no crea ni marca notificaciones.
- [ ] CA-13 (D-12): un mensaje de más de 30 días que entra en la primera sincronización queda histórico aunque el worker envíe otra cosa; uno reciente, o de un cliente ya sincronizado, queda pendiente; la migración clasifica igual los mensajes de 023.
- [ ] CA-14: suites de `shared`, `db`, `backend` y `frontend` tocadas, `test:aislamiento`, typecheck, lint, `db:migrate` ×2, `pnpm cobertura:bandeja` (≥ 90 %) y `pnpm e2e` (un caso: campana → bandeja → filtro «Críticos pendientes» → atender con comentario → sale de «Pendientes» → indicador del cliente baja) en verde.
- [ ] Casos reales aplicables: ninguno. Fixtures del mock de 023.

## Dependencias
- Specs: 005 (alcance, asignaciones, `ClienteScopeGuard`), 007a (listado de clientes), 017 (auditoría, autor, campana), 023 (tablas `buzon_*`, rutas y componentes de buzón, U-1 a U-4), 038 (estilo A). La consumen 028 (resumen diario de nuevos) y 037 (borrado del cliente).
- Externas: ninguna.

## Riesgos
- **Consulta unificada con muchos clientes asignados**: con 500 de 2.000 clientes, filtrar por lista de clientes sobre el índice por fecha puede leer de más; CA-9 lo mide y el plan elige índice por estudio y fecha (global) o recorrido por cliente (asignado o responsable).
- **Indicador sobre 2.000 clientes**: si el agregado no cumple CA-9 con 70 % pendientes, contador por cliente en BD mantenido en la misma transacción que la captura y la atención (más escrituras y una fila caliente por cliente, que ya serializa el lock por RUC de 008).
- **Comentarios con datos personales** (Ley 29733): viven solo en el historial, sin copia en logs ni auditoría; los borra 037 con el cliente.
- **Barra inferior en celular** (038 P-5): pasa de cuatro a cinco entradas; se revisa en la prueba manual a 390 px.
- **Crítico histórico sin atender**: una coactiva de hace más de 30 días que llega en la primera sincronización no avisa (023) ni sale en «Pendientes» (D-12); solo se ve en «Históricos» o «Todos». Es la regla elegida en P-1.

## Decisiones del usuario (2026-11-20)
Preguntas P-1 a P-10 respondidas el 2026-11-20, todas con la opción (a). Se conservan sus IDs porque las D y el plan las citan.
- **P-1 = (a) · Qué es «nuevo».** No atendido por nadie del equipo; los mensajes de más de 30 días que llegan en la primera sincronización de un cliente son históricos (D-12).
- **P-2 = (a) · Deshacer.** Sí, cualquiera con el permiso de P-4 sobre el cliente, con comentario opcional; cada marca y deshacer queda en el historial solo inserción y en la auditoría (D-5, D-8).
- **P-3 = (a) · Comentario y lote.** Comentario opcional en no críticos y obligatorio en críticos; marcar en lote hasta 100 con un mismo comentario (D-6, D-7).
- **P-4 = (a) · Permiso.** `buzon.atender` nuevo en Asistente, Contador, Administrador y Dueño (D-13).
- **P-5 = (a) · Clientes de la bandeja.** Visibles y no archivados, con «incluir archivados» y «solo donde soy responsable» (D-2).
- **P-6 = (a) · Orden y vista.** Fecha del mensaje, más reciente primero; abre en «Pendientes» con el filtro rápido «Críticos pendientes» (D-4).
- **P-7 = (a) · Indicador.** Número de nuevos y, aparte y en rojo, el de críticos nuevos, con filtro y enlace (D-9).
- **P-8 = (a) · Campana.** Sigue igual; atender no toca notificaciones (D-14).
- **P-9 = (a) · Dónde vive.** `/buzon` con entrada en el menú y en la barra inferior; `/clientes/:id/buzon` es la misma bandeja fijada en ese cliente (D-10).
- **P-10 = (a) · Nivel.** B con una ronda adversarial sobre alcance, lote, cursor e indicador (D-11).

## Requiere usuario (aparecidas al planificar)
Resueltas por el usuario el 2026-11-20: U-1, U-2 y U-3 según la propuesta.
- **U-1 · Atender en un cliente archivado.** **Decidido (propuesta):** no se puede (409 `cliente_archivado`, como «Revisar» y «Abrir» de 023: archivado = solo lectura); el historial se sigue viendo. Alternativa: se puede, porque la atención es interna y no toca SUNAT.
- **U-2 · Deshacer un histórico atendido.** **Decidido (propuesta):** vuelve a «Históricos» (la marca de histórico es del mensaje y no cambia). Alternativa: vuelve a «Pendientes» y cuenta como nuevo.
- **U-3 · Deshacer en lote.** **Decidido (propuesta):** no (P-3 habla de atender en lote; deshacer es individual y queda como nota). Alternativa: lote también para deshacer, con las mismas reglas.
