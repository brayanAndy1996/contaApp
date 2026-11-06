# Spec 014 · Compras (backend): propuesta inmutable, versiones de fila, clasificación, exclusión y agregar

Estado: borrador (a la espera de las respuestas a P-1 a P-12). Rama `spec/014-compras-backend` desde `main`. Sin `plan.md` ni `tasks.md` hasta que el usuario apruebe.
Nivel de riesgo: B (propuesto; ver P-12). Respuestas de 04 §2.1: (1) sí: la clasificación y los montos de cada fila alimentan el TXT de reemplazo; (2) sí: guarda las compras de los clientes de cada estudio, con aislamiento por RLS y por asignación (no maneja credenciales); (3) parcial: un cambio de columna o una versión pisada no se nota a simple vista; (4) sí: acciones masivas, deshacer y ediciones concurrentes. Por §2.1 literal saldría A; lo crítico en dinero, reglas y prevalidación ya está hecho y probado en 010, 011 y 012 (nivel A), y esta spec los orquesta y los persiste. Mismo caso que 007a y 007b.
Cubre: RF-060 (solo API, ver P-8), RF-061 a RF-071 (la grilla y los atajos de teclado son de 015) · HU-14 a HU-19 (parte backend) · RNF-052 · notas [014] y [012b] de ESTADO.

## Objetivo
Que el contador descargue la propuesta de compras de un cliente, la revise y la corrija fila por fila o en masa sin perder nunca lo que dijo el SIRE, y que 012b y 015 encuentren los datos listos: propuesta original inmutable, versiones de cada fila con autor y fecha, hallazgos del motor de 011, resumen por casillero y las filas en la forma que pide la prevalidación de 012.

## Alcance
- Modelo y migraciones desde la **0032** (013 reserva 0028–0031): `compra`, `compra_version`, `compra_operacion`, `compra_hallazgo` y `compra_periodo`, con RLS forzada y NUMERIC(14,2). La tabla `propuesta` y el tipo de trabajo `sire.propuesta.descargar` se reparten con 013 según P-1.
- Trabajo `sire.propuesta.descargar` (libro compras) en el worker con `SireApiClient` (mock en R1): guarda la propuesta como original y evalúa las reglas.
- API REST bajo `/clientes/:clienteId/periodos/:periodo/compras`: descargar, listar con filtros, detalle con historial de versiones, resumen por casillero, acciones (clasificar, editar, aceptar sugerencia, excluir, restaurar, descartar una agregada), acciones masivas, agregar, deshacer, rehacer, marcar revisado y reabrir.
- Dominio puro en `packages/domain/src/compras/`: identidad y clave normalizada, resumen por casillero, mapeo a `FilaReemplazo`. El lint contra `number` de 010 se amplía a esa carpeta (nota [011/013]).
- Esquemas zod y DTOs en `packages/shared` (el frontend solo depende de `shared`).
- Entrega a 012b: `leerFilasReemplazo` (original y vigente, listos para `prevalidar` y `resumirCambios`).

## Fuera de alcance
- Grilla, edición con teclado, Ctrl+Z y resumen en pantalla: 015. Modal de la lupa, parser UBL, `xml.obtener`, tabla del XML y subida manual: 016. Cuando 016 guarde el XML, re-evalúa las filas con el mismo punto de entrada que define D-4.
- Generar el archivo, `archivo_generado`, storage, versiones del archivo y su descarga: 012b. Aquí solo el estado del periodo (D-9) y la lectura de filas (D-10).
- Auditoría solo-inserción y notificaciones: 017 (D-12). Aprendizaje por proveedor, «Recordar para este proveedor», R-HIS y catálogo global de proveedores ISC: R2 (en R1 `proveedoresIsc` va vacío).
- Ventas, correlatividad, boleta 291 y formato TXT de ventas: 013. Importar archivo, agregar con XML y exportar a Excel: P-8, P-9 y P-11.
- RF-046 (listar periodos SIRE y su estado) no figura en ninguna fila de 04 §4: no se toma aquí. Sin adaptadores reales (`HttpSireApiClient`, `RealXmlProvider`): el backend nunca llama a SUNAT y el worker corre en `mock`.

