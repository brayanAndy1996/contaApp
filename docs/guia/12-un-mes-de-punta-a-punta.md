# 12 · Un mes de trabajo de punta a punta

> Anterior: [11 · Auditoría y notificaciones](11-auditoria-y-notificaciones.md) · Siguiente: [13 · Reglas aprendidas](13-reglas-aprendidas.md) · Índice: [00-indice.md](00-indice.md)

Este módulo une todo lo anterior en un solo recorrido: el cierre de compras y ventas de octubre de 2026 de un cliente, desde que lo das de alta hasta que descargas el archivo. Al terminar sabrás en qué orden se usa cada pantalla, qué no hace todavía ContApp y cómo resolver los problemas más comunes.

> **Este recorrido se probó de verdad.** Levantamos ContApp con PostgreSQL, Redis y los datos del seed, y un navegador automático siguió estos pasos. Las cifras y los mensajes de abajo son los que se vieron en pantalla. Donde la prueba encontró un problema de configuración, está explicado en «Problemas frecuentes».

## Para qué sirve

En un estudio, el cierre del mes de cada cliente se repite: bajar la propuesta del SIRE, revisarla, corregir lo que SUNAT trae mal, revisar que no falten comprobantes y presentar el reemplazo. ContApp ordena ese trabajo en cinco momentos:

| Momento | Qué haces | Módulo |
|---|---|---|
| **1. Preparar** (una vez por cliente) | Alta del cliente, perfil fiscal, responsable y credenciales | [05](05-clientes.md), [03](03-equipo-roles-asignaciones.md), [06](06-credenciales-y-trabajos.md) |
| **2. Traer** | Descargar la propuesta de compras y de ventas del periodo | [07](07-ventas.md), [08](08-compras.md) |
| **3. Revisar y corregir** | Alertas, sugerencias, lupa con el XML, correlatividad, exclusiones | [08](08-compras.md), [09](09-lupa-y-xml.md), [07](07-ventas.md) |
| **4. Cerrar** | Prevalidar, ver el resumen de cambios, generar y descargar el archivo | [10](10-generar-archivo.md) |
| **5. Controlar** | Auditoría de quién hizo qué y notificaciones | [11](11-auditoria-y-notificaciones.md) |
| **Mes siguiente** | Las compras de los proveedores que pediste «Recordar» llegan ya clasificadas | [13](13-reglas-aprendidas.md) |

## Quién puede usarlo

| Rol | En este recorrido |
|---|---|
| Dueño o Administrador | Todo: alta del cliente, credenciales, correcciones, generar y reabrir. |
| Contador | Credenciales, descargas, correcciones y generar el archivo (tiene `sire.aprobar_generar`). No crea clientes. |
| Asistente | Correcciones en los clientes asignados. Ve el previo y descarga versiones, pero no genera. |
| Lectura | Solo mira. |

El detalle está en el [módulo 03](03-equipo-roles-asignaciones.md).

## Antes de empezar

- ContApp arrancado como en el [módulo 01](01-preparar-entorno.md), **con `STORAGE=local` y una ruta completa en `STORAGE_DIR`**. Sin eso, la descarga del archivo generado falla.
- Entra con `ua@seed.contapp.test` (Dueño del «Estudio A (seed)»), contraseña `desarrollo-contapp-2026` (solo para pruebas locales).
- Usa únicamente datos de prueba y claves inventadas. Lee el aviso del [índice](00-indice.md).

## Paso a paso

### Momento 1: preparar al cliente

1. «Clientes» → «Nuevo cliente». Escribe `20700000001` y pasa al siguiente campo: sale «El RUC no es válido.». Corrígelo a `20700000002`, razón social `PRUEBA CONTRIBUYENTE S.A.C.`, régimen «Régimen General (RG)», y «Crear cliente».
2. En la ficha, en «Credenciales», pulsa «Verificar» en la SIRE antes de guardar nada: «Primero guarda la credencial.».
3. Guarda la SOL (`PRUEBA01` / `CLAVEPRUEBA1`) y la SIRE (client_id `11111111-2222-3333-4444-555555555555`, client_secret `SECRETOPRUEBA1`). Las dos quedan «Configurada».
4. Pulsa «Verificar» en las dos. Verás «Verificando…» y, en unos segundos, «Verificada el <fecha>». En «Trabajos» aparecen «Verificando clave SOL», «Verificando credencial SIRE» y «Consultando datos de RUC», todos «Completado».

