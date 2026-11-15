# 10 · Generar el archivo SIRE

> Anterior: [09 · La lupa y el XML](09-lupa-y-xml.md) · Siguiente: [11 · Auditoría y notificaciones](11-auditoria-y-notificaciones.md) · Índice: [00-indice.md](00-indice.md)

Al terminar este módulo vas a poder revisar el periodo antes de generar (errores, avisos y resumen de cambios), generar el archivo TXT dentro de un ZIP para compras y para ventas, seguir el trabajo, descargar cualquier versión con su huella SHA-256 y volver a generar después de reabrir.

## Para qué sirve

Corregir las filas es la mitad del trabajo. La otra mitad es **entregar el registro corregido** en el formato que pide el SIRE. ContApp arma ese archivo de reemplazo por ti, pero solo cuando todo cuadra:

1. **El previo** revisa el periodo completo y te dice qué impide generar (errores), qué conviene mirar pero no impide (avisos) y qué cambió respecto de la propuesta (filas modificadas, excluidas y agregadas, y el efecto en el IGV).
2. **Generar** crea el TXT, lo comprime en un ZIP y lo guarda como una **versión** con número, fecha, autor y huella SHA-256. El periodo queda `generado` y ya nadie lo cambia sin reabrirlo.
3. **Las versiones** quedan guardadas para siempre: si reabres y generas otra vez, nace la versión 2 y la 1 se sigue pudiendo descargar.

Es el último paso del mes para cada libro: primero corriges compras y ventas, y al final generas el archivo de cada uno. Piensa en el previo como la revisión del supervisor antes de firmar, y en la versión como la copia sellada que queda en el archivo del estudio.

> **El formato del archivo todavía es provisional.** SUNAT no ha entregado aún el anexo oficial ni un archivo de muestra aceptado, así que el TXT sigue un formato interno de ContApp. Mientras sea así, la pantalla muestra «Provisional: no subir a SUNAT». **No subas ese ZIP a SUNAT.** El envío directo a SUNAT desde ContApp llegará en R2.

## Quién puede usarlo

| Rol | Abrir el panel, ver el previo y las versiones, descargar | Generar y reabrir | Excluir y restaurar ventas con error |
|---|---|---|---|
| Dueño | Sí, de todos los clientes | Sí | Sí |
| Administrador | Sí, de todos los clientes | Sí | Sí |
| Contador | Sí, de sus clientes asignados | Sí | Sí |
| Asistente | Sí, de sus clientes asignados | No | Sí, salvo con el periodo `revisado` |
| Lectura | Sí, de sus clientes asignados | No | No |

- Ver el previo, listar y descargar versiones pide `clientes.ver`.
- «Generar» y «Reabrir» piden `sire.aprobar_generar`. Sin ese permiso, en lugar del botón verás «No tienes permiso para generar el archivo.».
- Excluir y restaurar ventas pide `sire.clasificar` y respeta el estado del periodo (con `revisado`, solo quien tiene `sire.aprobar_generar`).

## Antes de empezar

- Haz el [módulo 07 · Ventas](07-ventas.md) y el [módulo 08 · Compras](08-compras.md): necesitas el cliente `20700000002` con las propuestas de compras y de ventas de `202610` descargadas.
- Conviene haber visto el [módulo 09 · La lupa y el XML](09-lupa-y-xml.md), porque con el XML las sugerencias de compras son exactas.
- El worker debe estar corriendo: la generación es un trabajo en segundo plano ([módulo 06](06-credenciales-y-trabajos.md)).

## Paso a paso

### Abrir el panel «Generar archivo» y leer el previo

