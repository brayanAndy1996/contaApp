# Spec 012 · Prevalidación SUNAT, formatos TXT versionados y ZIP

Estado: borrador (2026-11-06). Rama `spec/012-prevalidacion-archivos` desde `main`. Sin plan ni tareas hasta que el usuario responda las P-n.
Nivel de riesgo: A. Responde «sí» a (1), (3) y (4): (1) un error produce un archivo tributario incorrecto o «procesado con errores»; (3) un centavo, un separador dentro de un texto o una fila omitida no se notan a simple vista; (4) hay muchas combinaciones de destinos, monedas, signos, versiones de formato y caracteres. (2) no aplica al núcleo puro; sí aplicaría a la parte persistida (descarga de versiones), si P-1 = (b). Por eso lleva TDD y ronda adversarial (§2.2 y §2.3).
Cubre: RF-088, RF-100 (compras; ventas según P-7), RF-101, RF-102 (cálculo), RNF-043 · HU-25 (la regla de bloqueo y la lista de filas) · HU-26 (el contenido del TXT y del ZIP). Con P-1 = (a), RF-103, la UI de HU-25 y HU-26 y RNF-035 pasan a 012b (ver Fuera de alcance).

## Objetivo
Que ningún archivo que genere ContApp salga «procesado con errores» (regla 11 de 01 §7). Para eso se construyen, como código puro y probado, la prevalidación que decide si un periodo puede generarse y lista las filas por corregir, el resumen de cambios, la serialización del TXT de reemplazo con un formato versionado, y el empaquetado en ZIP con su hash.

## Alcance (si P-1 = (a), recomendada)
- `packages/domain/src/prevalidacion/`: `prevalidar(filas, contexto) → { apto, errores[], avisos[] }`. Es pura y determinista, y no muta la entrada. Cada error lleva `filaId`, código, campo, explicación con cifras canónicas y, si existe, la sugerencia de 011 (la UI la usa como enlace a la fila, HU-25).
- `packages/domain/src/formatos/`: registro de formatos TXT versionados y declarativos (`id`, `version`, `vigenteDesde` como periodo AAAAMM, `oficial: boolean` y la lista de campos con obligatoriedad, longitud, patrón y conjunto de caracteres). Incluye la validación estructural de una fila contra su formato y `generarTxt(filas, formato, cabecera) → { bytes, nombreTxt }`.
- `packages/domain/src/prevalidacion/resumen.ts`: `resumirCambios(original, vigente) → { modificadas, excluidas, agregadas, impactoIgv }` (RF-102), con `Money`.
- `packages/sunat/src/formatos/empaquetar.ts`: `empaquetar(txt, nombres, fecha) → { zip, nombreZip, sha256Txt, sha256Zip }`, en memoria y sin escribir a disco. Solo lo usa el worker.
- La regla de lint contra `number` de 010 se amplía a `prevalidacion/` y `formatos/` (nota [011/013] de ESTADO).
- `docs/03-arquitectura.md` §11 y §7.3 se actualizan con la ubicación de los formatos (D2).

## Fuera de alcance
- Con P-1 = (a), todo esto va en **012b**, después de 014: la tabla `archivo_generado` (con migración desde la 0028), `packages/storage` con `StorageProvider` y su mock o local, las rutas `POST`/`GET …/archivos` (422 con la lista de filas), el trabajo `archivo.generar` en la cola `archivos`, las versiones con usuario, fecha y hash y la descarga de versiones anteriores (RF-103), el botón «Generar» deshabilitado y el resumen en pantalla (HU-25 y HU-26, con el permiso `sire.aprobar_generar`) y la medición de RNF-035.
- Modelo de comprobantes y versiones de fila (014). Aquí se consume una forma de entrada (`FilaReemplazo`, D3) a la que 014 adapta sus datos.
- Estructura del TXT de ventas (RVIE): según P-7. Correlatividad y boleta 291: 013.
- Envío a SUNAT y seguimiento del ticket (RF-104, R2). Importar el TXT de SUNAT (RF-051, 013). Prorrata (R2).
- La estructura oficial de SUNAT (campos, orden, separador, codificación, nombres): no está en `docs/` y no se inventa (P-2).