**Resultado esperado:** el cliente listo, con las dos credenciales verificadas y la campana «Notificaciones» del menú con avisos nuevos.

### Momento 2: traer las compras

5. En el encabezado de la ficha, «Compras». En «Periodo (AAAAMM)» escribe `202610` y pulsa «Descargar».
6. Debe salir «5 nuevas, 0 distintas», el estado «Abierto» y el «Resumen del periodo»: Base DG 1,041.98, IGV DG 46.71, ICBPER 1.50 y Total 1,090.19. En la grilla, «4 compras cargadas» (vista «Con IGV»).
7. Espera unos segundos a que lleguen los XML (en «Trabajos» salen con su nombre técnico, `xml.obtener`) y vuelve a abrir la pantalla con el periodo. La forma más rápida es la dirección terminada en `/compras?periodo=202610`: si recargas con F5 sin ella, la pantalla olvida el periodo.

### Momento 3: revisar y corregir

8. Lee las alertas de la grilla:
   - F001-2056: «R-MIX: 1.61 no es 18 % ni 10 % de 21.48; el XML indica gravado 8.97».
   - F001-5070: «R-GP: Posible gasto personal: la glosa dice "zapatilla"».
   - Todas: «R-NEW: Proveedor nuevo: elige la clasificación» (es el primer periodo del cliente).
9. Abre «Generar archivo» **antes** de corregir: en «Errores» está F001-2056 con `IGV` y «1.61 no es 18 % ni 10 % de 21.48», con «Ubicar en la grilla». El botón «Generar» está deshabilitado. Esto es la prevalidación: el sistema no te deja generar un archivo que SUNAT procesaría con errores.
10. En F001-2056: «Acciones» → «Aceptar sugerencias» → «Aceptar» en «R-MIX · Compra mixta». Sale «Sugerencia aceptada.» y la fila queda con 8.97 de base, 1.61 de IGV y 12.51 de no gravado.
11. Vista «Sin IGV», F001-1040 (San Juan): «R-ISC: Base gravada con IGV 0: el XML indica ISC». «Acciones» → «Aceptar sugerencias» → «Aceptar». La base pasa a 0.00 y el ISC a 770.00.
12. Mira el resumen: Base DG vigente 259.47, No gravado +12.51, ISC +770.00 y el **Total sigue en 1,090.19 «(sin cambio)»**. Corregiste dónde va cada monto, no cuánto suman.
13. Abre la lupa de F001-2056 (botón «Ver comprobante» de la columna «Lupa»): en «Comparación SIRE y XML» todas las filas dicen «Coincide».
14. Excluye la zapatilla: F001-5070 → «Acciones» → «Excluir», motivo «Gasto personal: zapatillas» (el motivo es opcional, pero conviene escribirlo) → «Excluir». El Total pasa a «1,090.19 | 913.19 | -177.00 (disminuye)».

### Momento 4: cerrar el periodo

15. Abre «Generar archivo». Ya no hay errores y «Generar» está habilitado. Púlsalo.
16. En unos segundos aparece en «Versiones generadas»: «Versión 1 · Generado el <fecha> por Usuario A», `CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip · 4 líneas`, la huella «SHA-256 del ZIP» completa y «Provisional: no subir a SUNAT». El estado del periodo pasa a «Generado» y «Acciones» de la grilla queda deshabilitado («El periodo ya está generado: reábrelo para modificarlo.»).
17. Pulsa «Descargar» en la versión 1. El ZIP trae un TXT con 4 líneas (la zapatilla excluida no está), con F001-2056 como `8.97|1.61|…|12.51|…|23.09` y F001-1040 con 770.00 en la columna de ISC.

**Para probar las versiones:**

18. «Reabrir» → «Confirmar». En «Excluidas», F001-5070 → «Acciones» → «Restaurar»: «Compra restaurada.».
19. «Generar archivo»: el panel avisa «Reabierto después de la última versión». «Generar» crea la «Versión 2» con 5 líneas, y la versión 1 sigue en la lista con su huella original.