## Frontera con 013
| Pieza | Dueño | Nota |
|---|---|---|
| `compra`, `compra_version`, `compra_operacion`, `compra_hallazgo`, `compra_periodo` | 014 | Columnas DG/DGNG/DNG de 010. 013 define sus propias tablas de ventas (otras columnas, sin clasificación). |
| `propuesta` (encabezado inmutable de cada descarga y libro), tipo `sire.propuesta.descargar` (con `libro`) y su procesador | Compartido: P-1 | Un solo tipo de trabajo evita registrar dos formas distintas (`registrarTipo` rechaza cambiar la forma de un tipo). |
| `FilaPropuestaSire` en `packages/sunat/src/puertos.ts` | Compartido | Solo se amplía con campos opcionales. 014 agrega `tipoDocContraparte` (por defecto «6») y `razonSocialContraparte`; 013 agrega los suyos. Ninguno quita ni renombra. |
| Clave normalizada de comprobante | 014 la define en `packages/domain/src/compras/`; 013 puede reutilizarla | Misma normalización que los duplicados de 012: serie en mayúsculas, número sin ceros a la izquierda, documento en mayúsculas ASCII. |
| Patrón «versión de fila solo-inserción» | Se repite por libro | No es código común: 013 decide si lo necesita. |

## Decisiones
- D-1 Modelo y versiones (RNF-052). Todas las tablas llevan `tenant_id`, RLS forzada, uuid v7 y NUMERIC(14,2). `compra` guarda la identidad (clave, tipo, serie, número, documento y razón social del proveedor, fecha, moneda, tipo de cambio, `origen` = `sire` | `agregada`) y un puntero `version_vigente`. `compra_version` es solo inserción: `n`, las 10 columnas de montos de 010 más el total, `excluida`, `motivo` (hasta 200), `clasificada`, `accion`, `operacion_id`, usuario y fecha. La versión 1 es la fila tal como la trajo el SIRE y no se actualiza ni se borra. Los roles de la aplicación no tienen UPDATE ni DELETE sobre `compra_version` ni `propuesta`, y un trigger impide cambiar la identidad de `compra`; lo único mutable es el puntero, con compare-and-set. La clave de identidad es única entre las filas vivas del cliente y periodo.
- D-2 Concurrencia. Toda acción lleva `versionBase`. Si no es la vigente, 409 `version_obsoleta` con la versión vigente y no se escribe nada. Las masivas llevan el `versionBase` de cada fila. Escribir la versión y mover el puntero es una sola transacción, con las filas bloqueadas en orden de id (sin interbloqueos entre masivas).
- D-3 Descarga. El tipo `sire.propuesta.descargar` va en la cola `sire` con canal `sire`, credencial `sire_api`, permiso `sire.descargar` e idempotente; parámetros `{ periodo: AAAAMM, libro }`, sin futuro. El procesador usa `conToken` y `SireApiClient` sin transacción abierta (008 D6) y después persiste en una sola transacción: encabezado, filas, versión 1 y hallazgos. Todo o nada: una fila con un monto que no cabe en NUMERIC(14,2), con moneda o tipo de cambio inválidos o con clave repetida en la misma descarga da `ErrorDatos`, el trabajo falla sin reintento y no queda nada a medias. Un reintento tras una caída no duplica filas (la clave de identidad). El backend solo encola; nunca importa `@contapp/sunat`.
- D-4 Reglas (RF-080, nota [014]). Se usa `evaluarReglas` de 011 con un único entorno: las filas del periodo, `proveedoresConocidos` (proveedores de las compras vivas o excluidas de ese cliente en otros periodos) y el diccionario base de 011. Se evalúa al descargar, y de nuevo la fila después de cada versión nueva; se guardan los hallazgos con sus `lecturas`. `aplicarSugerencia` y `aplicarMasivo` reciben siempre el mismo entorno. `SugerenciaObsoletaError` da 409 `revisar_de_nuevo` y `requiere_dato` da 422 con el dato pedido; en ambos casos no se escribe. Aceptar una sugerencia es una versión nueva con `accion = sugerencia`; nada se aplica solo. Un R-NEW resuelto (la fila ya tiene `clasificada`) no reaparece al re-evaluar. Una regla que falla con una fila deja esa fila sin hallazgos y no tumba la descarga (aislamiento de D19 de 012).
- D-5 Clasificar y editar (RF-062 a RF-064). Clasificar usa `cambiarDestino` de 010 y fija `clasificada`. Editar acepta cualquier subconjunto de las 10 columnas; el total se recalcula como Σ componentes (D2 de 010) y la respuesta trae el cuadre por celda (`verificarCuadre`, `igvCuadra`) con su explicación. Un IGV descuadrado se guarda y se señala (HU-16); quien bloquea la generación es la prevalidación de 012. Se admiten montos negativos (notas de crédito). Un monto con más de 2 decimales o fuera de NUMERIC(14,2) es 400.
- D-6 Excluir (RF-066). Una versión con `excluida = true` y motivo opcional: sale de los totales y de la lista principal y aparece en «excluidas»; restaurar crea otra versión. Una excluida sigue contando como historial del proveedor. Cualquier edición sobre una excluida es 409 `fila_excluida`.
- D-7 Agregar (RF-067). El formulario crea una `compra` con `origen = agregada` y versión 1. Si la clave ya existe entre las filas vivas, también excluidas, es 409 `duplicado` con el id de la existente (HU-18). «Descartar» solo vale para una agregada: queda marcada y sale de la lista, del resumen y del mapeo (no cuenta como excluida; nota [014]) y libera su clave. Las filas del SIRE nunca se descartan: se excluyen.
- D-8 Resumen (RF-068, RF-069). Función pura: por casillero (BI e IGV de DG, DGNG, DNG, no gravado, ISC, ICBPER, otros y total), original (versión 1 de las filas del SIRE) frente a vigente (sin excluidas ni descartadas) y la diferencia, todo con `Money`. Las filas USD se convierten con `convertirAPen`; las que no se pueden convertir salen en `filasSinConvertir` y no suman, igual que `resumirCambios`. «Con IGV» y «sin IGV» se separan por la suma de IGV de la fila distinta o igual a 0.00, con su cantidad.
- D-9 Estado del periodo (RF-071). `compra_periodo` guarda por cliente y periodo el estado (`abierto` | `revisado` | `generado`), quién lo marcó y cuándo; se crea en la primera descarga. Cada escritura de fila comprueba el estado; las reglas de bloqueo salen de P-4. `generado` lo fija 012b.
- D-10 Entrega a 012b (nota [012b]). `aFilaReemplazo` (pura) y `leerFilasReemplazo(tx, clienteId, periodo)` devuelven `{ original, vigente }`. Original: versión 1 de las filas del SIRE. Vigente: estado `excluida`, `agregada`, `modificada` (versión > 1) u `original`. `tipoCambio` es `null` en las filas PEN (nota [014]). Una fila USD pasa en USD con su tipo de cambio y sin `origenUsd`: la forma provisional de 009 no trae los montos en soles. La lectura usa los mismos tipos de 012, y 012b siempre le pasa `reglas` (nota [012b]).
- D-11 Permisos y alcance. Leer: `clientes.ver`. Descargar: `sire.descargar`. Clasificar, editar, aceptar, excluir, restaurar, agregar, descartar, deshacer, rehacer y marcar revisado: `sire.clasificar`. Editar un periodo revisado y reabrirlo: `sire.aprobar_generar`. Toda ruta con `:clienteId` usa `ClienteScopeGuard` (cliente ajeno o inexistente, el mismo 404) y todo listado `filtroAlcance`. Un cliente archivado da 409 `cliente_archivado` en toda escritura (007a D5). Un `compraId` de otro cliente, periodo o estudio da 404.
- D-12 Trazabilidad hasta 017 (RF-150). Las versiones guardan usuario, fecha, acción y, con la versión previa, el valor anterior y el nuevo; `compra_periodo` guarda quién revisó. 014 no crea la tabla de auditoría; 017 la alimenta desde aquí. Ningún log ni error lleva montos, claves ni razones sociales.
- D-13 Listado y volumen. Hasta 5.000 filas por periodo (RNF-031): paginación por cursor, filtros `vista` (`con_igv` | `sin_igv` | `excluidas`), `alertas`, `proveedorNuevo` y `q` (prefijo de RUC, fragmento de razón social o serie-número, comodines escapados), ordenado por fecha, serie y número. Las masivas reciben una lista explícita de hasta 5.000 ids; el filtro por proveedor lo resuelve el frontend. La razón social del SIRE es texto no confiable: se guarda como texto y el frontend la escapa.

