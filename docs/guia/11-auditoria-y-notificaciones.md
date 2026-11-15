# 11 · Auditoría y notificaciones

> Anterior: [10 · Generar el archivo SIRE](10-generar-archivo.md) · Siguiente: [12 · Un mes de trabajo de punta a punta](12-un-mes-de-punta-a-punta.md) · Índice: [00-indice.md](00-indice.md)

Al terminar este módulo vas a poder consultar quién hizo qué y cuándo en tu estudio, entender qué avisos te llegan a la campana y a quién, y reconocer el nombre del autor en el historial de las compras, el estado del periodo, el XML subido y las versiones del archivo.

## Para qué sirve

En un estudio con varias personas, tarde o temprano alguien pregunta: «¿quién excluyó esta compra?», «¿quién reabrió octubre?», «¿quién cambió el rol de Ana?». ContApp responde con dos herramientas:

- **Auditoría.** Un registro de todo lo importante que pasa en el estudio: ingresos, invitaciones, cambios de rol, clientes, credenciales, descargas, correcciones, cambios de estado y archivos generados. Es de **solo agregado**: nadie, ni el Dueño, puede editarlo ni borrarlo. Si por algún motivo una acción no se puede registrar, la acción tampoco se hace.
- **Notificaciones.** Avisos dentro de ContApp que te llegan solo a ti, cuando algo requiere tu atención: la clave de un cliente dejó de funcionar, terminó un trabajo que lanzaste o el plan está por llenarse.

Piensa en la auditoría como el libro de actas del estudio, y en las notificaciones como los post-it que te deja la oficina en el escritorio. La auditoría la revisa quien supervisa (de vez en cuando o cuando hay una duda); las notificaciones las miras todos los días.

## Quién puede usarlo

| Rol | Ver la auditoría (`/configuracion/auditoria`) | Ver sus notificaciones | Recibe «credencial inválida» | Recibe «límite del plan» |
|---|---|---|---|---|
| Dueño | Sí | Sí | Si es responsable del cliente, o si el cliente no tiene responsable | Sí |
| Administrador | Sí | Sí | Si es responsable del cliente, o si el cliente no tiene responsable | No |
| Contador | No | Sí | Si es responsable del cliente | No |
| Asistente | No | Sí | Si es responsable del cliente | No |
| Lectura | No | Sí | No (no puede ser responsable) | No |

- La auditoría pide el permiso `auditoria.ver`, que solo tienen el Dueño y el Administrador. Para los demás, el enlace «Auditoría» no aparece en el menú, y si abren la dirección a mano ven «No tienes permiso para ver la auditoría.».
- Las notificaciones no piden permiso: cada persona ve **solo las suyas**. Además, una notificación de un cliente solo se ve mientras sigas teniendo acceso a ese cliente.

## Antes de empezar

- Haz el [módulo 03 · Tu equipo](03-equipo-roles-asignaciones.md): conviene tener al menos dos usuarios para ver distintos autores.
- Para ver registros con contenido, haz antes algo de trabajo: crear un cliente ([módulo 05](05-clientes.md)), guardar credenciales ([módulo 06](06-credenciales-y-trabajos.md)), corregir compras ([módulo 08](08-compras.md)) y generar el archivo ([módulo 10](10-generar-archivo.md)).
- Usuarios de prueba del estudio sembrado: `ua@seed.contapp.test` (Dueño del «Estudio A (seed)») y `uab@seed.contapp.test` (Contador en los estudios A y B). La contraseña de desarrollo es `desarrollo-contapp-2026`: está en el repositorio y sirve **solo para pruebas locales** ([módulo 01](01-preparar-entorno.md)).

## Paso a paso

### Consultar la auditoría

1. Entra como Dueño o Administrador.
2. En el menú superior, pulsa «Auditoría». Se abre la página «Auditoría» (`/configuracion/auditoria`).
3. Verás la tabla «Registros de auditoría» con las columnas «Fecha», «Actor», «Acción», «Cliente» y «Detalle», **de la más reciente a la más antigua**.
4. La página muestra 50 registros. Para ver los anteriores, pulsa «Cargar más» al final.

