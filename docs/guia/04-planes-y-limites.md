# 04 · Planes y límites

> Anterior: [03 · Tu equipo: usuarios, roles y asignaciones](03-equipo-roles-asignaciones.md) · Siguiente: [05 · Clientes](05-clientes.md) · Índice: [00-indice.md](00-indice.md)

Al terminar este módulo sabrás cuántos RUC y cuántos usuarios permite el plan de tu estudio, dónde ver cuánto llevas usado, qué pasa al llegar al límite y qué avisos recibes antes. Si eres el super-admin de ContApp, también sabrás asignar planes a los estudios y crear o editar planes.

## Para qué sirve

Cada estudio trabaja con un **plan** que fija dos cupos:

- **RUC:** cuántos clientes activos puede tener el estudio.
- **Usuarios:** cuántas personas pueden trabajar en él.

Es como el contrato con un proveedor de software: si tu cartera crece, necesitas un plan mayor. ContApp te avisa cuando te acercas al límite y, al llegar, no te deja agregar más, pero **nunca borra ni bloquea** lo que ya tienes.

Lo miras al empezar (qué incluye tu prueba), cuando agregas clientes o personas, y cuando te llega un aviso de límite.

## Quién puede usarlo

| Quién | Qué puede hacer |
|---|---|
| Cualquier miembro del estudio | Ver el plan y su uso en el inicio («Plan …», «RUCs: …», «Usuarios: …»). |
| Dueño y Administrador | Ver también el uso en «Usuarios» y recibir el mensaje de límite al invitar o reactivar a alguien. |
| Dueño | Recibir en la campana «Notificaciones» los avisos del 90 % y del 100 % de RUC o de usuarios. |
| Super-admin de plataforma | Asignar plan y RUC adicionales a cada estudio, y crear, editar, desactivar y activar planes. |

**Nadie del estudio, ni siquiera el Dueño, puede cambiar su plan desde ContApp en esta versión.** El permiso `plan.gestionar` del Dueño todavía no tiene pantalla: el cambio de plan lo hace el super-admin de ContApp.

## Antes de empezar