## Criterios de aceptación
Los casos usan los fixtures de 009 (`fixtures/sire/20700000002-compras-202610.json`).
- [ ] CA-1 (RF-060, D-3): Dado un cliente con credencial SIRE verificada, cuando se pide descargar 202610, entonces responde 202 con `trabajoId`; al terminar hay 5 compras con versión 1 idéntica a la fila del SIRE (montos como cadenas exactas) y hallazgos R-ISC en F001-1040 y R-MIX en F001-2056. Una fila inválida deja la base sin cambios y el trabajo en error sin reintento. `apps/backend` no importa `@contapp/sunat`.
- [ ] CA-2 (RNF-052, D-1): Dado cualquier cambio posterior, entonces la versión 1 sigue igual; con los roles de la aplicación, UPDATE o DELETE sobre `compra_version`, `propuesta` o la identidad de `compra` fallan. El detalle devuelve original y vigente por separado.
- [ ] CA-3 (D-2): Dadas dos acciones simultáneas con el mismo `versionBase`, entonces una gana y la otra recibe 409 `version_obsoleta` sin escribir; una masiva con filas contendidas no deja ninguna a medias ni interbloquea.
- [ ] CA-4 (RF-062, RF-063, HU-15): Dada F001-3064 en DG, cuando se clasifica como DNG, entonces BI e IGV pasan a las columnas 3 y el total no cambia; clasificar 12 filas es una sola operación; el resumen refleja el cambio.
- [ ] CA-5 (RF-064, D-5): Dada una edición de la BI, entonces el total es Σ componentes y, si el IGV deja de cuadrar, la respuesta marca la celda con su explicación y aun así guarda; más de 2 decimales o fuera de rango dan 400.
- [ ] CA-6 (RF-080, D-4, casos San Juan y mixta): Dado F001-1040, cuando se acepta R-ISC con confirmación, entonces BI DG = 0.00 e ISC = 770.00. Dado F001-2056 sin XML, aceptar R-MIX pide `gravado` (422) y con 8.97 deja 8.97 en DG y 12.51 en no gravado. Dada una fila editada después de evaluarse, aceptar su sugerencia vieja da 409 y no escribe.
- [ ] CA-7 (RF-066, HU-17, D-6): Dada una compra con glosa «zapatillas», cuando se excluye con motivo, entonces sale de los totales y aparece en «excluidas»; restaurar la devuelve mientras el periodo no esté generado; después, 409 `periodo_generado`.
- [ ] CA-8 (RF-067, HU-18, D-7): Dado el formulario de una compra nueva, entonces queda como `agregada`; repetir una clave de una fila viva o excluida da 409 `duplicado` con su id; descartar la agregada la quita sin contarla como excluida y libera la clave.
- [ ] CA-9 (RF-068, RF-069, D-8): Dada la propuesta con San Juan corregido, el resumen muestra BI de DG −770.00 e ISC +770.00 frente a la original, separa compras con y sin IGV con sus cantidades, y la fila USD o se convierte o sale en `filasSinConvertir`.
- [ ] CA-10 (RF-070, HU-19, D-4): Dado un proveedor sin compras previas del cliente, la fila trae `proveedorNuevo` y queda pendiente; con una compra en otro periodo del mismo cliente no; el historial de otro cliente o estudio no cuenta; una vez clasificada deja de estar pendiente.
- [ ] CA-11 (RF-065): Según P-3: deshacer revierte la última operación (una masiva es un paso) creando versiones nuevas sin borrar nada; rehacer la repone; si la fila cambió después, 409 y nada se escribe.
- [ ] CA-12 (RF-071, D-9): Según P-4: con el periodo revisado, `sire.clasificar` recibe 403 `periodo_revisado` al editar y `sire.aprobar_generar` edita y reabre.
- [ ] CA-13 (D-11, aislamiento): Un asistente no asignado recibe el mismo 404 que un cliente inexistente en todas las rutas; sin el permiso, 403; sin `app.tenant_id` o con el de otro estudio, 0 filas; un cliente archivado da 409 `cliente_archivado`.
- [ ] CA-14 (D-10, integración con 012): Dado el fixture sin corregir, `leerFilasReemplazo` más `prevalidar` dan `apto = false` con el error de IGV de F001-2056; tras aceptar las sugerencias de San Juan y la mixta dan `apto = true`, y `resumirCambios` cuenta 2 modificadas y 0 excluidas. Las filas PEN llevan `tipoCambio: null`.
- [ ] CA-15 (RNF-031, RNF-033, RNF-034): Con 5.000 filas sintéticas, persistir y evaluar la descarga termina sin error, el listado responde en menos de 2 s en el servidor y una acción sobre una fila tiene p95 < 300 ms.
- [ ] CA-16: Typecheck y lint limpios; `packages/domain/src/compras/` sin IO y cubierto por la regla contra `number`; ningún monto como `number` en repositorios ni DTOs; cobertura ≥ 80 % por archivo en `compras/`; sin secretos en logs ni errores.
- [ ] Casos reales aplicables: San Juan ISC (CA-1, CA-6, CA-9, CA-14), mixta 21.48 / 1.61 (CA-1, CA-6, CA-14), zapatilla (CA-7), redondeo USD (sintético: F001-4062; CA-9; el caso real sigue diferido sin cifras). Boleta 291: no aplica (013).

