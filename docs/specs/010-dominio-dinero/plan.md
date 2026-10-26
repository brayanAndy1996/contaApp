# Plan 010 · Dominio de dinero

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/domain/` (`package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.mts`, `vitest.cobertura.config.mts`) | `@contapp/domain`, CJS a `dist/` como `@contapp/crypto`; única dependencia de producción `decimal.js` |
| crear | `packages/domain/src/dinero/{decimal,errores,moneda,money,monto-exacto,factor,tipo-cambio,redondeo,tolerancia,igv,cuadre,index}.ts` | valor `Money`, `MontoExacto`, `Factor`, `TipoCambio`, `redondearSunat`, IGV, cuadre genérico |
| crear | `packages/domain/src/comprobante/{columnas,montos-comprobante,cambiar-destino,mover-monto,convertir,index}.ts` · `src/index.ts` | `MontosComprobante` de compras, movimientos, conversión USD→PEN |
| crear | `packages/domain/src/{dinero,comprobante}/*.spec.ts` · `packages/domain/tests/casos-reales/dinero.spec.ts` | pruebas TDD (tester) y casos reales |
| crear | `tests/limites/dominio.spec.ts` | CA-1 (lint contra `number`) y CA-12 (lint de IO) con `ESLint#lintText` |
| modificar | `eslint.config.mjs`, `package.json` raíz, `.github/workflows/ci.yml`, `pnpm-lock.yaml` | reglas de dinero e IO en `packages/domain`, script `cobertura:dominio`, paso de CI |

## Contratos
`@contapp/domain` (reexporta `dinero/` y `comprobante/`; nunca exporta el constructor `Decimal` ni instancias de él). En los CA, `Money.desde(s)` abrevia `Money.desde(s, "PEN")`.
```ts
export type Moneda = "PEN" | "USD";
export class Money {                                   // congelado; valor en campo privado #d
  static desde(valor: string, moneda: Moneda): Money;  // ^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$ ; "-0", "-0.00" → "0.00"
  static desdeNumeric(valor: string, moneda: Moneda): Money; // misma gramática (salida de pg para NUMERIC(14,2))
  static desdeJSON(j: unknown): Money;                 // { monto: string, moneda } estricto, sin claves extra
  static cero(moneda: Moneda): Money;
  static suma(lista: readonly Money[], moneda: Moneda): Money;
  readonly moneda: Moneda;
  sumar(o: Money): Money; restar(o: Money): Money; negar(): Money; abs(): Money;
  por(f: Factor | TipoCambio): MontoExacto; entre(f: Factor): MontoExacto;   // sin redondear
  comparar(o: Money): -1 | 0 | 1; igual(o: Money): boolean; esCero(): boolean; esNegativo(): boolean;
  toString(): string;                                  // -?\d{1,12}\.\d{2}
  toJSON(): { monto: string; moneda: Moneda };
  [Symbol.toPrimitive](hint: string): string;          // lanza salvo hint "string": `a + b`, `a < b`, `+a` fallan
}
export class MontoExacto { static desde(valor: string, moneda: Moneda): MontoExacto; // hasta 12 enteros y 10 decimales (XML UBL)
  readonly moneda: Moneda; por(f: Factor | TipoCambio): MontoExacto; entre(f: Factor): MontoExacto;
  toString(): string; toJSON(): never }                // no se serializa sin redondear
export class Factor { static desde(s: string): Factor }          // ^(0|[1-9][0-9]{0,5})(\.[0-9]{1,10})?$ ; entre() exige > 0
export class TipoCambio { static desde(s: string): TipoCambio }  // ^(0|[1-9][0-9]{0,3})(\.[0-9]{1,3})?$ y > 0 (D7)
export function redondearSunat(x: MontoExacto): Money;           // D1; fuera de rango → MontoFueraDeRangoError
export type TasaIgv; export const TASA_IGV_18: TasaIgv, TASA_IGV_10: TasaIgv;  // marca nominal: solo estas dos
export class Tolerancia { static desde(s: string): Tolerancia }  // ≥ 0, ≤ 2 decimales
export const TOLERANCIA_CUADRE: Tolerancia /* 0.00 */, TOLERANCIA_IGV: Tolerancia /* 0.01 */;  // D2
export function igvEsperado(base: Money, tasa: TasaIgv): Money;  // redondearSunat(base × tasa)
export function igvCuadra(base: Money, igv: Money, tasa: TasaIgv, tol?: Tolerancia /* TOLERANCIA_IGV */): boolean;
export interface Cuadrable { readonly moneda: Moneda; readonly total: Money; componentes(): readonly Money[] }
export function verificarCuadre(c: Cuadrable, tol: Tolerancia):
  { cuadra: boolean; sumaComponentes: Money; total: Money; diferencia: Money };  // diferencia = total − suma
  // Ratificado en T16: si Σ o la diferencia exceden NUMERIC(14,2) lanza MontoFueraDeRangoError (CA-3), no
  // devuelve cuadra=false; quien solo necesita sí/no lo trata como "no cuadra" (igvCuadra, convertirAPen).
