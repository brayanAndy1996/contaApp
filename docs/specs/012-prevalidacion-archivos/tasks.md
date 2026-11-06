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
| T7 | Lint de dinero en `prevalidacion/` y `formatos/` | devops | haiku | T2, T6 ∥ T8 | ✓ | — | [ ] |
| T8 | Implementar `texto/codificar`, `texto/entero` y `formatos/` (sin `generarTxt`) | backend | opus | T1, T3, T6 | ✓ | — | [ ] |
| T9 | Implementar `prevalidar` y `generarTxt` | backend | opus | T4, T8 | ✓ | — | [ ] |
| T10 | Implementar `resumirCambios` | backend | opus | T5, T9 | ✓ | — | [ ] |
| T11 | Implementar `empaquetar` en sunat | backend | opus | T1, T5, T8 ∥ T9, T10 | ✓ | — | [ ] |
| T12 | Integración: checks completos | devops | haiku | T7, T10, T11 | — | — | [ ] |
| T13a | Ronda 1a: ataques de la spec (caja negra) | adversario | opus | T12 | — | ✓ | [ ] |
| T13b | Ronda 1b: escenarios nuevos (caja blanca) | adversario | opus | T12 ∥ T13a | — | ✓ | [ ] |
| T14 | Corregir hallazgos de la ronda 1 | backend | opus | T13a, T13b | — | — | [ ] |
| T15a | Ronda 2a: regresión de las correcciones | adversario | opus | T14 | — | ✓ | [ ] |
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

## T7 · Lint de dinero en las carpetas nuevas (devops · haiku) ∥ T8
- **Contexto (leer solo esto)**: `plan.md` (Decisiones: Lint y cobertura), `eslint.config.mjs` (bloque «Dinero (spec 010/011, CA-1)» y `GLOBALES_IO_DOMINIO`), `tests/limites/dominio-prevalidacion.spec.ts`.
- **Hacer**:
  1. Agregar `packages/domain/src/prevalidacion/**` y `packages/domain/src/formatos/**` a `files` de ese bloque.
  2. Cambiar los mensajes a «spec 010/011/012».
  3. Si T2 lo dejó anotado, agregar `TextEncoder` y `TextDecoder` a `GLOBALES_IO_DOMINIO`.
  
  No tocar otros bloques.
- **Hecho cuando**: `pnpm --filter @contapp/tests-limites test` queda en verde y `pnpm lint` no da errores nuevos. Commit `chore(012): lint contra number en prevalidación y formatos`.

## T8 · Implementar codificación y formatos (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: `formatos/` y `texto/`; Decisiones: Formato provisional RCE, Caracteres, Lint y cobertura, Ratificación de contratos 2–6, 11 y 15), `spec.md` (D2, D5–D8, D10), `packages/domain/src/texto/index.ts`, `packages/domain/src/reglas/errores.ts` (patrón de errores con `codigo`), los specs de T3.
- **Hacer**:
  - `texto/{codificar,entero}.ts`.
  - `formatos/{tipos,errores,registro,provisional-rce,campos,nombres,index}.ts`: la validación de un valor contra un `CampoTxt` (devuelve el código y la posición, sin lanzar) y `RUC` con `validarRuc` de `@contapp/shared`.
  - Dejar los stubs de `serializar.ts` que necesite T9.
  - Exportar todo desde `src/index.ts`.
- **Hecho cuando**: los specs de T3 pasan, la cobertura de esos archivos es ≥ 90 % y `pnpm --filter @contapp/domain lint typecheck` queda limpio. Commit `feat(012): codificación y registro de formatos TXT versionados`.

## T9 · Implementar prevalidar y generarTxt (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: `prevalidacion/` y `generarTxt`; Decisiones: Errores frente a excepciones, Orden de prevalidar, Explicaciones, generarTxt, Ratificación de contratos 1, 3, 4 y 6–12, 15), `spec.md` (D1, D3, D4, D6, D11, D13, D14, D16), `packages/domain/src/{dinero,comprobante,reglas}/index.ts`, `packages/domain/src/reglas/entrada.ts` (patrón de entrada estricta), los specs de T4.
- **Hacer**:
  - `prevalidacion/{tipos,errores,entrada,estructura,aritmetica,duplicados,explicaciones,prevalidar,index}.ts`.
  - `formatos/serializar.ts` con `generarTxt`: copia congelada leída una vez, `seleccionarFormato`, `prevalidar`, orden estable y codificación.
  - Reutilizar `verificarCuadre`, `igvCuadra`, `convertirAPen`, `TipoCambio.desde` y `evaluarReglas` sin reimplementarlos.