### Momento 2 y 3 en ventas

20. Desde «Compras», el enlace «Ventas» del encabezado, que conserva el periodo. También llegas desde la ficha del cliente (enlace «Ventas»: ahí escribe `202610`) o con la dirección terminada en `/ventas?periodo=202610`. Pulsa «Descargar»: «11 nuevos, 0 difieren».
21. En el resumen, el total del periodo es 1784.30 (10 comprobantes que suman; la F002-2 en dólares no suma porque no trae tipo de cambio). En la correlatividad: «Falta B001-291» y «Faltan B003-402 a B003-404». Justifícalos o agrega las ventas que falten ([módulo 07](07-ventas.md)).
22. «Generar archivo»: en «Errores», «F002-2 · Falta el tipo de cambio de un comprobante en USD». Las ventas no se editan en ContApp (se corrigen en el sistema de facturación): pulsa «Excluir» en ese error con un motivo y genera la versión 1 del RVIE.

### Momento 5: controlar

23. «Auditoría» (en el menú lateral; en celular, dentro de «Más»): verás las acciones de este recorrido, como la creación del cliente, las credenciales guardadas, las sugerencias aceptadas, la exclusión y la generación, con autor y hora.
24. La campana «Notificaciones» del menú muestra los trabajos terminados que lanzaste (verificaciones, descargas, generación).

## Qué ves en pantalla

| Pantalla | Qué tiene que estar bien antes de pasar al siguiente momento |
|---|---|
| Ficha del cliente | Las dos credenciales «Verificada». |
| Compras / Ventas | Estado «Abierto», descarga hecha, alertas revisadas. |
| Generar archivo | «Errores» vacío, avisos leídos, resumen de cambios que tenga sentido. |
| Versiones generadas | La versión con su huella; el periodo «Generado». |

## Reglas y límites

### Lo que ContApp todavía no hace

| Falta | Qué significa para ti hoy | Cuándo |
|---|---|---|
| Conexión real con SUNAT | Las descargas, la consulta RUC, la verificación de credenciales y los XML son simulados. No sirven para clientes reales. | Spec futura de adaptadores reales |
| Formato oficial del TXT | El archivo es «Provisional: no subir a SUNAT». En producción, «Generar» queda deshabilitado (`formato_no_oficial`). | Cuando llegue el anexo oficial de SUNAT |
| Enviar el archivo a SUNAT y seguir el ticket | Lo descargas y lo subes tú (cuando el formato sea oficial). | R2 (spec 032) |
| Lupa de ventas | Solo las compras tienen lupa. | R2 (spec 034) |
| Buzones SOL, prorrata, gastos no deducibles, correos de aviso, TOTP | No están. Las reglas aprendidas sí: ver el [módulo 13](13-reglas-aprendidas.md). | R2 |
| Vencimiento de la prueba y cambio de plan por el Dueño | La prueba de 14 días no vence sola; los planes los cambia el super-admin. | R3 |

### Detalles de pantalla que vas a notar

Los encontraron la prueba en vivo o la revisión del código. No impiden usar ContApp:

- Al recargar compras o ventas con F5 se pierde el periodo escrito: escribirlo no cambia la dirección. Usa la dirección con `?periodo=AAAAMM`, o entra a Ventas desde el enlace del encabezado de Compras, que lleva el periodo.
- No hay botón «Cerrar todas mis sesiones»: cambiar la contraseña cierra las demás.
- El menú no tiene un enlace «Inicio»: abre `http://localhost:3000/`.
- El panel «Trabajos» no muestra la posición en la cola, y dos tipos de trabajo salen con su nombre técnico (`xml.obtener`, `archivo.generar`).
- La ficha del cliente no muestra el estado ni la condición del contribuyente que trae la consulta RUC.
- Importar ventas con una columna faltante muestra un error genérico («Ocurrió un error. Inténtalo de nuevo.»).

## Pruébalo con los datos de prueba