// Errores (cada uno con `codigo`): DineroError ← MontoInvalidoError, MontoFueraDeRangoError, MonedaDistintaError,
// FactorInvalidoError, MovimientoInvalidoError, ComprobanteDescuadradoError (R1b-5, opción A). Mensaje fijo;
// nunca incluye el valor recibido completo.

export type ColumnaCompra = "biDg" | "igvDg" | "biDgng" | "igvDgng" | "biDng" | "igvDng"
  | "noGravado" | "isc" | "icbper" | "otrosTributos";
export const COLUMNAS_COMPRA: readonly ColumnaCompra[];     // este orden es el de componentes()
export type Destino = "DG" | "DGNG" | "DNG";
export class MontosComprobante implements Cuadrable {       // congelado
  static desde(moneda: Moneda, v: Partial<Record<ColumnaCompra, string>> & { total: string }): MontosComprobante;
  // columna faltante = 0.00; clave desconocida → MontoInvalidoError
  obtener(c: ColumnaCompra): Money; sumar(o: MontosComprobante): MontosComprobante;  // por columna y total
  toJSON(): { moneda: Moneda; total: string; columnas: Record<ColumnaCompra, string> };
}
export function cambiarDestino(m: MontosComprobante, d: Destino): { montos: MontosComprobante; consolidados: Destino[] };
export function moverMonto(m: MontosComprobante, origen: ColumnaCompra, destino: ColumnaCompra, monto: Money): MontosComprobante;
export function convertirAPen(m: MontosComprobante /* USD */, tc: TipoCambio): MontosComprobante; // D7
// convertirAPen exige que m cuadre con TOLERANCIA_CUADRE (un desborde de Σ o de total − Σ cuenta como
// descuadre); si no, ComprobanteDescuadradoError antes que cualquier error de rango (R1b-5, opción A).
```
Comando: `pnpm cobertura:dominio` (raíz) = `pnpm --filter @contapp/domain test:cobertura`.

## Decisiones
- **Orden en el árbol compartido**: la implementación de 010 (T2–T17) va **antes** que la de 004. 004 solo commitea sus docs mientras 010 está en curso; nadie cambia de rama con el árbol de 010 a medio hacer. 010 y 004 tocan `eslint.config.mjs`, `package.json` raíz, `ci.yml` y `pnpm-lock.yaml`: 004 debe partir de 010 cerrada o resolver esos conflictos al integrar.
- **Estructura**: `@contapp/domain` como `@contapp/crypto` (CJS, `module node16`, `dist/`, `exports` `"."`). `tsconfig.json` (typecheck: `src` y `tests`) con `types: []` y `lib: ["ES2023"]`: sin tipos de Node ni DOM, así `process`, `Buffer` o `fetch` no compilan. `tsconfig.build.json` emite solo `src` sin `*.spec.ts`.
- **decimal.js aislado**: solo `dinero/decimal.ts` importa `decimal.js` y crea `const D = Decimal.clone({ defaults: true, precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -9e15, toExpPos: 9e15 })`. `defaults: true` es obligatorio: sin él, `clone` copia la configuración global vigente al cargar (si otro módulo ya llamó a `Decimal.set`, se heredaría). El redondeo SUNAT pasa la regla explícita (`toDecimalPlaces(2, D.ROUND_HALF_UP)`) y la salida usa `toFixed(2)` de decimal.js tras redondear, más la normalización de `-0.00`. `D` y las instancias `Decimal` viven en campos `#privados` y no salen de `dinero/`.
- **Precisión** (actualizada en T16 tras R1b-2): `Money` usa `D` (40 dígitos), suficiente porque solo suma y resta valores de ≤ 14 dígitos. `MontoExacto` se guarda como **fracción exacta** `num/den` (`den > 0`): `por` multiplica `num` y `entre` multiplica `den` con un segundo clon `DX` interno de `decimal.ts` (precisión máxima, `defaults: true`) usado solo para productos, restas y división entera, nunca para cocientes periódicos. `redondearSunat` aplica D1 al cociente exacto (división entera de `100·num` entre `den` y comparación de `2·|resto|` con `den`), así que un medio céntimo exacto tras `entre → por` nunca se pierde. Los 40 dígitos de `D` ya solo rigen `MontoExacto.toString()` (mostrar). La fracción **no se reduce por MCD**: cada `por`/`entre` añade como máximo los dígitos del factor (≤ 16 con `Factor`, ≤ 7 con `TipoCambio`). Las cadenas reales tienen 1–3 pasos (base × tasa, IGV ÷ tasa, × TC); R2a-2 prueba 600 pasos con factores de 16 dígitos, exacta y en < 3 s. Reducir por MCD (Euclides sobre `Decimal`) cuesta más que lo que ahorra en cadenas cortas; se reconsidera solo si una spec encadena `por`/`entre` en bucle sin redondear entre pasos (límite escrito en la spec, "Límites conocidos").
- **Marca de tipo** (T12/T14, ratificado en T16): los constructores exigen un `Symbol` de módulo (privados también en ejecución); las 6 clases validan sus argumentos con una marca privada `#campo in o` (no `instanceof`: no la engañan prototipos, Proxy ni `Symbol.hasInstance`), y las clases y sus prototipos están congelados. Consecuencia: debe existir una sola copia cargada de `@contapp/domain` (pnpm workspace); un `Money` de otra copia se rechaza.
- **Gramáticas estrictas (D5, D8)**: `typeof valor !== "string"` → `MontoInvalidoError` (cubre `number` disfrazado, `new String`, objetos con `toString`). Solo dígitos ASCII `[0-9]` (no `\d` con `u`), sin `+`, sin ceros a la izquierda, sin `.5` ni `5.`; longitud máxima comprobada antes del regex. El rango ±999 999 999 999.99 se comprueba en el único constructor privado de `Money`, por donde pasan todas las operaciones.
- **Inmutabilidad**: `Object.freeze(this)` en cada constructor; `MontosComprobante` guarda un registro congelado y `componentes()` devuelve un arreglo congelado nuevo.
- **Movimientos (D4, D6)**: `moverMonto` exige misma moneda, `origen ≠ destino`, monto ≠ 0, mismo signo que el saldo de origen y |monto| ≤ |saldo| (saldo 0 → siempre inválido); el total no se toca. `cambiarDestino(m, d)`: BI_d' = BI_DG + BI_DGNG + BI_DNG e IGV_d' = IGV_DG + IGV_DGNG + IGV_DNG (con signo); los BI/IGV de los otros dos destinos quedan en 0.00; no gravado, ISC, ICBPER, otros tributos, total y moneda no cambian. `consolidados` = los destinos ≠ `d` que tenían BI ≠ 0 o IGV ≠ 0, en orden DG, DGNG, DNG. No existe "destino actual" de una fila mixta: la regla es la misma aunque `d` ya tenga montos. Por tanto `consolidados = []` ⇔ los otros dos destinos ya estaban en 0.00, y entonces el resultado es igual en valor a `m` (nueva instancia congelada). Invariantes: ΣBI y ΣIGV de los tres destinos, Σ columnas y total se conservan exactamente (tolerancia 0.00); tras el cambio solo `d` puede ser ≠ 0; es idempotente (`cambiarDestino(cambiarDestino(m,d).montos, d).consolidados = []`).
- **Conversión (D7)**: `convertirAPen` exige USD; cada columna = `redondearSunat(columna × tc)`; total = suma de convertidos. El caso real queda **diferido** (spec, Pendientes): cuando lleguen las cifras, el tester lo agrega a `tests/casos-reales/` y, si contradice D7, se reabre con el usuario.
- **Lint de dinero (CA-1)**: en `packages/domain/src/{dinero,comprobante}/**` salvo `*.spec.ts`, `no-restricted-syntax` contra `TSNumberKeyword`, llamadas a `parseFloat`/`parseInt`/`Number`, `new Number`, miembros `toNumber`/`valueOf` llamados, `Math.*` y `+x` unario; en todo `packages/domain/src/**` salvo `dinero/decimal.ts` y `*.spec.ts`, `no-restricted-imports` de `decimal.js` y `no-restricted-properties` de `Decimal.set`/`Decimal.config` (las pruebas sí pueden, para CA-4). Se prueba como en 003: `tests/limites/dominio.spec.ts` con `ESLint#lintText` y rutas ficticias (`packages/domain/src/dinero/__prueba__.ts` falla; el mismo código en `…/__prueba__.spec.ts` pasa; `decimal.js` en `dinero/decimal.ts` pasa y en `comprobante/x.ts` falla). El "grep vacío" lo corre el tester en la verificación.
- **Lint de IO (CA-12)**: en `packages/domain/**`, `no-restricted-imports` de `node:*`, de los módulos de `builtinModules` (`node:module`) sin prefijo, `pg`, `drizzle-orm*`, `@nestjs/*`, `bullmq`, `ioredis`, `axios`, `undici`, `node-fetch` y `@contapp/{db,sunat,storage,queue,crypto}` (ya existe); `no-restricted-globals` de `process`, `Buffer`, `fetch`, `require`, `XMLHttpRequest`, `WebSocket`.
- **Cobertura (CA-12, DoD A)**: `packages/domain/vitest.cobertura.config.mts`, v8, `include` `src/dinero/**/*.ts` y `src/comprobante/**/*.ts`, `exclude` solo pruebas, `thresholds: { perFile: true, lines: 90, statements: 90, functions: 90, branches: 90 }`. Existe desde T3 (antes de implementar). En CI, job `ci` (sin BD): paso `pnpm cobertura:dominio`.
- **Propiedades (CA-6, CA-11)**: `fast-check` con semilla fija (`seed: 20261025`) y `numRuns ≥ 1000`; los generadores producen strings canónicos, nunca `number` convertidos.
- **Versiones**: `decimal.js` (dependencia) y `fast-check` (dev) exactas (`-E`), la última publicada hace ≥ 2 semanas (`pnpm view <pkg> time`); `vitest` y `@vitest/coverage-v8` 5.0.5.

