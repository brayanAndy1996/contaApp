# Spec 041 · SIRE real de solo lectura

Estado: **verificada** (2026-11-28; aprobada 2026-11-24). P-1 a P-8 resueltas (P-3, P-5 y P-6 con la corrida real de contrato; al final). CA → evidencia: `resultados.md` (T17). Plan: `plan.md` · tareas: `tasks.md`.
Nivel de riesgo: **A**. Por 04 §2.1: (1) sí: una columna mal mapeada pone montos o la clasificación DG/DGNG/DNG de la propuesta en el lugar equivocado; (2) sí: maneja `client_secret`, clave SOL y token, y un ticket o archivo ajeno metería datos de otro contribuyente; (3) sí: un desplazamiento de columna o un redondeo silencioso no se ve en la grilla; (4) sí: estados de ticket, varias partes, codificaciones, errores HTTP y concurrencia.
Cubre: RNF-042, RNF-043 · base de RF-040–045 (descarga real) y de RF-112 (historial, 025). Prerrequisito de 032 (RF-104 · HU-27).

## Objetivo
Que el worker descargue de SUNAT la propuesta real de compras (RCE) y de ventas (RVIE) y el registro presentado de compras, detrás de los puertos que ya existen (`SireAuth`, `SireApiClient`), sin cambiar procesadores, persistidores ni pantallas. `SIRE_CLIENT=mock` sigue siendo el valor por defecto.

## Alcance
- `HttpSireAuth`: token OAuth (servicio 5.1) con `client_id`, `client_secret`, `ruc+usuarioSol` y clave SOL; `expiraEn = ahora + expires_in`.
- `HttpSireApiClient.descargarPropuesta` (compras 5.34, ventas 5.18): exportar → ticket → consultar ticket (5.31/5.16) → descargar archivo (5.32/5.17) → ZIP (una o varias partes) → TXT → `FilaPropuestaSire` / `FilaVentaSire`. Sin parámetros opcionales (probado con Postman, `tools/sire-postman/`).
- `HttpSireApiClient.descargarRegistroPresentado`: servicio 5.51 (**P-3**, resuelta; ver CA-13).
- Espera del ticket sin bloquear el worker según **P-4**.
- Lectura del TXT por **nombre de encabezado** (no por posición), con fallo claro si falta una columna (**P-1**).
- Mapeo de errores HTTP a `ErrorCredencial` / `ErrorDatos` / `ErrorTransitorio` / `ErrorPortal` y renovación única del token ante 401 de la API.
- Límites anti zip-bomb, timeouts por petición y presupuesto total por operación.
- Fixtures **sintéticos** con el encabezado real; servidor SUNAT falso para las pruebas.
- Prueba de contrato manual contra SUNAT: apagada por defecto, nunca en CI, solo lectura.

## Fuera de alcance
- Escritura (reemplazar, aceptar, registrar preliminar, eliminar): 032.
- Periodos habilitados (5.33), resúmenes, inconsistencias, CAR, casillas, no domiciliados, ajustes posteriores.
- Ampliar `FilaVentaSire` o las tablas de ventas con exportación, descuentos o IVAP (**P-2**; spec aparte si se elige).
- `SolPortal` real (buzones, PDT 621) y `XmlProvider` real.

