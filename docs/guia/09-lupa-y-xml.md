# 09 · La lupa y el XML

> Anterior: [08 · Compras (RCE)](08-compras.md) · Siguiente: [10 · Generar el archivo SIRE](10-generar-archivo.md) · Índice: [00-indice.md](00-indice.md)

Al terminar este módulo vas a poder abrir la «lupa» de cualquier compra, leer la factura completa con su XML, comparar lo que dice el SIRE con lo que dice el comprobante, subir un XML a mano cuando no llegó solo y agregar una compra que falta directamente desde su XML.

## Para qué sirve

Cuando una regla te dice «1.61 no es 18 % ni 10 % de 21.48», la pregunta del contador siempre es la misma: **¿qué dice la factura?** Antes había que entrar a SOL, buscar el comprobante y abrir el XML. La lupa te lo trae a la misma pantalla de compras:

- La **cabecera** del comprobante (proveedor, tipo, serie y número, fecha, moneda).
- Los **ítems** tal como vienen en el XML, con su afectación (gravado, exonerado, inafecto).
- Una **comparación columna por columna** entre la fila del SIRE y el XML, con las diferencias resaltadas y la regla que las explica.
- Los **hallazgos y la sugerencia** de la fila, y las mismas acciones que tienes en la grilla.
- El **historial del proveedor** en los últimos 6 periodos, para ver cómo clasificaste sus compras antes.

Además, cuando el XML está guardado, las reglas usan sus **montos exactos**. En la compra mixta, por ejemplo, la sugerencia deja de ser un estimado («entre 8.92 y 8.97») y pasa a ser la cifra exacta del XML (8.97 gravado y 12.51 no gravado).

Piensa en la lupa como tener la factura física engrapada a la fila del Excel. La usas durante la revisión del mes, justo después de descargar la propuesta y antes de generar el archivo.

> La lupa existe **solo en compras** en esta versión. La lupa de ventas llegará en una versión posterior (R2).

## Quién puede usarlo

| Rol | Abrir la lupa y descargar el XML | Obtener, reintentar o subir un XML; agregar desde XML | Aceptar, editar, clasificar o excluir desde la lupa |
|---|---|---|---|
| Dueño | Sí, de todos los clientes | Sí | Sí, también con el periodo `revisado` |
| Administrador | Sí, de todos los clientes | Sí | Sí, también con el periodo `revisado` |
| Contador | Sí, de sus clientes asignados | Sí | Sí, también con el periodo `revisado` |
| Asistente | Sí, de sus clientes asignados | Sí | Sí, salvo con el periodo `revisado` |
| Lectura | Sí, de sus clientes asignados | No | No |

- Ver la lupa pide el permiso `clientes.ver`. Obtener, subir y agregar piden `sire.clasificar`.
- Las acciones sobre la fila siguen las reglas de la grilla ([módulo 08](08-compras.md)): con el periodo `revisado` solo modifica quien tiene `sire.aprobar_generar`, y con el periodo `generado` nadie modifica hasta reabrir.
- **Obtener o subir un XML** se permite en cualquier estado del periodo (abierto, revisado o generado), porque no cambia los montos de la fila. Solo lo impide un cliente archivado.

## Antes de empezar

- Haz primero el [módulo 08 · Compras (RCE)](08-compras.md): necesitas el cliente de prueba `20700000002` con la propuesta de compras de `202610` descargada.
- Ten a mano la carpeta `fixtures/xml/` del proyecto. Trae cinco XML de prueba, uno por cada compra del contribuyente de prueba:

| Archivo | Caso |
|---|---|
| `20700000011-01-F001-1040.xml` | San Juan: ISC 770.00 |
| `20700000045-01-F001-2056.xml` | Mixta: gravado 8.97, IGV 1.61, no gravado 12.51, total 23.09 |
| `20700000053-01-F001-3064.xml` | ICBPER: 3 bolsas, 1.50 |
| `20700000061-01-F001-4062.xml` | Factura en USD: base 0.15, IGV 0.03, total 0.18 |
| `20700000070-01-F001-5070.xml` | «Par de zapatillas deportivas de prueba» |

> Recuerda que ContApp **no se conecta con SUNAT** todavía. Los XML que llegan solos los entrega una simulación (`XML_PROVIDER=mock`) a partir de esos archivos de prueba, y la lupa los marca como «XML simulado».