- Haber registrado un estudio de prueba en el [módulo 02](02-entrar-a-contapp.md) (por ejemplo, «Estudio Prueba Guía» con `dueno@prueba.test`). Ese estudio está en el plan Prueba, el mejor para ver los límites.
- Para la consola del super-admin, usar `plataforma@seed.contapp.test` (contraseña de desarrollo `desarrollo-contapp-2026`) u otro super-admin creado con `pnpm db:plataforma-alta` ([módulo 01](01-preparar-entorno.md#crear-otro-super-admin-opcional)).
- Saber crear un cliente por RUC lo verás en el [módulo 05](05-clientes.md); aquí basta con «Clientes» → «Nuevo cliente», escribir el «RUC» y hacer clic en «Crear cliente».

## Paso a paso

### Ver el plan y el uso de tu estudio

1. Entra a ContApp. Si estás en otra pantalla, vuelve al inicio abriendo `http://localhost:3000/` (el menú no tiene un enlace «Inicio»).
2. Mira el recuadro de uso del plan, debajo del título «ContApp».

**Resultado esperado:** ves algo como esto (la fecha es 14 días después del registro del estudio):

```text
Plan Prueba · periodo de prueba, vence el 29 de noviembre de 2026
RUCs: 0 de 5
Usuarios: 1 de 1
```

Si llegaste a algún límite, debajo aparece un aviso con «Llegaste al límite de RUCs de tu plan.» o «Llegaste al límite de usuarios de tu plan.», y «Contacta a ContApp para subir de plan.». El mismo recuadro aparece en «Usuarios».

### Saber qué pasa al llegar al límite de RUC

1. Crea clientes hasta llegar al máximo de tu plan.
2. Intenta crear uno más.

**Resultado esperado:** el cliente no se crea y ves «Llegaste al límite de RUCs de tu plan.» junto al recuadro de uso. Lo mismo pasa al **reactivar** un cliente archivado. En la importación masiva, la vista previa muestra «Cupo de RUCs disponible: N» y «Excedentes que no caben: N», y cada fila que no entra dice «No cabe en el cupo de RUCs de tu plan.».

Para liberar cupo, **archiva** un cliente que ya no atiendes: los archivados no cuentan.

### Saber qué pasa al llegar al límite de usuarios

1. En «Usuarios», invita a alguien con el cupo de usuarios lleno.

**Resultado esperado:** la invitación no se envía y ves «Alcanzaste el límite de usuarios de tu plan.» y «Contacta a ContApp para subir de plan.». Lo mismo pasa al **reactivar** a un miembro desactivado. Para liberar cupo, revoca invitaciones pendientes que no se usarán o desactiva a quien ya no trabaja contigo.

### Leer los avisos del 90 % y del 100 %

1. Mira la campana «Notificaciones» del menú (en el menú lateral en escritorio, en la barra inferior en celular): muestra cuántas notificaciones no has leído.
2. Ábrela y lee el aviso.

**Resultado esperado:** si eres Dueño y el uso de RUC o de usuarios llega al 90 % o al 100 % del límite, ves uno de estos textos:

| Situación | Texto del aviso |
|---|---|
| Llegaste al 90 % sin llenar el cupo | «Estás por llegar al límite de tu plan: usas 9 de 10 RUC.» |
| El 90 % llegó ya con el cupo lleno (por ejemplo, en un plan de 5) | «Superaste el 90 % del límite de tu plan: usas 5 de 5 RUC.» |
| Llegaste al 100 % | «Llegaste al límite de tu plan: usas 5 de 5 RUC.» |

Con usuarios, el texto dice «usuarios» en lugar de «RUC». Cada aviso sale **una vez** al cruzar el umbral. Si después bajas (por ejemplo, archivas clientes) y vuelves a subir, el aviso sale de nuevo.

### Asignar un plan a un estudio (super-admin)

1. Entra con el super-admin. Verás «Elige tu estudio» con el enlace «Administración de plataforma»; haz clic en él (o abre `http://localhost:3000/admin`).
2. En la tabla «Estudios», busca la fila del estudio.
3. En «Nuevo plan», elige el plan. Solo aparecen los planes activos.
4. En «RUCs adicionales», escribe cuántos RUC extra le contratas (0 si ninguno).
5. Haz clic en «Asignar plan».

**Resultado esperado:** ves «Suscripción actualizada.» y la columna «Plan actual» muestra el plan nuevo. El cambio vale al instante para ese estudio.

> El campo «RUCs adicionales» empieza siempre en `0` y la tabla no muestra los adicionales que el estudio ya tenía. Escribe siempre el número correcto antes de «Asignar plan», o le quitarás los adicionales.

### Crear, editar, desactivar o activar un plan (super-admin)

1. En «Administración de plataforma», haz clic en «Planes» (o abre `/admin/planes`). Verás «Planes de suscripción».
2. Para **crear**: completa el formulario «Nuevo plan» y haz clic en «Crear plan».
3. Para **editar**: haz clic en «Editar» en la fila del plan; el formulario cambia a «Editar plan …». Haz los cambios y haz clic en «Guardar cambios» (o «Cancelar»).
4. Para **desactivar** o **activar**: haz clic en «Desactivar» o «Activar» en la fila.
5. Para volver a la lista de estudios, haz clic en «Estudios».

**Resultado esperado:** ves «Plan creado.» o «Plan guardado.». Una edición vale **al instante para todos los estudios** que tienen ese plan. Un plan desactivado ya no se ofrece para asignar, pero los estudios que lo tienen lo conservan.

## Qué ves en pantalla

### Los planes que trae ContApp

Son los planes de partida que crea la base de datos. El super-admin puede cambiarlos; los precios son de referencia y el estudio nunca los ve.

| Plan | RUC incluidos | Usuarios | Tope de RUC adicionales |
|---|---|---|---|
| Prueba | 5 | 1 | 0 |
| Independiente | 30 | 2 | 6 |
| Estudio | 100 | 5 | 20 |
| Estudio Pro | 300 | 15 | 60 |
| Corporativo | 600 | Ilimitado | 120 |

Los estudios del seed (Estudio A y Estudio B) están en **Corporativo**.

### Cómo se cuentan los cupos

| Cupo | Qué cuenta | Límite |
|---|---|---|
| RUC | Clientes **no archivados** del estudio | RUC incluidos del plan + los adicionales contratados, sin pasar del tope de adicionales del plan |
| Usuarios | Miembros **activos** (el Dueño cuenta) + invitaciones **pendientes** no vencidas | Usuarios del plan («Ilimitado» = sin límite) |

Ejemplo: un estudio en Independiente con 10 RUC adicionales contratados tiene 30 + 6 = 36 RUC, porque el tope de adicionales de ese plan es 6.

### El recuadro de uso del plan

| Línea | Qué significa |
|---|---|
| «Plan Prueba · periodo de prueba, vence el …» | El plan y, si está en prueba, la fecha de fin de la prueba |
| «RUCs: 3 de 600» | Clientes activos y límite efectivo |
| «Usuarios: 2 de 5 (1 pendiente)» | Miembros activos más invitaciones pendientes; entre paréntesis, cuántas están pendientes |
| «Usuarios: 2 de ilimitado» | El plan no limita usuarios |
| «Tu estudio se creó, pero no tiene plan: …» (en lugar del uso) | El estudio no tiene suscripción (ver «Reglas y límites») |

Debajo de la línea de RUC, y de la de usuarios si el plan tiene límite, una barra muestra cuánto del cupo usas. La barra es solo una ayuda visual: la cifra exacta es la del texto.

### Consola del super-admin

| Pantalla | Dirección | Contenido |
|---|---|---|
| «Administración de plataforma» | `/admin` | Enlace «Planes» y tabla «Estudios» con «Estudio», «Plan actual» («Sin plan» si no tiene), «Estado» (`prueba`, `activa` o «—»), «Nuevo plan», «RUCs adicionales» y el botón «Asignar plan» |
| «Planes de suscripción» | `/admin/planes` | Enlace «Estudios»; tabla «Planes» con «Código», «Nombre», «Precio mensual», «Máximo de RUCs», «Máximo de usuarios» («Ilimitado» si está vacío), «Estado» («Activo» o «Inactivo») y «Acciones» («Editar», «Desactivar» o «Activar»); formulario «Nuevo plan» |

Campos del formulario de plan: «Código», «Nombre», «Precio mensual», «Precio anual», «Máximo de RUCs», «Máximo de usuarios» (vacío = ilimitado), «Precio por RUC extra», «Máximo de RUCs extra», «Frecuencia del buzón (min)» y «Características (JSON)».

## Reglas y límites

- **La prueba dura 14 días, pero hoy no vence.** ContApp guarda y muestra la fecha de fin de la prueba, pero en esta versión no hace nada al llegar: el estudio sigue funcionando igual. El vencimiento y el modo de solo lectura llegarán en una versión futura.
- **El Dueño no cambia de plan por su cuenta.** Lo hace el super-admin de ContApp. Por eso los avisos dicen «Contacta a ContApp para subir de plan.».
- **Una prueba por cuenta.** Cada cuenta origina una sola prueba gratis. Si registra otro estudio, ese estudio queda **sin plan**: no puede agregar clientes ni personas hasta que el super-admin le asigne uno ([módulo 02](02-entrar-a-contapp.md)).
- **Bajar de plan no borra nada.** Si un estudio pasa a un plan menor que su uso actual (o el super-admin reduce un plan), conserva todo, pero no puede agregar hasta quedar dentro del límite.
- **Un estudio en prueba sigue en prueba.** Si el super-admin asigna otro plan a un estudio en prueba, el plan cambia, pero la columna «Estado» sigue en `prueba` con su fecha.
- **Los avisos van solo a los Dueños activos** y solo dentro de ContApp (no por correo). Si el aviso se origina al **aceptar** una invitación, no aparece en vivo: lo ves al recargar. Si el super-admin edita los límites de un plan, el aviso no sale en ese momento sino con el siguiente cambio de uso del estudio.
- **Los límites se aplican también con peticiones simultáneas.** Si dos personas invitan a la vez con un solo cupo libre, solo una invitación se crea.

| Mensaje que ves | Por qué | Qué hacer |
|---|---|---|
| «Llegaste al límite de RUCs de tu plan.» | Al crear o reactivar un cliente, el cupo de RUC está lleno. | Archiva clientes que ya no atiendes o pide a ContApp otro plan. |
| «No cabe en el cupo de RUCs de tu plan.» (en una fila de la importación) | El archivo trae más RUC nuevos que el cupo libre. | Importa menos filas o libera cupo. |
| «Alcanzaste el límite de usuarios de tu plan.» | Al invitar o reactivar, activos más pendientes ya llenan el plan. | Revoca invitaciones pendientes o desactiva a alguien. |
| «Contacta a ContApp para subir de plan.» | Acompaña a los avisos de límite. | Pide el cambio al super-admin. |
| «Tu estudio se creó, pero no tiene plan: la prueba gratis ya se usó con tu cuenta. Contacta a ContApp para activar uno.» | El estudio no tiene suscripción. | El super-admin le asigna un plan. |
| «Los RUCs adicionales superan el tope del plan.» (super-admin) | Pediste más adicionales que el tope del plan elegido. | Baja la cantidad o elige otro plan. |
| «Indica una cantidad entera de RUCs adicionales (0 o más).» (super-admin) | El campo está vacío, es negativo o tiene decimales. | Escribe un entero, por ejemplo `0`. |
| «El plan está desactivado y no se puede asignar.» (super-admin) | El plan se desactivó mientras tenías la pantalla abierta. | Recarga y elige un plan activo. |
| «Revisa los valores del plan.» (super-admin) | Algún valor es inválido: negativo, un límite en 0, o un tope de RUC extra mayor que el 20 % del «Máximo de RUCs». | Corrige los valores. |
| «Ya existe un plan con ese código.» (super-admin) | El «Código» está repetido. | Usa otro código. |
| «Las características deben ser un objeto JSON.» (super-admin) | «Características (JSON)» no es un objeto, por ejemplo `[]` o texto suelto. | Escribe `{}` si no necesitas nada. |
| «No tienes permiso para realizar esta acción.» (en `/admin`) | Entraste a la consola sin ser super-admin. | Usa una cuenta de super-admin. |

## Pruébalo con los datos de prueba

Usa el «Estudio Prueba Guía» del [módulo 02](02-entrar-a-contapp.md) (Dueño `dueno@prueba.test`, plan Prueba). Los RUC salen de `fixtures/rucs-prueba.json`.

1. **Uso inicial.** Entra con `dueno@prueba.test` y elige «Estudio Prueba Guía». El inicio muestra «Plan Prueba · periodo de prueba, vence el …», «RUCs: 0 de 5» y «Usuarios: 1 de 1», con el aviso «Llegaste al límite de usuarios de tu plan.».
2. **Límite de usuarios.** En «Usuarios», invita a `ayudante@prueba.test`: debes ver «Alcanzaste el límite de usuarios de tu plan.» y «Contacta a ContApp para subir de plan.».
3. **Cuatro clientes (80 %).** Crea clientes con los RUC `20700000002`, `20700000011`, `20700000045` y `20700000053`. El inicio muestra «RUCs: 4 de 5». La campana no muestra avisos de plan: 4 de 5 es el 80 %.
4. **Quinto cliente (100 %).** Crea el cliente `20700000061`. La campana muestra dos avisos nuevos: «Superaste el 90 % del límite de tu plan: usas 5 de 5 RUC.» y «Llegaste al límite de tu plan: usas 5 de 5 RUC.».
5. **Sexto cliente.** Intenta crear el cliente `20700000070`: debes ver «Llegaste al límite de RUCs de tu plan.» y el recuadro de uso.
6. **Liberar cupo.** Archiva uno de los clientes (desde su ficha). El inicio vuelve a «RUCs: 4 de 5» y ahora sí puedes crear `20700000070`. Al volver a 5 de 5, los avisos salen otra vez.
7. **Subir de plan (super-admin).** En otra ventana privada, entra con `plataforma@seed.contapp.test` → «Administración de plataforma». En la fila de «Estudio Prueba Guía», elige «Independiente», escribe `7` en «RUCs adicionales» y haz clic en «Asignar plan»: debes ver «Los RUCs adicionales superan el tope del plan.» (el tope de Independiente es 6). Cambia a `6` y repite: «Suscripción actualizada.». El «Estado» sigue en `prueba`.
8. **Comprobar el cambio.** Vuelve a la ventana del Dueño y recarga el inicio: «Plan Independiente · periodo de prueba, vence el …», «RUCs: 5 de 36» y «Usuarios: 1 de 2». Ahora la invitación a `ayudante@prueba.test` sí se envía.
9. **Estudio sin plan.** En la consola, la fila «Segundo Estudio Guía» (del módulo 02) muestra «Sin plan» en «Plan actual». Asígnale «Estudio» con `0` adicionales y verifica, entrando a ese estudio con `dueno@prueba.test`, que el inicio ya muestra «Plan Estudio».
10. **Plan inválido.** En «Planes», crea un plan con «Máximo de RUCs» `10` y «Máximo de RUCs extra» `3` (más del 20 %): debes ver «Revisa los valores del plan.».

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| No puedo invitar a nadie en mi estudio nuevo | El plan Prueba admite un solo usuario, y ese eres tú. | Pide a ContApp otro plan. |
| Archivé un cliente y el aviso de límite sigue | El recuadro se actualiza al recargar la pantalla. | Recarga el inicio. |
| La prueba «venció» y todo sigue funcionando | En esta versión la fecha de fin de la prueba es informativa. | Nada que hacer; el vencimiento llegará en una versión futura. |
| No me llegó el aviso del 90 % | Solo lo reciben los Dueños; con usuarios «Ilimitado» no hay avisos; y si el aviso salió al aceptar una invitación, aparece al recargar. | Revisa tu rol y recarga la pantalla. |
| No veo «Administración de plataforma» | La cuenta no es super-admin. | Entra con `plataforma@seed.contapp.test` o crea uno con `pnpm db:plataforma-alta`. |
| El super-admin no ve los clientes del estudio | La consola solo gestiona planes y suscripciones; no da acceso a los datos de los estudios. | Es así por diseño. |
| Al reasignar el plan, el estudio perdió sus RUC adicionales | El campo «RUCs adicionales» empieza en 0. | Asigna de nuevo con la cantidad correcta. |
| El inicio muestra «Tu estudio se creó, pero no tiene plan…» | El estudio no tiene suscripción (segunda prueba de la misma cuenta). | El super-admin le asigna un plan. |

## Comprueba lo aprendido

1. Tu estudio está en Estudio (100 RUC) y tiene 100 clientes activos y 8 archivados. ¿Puedes crear uno más? ¿Qué harías?
2. En el plan Independiente (2 usuarios) eres el único miembro y ya enviaste una invitación que nadie ha aceptado. ¿Puedes invitar a otra persona?
3. Un cliente te pregunta si al vencer la prueba perderá sus datos. ¿Qué le respondes según la versión actual?
4. Como super-admin, quieres dar 10 RUC adicionales a un estudio en Independiente. ¿Qué pasa?
5. Eres Administrador (no Dueño) y tu estudio llega al 100 % de RUC. ¿Te llega el aviso a la campana?

<details>
<summary>Soluciones</summary>

1. No: los 100 activos llenan el cupo (los 8 archivados no cuentan, pero los activos sí). Verás «Llegaste al límite de RUCs de tu plan.». Archiva un cliente que ya no atiendes o pide a ContApp un plan mayor o RUC adicionales.
2. No: cuentan los miembros activos y las invitaciones pendientes. Tú más la invitación pendiente suman 2 de 2. Revoca la pendiente si no se va a usar, o pide otro plan.
3. Hoy la prueba no vence: la fecha es informativa y el estudio sigue funcionando. Aun cuando llegue el vencimiento, ContApp nunca borra datos por un cambio de plan.
4. Se rechaza con «Los RUCs adicionales superan el tope del plan.»: el tope de Independiente es 6. Con 6, el estudio tiene 36 RUC.
5. No: los avisos de límite del plan van solo a los Dueños activos. Sí ves el recuadro de uso en el inicio y los mensajes al intentar agregar.

</details>

## Para saber más

- Curso técnico: [14 · Auditoría y notificaciones](../curso/14-auditoria-y-notificaciones.md)
- Specs: [`docs/specs/006-planes/spec.md`](../specs/006-planes/spec.md) (planes, registro y límites) · [`docs/specs/017-auditoria-notif/spec.md`](../specs/017-auditoria-notif/spec.md) (avisos del 90 % y 100 %, decisión P-5) · notas pendientes en [`docs/specs/ESTADO.md`](../specs/ESTADO.md) (cambio de plan por el Dueño en R3)
- Requisitos: RF-001, RF-002, RF-003, RF-004 · HU-01, HU-02 · HU-03 (límite de usuarios).