## Decisiones
- D1 Una sola verdad aritmética: la prevalidación no reimplementa cuadres. Usa `verificarCuadre` (tolerancia 0.00), `igvCuadra` (±0.01), `convertirAPen` y `redondearSunat` de 010, y reutiliza `evaluarReglas` de 011 para la sugerencia. Un error de cuadre trae la sugerencia de R-RED (D-6 de 011) cuando la hay. Con eso se cubre el primer criterio de HU-25.
- D2 Ubicación de los formatos: 03 §11 los pone en `packages/sunat/formatos`, pero el backend debe prevalidar en línea (03 §7.3, respuesta 422) y no puede importar `@contapp/sunat`. Por eso las definiciones, la validación estructural y la serialización del TXT van en `packages/domain/src/formatos/`, que es pura. Solo el ZIP y el SHA-256 (que usan `fflate` y `node:crypto`) quedan en `packages/sunat/src/formatos/`. Se corrige 03.
- D3 Entrada `FilaReemplazo`: `{ id, estado: "original" | "modificada" | "agregada" | "excluida", identidad (tipo, serie, número, documento del proveedor, fecha), moneda, tipoCambio?, origenUsd?, montos: MontosComprobante }`. Parte de los campos de `FilaPropuestaSire` de 009 (provisional) y 014 la mapea desde sus versiones. Los textos que viajan al TXT (razón social, si la estructura oficial los pide) llegan como `string` y se validan, nunca se recortan en silencio.
- D4 Seguridad por construcción: `generarTxt` llama a `prevalidar` y lanza `ArchivoNoPrevalidadoError` si el resultado no es apto. No existe un camino que serialice filas no aptas. Las filas `excluida` no se prevalidan (no bloquean) y su trato en el TXT lo fija P-6.
- D5 Formatos versionados (RNF-043): la versión se elige por `vigenteDesde` ≤ periodo de la propuesta, y la más reciente gana. Si el periodo es anterior a toda versión, se lanza `FormatoNoVigenteError`. Un formato con `oficial: false` solo genera si quien llama pasa `permitirProvisional: true`, y el resultado sale marcado `provisional: true`. 012b bloquea los formatos provisionales en producción, como 009 D15 con los mocks.
- D6 Determinismo: las mismas filas, formato y cabecera dan exactamente los mismos bytes. Las líneas se ordenan de forma estable por fecha de emisión, tipo, serie y número, salvo que la estructura oficial exija otro orden. `empaquetar` recibe la fecha del ZIP como parámetro, sin `Date.now()`, y genera una sola entrada. El hash es SHA-256 en hexadecimal, del TXT y del ZIP.
- D7 Nombres: los componentes del nombre del TXT y del ZIP (RUC de 11 dígitos, periodo AAAAMM y los códigos que fije la estructura) se validan con una gramática estricta antes de armarlos. Sin `/`, `\`, `..` ni caracteres de control. El patrón del nombre lo da la versión del formato (P-2).
- D8 Montos: los montos salen de `Money.toString()` canónico, adaptado solo como lo pida la versión del formato (separador decimal, signo de las notas de crédito según D6 de 010). Ninguna ruta usa `number`.

## Criterios de aceptación
Los casos usan los fixtures de 009 (`fixtures/sire/20700000002-compras-202610.json`), mapeados a `FilaReemplazo`.
- [ ] CA-1 (HU-25, mixta): dada la propuesta del fixture sin corregir, cuando se prevalida, entonces `apto = false` y F001-2056 trae un error de IGV que dice «1.61 no es 18 % ni 10 % de 21.48». F001-1040 (San Juan, BI 770.00 con IGV 0.00) bloquea o solo avisa según P-3. Las filas F001-3064, F001-4062 y F001-5070 no tienen errores.
- [ ] CA-2: dadas las mismas filas tras aplicar las sugerencias de 011 (mixta 8.97 + 12.51; San Juan con ISC 770.00), cuando se prevalida, entonces `apto = true` y sin errores. `generarTxt` produce una línea por fila no excluida.
- [ ] CA-3 (cuadre): dada una fila con Σ componentes ≠ total por 0.01 (o por −0.01), entonces da error de cuadre con `diferencia` (total − Σ) y la sugerencia de R-RED. Con diferencia 0.00 no hay error (tolerancia 0.00, D2 de 010).
- [ ] CA-4 (USD, sintético): una fila USD sin tipo de cambio, con un TC de más de 3 decimales, en cero o negativo, o una fila PEN con `origenUsd` cuyos montos no coinciden con la conversión por componente (D7 de 010), da un error que nombra el campo. El caso real USD sigue diferido sin cifras, como en 010 y 011.
- [ ] CA-5 (estructura): un campo obligatorio vacío, una longitud mayor que la del formato, un RUC inválido, o un texto con el separador del formato, un salto de línea, un carácter de control o un carácter fuera de la codificación, dan error de estructura con el campo (o se tratan como diga P-5). Ningún texto se recorta en silencio.
- [ ] CA-6 (duplicados): el mismo comprobante (tipo, serie, número y documento del proveedor) dos veces entre las filas no excluidas da error en ambas.
- [ ] CA-7 (bloqueo por construcción, D4): `generarTxt` con filas no aptas lanza `ArchivoNoPrevalidadoError` y no devuelve bytes. Las filas excluidas no bloquean.
- [ ] CA-8 (RF-102): dados un conjunto original y uno vigente con N modificadas, M excluidas y K agregadas, `resumirCambios` da esos conteos y el impacto en IGV de P-4, exacto con `Money`. Una fila modificada y vuelta a sus montos originales no cuenta como modificada.
- [ ] CA-9 (determinismo y versiones, D5 y D6): dos llamadas con las mismas filas, en cualquier orden de entrada, dan los mismos bytes y el mismo SHA-256. Un periodo anterior a toda versión lanza `FormatoNoVigenteError`. Un formato `oficial: false` sin `permitirProvisional` no genera, y con él sale marcado `provisional: true`. Si hay dos versiones, la elección sigue `vigenteDesde`.
- [ ] CA-10 (ZIP, D6 y D7): `empaquetar` devuelve un ZIP con una sola entrada llamada `nombreTxt`, cuyo contenido descomprimido es idéntico al TXT, byte por byte. Los nombres cumplen el patrón de la versión y rechazan RUC o periodo mal formados, `../` y caracteres de control. Los hashes coinciden con un SHA-256 calculado aparte.
- [ ] CA-11: cobertura ≥ 90 % por archivo en `prevalidacion/` y `formatos/` de `packages/domain` y en `packages/sunat/src/formatos/`. El lint contra `number` cubre esas carpetas. `packages/domain` no importa `node:*`, BD, HTTP ni `@contapp/sunat`, y `apps/backend` no importa `@contapp/sunat`.
- [ ] Casos reales aplicables: mixta 21.48/1.61 (CA-1, CA-2), San Juan ISC (CA-1 según P-3, CA-2), redondeo USD (diferido, CA-4 sintético) y zapatilla (R-GP solo avisa y nunca bloquea, CA-1). Boleta 291: no aplica (013).

## Ataques obligatorios del adversario
Los catálogos «Dinero / reglas / prevalidación» y «Formatos TXT/ZIP» de 04 §2.3, más estos: medio centavo en el cuadre, notas de crédito con todos los tributos, USD con TC de 3 decimales y redondeos acumulados en 1.000 filas, filas excluidas que intentan colarse en el TXT, `generarTxt` con filas mutadas después de prevalidar, razón social con `|`, `\r\n`, NBSP, homoglifos, emojis o caracteres fuera de la codificación, longitudes en el borde exacto, periodo de otro año, nombres de archivo con `../`, y determinismo bajo permutación.

## Dependencias
- Specs: 010 (Money, cuadre, conversión), 011 (`evaluarReglas` y la sugerencia de R-RED), 009 (fixtures y `FilaPropuestaSire`). Consumidoras: 012b o 014 (persistencia y rutas), 015 (UI), 013 (ventas, según P-7).
- Externas: la estructura oficial del TXT de reemplazo y del nombre del ZIP (P-2). `fflate` en `packages/sunat`, que ya está en el monorepo por 007b.

## Preguntas abiertas
- **P-1 Corte de la spec.** Hoy no existen las tablas de comprobantes y versiones (014), ni `packages/storage`, y 012 va antes de 014 en el orden.
  - (a) Partir en dos. 012 queda como el núcleo puro de nivel A: prevalidación, resumen, formatos, TXT y ZIP. 012b, después de 014, trae `archivo_generado`, el storage, las rutas, el trabajo `archivo.generar`, las versiones y descarga (RF-103) y la UI (HU-25 y HU-26). Es el mismo patrón que 007a y 007b. **(Recom.)**
  - (b) Todo en 012, adelantando el modelo de comprobantes de 014.
  - (c) Reordenar: hacer 012 completa después de 014 y 015.
- **P-2 Estructura oficial del TXT y del ZIP.** `docs/` no fija los campos, su orden, el separador, la codificación, el fin de línea, el formato de montos y fechas ni el nombre del TXT y del ZIP.
  - (a) Construir ahora el motor versionado con una versión «provisional» marcada `oficial: false`, que no genera en producción (D5). La versión oficial se agrega cuando el usuario o el equipo entreguen el anexo vigente de SUNAT y un archivo de muestra aceptado (anonimizado). **(Recom.)**
  - (b) No aprobar 012 hasta tener la estructura oficial.
  - (c) Que el arquitecto investigue la documentación pública de SUNAT y proponga la estructura para que el usuario la valide antes del plan.
- **P-3 Qué bloquea la generación.** La documentación solo dice «estructura y cuadre de SUNAT»; la regla 10 de 01 §7 indica que un IGV que no cuadra sale «procesado con errores».
  - (a) Bloquean: la estructura del formato, el cuadre total = Σ (0.00), el IGV que no cuadra con 18 % ni 10 % (±0.01) en cualquier destino, una fila USD sin TC o con una conversión que no cuadra, y los duplicados. R-ISC (BI > 0 con IGV 0), R-NEW y R-GP solo avisan. **(Recom.)**
  - (b) Además de lo de (a), bloquea cualquier hallazgo de 011 sin resolver (incluidos R-ISC, R-NEW y R-GP).
  - (c) Solo bloquean la estructura y el cuadre total; el IGV que no cuadra solo avisa.
- **P-4 Impacto en IGV del resumen (RF-102).**
  - (a) La diferencia vigente − original del IGV por destino (DG, DGNG, DNG) y del total, sin aplicar prorrata (que es de R2). **(Recom.)**
  - (b) Solo la diferencia del IGV DG (el crédito fiscal directo).
- **P-5 Textos con caracteres que rompen el formato** (separador, saltos de línea, caracteres fuera de la codificación).
  - (a) Es un error de prevalidación y el contador corrige el texto, porque nunca se alteran datos en silencio. **(Recom.)**
  - (b) Se normalizan solos (reemplazo por espacio o transliteración) y se muestra un aviso.
- **P-6 Filas excluidas («No deducible», RF-066) en el TXT de reemplazo.** La documentación no dice si se omiten o se declaran con alguna marca.
  - (a) Lo fija la estructura oficial (P-2). Mientras tanto, el formato provisional las omite y el resumen las cuenta. **(Recom.)**
  - (b) Se omiten siempre del TXT.
  - (c) Se incluyen siempre, con la marca que defina la estructura oficial.
- **P-7 Ventas (RVIE) en 012.** RF-100 pide compras y ventas, pero las columnas de ventas se definen en 013 (D4 de 010).
  - (a) 012 cubre compras (RCE). 013 agrega el formato de ventas como otra entrada del mismo registro versionado, reutilizando la prevalidación genérica. **(Recom.)**
  - (b) Ambos libros en 012, con columnas de ventas provisionales.
- **P-8 Forzar la generación con errores.**
  - (a) No se puede: la fila se corrige o se excluye (lectura literal de RF-088). **(Recom.)**
  - (b) Un usuario con `sire.aprobar_generar` puede marcar la fila como «revisada, generar igual», con motivo y auditoría (017).