**Resultado esperado:** puedes responder quién hizo algo, cuándo (hora de Lima) y sobre qué cliente.

> En esta versión la auditoría **no tiene filtros** (por usuario, cliente, acción o fechas): es una lista por fecha. Los filtros llegan en R2. Mientras tanto, usa la búsqueda del navegador (Ctrl+F) sobre lo que ya cargaste.

### Revisar tus notificaciones desde la campana

1. Mira la campana en la barra superior. Si tienes avisos sin leer, muestra el número (con más de 99, «99+»).
2. Haz clic en la campana. Se abre el panel «Notificaciones» con las 10 más recientes. Las no leídas salen en negrita y con «Sin leer».
3. Haz clic en una notificación: se marca como leída y te lleva a donde corresponde (la ficha del cliente, o «Trabajos» si es de un trabajo sin cliente).
4. Para limpiar la campana de una vez, pulsa «Marcar todas como leídas».
5. Para ver más de 10, pulsa «Ver todas».

**Resultado esperado:** el número de la campana baja a medida que lees.

La campana se actualiza sola: cuando te llega un aviso nuevo, el número cambia sin recargar la página.

### Ver todas tus notificaciones

1. Desde el panel de la campana pulsa «Ver todas», o entra a `/notificaciones`.
2. Verás la página «Notificaciones», de la más nueva a la más vieja, con «Marcar todas como leídas» arriba y «Cargar más» al final.

Las notificaciones **no se borran a mano**: solo se marcan como leídas. ContApp las elimina solas a los **90 días** de creadas, leídas o no.

### Ver quién hizo cada cambio en las demás pantallas

El nombre del autor aparece también fuera de la auditoría:

| Dónde | Qué ves |
|---|---|
| Estado del periodo (compras y ventas) | «Marcado el [fecha] por [nombre]» |
| «Historial» de una compra ([módulo 08](08-compras.md)) | «Versión 3 · [nombre] · [fecha]», y «SIRE» para la versión original |
| Lupa, estado del XML ([módulo 09](09-lupa-y-xml.md)) | «XML subido por [nombre] el [fecha y hora]» |
| «Versiones generadas» ([módulo 10](10-generar-archivo.md)) | «Versión 1 · Generado el [fecha y hora] por [nombre]» |

Si la persona ya no está activa en el estudio verás «[nombre] (inactivo)». Si el autor no es miembro del estudio verás «Usuario desconocido». Nunca se muestra un identificador interno.

## Qué ves en pantalla

### Columnas de la auditoría

| Columna | Qué muestra |
|---|---|
| «Fecha» | Fecha y hora de Lima del registro. |
| «Actor» | Quién lo hizo: el nombre de la persona; «[nombre] (proceso automático)» si lo hizo un trabajo que lanzó esa persona; «Proceso automático» si no se sabe quién lo lanzó; «Sistema» para acciones internas. |
| «Acción» | Qué se hizo, en español (tabla siguiente). |
| «Cliente» | La razón social del cliente, o «—» si la acción no es de un cliente (por ejemplo, un cambio de rol). |
| «Detalle» | Datos breves: a quién afectó, libro, periodo, estado antes → después, rol, tipo de credencial, operación, cantidad de filas, versión, motivo. Un cliente editado muestra cada campo con su valor antes → después. |

### Acciones que se registran

Este es el catálogo completo de R1. Lo que no está en esta lista no se audita.

