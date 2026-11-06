# Plan 012 · Prevalidación SUNAT, formatos TXT versionados y ZIP

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/domain/src/texto/{codificar,entero}.ts` (+ export en `texto/index.ts`) | texto → bytes según la codificación del formato, sin `TextEncoder` (no está en `lib` ES2023) |
| crear | `packages/domain/src/formatos/{tipos,errores,registro,provisional-rce,campos,nombres,serializar,index}.ts` | registro versionado, versión provisional de compras, validación de campos, nombres, `generarTxt` |
| crear | `packages/domain/src/prevalidacion/{tipos,errores,entrada,estructura,aritmetica,duplicados,explicaciones,prevalidar,resumen,index}.ts` | `prevalidar`, `resumirCambios` |
| modificar | `packages/domain/src/index.ts` · `packages/domain/package.json` (`@contapp/shared: workspace:*`) | reexportar; `validarRuc` de shared (03 §2 lo permite; una sola verdad) |
| crear | `packages/domain/src/{formatos,prevalidacion}/*.spec.ts` · `src/texto/codificar.spec.ts` · `tests/ayudas/filas-reemplazo.ts` · `tests/casos-reales/prevalidacion.spec.ts` | TDD y casos reales |
| crear | `packages/sunat/src/formatos/{empaquetar,index}.ts` (+ export en `src/index.ts`) · `empaquetar.spec.ts` · `fixture-012.spec.ts` | ZIP en memoria y SHA-256; CA-1/CA-2 con el JSON real del fixture |
| modificar | `packages/sunat/package.json` (`fflate: 0.8.2` exacto, script `test:cobertura`) · crear `packages/sunat/vitest.cobertura.config.mts` | CA-11 en `src/formatos/**` |
| modificar | `eslint.config.mjs` (bloque «Dinero», `files`) · `packages/domain/vitest.cobertura.config.mts` (`include`) · `package.json` (`cobertura:dominio` construye shared; nuevo `cobertura:sunat`) · `.github/workflows/ci.yml` | lint contra `number` y cobertura 90 % por archivo |
| crear | `tests/limites/dominio-prevalidacion.spec.ts` | CA-11: lint de dinero e IO en las carpetas nuevas; backend sin `@contapp/sunat` |

Sin BD, migraciones, `apps/*` ni `withTenant` (D9). `texto/codificar.ts` queda fuera del lint de dinero (usa códigos de carácter, como `texto/`), pero dentro del de IO y de la cobertura.

## Contratos
`@contapp/domain` reexporta esto, congelado y con la marca privada `#campo in o` de 010 en las clases. Montos siempre `Money`/`MontosComprobante`.
```ts
// formatos/
type Libro = "compras";                                  // 013 agrega "ventas" (D15)
type Codificacion = "ascii" | "latin1" | "utf8";
interface CampoTxt { readonly nombre: string; readonly obligatorio: boolean; readonly longitudMax: Entero /* en caracteres */;
  readonly patron?: RegExp; readonly tipo: "texto" | "ruc" | "fecha" | "monto" | "tc" | "codigo" }
interface FormatoTxt { readonly id: string; readonly libro: Libro; readonly version: string; readonly vigenteDesde: string /* AAAAMM */;
  readonly oficial: boolean; readonly codificacion: Codificacion; readonly separador: string; readonly finDeLinea: "\r\n" | "\n";
  readonly campos: readonly CampoTxt[]; readonly incluyeExcluidas: boolean;           // provisional: false (D14)
  readonly nombre: (c: { ruc: string; periodo: string }) => { nombreTxt: string; nombreZip: string } }
class RegistroFormatos { static desde(f: readonly FormatoTxt[]): RegistroFormatos }   // id+versión únicos, vigenteDesde AAAAMM, campos coherentes
const REGISTRO_FORMATOS: RegistroFormatos;               // hoy solo RCE provisional, oficial: false, vigenteDesde 202601
function seleccionarFormato(libro: Libro, periodo: string, registro?: RegistroFormatos): FormatoTxt; // D5; FormatoNoVigenteError
interface CabeceraTxt { readonly rucDeclarante: string; readonly periodo: string; readonly libro: Libro }
function generarTxt(filas: readonly FilaReemplazo[], cabecera: CabeceraTxt,
  opciones?: { permitirProvisional?: boolean; registro?: RegistroFormatos }):
  { readonly bytes: Uint8Array; readonly nombreTxt: string; readonly nombreZip: string;
    readonly provisional: boolean; readonly lineas: Entero; readonly formato: { id: string; version: string } };
