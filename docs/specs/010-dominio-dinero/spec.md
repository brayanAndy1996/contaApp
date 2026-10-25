# Spec 010 · Dominio de dinero

Estado: aprobada (usuario, 2026-10-25: "todo lo recomendado" en P1–P8 → D1–D8)
Nivel de riesgo: A — sí a (1) un error da montos, IGV o archivos tributarios incorrectos; sí a (3) un centavo de diferencia no se ve a simple vista y SUNAT devuelve "procesado con errores"; sí a (4) combinaciones de signos, monedas, tasas, redondeos acumulados y orden de suma. (2) no aplica.
Cubre: RNF-050, RNF-051, RNF-053 (parte de dinero) · base aritmética de RF-062, RF-064, RF-082, RF-083, RF-088 · HU-15, HU-16, HU-25 (la parte de cálculo)

## Objetivo
Dar a todo ContApp un único módulo de dinero exacto y probado en `packages/domain` (sin IO): el valor `Money`, el redondeo SUNAT a 2 decimales, el movimiento de montos entre columnas de un comprobante y la verificación de cuadre. Las reglas (011), la prevalidación (012) y las grillas (013–015) lo usan; ninguna reimplementa aritmética de dinero.

## Alcance
- `packages/domain/src/dinero/`: `Money` inmutable con moneda PEN/USD (D7) sobre un `Decimal` **clonado** (`Decimal.clone`, sin depender de `Decimal.set` global). Rango de NUMERIC(14,2): ±999 999 999 999.99. Operaciones: sumar, restar, negar, multiplicar por tasa o tipo de cambio (resultado sin redondear hasta llamar a `redondearSunat`), comparar, `esCero`, `suma(lista)`. Construcción solo desde string canónico de hasta 2 decimales (D5, D8) o desde otro `Money`; **nunca desde `number`** (error de tipos y en ejecución).
- `redondearSunat(decimal) → Money`: una sola función, una sola regla (D1), usada por todo el monorepo.
- Serialización: `toString()` canónico `-?\d{1,12}\.\d{2}` (punto, sin miles, sin exponente, sin `-0.00`); `desdeNumeric(string)` acepta lo que devuelve PostgreSQL para NUMERIC(14,2) y la ida y vuelta es idéntica.
- Tasas IGV 18 % y 10 % como constantes; `igvEsperado(base, tasa)` y `igvCuadra(base, igv, tasa, tolerancia)` (D3).
- `packages/domain/src/comprobante/`: `MontosComprobante` inmutable con moneda y las columnas de compras (D4). `cambiarDestino(montos, DG|DGNG|DNG)` mueve los pares BI/IGV; `moverMonto(montos, origen, destino, monto)` mueve un monto parcial o total entre dos columnas (lo usan R-ISC, R-MIX y R-ICB en 011). Ambas conservan el total.
- `verificarCuadre(montos, tolerancia) → { cuadra, sumaComponentes, total, diferencia }`, con `total = Σ columnas` (D2).
- Conversión USD → PEN por componente con tipo de cambio de hasta 3 decimales (D7).

## Fuera de alcance
- Detección de reglas y estimación del rango de gravado de R-MIX (011); reglas completas de prevalidación y formato TXT (012).
- Parseo de entradas de usuario con formato local (`1.234,50`, espacios): lo normaliza quien recibe la entrada (frontend o importación) antes de llamar a `Money` (D5).
- Persistencia, esquemas zod y columnas de BD (014). Columnas de ventas (013, D4).

