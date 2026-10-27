# Plan 011 · Motor de reglas

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/domain/src/texto/{normalizar,diccionario,index}.ts` | tokens de glosa y diccionario de palabras clave (D-5); sin dinero |
| crear | `packages/domain/src/reglas/{tipos,errores,entrada,explicaciones,rango,r-isc,r-mix,r-red,r-new,r-gp,motor,aplicar,index}.ts` | contratos, validación de entrada, las 5 reglas, `evaluarReglas`, `aplicarSugerencia`, `aplicarMasivo` |
| modificar | `packages/domain/src/index.ts` | reexporta `reglas/` y `texto/` |
| crear | `packages/domain/src/{reglas,texto}/*.spec.ts` · `packages/domain/tests/casos-reales/reglas.spec.ts` · `packages/domain/tests/ayudas/filas.ts` | pruebas TDD (tester) y casos reales |
| crear | `tests/limites/dominio-reglas.spec.ts` | CA-13: lint contra `number` también en `reglas/` |
| modificar | `eslint.config.mjs` (bloque "Dinero", `files`) · `packages/domain/vitest.cobertura.config.mts` (`include`) | lint de dinero en `src/reglas/**`; cobertura 90 % por archivo de `src/reglas/**` y `src/texto/**` |

**No toca la BD**, ni migraciones, ni `apps/*`, ni dependencias nuevas. El comando `pnpm cobertura:dominio` y su paso de CI ya existen (010).

## Contratos
`@contapp/domain` reexporta lo siguiente; todo congelado, con la marca privada `#campo in o` de 010 en las clases. Montos siempre `Money`/`MontosComprobante` de 010.
```ts
// texto/
export function tokensDeGlosa(glosa: string): readonly string[];
  // NFKD → quita \p{M} → minúsculas → todo lo que no sea [a-z0-9.] separa; un punto final marca abreviatura ("zapat.").
  // Lineal en la longitud; sin regex con retroceso.
export interface EntradaDiccionario { readonly categoria: string; readonly palabras: readonly string[] }  // palabras en singular
export class DiccionarioGlosas {
  static desde(e: readonly EntradaDiccionario[]): DiccionarioGlosas;   // palabra vacía, con espacios o < 3 letras → error
  buscar(glosas: readonly string[]): Coincidencia | null;  // gana la primera glosa con coincidencia; dentro de ella, la primera palabra del diccionario
}
export interface Coincidencia { readonly palabra: string; readonly categoria: string }  // palabra en singular normalizado
export const DICCIONARIO_GLOSAS_BASE: DiccionarioGlosas;
  // calzado-ropa: zapatilla, zapato, polo, casaca, blusa, vestido · juguetes: juguete, peluche, muñeca
  // cuidado-personal: perfume, colonia, maquillaje, labial · entretenimiento: videojuego, cine

// reglas/
export type CodigoRegla = "R-ISC" | "R-MIX" | "R-RED" | "R-NEW" | "R-GP";
export const ORDEN_REGLAS: readonly CodigoRegla[];          // ese orden
export interface DocProveedor { readonly tipo: string; readonly numero: string }  // tipo ^[0-9A-Z]$; numero sin espacios ^[0-9A-Z-]{1,15}$ tras quitar espacios y pasar a mayúsculas
export interface IdComprobante { readonly tipo: string; readonly serie: string; readonly numero: string } // ^[0-9]{2}$ · ^[0-9A-Z]{1,4}$ · ^[0-9]{1,8}$ (ceros a la izquierda no cuentan)
export interface ResumenXml {                               // lo produce 016 (mock en 009)
  readonly proveedor: DocProveedor; readonly comprobante: IdComprobante; readonly moneda: Moneda;
  readonly gravado: Money; readonly igv: Money; readonly noGravado: Money;  // noGravado = exonerado + inafecto
  readonly isc: Money; readonly icbper: Money; readonly total: Money;
  readonly glosas: readonly string[];                       // descripción de cada ítem
}
export interface FilaEvaluable {
  readonly id: string;                                      // ^[A-Za-z0-9_-]{1,64}$, único en la llamada
  readonly proveedor: DocProveedor; readonly comprobante: IdComprobante;
  readonly montos: MontosComprobante;
  readonly origenUsd?: { readonly montos: MontosComprobante /* USD */; readonly tipoCambio: TipoCambio };  // solo si montos está en PEN
  readonly xml?: ResumenXml;
}
export interface ContextoReglas {
  readonly proveedoresConocidos: readonly DocProveedor[];   // historial del cliente (sin el periodo actual)
  readonly proveedoresIsc: readonly DocProveedor[];         // marca "emisor de ISC" (R1: dato del llamador; catálogo en R2)
  readonly diccionario: DiccionarioGlosas;
}
export type Sugerencia =
  | { tipo: "mover"; origen: ColumnaCompra; destino: ColumnaCompra; monto: Money }                    // R-ISC
  | { tipo: "separar"; columnaBi: ColumnaCompra; min: Money; max: Money; estimado: Money; exacto: Money | null } // R-MIX: gravado; el resto a noGravado
  | { tipo: "ajustar"; valores: Readonly<Partial<Record<ColumnaCompra | "total", Money>>> }          // R-RED: valores nuevos
  | { tipo: "clasificar" }                                                                            // R-NEW: pide Destino
  | { tipo: "excluir"; palabra: string; categoria: string };                                         // R-GP