function validarNombreArchivo(nombre: string): boolean;  // D7; lo reusa sunat; nunca lanza
function validarCampo(valor: string, campo: CampoTxt, formato: FormatoTxt):  // nunca lanza; null = válido
  { readonly codigo: "CAMPO_OBLIGATORIO" | "LONGITUD" | "PATRON" | "CARACTER_NO_PERMITIDO" | "RUC_INVALIDO";
    readonly posicion: Entero | null /* índice UTF-16 desde 0 del primer carácter ofensor */ } | null;
// Errores (codigo, mensaje fijo sin valores): FormatosError ← FormatoNoVigenteError (FORMATO_NO_VIGENTE),
// FormatoProvisionalError (FORMATO_PROVISIONAL), ArchivoNoPrevalidadoError (ARCHIVO_NO_PREVALIDADO; `.resultado`
// lleva el ResultadoPrevalidacion), DefinicionFormatoInvalidaError (DEFINICION_FORMATO_INVALIDA),
// NombreArchivoInvalidoError (NOMBRE_ARCHIVO_INVALIDO).
// PrevalidacionError ← EntradaPrevalidacionInvalidaError: base exportada, como DineroError (010), ReglasError (011)
// y FormatosError, para que 012b capture cualquier error de prevalidación con un solo instanceof (precisión de T12).

// texto/
function codificar(texto: string, codificacion: Codificacion): Uint8Array;  // nuevo en cada llamada; nunca sustituye
// CaracterNoCodificableError (CARACTER_NO_CODIFICABLE): carácter fuera de la codificación, sustituto suelto,
// codificación desconocida o texto que no es string.

// prevalidacion/
type EstadoFila = "original" | "modificada" | "agregada" | "excluida";
interface FilaReemplazo { readonly id: string /* ^[A-Za-z0-9_-]{1,64}$ */; readonly estado: EstadoFila;
  readonly comprobante: IdComprobante; readonly proveedor: DocProveedor & { readonly razonSocial?: string };
  readonly fechaEmision: string /* AAAA-MM-DD */; readonly montos: MontosComprobante /* su moneda es la de la fila */;
  readonly tipoCambio: string | null /* obligatorio si USD; null si PEN */;
  readonly origenUsd: { readonly montos: MontosComprobante; readonly tipoCambio: string } | null /* solo si PEN */;
  readonly xml?: ResumenXml }
type CodigoError = "CAMPO_OBLIGATORIO" | "LONGITUD" | "PATRON" | "CARACTER_NO_PERMITIDO" | "RUC_INVALIDO" | "FECHA_INVALIDA"
  | "FECHA_POSTERIOR_AL_PERIODO" | "CUADRE" | "IGV" | "USD_SIN_TC" | "TC_INVALIDO" | "CONVERSION_USD" | "DUPLICADO" | "SIN_FILAS";
interface ErrorPrevalidacion { readonly filaId: string | null; readonly codigo: CodigoError; readonly campo: string | null;
  readonly destino: Destino | null; readonly explicacion: string; readonly diferencia: Money | null; readonly sugerencia: Hallazgo | null }
interface AvisoPrevalidacion { readonly filaId: string; readonly codigo: "R-ISC" | "R-NEW" | "R-GP"; readonly explicacion: string; readonly hallazgo: Hallazgo }
interface ResultadoPrevalidacion { readonly apto: boolean; readonly errores: readonly ErrorPrevalidacion[]; readonly avisos: readonly AvisoPrevalidacion[];
  readonly formato: { id: string; version: string; oficial: boolean } }
function prevalidar(filas: readonly FilaReemplazo[], contexto: { cabecera: CabeceraTxt; reglas?: ContextoReglas; registro?: RegistroFormatos }): ResultadoPrevalidacion;
interface ResumenCambios { readonly modificadas: Entero; readonly excluidas: Entero; readonly agregadas: Entero;
  readonly impactoIgv: { readonly DG: Money; readonly DGNG: Money; readonly DNG: Money; readonly total: Money } /* PEN */;
  readonly filasSinConvertir: readonly string[] }