1. Entra a las compras (o a las ventas) del cliente y del periodo.
2. Junto al estado del periodo, pulsa «Generar archivo».
3. Se abre el panel «Generar archivo» con el subtítulo del libro: «Archivo TXT del Registro de Compras Electrónico (RCE) para el SIRE» o «Archivo TXT del Registro de Ventas e Ingresos Electrónico (RVIE) para el SIRE». Mientras carga verás «Cargando el previo…».
4. Lee el panel de arriba abajo:
   - El formato: «Formato RCE-REEMPLAZO · versión 0-provisional» (en ventas, «RVIE-REEMPLAZO»), y el recuadro «Provisional: no subir a SUNAT».
   - El veredicto: «El archivo está listo para generarse.» o «El archivo no se puede generar todavía.» con el motivo.
   - «Errores»: cada error con el comprobante, el código, el campo y una explicación con cifras, y el enlace «Ubicar en la grilla».
   - «Avisos»: lo que conviene revisar pero no bloquea («Los avisos no impiden generar el archivo.»).
   - «Resumen de cambios del archivo»: «Modificadas», «Excluidas», «Agregadas» e «Impacto en el IGV» por DG, DGNG, DNG y «Total».
   - «Versiones generadas».

En compras, en una pantalla ancha el panel se abre como una columna al lado de la grilla; en una más angosta, debajo de ella. En ventas se abre a la derecha. Para cerrarlo, pulsa «Cerrar».

**Resultado esperado:** sabes exactamente qué falta corregir antes de generar.

### Corregir los errores desde el previo

1. En «Errores», pulsa «Ubicar en la grilla» del error.
2. La grilla lleva esa fila a la vista y la resalta. En pantallas angostas el panel se cierra para no taparla; ábrelo de nuevo con «Generar archivo».
3. Corrige la fila: acepta la sugerencia, edita o excluye ([módulo 08](08-compras.md)), o ábrela en la lupa ([módulo 09](09-lupa-y-xml.md)).
4. Con el panel abierto, el previo se vuelve a pedir solo cuando cambia la grilla.

**Resultado esperado:** el error desaparece de la lista. Cuando no queda ninguno, verás «Sin errores.» y «El archivo está listo para generarse.».

### Excluir una venta con error para poder generar

Las ventas llegan del SIRE tal como las emitió tu cliente. ContApp no las edita: si una venta tiene un error, la corrección de fondo se hace en el sistema de facturación. Pero para no frenar el periodo puedes **excluirla** del archivo. El panel te lo recuerda: «Las ventas llegaron así del SIRE: el error se corrige en el sistema de facturación. Para generar este periodo, puedes excluir la venta con un motivo; no irá en el archivo.»

1. En el panel de ventas, en el error de la venta, pulsa «Excluir».
2. Lee el aviso: «La venta no irá en el archivo: el RVIE no la declarará aunque SUNAT la tenga registrada. Puedes restaurarla después.»
3. Escribe el motivo (obligatorio, de 1 a 200 caracteres, en una línea) y pulsa «Confirmar».

**Resultado esperado:** «Venta excluida del archivo.» La venta sale en la grilla con la marca «Excluida» y en el panel aparece en «Ventas excluidas» con «Motivo: …». El resumen la cuenta en «Excluidas».

Para deshacerlo, en «Ventas excluidas» pulsa «Restaurar» y confirma («¿Restaurar la venta …? Volverá a validarse y a incluirse en el archivo.»). Su error vuelve y bloquea otra vez.

Solo se excluye una venta del SIRE que **hoy tiene un error**. Una venta sin error o agregada a mano no se excluye (las agregadas se quitan, [módulo 07](07-ventas.md)).

### Generar el archivo

1. Con «El archivo está listo para generarse.», pulsa «Generar». El botón pasa a «Generando…».
2. Sigue el trabajo en el mismo panel: «En cola · posición N» (o «En cola»), luego «Generando el archivo…». Si quieres verlo en la lista general, pulsa «Ver trabajos».
3. Al terminar verás «Archivo generado.» y el previo se recarga.

**Resultado esperado:**

- En «Versiones generadas» aparece «Versión 1 · Generado el [fecha y hora] por [tu nombre]», el nombre del ZIP, la cantidad de líneas, «SHA-256 del ZIP» con la huella completa, la marca «Provisional: no subir a SUNAT» y el botón «Descargar».
- El periodo queda `generado`. La grilla pasa a solo lectura con «El periodo ya está generado: reábrelo para modificarlo.».