## Ataques del adversario (solo si P-12 = a)
Una ronda de hasta 15 pruebas, caja negra y luego blanca, limitada a: UPDATE o DELETE de la versión 1 con cada rol; doble acción con el mismo `versionBase`; deshacer sobre filas tocadas por otro usuario; ids de otro cliente, periodo o estudio en masivas; asistente no asignado; `compraId` ajeno en la URL; masiva con 5.001 ids; dos descargas simultáneas del mismo periodo; razón social con fórmula o HTML; montos 0.005, 0.015, negativos y enormes.

## Dependencias
- Specs: 002 (RLS, `withTenant`), 005 (`ClienteScopeGuard`, `filtroAlcance`, permisos), 007a (archivado), 007b (credencial `sire_api`), 008 (catálogo, ejecutor, `conToken`), 009 (`SireApiClient`, fixtures), 010 (Money, `cambiarDestino`, cuadre, `convertirAPen`), 011 (`evaluarReglas`, aplicar), 012 (`FilaReemplazo`, `prevalidar`, `resumirCambios`), 013 (P-1). Después: 012b, 015, 016, 017, 018.
- Externas: ninguna en R1. Para el adaptador real: la forma real de la propuesta (tipo de documento y razón social del proveedor, y si en USD trae también los montos en soles).