## Criterios de aceptación
- [ ] CA-1: Dado `Money.desde("0.10")` sumado a `"0.20"`, entonces `toString()` es `"0.30"`; ninguna ruta de `dinero/` ni `comprobante/` usa `number`, `parseFloat`, `Number(` ni `toNumber()` para montos (lint en `packages/domain` + grep vacío).
- [ ] CA-2: Dado `Money.desde(12.5 as any)`, `NaN`, `Infinity`, `"1e3"`, `"12.345"`, `"1,234.50"`, `" 12.00"`, `""`, `"--1"` o `"0x10"`, entonces lanza `MontoInvalidoError` (no redondea ni recorta en silencio).
- [ ] CA-3: Dado `"999999999999.99"` + `"0.01"`, o un producto por tasa cuyo redondeo excede el rango, entonces lanza `MontoFueraDeRangoError`; `"-999999999999.99"` es válido.
- [ ] CA-4: Con la regla de D1, dado 2.25 × 0.18 = 0.405, entonces `redondearSunat` da `"0.41"`; dado −0.405, da `"-0.41"`; 0.004999… da `"0.00"`; 0.005 da `"0.01"`; 0.015 da `"0.02"`. El resultado no cambia si otro módulo llama a `Decimal.set({ rounding: … })`.
- [ ] CA-5: `Money.desde("-0.00")`, `negar("0.00")` y `"0.01" − "0.01"` dan `"0.00"`, son iguales a cero y `esCero()` es verdadero.
- [ ] CA-6: Dada una lista de N montos (incluidos negativos de notas de crédito), entonces `suma` da el mismo resultado en cualquier permutación y agrupación (propiedad con fast-check o tabla de ≥ 1000 casos con semilla fija).
- [ ] CA-7: Dado `MontosComprobante` en PEN y otro en USD, entonces sumar o mover entre ellos lanza `MonedaDistintaError`.
- [ ] CA-8: Dada una fila con BI DG 100.00 e IGV DG 18.00, cuando `cambiarDestino(DNG)`, entonces BI DNG 100.00, IGV DNG 18.00, DG en 0.00, total igual; el original no cambia (inmutabilidad, `Object.isFrozen`).
- [ ] CA-9: `moverMonto` con monto mayor que el saldo de origen, negativo, cero, o con origen igual a destino lanza `MovimientoInvalidoError` (D6 para notas de crédito); en todos los casos válidos `Σ columnas` antes = después.
- [ ] CA-10: Dada una fila cuyo total difiere de la suma de componentes en 0.01, entonces `verificarCuadre(…, tolerancia "0.00")` da `cuadra = false` y `diferencia = "0.01"` (o `"-0.01"`, con signo definido: total − suma); con diferencia 0.00 cuadra.
- [ ] CA-11: Para todo string válido `s` en el rango, `desdeNumeric(s).toString()` canónico es igual a `s` normalizado (`"5"`→`"5.00"`, `"5.5"`→`"5.50"`), y `toString()` siempre cumple la expresión regular del Alcance.
- [ ] CA-12: Cobertura ≥ 90 % en líneas, ramas, funciones y sentencias **por archivo** en `packages/domain/src/{dinero,comprobante}` (umbral `perFile` de Vitest); `packages/domain` no importa `node:*`, BD, HTTP ni `@contapp/sunat` (lint).
- [ ] CA-13 (D7, valores sintéticos, no es el caso real): Dado un comprobante USD con BI DG 0.15, IGV DG 0.03 y total 0.18, convertido con TC 3.300, entonces BI DG 0.50 (0.495), IGV DG 0.10 (0.099) y total 0.60 = suma de convertidos (no 0.59 = redondeo de 0.18 × 3.300), y `verificarCuadre(…, "0.00")` cuadra. Un TC con más de 3 decimales, cero o negativo se rechaza.
- [ ] Casos reales aplicables:
  - Mixta 21.48/1.61: `igvCuadra(21.48, 1.61)` es falso a 18 % (esperado 3.87) y a 10 % (2.15); `igvEsperado(8.97, 18 %)` = 1.61 y `igvEsperado` de 8.92 también, pero 8.91 → 1.60 y 8.98 → 1.62; `moverMonto(BI DG → no gravado, 12.51)` deja 8.97 + 12.51 con total igual.
  - San Juan ISC: mover 770.00 de BI DG a ISC conserva el total y deja IGV DG en 0.00.
  - Redondeo USD: **DIFERIDO** (pendiente no bloqueante, ver abajo).