Se puede generar desde un periodo `abierto` o `revisado`. Dos clics seguidos en «Generar» dan un solo trabajo y una sola versión.

### Descargar una versión

1. En «Versiones generadas», pulsa «Descargar» en la versión que quieras.
2. El navegador guarda el ZIP. Dentro va el TXT.

**Nombre del archivo:** la versión más reciente se descarga con el nombre del servidor, por ejemplo `CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip`. Las versiones anteriores se descargan con `_vN` al final (`CONTAPP-PROVISIONAL-20700000002-202610-RCE_v1.zip`) para que no se pisen en tu carpeta. El contenido no cambia.

Antes de entregarte el ZIP, ContApp recalcula su huella. Si no coincide con la guardada, no lo descarga y te dice «El archivo guardado no coincide con su huella: no se puede descargar.».

### Reabrir y generar de nuevo

1. En el estado del periodo, pulsa «Reabrir» y confirma («¿Reabrir el periodo generado? Volverá a quedar abierto para modificarlo.»).
2. El periodo vuelve a `abierto`. En el panel, «Versiones generadas» muestra el aviso «Reabierto después de la última versión».
3. Haz tus correcciones y vuelve a pulsar «Generar».

**Resultado esperado:**

- Si cambiaste algo, nace la **versión 2**. La versión 1 se sigue descargando con su huella original.
- Si **no** cambiaste nada, el TXT saldría idéntico: ContApp **no crea una versión nueva**. El trabajo termina, el periodo vuelve a `generado` y la lista sigue con las mismas versiones.

Reabrir nunca borra versiones.

## Qué ves en pantalla

### Veredicto y motivos

| Lo que ves | Qué significa |
|---|---|
| «El archivo está listo para generarse.» | Sin errores. «Generar» está habilitado (si tienes el permiso). |
| «El archivo no se puede generar todavía. Hay errores por corregir antes de generar.» | Hay al menos un error en «Errores». |
| «El archivo no se puede generar todavía. El periodo ya está generado: reábrelo para generar de nuevo.» | Ya hay una versión vigente. Reabre para generar otra. |
| «El archivo no se puede generar todavía. El cliente está archivado y es de solo lectura.» | Un cliente archivado no genera, pero sus versiones se siguen descargando. |
| «El archivo no se puede generar todavía. El formato del archivo aún no es el oficial de SUNAT.» | Solo en **producción**: con formato provisional, ContApp no genera. En tu entorno de prueba genera y marca el archivo como provisional. |

### Errores y avisos más comunes

| Código | Dónde | Qué significa | ¿Bloquea? |
|---|---|---|---|
| `IGV` | Compras y ventas | El IGV no es 18 % ni 10 % de la base. Ejemplo: «1.61 no es 18 % ni 10 % de 21.48». | Sí |
| «Los montos no cuadran con el total» (`CUADRE`) | Compras y ventas | La suma de las columnas no es igual al total. | Sí |
| «Falta el tipo de cambio de un comprobante en USD» (`USD_SIN_TC`) | Compras y ventas | Un comprobante en USD no tiene tipo de cambio. | Sí |
| `DUPLICADO`, `FECHA_INVALIDA`, `FECHA_POSTERIOR_AL_PERIODO`, `TC_INVALIDO` | Compras y ventas | Comprobante repetido, fecha mal escrita o posterior al periodo, tipo de cambio inválido. | Sí |
| `SIN_FILAS` | Compras y ventas | «No hay filas para generar: la lista está vacía o todas las filas están excluidas». | Sí |
| `R-ISC`, `R-NEW`, `R-GP` | Solo compras | Posible ISC en la base, proveedor nuevo, posible gasto personal. | No |
| «Salto en la correlatividad de los comprobantes» (`SALTO_CORRELATIVIDAD`) | Solo ventas | «Falta B001-291» o «Faltan B003-402 a B003-404». Se justifica en el [módulo 07](07-ventas.md). | No |
| `RAZON_SOCIAL_RECORTADA` | Compras y ventas | La razón social tenía más de 100 caracteres y se recortó a 100. | No |