## Preguntas abiertas
Cada una lleva su opción recomendada (Recom.). Mientras no se responda, la spec se redacta con la recomendada.
- P-1 Modelo común con 013 (propuesta, tipo de trabajo y procesador de descarga). ¿Dónde nace?
  - (a) (Recom.) En 013: `propuesta` con `libro`, el tipo `sire.propuesta.descargar` y su procesador, que delega en un persistidor por libro. 014 agrega `compra*` y su persistidor; sus tareas de base de datos esperan el merge de 013 (el dominio puro corre en paralelo).
  - (b) En 014: crea `propuesta`, el tipo y el procesador; 013 los consume. Choca con que 013 reservó la 0028 antes.
  - (c) Sin nada compartido: `propuesta_compra` y `propuesta_venta`, y los tipos `sire.compras.descargar` y `sire.ventas.descargar`. Sin dependencia entre 013 y 014, a cambio de duplicar código y de corregir 03 §6.1 y §8.
- P-2 Descargar de nuevo un periodo ya descargado.
  - (a) (Recom.) Complementar: agrega solo los comprobantes nuevos del SIRE como originales, nunca toca una fila existente, e informa cuántas filas del SIRE difieren de su versión 1 (aviso, sin cambiarlas). Además hace idempotente el reintento.
  - (b) Rechazar: 409 `propuesta_existente`; lo que falte se agrega a mano.
  - (c) Reemplazar: descarta el trabajo del periodo y carga todo de nuevo, con confirmación y solo si el periodo está abierto. Riesgo de perder correcciones.
- P-3 Deshacer y rehacer (RF-065, «dentro de la sesión de trabajo del periodo»).
  - (a) (Recom.) Persistente por periodo y por usuario: deshace la última operación propia (una masiva es un paso) creando versiones que restauran; rehacer vale hasta la siguiente acción; si otra persona cambió la fila después, 409 y no se deshace nada.
  - (b) Persistente por periodo y de cualquiera: la última operación del periodo, sea de quien sea. Riesgo de deshacer trabajo ajeno.
  - (c) Solo en el navegador: 014 no guarda pila; deshacer es enviar la acción inversa y se pierde al recargar.