## Paso a paso

### Abrir la lupa desde la grilla de compras

1. Entra a «Clientes», abre el cliente y ve a sus compras del periodo `202610`.
2. En la fila de la compra, al final, está la columna «Ver comprobante» con un botón de lupa. Haz clic en él.
3. Se abre una ventana con el título «Comprobante F001-2056» (la serie y el número de la fila).
4. Para pasar a otra compra sin cerrar, usa «Compra anterior» y «Compra siguiente», o las flechas ← y → del teclado. Verás «Compra 2 de 5»: la lupa recorre las compras **en el mismo orden en que las mostraba la grilla** al abrirla.
5. Para cerrar, pulsa «Cerrar comprobante», presiona Esc o haz clic fuera de la ventana.

**Resultado esperado:** al cerrar, la fila de la grilla se recarga y refleja cualquier cambio que hiciste desde la lupa.

### Leer el comprobante

La lupa se lee de arriba abajo, en este orden:

1. **Cabecera:** RUC, razón social (con la marca «Proveedor nuevo» si es la primera vez que aparece), tipo de comprobante (por ejemplo «Factura (01)»), serie y número, fecha de emisión, moneda, tipo de cambio y origen de la serie («Electrónica» o «Física»).
2. **XML del comprobante:** de dónde salió el XML o por qué no está (ver «Qué ves en pantalla»). Si está, tienes «Descargar XML» para guardarlo en tu computadora.
3. **Ítems del XML:** una tabla con descripción, cantidad, unidad, precio unitario, valor, afectación, IGV, ISC e ICBPER de cada línea.
4. **Comparación SIRE y XML:** columna por columna, la cifra del SIRE, la del XML y el resultado («Coincide», «Difiere» o «Sin XML»). Las filas que difieren salen resaltadas y llevan la regla que las explica.
5. **Hallazgos y sugerencia:** cada hallazgo con su regla (por ejemplo «R-MIX · Compra mixta») y su explicación.
6. **Historial del proveedor:** sus compras de este cliente en los últimos 6 periodos, con el destino que tuvieron y si se excluyeron.
7. **Acciones:** las mismas de la grilla («Clasificar», «Excluir», etc.), más «Editar», «Aceptar sugerencias» e «Historial».

### Aceptar la sugerencia con el teclado (Enter en dos pasos)

1. Con la lupa abierta en una compra que tiene sugerencia, presiona **Enter** (con el foco en la ventana, no sobre un botón ni un campo).
2. Se abre la aceptación de la sugerencia con el detalle de lo que va a cambiar.
3. Presiona **Enter otra vez** para confirmarla, o Esc para cancelar.

La ayuda de teclado de la lupa lo dice así: «← → cambian de compra · Enter abre la aceptación de la sugerencia y un segundo Enter la confirma · Esc cierra».

**Resultado esperado:** «Sugerencia aceptada.» y la comparación se actualiza. Si otra persona cambió la fila mientras tanto, verás el mismo mensaje que en la grilla y la fila se recarga.

### Editar los montos desde la lupa

La lupa no tiene celdas editables. «Editar» te lleva a la grilla:

1. Pulsa «Editar» en la sección de acciones.
2. La lupa se cierra y la grilla abre esa compra en edición, en su primera celda de monto.
3. Edita como en el [módulo 08](08-compras.md) (Enter guarda, Esc cancela).

«Editar» sale deshabilitado si la compra está excluida o si el periodo es de solo lectura para ti; al pasar el mouse ves el motivo.

### Pedir el XML o reintentar

Si la lupa dice «El XML de este comprobante aún no se solicitó.»:

1. Pulsa «Obtener XML».
2. Verás «Se solicitó el XML.» y luego «Pendiente: se está obteniendo el XML.».
3. No necesitas recargar: cuando el trabajo termina, la lupa se actualiza sola.

Si dice «XML no disponible», lee la causa y pulsa «Reintentar» para pedirlo otra vez. Si sabes que no va a llegar, súbelo tú (siguiente tarea).

### Subir un XML a mano

Usa esto cuando el XML no llegó, o cuando tienes el XML real y el que se ve es el simulado.