## Hallazgos del layout real (Postman 2026-11-23; filas reales NO copiadas)
| Tema | Compras RCE (propuesta) | Ventas RVIE (propuesta) | Hoy en el repo (mock / formatos 012) |
|---|---|---|---|
| Nombre del TXT | `{RUC}-{AAAAMMDD}-{HHMM}-propuesta.txt` (fecha de generación) | `LE{RUC}{AAAAMM}00140400` + `01EXP2.txt`; el AAAAMM fue **202611** para el periodo 202510 (parece mes de generación) | `CONTAPP-PROVISIONAL-…` (012). **Nunca** deducir el periodo del nombre. |
| Columnas | 80 (incluye `Año` de DUA, DG/DGNG/DNG, `IMB`, `Incal`, `CLU1`–`CLU39`) | 40 (incluye exportación, descuentos, IVAP, FOB, gratuitas, `CLU`) | Mock: JSON ya mapeado. Provisional RCE 22 y RVIE 17 campos |
| Encabezado | 1.ª fila; `RUC`; `Apellidos Nombres/ Razón  Social` (doble espacio) | 1.ª fila con **BOM UTF-8**; `Ruc`, `Razon Social` sin tilde | sin encabezado (provisional) |
| Codificación / fin de línea | UTF-8 sin BOM, LF | UTF-8 con BOM, LF | provisional: latin1 y CRLF |
| Separador | `\|`; filas con `\|` final, encabezado sin él | igual | `\|` |
| Fechas | `dd/mm/aaaa` | `dd/mm/aaaa` | `AAAA-MM-DD` |
| Montos | siempre 2 decimales | sin formato fijo (`500`, `1837.5`, `1271.19`) | cadenas con 2 decimales |
| Tipo de cambio | `1.000` también en PEN | igual | solo en USD |
| Contribuyente | `RUC` y razón social propias en cada fila; la razón social **varía por fila** | igual | sin RUC propio |
| Contraparte | `Tipo Doc Identidad` + `Nro Doc Identidad` + razón social | igual; consumidor final sin confirmar | ventas: `-` = consumidor final |
| Sin equivalente en el modelo | `IMB`, `Año` DUA, CAR, detracción, doc. modificado, `CLU*` | exportación, `Dscto BI`, `Dscto IGV`, `BI Grav IVAP`, `IVAP`, FOB, gratuitas, rango final | — |

Muestra: solo facturas `01`, PEN, RUC. Sin notas de crédito, USD, boletas, rangos ni anulados: su forma real queda para la prueba de contrato (P-5).

