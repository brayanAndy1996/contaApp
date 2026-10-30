# 08 · Dinero y dominio: montos exactos y el motor de reglas

> Módulo anterior: [07-seguridad-cifrado-y-sesiones.md](07-seguridad-cifrado-y-sesiones.md) · Siguiente: [09-pruebas-y-calidad.md](09-pruebas-y-calidad.md) · Índice: [00-indice.md](00-indice.md)

## Lo que aprenderás

- Por qué en JavaScript `0.1 + 0.2 !== 0.3`, y por qué eso es inaceptable en un registro de compras.
- Qué es `decimal.js` y cómo ContApp lo encierra dentro de `Money`, `MontoExacto`, `Factor`, `TipoCambio` y `Tolerancia`.
- Cómo redondea ContApp (regla SUNAT: *half-up* a 2 decimales) y cuándo lo hace.
- Cómo se mueve un monto entre columnas sin descuadrar el comprobante.
- El lint que prohíbe `number` en el dominio del dinero.
- El motor de reglas (R-ISC, R-MIX, R-RED, R-NEW) explicado como lo haría un contador.
- Por qué el dominio es "puro, sin IO" y cómo eso hace fácil probarlo.

---

## 1. El problema: la computadora no sabe contar céntimos

Abre una terminal y prueba:

```bash
node -e 'console.log(0.1 + 0.2, 0.1 + 0.2 === 0.3, (1.005).toFixed(2), 8.94 * 0.18)'
# 0.30000000000000004 false 1.00 1.6091999999999997
```

El tipo `number` de JavaScript es **punto flotante binario** (IEEE 754). Guarda los números en base 2, y en base 2 el `0.1` es periódico, igual que `1/3 = 0.3333…` en base 10. Se guarda una aproximación, y al sumar aproximaciones el error asoma.

- `(1.005).toFixed(2)` da `"1.00"`, no `"1.01"`: internamente `1.005` es `1.00499999…`.
- Un IGV calculado como `8.94 * 0.18` da `1.6091999…`; según cómo redondees puede salir `1.61` o, con otro número, un céntimo menos.

Un céntimo de diferencia en el IGV es la diferencia entre un comprobante que cuadra y uno que SUNAT observa. Multiplicado por miles de filas al mes, es un estudio que pierde la confianza en el sistema.

## 2. La solución: decimales exactos

`decimal.js` representa números en **base 10** con la precisión que pidas: `0.1 + 0.2` es exactamente `0.3`. ContApp no lo usa suelto: lo encierra en un solo archivo, `packages/domain/src/dinero/decimal.ts:16-22`:

```ts
export const D = Decimal.clone({
  defaults: true,          // ignora cualquier Decimal.set global de otra librería
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,          // nunca notación científica (1e-7)
});
```

`Decimal.clone` crea una copia privada de la configuración: si otra librería cambia la configuración global, el dinero de ContApp no se entera. Y `D` nunca sale de la carpeta `dinero/` (`dinero/index.ts` no la exporta).

En la base de datos los montos van como `NUMERIC(14,2)` (convención de `docs/03-arquitectura.md`, sección de modelo de datos): exacto, 12 enteros y 2 decimales, rango ±999 999 999 999.99. PostgreSQL lo devuelve como **texto** y `Money.desdeNumeric` lo lee sin pasar nunca por `number`. Las tablas con montos (compras, ventas) llegan en specs posteriores; el contrato ya está listo.

## 3. Los tipos del dinero

Como en un plan contable, cada tipo tiene su propósito y no se mezclan:

| Tipo | Qué representa | Ejemplo | Archivo |
|---|---|---|---|
| `Money` | Un monto **final**, 2 decimales, con moneda PEN/USD | `"118.00"` PEN | `dinero/money.ts` |
| `MontoExacto` | Un resultado **intermedio** sin redondear (producto, división, importe del XML) | `1.6092` | `dinero/monto-exacto.ts` |
| `Factor` | Una tasa o multiplicador sin signo (hasta 10 decimales) | `0.18` | `dinero/factor.ts` |
| `TipoCambio` | TC > 0 con hasta 3 decimales | `3.745` | `dinero/tipo-cambio.ts` |
| `Tolerancia` | Cuánto se permite que algo no cuadre | `0.01` | `dinero/tolerancia.ts` |

### `Money`: solo nace de texto

`packages/domain/src/dinero/money.ts:14` define la gramática aceptada:

```ts
const GRAMATICA_MONTO = /^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;
```

Y el constructor es privado (`money.ts:50-58`): solo se crea con `Money.desde("118.00", "PEN")`. `Money.desde(0.1, "PEN")` lanza `MontoInvalidoError`: un `number` ya podría venir contaminado. Tampoco se acepta `"1,5"`, `"1e2"`, `"+5"`, `"007"` ni más de 2 decimales.