| Grupo | Acción que ves | Cuándo |
|---|---|---|
| Sesión | «Inició sesión» | Al entrar y al cambiar de estudio. Los intentos fallidos no aparecen aquí. |
| Equipo | «Creó una invitación», «Revocó una invitación», «Modificó una invitación» | Invitaciones ([módulo 03](03-equipo-roles-asignaciones.md)). |
| Equipo | «Se unió al estudio», «Creó el estudio», «Dio de alta a un miembro» | Alta de un miembro (por invitación, por registro o de otro modo). |
| Equipo | «Cambió el rol de un miembro», «Desactivó a un miembro», «Reactivó a un miembro», «Eliminó a un miembro» | Cambios en los miembros. |
| Asignaciones | «Asignó un cliente», «Quitó la asignación de un cliente», «Cambió el tipo de asignación de un cliente» | Responsable y colaboradores. |
| Clientes | «Creó un cliente», «Editó un cliente», «Archivó un cliente», «Reactivó un cliente», «Eliminó un cliente» | [Módulo 05](05-clientes.md). La creación indica si fue manual o por importación. |
| Credenciales | «Guardó una credencial», «Verificó una credencial», «Marcó una credencial como inválida», «Descifró una credencial» | [Módulo 06](06-credenciales-y-trabajos.md). Solo se registra el tipo («Clave SOL» o «Credencial de la API del SIRE») y el estado, **nunca la clave**. «Descifró una credencial» aparece cada vez que se usa la credencial (por ejemplo, al descargar o verificar), con actor «Sistema». |
| Libros | «Cargó la propuesta del SIRE» | Descarga o importación de la propuesta de compras o ventas. |
| Libros | «Modificó compras» | Una fila por operación de la grilla (clasificar, editar, excluir, restaurar, agregar, descartar, aceptar sugerencia, deshacer, rehacer), con la cantidad de filas. Una acción masiva de 300 compras deja **un** registro con «Filas: 300». |
| Libros | «Agregó una venta», «Excluyó una venta», «Restauró una venta», «Justificó un salto de correlatividad» | [Módulo 07](07-ventas.md) y [módulo 10](10-generar-archivo.md). |
| Libros | «Subió un XML» | [Módulo 09](09-lupa-y-xml.md). |
| Libros | «Cambió el estado de un periodo» | Marcar revisado, generar o reabrir. El detalle dice el libro, el periodo y «Abierto → Generado», etc. |
| Libros | «Generó un archivo» | Cada versión generada, con su número. |
| Reservada | «Envió a SUNAT» | Reservada para R2: hoy no aparece. |

La auditoría **no guarda montos**: «Modificó compras» dice qué operación fue y cuántas filas tocó. El antes y después de cada compra lo ves en su «Historial» ([módulo 08](08-compras.md)).

### Qué te notifica ContApp

| Aviso | Texto que ves (ejemplo) | A quién le llega | Cuándo |
|---|---|---|---|
| Credencial inválida | «La clave SOL de PRUEBA CONTRIBUYENTE S.A.C. fue rechazada por SUNAT. Actualízala para seguir trabajando.» | Al **responsable** activo del cliente. Si el cliente no tiene responsable, a **todos los Dueños y Administradores** activos. | Cuando una credencial pasa a inválida. Una sola vez mientras siga inválida; si la reemplazas y vuelve a fallar, avisa de nuevo. |
| Trabajo terminado | «La descarga de la propuesta del SIRE de PRUEBA CONTRIBUYENTE S.A.C. terminó.» o «La verificación de la clave SOL de … terminó con error: la credencial es inválida.» | Solo a **quien lanzó el trabajo** desde la pantalla. | Al terminar con éxito o con error, una vez por trabajo aunque haya reintentos. |
| Límite del plan | «Estás por llegar al límite de tu plan: usas 9 de 10 RUC.» o «Llegaste al límite de tu plan: usas 5 de 5 usuarios.» | A los **Dueños** activos. | Al llegar al **90 %** y al **100 %** de RUC o de usuarios. Como máximo una vez por día por recurso y umbral; vuelve a avisar solo si el uso baja y cruza el umbral otra vez. |

Sobre los trabajos:

- Avisan los que **una persona lanzó desde la pantalla**: descargar la propuesta de compras o de ventas, verificar una credencial, generar el archivo y «Obtener XML» en la lupa (este último sale con un texto genérico, «Un trabajo en segundo plano … terminó.»).
- **No** avisan los trabajos programados, los automáticos (por ejemplo, los XML que se piden solos después de la descarga, o las consultas RUC de una importación masiva), los internos del sistema ni los cancelados.

Sobre el plan: si el límite se cruza al aceptar una invitación, el aviso se guarda pero no salta en vivo; lo verás en la campana al recargar. Si el super-admin cambia los límites del plan, el aviso sale en el siguiente cambio de uso del estudio ([módulo 04](04-planes-y-limites.md)).