## Riesgos
- D1 es una regla asumida (half-up) sin documento oficial a la vista: si SUNAT usa otra, cambia una función y CA-4; se detecta con el caso real USD o con un TXT rechazado.
- Caso real USD diferido: D7 podría no coincidir con lo que hace SUNAT o el video (p. ej., convertir el total directamente); CA-13 fija la regla elegida para que el cambio sea visible.
- El lint contra `number` es sintáctico: un valor numérico inferido sin anotación (p. ej., `.length`) no se detecta; lo compensan `Symbol.toPrimitive` (falla al operar `Money` como número), `types: []` y el adversario. Tras R2a-6 quedan abiertos tres límites (number por inferencia pura, `keyof string[]` en tipo condicional sin `infer`, clase `Decimal` filtrada desde un valor; este último cerrado por diseño de la API) y la regla es estricta: en `dinero/` y `comprobante/` prohíbe tipos indexados, `typeof` en tipos e `infer` (las uniones se escriben a mano). Solo cubre `dinero/` y `comprobante/`: una spec que maneje montos en otra carpeta de `packages/domain` (p. ej., reglas en 011) debe ampliar la lista `files` del bloque.
- Conflictos de integración con 004 en `eslint.config.mjs`, `package.json`, `ci.yml`, `pnpm-lock.yaml` y `docs/specs/ESTADO.md` (ambas ramas parten de `spec/003-cifrado`).