1. Abre la lupa de la compra.
2. En «XML del comprobante», pulsa «Subir XML» y elige el archivo, o arrástralo a la zona punteada («o arrastra el archivo XML aquí»).
3. Espera «Subiendo…».

**Resultado esperado:** «XML subido.» La lupa se completa sin recargar la página y la etiqueta cambia a «XML subido por [tu nombre] el [fecha y hora]». Las reglas se vuelven a evaluar con ese XML.

Antes de enviar, ContApp comprueba que el archivo no esté vacío y que no pase de 1 MiB. En el servidor revisa además que sea un XML válido y que corresponda **exactamente** a esa compra: mismo RUC del emisor, tipo, serie y número, y que el receptor sea tu cliente.

«Subir XML» solo aparece si no hay XML o si el que hay es simulado. Un XML que ya se subió (o uno real) no se reemplaza.

### Agregar una compra desde su XML

Cuando una factura no está en la propuesta del SIRE pero tienes su XML:

1. En la pantalla de compras pulsa «Agregar compra».
2. En el formulario, pulsa «Subir XML» (arriba a la derecha) y elige el archivo. Verás «Leyendo el XML…».
3. El formulario cambia a «Agregar desde XML» y muestra los «Datos leídos del XML» (tipo, comprobante, fecha, moneda, proveedor), los montos y los ítems. Esos datos no se editan: salen del XML.
4. En «Destino de la base imponible y el IGV» elige DG, DGNG o DNG.
5. Si el XML está en **USD**, aparece además «Tipo de cambio» con la ayuda «El XML está en USD: indica el tipo de cambio de la compra.». Escríbelo con hasta 3 decimales (por ejemplo `3.752`). En PEN no se pide.
6. Pulsa «Agregar compra».

**Resultado esperado:** «Compra agregada desde el XML.» La compra aparece en la grilla con la marca «Agregada» y su XML ya guardado (lo ves en su lupa como «XML subido por …»).

Si te equivocaste de archivo, «Quitar el XML» te devuelve al formulario manual.

## Qué ves en pantalla

### Estado del XML

| Lo que ves | Qué significa | Qué puedes hacer |
|---|---|---|
| «XML simulado» | El XML lo entregó la simulación (mock). Es de prueba, no de SUNAT. | «Descargar XML». También «Subir XML» para reemplazarlo por el tuyo. |
| «XML subido por [nombre] el [fecha y hora]» | Alguien del estudio lo subió a mano. Se ve su nombre (o «Usuario desconocido», o «(inactivo)» si ya no está activo) y la fecha en hora de Lima. | «Descargar XML». No se puede reemplazar. |
| «XML subido» | Igual que el anterior, sin datos del autor. | «Descargar XML». |
| «XML real» | Lo entregó la conexión real con SUNAT. **En esta versión no aparece**, porque no hay conexión real. | «Descargar XML». |
| «Pendiente: se está obteniendo el XML.» | Hay un trabajo pidiéndolo. La lupa se actualiza sola al terminar. | Esperar. |
| «El XML de este comprobante aún no se solicitó.» | Nadie lo pidió todavía (por ejemplo, una compra agregada a mano). | «Obtener XML» o «Subir XML». |
| «XML no disponible» · «SUNAT no entregó el XML de este comprobante.» | La fuente respondió que no lo tiene. | «Reintentar» o «Subir XML». |
| «XML no disponible» · «No se pudo obtener el XML con la credencial del cliente.» | La fuente rechazó el acceso. | Revisar credenciales ([módulo 06](06-credenciales-y-trabajos.md)); «Subir XML». |
| «XML no disponible» · «No se pudo obtener el XML ahora; se volverá a intentar.» | Falla pasajera (la fuente no respondió a tiempo). | Esperar, «Reintentar» o «Subir XML». |
| «XML no disponible» · «Este comprobante no tiene XML que obtener.» | El tipo de comprobante o el proveedor no tienen XML (por ejemplo, un proveedor sin RUC). | Nada: no hay «Reintentar». |
| Aviso «La moneda del XML (USD) no coincide con la de la fila (PEN). Se muestran sin convertir.» | La fila del SIRE y el XML están en monedas distintas: es una discrepancia real. | Revisar la fila. No habrá sugerencias basadas en el XML. |

### Comparación SIRE y XML