Todo este módulo es el «Pruébalo»: los pasos 1 a 24 usan el contribuyente `20700000002` y el periodo `202610`. Si quieres repetirlo desde cero, sigue «Empezar de cero» del [módulo 01](01-preparar-entorno.md).

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| El backend se cae al arrancar con `Falta DATABASE_URL para createDb` | No cargaste el `.env` en la terminal o faltó `--env-mode=loose`. | Arranca como en el [módulo 01](01-preparar-entorno.md): terminal 1 con el `.env` para backend y worker. |
| El backend se cae con `EADDRINUSE … :4000` | El frontend heredó `PORT=4000` del `.env`. | Arranca el frontend en otra terminal sin el `.env`. |
| «Descargar» una versión del archivo da error (`archivo_alterado`) | `STORAGE=mock`: el worker guardó el ZIP en su memoria y el backend no lo encuentra. | `STORAGE=local` y `STORAGE_DIR` con ruta completa; reinicia y genera de nuevo. Lo generado con `mock` no se recupera. |
| Tras recargar, la grilla aparece vacía | La pantalla olvidó el periodo. | Escríbelo de nuevo o usa `?periodo=202610` en la dirección. |
| No aparecen R-GP ni «el XML indica…» | Los XML aún no llegan, o `XML_SIMULADO_EN_REGLAS` no es `1`. | Espera los trabajos `xml.obtener` y vuelve a abrir el periodo. Revisa esa línea del `.env`. |
| «Generar» deshabilitado | Hay errores en el previo, o no tienes `sire.aprobar_generar`. | Corrige o excluye las filas del apartado «Errores»; o pide a alguien con el permiso. |
| «Acciones» deshabilitado en la grilla | El periodo está «Generado». | «Reabrir» → «Confirmar». |
| La clave SOL sale «Inválida» | Guardaste `clave-errada` (el centinela del simulador) o la credencial cambió. | Guarda otra vez la clave de prueba y pulsa «Verificar». |

## Comprueba lo aprendido

1. Generaste la versión 1, reabriste y pulsaste «Generar» sin cambiar nada. ¿Cuántas versiones hay ahora y por qué?
2. Después de aceptar R-MIX y R-ISC, ¿por qué el Total del periodo no cambia?
3. Un compañero no puede descargar ninguna versión del archivo, pero sí las ve en la lista. ¿Qué revisas primero?
4. Una venta en dólares sin tipo de cambio bloquea la generación del RVIE. ¿Puedes corregirla en ContApp? ¿Qué haces?
5. ¿Puedes subir hoy el ZIP generado a SUNAT? Explica.

<details>
<summary>Soluciones</summary>

1. Sigue habiendo una: si el TXT sale idéntico a la última versión, ContApp no crea otra y el periodo vuelve a «Generado» (módulo 10).
2. Porque las sugerencias mueven montos entre columnas (de base gravada a no gravado o a ISC) sin cambiar la suma. Es una reclasificación, como un asiento que debe y haber compensan.
3. El `.env` del servidor: con `STORAGE=mock` el backend no encuentra los ZIP que guardó el worker (`archivo_alterado`). Hay que pasar a `STORAGE=local` con una ruta completa y volver a generar.
4. No: las ventas llegan del SIRE tal como las emitió el cliente y se corrigen en su sistema de facturación. En ContApp la excluyes con un motivo para poder generar el periodo, y la restauras cuando llegue corregida.
5. No: el formato es provisional («Provisional: no subir a SUNAT») y los datos vienen de simulaciones. Se podrá cuando existan el formato oficial y la conexión real con SUNAT.

</details>

## Para saber más

- Curso técnico: [10 · Prevalidación y archivo SIRE](../curso/10-prevalidacion-y-archivo-sire.md), [12 · Compras](../curso/12-compras.md) y [15 · Pruebas E2E](../curso/15-pruebas-e2e.md), que automatiza un recorrido parecido a este.
- Siguiente paso: [13 · Reglas aprendidas](13-reglas-aprendidas.md), para que el mes siguiente las compras de tus proveedores recurrentes lleguen ya clasificadas.
- Tablero del proyecto: [`docs/specs/ESTADO.md`](../specs/ESTADO.md), con lo hecho y la hoja de ruta de R2.