export interface Hallazgo {
  readonly filaId: string; readonly regla: CodigoRegla; readonly destino: Destino | null;
  readonly explicacion: string;               // catálogo fijo de explicaciones.ts con cifras canónicas; nunca texto del XML salvo la palabra del diccionario
  readonly sugerencia: Sugerencia | null;     // null = solo aviso (rango vacío, descuadre grande, XML sin ISC…)
  readonly requiereConfirmacion: boolean;     // true si no la respalda el XML
  readonly dato: "gravado" | "destino" | null; // lo que aplicar necesita del contador
  readonly lecturas: Readonly<Partial<Record<ColumnaCompra | "total", Money>>>; // columnas leídas, para detectar obsolescencia
}
export interface Aviso { readonly filaId: string; readonly codigo: "XML_AJENO" | "XML_MONEDA"; readonly explicacion: string }
export function evaluarReglas(filas: readonly FilaEvaluable[], ctx: ContextoReglas):
  { readonly hallazgos: readonly Hallazgo[]; readonly avisos: readonly Aviso[] };
  // orden: id de fila (comparación por unidades de código, sin locale) → ORDEN_REGLAS → DG, DGNG, DNG
export type Confirmacion = { gravado: Money } | { destino: Destino };
export function aplicarSugerencia(montos: MontosComprobante, h: Hallazgo, c?: Confirmacion):
  { readonly montos: MontosComprobante; readonly excluir: boolean };
export function aplicarMasivo(entradas: readonly { montos: MontosComprobante; hallazgo: Hallazgo; confirmacion?: Confirmacion }[]):
  { readonly aplicadas: readonly { filaId: string; montos: MontosComprobante; excluir: boolean }[];
    readonly rechazadas: readonly { filaId: string; regla: CodigoRegla; codigo: string }[] };