| Columna | Qué compara |
|---|---|
| «Base imponible (DG + DGNG + DNG)» | La suma de las tres bases de la fila contra el gravado del XML. El XML no dice el destino, así que la clasificación solo se compara en la suma. |
| «IGV» | La suma de los tres IGV contra el IGV del XML. |
| «No gravado», «ISC», «ICBPER», «Otros tributos», «Total» | Columna contra columna. |

Cada fila dice «Coincide», «Difiere» (resaltada, con la regla y su explicación si una regla la cubre) o «Sin XML». Sin XML verás «Sin XML: no hay con qué comparar el SIRE.». Los montos se comparan en la moneda del comprobante, sin convertir.

### Ítems del XML

La afectación sale con su nombre y su código del catálogo de SUNAT: «Gravado (10)», «Exonerado (20)», «Inafecto (30)», «Exportación (40)». Las descripciones se muestran como texto, tal como vienen en el XML.

## Cuándo llega el XML solo

No tienes que pedir los XML uno por uno:

1. Cuando termina la **descarga de la propuesta** de compras ([módulo 08](08-compras.md)), ContApp pone en cola un trabajo `xml.obtener` para las compras que todavía no tienen XML, **primero las que tienen hallazgos**.
2. Esos trabajos corren en segundo plano. No te mandan notificación ([módulo 11](11-auditoria-y-notificaciones.md)).
3. Un XML ya guardado no se vuelve a pedir, y repetir la descarga no duplica nada.
4. Desde la lupa, «Obtener XML» pide uno solo y con prioridad, porque lo estás esperando.

En tu entorno de prueba la simulación responde al instante, así que normalmente al abrir la lupa ya ves «XML simulado».

## La bandera XML_SIMULADO_EN_REGLAS

El XML simulado es de prueba. Por eso hay una opción de configuración que decide si **las reglas lo usan**:

| `XML_SIMULADO_EN_REGLAS` | Qué ves en la lupa | Qué pasa con las reglas |
|---|---|---|
| `1` (así viene en `.env.example`, para desarrollo y pruebas) | «XML simulado», ítems y comparación | Las reglas usan los montos del XML: en la mixta, R-MIX sugiere exacto 8.97 / 12.51 y se acepta sin pedir confirmación. En San Juan, R-ISC sugiere mover 770.00 a ISC respaldado por el XML. |
| `0` o ausente (valor por defecto del código, el de producción) | Lo mismo: el XML se ve y se compara | Las reglas **no** lo usan: los hallazgos siguen siendo los de «sin XML» (en la mixta, un estimado que pide confirmación). Un XML **subido** sí entra en las reglas siempre. |

Si en tu entorno no ves las sugerencias exactas del XML, revisa esta variable con quien instaló el sistema ([módulo 01](01-preparar-entorno.md)).

## Reglas y límites

| Mensaje que ves | Por qué | Qué hacer |
|---|---|---|
| «El archivo está vacío.» | El archivo no tiene contenido. Ni se envía. | Elige el archivo correcto. |
| «El archivo pesa más de 1 MiB: no se envió.» | El tope de un XML es 1 MiB. | Revisa que sea el XML del comprobante y no otro archivo. |
| «El archivo no es un XML válido.» | No es XML, está dañado, usa una codificación distinta de UTF-8 o ISO-8859-1, trae declaraciones `<!DOCTYPE` (bloqueadas por seguridad), pasa de 2.000 ítems, está en una moneda distinta de PEN o USD, o tiene importes repetidos o negativos. | Descarga de nuevo el XML desde la fuente original. |
| «El XML no trae todos los datos del comprobante.» | Le falta, por ejemplo, el importe total. | Consigue el XML completo. |
| «El XML no corresponde a este comprobante: no coincide el RUC del emisor y el número.» | Subiste el XML de otra factura. El mensaje dice qué campos difieren (RUC del emisor, tipo, serie, número o RUC del receptor). | Sube el XML de esa compra. |
| «El XML no corresponde a este cliente: no coincide el RUC del receptor.» | En «Agregar desde XML», la factura no está emitida a tu cliente. | Usa un XML recibido por ese cliente. |
| «Este comprobante ya tiene un XML guardado.» | Ya hay un XML subido o real. No se reemplaza. | Nada: el XML vigente se queda. |
| «Este comprobante ya está en la propuesta.» | En «Agregar desde XML», la compra ya existe. | «Ubicar la compra existente» y abre su lupa. |
| «El tipo de cambio es obligatorio en USD.» / «Ingresa el tipo de cambio con hasta 3 decimales, por ejemplo 3.752.» | El XML en USD no trae tipo de cambio y la compra lo necesita. | Escribe el tipo de cambio. |
| «Elige el destino de la compra.» | Falta elegir DG, DGNG o DNG. | Elígelo. |
| Botones de la lupa deshabilitados | El periodo está `revisado` (y no tienes `sire.aprobar_generar`) o `generado`, o el cliente está archivado. | Ver [módulo 08](08-compras.md). |