Y lo más didáctico, `money.ts:159-162`:

```ts
/** Solo se convierte a string: `a + b`, `a < b` y `+a` lanzan. */
[Symbol.toPrimitive](hint: string): string {
  if (hint === "string") return this.toString();
  throw new TypeError("Money no se opera como número: usa sus métodos.");
}
```

Si alguien escribe `a + b` con dos `Money` por costumbre, explota en vez de concatenar o dar un número raro. Se opera con métodos: `a.sumar(b)`, `a.restar(b)`, `a.comparar(b)`, `Money.suma(lista, "PEN")`. Sumar PEN con USD lanza `MonedaDistintaError`.

### `MontoExacto` y la regla de oro: redondear una sola vez, al final

`Money.por(factor)` **no** devuelve `Money`, devuelve `MontoExacto` (`money.ts:122`). Para volver a `Money` hay que pasar por `redondearSunat`. El tipo te obliga a decidir **dónde** redondeas. Por dentro, `MontoExacto` guarda una fracción `num/den` exacta, así que dividir y luego multiplicar nunca pierde un medio céntimo.

## 4. Redondeo SUNAT: *half-up* a 2 decimales

`packages/domain/src/dinero/redondeo.ts:8-10` es la **única** regla de redondeo del monorepo:

```ts
export function redondearSunat(x: MontoExacto): Money {
  return moneyDesdeDecimal(centimosDeExacto(x), x.moneda);
}
```

*Half-up alejándose de cero*: si el tercer decimal es 5 o más, se sube; los negativos son simétricos. El corazón está en `decimal.ts:47-53` (`centimosDeCociente`): calcula el cociente entero en céntimos y compara el doble del resto con el divisor (`dobleResto.gte(den)`), todo en enteros, sin decimales truncados.

Ejemplos en soles (todos salen de pruebas reales de `packages/domain/src/dinero/redondeo.spec.ts`):

| Operación | Exacto | SUNAT |
|---|---|---|
| IGV de S/ 2.25 al 18 % | 0.405 | **0.41** (no 0.40) |
| Nota de crédito: −2.25 × 0.18 | −0.405 | **−0.41** |
| Medio céntimo exacto | 0.005 | **0.01** |
| 10.004 | 10.004 | 10.00 |
| IGV de S/ 8.94 al 18 % | 1.6092 | 1.61 |

Y para el IGV hay un ayudante con tolerancia de ±0.01 (`dinero/igv.ts`): `igvEsperado(base, TASA_IGV_18)` y `igvCuadra(base, igv, tasa)`.

## 5. El comprobante: columnas y cuadre

Un registro de compras tiene columnas fijas (`packages/domain/src/comprobante/columnas.ts:2-12`): `biDg`, `igvDg` (base e IGV con destino gravado), `biDgng`, `igvDgng` (gravado y no gravado), `biDng`, `igvDng` (no gravado), `noGravado`, `isc`, `icbper`, `otrosTributos`.

**Cuadre** (`packages/domain/src/dinero/cuadre.ts`): `diferencia = total − Σ componentes`; cuadra si `|diferencia| ≤ tolerancia`. Para el total la tolerancia es `0.00` (`TOLERANCIA_CUADRE`); para el IGV contra base × tasa, `0.01` (`TOLERANCIA_IGV`).

**Mover un monto entre columnas** es lo que hace el contador cuando reclasifica: "esto no era base gravada, era ISC". `packages/domain/src/comprobante/mover-monto.ts:13-37` (resumido):

```ts
export function moverMonto(m, origen, destino, monto: Money) {
  const real = Money.suma([monto], m.moneda);          // valida que sea Money real y de la moneda
  if (origen === destino) throw new MovimientoInvalidoError();
  const saldo = columnas[origen];
  if (real.esCero() || saldo.esCero()
      || real.esNegativo() !== saldo.esNegativo()     // mismo signo (notas de crédito)
      || real.abs().comparar(saldo.abs()) > 0)        // no puedes mover más de lo que hay
    throw new MovimientoInvalidoError();
  columnas[origen] = saldo.restar(real);
  columnas[destino] = columnas[destino].sumar(real);
  return montosDesdeColumnas(m.moneda, columnas, m.total); // el total NO cambia
}
```

Es un asiento de reclasificación: debe y haber se compensan, el total del comprobante queda igual.

## 6. El lint que prohíbe `number`

Aun con `Money`, un programador apurado podría escribir `parseFloat(monto)`. El ESLint del repo lo impide en `packages/domain/src/{dinero,comprobante,reglas}` (`eslint.config.mjs:779-790`), con selectores definidos en `eslint.config.mjs:532-560`:

