# 03 · Tu equipo: usuarios, roles y asignaciones

> Anterior: [02 · Entrar a ContApp](02-entrar-a-contapp.md) · Siguiente: [04 · Planes y límites](04-planes-y-limites.md) · Índice: [00-indice.md](00-indice.md)

Al terminar este módulo sabrás invitar a las personas de tu estudio, darles el rol adecuado, cambiarlo o desactivarlas, y repartir los clientes entre ellas con un responsable y colaboradores, de uno en uno o varios a la vez.

## Para qué sirve

En un estudio contable no todos hacen lo mismo: el dueño decide, el contador revisa y aprueba, el asistente digita y clasifica, y alguien más solo consulta. ContApp lo refleja con **roles**: cada rol trae un conjunto fijo de permisos.

Además, cada cliente tiene **un responsable** (quien responde por ese RUC) y puede tener **colaboradores** (quienes ayudan). Es la cartera de cada persona: un asistente con 15 de los 120 clientes del estudio solo ve esos 15.

Lo usas al empezar (armar el equipo), cuando entra o sale alguien, y cuando reorganizas la cartera de clientes.

## Quién puede usarlo

### Los cinco roles

| Rol | Para quién | Qué clientes ve |
|---|---|---|
| **Dueño** | El titular del estudio | Todos (alcance **global**) |
| **Administrador** | Quien gestiona el día a día del estudio | Todos (alcance **global**) |
| **Contador** | Quien revisa, aprueba y genera | Solo los que tiene asignados |
| **Asistente** | Quien descarga y clasifica | Solo los que tiene asignados |
| **Lectura** | Quien solo consulta | Solo los que tiene asignados |

«Asignado» significa ser responsable o colaborador del cliente. El alcance va fijo con el rol: no se puede dar alcance global a un Contador.

### Permisos de cada rol

Esta es la matriz exacta del sistema. «Sí» indica que el rol tiene el permiso.

| Permiso | Qué permite hoy | Dueño | Administrador | Contador | Asistente | Lectura |
|---|---|---|---|---|---|---|
| `clientes.ver` | Ver clientes (dentro de su alcance), sus compras, ventas y archivos, y la pantalla «Trabajos» | Sí | Sí | Sí | Sí | Sí |
| `clientes.crear` | «Nuevo cliente» e «Importar clientes» | Sí | Sí | — | — | — |
| `clientes.editar` | Editar los datos fiscales de un cliente | Sí | Sí | — | — | — |
| `clientes.archivar` | Archivar y reactivar clientes | Sí | Sí | — | — | — |
| `clientes.asignar` | Asignar responsable y colaboradores | Sí | Sí | — | — | — |
| `credenciales.editar` | Guardar y verificar las credenciales SOL y SIRE de un cliente | Sí | Sí | Sí | — | — |
| `sire.descargar` | Descargar o importar las propuestas SIRE | Sí | Sí | Sí | Sí | — |
| `sire.clasificar` | Corregir, clasificar y excluir filas; necesario para ser responsable de un cliente | Sí | Sí | Sí | Sí | — |
| `sire.aprobar_generar` | Generar el archivo SIRE, reabrir un periodo y cambiar un periodo ya revisado | Sí | Sí | Sí | — | — |
| `usuarios.ver` | Ver la pantalla «Usuarios» | Sí | Sí | — | — | — |
| `usuarios.gestionar` | Invitar, cambiar el rol, desactivar y reactivar | Sí | Sí | — | — | — |
| `auditoria.ver` | Ver «Auditoría» | Sí | Sí | — | — | — |
| `plan.gestionar` | Reservado al Dueño; en esta versión no tiene pantalla (el plan lo cambia ContApp, ver [módulo 04](04-planes-y-limites.md)) | Sí | — | — | — | — |
| `estudio.configurar`, `roles.gestionar` | Reservados para versiones futuras; sin pantalla hoy | Sí | Sí | — | — | — |
| `reglas.gestionar` | «Recordar» la clasificación de un proveedor y editar, activar, desactivar o eliminar las reglas aprendidas de un cliente. Con alcance global (Dueño y Administrador), también encender o apagar las «Reglas del motor» ([módulo 13](13-reglas-aprendidas.md)) | Sí | Sí | Sí | — | — |
| `ajustes.crear`, `ajustes.generar` | Reservados para versiones futuras; sin pantalla hoy | Sí | Sí | Sí | — | — |
| `reglas.ver` | Ver las «Reglas aprendidas» de un cliente y la pantalla «Reglas del motor» ([módulo 13](13-reglas-aprendidas.md)) | Sí | Sí | Sí | Sí | Sí |
| `buzon.ver`, `prorrata.ver` | Reservados para versiones futuras (buzón SOL, prorrata); sin pantalla hoy | Sí | Sí | Sí | Sí | Sí |
| `buzon.marcar_leido` | Reservado para el buzón SOL; sin pantalla hoy | Sí | Sí | Sí | Sí | — |