Si hay muchos errores, al final verás «Y N errores más que no se muestran.». Corrige los visibles y el previo mostrará los siguientes.

### Resumen de cambios

| Dato | Qué cuenta |
|---|---|
| «Modificadas» | Filas de la propuesta que cambiaste (montos, destino). |
| «Excluidas» | Filas que no irán en el archivo. |
| «Agregadas» | Filas que agregaste a mano o desde XML. |
| «Impacto en el IGV» | Cuánto cambia el IGV respecto de la propuesta, por DG, DGNG y DNG (los que aplican) y «Total», en soles. |
| «N filas en USD no se incluyen en el impacto: falta su tipo de cambio.» | Filas en USD sin tipo de cambio: no se pueden convertir a soles. |

### Cada versión

| Dato | Ejemplo |
|---|---|
| Número, fecha y autor | «Versión 1 · Generado el [fecha y hora de Lima] por Usuario A» |
| Nombre del ZIP y líneas | `CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip` · «5 líneas» (una por fila no excluida) |
| «SHA-256 del ZIP» | Los 64 caracteres de la huella, completos. Sirve para comprobar que el archivo que tienes es exactamente el que generó ContApp. |
| Marca | «Provisional: no subir a SUNAT» |

## Reglas y límites

| Mensaje que ves | Por qué | Qué hacer |
|---|---|---|
| «Hay errores por corregir antes de generar el archivo.» | Alguien pidió generar con errores. Nunca se puede forzar. | Corrige o excluye las filas con error. |
| «El periodo cambió desde que viste el previo. Se recargó el previo: revísalo y vuelve a generar.» | Entre que abriste el previo y pulsaste «Generar», alguien cambió una fila (o excluyó o restauró una venta). ContApp no genera algo distinto de lo que viste. | Revisa el previo recargado y vuelve a pulsar «Generar». |
| «El estado del periodo cambió desde que viste el previo. Se recargó el previo: revísalo y vuelve a generar.» | Otra persona marcó revisado, generó o reabrió el periodo mientras tanto. | Revisa el estado y repite. |
| «No se pudo generar el archivo. Se recargó el previo: revisa su estado.» | El trabajo falló (por ejemplo, una fila cambió justo después de encolar). El periodo vuelve a su estado anterior y no queda versión. | Lee el previo recargado: muestra la causa vigente. |
| «La generación se canceló.» | Alguien canceló el trabajo en «Trabajos». | Vuelve a generar. |
| «El periodo ya está generado: reábrelo para generar de nuevo.» | Ya hay una versión vigente. | «Reabrir» (con `sire.aprobar_generar`). |
| «El cliente está archivado y es de solo lectura.» | Cliente archivado. | Reactívalo si necesitas generar ([módulo 05](05-clientes.md)). Descargar sí se puede. |
| «El archivo guardado no coincide con su huella: no se puede descargar.» | El ZIP guardado se alteró. ContApp no entrega un archivo distinto del que generó. | Avisa al administrador del sistema. Puedes reabrir y generar una versión nueva. |
| «No se pudo calcular el resumen del archivo: hay montos fuera de rango.» | Algún monto excede el rango permitido. | Revisa las filas con montos enormes. |
| «Escribe un motivo de 1 a 200 caracteres en una sola línea.» | Excluir una venta exige motivo. | Escríbelo. |
| «Esta venta no se puede excluir: solo las ventas del SIRE con un error que bloquea la generación.» | La venta no tiene error, o es agregada. | Las agregadas se quitan; las demás no necesitan excluirse. |

Además:

- Compras y ventas se generan **por separado**, cada uno desde su pantalla. Un archivo es de un cliente, un periodo y un libro.
- Las versiones son inmutables: nadie las edita ni las borra.
- La generación no usa las credenciales del cliente ni se conecta con SUNAT.

