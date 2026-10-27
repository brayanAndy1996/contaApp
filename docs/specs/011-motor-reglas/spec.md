# Spec 011 · Motor de reglas

Estado: borrador
Nivel de riesgo: A — sí a (1) una sugerencia mal calculada mueve montos o IGV a la columna equivocada y el archivo sale con crédito fiscal incorrecto; sí a (3) un centavo o una regla que no se dispara no se ve en una grilla de cientos de filas; sí a (4) combinaciones de destinos, tasas, signos (notas de crédito), monedas, con o sin XML y reglas que se cruzan en la misma fila. (2) no aplica (lógica pura, sin datos de otros estudios).
Cubre: RF-080, RF-081, RF-082, RF-083, RF-085 · HU-23, HU-24, HU-19 (marca de la fila), HU-25 (parte R-RED) · RNF-052, RNF-053 (parte de reglas)

## Objetivo
Dar a ContApp, en `packages/domain/src/reglas/` (sin IO, sin IA), una función determinista que evalúa las filas de una propuesta de compras y devuelve, por fila, los **hallazgos** (regla disparada y explicación en lenguaje simple con cifras) y la **sugerencia** de corrección, sin aplicarla. Y la función que aplica una sugerencia aceptada (una o todas las de una regla) devolviendo montos nuevos. La usan el worker al cargar la propuesta (014) y la lupa (016); toda la aritmética sale de 010.

## Alcance
- `evaluarReglas(filas, contexto) → hallazgos`: pura, determinista (mismo orden de salida para la misma entrada), no muta la entrada. Contexto que entrega quien llama: proveedores conocidos del cliente, proveedores marcados como emisores de ISC y, si P-1 = A, el diccionario de glosas.
- Reglas de R1 (código, explicación con cifras canónicas y sugerencia):
  - **R-ISC** (RF-081): BI > 0 con IGV = 0 en un destino, o proveedor marcado como emisor de ISC → mover a `isc` (D-1, D-2).
  - **R-MIX** (RF-082): IGV ≠ 0 que no cuadra con 18 % ni 10 % de la BI (`igvCuadra`, `TOLERANCIA_IGV`) → separar gravado y no gravado; sin XML como **rango** con estimado; con XML, exacta (D-3, P-3).
  - **R-RED** (RF-083): `verificarCuadre(…, TOLERANCIA_CUADRE)` no cuadra en la moneda de origen o tras `convertirAPen` → sugerir el monto corregido (P-2).
  - **R-NEW** (RF-085): proveedor (tipo y número de documento) que no está entre los conocidos del cliente → hallazgo "Proveedor nuevo", pendiente de clasificar, sin montos.
  - **R-GP** (solo si P-1 = A): palabra clave de consumo personal en la glosa del XML → sugerir "Excluir como no deducible" (sin montos).
- Resumen del XML como entrada opcional por fila (identidad del comprobante y totales por tributo); lo produce 016 (o el mock de 009). Si su identidad no coincide con la fila, se ignora y se informa.
- `aplicarSugerencia(montos, sugerencia, confirmado?) → MontosComprobante` y su versión masiva por regla, ambas puras, con `moverMonto`/`cambiarDestino` de 010; nunca tocan la propuesta original (RNF-052).
- Lint contra `number` de 010 ampliado a `packages/domain/src/reglas/**` (nota [011/013] de ESTADO).

## Fuera de alcance
- Persistencia de hallazgos y versiones de fila, disparo al cargar la propuesta, resumen por casillero (014); grilla y botones aceptar (015); modal y parser XML (016).
- R-ICB (RF-084), R-HIS (RF-086), catálogo global de proveedores (RF-087) y activar/desactivar reglas por estudio (RF-089): R2. La marca "emisor de ISC" llega como dato del contexto.
- Prevalidación que bloquea la generación (RF-088) y formato TXT: 012 (reutiliza la detección de cuadre).
- Correlatividad de ventas y caso boleta 291 (RF-053, HU-12): 013, en `packages/domain/src/correlatividad/`.
- Puntaje completo de gasto personal (CIIU, giro, feriados, historial, umbral, diccionario por estudio: RF-116–118): R2.