- **Hecho cuando**: los specs de T4 y la parte de CA-1 y CA-2 de domain pasan, la cobertura es ≥ 90 % por archivo, y lint y typecheck quedan limpios. Las pruebas de 010 y 011 siguen en verde. Commit `feat(012): prevalidación SUNAT y generación del TXT bloqueada por construcción`.

## T10 · Implementar resumirCambios (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: `ResumenCambios`; Decisiones: resumirCambios, Ratificación de contratos 13), `spec.md` (D12, D14; CA-8), `packages/domain/src/prevalidacion/{tipos,entrada}.ts`, `packages/domain/src/prevalidacion/resumen.spec.ts`.
- **Hacer**: `prevalidacion/resumen.ts` y su export.
- **Hecho cuando**: `resumen.spec.ts` pasa, la cobertura es ≥ 90 % y lint y typecheck quedan limpios. Commit `feat(012): resumen de cambios con impacto en IGV por destino`.

## T11 · Implementar empaquetar (backend · opus) ∥ T9, T10
- **Contexto (leer solo esto)**: `plan.md` (Contratos: `@contapp/sunat`; Decisiones: empaquetar, Ratificación de contratos 14), `spec.md` (D6, D7; CA-10), `packages/sunat/src/index.ts`, `packages/sunat/src/errores.ts` (patrón), `packages/sunat/src/formatos/empaquetar.spec.ts`.
- **Hacer**: `packages/sunat/src/formatos/{empaquetar,index}.ts` y su export desde `src/index.ts`. Usar `validarNombreArchivo` de `@contapp/domain`, sin una gramática propia.
- **Hecho cuando**: `empaquetar.spec.ts` pasa, `pnpm cobertura:sunat` sale 0 y lint y typecheck de sunat quedan limpios. `fixture-012.spec.ts` puede seguir en rojo hasta T9. Commit `feat(012): empaquetado ZIP en memoria con SHA-256`.

## T12 · Integración (devops · haiku)
- **Contexto (leer solo esto)**: esta tarea y la salida de los comandos.
- **Hacer**: correr `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm cobertura:dominio`, `pnpm cobertura:sunat`, `pnpm --filter @contapp/sunat test` y `pnpm --filter @contapp/tests-limites test`.
- **Hecho cuando**: todo sale 0, incluido `fixture-012.spec.ts`. Responder solo los fallos o «OK» con los conteos. Si algo falla, se devuelve a la tarea dueña, sin arreglarlo aquí. Sin commit, salvo un lockfile o formato pendiente: `chore(012): integración`.

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

## T13b · Ronda 1b, caja blanca (adversario · opus) ∥ T13a
- **Contexto (leer solo esto)**: lo de T13a más `packages/domain/src/{prevalidacion,formatos}/*.ts`, `packages/domain/src/texto/{codificar,entero}.ts` y `packages/sunat/src/formatos/*.ts`.
- **Hacer**: unas 15 pruebas en `ronda1b.adv.spec.ts`, en las mismas carpetas, con escenarios que T13a no cubre:
  - divergencia entre el error `IGV` y el R-MIX de 011;
  - getters y proxies;
  - `__proto__` en la cabecera;
  - registros con versiones solapadas;
  - sustitutos sueltos en `codificar`;
  - ZIP con nombres no ASCII.
- **Hecho cuando**: igual que T13a, con commit `test(012): ronda adversarial 1b`.

## T14 · Corregir la ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: los hallazgos de T13a y T13b, los `*.adv.spec.ts` que fallan, y los archivos de producción que nombran.
- **Hacer**: dejar en verde las pruebas adversariales sin editarlas. Si un hallazgo exige cambiar la spec, `requiere usuario`.
- **Hecho cuando**: las pruebas adversariales y TDD pasan, la cobertura es ≥ 90 % y lint y typecheck quedan limpios. Commit `fix(012): hallazgos de la ronda 1`.

## T15a · Ronda 2a, regresión (adversario · opus) — solo si la ronda 1 dejó fallos
- **Contexto (leer solo esto)**: el diff de T14 y los hallazgos de la ronda 1.
- **Hacer**: unas 15 pruebas en `ronda2a.adv.spec.ts`, con variantes de cada hallazgo corregido.
- **Hecho cuando**: igual que T13a, con commit `test(012): ronda adversarial 2a`.

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