## Qué hacer con el ZIP hoy

- **No lo subas a SUNAT.** El formato es provisional y SUNAT lo rechazaría o, peor, lo procesaría con errores.
- Úsalo para **revisar**: abre el TXT y compáralo con tu registro, o guárdalo como respaldo de la revisión del mes junto con su SHA-256.
- Cuando llegue el formato oficial, ContApp generará el archivo definitivo y dejará de marcarlo como provisional. El **envío directo a SUNAT** y el seguimiento del ticket llegan en **R2**.

## Pruébalo con los datos de prueba

Usa el cliente `20700000002`, periodo `202610`, con un usuario que tenga `sire.aprobar_generar` (por ejemplo, el Dueño del estudio de prueba).

**Compras: previo con errores**

1. Antes de corregir la mixta, abre «Generar archivo» en compras.
2. Debes ver «El archivo no se puede generar todavía. Hay errores por corregir antes de generar.» y, en «Errores», F001-2056 con `IGV` y la explicación «1.61 no es 18 % ni 10 % de 21.48». «Generar» está deshabilitado.
3. En «Avisos» debe aparecer F001-1040 (San Juan) con `R-ISC`. Puede haber también avisos `R-NEW` o `R-GP`. Ninguno bloquea.

**Compras: corregir y generar la versión 1**

4. Pulsa «Ubicar en la grilla» en el error de F001-2056 y acepta su sugerencia R-MIX (8.97 gravado, 12.51 no gravado). Si quieres, acepta también la de San Juan (770.00 a ISC).
5. El previo debe decir «Sin errores.» y «El archivo está listo para generarse.». El resumen cuenta las filas que modificaste.
6. Pulsa «Generar». Verás «En cola…», «Generando el archivo…» y «Archivo generado.».
7. En «Versiones generadas»: «Versión 1», `CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip`, «5 líneas», la huella SHA-256 completa y «Provisional: no subir a SUNAT». El estado del periodo es «Generado».
8. Pulsa «Descargar» y abre el ZIP: dentro hay un TXT con 5 líneas.

**Compras: reabrir y generar de nuevo**

9. Pulsa «Reabrir» y confirma. El panel muestra «Reabierto después de la última versión».
10. Sin cambiar nada, pulsa «Generar». Termina con «Archivo generado.», pero **no** aparece una versión 2: el archivo habría sido idéntico.
11. Pulsa «Reabrir» otra vez. Excluye la compra F001-5070 (zapatilla) con un motivo, desde la grilla. El resumen debe contar 1 en «Excluidas».
12. Pulsa «Generar». Ahora sí aparece «Versión 2» con «4 líneas». Descarga la versión 1: el archivo se guarda como `CONTAPP-PROVISIONAL-20700000002-202610-RCE_v1.zip` y su huella sigue siendo la original.

**Compras: resumen cambiado**

13. Reabre el periodo. Abre la misma pantalla de compras en dos ventanas del navegador. En la ventana A abre el panel «Generar archivo». En la ventana B edita cualquier monto y guárdalo. Vuelve a A y pulsa «Generar»: debe salir «El periodo cambió desde que viste el previo. Se recargó el previo: revísalo y vuelve a generar.».

**Ventas: excluir para poder generar**

14. Ve a las ventas del mismo periodo y abre «Generar archivo».
15. En «Errores» debe estar F002-2 con «Falta el tipo de cambio de un comprobante en USD» y la nota de que las ventas se corrigen en el sistema de facturación. En «Avisos», «Falta B001-291» y «Faltan B003-402 a B003-404».
16. Pulsa «Excluir» en F002-2, escribe un motivo (por ejemplo «Sin tipo de cambio: se corrige en facturación») y «Confirmar».
17. El previo queda listo para generarse, con F002-2 en «Ventas excluidas» y 1 en «Excluidas». Pulsa «Generar»: nace la «Versión 1» del RVIE, con `CONTAPP-PROVISIONAL-20700000002-202610-RVIE.zip`.