En R1 **no hay correo**: todos los avisos son dentro de ContApp. Los correos y el resumen diario llegan en R2.

## Reglas y límites

| Mensaje que ves | Por qué | Qué hacer |
|---|---|---|
| «No tienes permiso para ver la auditoría.» | Tu rol no tiene `auditoria.ver` (solo Dueño y Administrador). | Pide a un Dueño o Administrador que la consulte. |
| «Todavía no hay registros de auditoría.» | El estudio es nuevo. | Haz alguna acción (iniciar sesión ya cuenta) y recarga. |
| «No se pudo cargar la auditoría. Inténtalo de nuevo.» | Falló la conexión con el servidor. | «Reintentar». |
| «No tienes notificaciones.» | No hay avisos para ti (o ya se purgaron). | Nada. |
| «No se pudieron cargar las notificaciones. Inténtalo de nuevo.» / «No se pudo marcar como leída. Inténtalo de nuevo.» | Falló la conexión. | «Reintentar». |
| Una notificación de un cliente desapareció. | Te quitaron la asignación de ese cliente: ya no la ves ni cuenta en la campana. | Pide que te asignen de nuevo si la necesitas. |
| Notificaciones viejas que ya no están. | Se purgan a los 90 días de creadas. | Nada: la auditoría sí se conserva. |

Además:

- La auditoría **no se purga** en R1 (se conservará 5 años).
- Nadie puede editar ni borrar la auditoría: ni desde la app ni con acceso directo a la base de datos.
- El actor sale de la sesión de quien hizo la acción; no se puede falsificar.
- Ni la auditoría ni las notificaciones guardan claves, tokens, contenido de XML ni montos.

## Pruébalo con los datos de prueba

1. **Auditoría como Dueño.** Entra con `ua@seed.contapp.test`. En el menú pulsa «Auditoría». El registro más reciente debe ser «Inició sesión» con tu nombre como actor y «—» en «Cliente».
2. **Auditoría como Contador.** Cierra sesión y entra con `uab@seed.contapp.test`. El enlace «Auditoría» no está en el menú. Escribe `/configuracion/auditoria` en la barra del navegador: debe salir «No tienes permiso para ver la auditoría.».
3. **Rastro de un mes de trabajo.** Como Dueño, recorre el cliente `20700000002` en `202610`: descarga las compras, acepta la sugerencia de F001-2056, genera el archivo ([módulo 10](10-generar-archivo.md)). Vuelve a «Auditoría» y busca, de abajo hacia arriba:
   - «Descifró una credencial» con actor «Sistema» (la descarga usó la credencial del cliente).
   - «Cargó la propuesta del SIRE» con «Libro: Compras · Periodo: 202610».
   - «Modificó compras» con «Operación: Aceptar una sugerencia · Filas: 1».
   - «Cambió el estado de un periodo» con «Estado: Abierto → Generado».
   - «Generó un archivo» con «Versión: 1».
4. **Notificación de trabajo terminado.** Al terminar la descarga de compras del paso anterior, la campana debe sumar 1: «La descarga de la propuesta del SIRE de PRUEBA CONTRIBUYENTE S.A.C. terminó.». Haz clic: te lleva a la ficha del cliente y la campana baja.
5. **Notificación de credencial inválida.** En las credenciales del cliente ([módulo 06](06-credenciales-y-trabajos.md)), guarda una clave SOL inventada exactamente igual a `clave-errada` y pulsa verificar. La simulación la rechaza. Debes recibir:
   - «La verificación de la clave SOL de PRUEBA CONTRIBUYENTE S.A.C. terminó con error: la credencial es inválida.» (porque lanzaste el trabajo).
   - «La clave SOL de PRUEBA CONTRIBUYENTE S.A.C. fue rechazada por SUNAT. Actualízala para seguir trabajando.» (si eres el responsable del cliente, o si el cliente no tiene responsable y eres Dueño o Administrador).
   En la auditoría verás «Guardó una credencial» y «Marcó una credencial como inválida» (con su motivo en «Detalle»). Vuelve a guardar una clave de prueba válida (por ejemplo `CLAVEPRUEBA1`) para seguir trabajando.