- El tipo `number` (`TSNumberKeyword`): "el tipo `number` está prohibido; usa Money/decimal".
- `Number`, `parseFloat`, `parseInt`, `Math`, `globalThis` y sus alias.
- `.toNumber()`, `.valueOf()` y el `+x` unario.
- Vías dinámicas: `eval`, `new Function`, `import()`.

El propio archivo documenta lo que el lint **no** puede cerrar (`eslint.config.mjs:621-625`, por ejemplo `const n = s.length`): fue un riesgo aceptado por el usuario (D10 de la spec 010). Bien hecho: se deja escrito el límite en vez de fingir que no existe.

## 7. El motor de reglas, contado por un contador

`packages/domain/src/reglas/motor.ts` evalúa cada fila del registro de compras y devuelve **hallazgos** con una explicación y, si puede, una **sugerencia**. Nunca corrige solo: el contador confirma. El reparto por destino está en `motor.ts:29-41`:

```ts
for (const d of destinosActivos(fila)) {            // DG, DGNG, DNG por separado
  if (d.igv.esCero()) hallazgos.push(evaluarIscIgvCero(fila, d));        // R-ISC
  else if (!igvCuadra(d.bi, d.igv, TASA_IGV_18) && !igvCuadra(d.bi, d.igv, TASA_IGV_10))
    hallazgos.push(evaluarMix(fila, d));                                  // R-MIX
  else if (marcado) hallazgos.push(evaluarIscMarcado(fila, d));          // proveedor de ISC
}
```

- **R-ISC** (`reglas/r-isc.ts`): "Tengo base gravada pero el IGV es cero. Eso no es una compra gravada: probablemente es ISC (un licor, un combustible)". Caso real de la spec 011 (CA-1, San Juan): BI DG 770.00, IGV 0.00, total 770.00 → sugerencia "mover 770.00 de BI DG a ISC". Sin XML requiere confirmación; con XML que trae ISC 770.00 se respalda. Al aplicarla: ISC 770.00, BI DG 0.00, total igual.
- **R-MIX** (`reglas/r-mix.ts`): "El IGV no es el 18 % ni el 10 % de la base. Parte de esa base no estaba gravada". Caso real (CA-2): BI 21.48, IGV 1.61. 1.61 / 0.18 = 8.944… → estimado **8.94**. Pero varios gravados dan el mismo IGV redondeado: de 8.92 a 8.97 todos producen 1.61 (8.92 × 0.18 = 1.6056 → 1.61; 8.97 × 0.18 = 1.6146 → 1.61). Por eso sin XML se ofrece un **rango 8.92–8.97** y el contador elige; con XML se usa el exacto (8.97, que deja 12.51 no gravado).
- **R-RED** (`reglas/r-red.ts`): "La suma de columnas no da el total". Si la diferencia es de redondeo (≤ 0.01 por cada componente distinto de cero) sugiere ajustar el total; si hay XML y su total coincide, ajusta la columna que difiere; más allá, solo avisa.
- **R-NEW** (`reglas/r-new.ts`): "Este proveedor no lo conozco para este cliente". No toca montos; pide clasificar el destino (`sugerencia: { tipo: "clasificar" }`, `requiereConfirmacion: true`).
- (Hay una quinta, **R-GP**: glosa con palabras de consumo personal, como "zapatilla".)

Al aplicar una sugerencia (`reglas/aplicar.ts:301`), el motor comprueba que los montos sigan siendo los que leyó; si alguien los cambió entretanto, lanza `SugerenciaObsoletaError`. Como no aprobar un asiento sobre un saldo que ya se movió.

## 8. Dominio puro: sin IO

`packages/domain` no importa `packages/db`, `sunat`, `queue`, `storage` ni `crypto` (lint en `eslint.config.mjs`, "packages/domain no puede importar paquetes de IO"). No lee archivos, no consulta la BD, no llama a SUNAT. Recibe datos y devuelve datos.

¿Qué gana el proyecto?

- **Pruebas rápidas y deterministas**: 1000 pruebas del dominio corren en unos 9 s, sin Docker, sin PostgreSQL, sin red.
- **Pruebas de propiedades** con `fast-check`: se generan miles de montos al azar y se verifica una ley ("el total no cambia al mover", "redondear coincide con half-up en enteros").
- **Reutilizable**: la misma regla sirve en el worker, en el backend o en un script.

Es como separar el cálculo de la planilla (una fórmula que siempre da lo mismo) del trámite de presentarla en el portal (que puede fallar por la red).

## Práctica

**A. El float en 5 líneas** (cualquier carpeta):