**Sin permiso**

18. Entra con un usuario de rol Asistente asignado al cliente. Abre «Generar archivo»: ves el previo y las versiones, puedes descargar, y en lugar del botón dice «No tienes permiso para generar el archivo.».

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| No veo el botón «Generar», solo «No tienes permiso para generar el archivo.» | Tu rol no tiene `sire.aprobar_generar` (Asistente o Lectura). | Pide a un Contador, Administrador o Dueño que genere. |
| «Generar» está gris aunque no hay errores. | El periodo ya está `generado`, el cliente está archivado, o el previo se está recargando. | Lee el veredicto bajo el formato. Si es `generado`, reabre. |
| Se queda en «En cola». | El worker no está corriendo o hay otros trabajos antes. | Pulsa «Ver trabajos» y revisa el worker ([módulo 06](06-credenciales-y-trabajos.md)). |
| Generé otra vez y no salió una versión nueva. | No había cambios: el TXT habría sido idéntico. | Es lo esperado. La versión vigente es la última de la lista. |
| No puedo editar compras después de generar. | El periodo está `generado`. | «Reabrir». |
| En producción dice que el formato no es el oficial. | Con formato provisional, producción no genera. | Esperar el formato oficial de SUNAT. |
| No encuentro cómo corregir una venta con error. | Las ventas del SIRE no se editan en ContApp. | Corrígela en el sistema de facturación o exclúyela con motivo para generar. |

## Comprueba lo aprendido

1. El previo muestra un aviso `R-ISC` y ningún error. ¿Puedes generar?
2. Generaste la versión 1, reabriste y volviste a generar sin tocar nada. ¿Cuántas versiones ves y en qué estado queda el periodo?
3. Pulsas «Generar» y sale «El periodo cambió desde que viste el previo.». ¿Qué pasó y qué haces?
4. Una venta en USD sin tipo de cambio bloquea el RVIE. ¿Cuáles son tus dos caminos?
5. Un auditor te pide «el archivo que generaste en octubre, la primera versión». ¿Cómo se lo das y cómo puede comprobar que es el mismo?

<details>
<summary>Soluciones</summary>

1. Sí. Los avisos (`R-ISC`, `R-NEW`, `R-GP`, saltos de correlatividad, razón social recortada) no bloquean. Solo los errores bloquean.
2. Una sola versión: no se crea una nueva si el TXT sería idéntico. El periodo vuelve a `generado`.
3. Alguien cambió una fila (o excluyó o restauró una venta) después de que abriste el previo. ContApp no genera algo distinto de lo que viste: revisa el previo recargado y vuelve a pulsar «Generar».
4. Corregirla en el sistema de facturación y volver a descargar la propuesta de ventas, o excluirla del archivo con un motivo («Excluir» en su error) para generar ahora. Se puede restaurar después.
5. Abres «Generar archivo» del periodo, en «Versiones generadas» pulsas «Descargar» en la «Versión 1» (se guarda con `_v1` si ya hay otras) y le das también el «SHA-256 del ZIP» que muestra la lista. El auditor calcula el SHA-256 del ZIP y debe coincidir.

</details>

## Para saber más

- Curso técnico: [10 · Prevalidación y archivo SIRE: del periodo corregido al ZIP](../curso/10-prevalidacion-y-archivo-sire.md)
- Specs: [`docs/specs/012-prevalidacion-archivos/spec.md`](../specs/012-prevalidacion-archivos/spec.md) · [`docs/specs/012b-generar-archivo/spec.md`](../specs/012b-generar-archivo/spec.md) · [`docs/specs/020-deuda-r1/spec.md`](../specs/020-deuda-r1/spec.md) (T6 y T7: panel a 1440 px, horas de Lima, versiones con autor, SHA-256 y `_vN`)
- Requisitos: RF-071, RF-088, RF-100 a RF-103 · HU-25, HU-26.