## Pendientes no bloqueantes
- Caso real de redondeo en USD: el video no da las cifras. No se inventan. Cuando el equipo las entregue, se agrega como prueba en `packages/domain/tests/casos-reales/` (tester) y, si contradice D7, se reabre D7 con el usuario. No impide cerrar la spec; CA-13 cubre la regla con valores sintéticos.

## Ataques obligatorios del adversario
Desborde en el límite de NUMERIC(14,2) y en sumas largas; precisión con divisiones (`igv / 0.18`) y TC de 3+ decimales; medio centavo exacto (0.005, 0.015, 0.025, …, −0.005) y valores a 1 ulp del límite; signos y notas de crédito; cero negativo; NaN, ±Infinity, `number` disfrazado (`as any`, objeto con `toString`); notación científica (`1e2`, `1E-2`); strings con coma, espacios, `+`, ceros a la izquierda, Unicode (dígitos árabes, NBSP); conmutatividad y asociatividad al sumar en distinto orden; cuadre con ±0.01; conservación del total en `cambiarDestino` y `moverMonto` encadenados; mutación del original o de internos (`Object.freeze`, `Decimal` expuesto); `Decimal.set` global alterado por otro módulo; ida y vuelta NUMERIC(14,2) y JSON (`JSON.stringify` no debe producir `number`).

## Dependencias
- Specs: 001 (monorepo, Vitest, lint). Independiente de 002/003 (sin BD). Rama `spec/010-dominio-dinero` desde `spec/003-cifrado` (003 sin mergear).
- Externas: `decimal.js`. Ninguna de SUNAT.

## Decisiones (aprobadas por el usuario el 2026-10-25)
- D1 Redondeo SUNAT: half-up alejándose de cero (`ROUND_HALF_UP` de decimal.js) a 2 decimales; coincide con el rango 8.92–8.97 del caso real. Si una fuente oficial de SUNAT dijera otra cosa, solo cambia `redondearSunat` y sus pruebas.
- D2 Tolerancias: 0.00 para el cuadre `total = Σ componentes` (generación del TXT); ±0.01 solo para IGV contra base × tasa (RF-082).
- D3 `igvEsperado` e `igvCuadra` van en 010 (los necesita el cuadre en vivo de HU-16; R-MIX en 011 los reutiliza).
- D4 Columnas: 010 solo trae las de compras (BI/IGV DG, BI/IGV DGNG, BI/IGV DNG, no gravado, ISC, ICBPER, otros tributos y total). Ventas va en 013 reutilizando `Money` y un `verificarCuadre` genérico sobre una lista de componentes. `cambiarDestino` con montos en varios destinos consolida todo en el nuevo e informa qué destinos consolidó.
- D5 Entrada estricta: el dominio rechaza coma decimal, espacios y cualquier formato local; la normalización va en frontend o importación.
- D6 Notas de crédito: montos negativos en todas las columnas (mismo signo); `moverMonto` exige el mismo signo que el saldo de origen y |monto| ≤ |saldo|.
- D7 Moneda y tipo de cambio: `Money` lleva moneda PEN/USD y operar entre monedas distintas lanza `MonedaDistintaError`; el TC es un decimal de hasta 3 decimales; la conversión es por componente (cada columna se redondea) y el total convertido es la suma de los convertidos, para que cuadre en PEN.
- D8 Más de 2 decimales: `Money.desde` los rechaza; el parser de XML (016) convierte el valor exacto y llama a `redondearSunat` explícitamente.
- D9 Adiciones al alcance (aprobada por el usuario el 2026-10-25): quedan dentro de 010 tres adiciones que no figuraban en el texto original de Alcance: `entre` (división), `MontosComprobante.sumar` y `convertirAPen`.