Además:

- La lupa **no verifica la firma digital** del XML ni el CDR. No afirma que el XML sea auténtico.
- No hay botón de PDF ni «Recordar para este proveedor» en esta versión.
- Un XML que llega o se sube **no crea una versión nueva** de la fila ni cambia sus montos: solo vuelve a evaluar las reglas. Los montos cambian cuando tú aceptas una sugerencia o editas.

## Pruébalo con los datos de prueba

Usa el cliente `20700000002`, periodo `202610`, con la propuesta de compras ya descargada.

1. **Abrir la mixta.** En la grilla, abre la lupa de F001-2056 (PRUEBA PROVEEDOR MIXTO S.A.C.). Debes ver «XML simulado». En «Ítems del XML» hay dos líneas: «Producto gravado de prueba (PRUEBA)» como «Gravado (10)» y «Producto exonerado de prueba (PRUEBA)» como «Exonerado (20)».
2. **Leer la comparación.** «Base imponible» dice 21.48 en el SIRE y 8.97 en el XML: «Difiere» con R-MIX. «No gravado» dice 0.00 y 12.51: «Difiere». «IGV» (1.61) y «Total» (23.09) coinciden.
3. **Ver el hallazgo.** En «Hallazgos y sugerencia» debe decir «R-MIX · Compra mixta» con «1.61 no es 18 % ni 10 % de 21.48; el XML indica gravado 8.97».
4. **Subir el XML a mano.** Pulsa «Subir XML» y elige `fixtures/xml/20700000045-01-F001-2056.xml`. Debes ver «XML subido.» y la etiqueta «XML subido por [tu nombre] el [fecha]». Los montos del XML siguen siendo 8.97, 1.61 y 12.51. «Subir XML» ya no aparece.
5. **Aceptar con el teclado.** Haz clic en un espacio vacío de la ventana y presiona Enter, revisa y presiona Enter otra vez. Tras «Sugerencia aceptada.», la comparación debe decir «Coincide» en todas las columnas.
6. **Navegar.** Presiona ← o → para pasar a F001-1040 (San Juan). Debe mostrar ISC 770.00 en el XML, 0.00 en el SIRE, y el hallazgo R-ISC. Pasa a F001-5070: el ítem «Par de zapatillas deportivas de prueba».
7. **Probar un XML ajeno.** En la lupa de F001-3064, el XML es simulado, así que aparece «Subir XML». Sube `20700000011-01-F001-1040.xml`. Debe salir «El XML no corresponde a este comprobante: no coincide …» con el RUC del emisor y el número. No cambia nada.
8. **Probar un XML no disponible.** Agrega a mano una compra cuyo número termine en **8** (por ejemplo F001-108, proveedor `20700000045`; cómo agregar está en el [módulo 08](08-compras.md)). Ábrela en la lupa: si dice «aún no se solicitó», pulsa «Obtener XML». Al terminar verás «XML no disponible» con «SUNAT no entregó el XML de este comprobante.», más «Reintentar» y «Subir XML». Con un número que termine en **9** verás la causa de credencial, y con **7** la falla pasajera. Son los «centinelas» de la simulación.
9. **Agregar desde XML (duplicado).** Pulsa «Agregar compra» → «Subir XML» → elige `20700000061-01-F001-4062.xml`. Como F001-4062 ya está en la propuesta, verás «Este comprobante ya está en la propuesta.» con «Ubicar la compra existente».
10. **Agregar desde XML (nuevo, en USD).** Haz una copia de `20700000061-01-F001-4062.xml` en otra carpeta y, con un editor de texto, cambia `<cbc:ID>F001-4062</cbc:ID>` por `<cbc:ID>F001-4063</cbc:ID>`. Súbela en «Agregar compra». Debe pedirte el tipo de cambio: escribe `3.300`, elige DG y pulsa «Agregar compra». Verás «Compra agregada desde el XML.» y la nueva fila con base 0.15, IGV 0.03 y total 0.18 en USD.

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| La descarga de una versión (o «Descargar XML» en la lupa) falla con un error, aunque la versión aparece en la lista | Tu `.env` tiene `STORAGE=mock`: el worker guardó el archivo en su memoria y el backend no lo encuentra (`archivo_alterado`). | Configura `STORAGE=local` con una ruta completa ([módulo 01](01-preparar-entorno.md)). Lo generado antes del cambio no se recupera: reabre y genera de nuevo. |
| La lupa se queda en «Pendiente: se está obteniendo el XML.» | El worker no está corriendo o la cola está detenida. | Revisa «Trabajos» ([módulo 06](06-credenciales-y-trabajos.md)) y que el worker esté levantado ([módulo 01](01-preparar-entorno.md)). |
| Veo el XML simulado pero la sugerencia sigue siendo un estimado. | `XML_SIMULADO_EN_REGLAS` está apagada. | Es lo esperado en producción. En pruebas, actívala o sube el XML a mano. |
| No aparece «Subir XML». | Ya hay un XML subido, o no tienes `sire.clasificar`, o eres de rol Lectura. | Si ya hay XML subido, no se reemplaza. Si no, pide el permiso. |
| Enter no abre la aceptación. | El foco está en un botón o campo, o la fila no tiene sugerencia, o el periodo no te deja modificar. | Haz clic en un espacio vacío de la ventana y vuelve a presionar Enter. |
| «Este comprobante ya está en la propuesta.» al agregar desde XML. | La compra ya existe. | «Ubicar la compra existente» y sube el XML desde su lupa. |