function resumirCambios(original: readonly FilaReemplazo[], vigente: readonly FilaReemplazo[]): ResumenCambios;
// EntradaPrevalidacionInvalidaError (ENTRADA_INVALIDA): forma, no datos (ver Decisiones).
```
`@contapp/sunat` (desde `src/formatos/index.ts`): `empaquetar(txt: Uint8Array, nombres: { nombreTxt; nombreZip }, fecha: Date): { zip: Uint8Array; nombreZip; sha256Txt; sha256Zip }` (hex en minúsculas); `EmpaquetadoInvalidoError` (`EMPAQUETADO_INVALIDO`).

## Decisiones
- **Formato provisional RCE** (D10): `id "RCE-REEMPLAZO"`, `version "0-provisional"`, `oficial: false`, `latin1`, separador `|`, fin `\r\n` también en la última línea. Campos en orden: periodo, tipo, serie, número, fecha `DD/MM/AAAA`, tipo y número de documento del proveedor, razón social (opcional, ≤ 100), moneda, TC (`d.ddd` o vacío), las 10 columnas de `COLUMNAS_COMPRA`, total. Nombres: `CONTAPP-PROVISIONAL-{ruc}-{periodo}-RCE.txt` / `.zip`, inconfundibles con uno oficial. Es una herramienta de prueba del motor, no una propuesta de la estructura de SUNAT.
- **Caracteres** (D13): en texto se admiten U+0020–U+007E y U+00A1–U+00FF de `latin1`, menos el separador. Fuera quedan los controles C0 y C1, DEL, NBSP, saltos de línea, marcas combinantes, emojis y homoglifos. Sin NFC, `trim` ni transliteración. La explicación da el campo, la posición y el `U+XXXX`, nunca el carácter crudo. La longitud se mide en caracteres; en `latin1` coincide con los bytes.
- **Errores frente a excepciones**: un dato que el contador puede corregir (texto, serie, RUC, fecha, montos, TC) es un `ErrorPrevalidacion`. Una forma imposible es `EntradaPrevalidacionInvalidaError`: un tipo que no es string, `montos` sin marca de 010, claves extra, `__proto__`, ids repetidos, `estado` desconocido, `origenUsd` en una fila USD, o una cabecera mala. RUC del proveedor (tipo `6`) y del declarante con `validarRuc`.
- **Orden de prevalidar**: (1) entrada estricta; cada campo se lee una sola vez a una copia congelada, que es la que se valida y se serializa (contra getters y mutación posterior). (2) Formato con `seleccionarFormato`. (3) Por cada fila no excluida: estructura, fecha ≤ último día del periodo, TC (USD sin TC → `USD_SIN_TC`; `TipoCambio.desde` falla → `TC_INVALIDO`), cuadre con `verificarCuadre(TOLERANCIA_CUADRE)` y `diferencia = total − Σ`, IGV por destino con `igvCuadra` a 18 % y a 10 % (`TOLERANCIA_IGV`), y `origenUsd` contra `convertirAPen`. (4) Duplicados por tipo, serie en mayúsculas, número sin ceros a la izquierda y documento del proveedor; el error va en todas las copias. (5) Sin filas generables → `SIN_FILAS`. (6) Si hay `reglas`, `evaluarReglas` solo sobre las filas sin error de estructura: R-MIX se adjunta como sugerencia del error `IGV` del mismo destino, R-RED como sugerencia de `CUADRE`/`CONVERSION_USD`, y R-ISC, R-NEW y R-GP pasan a avisos. El bloqueo nunca depende de `reglas`: con o sin ellas salen los mismos errores (propiedad). Errores ordenados por fila (unidades de código), código y campo; `apto ⇔ errores = []`.
- **Explicaciones** (`explicaciones.ts`, catálogo fijo, cifras canónicas con signo): IGV `{igv} no es 18 % ni 10 % de {bi}` (mismo texto que R-MIX); cuadre `La suma de componentes ({suma}) no es igual al total ({total}): diferencia {dif}`; las demás con el campo y el límite.
- **generarTxt** (D4–D6): elige el formato, prevalida y, si no es apto, lanza `ArchivoNoPrevalidadoError` sin bytes. Con `oficial: false` y sin `permitirProvisional` lanza `FormatoProvisionalError`. Ordena por fecha, tipo, serie, número (como número), documento e id. Omite las excluidas si `incluyeExcluidas = false`. Montos con `Money.toString()` y TC con 3 decimales. Codifica con `texto/codificar`, que lanza si un carácter queda fuera, como segunda barrera. No acepta un formato suelto: así no se puede usar una versión no vigente.
- **resumirCambios** (D12, CA-8): empareja por `id`. Si un id original falta en el vigente, o una fila `agregada` trae un id del original, lanza `EntradaPrevalidacionInvalidaError`. `excluida` gana a `modificada`. Una fila modificada cuenta solo si cambió la identidad, el TC, `origenUsd` o algún monto (`Money.igual`). Impacto = Σ IGV de las vigentes no excluidas − Σ IGV de las originales, por destino, en PEN con `convertirAPen` por componente. Una fila USD sin TC válido no suma y va a `filasSinConvertir`.
- **empaquetar** (D6, D7): `fflate.zipSync` con una sola entrada, `mtime = fecha`, nivel 6 fijo y sin comentarios ni campos extra. Valida otra vez los dos nombres con `validarNombreArchivo` y que `nombreZip` sea el base de `nombreTxt` + `.zip`. SHA-256 con `node:crypto`. No toca el disco.
- **Lint y cobertura**: el bloque «Dinero» de `eslint.config.mjs` suma `src/prevalidacion/**` y `src/formatos/**` a `files`. Conteos y longitudes usan `type Entero = number`, declarado en `texto/entero.ts` (fuera del lint, igual que `texto/`) con el comentario «solo conteos y longitudes, nunca dinero». En las carpetas con lint no se escribe `number`. La cobertura suma `src/prevalidacion/**` y `src/formatos/**` en domain y `src/formatos/**` en sunat, con 90 % por archivo.
- **Pruebas**: fast-check con `SEMILLA` 20261025 y `NUM_RUNS` 1000 (`tests/ayudas/comprobante.ts`). Hay un oráculo de centavos enteros para el cuadre y el IGV, y una permutación de la entrada da los mismos bytes. `tests/ayudas/filas-reemplazo.ts` copia las cifras del fixture; `fixture-012.spec.ts`, en sunat, lee el JSON real (con `MockSireApiClient` o `node:fs`) y comprueba la misma conclusión.

### Ratificación de contratos (T6, 2026-11-06)
Las pruebas de T2–T5 quedan como contrato con estas precisiones. Las pruebas marcadas «T6» las agregó esta tarea; ninguna cambia un CA ni una D.
1. **IGV 0.00** (CA-1, D11): un IGV exactamente 0.00 nunca es error `IGV`, sea cual sea la base. BI 0.00 con IGV distinto de cero y los signos distintos sí lo son. Es la única lectura compatible con CA-1 (San Juan avisa con R-ISC y no bloquea) y con un bloqueo que no depende de `reglas`. Consecuencia: sin `reglas`, una base gravada con IGV 0.00 pasa sin aviso, así que 012b debe pasar siempre `reglas`. El riesgo residual queda como P-9 en `tasks.md` (T6).
2. **validarCampo** (`formatos/campos.ts`, exportada): firma de Contratos. Precedencia: vacío (`CAMPO_OBLIGATORIO`, o `null` si es opcional), luego, si el tipo es `ruc`, solo `validarRuc` (`RUC_INVALIDO`, que ya cubre largo y caracteres), luego `CARACTER_NO_PERMITIDO`, `LONGITUD` y `PATRON`. Un error por campo.
3. **Campos del provisional**: los 21 de `provisional.spec.ts`, con longitudes 6/2/4/8/10/1/15/100/3, `tipoCambio` 8 y montos 16 (NUMERIC(14,2) con signo). Patrones alineados con la gramática de 011, para que una fila sin error de estructura nunca haga lanzar a `evaluarReglas`: `tipoComprobante ^[0-9]{2}$`, `serie ^[0-9A-Za-z]{1,4}$`, `numero ^[0-9]{1,8}$`, `tipoDocProveedor ^[0-9A-Z]$` y `numeroDocProveedor ^[0-9A-Za-z-]{1,15}$`. El `campo` de cada error es el nombre del campo del formato, más `rucDeclarante` (cabecera) y `origenUsd` (`CONVERSION_USD` y el `TC_INVALIDO` del TC de origen).
4. **Línea del provisional**: `periodo|tipo|serie|numero|DD/MM/AAAA|tipoDoc|numDoc|razonSocial|moneda|TC|10 columnas|total` y CRLF, también en la última. El texto va tal como llega (número con sus ceros; razón social vacía si falta). El TC va vacío en PEN (también con `origenUsd`). En USD va el texto que aceptó `TipoCambio.desde`, completado con ceros a 3 decimales (`3` → `3.000`), como operación de texto. Montos con `Money.toString()`. Orden: fecha, tipo, serie (texto), número, tipo y número del documento, e id. El número se compara sin ceros a la izquierda, por largo y luego por texto, sin `number`.
5. **RegistroFormatos.desde** lanza `DefinicionFormatoInvalidaError` ante: entrada que no es arreglo o elemento que no es objeto; `id` o `version` vacíos, o el par repetido; `libro` desconocido; `vigenteDesde` fuera de `^[0-9]{4}(0[1-9]|1[0-2])$` (ASCII); `oficial` o `incluyeExcluidas` no booleanos; `nombre` que no es función; codificación o fin de línea desconocidos; separador que no es un solo carácter de U+0021–U+007E, o que es letra, dígito, `.`, `-` o `/` (aparecen en montos, fechas y TC); lista de campos vacía; nombre de campo vacío o repetido; `longitudMax` que no es entero ≥ 1; `tipo` desconocido; `patron` con bandera `g` o `y`; o `patron` que acepta el separador (`patron.test(separador)`). Copia y congela todo; cada `patron` se recrea con `new RegExp(source, flags)`.
6. **Nombres**: `validarNombreArchivo` nunca lanza y da `true` solo para las gramáticas de los formatos de `REGISTRO_FORMATOS` (hoy `^CONTAPP-PROVISIONAL-[0-9]{11}-[0-9]{4}(0[1-9]|1[0-2])-RCE\.(txt|zip)$`, ASCII). No mira el dígito verificador, que es cosa de `prevalidar`. Un registro de prueba no la amplía. `nombre()` del provisional lanza `NombreArchivoInvalidoError` con componentes malos. `generarTxt` comprueba además que lo que devuelve `formato.nombre` sea un nombre seguro (`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, sin `..`) y que `nombreZip` sea la base de `nombreTxt` más `.zip`. Si no, lanza `NombreArchivoInvalidoError`.
7. **Cabecera**: una forma mala lanza `EntradaPrevalidacionInvalidaError`: no es objeto, claves extra o ausentes, `__proto__`, valores que no son string, `libro` fuera de `Libro` o `periodo` mal formado. Un `rucDeclarante` string que `validarRuc` rechaza es el error `RUC_INVALIDO` con `filaId: null` y `campo: "rucDeclarante"`, y las filas se validan igual.
8. **TC**: solo `null` es «sin TC» (`USD_SIN_TC` en USD). Todo string que `TipoCambio.desde` rechaza, incluido `""`, es `TC_INVALIDO`. Una fila PEN con `tipoCambio` no nulo también es `TC_INVALIDO`: no se descarta en silencio (D13). Un `tipoCambio` que no es string ni `null` lanza.
9. **generarTxt**: `ArchivoNoPrevalidadoError.resultado` es el resultado congelado; el error no lleva `bytes` ni datos en el mensaje. Orden: entrada y cabecera, `seleccionarFormato` (`FormatoNoVigenteError`), `FormatoProvisionalError` (antes de prevalidar), `prevalidar` (`ArchivoNoPrevalidadoError`), y al final serializar y codificar.
10. **Qué se evalúa**: la forma se valida en todas las filas, también en las excluidas, y una forma imposible lanza. En las excluidas no se evalúa nada más. Un «error de estructura» es `CAMPO_OBLIGATORIO`, `LONGITUD`, `PATRON`, `CARACTER_NO_PERMITIDO` o `RUC_INVALIDO` en la fila; esas filas no pasan a `evaluarReglas`. Las que solo tienen errores de fecha, cuadre, IGV, TC o duplicado sí pasan, para traer la sugerencia. Los duplicados se buscan en todas las no excluidas, aunque tengan error de estructura, con la clave: tipo, serie en mayúsculas ASCII, número sin ceros a la izquierda, y tipo y número del documento. R-MIX va al error `IGV` de su destino. R-RED va al `CUADRE` de la fila o, si no lo hay, a su `CONVERSION_USD`. Un hallazgo sin su error se descarta: nunca bloquea ni avisa. Un `origenUsd` con montos USD descuadrados da `CONVERSION_USD` sin llamar a `convertirAPen`, que lanzaría. Si su TC es inválido, da `TC_INVALIDO` en `origenUsd` y no `CONVERSION_USD`. Hay una sola `CONVERSION_USD` por fila, y su explicación nombra la primera columna que difiere.
11. **Fecha y versión**: una fecha anterior al periodo (otro mes u otro año) es válida; solo se exige que no pase del último día del periodo. Un periodo sin versión vigente lanza `FormatoNoVigenteError` desde `seleccionarFormato`, `prevalidar` y `generarTxt`. Si se llama a `seleccionarFormato` directamente con un libro sin formatos, o con un periodo mal formado o que no es string, también lanza `FormatoNoVigenteError`, para mantener cerrada la lista de errores.
12. **Lectura única**: cada propiedad propia de la entrada (fila, comprobante, proveedor, `origenUsd` y cabecera) se lee exactamente una vez a una copia congelada. Los getters se admiten y se leen una vez. Lo que se valida y se serializa es la copia. `generarTxt` copia una sola vez y prevalida esa copia.
13. **resumirCambios** empareja por `id`. Las filas del original deben tener estado `original`. En el vigente: `excluida` suma a excluidas; `agregada` suma a agregadas y su id no puede estar en el original; `original` y `modificada` suman a modificadas si difieren, aunque digan `original`. Una vigente no agregada cuyo id falta en el original lanza: 014 quita una fila agregada que luego se descarta, no la marca `excluida`. «Difiere» quiere decir que cambia algún dato que va a la línea del TXT: comprobante y documento (literales), razón social, fecha, moneda y montos (`Money.igual`), el TC por valor (`3.3` = `3.300`; si alguno es inválido, por texto) u `origenUsd`. El `xml` no cuenta. El impacto se calcula en PEN; las USD pasan por `convertirAPen` por componente. Una USD con TC inválido o con montos descuadrados no suma, y su id va a `filasSinConvertir` (sin repetir, ordenado por unidades de código). Una vigente excluida no se evalúa, así que solo aparece si su original no convierte. `total = DG + DGNG + DNG`.
14. **empaquetar** se importa de `src/formatos/index.ts` (y de `@contapp/sunat`), y todo error es `EmpaquetadoInvalidoError`. El sello DOS lleva los campos UTC de `fecha`, para que el mismo instante dé los mismos bytes en cualquier huso horario (fflate usa la hora local). Una `fecha` fuera del rango 1980-01-01 a 2107-12-31 (UTC) lanza.
15. **Códigos y mensajes**: los códigos son los de Contratos y todos cumplen `^[A-Z_]+$`. Las excepciones llevan un mensaje fijo, sin valores de la entrada. La `explicacion` de un `ErrorPrevalidacion` sí lleva cifras canónicas de `Money`, nombres de campo, límites del formato, posiciones, `U+XXXX` y, en `DUPLICADO`, los ids de las otras copias. Nunca lleva texto de la fila tal como llegó: razón social, serie, número, documento, fecha o TC. Los errores se ordenan con `filaId: null` primero, y después por `filaId`, `codigo` y `campo` (`null` primero), en unidades de código.

## Riesgos
- La estructura oficial puede contradecir supuestos: que el orden de líneas sea libre, `latin1`, montos con punto o que las excluidas se omitan. Las reglas son declarativas y por versión. Agregar la oficial es agregar datos más su prueba contra el archivo de muestra (D10).
- Depender de `@contapp/shared` obliga a construir shared antes de probar domain. Si falta el `build` previo, la prueba falla al resolver el módulo, no en silencio. T1 lo agrega a los scripts.
- La salida de `fflate` depende de su versión: está fijada en 0.8.2 y CA-10 compara contra el TXT descomprimido, no contra bytes de ZIP guardados.
- Si la conversión USD de 010 (D7) difiere del caso real diferido, CA-4 sigue siendo sintético. Se detecta al agregar ese caso a `tests/casos-reales/`.