## Criterios de aceptación
- [x] CA-1: `SIRE_CLIENT` ausente o `mock` → mocks (todas las pruebas de 009–026 siguen verdes); `http` → `HttpSireAuth` + `HttpSireApiClient`; otro valor → error de arranque que nombra la variable; con `NODE_ENV=production`, `http` no cuenta como mock.
- [x] CA-2: Token: POST `x-www-form-urlencoded` con los 6 campos; `expiraEn` = ahora + `expires_in`. 400/401 → `ErrorCredencial`; 5xx, 429, timeout o red → `ErrorTransitorio`; 200 sin `access_token` o `expires_in` inválido → `ErrorPortal`; `client_id` fuera de gramática → `ErrorCredencial` sin llamar.
- [x] CA-3: Propuesta de compras desde un ZIP sintético con el encabezado real → las `FilaPropuestaSire` esperadas: fecha `AAAA-MM-DD`, montos con 2 decimales vía `Money`, `tipoCambio` solo en USD, contraparte y razón social de la columna del proveedor (nunca la del contribuyente).
- [x] CA-4: Propuesta de ventas con BOM y montos `500` / `1837.5` → `FilaVentaSire` con `500.00` / `1837.50`; consumidor final según P-5.
- [x] CA-5: Encabezado por nombre normalizado (BOM, NFC, espacios, mayúsculas): columnas permutadas dan el mismo resultado; columnas extra se ignoran; columna requerida ausente o duplicada → error según P-1 con `detalle: "encabezado"`.
- [x] CA-6: Fila con `RUC` distinto al pedido o `Periodo` distinto al pedido → `ErrorDatos` `respuesta_ajena`, sin devolver filas. Monto con más de 2 decimales, separador de miles, exponente o fuera de NUMERIC(14,2), fecha imposible o moneda no soportada → `ErrorDatos` `fila_invalida`; nunca se redondea.
- [x] CA-7: Columnas sin equivalente con valor ≠ 0 → según P-2; nunca se pierden en silencio.
- [x] CA-8: Ticket: se busca por `numTicket` exacto (nunca `registros[0]`); estados 01/02/05 = pendiente; 04/06 = listo; 03 = `ErrorDatos`; otro = `ErrorPortal`. Ticket sin terminar dentro del presupuesto → comportamiento de P-4; el reintento retoma el mismo ticket sin exportar de nuevo y la clave incluye estudio y cliente.
- [x] CA-9: Varias partes en `archivoReporte` → se descargan todas, en orden; encabezados distintos entre partes → `ErrorPortal`. `nomArchivoReporte` fuera de gramática (`/`, `\`, `..`, controles) → `ErrorPortal` sin descargar; `codTipoAchivoReporte` o `codTipoArchivoReporte` `null` se envía como `null`.
- [x] CA-10: ZIP: más de 8 entradas o un número de entradas con datos distinto de UNA (se ignoran la carpeta y las entradas vacías, pero se validan TODOS los nombres: solo `[A-Za-z0-9._-]`, a lo sumo una carpeta, `.txt` exacto), entrada con datos que no es `.txt`, cifrado, corrupto, no contiguo, más de un EOCD, cabecera local ≠ central, deflate que no consume exactamente lo declarado, comprimido > 32 MiB, descomprimido > 64 MiB por parte o > 256 MiB acumulados entre partes (usuario, 2026-11-27) o razón > 200:1 → `ErrorPortal` `zip_invalido` sin superar ~2× el tope en memoria (prueba con bomba deflate). Se acepta el prefijo `PK\x07\x08` del ZIP real. Texto no UTF-8 válido → `ErrorPortal`.
- [x] CA-11: Errores de la API: 401 → la caché de 008 renueva el token una sola vez y luego `ErrorCredencial`; 403 → `ErrorCredencial`; 422 → `ErrorDatos`; 404 del archivo, 429, 5xx, timeout, `ECONNRESET` → `ErrorTransitorio`; 200 con cuerpo que no cumple el esquema → `ErrorPortal`; redirecciones no se siguen. Cada petición tiene timeout y la operación un presupuesto total. Excepción en la solicitud 5.51 del registro: 400/422 con `cod` 1070 → `sin_datos` (CA-13); con otro código (1026, 1061…) o cuerpo ilegible → `ErrorPortalSire` `solicitud_rechazada` (solo los `cod` numéricos, nunca `msg`), sin reintento.
- [x] CA-12: Secretos: con canarios en `client_secret`, clave SOL y token, ninguno aparece en `message`, `stack`, `JSON.stringify` del error, logs del worker, `resultado` del trabajo, eventos SSE ni en el almacén de tickets. El token solo viaja en `Authorization` a `api-sire.sunat.gob.pe`; los secretos, solo en el cuerpo a `api-seguridad.sunat.gob.pe`.
- [x] CA-13: Registro presentado (P-3): servicio 5.51 con `codProceso=70` fijo y `codMoneda=PEN` (obligatorio pero no filtra): UNA solicitud y un ticket por periodo (clave `…:compras:{per}:registro`) traen todas las monedas, cada fila con la suya; luego el mismo flujo y mapeo que la propuesta de compras; comprobante repetido → `ErrorPortal`. «Sin datos» (cod 1070 o TXT con solo encabezado) → `ErrorDatos` `sin_datos` (025 lo cuenta como periodo sin registro y sigue).
- [x] CA-14: 20.000 filas de compras sintéticas: parseo y mapeo en < 3 s (mediana de 5) sin pasar de 64 MiB descomprimidos.
- [x] CA-15: Prueba de contrato: excluida de `test`, `test:int` y CI (prueba que lo comprueba); corre solo con `--mode contrato` y `SIRE_CONTRATO=1`; solo hace el POST del token y GET; imprime solo formas (cantidad de columnas, si el encabezado coincide, estados vistos, tiempos), nunca valores. **Corrida real del usuario (2026-11-28, 2 RUC): favorable**: token 3600 s; propuestas con 80 y 40 columnas y encabezado igual al sintético; registro 5.51 con 80 columnas (solo difiere la col. 34, no mapeada) y ZIP de 3 entradas legible.
- [x] Casos reales aplicables: ninguno de dinero (el mapeo no calcula); la prueba de contrato validó notas de crédito, USD y boletas (P-5); notas de débito sin casos reales.

## Dependencias
- Specs: 008 (caché del token, reintentos), 009 (puertos y mocks), 013/014 (persistidores), 025 (historial). Ninguna migración.
- Externas: credenciales reales del usuario para la prueba de contrato (la corre él, en su máquina).

## Preguntas abiertas (recomendación entre corchetes)

**Decisión del usuario (2026-11-24): se aprueban P-1 a P-8 con la recomendación indicada.**
- **P-1 · Encabezado cambiado**: ¿`ErrorDatos` (como se pidió) o `ErrorPortal`? [`ErrorPortal` con `detalle: "encabezado"`: es justo «SUNAT cambió de forma», no reintenta y alimenta la alerta de RNF-044; con `ErrorDatos`, 025 tomaría cada periodo como «sin datos» y lo ocultaría.]
- **P-2 · Columnas sin equivalente ≠ 0** (exportación, descuentos, IVAP en ventas; `IMB` en compras; rango de boletas): (a) la descarga falla con `ErrorDatos` `columna_no_soportada` y se abre una spec para ampliar el modelo; (b) ampliar `FilaVentaSire` y las tablas de ventas aquí; (c) sumarlas a `otros`. [(a): no se pierde ni se reinterpreta un monto; (c) cambia el sentido tributario.]
- **P-3 · Registro presentado** (**resuelta** 2026-11-28 con la corrida real: 5.51, `codProceso` 70 fijo —00/01/02 dan 1026—, `codMoneda` obligatorio —1061 si falta— sin efecto de filtro; ver CA-13 y `plan.md` §P-3): los servicios 5.50 y 5.51 del manual de compras tienen la misma URL (`…/rce/ajustesposteriores/web/ajustesposteriores/{per}/solicitardescarga`) con `codProceso` 00/01/02, y el ejemplo usa `codProceso=70` («Descarga RCE», anexo I). Opciones: (a) 5.51 con `codProceso` 01 y luego 02; (b) 5.40 «exportar preliminar de registro de compras»; (c) dejar `descargarRegistroPresentado` en mock hasta probarlo con Postman. [(c) y añadir a Postman 5.51 y 5.40 para que el usuario los pruebe; se decide con la respuesta real.]
- **P-4 · Ticket que no termina**: (a) sondeo corto dentro del trabajo y, si no termina, `ErrorTransitorio` y se exporta de nuevo en el reintento; (b) re-encolado diferido con el ticket en BD; (c) sondeo corto (≤ 20 s, 0,5→4 s) y, si no termina, se guarda el ticket en Redis (TTL 1 h, clave por estudio, cliente, libro y periodo) y `ErrorTransitorio`: el reintento de 008 lo retoma. [(c): sin migración, reutiliza los reintentos y no regenera tickets.]
- **P-5 · Forma real sin muestra** (**resuelta** 2026-11-28 con datos reales de 2 RUC: NC con total negativo, USD con tipo de cambio, boletas sin documento → `-`; **notas de débito sin verificar**, no hubo casos): signo de las notas de crédito, consumidor final en ventas, anulados (`Est. Comp.`), rango de boletas, otras monedas. [Tomar los montos tal cual (los fixtures ya usan NC negativas), `-` cuando el documento venga vacío, y confirmar todo con la prueba de contrato sobre un periodo que los tenga antes de cerrar la spec.]
- **P-6 · Codificación** (**resuelta** 2026-11-28: 0 errores de codificación en la corrida real; basta UTF-8 estricto): ¿solo UTF-8 estricto? [Sí; otra codificación → `ErrorPortal`. Si la prueba de contrato ve latin1, se agrega.]
- **P-7 · Contratos de prueba**: ¿quién corre la prueba de contrato y con qué RUC? [El usuario, en su máquina, con su propio RUC y un periodo pasado; la salida (solo formas) se pega en `tasks.md`.]
- **P-8 · Presupuestos**: timeouts 10 s (token, exportar, ticket), 60 s (descarga), 90 s total por operación; topes de CA-10. [Aceptarlos; quedan como constantes del adaptador.]