## Comprueba lo aprendido

1. Abres la lupa de una compra y ves «XML simulado». ¿Puedes subir encima el XML que te mandó el proveedor? ¿Y si dijera «XML subido por …»?
2. El periodo está `generado`. ¿Puedes subir un XML a una compra? ¿Puedes aceptar su sugerencia?
3. Tu compañero dice que la sugerencia de la mixta pide confirmación y no muestra 8.97 exacto, aunque la lupa enseña el XML simulado. ¿Qué revisas?
4. Tienes el XML de una factura en USD que no está en la propuesta. ¿Qué pasos sigues y qué dato extra te pedirá ContApp?
5. Subes un XML y sale «El XML no corresponde a este comprobante: no coincide el número.». ¿Qué pasó?

<details>
<summary>Soluciones</summary>

1. Sí: con XML simulado, «Subir XML» aparece y tu XML lo reemplaza (el anterior se conserva en el sistema, pero queda vigente el tuyo). Con «XML subido por …» no: un XML subido o real no se reemplaza y el servidor responde «Este comprobante ya tiene un XML guardado.».
2. Subir el XML, sí: no cambia montos y se permite en cualquier estado del periodo (solo lo impide un cliente archivado). Aceptar la sugerencia, no: con el periodo `generado` hay que reabrirlo primero.
3. La variable `XML_SIMULADO_EN_REGLAS`: si está en 0 o no está, el XML simulado se ve pero no entra en las reglas. En pruebas se pone en 1; también puedes subir el XML a mano, que siempre cuenta.
4. «Agregar compra» → «Subir XML» → revisar los datos leídos → elegir el destino → escribir el tipo de cambio (hasta 3 decimales) → «Agregar compra». El dato extra es el tipo de cambio, porque el XML no lo trae.
5. Subiste el XML de otro comprobante (misma serie y proveedor, pero otro número). Busca el XML correcto: ContApp solo lo acepta si coinciden RUC del emisor, tipo, serie, número y receptor.

</details>

## Para saber más

- Curso técnico: [13 · La lupa del comprobante: XML UBL, parser seguro y re-evaluación](../curso/13-lupa-xml.md)
- Spec: [`docs/specs/016-lupa-xml/spec.md`](../specs/016-lupa-xml/spec.md)
- Requisitos: RF-090 a RF-099 (con RF-097a y RF-097b), RF-061, RF-067 · HU-18, HU-20, HU-21, HU-22, HU-23, HU-24.