- P-4 Estados del periodo y bloqueo de edición (RF-071, HU-17).
  - (a) (Recom.) `abierto` → `revisado` (lo marca quien tenga `sire.clasificar`) → `generado` (lo fija 012b). En `revisado` solo edita y reabre quien tenga `sire.aprobar_generar`. En `generado` nadie edita ni restaura hasta que alguien con `sire.aprobar_generar` lo reabra de forma explícita.
  - (b) Solo `abierto` y `revisado`: generar no bloquea. Quien tenga `sire.aprobar_generar` sigue editando después de generar y el archivo anterior queda como desactualizado (lo marca 012b). No cumple HU-17 («mientras no esté generado») para ese rol.
  - (c) Como (a), pero marcar `revisado` exige `sire.aprobar_generar`: el asistente no puede cerrar su propia revisión.
- P-5 Acciones masivas (clasificar, aceptar, excluir, restaurar).
  - (a) (Recom.) Parcial con informe: se aplican las filas válidas en una sola operación y se devuelven las rechazadas con su código (`version_obsoleta`, `requiere_dato`, `fila_excluida`), como `aplicarMasivo` de 011.
  - (b) Todo o nada: si una fila falla no cambia ninguna y se devuelve la lista de las que fallaron.
- P-6 Qué sugerencias se aceptan en masa.
  - (a) (Recom.) Solo las que no piden confirmación ni dato: R-RED y las que respalda el XML. R-ISC sin XML, R-MIX sin monto exacto y R-NEW se aceptan de una en una.
  - (b) También las que piden confirmación (R-ISC sin XML), si el usuario confirma la lista completa; R-NEW con un mismo destino elegido por él; R-MIX nunca en masa.
- P-7 Proveedor nuevo en el primer periodo de un cliente (RF-070).
  - (a) (Recom.) Literal: sin historial en ContApp, todos los proveedores son nuevos y quedan por clasificar (01 §7 regla 5: el primer mes lo hace el contador); la clasificación masiva por proveedor (RF-063) lo hace rápido.
  - (b) El primer periodo de cada cliente no genera R-NEW ni la etiqueta. Evita el ruido, pero esconde proveedores que sí son nuevos.
- P-8 Importar la propuesta desde archivo (RF-060 «o importarla desde archivo»).
  - (a) (Recom.) Diferido: 014 solo trae la API (mock). El formato del TXT de la propuesta de SUNAT no está en `docs/` (como 012 D10) y 013 tiene el mismo hueco con RF-051; una sola spec de importación cuando llegue el anexo.
  - (b) 014 importa Excel o CSV con una plantilla propia de ContApp (columnas fijas), con los topes y la defensa contra fórmulas de 007b; la propuesta queda con `origen = archivo`.
- P-9 Agregar una compra subiendo su XML (RF-067, HU-18).
  - (a) (Recom.) 014 entrega el formulario y el servicio `agregarCompra`; la subida y el relleno automático llegan con el parser de 016, que llama a ese servicio.
  - (b) 014 incluye un parser UBL mínimo solo para esto y 016 lo sustituye. Duplica trabajo y abre el riesgo de XXE fuera de la spec que tiene ataques de parser.
- P-10 Recálculo y cuadre en vivo para 015 (RF-064; `apps/frontend` solo depende de `shared`).
  - (a) (Recom.) Vista previa `POST …/compras/:id/calcular` (sin guardar) con el total y el cuadre por celda con la lógica de 010; 015 la llama con debounce y suma en local con `decimal.js` para lo inmediato.
  - (b) Mover a `shared` las funciones puras de total e IGV para que 015 calcule sin red. Toca 010 (nivel A) y su lint.
  - (c) Sin vista previa: el cuadre se informa solo al guardar.
- P-11 Exportar la grilla a Excel (RF-105): no figura en ninguna fila de 04 §4.
  - (a) (Recom.) 014 agrega `GET …/compras/exportar.xlsx` en el servidor, con las filas vigentes y neutralización de fórmulas (`=`, `+`, `-`, `@`), y prueba TDD; suma una dependencia de escritura de xlsx.
  - (b) Fuera de 014: lo toma 015 o 012b. Hay que asignarlo en 04 §4 y la defensa contra inyección de fórmulas queda sin ronda propia.
- P-12 Nivel y ronda adversarial.
  - (a) (Recom.) B con TDD y una ronda adversarial acotada a inmutabilidad, concurrencia y alcance (sección «Ataques»), como 007b.
  - (b) B sin adversarial: más barato, pero la inmutabilidad y las versiones concurrentes solo las prueba quien las implementa.
  - (c) A completo (hasta 2 rondas y revisión final de Opus).
