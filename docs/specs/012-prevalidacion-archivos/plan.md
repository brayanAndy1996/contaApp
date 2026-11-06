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
function validarNombreArchivo(nombre: string): boolean;  // D7; lo reusa sunat
// Errores (codigo, mensaje fijo sin valores): FormatosError ← FormatoNoVigenteError, FormatoProvisionalError,
// ArchivoNoPrevalidadoError (lleva el ResultadoPrevalidacion), DefinicionFormatoInvalidaError, NombreArchivoInvalidoError.

// prevalidacion/
type EstadoFila = "original" | "modificada" | "agregada" | "excluida";
interface FilaReemplazo { readonly id: string /* ^[A-Za-z0-9_-]{1,64}$ */; readonly estado: EstadoFila;
  readonly comprobante: IdComprobante; readonly proveedor: DocProveedor & { readonly razonSocial?: string };
  readonly fechaEmision: string /* AAAA-MM-DD */; readonly montos: MontosComprobante /* su moneda es la de la fila */;
  readonly tipoCambio: string | null /* obligatorio si USD */;
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
`@contapp/sunat`: `empaquetar(txt: Uint8Array, nombres: { nombreTxt; nombreZip }, fecha: Date): { zip: Uint8Array; nombreZip; sha256Txt; sha256Zip }` (hex en minúsculas); `EmpaquetadoInvalidoError`.

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

## Riesgos
- La estructura oficial puede contradecir supuestos: que el orden de líneas sea libre, `latin1`, montos con punto o que las excluidas se omitan. Las reglas son declarativas y por versión. Agregar la oficial es agregar datos más su prueba contra el archivo de muestra (D10).
- Depender de `@contapp/shared` obliga a construir shared antes de probar domain. Si falta el `build` previo, la prueba falla al resolver el módulo, no en silencio. T1 lo agrega a los scripts.
- La salida de `fflate` depende de su versión: está fijada en 0.8.2 y CA-10 compara contra el TXT descomprimido, no contra bytes de ZIP guardados.
- Si la conversión USD de 010 (D7) difiere del caso real diferido, CA-4 sigue siendo sintético. Se detecta al agregar ese caso a `tests/casos-reales/`.