```bash
node -e '
const a = 0.1 + 0.2;                 console.log("0.1+0.2 =", a, a === 0.3);
console.log("1.005.toFixed(2) =", (1.005).toFixed(2));
let s = 0; for (let i = 0; i < 10; i++) s += 0.1;  console.log("10 × 0.1 =", s);
console.log("IGV 8.94 =", 8.94 * 0.18);'
# 0.1+0.2 = 0.30000000000000004 false
# 1.005.toFixed(2) = 1.00
# 10 × 0.1 = 0.9999999999999999
# IGV 8.94 = 1.6091999999999997
```

**B. El mismo cálculo con el dominio** (desde la raíz del repo, tras `pnpm --filter @contapp/domain build`):

```bash
cd packages/domain && node -e '
const { Money, MontoExacto, redondearSunat, igvEsperado, TASA_IGV_18 } = require("./dist");
console.log(Money.desde("0.10","PEN").sumar(Money.desde("0.20","PEN")).toString()); // 0.30
console.log(redondearSunat(MontoExacto.desde("-10.005","PEN")).toString());         // -10.01
console.log(igvEsperado(Money.desde("8.94","PEN"), TASA_IGV_18).toString());        // 1.61
try { Money.desde("1.00","PEN") + Money.desde("2.00","PEN") } catch (e) { console.log(e.message) }'
```

**C. Correr las pruebas del dominio**:

```bash
pnpm --filter @contapp/domain test       # ~43 archivos, 1000 pruebas
pnpm cobertura:dominio                   # lo mismo con cobertura ≥ 90 % por archivo
```

## Impacto en ContApp

- El IGV, los totales y las reclasificaciones dan siempre el mismo resultado que el contador hace a mano con la regla SUNAT.
- Un error de céntimo no puede entrar "por costumbre": el tipo, el `toPrimitive` y el lint lo cierran.
- Las reglas sugieren, el contador decide: el sistema nunca cambia un monto sin confirmación cuando hay duda (rango de R-MIX, R-ISC sin XML).
- Como el dominio es puro, las rondas adversariales pudieron atacar miles de combinaciones (0.005, notas de crédito, montos en el límite de NUMERIC(14,2)) en segundos.

## Errores comunes

- `Number(fila.total)` "solo para comparar": ya perdiste precisión. Usa `Money.desdeNumeric` y `comparar`.
- Redondear en cada paso intermedio: el error se acumula. Redondea una vez, con `redondearSunat`, al final.
- `toFixed(2)` como redondeo: usa la representación binaria, no *half-up* decimal (`1.005 → "1.00"`).
- Sumar PEN y USD "porque son números": `Money` lo impide; para convertir está `convertirAPen` (`comprobante/convertir.ts`).
- Guardar montos como `float`/`double precision` en PostgreSQL: van como `NUMERIC(14,2)`.
- Meter una consulta a la BD dentro de una regla "para traer los proveedores": rompe la pureza; los conocidos entran por el contexto (`ctx.conocidos`).

## Ejercicios

1. ¿Por qué `Money.por(TASA_IGV_18)` devuelve `MontoExacto` y no `Money`?
2. Calcula a mano el IGV SUNAT de una base de S/ 2.25 y de S/ −2.25.
3. Con BI DG 21.48 e IGV DG 1.61, ¿8.98 está en el rango de R-MIX? Justifica.
4. Una fila tiene BI DG 100.00 e IGV DG 0.00. ¿Qué regla dispara y por qué nunca R-MIX?
5. Escribe (sin ejecutar) qué pasa con `moverMonto(m, "biDg", "isc", Money.desde("150.00","PEN"))` si `biDg` es 100.00.

<details><summary>Soluciones</summary>

1. Para obligar a decidir explícitamente cuándo redondear. Si devolviera `Money` habría que redondear en cada producto y los errores se acumularían en cadenas de operaciones (por ejemplo, dividir entre el TC y luego multiplicar).
2. 2.25 × 0.18 = 0.405 → 0.41; −0.405 → −0.41 (simétrico, alejándose de cero).
3. No: 8.98 × 0.18 = 1.6164 → 1.62 ≠ 1.61. El rango es 8.92–8.97.
4. R-ISC: `motor.ts` revisa primero `d.igv.esCero()`; solo si el IGV no es cero evalúa R-MIX (CA-5 de la spec 011).
5. Lanza `MovimientoInvalidoError`: `|monto| > |saldo|` (no puedes mover 150 de una columna que tiene 100).

</details>

## Para profundizar

- MDN, `Number` y precisión de punto flotante: https://developer.mozilla.org/es/docs/Web/JavaScript/Reference/Global_Objects/Number
- Documentación de decimal.js: https://mikemcl.github.io/decimal.js/
- PostgreSQL, tipos numéricos (`numeric`): https://www.postgresql.org/docs/17/datatype-numeric.html