// Errores (con `codigo`, mensaje fijo sin valores): ReglasError ← EntradaReglasInvalidaError (ENTRADA_INVALIDA),
// SugerenciaObsoletaError (SUGERENCIA_OBSOLETA), ConfirmacionInvalidaError (CONFIRMACION_INVALIDA).
// Los errores de 010 se propagan sin envolver. Separar: siempre min ≤ max numéricamente (ver Ratificación).
```

## Decisiones
- **Evaluación por destino** (CA-5): para cada destino con BI ≠ 0 o IGV ≠ 0: IGV = 0 → R-ISC; IGV ≠ 0 y `igvCuadra` falso a 18 % y a 10 % (`TOLERANCIA_IGV`) → R-MIX; si no, nada. Destino en 0.00/0.00 se ignora. R-RED, R-NEW, R-GP son por fila. Signo: se trabaja con `abs()` y se reaplica el signo de la BI (D6 de 010); BI e IGV de signo distinto → R-MIX sin sugerencia.
- **R-ISC** (D-1, D-2): sin XML → `mover` toda la BI del destino a `isc`, `requiereConfirmacion`. Con XML: si `xml.isc` ≠ 0, mueve `xml.isc − montos.isc` desde la BI del único destino con BI ≠ 0 (≤ |BI|, mismo signo); si hay varios destinos o no cabe, sin sugerencia. XML con ISC 0 → aviso "XML sin ISC: revisar" sin sugerencia. Proveedor en `proveedoresIsc` con IGV ≠ 0 que cuadra: sin XML hallazgo sin sugerencia; con XML, la misma regla de arriba. Explicación con XML: "Base gravada con IGV 0: el XML indica ISC".
- **Rango de R-MIX** (D-3, D-7, CA-4) en `rango.ts`: estimado `e = redondearSunat(|IGV|.entre(TASA_IGV_18))`; se avanza de 0.01 en 0.01 hacia arriba y hacia abajo desde `e` mientras `igvEsperado(g) = |IGV|` (vecindad acotada: a lo sumo 12 pasos por lado, porque el ancho es ≤ 0.01/0.10). Luego se recorta a [0.01, |BI|]; vacío → sin sugerencia. El estimado se acota al rango. Sin `number`: solo API de 010. Con XML y un solo destino con BI ≠ 0: `exacto = xml.gravado` si `xml.igv = IGV`, monedas iguales y el gravado cae en el rango a 18 % o, si no, en el rango a 10 % calculado igual (D-7: el 10 % solo con XML); si no, `exacto = null` y la explicación lo dice. Aplicar: `moverMonto(columnaBi → noGravado, |BI| − gravado)` con signo.
- **R-RED** (D-6): `verificarCuadre(montos, TOLERANCIA_CUADRE)`; si no cuadra y |dif| ≤ 0.01 × (columnas ≠ 0, mínimo 1) → `ajustar { total: Σ }`. Con XML de igual moneda y `xml.total = total`: si exactamente un grupo (ΣBI↔gravado, ΣIGV↔igv, noGravado, isc, icbper) difiere en exactamente `dif` y cae en una sola columna, `ajustar` esa columna; si no, sin sugerencia. Con `origenUsd`: `convertirAPen(origen, tc)` es lo esperado; si alguna columna o el total difiere → `ajustar` con todas las columnas que difieren (exacta, sin confirmación); si el origen no cuadra (`ComprobanteDescuadradoError`) → R-RED sin sugerencia. `MontoFueraDeRangoError` de `verificarCuadre` → R-RED sin sugerencia (no lanza).
- **R-NEW**: clave `tipo + ":" + numero` normalizada; se compara con `proveedoresConocidos` en un `Map` construido dentro (nunca objetos literales como diccionario: `__proto__`). Sugerencia `clasificar`, `dato: "destino"`; aplicar = `cambiarDestino(m, destino).montos`.
- **R-GP** (D-5): `ctx.diccionario.buscar(xml.glosas)` si hay XML; coincidencia = token igual a la palabra, o igual quitando una `s`/`es` final, o token abreviado (con punto, ≥ 4 letras) que es prefijo de la palabra. Sin XML no se evalúa. Aplicar devuelve `{ montos: igual, excluir: true }`.
- **XML ajeno** (CA-11): si proveedor o comprobante del XML (normalizados) no coinciden con la fila → `Aviso XML_AJENO` y la fila se evalúa como sin XML; moneda distinta → `XML_MONEDA`, igual.
- **Obsolescencia** (CA-9): `lecturas` guarda las columnas que la regla leyó (R-ISC: BI e IGV del destino; R-MIX: BI e IGV del destino; R-RED: todas y total; R-NEW y R-GP: ninguna). `aplicarSugerencia` compara esas columnas con los montos actuales; si alguna cambió → `SugerenciaObsoletaError`. Así dos R-ISC de la misma fila (DG y DGNG) se aplican seguidas. `aplicarMasivo` aplica en el orden recibido y encadena por `filaId` (la segunda usa los montos de la primera); un error de una entrada va a `rechazadas` con su `codigo` y no detiene el lote. R-MIX sin `exacto` necesita `{ gravado }` dentro de [min, max]; en masivo, sin confirmación se rechaza con `requiere_dato` (nunca se aplica el estimado en lote).
- **Entrada estricta**: `evaluarReglas` valida forma y gramáticas (`EntradaReglasInvalidaError`): ids repetidos, `montos` que no es `MontosComprobante` real (marca de 010), `origenUsd` con `montos` no PEN, claves extra. No muta ni congela lo que recibe; devuelve objetos nuevos congelados.
- **Lint y cobertura**: el bloque "Dinero" de `eslint.config.mjs` agrega `packages/domain/src/reglas/**` a `files` (nota [011/013]); `texto/` queda fuera (usa índices) pero no importa `dinero/`. Cobertura: `include` agrega `src/reglas/**/*.ts` y `src/texto/**/*.ts`, mismo umbral `perFile` 90.
- **Ratificación de contratos (arquitecto, 2026-10-27, tras las pruebas en rojo T2–T6)**:
  - *R-RED, precedencia y lectura de D-6*: el umbral 0.01 × componentes solo limita el ajuste del **total sin respaldo**. Orden: (1) `origenUsd` presente → manda la conversión (dispara aunque la fila PEN cuadre sola; `ajustar` con las columnas que difieren y `total`; `requiereConfirmacion = false`); (2) XML válido (misma identidad y moneda) y la fila no cuadra → si `xml.total = total` y un solo grupo difiere en exactamente `dif` y cae en una columna, `ajustar` esa columna **sin umbral** (el XML respalda el monto); si `xml.total ≠ total` y `Σ = xml.total`, `ajustar { total: Σ }`; si no, sin sugerencia; el umbral no se aplica con XML válido; ambas con `requiereConfirmacion = false`; (3) sin respaldo → umbral, `requiereConfirmacion = true`. XML ajeno o de otra moneda = sin XML (más su aviso).
  - *Rango de R-MIX en notas de crédito*: `min ≤ max` numéricamente siempre (`min.comparar(max) ≤ 0`): −21.48/−1.61 da `min` −8.97, `max` −8.92, `estimado` −8.94. La confirmación se valida con ese orden. `min/max/estimado` describen siempre la estimación a 18 % (D-7); si `exacto` sale del rango a 10 % (BI 80.00/IGV 5.00 con XML 50.00 → rango 27.75–27.80, exacto 50.00), manda `exacto` y `exacto` puede quedar fuera de [min, max].
  - *Explicaciones* (catálogo fijo en `explicaciones.ts`; `{x}` = `toString()` canónico con signo): R-ISC sin XML `Base gravada {bi} con IGV 0: posible ISC`; con XML exacto `Base gravada con IGV 0: el XML indica ISC` (texto exacto); XML con ISC 0 `Base gravada {bi} con IGV 0. XML sin ISC: revisar`; ISC del XML que no cabe o varios destinos `Base gravada {bi} con IGV 0: el ISC del XML ({isc}) no cabe en un solo destino: revisar`; marca sin XML `Proveedor emisor de ISC: revisar con el XML`; marca con XML `Proveedor emisor de ISC: el XML indica ISC {isc}`. R-MIX `{igv} no es 18 % ni 10 % de {bi}` y, como sufijo: exacto `; el XML indica gravado {g}`; gravado del XML fuera de rango `; el gravado del XML ({g}) no produce ese IGV: confirma el monto`; IGV del XML distinto `; el IGV del XML ({igvXml}) es distinto: confirma el monto`; rango vacío ` y no se puede separar: revisar`. R-RED `La suma de componentes ({suma}) no es igual al total ({total}): diferencia {total − suma}` (+ `; el XML indica el monto correcto` si lo respalda el XML); con `origenUsd` `Los montos en PEN no coinciden con la conversión por componente con TC {tc}`. R-NEW `Proveedor nuevo: elige la clasificación`. R-GP `Posible gasto personal: la glosa dice "{palabra}"`. Avisos: `El XML no corresponde a este comprobante` / `El XML está en otra moneda que la fila`. Nunca texto del XML salvo la palabra del diccionario.
  - *Orden*: hallazgos por id (unidades de código) → `ORDEN_REGLAS` → DG, DGNG, DNG; avisos por id.
  - *Aplicar*: hallazgo sin sugerencia, falsificado o con `lecturas` que no son `Money` reales → `EntradaReglasInvalidaError`. `aplicarMasivo`: si el hallazgo tiene `dato ≠ null` y la entrada no trae confirmación → rechazo `requiere_dato` (sin llamar a `aplicarSugerencia`); cualquier otro `ReglasError` o `DineroError` → rechazo con su `codigo` (el mismo que lanzaría `aplicarSugerencia`); otro tipo de error se propaga (es un defecto, no un rechazo).
  - *Contexto estricto*: `ContextoReglas` sin claves extra ni `__proto__` propio, arreglos de `DocProveedor` válidos y `diccionario` real (marca de `DiccionarioGlosas`); si no, `EntradaReglasInvalidaError` y no hay resultados parciales.
  - *texto/*: `tokensDeGlosa` y `DiccionarioGlosas` como los fijó T3 y los implementó T8 (palabras en singular normalizado, ≥ 3 letras; abreviatura con punto y ≥ 4 letras; `Coincidencia` exportado; `DICCIONARIO_GLOSAS_BASE` congelado).
  - *Stubs del tester*: `reglas/{tipos,errores,motor,aplicar,index}.ts` (T4) son provisionales; T9 reemplaza `tipos`, `errores` (conservando nombres y `codigo`), `motor` y `aplicar`; T10 completa `motor`, `aplicar` e `index`. `texto/index.ts` ya lo dejó T8.
- **Cambios de T13 (ronda adversarial 1), pendientes de ratificación del arquitecto en T17**:
  - *Lecturas de R-ISC* (R1b-1): cuando se usa el ISC del XML (`xml.isc ≠ 0`), además de BI e IGV del destino lee `isc` y las BI de los otros dos destinos (el monto es `xml.isc − isc` y exige "único destino con BI ≠ 0"). Sin XML siguen siendo solo BI e IGV del destino (dos R-ISC seguidas DG y DGNG siguen valiendo).
  - *Aplicar no cree la sugerencia* (R1b-2 a R1b-4): `mover` solo desde la BI del destino del hallazgo hacia `isc`; sin `isc` en lecturas, IGV 0, monto = toda la BI y `requiereConfirmacion`; con `isc`, monto ≠ 0 del signo de la BI, ≤ |BI|, otras BI en 0 y sin confirmación. `separar`: `columnaBi` = BI del destino; `min`/`max`/`estimado` = `rangoGravado` a 18 % de las lecturas; `exacto` ≠ null solo con `dato` null, sin confirmación y dentro del rango a 18 % o a 10 %; `exacto` null exige `dato: "gravado"` y confirmación. R-RED, R-NEW y R-GP sin destino; `dato` de R-ISC, R-RED y R-GP null y de R-NEW `"destino"`. Forma incoherente → `EntradaReglasInvalidaError`; falta una lectura que la regla lee (R-ISC/R-MIX: BI e IGV del destino, más lo de arriba; R-RED: todas y total) → `SugerenciaObsoletaError`.
  - *Serie* (R1b-5, decisión del usuario): se recibe `^[0-9A-Za-z]{1,4}$` y se compara en mayúsculas; serie del XML fuera de gramática → `XML_AJENO` sin abortar el lote (la de la fila sigue siendo `EntradaReglasInvalidaError`).
  - *texto/* (R1b-6, decisión del usuario): un punto seguido de una letra cierra el token (`"zapat.dep."` → `zapat.`, `dep.`; `"1.50"` se conserva); un token con punto final coincide como abreviatura (≥ 4 letras, prefijo) o como palabra completa o su plural (`"zapatillas."`).
- **Cambios de T15 (ronda adversarial 2), pendientes de ratificación del arquitecto en T17**:
  - *Aplicar re-evalúa* (R2a-1, R2a-2, R2a-3 = R2b-1): firma nueva con **entorno obligatorio** (T15b): `aplicarSugerencia(montos, hallazgo, confirmacion | undefined, entorno)` y `aplicarMasivo(entradas, entorno)`, con `EntornoEvaluacion = { filas: FilaEvaluable[]; contexto: ContextoReglas }` (lo mismo que recibió `evaluarReglas`, XML incluido). Sin entorno o con uno inválido → `EntradaReglasInvalidaError` (en masivo aborta la llamada). La fila del hallazgo (por `filaId`; ausente → `EntradaReglasInvalidaError`) se re-evalúa con los montos actuales (en masivo, los encadenados) y solo se aplica si sale el mismo hallazgo para esa regla y destino (explicación, sugerencia, confirmación, dato y lecturas); si no, o si cambió la moneda, `SugerenciaObsoletaError`. La confirmación de R-MIX se valida contra el rango recalculado. Se mantienen las validaciones de forma del hallazgo y los montos; las comprobaciones de lecturas, vigencia y coherencia de T13/T15 sin entorno se retiraron (la re-evaluación las cubre). **Nota para 014**: pasar siempre filas, contexto y XML (los mismos que en la evaluación).
  - *Lecturas de R-MIX con XML* (R2a-3 = R2b-1): con XML también lee las BI de los otros destinos (el exacto exige "único destino con BI ≠ 0"); sin XML siguen siendo BI e IGV del destino.
  - *Identidad del XML* (R2a-4 = R2b-3, R2b-2; CA-11 y decisión del usuario sobre R1b-6): tipo, serie o número de comprobante y tipo o número de documento del XML fuera de gramática o de más de 64 caracteres → `XML_AJENO` sin abortar el lote. Un campo que no es string sigue siendo `EntradaReglasInvalidaError`; en la fila y el contexto no cambia nada.
  - *texto/* (R2a-5 = R2b-4 + R2b-5; decisión del usuario sobre R1b-7): un punto después de una letra cierra el token y se conserva (también ante dígitos: `"zapatillas.38"` → `zapatillas.`, `38`); el punto entre dos dígitos se conserva (`"1.50"`); cualquier otro punto separa (repetidos y `"…"`: `"zapat... dep"` → `zapat.`, `dep`).
- **Propiedades**: fast-check con `SEMILLA` 20261025 y `NUM_RUNS` 1000 de `tests/ayudas/comprobante.ts`; oráculo del rango con centavos enteros (independiente de la implementación).

## Riesgos
- Fila PEN con `origenUsd` cuyo XML viene en USD: hoy da `XML_MONEDA` y se evalúa sin XML (R-RED con `origenUsd` sí cubre el redondeo). Comparar ese XML con `origenUsd` queda para 014/016 si el caso aparece.
- R-RED con `origenUsd` asume D7 de 010 (conversión por componente); el caso real USD sigue diferido y podría contradecirla: se detecta al agregarlo en `tests/casos-reales/`.
- R-GP da falsos positivos ("zapatilla de seguridad" en una ferretería, "polo a tierra") y no detecta homoglifos: solo sugiere; el puntaje con giro e historial (R2) los reduce. Límite a escribir en la spec al cerrar.
- Reglas cruzadas: aplicar una sugerencia puede volver obsoletas otras de la misma fila; 014 debe re-evaluar la fila tras cada aplicación (contrato con 014).
- El lint de `number` en `reglas/` hereda los tres límites aceptados en 010 (D10).
