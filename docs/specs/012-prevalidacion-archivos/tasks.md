# Tareas 012 · Prevalidación SUNAT, formatos TXT versionados y ZIP

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la indicada (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo de 04 §1.3: andamiaje, pruebas (rojo), ratificación, implementación (verde, con cobertura por archivo desde el diseño), integración, adversario (máximo 2 rondas, cada una en dos partes), verificación, revisión final y cierre. Se trabaja en la rama `spec/012-prevalidacion-archivos`. Los CA y las D están en `spec.md`; los contratos y decisiones técnicas, en `plan.md`. **012 no toca la BD**: ninguna tarea crea migraciones ni usa `withTenant`, y las pruebas corren sin PostgreSQL ni Redis (D9).

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Andamiaje: dependencias, cobertura y CI | devops | haiku | — | — | — | [x] |
| T2 | Pruebas de límites: lint de dinero e IO en las carpetas nuevas (rojo) | tester | sonnet | — ∥ T1 | ✓ | — | [x] |
| T3 | Pruebas de `texto/codificar` y `formatos/` (rojo) | tester | sonnet | — ∥ T2 | ✓ | — | [x] |
| T4 | Pruebas de `prevalidar` y del bloqueo de `generarTxt` (rojo) | tester | sonnet | — ∥ T3 | ✓ | — | [x] |
| T5 | Pruebas de `resumirCambios`, casos reales, fixture y `empaquetar` (rojo) | tester | sonnet | — ∥ T4 | ✓ | — | [x] |
| T6 | Ratificar los contratos que fijaron T2–T5 | arquitecto | opus | T2, T3, T4, T5 | — | — | [x] |
| T7 | Lint de dinero en `prevalidacion/` y `formatos/` | devops | haiku | T2, T6 ∥ T8 | ✓ | — | [x] |
| T8 | Implementar `texto/codificar`, `texto/entero` y `formatos/` (sin `generarTxt`) | backend | opus | T1, T3, T6 | ✓ | — | [x] |
| T9 | Implementar `prevalidar` y `generarTxt` | backend | opus | T4, T8 | ✓ | — | [x] |
| T10 | Implementar `resumirCambios` | backend | opus | T5, T9 | ✓ | — | [x] |
| T11 | Implementar `empaquetar` en sunat | backend | opus | T1, T5, T8 ∥ T9, T10 | ✓ | — | [x] |
| T12 | Integración: checks completos | devops | haiku | T7, T10, T11 | — | — | [x] |
| T13a | Ronda 1a: ataques de la spec (caja negra) | adversario | opus | T12 | — | ✓ | [x] |
| T13b | Ronda 1b: escenarios nuevos (caja blanca) | adversario | opus | T12 ∥ T13a | — | ✓ | [x] |
| T14 | Corregir hallazgos de la ronda 1 | backend | opus | T13a, T13b | — | — | [x] |
| T14a | Cerrar P-10 y P-11 (D21, D22) | backend | opus | T14 | — | — | [x] |
| T15a | Ronda 2a: regresión de las correcciones | adversario | opus | T14 | — | ✓ | [x] |
| T15b | Ronda 2b: escenarios nuevos contra las correcciones | adversario | opus | T14 ∥ T15a | — | ✓ | [ ] |
| T16 | Corregir hallazgos de la ronda 2 | backend | opus | T15a, T15b | — | — | [ ] |
| T17 | Verificar CA-1 a CA-11 y cobertura con evidencia | tester | sonnet | T16 | — | — | [ ] |
| T18 | Revisión final contra la spec | arquitecto | opus | T17 | — | — | [ ] |
| T19 | Cierre: tasks y commit (el orquestador actualiza ESTADO) | devops | haiku | T18 | — | — | [ ] |

Escalamientos: no hay ninguno previsto. T7 y T12 son mecánicas: si `haiku` falla una vez, pasan a `sonnet` (04 §3.3). Las rondas 2a y 2b se omiten si la ronda 1 no deja fallos nuevos (04 §2.3); en ese caso T15a, T15b y T16 se marcan «no aplica» y T17 depende de T14. Si T18 encuentra defectos, se añaden T18a (pruebas en rojo, tester sonnet) y T18b (corrección, backend opus).

Decisiones del usuario: el 2026-11-06 aprobó la spec y eligió (a), la opción recomendada, en P-1 a P-8 (D9 a D16 de `spec.md`).

Reglas comunes:
- Un commit por tarea, con Conventional Commits (`test(012): …`, `feat(012): …`, `fix(012): …`, `chore(012): …`) y el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push: lo hace el orquestador.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md`. Usar `git add <rutas>` explícitas, nunca `git add -A` ni `git add .`.
- `docs/specs/ESTADO.md` lo mantiene el orquestador. En esta rama solo lo tocan T13a–T15b (para anotar hallazgos, releyéndolo antes).
- Checks: responder solo los fallos (`archivo:línea · mensaje`), o «OK» con el conteo. Correr solo `@contapp/domain`, `@contapp/sunat` y `@contapp/tests-limites`. Las suites completas van en T12 y T17. Las pruebas de sunat importan `@contapp/domain` construido: antes, `pnpm --filter @contapp/shared build && pnpm --filter @contapp/domain build`.
- El tester no toca código de producción, salvo los stubs que fijan contratos. El backend no edita `*.spec.ts` ni `*.adv.spec.ts`: si necesita una prueba, la pide. El adversario solo escribe `*.adv.spec.ts`.
- Ningún `number` para montos. En `prevalidacion/` y `formatos/`, nunca la palabra `number` (conteos con `Entero`, ver plan). En pruebas, `x as unknown as string`, no `as any`. Montos solo con la API pública de 010; nunca `decimal.js` fuera de `dinero/decimal.ts`.
- No modificar `dinero/`, `comprobante/`, `reglas/` ni `texto/{normalizar,diccionario}.ts`, salvo por un error demostrado con una prueba (anotarlo en la tarea y avisar al orquestador). Las pruebas de 010 y 011 siguen en verde.
- Toda dependencia nueva lleva versión exacta (sin `^`) y se publicó hace al menos 2 semanas. Solo se admite `fflate@0.8.2`, que ya está en el lockfile, y `@contapp/shared` del workspace.
- Nunca se baja el umbral de cobertura ni se excluyen archivos. Si faltan ramas, se crea una subtarea para el tester y otra para el backend.
- Ningún dato real de contribuyentes: solo los fixtures sintéticos de 009 y cifras sintéticas.
- Escalar según 04 §3.3 y anotarlo arriba. Una ambigüedad que cambie la spec no se decide: se marca `requiere usuario` y se informa al orquestador.

## T1 · Andamiaje (devops · haiku)
- **Contexto (leer solo esto)**: `plan.md` (Archivos; Decisiones: Lint y cobertura), `packages/domain/package.json`, `packages/domain/vitest.cobertura.config.mts`, `packages/sunat/package.json`, `package.json` (scripts `cobertura:*`), `.github/workflows/ci.yml` (paso «Cobertura de @contapp/domain»).
- **Hacer**:
  1. Agregar `"@contapp/shared": "workspace:*"` a `dependencies` de domain.
  2. Cambiar `cobertura:dominio` por `pnpm --filter @contapp/shared build && pnpm --filter @contapp/domain test:cobertura`.
  3. Agregar `src/prevalidacion/**/*.ts` y `src/formatos/**/*.ts` al `include` de cobertura de domain y actualizar el comentario (010, 011 y 012).
  4. En sunat, agregar `"fflate": "0.8.2"` a `dependencies` y crear `vitest.cobertura.config.mts`, copia del de domain con `include: ["src/formatos/**/*.ts"]`. Agregar el script `test:cobertura`.
  5. Agregar en la raíz `cobertura:sunat` (construye shared y domain, luego `pnpm --filter @contapp/sunat test:cobertura`) y su paso de CI después del de domain.
  6. `pnpm install`.
- **Hecho cuando**: `pnpm install --frozen-lockfile` pasa después de commitear el lockfile. `pnpm cobertura:dominio` y `pnpm cobertura:sunat` salen 0, porque las carpetas aún no existen. Un `src/formatos/__tmp.ts` sin pruebas hace fallar cada script por ese archivo; después se borra. Commit `chore(012): dependencias y cobertura de prevalidación, formatos y empaquetado`.
- **Resultado**: hecho en una copia limpia de HEAD + T1, porque el árbol compartido tiene specs rojos de T3 en curso. `pnpm install --frozen-lockfile` OK; el lock suma `@contapp/shared` en domain y `fflate` 0.8.2 en sunat. `cobertura:dominio` y `cobertura:sunat` salen 0; con `src/formatos/__tmp.ts` sin pruebas, cada uno falla por ese archivo (borrado). Lint y typecheck de domain y sunat OK. Desvíos: (a) el `vitest.cobertura.config.mts` de sunat usa `src/**/*.spec.ts` sin `*.int.spec.ts`, no `tests/**` (no existe en sunat); (b) pnpm pasó el peer `jsdom` de `@vitest/coverage-v8@5.0.5(vitest@5.0.5)` de 30.1.3 a 30.1.2 (ambos ya estaban en el lock); (c) `@vitest/coverage-v8` no hace falta en sunat, resuelve sin declararlo. (d) En el árbol compartido, `cobertura:dominio` y el typecheck de domain fallan solo por los specs rojos de T3 (`src/formatos/{campos,nombres,provisional,registro}.spec.ts`, `src/texto/codificar.spec.ts`, `tests/ayudas/formatos.ts`), no por T1.

## T2 · [x] Pruebas de límites, rojo (tester · sonnet) ∥ T1
- **Contexto (leer solo esto)**: `spec.md` (CA-11), `plan.md` (Decisiones: Lint y cobertura), `tests/limites/dominio-reglas.spec.ts` (patrón completo).
- **Hacer**: `tests/limites/dominio-prevalidacion.spec.ts`.
  1. Con `filePath` en `packages/domain/src/{prevalidacion,formatos}/__prueba__.ts` deben fallar: `let x: number`, `parseFloat("1")`, `Number("1")`, `Math.round(1)`, `+s`, `d.toNumber()`, `import Decimal from "decimal.js"`, `import "node:crypto"`, `import "@contapp/sunat"`, `TextEncoder` y `fetch("x")`.
  2. El mismo código en `__prueba__.spec.ts` pasa el lint de dinero.
  3. `import type { Entero } from "../texto"` pasa.
  4. En `apps/backend/src/__prueba__.ts`, `import "@contapp/sunat"` falla.
  5. En `packages/sunat/src/formatos/__prueba__.ts`, `import { createHash } from "node:crypto"` pasa.
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` falla solo en los casos de dinero de las carpetas nuevas, que cubrirá T7. Si `TextEncoder` no está prohibido hoy, queda anotado como caso que cubre T7. Los demás archivos siguen en verde. Commit `test(012): lint de dinero e IO en prevalidación y formatos (rojo)`.
- **Resultado**: `tests/limites/dominio-prevalidacion.spec.ts`, 42 pruebas (2 carpetas x 20, más 2 de fronteras). Rojo: 14 fallan (7 de dinero y `TextEncoder` en `prevalidacion/` y en `formatos/`), que cubre T7. El resto (decimal.js, node:crypto, @contapp/sunat, fetch, specs, Entero, backend sin sunat, sunat con node:crypto) ya pasa. **Nota para T7**: `TextEncoder` NO está prohibido hoy; agregar `TextEncoder` y `TextDecoder` a `GLOBALES_IO_DOMINIO`. Los demás archivos de tests-limites siguen en verde (12 de 13).

## T3 · [x] Pruebas de texto/codificar y formatos/, rojo (tester · sonnet) ∥ T2
- **Contexto (leer solo esto)**: `spec.md` (D2, D5–D8, D10, D13, D14; CA-5, CA-9, CA-10 en la parte de nombres), `plan.md` (Contratos: `formatos/`; Decisiones: Formato provisional RCE, Caracteres, generarTxt), `packages/domain/src/texto/index.ts`, `packages/domain/tests/ayudas/comprobante.ts`.
- **Hacer**: `packages/domain/src/texto/codificar.spec.ts`, que prueba `ascii`, `latin1` y `utf8` byte por byte (ñ, tildes, `€` fuera de latin1, sustitutos sueltos, emoji) y que lanza si un carácter queda fuera. `packages/domain/src/formatos/{registro,campos,nombres,provisional}.spec.ts` contra `../index`, que prueban:
  - `RegistroFormatos.desde`: rechaza id y versión repetidos, `vigenteDesde` mal formado o fuera de rango, un separador dentro del conjunto de caracteres y un campo sin nombre.
  - `seleccionarFormato` con dos versiones: el periodo anterior lanza `FormatoNoVigenteError`, el borde exacto elige la nueva y un periodo de otro año elige por `vigenteDesde`.
  - El provisional es `oficial: false` y está congelado.
  - `validarNombreArchivo`: rechaza `../`, `/`, `\`, controles, RUC de 10 o 12 dígitos y periodo `202613`.
  - Los nombres del provisional son exactos.
  
  Si hacen falta stubs para compilar, que lancen «no implementado».
- **Hecho cuando**: `pnpm --filter @contapp/domain test` falla solo por falta de implementación. Commit `test(012): codificación y registro de formatos versionados (rojo)`.
- **Resultado**: Rojo: 5 archivos fallan (27 pruebas de `texto/codificar.spec.ts` y las 4 suites de `formatos/`, que no cargan porque `codificar`, `RegistroFormatos`, `seleccionarFormato`, etc. no existen); las otras 43 suites de domain siguen en verde. Sin stubs (restricción del orquestador: nada de código de producción), por lo que `pnpm --filter @contapp/domain typecheck` queda en rojo hasta T8. Ayuda nueva: `tests/ayudas/formatos.ts`. **Contratos fijados que T6 debe ratificar**: (1) `codificar(texto, 'ascii'|'latin1'|'utf8'): Uint8Array`, lanza si no cabe, exportado desde `src/index.ts`; (2) `validarCampo(valor, campo, formato): {codigo, posicion} | null` (nombre y forma inventados; posición = índice UTF-16 desde 0; `null` = válido); (3) nombres de los 21 campos del provisional (`periodo, tipoComprobante, serie, numero, fechaEmision, tipoDocProveedor, numeroDocProveedor, razonSocial, moneda, tipoCambio`, las 10 columnas de `COLUMNAS_COMPRA`, `total`) y sus longitudes (6/2/4/8/10/1/15/100/3); (4) `validarNombreArchivo` acepta solo `CONTAPP-PROVISIONAL-{11 dígitos}-{AAAAMM, mes 01-12}-RCE.{txt|zip}` y `nombre()` lanza `NombreArchivoInvalidoError` con componentes malos; (5) 'separador dentro del conjunto de caracteres' se probó como: separador de 1 carácter imprimible y ningún `patron` de campo que acepte el separador; además `desde` rechaza nombres de campo repetidos, campos vacíos, `longitudMax <= 0`, codificación o fin de línea desconocidos; (6) `seleccionarFormato` con libro inexistente lanza `FormatoNoVigenteError` y con periodo mal formado lanza algún `FormatosError`; (7) los códigos de error solo se exigen con forma `/^[A-Z_]+$/` y mensajes sin valores.

## T4 · [x] Pruebas de prevalidar y del bloqueo de generarTxt, rojo (tester · sonnet) ∥ T3
- **Contexto (leer solo esto)**: `spec.md` (D1, D3–D8, D11, D13, D14, D16; CA-3 a CA-7, CA-9), `plan.md` (Contratos: `prevalidacion/` y `generarTxt`; Decisiones: Caracteres, Errores frente a excepciones, Orden de prevalidar, Explicaciones, generarTxt), `packages/domain/tests/ayudas/{comprobante,filas}.ts`, `packages/domain/src/reglas/index.ts` (solo los tipos exportados).
- **Hacer**: `packages/domain/tests/ayudas/filas-reemplazo.ts` (constructor de `FilaReemplazo` y cabecera válida). `packages/domain/src/prevalidacion/{estructura,aritmetica,duplicados,prevalidar}.spec.ts` y `src/formatos/generar.spec.ts`, que cubren:
  - CA-3: ±0.01, 0.00, con `diferencia` y la sugerencia de R-RED si se pasan `reglas`.
  - IGV: a 18 % y a 10 % en el borde de ±0.01 en cada destino, BI 0 con IGV > 0, signos distintos y la explicación exacta.
  - CA-4: USD sin TC, TC `3.3001`, `0.000` y `-3.300`, y PEN con `origenUsd` descuadrado.
  - CA-5: campo obligatorio vacío, longitud máxima y máxima + 1, RUC con dígito verificador malo, `|`, `\r`, `\n`, `\t`, U+0000, U+0085, NBSP, U+0301, emoji y `Ꭺ`; ninguno se recorta. También fecha imposible y fecha posterior al periodo.
  - CA-6: duplicado con ceros a la izquierda y serie en minúsculas, con error en ambas. Si una de las copias está excluida, no hay error.
  - Excluidas: no bloquean.
  - `SIN_FILAS`.
  - Errores frente a excepciones: un tipo no string, montos falsos, `__proto__`, ids repetidos y `estado` desconocido.
  - La propiedad «mismos errores con o sin `reglas`».
  - Los avisos R-ISC, R-NEW y R-GP no bloquean.
  - Sin mutación de la entrada.
  - CA-7: `ArchivoNoPrevalidadoError` sin bytes; una fila con getter que cambia de valor tras la primera lectura no se cuela.
  - CA-9: `FormatoProvisionalError` sin `permitirProvisional`; con él, `provisional: true`; las mismas filas permutadas dan los mismos bytes (fast-check); una línea por fila no excluida.
- **Hecho cuando**: igual que T3. Commit `test(012): prevalidación y bloqueo de la generación (rojo)`.
- **Resultado**: Rojo: `prevalidar`, `generarTxt` y sus errores no existen (el resto de suites de domain sigue en verde). Archivos: `prevalidacion/{estructura,aritmetica,duplicados,prevalidar}.spec.ts`, `formatos/generar.spec.ts` y `tests/ayudas/filas-reemplazo.ts` (cabecera, `filaReemplazo`, fixture de 009 y su versión corregida, decodificación latin1). Cubren CA-3 a CA-7 y CA-9, D17 y la propiedad con/sin `reglas` (oráculo en centavos para cuadre e IGV, fast-check SEMILLA 20261025). **Ambigüedades que T6 debe ratificar**: (1) IGV exactamente 0.00 con base != 0 NO es error IGV (si no, San Juan bloquearía y contradiría CA-1; coincide con R-MIX/R-ISC que parten de IGV != 0); (2) RUC del declarante con dígito verificador malo es un error `RUC_INVALIDO` con `filaId: null` y `campo: 'rucDeclarante'` (no excepción); cabecera con forma mala sí lanza `EntradaPrevalidacionInvalidaError`; (3) nombres de `campo` de los errores = nombres del provisional (T3) y `CONVERSION_USD` usa `campo: 'origenUsd'`; (4) TC '' (cadena vacía) es `TC_INVALIDO`, no `USD_SIN_TC` (solo `null` es 'sin TC'); (5) `ArchivoNoPrevalidadoError.resultado` guarda el `ResultadoPrevalidacion`; (6) el error DUPLICADO va en todas las copias no excluidas y la clave incluye tipo y número del documento del proveedor; (7) las reglas no se evalúan en filas excluidas ni en filas con error de estructura, y una fila excluida con forma imposible igual lanza; (8) fecha anterior al periodo (otro mes o año) es válida; (9) un periodo sin formato vigente propaga `FormatoNoVigenteError` desde `prevalidar` y `generarTxt`; (10) línea del provisional: `periodo|tipo|serie|numero|DD/MM/AAAA|tipoDoc|numDoc|razon|moneda|TC|10 columnas|total` con CRLF final, TC con 3 decimales, número tal como llega; (11) 'cada campo se lee una sola vez' se prueba con getters que cuentan lecturas (exactamente 1).

## T5 · [x] Pruebas de resumen, casos reales, fixture y ZIP, rojo (tester · sonnet) ∥ T4
- **Contexto (leer solo esto)**: `spec.md` (D6, D7, D12, D14; CA-1, CA-2, CA-8, CA-10; Casos reales), `plan.md` (Contratos; Decisiones: resumirCambios, empaquetar, Pruebas), `fixtures/sire/20700000002-compras-202610.json`, `packages/sunat/src/mock/sire-api-client.mock.ts` (solo la firma), `packages/domain/tests/casos-reales/reglas.spec.ts` (patrón).
- **Hacer**:
  1. `packages/domain/src/prevalidacion/resumen.spec.ts`, para CA-8: N modificadas, M excluidas y K agregadas; una fila modificada y vuelta a sus montos originales no cuenta; `excluida` gana a `modificada`; impacto por destino y total exacto, también con notas de crédito; USD convertida y USD sin TC en `filasSinConvertir`; id original ausente lanza.
  2. `packages/domain/tests/casos-reales/prevalidacion.spec.ts`, con las cifras del fixture copiadas a mano:
     - CA-1: F001-2056 con «1.61 no es 18 % ni 10 % de 21.48»; F001-1040 solo con el aviso R-ISC; 3064, 4062 y 5070 sin errores.
     - CA-2: mixta 8.97 + 12.51 y San Juan con ISC 770.00 dan `apto` y 5 líneas.
     - Zapatilla: R-GP solo avisa.
     - `it.todo` del redondeo USD.
  3. `packages/sunat/src/formatos/fixture-012.spec.ts`: lee el JSON real y repite las conclusiones de CA-1 y CA-2 vía `@contapp/domain`.
  4. `packages/sunat/src/formatos/empaquetar.spec.ts`, para CA-10: una entrada llamada `nombreTxt`; `unzipSync` idéntico al TXT; los SHA-256 coinciden con `createHash` calculado aparte; la misma fecha da el mismo ZIP; rechaza nombres con `../` o controles y un `nombreZip` que no corresponde.
- **Hecho cuando**: las pruebas de domain y sunat fallan solo por falta de implementación. Commit `test(012): resumen de cambios, casos reales y empaquetado (rojo)`.
- **Resultado**: Rojo: domain 12 suites fallan en total (T3 a T5; las otras 43 siguen en verde) y sunat 2 (`empaquetar.spec.ts`: módulo `./index.js` inexistente; `fixture-012.spec.ts`: `prevalidar` aún no existe en el `dist` de domain). Archivos: `prevalidacion/resumen.spec.ts` (CA-8, con propiedad de oráculo en centavos), `tests/casos-reales/prevalidacion.spec.ts` (CA-1, CA-2 con las sugerencias reales de 011 aplicadas, zapatilla, San Juan, `it.todo` del redondeo USD), `sunat/src/formatos/fixture-012.spec.ts` (lee el JSON real; las cifras de `tests/ayudas/filas-reemplazo.ts` se verificaron contra él) y `sunat/src/formatos/empaquetar.spec.ts` (CA-10). **Ambigüedades que T6 debe ratificar**: (1) `resumirCambios` cuenta por el `estado` de la fila vigente; la fecha de emisión forma parte de la identidad (D3); un TC escrito distinto pero del mismo valor ('3.3' vs '3.300') NO se probó (queda para el adversario); (2) `filasSinConvertir` sin repetir y ordenada por unidades de código, e incluye ids de filas USD sin TC válido tanto del original como del vigente, pero no se fijó qué pasa con una excluida sin TC; (3) `impactoIgv.total` = DG + DGNG + DNG; (4) `modificada` cuyo id no está en el original no se probó; (5) `empaquetar` se importa de `./index.js` (`formatos/index`), lanza `EmpaquetadoInvalidoError` con `codigo` /^[A-Z_]+$/ ante nombres inválidos, no-Uint8Array, fecha inválida o no-Date, y no valida el año de la fecha (fflate exige >= 1980: queda para el adversario); (6) dependencia de huso horario: fflate escribe el sello DOS en hora local, la prueba de determinismo asume el mismo huso en las dos llamadas; (7) `fixture-012.spec.ts` queda rojo hasta T9 (necesita domain construido) y la parte de ZIP de extremo a extremo (generarTxt a empaquetar) no se incluyó para no atarla a T11.
- **Corrección posterior (zapatilla)**: 3 pruebas del bloque «gasto personal» fallaban porque `conGlosa` usa el proveedor `PROV` (20100070970), ausente de `proveedoresConocidos`, y R-NEW añadía un aviso; se declara conocido solo en ese bloque (`prevZ`, sin tocar `REGLAS`), y las aserciones (apto, sin errores, un único aviso R-GP) no cambian. Spec en verde: 16 pruebas + 1 `it.todo`.

## T6 · [x] Ratificar contratos (arquitecto · opus)
- **Contexto (leer solo esto)**: `plan.md`, los `*.spec.ts` y stubs de T2 a T5 (solo sus firmas y aserciones de contrato).
- **Hacer**: comparar lo que fijaron las pruebas con los Contratos del plan. Si hubo diferencias, registrarlas en `plan.md`, Decisiones, «Ratificación de contratos», o pedir al tester que ajuste la prueba. Ninguna ratificación puede cambiar un CA ni una D sin el usuario.
- **Hecho cuando**: el plan y las pruebas coinciden y quedan anotadas las desviaciones aceptadas. Commit `docs(012): ratificación de contratos tras las pruebas en rojo`.
- **Resultado**: las 15 ambigüedades de T3–T5 quedan ratificadas en `plan.md`, Decisiones, «Ratificación de contratos (T6)», puntos 1 a 15, y en Contratos (`validarCampo`, `codificar` y `CaracterNoCodificableError`, los códigos exactos de cada error y TC `null` en PEN). Ninguna prueba se corrigió por estar mal. Se agregaron pruebas marcadas «T6» para fijar lo que quedaba abierto, y todas siguen en rojo solo por falta de implementación:
  - `campos.spec`: precedencia de `validarCampo`.
  - `registro.spec`: patrón con `g`/`y` y separador letra, dígito, `.`, `-`, `/` o espacio.
  - `provisional.spec`: patrones alineados con 011; `tipoCambio` 8 y montos 16.
  - `aritmetica.spec`: PEN con TC → `TC_INVALIDO`; `origenUsd` descuadrado → `CONVERSION_USD`, sin lanzar.
  - `prevalidar.spec`: `filaId: null` primero.
  - `resumen.spec`: razón social cuenta como cambio, TC por valor, `original` con cambios cuenta, USD descuadrada → `filasSinConvertir`, excluida sin TC, id ausente no agregado lanza, original con estado distinto lanza.
  - `sunat/empaquetar.spec`: sello DOS en UTC, independiente del huso, y fecha fuera del rango DOS.

  Correcciones respecto de lo que proponía el tester (ninguna contradice sus pruebas):
  - (a) En `resumirCambios`, `original` y `modificada` cuentan igual si difieren, y la razón social forma parte de la comparación.
  - (b) `FormatoProvisionalError` se lanza antes de prevalidar.
  - (c) `seleccionarFormato` con un periodo mal formado lanza `FormatoNoVigenteError`, para mantener cerrada la lista de errores.
  - (d) El ZIP no depende del huso horario del worker; el tester lo había dejado como supuesto.

  Notas para 014: mapear `tipoCambio: null` en las filas PEN, porque si no, bloquean con `TC_INVALIDO`; y quitar, no marcar `excluida`, una fila agregada que luego se descarta. Nota para 012b: pasar siempre `reglas`, para que una base gravada con IGV 0.00 traiga el aviso R-ISC.
  - **P-9 · requiere usuario** (riesgo a aceptar, no bloquea T7–T11): con el punto 1, ninguna fila con IGV 0.00 bloquea, aunque tenga base gravada; por ejemplo, BI DG 1000.00 con IGV 0.00 por olvido. Solo avisa R-ISC, y solo si se pasan `reglas`. No sabemos si SUNAT marca esa fila como error hasta tener el anexo oficial (D10). **(a) (Recom.)** Aceptarlo como dicen CA-1 y D11, y revisarlo al agregar la versión oficial. (b) Bloquearla y que el contador mueva la base (a ISC o a no gravado, como sugiere R-ISC). Eso cambia CA-1, porque San Juan bloquearía, y hay que reabrir la spec.

## T7 · [x] Lint de dinero en las carpetas nuevas (devops · haiku) ∥ T8
- **Contexto (leer solo esto)**: `plan.md` (Decisiones: Lint y cobertura), `eslint.config.mjs` (bloque «Dinero (spec 010/011, CA-1)» y `GLOBALES_IO_DOMINIO`), `tests/limites/dominio-prevalidacion.spec.ts`.
- **Hacer**:
  1. Agregar `packages/domain/src/prevalidacion/**` y `packages/domain/src/formatos/**` a `files` de ese bloque.
  2. Cambiar los mensajes a «spec 010/011/012».
  3. Si T2 lo dejó anotado, agregar `TextEncoder` y `TextDecoder` a `GLOBALES_IO_DOMINIO`.
  
  No tocar otros bloques.
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` queda en verde y `pnpm lint` no da errores nuevos. Commit `chore(012): lint contra number en prevalidación y formatos`.
- **Resultado**: en `eslint.config.mjs` solo cambió lo de T7. `GLOBALES_IO_DOMINIO` suma `TextEncoder` y `TextDecoder`. El bloque «Dinero» suma `packages/domain/src/prevalidacion/**` y `packages/domain/src/formatos/**` a `files`, y su comentario y mensaje dicen «spec 010/011/012». `pnpm --filter @contapp/tests-limites test`: 13 de 13 archivos y 329 de 329 pruebas en verde (antes fallaban 14, todas de `dominio-prevalidacion.spec.ts`). `pnpm lint`: 9 de 9 paquetes OK, ejecutados sin caché y sin errores. Ningún archivo de `packages/domain` usa `TextEncoder` ni `TextDecoder` en código, así que la prohibición no rompe nada.

## T8 · [x] Implementar codificación y formatos (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: `formatos/` y `texto/`; Decisiones: Formato provisional RCE, Caracteres, Lint y cobertura, Ratificación de contratos 2–6, 11 y 15), `spec.md` (D2, D5–D8, D10), `packages/domain/src/texto/index.ts`, `packages/domain/src/reglas/errores.ts` (patrón de errores con `codigo`), los specs de T3.
- **Hacer**:
  - `texto/{codificar,entero}.ts`.
  - `formatos/{tipos,errores,registro,provisional-rce,campos,nombres,index}.ts`: la validación de un valor contra un `CampoTxt` (devuelve el código y la posición, sin lanzar) y `RUC` con `validarRuc` de `@contapp/shared`.
  - Dejar los stubs de `serializar.ts` que necesite T9.
  - Exportar todo desde `src/index.ts`.
- **Hecho cuando**: los specs de T3 pasan, la cobertura de esos archivos es ≥ 90 % y `pnpm --filter @contapp/domain lint typecheck` queda limpio. Commit `feat(012): codificación y registro de formatos TXT versionados`.
- **Resultado**: los 5 specs de T3 (y los casos «T6») pasan: 173 pruebas. Archivos: `texto/{codificar,entero}.ts` (+ `texto/index.ts`), `formatos/{tipos,errores,registro,provisional-rce,campos,nombres,index}.ts` y el export en `src/index.ts`. Cobertura con los specs de T3: 100 % en todo, salvo ramas de `campos.ts` (96,4 %) y `registro.ts` (94,6 %); `pnpm cobertura:dominio` sale 1 sin tabla por las suites rojas de T4/T5. Lint OK; `tsc -p tsconfig.build.json` OK; el typecheck completo falla solo en specs de T4/T5 y `tests/ayudas/filas-reemplazo.ts`. Desvíos: (a) `FormatoProvisionalError`, `ArchivoNoPrevalidadoError` y `serializar.ts` quedan para T9: sin `generarTxt` no se prueban y bajarían la cobertura de funciones; (b) `RegistroFormatos.desde` rechaza además dos versiones del mismo libro con el mismo `vigenteDesde`, porque si no, la elección dependería del orden (CA-9); (c) el `patron` de los campos registrados es un getter que da una `RegExp` nueva en cada lectura, y `validarCampo` siempre usa una copia, así que `compile` o `lastIndex` no lo alteran; (d) `esEnteroPositivo` vive en `texto/entero.ts`, fuera del lint, para validar `longitudMax` sin escribir `number`; (e) **pide prueba**: `src/ronda2b.adv.spec.ts` (R2b-1) fija la superficie pública exacta de 011 y ahora falla por los exports nuevos que exige el plan (`codificar`, `CaracterNoCodificableError`, `RegistroFormatos`, `REGISTRO_FORMATOS`, `seleccionarFormato`, `validarCampo`, `validarNombreArchivo` y los errores de formatos). Hay que ampliar su lista, sin cambiar nada más (adversario o tester).

## T9 · [x] Implementar prevalidar y generarTxt (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: `prevalidacion/` y `generarTxt`; Decisiones: Errores frente a excepciones, Orden de prevalidar, Explicaciones, generarTxt, Ratificación de contratos 1, 3, 4 y 6–12, 15), `spec.md` (D1, D3, D4, D6, D11, D13, D14, D16), `packages/domain/src/{dinero,comprobante,reglas}/index.ts`, `packages/domain/src/reglas/entrada.ts` (patrón de entrada estricta), los specs de T4.
- **Hacer**:
  - `prevalidacion/{tipos,errores,entrada,estructura,aritmetica,duplicados,explicaciones,prevalidar,index}.ts`.
  - `formatos/serializar.ts` con `generarTxt`: copia congelada leída una vez, `seleccionarFormato`, `prevalidar`, orden estable y codificación.
  - Reutilizar `verificarCuadre`, `igvCuadra`, `convertirAPen`, `TipoCambio.desde` y `evaluarReglas` sin reimplementarlos.
- **Hecho cuando**: los specs de T4 y la parte de CA-1 y CA-2 de domain pasan, la cobertura es ≥ 90 % por archivo, y lint y typecheck quedan limpios. Las pruebas de 010 y 011 siguen en verde. Commit `feat(012): prevalidación SUNAT y generación del TXT bloqueada por construcción`.
- **Resultado**: los 5 specs de T4 (y los casos «T6») pasan, así como CA-1, CA-2 y San Juan de `tests/casos-reales/prevalidacion.spec.ts`; 010 y 011 siguen en verde, y `sunat/src/formatos/fixture-012.spec.ts` pasa (5 de 5) con domain construido. Archivos: `prevalidacion/{tipos,errores,entrada,estructura,aritmetica,duplicados,explicaciones,prevalidar,index}.ts`, `formatos/serializar.ts` (`generarTxt`), `FormatoProvisionalError` y `ArchivoNoPrevalidadoError` en `formatos/errores.ts`, y los exports. Pruebas propias de bordes: `prevalidacion/bordes.spec.ts` y `formatos/serializar.spec.ts` (25). Cobertura por archivo ≥ 90 % en las cuatro métricas; la más baja es la de ramas de `prevalidar.ts`, con 91,4 %. Se midió sin `resumen.spec`, `ronda2b.adv.spec` ni los casos reales, que siguen en rojo. Lint OK; `tsc -p tsconfig.build.json` OK; el typecheck completo falla solo por `resumen.spec.ts` (T10). Rojo que queda: `resumen.spec.ts` (T10), `ronda2b.adv.spec.ts` (T12) y 3 pruebas de zapatilla en los casos reales.
  - **Prueba que parece incorrecta (no tocada)**: en `tests/casos-reales/prevalidacion.spec.ts`, «caso real: gasto personal…» (3 pruebas), `REGLAS.proveedoresConocidos` solo trae los 5 proveedores del fixture, pero `conGlosa` usa el proveedor por defecto 20100070970. Por eso `evaluarReglas` da además un R-NEW legítimo: las pruebas esperan solo R-GP (o ningún aviso con «zapata»). Corrección sugerida al tester: agregar `PROV` a `proveedoresConocidos`.
  - **Desvíos**:
    - (a) «Filas generables» = no excluidas, más las excluidas si `formato.incluyeExcluidas`. Con un formato que incluye las excluidas, esas filas se prevalidan, cuentan para `SIN_FILAS` y para duplicados, y pasan a reglas: van al TXT y no pueden romperlo. Con el provisional nada cambia (D4, D14).
    - (b) Contexto y opciones: `reglas`, `registro` y `permitirProvisional` con valor `undefined` cuentan como ausentes, y lo mismo `xml` y `razonSocial`. Un contexto u opciones con forma mala lanzan `EntradaPrevalidacionInvalidaError`, y unas `reglas` malas lanzan `EntradaReglasInvalidaError` de 011, sin envolverlo.
    - (c) El XML se valida con la misma forma que exige `evaluarReglas`, también sin `reglas`, para que la forma no dependa de ellas.
    - (d) Un campo del formato sin valor conocido lanza `DefinicionFormatoInvalidaError` en `generarTxt`, no en `prevalidar`.
    - (e) `generarTxt` no pasa `reglas` a `prevalidar`.
    - (f) Una suma fuera de NUMERIC(14,2) da `CUADRE` con `diferencia: null`, y una conversión de `origenUsd` fuera de rango da `CONVERSION_USD`.
    - (g) `DUPLICADO` lleva `campo: null`.

## T10 · [x] Implementar resumirCambios (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: `ResumenCambios`; Decisiones: resumirCambios, Ratificación de contratos 13), `spec.md` (D12, D14; CA-8), `packages/domain/src/prevalidacion/{tipos,entrada}.ts`, `packages/domain/src/prevalidacion/resumen.spec.ts`.
- **Hacer**: `prevalidacion/resumen.ts` y su export.
- **Hecho cuando**: `resumen.spec.ts` pasa, la cobertura es ≥ 90 % y lint y typecheck quedan limpios. Commit `feat(012): resumen de cambios con impacto en IGV por destino`.
- **Resultado**: `prevalidacion/resumen.ts` (`resumirCambios`), `ResumenCambios` en `tipos.ts` y ambos exportados desde `prevalidacion/index.ts`; `tipoCambioDe` de `aritmetica.ts` pasa a exportarse para reusarlo. `resumen.spec.ts`: 43 de 43 en verde (incluidas las «T6»). Domain: 56 suites en verde; solo falla `ronda2b.adv.spec.ts` (R2b-1, lista de exports, T12). Cobertura de `resumen.ts`: 98,6 % sentencias, 97,8 % ramas, 100 % funciones y líneas. Typecheck completo de domain, `tsc -p tsconfig.build.json` y lint OK.
  - **Desvíos**:
    - (a) El TC se compara por valor completando con ceros a 3 decimales como texto (la gramática de `TipoCambio` no admite ceros a la izquierda), sin `number` ni `decimal.js`.
    - (b) Una USD cuya conversión sale de NUMERIC(14,2) también va a `filasSinConvertir`, igual que la descuadrada.
    - (c) El impacto se suma con un solo `Money.suma` por destino y otro para el total, con las originales negadas: el rango solo se comprueba en el resultado; si este sale de NUMERIC(14,2), `MontoFueraDeRangoError` de 010 se propaga.
    - (d) Commit `feat(012): resumen de cambios`, como pidió el orquestador.

## T11 · [x] Implementar empaquetar (backend · opus) ∥ T9, T10
- **Contexto (leer solo esto)**: `plan.md` (Contratos: `@contapp/sunat`; Decisiones: empaquetar, Ratificación de contratos 14), `spec.md` (D6, D7; CA-10), `packages/sunat/src/index.ts`, `packages/sunat/src/errores.ts` (patrón), `packages/sunat/src/formatos/empaquetar.spec.ts`.
- **Hacer**: `packages/sunat/src/formatos/{empaquetar,index}.ts` y su export desde `src/index.ts`. Usar `validarNombreArchivo` de `@contapp/domain`, sin una gramática propia.
- **Hecho cuando**: `empaquetar.spec.ts` pasa, `pnpm cobertura:sunat` sale 0 y lint y typecheck de sunat quedan limpios. `fixture-012.spec.ts` puede seguir en rojo hasta T9. Commit `feat(012): empaquetado ZIP en memoria con SHA-256`.
- **Resultado**: `src/formatos/{empaquetar,index}.ts` y export en `src/index.ts`; sin dependencias nuevas (`fflate` 0.8.2 ya estaba). Valida los nombres con `validarNombreArchivo` de domain y que `nombreZip` sea el base de `nombreTxt` (`.txt`) + `.zip`. Sello DOS con los campos UTC (Ratificación 14): fflate escribe la hora local y su rango termina en 2099, así que recibe una fecha fija y después se reescriben hora y fecha en la cabecera local y en la del directorio central; el rango aceptado es 1980–2107 UTC. `empaquetar.spec.ts`: 32 de 32 en verde (incluidas las «T6»); cobertura de `formatos/` 100 % en las cuatro métricas; lint de sunat OK. Pendiente de T9: `fixture-012.spec.ts` sigue en rojo (`prevalidar` no está en el `dist` de domain; T9 aún no había empezado), por eso `pnpm cobertura:sunat` y el typecheck de sunat fallan solo por ese archivo (10 de 11 suites y 190 pruebas en verde). Desvío: el commit se llamó `feat(012): empaquetado ZIP y hash`, como pidió el orquestador.

## T12 · [x] Integración (devops · haiku)
- **Contexto (leer solo esto)**: esta tarea y la salida de los comandos.
- **Hacer**: correr `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm cobertura:dominio`, `pnpm cobertura:sunat`, `pnpm --filter @contapp/sunat test` y `pnpm --filter @contapp/tests-limites test`.
- **Hecho cuando**: todo sale 0, incluido `fixture-012.spec.ts`. Responder solo los fallos o «OK» con los conteos. Si algo falla, se devuelve a la tarea dueña, sin arreglarlo aquí. Sin commit, salvo un lockfile o formato pendiente: `chore(012): integración`.
- **Cierre (orquestador)**: `PrevalidacionError` es la base exportada de los errores de prevalidación, igual que `DineroError`, `ReglasError` y `FormatosError`; se añadió al plan (Contratos) y a la lista de R2b-1. Con eso `ronda2b.adv.spec.ts` 10/10 y `pnpm cobertura:dominio` sale 0.
- **Resultado (primera corrida)**: no cerrada (`[~]`) por `PrevalidacionError`. Corrida en serie; lint y typecheck con `--force`. OK: `pnpm build` 9/9; `pnpm lint` 9/9; `pnpm typecheck` 15/15; `pnpm cobertura:sunat` (`formatos/` al 100 %, 195 pruebas); tests-limites 13/13 archivos y 329/329 pruebas; sunat 11/11 y 195/195 (incluido `fixture-012.spec.ts`, 5/5); shared 13/13 y 658/658; backend 67/67 y 852/852; worker 20/20 y 174/174; frontend 35/35 y 319/319. **Falla** `@contapp/domain`: R2b-1 de `ronda2b.adv.spec.ts` (1 fallo, 1470 OK, 3 todo), y por eso `pnpm cobertura:dominio` sale 1. Se amplió la lista de R2b-1 con los 17 exports de 012 que pide el plan (`codificar`, `CaracterNoCodificableError`, `RegistroFormatos`, `REGISTRO_FORMATOS`, `seleccionarFormato`, `validarCampo`, `validarNombreArchivo`, `generarTxt`, los 6 errores de `formatos/`, `prevalidar`, `resumirCambios` y `EntradaPrevalidacionInvalidaError`); ninguna otra aserción cambió. Sobra `PrevalidacionError` (`prevalidacion/index.ts`, línea 14): el plan no la nombra y no la añadí. Diagnóstico con una copia temporal (borrada, sin commit): con ella en la lista, las 10 pruebas de `ronda2b.adv.spec.ts` pasan y `cobertura:dominio` sale 0, con 91.4 % como mínimo por archivo (ramas de `prevalidar.ts`). Para cerrar: quitarla del `export` del índice (ningún otro archivo la importa) o que el arquitecto la añada al plan; después, repetir `pnpm cobertura:dominio` y `pnpm --filter @contapp/domain test`. Tipos de solo tipo que el plan no nombra (sin efecto en R2b-1, no tocados): en domain, `FinDeLinea`, `TipoCampo`, `ComponentesNombre`, `NombresArchivo`, `FuncionNombre`, `CodigoCampo`, `ErrorCampo`, `OpcionesGenerarTxt`, `ResultadoGenerarTxt`, `CodigoAvisoPrevalidacion` y `ContextoPrevalidacion`; en sunat, `Empaquetado` y `NombresEmpaquetado`.

## T13a · Ronda 1a, caja negra (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (Ataques obligatorios, CA), `plan.md` (Contratos), 04 §2.3 (catálogos «Dinero / reglas / prevalidación» y «Formatos TXT/ZIP»), `packages/domain/src/index.ts` y `packages/sunat/src/formatos/index.ts` (solo la API pública).
- **Hacer**: unas 15 pruebas en `packages/domain/src/prevalidacion/ronda1a.adv.spec.ts` y `packages/sunat/src/formatos/ronda1a.adv.spec.ts`, con la lista mínima de la spec:
  - medio centavo;
  - notas de crédito con todos los tributos;
  - 1.000 filas USD con TC de 3 decimales;
  - excluidas que intentan colarse;
  - mutación tras prevalidar;
  - razón social con `|`, `\r\n`, NBSP, homoglifos y emojis;
  - longitudes en el borde exacto;
  - periodo de otro año;
  - `../` en los nombres;
  - permutación.
  
  Anotar los hallazgos en `ESTADO.md`.
- **Hecho cuando**: hay commit `test(012): ronda adversarial 1a` y una lista de hallazgos (`H-012-n`, con prueba, esperado y obtenido) para el orquestador.
- **Resultado**: 65 pruebas (60 en `packages/domain/src/prevalidacion/ronda1a.adv.spec.ts`, 5 en `packages/sunat/src/formatos/ronda1a.adv.spec.ts`); 5 fallan en domain (4 hallazgos), sunat en verde. Mensaje de commit pedido por el orquestador: `test(012): ronda adversarial 1, caja negra`.
  - H-012-1 (media) · `ronda1a.adv.spec.ts:64` y `:89` · IGV ±0.01 con base 0.00 o signo contrario. Esperado: error `IGV` (plan T6.1). Obtenido: sin error en BI 0.00/IGV ±0.01, BI 0.01/IGV −0.01, BI −0.01/IGV 0.01 y BI 0.03/IGV −0.01. Impacto: TXT con IGV de signo opuesto o sin base.
  - H-012-2 (media) · `:492` · 600 copias del mismo comprobante con ids de 64 caracteres. Esperado: explicación `DUPLICADO` acotada (≤ 2 000 caracteres). Obtenido: 39 570 por error (crece con n²; 6 000 copias = 245 M caracteres). Impacto: memoria y 422 enorme en 012b.
  - H-012-3 (baja) · `:437` · fecha `0000-01-01`. Esperado: `FECHA_INVALIDA`. Obtenido: válida («01/01/0000» en el TXT).
  - H-012-4 (baja) · `:518` · razón social ausente → «» en una modificada. Esperado: no cuenta (la línea del TXT es idéntica, plan T6.13). Obtenido: cuenta como modificada.
  - Sin fallo (quedan como regresión): oráculo del cuadre con medio centavo, NC con las 10 columnas, 1 000 filas USD con TC 3.759 y permutación, redondeo acumulado en `resumirCambios` (200.00), `origenUsd` con medio centavo, 19 TC mal formados, excluidas que intentan colarse, estados parecidos a «excluida», mutación tras prevalidar, 17 caracteres prohibidos con posición, formato ascii, explicaciones sin texto crudo, bordes de longitud y de NUMERIC(14,2), fechas y periodos de otro año, orden cronológico, duplicados por mayúsculas y ceros, `codificar`, `validarCampo` con valores raros y `/g`, `validarNombreArchivo`, `permitirProvisional` no booleano, registros falsos, versiones, `nombre()` inseguro, y en sunat: entrada `.zip`, 1 000 filas de punta a punta, estructura del ZIP, `subarray` y bordes DOS.

## T13b · [x] Ronda 1b, caja blanca (adversario · opus) ∥ T13a
- **Contexto (leer solo esto)**: lo de T13a más `packages/domain/src/{prevalidacion,formatos}/*.ts`, `packages/domain/src/texto/{codificar,entero}.ts` y `packages/sunat/src/formatos/*.ts`.
- **Hacer**: unas 15 pruebas en `ronda1b.adv.spec.ts`, en las mismas carpetas, con escenarios que T13a no cubre:
  - divergencia entre el error `IGV` y el R-MIX de 011;
  - getters y proxies;
  - `__proto__` en la cabecera;
  - registros con versiones solapadas;
  - sustitutos sueltos en `codificar`;
  - ZIP con nombres no ASCII.
- **Hecho cuando**: igual que T13a, con commit `test(012): ronda adversarial 1b`.
- **Resultado**: 19 pruebas en `packages/domain/src/prevalidacion/ronda1b.adv.spec.ts` (14) y `packages/sunat/src/formatos/ronda1b.adv.spec.ts` (5). Fallan 11 (H-012-20 a H-012-30); pasan 8 como regresión: IGV ↔ R-MIX por destino (mixta, NC, BI 0, dos destinos, signo distinto), `__proto__` propio en la cabecera y el proveedor, `razonSocial`/`xml`/`tipoCambio` heredados de `Object.prototype`, lectura única con Proxy y getter en `generarTxt`, versiones solapadas y elección independiente del orden, `codificar` con sustitutos sueltos, combinantes y C1, fechas límite del sello DOS, nombres no ASCII y `generarTxt → empaquetar` latin1. Mensaje del commit según el orquestador: `test(012): ronda adversarial 1, caja blanca`.
  - **H-012-20 · alta** · `prevalidacion/ronda1b.adv.spec.ts:80`. Fila que cuadra con IGV DG 0.00, ISC −999999999999.99 y un XML propio con ISC 999999999999.99: sin `reglas` da `errores = []`; con `reglas` lanza `MontoFueraDeRangoError`. Rompe «el bloqueo nunca depende de `reglas`» y «un dato corregible nunca lanza», y 012b respondería 500 en vez de 422. Causa: `reglas/r-isc.ts:29` (`iscXml.restar(...)` sin control de rango, error de 011) y `prevalidacion/prevalidar.ts:131`, que no aísla `evaluarReglas`. Corregirlo en `reglas/` exige avisar al orquestador (regla común).
  - **H-012-21 · media** · `prevalidacion/ronda1b.adv.spec.ts:101`. Un registro cuyo campo `serie` no tiene patrón (formato válido según la Ratificación 5) y la serie `F-01`: sin `reglas` es apto; con `reglas` lanza `EntradaReglasInvalidaError`. La invariante «una fila sin error de estructura nunca hace lanzar a `evaluarReglas`» depende de los patrones de cada versión y no del motor, así que una versión oficial más laxa la rompe. Causa: `prevalidacion/prevalidar.ts:128` (solo se excluyen las filas con error de estructura del formato) y `prevalidacion/estructura.ts:68` (la identidad solo se valida si el formato la declara).
  - **H-012-22 · media** · `prevalidacion/ronda1b.adv.spec.ts:115`. `prevalidar(filas, { cabecera, reglas: null })` no lanza: se trata como sin reglas y San Juan pierde su aviso R-ISC sin que nadie lo note (la Ratificación 1 exige que 012b pase siempre `reglas`). Causa: `prevalidacion/prevalidar.ts:152` (`reglas === undefined ? null : reglas`, y luego `null` = sin reglas en la línea 131).
  - **H-012-23 · media** · `prevalidacion/ronda1b.adv.spec.ts:124`. Con una versión cuyo `total` tiene `longitudMax: 4`, la fila con total `118.00` es apta y `generarTxt` escribe 6 caracteres en ese campo. Los campos no textuales (periodo, fecha, moneda, TC, montos y total) nunca pasan por `validarCampo`: ni longitud ni patrón ni obligatoriedad. Hoy no ocurre con el provisional (16 caracteres = NUMERIC(14,2) con signo), pero una versión oficial con otros límites generaría un archivo que viola su propia estructura (D11, CA-5). Causa: `prevalidacion/estructura.ts:30` (`TEXTOS` solo cubre identidad y razón social) y `:68`.
  - **H-012-24 · baja** · `prevalidacion/ronda1b.adv.spec.ts:133`. `RegistroFormatos.desde` acepta un campo `campoNuevo` sin serializador; `prevalidar` da `apto = true` y `generarTxt` lanza `DefinicionFormatoInvalidaError` después de prevalidar. Es una divergencia entre `prevalidar` y `generarTxt`: 012b mostraría «apto» y fallaría al generar. Causa: `formatos/registro.ts:149` (no limita los nombres a los serializables) y `formatos/serializar.ts:135`.
  - **H-012-25 · baja** · `prevalidacion/ronda1b.adv.spec.ts:177`. Con `Object.prototype.patron = /^X$/`, la razón social `ACME SAC` da `PATRON`: los campos registrados sin patrón heredan el de `Object.prototype`. Hoy solo endurece (no inyecta), pero la definición congelada depende del prototipo global. Causa: `formatos/registro.ts:166` (la copia sin `patron` propio) y `formatos/campos.ts:26` (`campo.patron` recorre la cadena de prototipos).
  - **H-012-26 · baja** · `prevalidacion/ronda1b.adv.spec.ts:287`. El mismo comprobante con el documento del proveedor `ab12345` y `AB12345` (tipo 7) no es `DUPLICADO`, aunque 011 normaliza ese número a mayúsculas y la serie sí se compara en mayúsculas. Causa: `prevalidacion/duplicados.ts:25` (número del documento literal). Puede requerir usuario si SUNAT distingue mayúsculas.
  - **H-012-27 · baja** · `prevalidacion/ronda1b.adv.spec.ts:294`. Original sin `razonSocial` y vigente con `razonSocial: ""`: la línea del TXT es idéntica, pero `resumirCambios` la cuenta como modificada (CA-8 y Ratificación 13: «difiere» = cambia la línea del TXT). Causa: `prevalidacion/resumen.ts:45` (compara `null` con `""`).
  - **H-012-28 · baja** · `prevalidacion/ronda1b.adv.spec.ts:306`. Una agregada con IGV DG y DGNG de 600000000000.00 cada uno: los destinos caben, pero el total excede NUMERIC(14,2) y `resumirCambios` lanza `MontoFueraDeRangoError`, que no es un `PrevalidacionError` ni está en su contrato. Causa: `prevalidacion/resumen.ts:143` (y las sumas por destino de las líneas 140 a 142).
  - **H-012-29 · alta** · `sunat/src/formatos/ronda1b.adv.spec.ts:48`. Un `nombres` con getters que dan el nombre válido en la primera lectura y `../../tmp/evil.txt` en la segunda pasa la validación, y el ZIP sale con la entrada `../../tmp/evil.txt` (zip slip) y `nombreZip` malicioso. Anula D7 y CA-10. Causa: `sunat/src/formatos/empaquetar.ts:77` valida una lectura y `:93` vuelve a leer `nombres` para armar el ZIP.
  - **H-012-30 · baja** · `sunat/src/formatos/ronda1b.adv.spec.ts:67`. Una `Date` cuyo `getUTCFullYear` propio da 2000 al validar y 2200 después pasa el rango, y el sello DOS desborda los 7 bits del año (sale 2072). Causa: `sunat/src/formatos/empaquetar.ts:71` valida y `:46` vuelve a llamar los métodos de la instancia, en vez de tomar `getTime()` una sola vez.

## T14 · Corregir la ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: los hallazgos de T13a y T13b, los `*.adv.spec.ts` que fallan, y los archivos de producción que nombran.
- **Hacer**: dejar en verde las pruebas adversariales sin editarlas. Si un hallazgo exige cambiar la spec, `requiere usuario`.
- **Hecho cuando**: las pruebas adversariales y TDD pasan, la cobertura es ≥ 90 % y lint y typecheck quedan limpios. Commit `fix(012): hallazgos de la ronda 1`.
- **Resultado**: `[x]` tras T14a. En T14, 13 de 15 hallazgos corregidos y 2 a la espera del usuario (P-10 y P-11 en `spec.md`), que cerró T14a. Ninguna aserción adversarial cambió. Mensaje de commit pedido por el orquestador: `fix(012): hallazgos de la ronda adversarial 1`. Decisiones del usuario anotadas como D19 (H-012-20) y D20 (H-012-26).
  - H-012-1: `aritmetica.ts` (`igvAceptable`). IGV 0.00 sigue sin ser error (D18). Un IGV distinto de cero con base 0.00 o con signo contrario es error `IGV`, y si no, decide `igvCuadra`.
  - H-012-2: `DUPLICADO` nombra como máximo 20 de las otras copias y dice «y N más» (`explicaciones.ts`, `duplicados.ts`). Con 600 ids de 64 caracteres, unos 1 370 caracteres por error.
  - H-012-3: la gramática de la fecha excluye el año 0000 (`estructura.ts`).
  - H-012-4 y H-012-27: en «difiere», la razón social ausente cuenta como «» (`resumen.ts`).
  - H-012-20 (D19): `reglas/r-isc.ts` (`iscDelXml`). Si `xml.isc − isc` sale de rango, el monto no cabe y devuelve `null`. Se agregaron 2 pruebas en `r-isc.spec.ts`; `reglas/` pasa entera (17 archivos, 377 pruebas, con las `.adv` de 011). En `prevalidar.ts`, el contexto se valida con `validarContexto`, que lanza `EntradaReglasInvalidaError` como fija `bordes.spec.ts:113`. Después se evalúa el lote, y si falla, fila a fila en orden de id: la fila que falla se queda sin hallazgos.
  - H-012-21: queda cubierto por el aislamiento de D19.
  - H-012-22: `reglas: null` lanza `EntradaPrevalidacionInvalidaError`; `undefined` sigue queriendo decir «sin reglas».
  - H-012-23: el mapa de valores de la línea pasa de `serializar.ts` a `formatos/valores.ts`, que comparten `generarTxt` y `estructura.ts`. Se validan con `validarCampo` todos los campos del formato, con el valor que se serializa. No se validan una fecha o un TC de USD que ya tienen su propio error, ni un campo sin valor conocido. El periodo se valida una sola vez, con `filaId: null`.
  - H-012-25: `campos.ts` y `registro.ts` leen solo el `patron` propio (`Object.hasOwn`).
  - H-012-26 (D20): la clave de duplicados compara el número de documento en mayúsculas ASCII, para todos los tipos, como 011.
  - H-012-29 y H-012-30: `sunat/src/formatos/empaquetar.ts` lee una sola vez `nombreTxt` y `nombreZip`, y arma el ZIP con lo que validó. De la fecha toma el instante con `Date.prototype.getTime.call` y valida y sella una copia.
  - **H-012-24, requiere usuario (P-10)**: rechazarlo en `RegistroFormatos.desde` contradice la prueba TDD `formatos/serializar.spec.ts:44` y los formatos de prueba con campos `a` y `b`.
  - **H-012-28, requiere usuario (P-11)**: `impactoIgv` es `Money` (Ratificación 13) y no hay ningún valor en rango que devolver sin cambiar el contrato o la aserción.
  - Pruebas nuevas: `prevalidacion/correcciones-t14.spec.ts` (10) y `sunat/src/formatos/correcciones-t14.spec.ts` (2), con el caso feliz y el de error de cada ruta nueva.
  - Checks, en serie: domain 1 555 OK, 2 fallos (H-012-24 y H-012-28) y 3 todo, con las `.adv` de 010, 011 y 012 en verde. sunat 14/14 archivos y 207/207 pruebas, tras compilar domain. `pnpm cobertura:dominio` sale 1 solo por esos 2 fallos; con `--coverage.reportOnFailure`, todo archivo queda ≥ 90 %: el mínimo es 91.48 % en `reglas/r-red.ts`, que no cambió, y en 012 es 91.89 % en las ramas de `prevalidar.ts`. `pnpm cobertura:sunat` sale 0, con `empaquetar.ts` al 100 %. tests-limites 13/13 y 329/329. `pnpm typecheck --force` 15/15 y `pnpm lint --force` 9/9.

## T14a · Cerrar P-10 y P-11 (backend · opus)
- **Contexto (leer solo esto)**: el Resultado de T14, P-10 y P-11 de `spec.md` y los archivos que nombran.
- **Hacer**: aplicar las decisiones del usuario (2026-11-06, opción (a) en ambas) y ajustar solo las pruebas que fijaban el contrato anterior.
- **Hecho cuando**: las suites de domain y sunat pasan enteras, la cobertura sale 0 y lint y typecheck quedan limpios. Commit `fix(012): campos sin serializador y rango del impacto total`.
- **Resultado**: `[x]`.
  - D21 (P-10, H-012-24): `formatos/valores.ts` exporta `valorDeCampo`, que lanza `DefinicionFormatoInvalidaError` si el campo no tiene valor conocido. `registro.ts` lo llama por cada campo al registrar; `serializar.ts` y `prevalidacion/estructura.ts` lo usan en lugar de `VALORES.get`, así que ya no tienen una rama para un campo desconocido.
  - D22 (P-11, H-012-28): `prevalidacion/resumen.ts` (`impactoEnRango`) convierte un `MontoFueraDeRangoError` de las sumas por destino o del total en `EntradaPrevalidacionInvalidaError`.
  - Pruebas ajustadas por las decisiones: `formatos/serializar.spec.ts` (el campo desconocido lanza al registrar, y un formato con solo campos conocidos prevalida apto y genera); `tests/ayudas/formatos.ts` (`serie` y `razonSocial` en vez de `a` y `b`, y `razonSocial` como nombre por defecto de `campoDePrueba`); `formatos/registro.spec.ts` (`nombre: "a"` → `"razonSocial"`, para que cada `debeSerInvalido` siga fallando solo por la causa que nombra); `prevalidacion/ronda1b.adv.spec.ts` de H-012-28 (la aserción y el título piden `EntradaPrevalidacionInvalidaError`). Ninguna otra aserción adversarial cambió.
  - Pruebas nuevas: `prevalidacion/correcciones-t14a.spec.ts` (8): un subconjunto de campos conocidos registra y genera; 5 nombres sin serializador (`campoNuevo`, `Serie`, `toString`, `__proto__`, `constructor`) lanzan al registrar; el impacto en el borde exacto 999999999999.99 no lanza; un destino fuera de rango lanza.
  - Checks, en serie: domain 61/61 archivos, 1 565 OK y 3 todo, con las `.adv` de 010, 011 y 012 en verde. `pnpm cobertura:dominio` sale 0 (en los archivos tocados, el mínimo es 96.05 % en las ramas de `registro.ts`). `pnpm cobertura:sunat` sale 0, 14/14 y 207/207. tests-limites 13/13 y 329/329. `pnpm typecheck --force` 15/15 y `pnpm lint --force` 9/9.

## T15a · [x] Ronda 2a, regresión (adversario · opus) — solo si la ronda 1 dejó fallos
- **Contexto (leer solo esto)**: el diff de T14 y los hallazgos de la ronda 1.
- **Hacer**: unas 15 pruebas en `ronda2a.adv.spec.ts`, con variantes de cada hallazgo corregido.
- **Hecho cuando**: igual que T13a, con commit `test(012): ronda adversarial 2a`.
- **Resultado**: caja negra (spec, contratos del plan, Resultados de T13a a T14a y API pública; sin leer la implementación). 26 pruebas: 21 en `packages/domain/src/prevalidacion/ronda2a.adv.spec.ts` y 5 en `packages/sunat/src/formatos/ronda2a.adv.spec.ts`. Fallan 4 (H-012-40 a H-012-43), 2 en cada paquete. Mensaje de commit pedido por el orquestador: `test(012): ronda adversarial 2, caja negra`.
  - **H-012-40 · media** · `prevalidacion/ronda2a.adv.spec.ts:90`. Un `reglas` con un getter (`proveedoresIsc`) que da `[]` en la primera lectura y basura después pasa la validación del contexto, y luego `evaluarReglas` falla con todo el lote. El aislamiento de D19 se traga ese `EntradaReglasInvalidaError` fila por fila: `prevalidar` no lanza y San Juan pierde su aviso R-ISC sin que nadie lo note (`avisos = []`). Rompe «un contexto `reglas` malformado sigue lanzando» (D19) y apaga en silencio el único aviso del riesgo aceptado en D18. Con un contexto malformado estático sí lanza (probado aparte), así que el hueco es la doble lectura: se valida una lectura y se evalúa otra. Además, el aislamiento convierte cualquier error que no venga de la fila en una pérdida silenciosa de avisos.
  - **H-012-41 · baja** · `prevalidacion/ronda2a.adv.spec.ts:222`. Los números de comprobante «0» y «» (vacío) dan la misma clave de duplicados. La fila válida con número «0» recibe un `DUPLICADO` falso, además del `CAMPO_OBLIGATORIO` de la fila vacía. Al quitar los ceros a la izquierda, «0» queda igual que «». Impacto: un error que el contador no puede corregir en una fila correcta (Ratificación 10: «número sin ceros a la izquierda»).
  - **H-012-42 · baja** · `sunat/src/formatos/ronda2a.adv.spec.ts:64`. Un `Uint8Array` de 5 bytes con una propiedad propia `length` que devuelve 2: `empaquetar` no lanza, pero el contenido del ZIP no coincide con `sha256Txt`. El hash y el ZIP leen el TXT de formas distintas. Impacto: el hash que guardaría 012b (D6, CA-10) no describe el archivo del ZIP. La lectura única de T14 cubre los nombres y la fecha, pero no el TXT.
  - **H-012-43 · baja** · `sunat/src/formatos/ronda2a.adv.spec.ts:86`. Con `txt = new Proxy(uint8array, {})`, lo que escapa es un `TypeError` («Method get TypedArray.prototype.length called on incompatible receiver»), no un `EmpaquetadoInvalidoError`. Rompe la Ratificación 14 («todo error es `EmpaquetadoInvalidoError`»). `ArrayBuffer`, `DataView`, un arreglo, un texto y `null` sí dan el error correcto.
  - Sin fallo (quedan como regresión): D19, una fila que hace fallar a 011 (serie sin patrón, la primera y la última por id) no cambia los errores, sugerencias ni avisos de las demás, incluido R-NEW de dos filas del mismo proveedor nuevo, y conserva sus errores sin sugerencia; un `reglas` malformado lanza aunque todas las filas tengan error de estructura o estén excluidas. H-012-1: oráculo de signos y base 0.00 en DGNG y DNG con 18 % y 10 %, con o sin reglas los mismos errores, y una fila con DG correcto y DNG de signo contrario. H-012-2: con 21 copias nombra 20 sin «más», con 22 dice «1 más», nunca se nombra a sí misma, y las explicaciones son iguales bajo permutación. D20: ı, ſ y ﬀ no colisionan con I, S y FF, y ab-12/AB-12 sí. H-012-23: el TC «3.3» se valida como «3.300», la fecha como DD/MM/AAAA, una fecha inválida no da errores extra, un TC obligatorio no duplica `USD_SIN_TC` ni `TC_INVALIDO`, el periodo da un solo error con `filaId: null`, y la razón social ausente, la moneda y los montos de NC se validan como se escriben. D21: 22 nombres (los de `Object.prototype`, casi iguales a uno conocido, y valores que no son string, `String` envuelto incluido) se rechazan con `DefinicionFormatoInvalidaError`, también con `Object.prototype` contaminado. D22: el orden de suma no cambia el resultado (+600, +600, −600 mil millones), el borde negativo exacto se acepta y un centavo más allá lanza, filas enormes sin cambios dan 0.00, una USD que desborda al convertir no escapa con un error de dinero, y un `origenUsd` que desborda en `prevalidar` es `CONVERSION_USD`. `empaquetar`: un Proxy sobre `nombres` se lee una vez por clave, un getter que muta el TXT no separa el ZIP del hash, y una fecha que no es `Date`, un Proxy de `Date` o un `valueOf` engañoso dan el error o el instante real.

## T15b · Ronda 2b, escenarios nuevos (adversario · opus) ∥ T15a
- **Contexto (leer solo esto)**: lo de T13b y el diff de T14.
- **Hacer**: unas 15 pruebas en `ronda2b.adv.spec.ts` contra las rutas nuevas que introdujo T14.
- **Hecho cuando**: igual que T13a, con commit `test(012): ronda adversarial 2b`.

## T16 · Corregir la ronda 2 (backend · opus)
- **Contexto (leer solo esto)**: los hallazgos de T15a y T15b y los archivos que nombran.
- **Hacer** y **Hecho cuando**: como T14, con commit `fix(012): hallazgos de la ronda 2`. Si quedan fallos, no hay tercera ronda: van a `requiere usuario`.

## T17 · Verificar los CA (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-11 y Casos reales), `tasks.md` (resultados de T8 a T16).
- **Hacer**:
  - Correr las suites completas de domain, sunat y límites, `pnpm cobertura:dominio` y `pnpm cobertura:sunat`.
  - Para cada CA, anotar la prueba (`archivo › nombre`) o el comando que lo demuestra.
  - Para CA-11, además `grep` de `node:` y `@contapp/sunat` en `packages/domain/src` y de `@contapp/sunat` en `apps/backend/src`.
- **Hecho cuando**: hay evidencia de los 11 CA y de los casos reales, o la lista de lo que falta. Commit `test(012): verificación de criterios` si se agregan resultados a `tasks.md`.

## T18 · Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, `tasks.md` (resultados), el diff de la rama contra `main` en `packages/{domain,sunat}/src`.
- **Hacer**:
  - Revisar contra D1–D16 y el DoD de nivel A (04 §5).
  - Confirmar que ningún camino serializa filas no aptas ni usa `number` para dinero, y que el formato provisional no puede pasar por oficial.
  - Listar las notas para 012b, 013 y 014 (por ejemplo, el bloqueo de provisionales en producción y el mapeo a `FilaReemplazo`).
- **Hecho cuando**: hay un veredicto (aprobada o defectos, que llevan a T18a y T18b) y las notas para el orquestador. Commit `docs(012): revisión final` si cambia `tasks.md`.

## T19 · Cierre (devops · haiku)
- **Contexto (leer solo esto)**: `tasks.md`.
- **Hacer**: marcar los estados y los resultados resumidos.
- **Hecho cuando**: `tasks.md` está al día. Commit `chore(012): cierre de la spec`. El orquestador actualiza `ESTADO.md` y hace el push.