6. **Autor con nombre.** Abre el «Historial» de F001-2056: la versión de la sugerencia aceptada lleva tu nombre. En «Generar archivo», la versión 1 dice «… por [tu nombre]».
7. **Marcar todas.** Abre la campana y pulsa «Marcar todas como leídas». El número desaparece.

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| Tras una descarga correcta, la auditoría muestra «Descifró una credencial» con «Motivo: SUNAT rechazó el token del SIRE» | Es un rótulo equivocado de la pantalla: el motivo guardado (`sire.token`) significa que el worker descifró la credencial **para pedir** el token del SIRE, no que SUNAT lo rechazara. Lo vimos en la prueba en vivo. | Ninguna: la descarga salió bien. Si una credencial falla de verdad, verás «Marcó una credencial como inválida» y la credencial en «Inválida». |
| No veo «Auditoría» en el menú. | Tu rol no es Dueño ni Administrador. | Es lo esperado. |
| No encuentro una acción en la auditoría. | No está en el catálogo (por ejemplo, un intento de login fallido o abrir la lupa), o está más abajo. | Revisa la tabla de acciones y usa «Cargar más». |
| Lancé un trabajo y no me llegó aviso. | Fue cancelado, era automático, o lo lanzó otra persona. | Míralo en «Trabajos» ([módulo 06](06-credenciales-y-trabajos.md)). |
| La credencial de un cliente quedó inválida y no me avisaron. | El cliente tiene un responsable y no eres tú. | El aviso le llegó al responsable. Revisa las asignaciones ([módulo 03](03-equipo-roles-asignaciones.md)). |
| La campana no se actualiza sola. | Se perdió la conexión en vivo. | Recarga la página: el conteo se pone al día. |
| Veo «Usuario desconocido» como autor. | El autor no es miembro de este estudio. | Nada que corregir: ContApp no muestra datos de personas ajenas al estudio. |

## Comprueba lo aprendido

1. Un Contador te pide revisar quién excluyó una compra. ¿Puede verlo él mismo en la auditoría? ¿Dónde más puede ver el autor?
2. Hiciste una aceptación masiva de R-RED sobre 200 compras. ¿Cuántos registros deja en la auditoría y qué dicen?
3. La clave SOL de un cliente sin responsable deja de funcionar. ¿Quién recibe el aviso?
4. Tu estudio usa 9 de 10 RUC. ¿Quién recibe el aviso y cuántas veces si mañana archivas uno y al día siguiente creas otro?
5. ¿Qué pasa con una notificación de hace cuatro meses? ¿Y con un registro de auditoría de la misma fecha?

<details>
<summary>Soluciones</summary>

1. No: la auditoría solo la ven el Dueño y el Administrador. Pero el Contador sí ve el autor en el «Historial» de la compra («Versión N · nombre · fecha»).
2. Un solo registro «Modificó compras» con «Operación: Aceptar una sugerencia» y «Filas: 200». El antes y después de cada compra está en su Historial.
3. Todos los Dueños y Administradores activos del estudio.
4. Los Dueños activos. Reciben el aviso del 90 % al llegar a 9 de 10. Al archivar uno el uso baja del umbral; al crear otro lo cruza de nuevo y se vuelve a avisar, siempre que haya pasado al menos un día desde el último aviso de ese umbral.
5. La notificación ya no existe: se purgan a los 90 días. El registro de auditoría sigue ahí: no se purga.

</details>

## Para saber más

- Curso técnico: [14 · Auditoría y notificaciones: quién hizo qué, y a quién avisar](../curso/14-auditoria-y-notificaciones.md)
- Spec: [`docs/specs/017-auditoria-notif/spec.md`](../specs/017-auditoria-notif/spec.md) · catálogo de acciones en `packages/shared/src/auditoria/acciones.ts` y la migración `packages/db/migrations/0045_auditoria_ronda_r1.sql`
- Requisitos: RF-026, RF-150, RF-152, RF-160 · RNF-001, RNF-004, RNF-021 · HU-10 y parte de HU-40.