## Criterios de aceptación
- [ ] CA-1 (San Juan, HU-23): Dada una compra con BI DG 770.00, IGV DG 0.00 y total 770.00, entonces hay un hallazgo R-ISC con sugerencia exacta "mover 770.00 de BI DG a ISC" que requiere confirmación; con XML que trae ISC 770.00 la explicación es "Base gravada con IGV 0: el XML indica ISC". Al aplicarla: ISC 770.00, BI DG 0.00, total igual.
- [ ] CA-2 (mixta sin XML, HU-24): Dada BI DG 21.48 e IGV DG 1.61, entonces R-MIX sugiere un rango gravado 8.92–8.97 con estimado 8.94, no gravado = 21.48 − gravado, requiere confirmación y explica "1.61 no es 18 % ni 10 % de 21.48". `aplicarSugerencia` sin monto confirmado o con uno fuera del rango lanza error; con 8.97 deja 8.97 + 12.51 y total igual.
- [ ] CA-3 (mixta con XML): con XML de gravado 8.97, la sugerencia es exacta: gravado 8.97 y no gravado 12.51. Si el gravado del XML queda fuera del rango o su IGV difiere del SIRE, no hay sugerencia exacta y el hallazgo lo explica.
- [ ] CA-4 (rango): para todo IGV y BI válidos, cada gravado `g` del rango cumple `igvEsperado(g, 18 %) = IGV` y `0 < |g| ≤ |BI|`, y `min − 0.01` y `max + 0.01` no (propiedad, ≥ 1000 casos con semilla fija). Rango vacío (p. ej. BI 0 con IGV > 0, o IGV mayor que el 18 % de la BI) → hallazgo sin sugerencia.
- [ ] CA-5 (precedencia): con IGV = 0 solo dispara R-ISC (nunca R-MIX); una fila que cuadra a 18 % o a 10 % (±0.01) no dispara R-MIX; cada destino (DG, DGNG, DNG) se evalúa por separado.
- [ ] CA-6 (R-RED, HU-25): una fila con Σ componentes ≠ total da hallazgo R-RED con diferencia (total − Σ) y la sugerencia de P-2; una fila USD sintética cuyo cuadre se rompe solo al convertir a PEN también lo da. Caso real USD: diferido sin cifras (pendiente no bloqueante, igual que en 010).
- [ ] CA-7 (R-NEW, HU-19): un proveedor fuera de los conocidos marca todas sus filas del periodo con "Proveedor nuevo" y sin montos; el documento se compara normalizado (sin espacios, mismo tipo); uno conocido no dispara.
- [ ] CA-8 (no aplica): `evaluarReglas` no cambia ninguna fila de entrada (`Object.isFrozen` y igualdad antes/después); el resultado es idéntico en dos llamadas y con las filas permutadas (salvo el orden, que es por id de fila y código de regla).
- [ ] CA-9 (aplicar): toda sugerencia aplicada conserva el total salvo la de R-RED; aplicar una sugerencia sobre montos que ya no son los evaluados lanza `SugerenciaObsoletaError`; la masiva aplica fila por fila y devuelve aplicadas y rechazadas con motivo, sin abortar el lote.
- [ ] CA-10 (signos y moneda): una nota de crédito (montos negativos, D6 de 010) dispara R-ISC y R-MIX con el mismo signo; una fila USD se evalúa en USD y nunca mezcla monedas.
- [ ] CA-11 (XML ajeno): un XML con otro RUC, serie o número se ignora y genera el aviso "El XML no corresponde a este comprobante" (no produce sugerencias exactas).
- [ ] CA-12 (zapatilla, solo si P-1 = A): una glosa "ZAPATILLAS URBANAS T-42" o "zapat. dep." dispara R-GP con la palabra encontrada en la explicación; "zapata de concreto" no.
- [ ] CA-13: cobertura ≥ 90 % por archivo en `packages/domain/src/reglas/` (RNF-053); lint sin `number` ni IO en `reglas/`.
- [ ] Casos reales aplicables: San Juan ISC (CA-1), mixta 21.48/1.61 (CA-2, CA-3), redondeo USD (diferido, CA-6 sintético), zapatilla (CA-12, según P-1). Boleta 291: no aplica (013).

## Ataques obligatorios del adversario
Catálogo de dinero/reglas de 04-metodologia §2.3 más: IGV a 1 céntimo del borde del rango; BI 0 con IGV > 0; IGV > BI; filas con todos los tributos y los tres destinos a la vez; reglas cruzadas en la misma fila y aplicar dos sugerencias seguidas; XML de otro comprobante o con montos que no suman; contexto con `__proto__` o documentos con espacios/ceros; glosas enormes, Unicode y homoglifos (ReDoS en la normalización).

## Dependencias
- Specs: 010 (Money, `igvCuadra`, `verificarCuadre`, `moverMonto`, `cambiarDestino`, `convertirAPen`). 014 y 016 consumen esta API.
- Externas: ninguna (XML vía su resumen; mock en 009).

## Decisiones propuestas
- D-1 R-ISC sin XML: sugerencia exacta (toda la BI del destino a ISC) que requiere confirmación; con XML se mueve el ISC del XML (≤ BI, mismo signo); si el XML no trae ISC, solo hallazgo "XML sin ISC: revisar".
- D-2 Marca de proveedor emisor de ISC con IGV ≠ 0: sin XML, hallazgo informativo sin montos; con XML, sugerencia exacta del ISC del XML.
- D-3 Rango de R-MIX: `{g | igvEsperado(g, tasa) = IGV} ∩ (0, BI]`; estimado = `redondearSunat(IGV / tasa)` acotado al rango; el no gravado va a `noGravado`.
- D-4 Ninguna regla aplica nada: el resultado son datos; aceptar es una llamada explícita a `aplicarSugerencia` (RF-080).

## Preguntas abiertas
- P-1 Glosa "zapatilla" (RF-116 es R2, pero es caso real obligatorio). A: R-GP mínima en 011 (solo palabra clave + normalización simple, diccionario base como parámetro, sugiere excluir). B: diferir a la spec R2 de gasto personal. **Recomiendo A**: cubre el caso real y HU-17 con poco código; el puntaje completo sigue en R2.
- P-2 R-RED, qué columna absorbe la diferencia. A: ajustar el total a Σ componentes (coherente con D2/D7 de 010) cuando |diferencia| ≤ 0.01 × componentes distintos de cero; si hay XML y su total coincide con el del SIRE, ajustar la columna que difiere del XML; más allá, hallazgo sin sugerencia. B: siempre pedir al contador. **Recomiendo A.**
- P-3 Tasa para estimar R-MIX sin XML. A: solo 18 %; 10 % solo con XML. B: dos rangos, 18 % primero. C: según una marca del proveedor. **Recomiendo A**: coincide con HU-24 y evita ruido; con XML la tasa sale de cada línea.