En resumen: el Administrador tiene todo menos `plan.gestionar`, y en la práctica la única diferencia de poder con el Dueño es que **no puede tocar a un Dueño** (ver «Reglas y límites»).

### Qué ve cada rol en el menú

| Rol | Enlaces del menú |
|---|---|
| Dueño y Administrador | «Clientes», «Trabajos», «Notificaciones», «Usuarios», «Auditoría», «Reglas del motor» |
| Contador, Asistente y Lectura | «Clientes», «Trabajos», «Notificaciones», «Reglas del motor» |

Todos ven además el selector «Estudio», «Cambiar contraseña» y «Cerrar sesión». En celular, «Usuarios», «Auditoría», «Reglas del motor» y el resto quedan dentro de «Más» ([módulo 02](02-entrar-a-contapp.md#qué-ves-en-pantalla)).

Si alguien no ve un botón, casi siempre es por su rol. Ocultar es solo una comodidad: aunque alguien escriba la dirección a mano, el sistema le niega la acción.

## Antes de empezar

- Haber leído el [módulo 02](02-entrar-a-contapp.md) (cómo se entra y cómo funciona la invitación por correo).
- Entrar con un Dueño o Administrador. En tu entorno de prueba, usa `ua@seed.contapp.test` (Dueño del Estudio A, plan Corporativo, sin límite de usuarios).
- Tener clientes para asignar. El Estudio A del seed ya trae tres.

> El plan Prueba admite **un solo usuario** (el Dueño). En un estudio recién registrado no podrás invitar a nadie hasta que ContApp le asigne otro plan. Para practicar este módulo usa el Estudio A del seed.

## Paso a paso

### Invitar a una persona

1. En el menú, haz clic en «Usuarios».
2. Baja hasta «Invitar a una persona».
3. Escribe su «Correo» y elige su «Rol». La lista solo muestra los roles que tú puedes otorgar.
4. Haz clic en «Invitar».

**Resultado esperado:** ves «Invitación enviada.» y la invitación aparece en la tabla «Invitaciones» con estado «Pendiente» y su fecha en «Vence» (72 horas). La persona recibe el correo «ContApp: te invitaron a un estudio» con un enlace que termina en `/invitacion#t=…`.

### Aceptar una invitación (lo hace la persona invitada)

1. Abre el enlace del correo. La página «Invitación a ContApp» dice «Verificando la invitación…» y luego «Te invitaron a … como …. Correo: …».
2. Si **no tienes cuenta**: escribe tu «Nombre» y una «Contraseña» (12 a 128 caracteres) y haz clic en «Crear cuenta y aceptar». Verás «Tu cuenta fue creada. Ya puedes iniciar sesión.».
3. Si **ya tienes cuenta** (por ejemplo, trabajas para otro estudio): verás «Ya tienes una cuenta: inicia sesión para aceptar.». Escribe tu contraseña y haz clic en «Iniciar sesión y aceptar». Verás «Te uniste a ….» y el botón «Cambiar a este estudio».

**Resultado esperado:** la persona pasa a la tabla «Miembros» con el rol de la invitación y estado «Activo». La invitación desaparece de «Invitaciones». ContApp nunca cambia la contraseña de una cuenta que ya existía.

### Reenviar o revocar una invitación

1. En «Usuarios» → «Invitaciones», busca la fila.
2. Haz clic en «Reenviar» para mandar un enlace nuevo (el anterior deja de servir y el plazo de 72 horas empieza de nuevo), o en «Revocar» para anularla.

**Resultado esperado:** con «Reenviar» llega un correo nuevo; con «Revocar» la invitación sale de la lista y su enlace muestra «La invitación no es válida o venció. Pide una nueva al estudio.».

### Cambiar el rol de un miembro

1. En «Usuarios» → «Miembros», busca a la persona.
2. En la columna «Acciones», abre la lista «Cambiar rol» y elige el rol nuevo.

**Resultado esperado:** la columna «Rol» cambia. El efecto es inmediato: en su siguiente clic, la persona ya trabaja con los permisos nuevos, sin volver a ingresar. Si el rol nuevo no tiene `sire.clasificar` (por ejemplo, Lectura), los clientes de los que era responsable quedan «Sin responsable» y la persona sigue en ellos como colaboradora.

### Desactivar y reactivar a un miembro

1. En «Miembros», haz clic en «Desactivar» en la fila de la persona. No hay ventana de confirmación: se aplica al instante.
2. Para devolverle el acceso, haz clic en «Reactivar» en la misma fila.

**Resultado esperado:** el «Estado» pasa a «Desactivado». La persona no se borra ni pierde su historial. Desde su siguiente clic ya no entra a este estudio (si no tiene otros, verá «No perteneces a ningún estudio activo…»); sus otros estudios no se tocan. Los clientes de los que era responsable quedan «Sin responsable» y sus colaboraciones se retiran. Al reactivarla recupera su rol, **pero no** sus clientes: hay que volver a asignarlos.

### Asignar responsable y colaboradores a un cliente

1. En «Clientes», haz clic en la razón social del cliente.
2. En la sección «Asignaciones» verás la tabla con «Nombre» y «Tipo» de quienes ya están asignados.
3. En «Usuario» elige a la persona y en «Tipo», «Colaborador» o «Responsable».
4. Si eliges «Responsable» y el cliente ya tiene otro, aparece «Responsable anterior»: elige «Pasa a colaborador» o «Se retira».
5. Haz clic en «Asignar».
6. Para quitar a alguien, haz clic en «Quitar» en su fila.

**Resultado esperado:** la tabla «Asignaciones» se actualiza y, en la lista de «Clientes», la columna «Responsable» muestra el nombre nuevo. Cada cliente tiene **como máximo un** responsable.

### Asignar varios clientes a la vez

1. En «Clientes», marca la casilla de cada cliente que quieres asignar (los archivados no se pueden marcar).
2. Debajo de la tabla, elige el «Usuario» y el «Tipo».
3. Si el tipo es «Responsable», elige qué pasa con el «Responsable anterior»: «Pasa a colaborador» o «Se retira».
4. Haz clic en «Asignar seleccionados».

**Resultado esperado:** ves «Clientes asignados: N». Se aplica **todo o nada**: si un cliente del lote no se puede asignar, no se asigna ninguno. Puedes asignar hasta 500 clientes en una sola vez.

## Qué ves en pantalla

### Pantalla «Usuarios»

Arriba aparece el uso del plan (por ejemplo, «Usuarios: 2 de ilimitado»; ver [módulo 04](04-planes-y-limites.md)).

| Tabla | Columnas | Valores |
|---|---|---|
| «Miembros» | «Nombre», «Correo», «Rol», «Estado», «Acciones» | Estado: «Activo» o «Desactivado». Acciones: lista «Cambiar rol» y «Desactivar», o «Reactivar». |
| «Invitaciones» | «Correo», «Rol», «Estado», «Vence», «Acciones» | Estado: «Pendiente» o «Vencida». Acciones: «Reenviar» y «Revocar». |

La columna «Acciones» solo aparece si puedes gestionar usuarios. En tu propia fila y en las filas que tu rol no puede tocar, la columna queda vacía.

### Asignaciones

| Dónde | Qué ves |
|---|---|
| Lista «Clientes», columna «Responsable» | El nombre del responsable, o «Sin responsable» |
| Ficha del cliente, sección «Asignaciones» | Tabla «Nombre» / «Tipo» («Responsable» o «Colaborador») con «Quitar»; formulario «Usuario», «Tipo», «Responsable anterior» y «Asignar» |
| Ficha de un cliente archivado | La tabla se ve, pero sin «Quitar» ni formulario: un cliente archivado es solo lectura |

La sección «Asignaciones» y las casillas de la lista solo aparecen a quien tiene `clientes.asignar` (Dueño y Administrador).

## Reglas y límites

- **Solo un Dueño toca a un Dueño.** Un Administrador no puede invitar a alguien como Dueño, ni cambiar el rol, desactivar o reactivar a un Dueño. Por eso en su lista de roles no aparece «Dueño» y en las filas de los Dueños no tiene acciones.
- **Nadie da más de lo que tiene.** Solo puedes otorgar roles cuyos permisos ya tienes.
- **Nadie se toca a sí mismo.** No puedes cambiar tu propio rol ni desactivarte: tu fila no tiene acciones.
- **Siempre queda un Dueño activo.** El estudio nunca puede quedarse sin Dueño. Como nadie puede degradarse ni desactivarse a sí mismo, en la pantalla siempre quedará al menos uno; la regla también protege el caso de dos Dueños que se degradan entre sí al mismo tiempo: uno de los dos cambios se rechaza.
- **Quién puede ser responsable.** Solo un miembro activo con `sire.clasificar`: Dueño, Administrador, Contador o Asistente. Un usuario de Lectura puede ser colaborador, no responsable.
- **Los cambios son inmediatos.** Un cambio de rol, una desactivación o una desasignación se notan en el siguiente clic de la persona afectada.
- **El usuario cuenta para el plan.** Los miembros activos y las invitaciones pendientes no vencidas cuentan para el límite de usuarios ([módulo 04](04-planes-y-limites.md)).

| Mensaje que ves | Por qué | Qué hacer |
|---|---|---|
| «Esa persona ya es miembro del estudio.» | Invitaste a alguien que ya está activo en tu estudio. | Si está desactivado, usa «Reactivar»; si no, no hace falta invitarlo. |
| «Ya hay una invitación pendiente para ese correo.» | Ya existe una invitación vigente. | Usa «Reenviar» en «Invitaciones». |
| «Alcanzaste el límite de usuarios de tu plan.» y «Contacta a ContApp para subir de plan.» | Miembros activos más invitaciones pendientes ya llegan al máximo del plan. | Revoca invitaciones que no se usarán, desactiva a quien ya no trabaja contigo o pide a ContApp otro plan. |
| «Debe quedar al menos un Dueño activo en el estudio.» | El cambio dejaría al estudio sin Dueño activo. | Primero da el rol de Dueño a otra persona. |
| «Ese usuario no puede ser asignado a este cliente.» | Elegiste como responsable a alguien sin `sire.clasificar` (por ejemplo, Lectura) o a un miembro desactivado. | Elige a otra persona, o asígnala como colaborador. |
| «Hay clientes archivados en la selección. Reactívalos o quítalos para asignar.» | El lote incluye un cliente archivado. | Quítalo de la selección o reactívalo. |
| «No tienes permiso para realizar esta acción.» | Tu rol no tiene el permiso. | Pide la acción a un Dueño o Administrador. |
| «La invitación no es válida o venció. Pide una nueva al estudio.» (al aceptar) | El enlace venció (72 h), se reenvió, se revocó o ya se usó. | Pide al estudio que la reenvíe. |

## Pruébalo con los datos de prueba

Entra con `ua@seed.contapp.test` (contraseña `desarrollo-contapp-2026`), Dueño del Estudio A.

1. **Invitar.** En «Usuarios», invita a `asistente@prueba.test` con el rol «Asistente». Debes ver «Invitación enviada.» y la fila «Pendiente».
2. **Invitación duplicada.** Invita otra vez a `asistente@prueba.test`: debes ver «Ya hay una invitación pendiente para ese correo.».
3. **Ya es miembro.** Invita a `uab@seed.contapp.test`: debes ver «Esa persona ya es miembro del estudio.».
4. **Aceptar con cuenta nueva.** Abre el correo «ContApp: te invitaron a un estudio» y entra al enlace en una **ventana privada** (para no cerrar la sesión de `ua`). Escribe el nombre «Ana Asistente» y una contraseña de 12 caracteres o más, y haz clic en «Crear cuenta y aceptar».
5. **Alcance asignado.** En la ventana privada, entra con `asistente@prueba.test`. En el menú verás «Clientes», «Trabajos», «Notificaciones» y «Reglas del motor», pero no «Usuarios» ni «Auditoría», y la lista de clientes estará vacía.
6. **Asignación masiva.** En la ventana de `ua`, ve a «Clientes», marca «Cliente A dos» y «Cliente A tres», elige «Ana Asistente», tipo «Colaborador», y haz clic en «Asignar seleccionados». Debes ver «Clientes asignados: 2». En la ventana privada, recarga «Clientes»: ahora Ana ve esos dos.
7. **Responsable.** En la ficha de «Cliente A dos», asigna a «Ana Asistente» como «Responsable». En la lista de clientes, su «Responsable» pasa a «Ana Asistente».
8. **Cambio de rol.** En «Usuarios», cambia el rol de Ana a «Lectura». En «Clientes», «Cliente A dos» vuelve a «Sin responsable» (Lectura no puede ser responsable). En su ficha, Ana figura ahora como «Colaborador» y sigue viendo sus dos clientes.
9. **Responsable inválido.** En la ficha de «Cliente A tres», intenta asignar a Ana (ahora Lectura) como «Responsable»: debes ver «Ese usuario no puede ser asignado a este cliente.».
10. **Desactivar.** En «Usuarios», haz clic en «Desactivar» en la fila de Ana. En la ventana privada, Ana ya no puede trabajar en el Estudio A: al recargar la página termina en «Elige tu estudio» con «No perteneces a ningún estudio activo…». Reactívala: vuelve a entrar, pero sin clientes asignados.
11. **Cuenta existente.** Invita a `ub@seed.contapp.test` (Dueño del Estudio B) como «Contador». Cierra la ventana privada y abre el enlace en una ventana privada nueva (si inicias sesión en la ventana de `ua`, su sesión se reemplaza). Verás «Ya tienes una cuenta: inicia sesión para aceptar.». Con la contraseña de desarrollo, haz clic en «Iniciar sesión y aceptar»: debe salir «Te uniste a Estudio A (seed).».

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| No veo «Usuarios» en el menú | Tu rol no es Dueño ni Administrador. | Pide la gestión a quien tenga esos roles. |
| No aparece «Dueño» en la lista de roles | Eres Administrador: solo un Dueño crea o toca Dueños. | Pide al Dueño que haga el cambio. |
| Mi fila no tiene acciones | Nadie puede cambiar su propio rol ni desactivarse. | Pide el cambio a otro Dueño o Administrador. |
| Un contador dice que no ve a un cliente | No está asignado a ese cliente (su alcance es solo lo asignado). | Asígnalo como responsable o colaborador. |
| Al reactivar a alguien no ve sus clientes de antes | Al desactivar se retiraron sus asignaciones y no vuelven solas. | Asígnale de nuevo sus clientes. |
| La invitación no llega | Lo buscas en el lugar equivocado ([módulo 01](01-preparar-entorno.md#ver-los-correos-que-envía-contapp)). | Revisa la terminal o Mailpit; si venció, usa «Reenviar». |
| No puedo invitar en mi estudio nuevo | El plan Prueba admite un solo usuario. | Pide a ContApp otro plan ([módulo 04](04-planes-y-limites.md)). |
| Varios clientes quedaron «Sin responsable» de golpe | Desactivaste a su responsable o le cambiaste a un rol sin `sire.clasificar`. | En «Clientes», filtra «Responsable» por «Sin responsable» y reasígnalos con la asignación masiva. |

## Comprueba lo aprendido

1. Contratas a una practicante que solo debe consultar los registros de tres clientes, sin cambiar nada. ¿Qué rol le das y qué haces después de que acepte la invitación?
2. Tu Administrador quiere ascender a un Contador a Dueño y no encuentra la opción. ¿Por qué?
3. Un asistente se va del estudio. ¿Qué haces y qué pasa con los clientes de los que era responsable?
4. Quieres que un contador sea responsable de 40 clientes nuevos. ¿Cómo lo haces en un solo paso?
5. ¿Puede un usuario con rol Lectura ser responsable de un cliente? ¿Y colaborador?

<details>
<summary>Soluciones</summary>

1. Rol «Lectura». Después, la asignas como colaboradora de esos tres clientes (en cada ficha o con la asignación masiva); sin asignación no verá ningún cliente.
2. Porque solo un Dueño puede crear o tocar a un Dueño. Debe hacerlo el Dueño.
3. Lo desactivas en «Usuarios» → «Desactivar». No se borra su historial. Sus clientes como responsable quedan «Sin responsable» y sus colaboraciones se retiran: hay que reasignarlos.
4. En «Clientes», marca los 40, elige al contador en «Usuario», tipo «Responsable», decide qué pasa con el «Responsable anterior» y haz clic en «Asignar seleccionados». Se aplica todo o nada.
5. Responsable, no: hace falta `sire.clasificar`. Colaborador, sí.

</details>

## Para saber más

- Curso técnico: [03 · Multitenancy, RLS y `withTenant()`](../curso/03-rls-y-withtenant.md) · [06 · Backend con NestJS y estado en vivo con SSE](../curso/06-backend-nestjs-sse.md)
- Spec: [`docs/specs/005-acceso/spec.md`](../specs/005-acceso/spec.md) (roles, permisos, invitaciones y asignaciones) · matriz de permisos en `packages/shared/src/acceso/roles.ts`
- Requisitos: RF-020, RF-021, RF-023, RF-024, RF-025, RF-026, RF-027, RF-028 · HU-03, HU-07, HU-08.
