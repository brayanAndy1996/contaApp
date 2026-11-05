# Tareas 009 · Adaptadores mock (XML, propuesta SIRE) y fixtures

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel C (spec): sin TDD ni ronda adversarial. Flujo 04 §1.3: implementar con pruebas mínimas (1 caso feliz y 1 de error por comportamiento público, escritas por `backend` junto al código) → verificar → cerrar. Por pedido del usuario se agregan la verificación por `tester` (T11, en vez de `devops`) y una revisión del arquitecto (T12), que el nivel C no exige. Rama `spec/009-adaptadores-mock`. CA y D = `spec.md`; contratos y decisiones = `plan.md`. Sin migración (la 0028 queda libre).

| #   | Tarea                                                                                              | Rol      | Modelo | Depende de     | TDD | ADV | Estado |
| --- | -------------------------------------------------------------------------------------------------- | -------- | ------ | -------------- | --- | --- | ------ |
| T1  | Puertos `XmlProvider` y `SireApiClient`, tipos, `OrigenXml` y dependencia de `domain`              | backend  | sonnet | —              | —   | —   | [x]    |
| T2  | Fixtures sintéticos XML y SIRE, lista de RUC de prueba y `LEEME.md`                                | devops   | haiku  | — ∥ T1         | —   | —   | [x]    |
| T3  | `MockXmlProvider` (fixture, UBL sintético, inyección, errores, latencia, ruta segura) y sus pruebas | backend  | sonnet | T1             | —   | —   | [ ]    |
| T4  | `MockSireApiClient` y sus pruebas                                                                  | backend  | sonnet | T1 ∥ T3        | —   | —   | [ ]    |
| T5  | `adaptadores.module.ts`: 5 puertos por entorno, guarda de producción y pruebas                     | backend  | sonnet | T3, T4         | —   | —   | [ ]    |
| T6  | **[nivel A]** `KeyWrapper` del backend creado al arrancar fuera de `development` y `test`          | backend  | sonnet | — ∥ T1–T5      | —   | —   | [ ]    |
| T7  | **[nivel A]** Pruebas de cierre de 008: fallar con `CI=true` en vez de omitir                      | tester   | sonnet | — ∥ T1–T6      | —   | —   | [x]    |
| T8  | `ci:db` y CI: paso aparte, al final y en serie, con la BD despejada                                | devops   | haiku  | T7             | —   | —   | [ ]    |
| T9  | Prueba de humo fila SIRE ↔ XML, RUC de prueba y canario en los mocks                               | backend  | sonnet | T2, T3, T4     | —   | —   | [ ]    |
| T10 | `docs/03-arquitectura.md` §3 con los nombres reales de los puertos                                 | devops   | haiku  | T1 ∥ T3–T9     | —   | —   | [ ]    |
| T11 | Verificar CA-1 a CA-11 con evidencia (suites de los paquetes afectados)                            | tester   | sonnet | T5, T6, T8, T9, T10 | — | —   | [ ]    |
| T12 | Revisión contra la spec (con atención a T6 y T7, nivel A)                                          | arquitecto | sonnet | T11          | —   | —   | [ ]    |
| T13 | Cierre: tasks, estado de la spec y commit (el orquestador actualiza ESTADO)                        | devops   | haiku  | T12            | —   | —   | [ ]    |

Paralelismo: T1 ∥ T2 ∥ T6 ∥ T7 arrancan juntas; T3 ∥ T4 tras T1 (comparten `packages/sunat/src/index.ts`: hacen commit una tras otra, cada una agrega solo su línea de exportación); T8 ∥ T9 ∥ T10 cuando sus dependencias estén. No hay dependencia entre T6/T7/T8 y el resto hasta T11.

Escalamientos: ninguno previsto. T2 es `haiku` porque es contenido sintético acotado; si un XML no cuadra con su fila o T9 falla por fixtures, T2 pasa a `sonnet` (04 §3.3). T8 pasa a `sonnet` si `haiku` falla una vez. T3 concentra la seguridad de ruta (CA-4): si falla dos veces nace de nuevo en `opus`.

Nivel A tocado (justificación): T6 modifica el punto de creación del `KeyWrapper` (cifrado de 003/007b) pero no su lógica ni `@contapp/crypto`, y T7 modifica la condición de omisión en dos archivos `*.adv.int.spec.ts` (pruebas adversariales de 008). No se toca el ejecutor de 008 (P1 se difirió a propósito, D14). T7 la hace `tester` y no `adversario` porque el cambio es mecánico (omitir → fallar) y no agrega ataques; por eso T12 revisa ambos diffs y que ninguna aserción se haya debilitado.

Reglas comunes:

- Un commit por tarea (Conventional Commits `feat(009): …`, `test(009): …`, `chore(009): …`, `docs(009): …`) con los trailers `Co-Authored-By` del modelo que la ejecutó y `Claude-Session`. Sin push del subagente: el orquestador lo hace.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` (cambios ajenos): `git add <rutas>` explícitas, nunca `git add -A`/`.`.
- **Nunca** imprimir ni commitear secretos reales ni el contenido de `.env`. Ningún mock devuelve, registra ni incluye en un error la credencial recibida; los fixtures solo usan RUC de `fixtures/rucs-prueba.json`.
- Montos con `Money`/`decimal.js`; nunca `number`. Adaptadores en `mock` por defecto. `apps/frontend` y `apps/backend` no importan `@contapp/sunat`.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo. Correr solo las pruebas del paquete afectado (`packages/sunat`, `packages/shared`, `apps/worker`, `apps/backend`); las suites completas, en T11.
- Dependencias nuevas con versión exacta (sin `^`); T1 solo agrega `@contapp/domain` como `workspace:*`.
- Escalar según 04 §3.3 y anotar arriba. Una ambigüedad que cambie la spec no se decide: `requiere usuario` y se informa al orquestador.

## T1 · Puertos, tipos y `OrigenXml` (backend · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D1, D3, D7), `plan.md` (Contratos), `packages/sunat/src/{puertos,errores,index}.ts`, `packages/sunat/package.json`, `packages/shared/src/index.ts`, `packages/shared/src/trabajos/index.ts` (patrón de submódulo), `packages/domain/src/index.ts` (que `Money` se exporte).
- **Hacer**: agregar `XmlProvider`, `SireApiClient`, `SolicitudXml`, `ReferenciaXml`, `RespuestaXml`, `SolicitudPropuesta`, `PropuestaSire`, `FilaPropuestaSire` a `puertos.ts` con JSDoc (qué errores lanza cada uno; el proveedor real ignora `referencia`); `packages/shared/src/xml/{origen,index}.ts` con `OrigenXml` y `origenXmlSchema` (zod) y su prueba mínima (valor válido, valor inválido); `@contapp/domain` en `dependencies` de `packages/sunat` (y referencia de `tsconfig` si el patrón del repo la pide).
- **Hecho cuando**: `pnpm --filter @contapp/shared test` y `pnpm --filter @contapp/sunat typecheck` OK; `eslint` limpio en ambos; `OrigenXml` se importa desde `@contapp/shared` (parte de CA-10). Commit `feat(009): puertos XmlProvider y SireApiClient, OrigenXml`.
- **Resultado (2026-11-05)**: `puertos.ts` con `XmlProvider`, `SireApiClient`, `SolicitudXml`, `ReferenciaXml`, `RespuestaXml`, `SolicitudPropuesta`, `PropuestaSire`, `FilaPropuestaSire` y `LibroSire`; `packages/shared/src/xml/{origen,index,origen.spec}.ts` (`OrigenXml`, `origenXmlSchema`) exportado desde `@contapp/shared`. `packages/sunat` depende ahora de `@contapp/domain` y de `@contapp/shared` (`workspace:*`; `shared` hace falta porque `RespuestaXml.origen` usa `OrigenXml`). `pnpm install --frozen-lockfile` OK; `shared` test 658, `sunat` test 63, typecheck y eslint limpios en ambos. Sin referencia de `tsconfig` (el repo no las usa).

## T2 · Fixtures sintéticos (devops · haiku)

- **Contexto (leer solo esto)**: `plan.md` (Contratos: Fixtures y tabla de casos), `spec.md` (D4, D6, D7, D17; CA-2, CA-5), `docs/specs/010-dominio-dinero/spec.md` (solo CA-13), `packages/shared/src/clientes/ruc.ts` (`validarRuc`, para generar RUC válidos), `packages/sunat/src/puertos.ts` (forma de `FilaPropuestaSire`, tras T1; si T1 no terminó, el bloque de `plan.md`).
- **Hacer**: `fixtures/rucs-prueba.json` (RUC con dígito verificador válido, ninguno terminado en 7, 8 ni 9, sin coincidir con RUC reales conocidos); `fixtures/xml/` con un UBL 2.1 por caso del plan (San Juan, mixta, ICBPER, redondeo USD, zapatilla) con los tributos y cifras de la tabla y números de comprobante que no terminan en 7, 8 ni 9; `fixtures/sire/` con compras (las filas de esos XML, con los montos mal ubicados que corregirá 011) y ventas (boletas B001-290 y B001-292, sin la 291) de un periodo, más el conjunto genérico por libro (`generico-compras.json`, `generico-ventas.json`); `fixtures/LEEME.md` (qué es cada archivo, regla de nombres y de últimos dígitos, aviso «datos sintéticos»). Razón social y direcciones inventadas y marcadas «PRUEBA».
- **Hecho cuando**: todo XML está bien formado (`xmllint --noout` o `node -e` con `fast-xml-parser`); `grep -rn` de los RUC de `fixtures/` solo encuentra los de `rucs-prueba.json`; cada total de un XML es igual a la suma de su desglose (T9 lo automatiza). Commit `chore(009): fixtures sintéticos de XML y propuesta SIRE`.
- **Resultado**: 11 archivos en `fixtures/` (`rucs-prueba.json`, 5 XML UBL 2.1, `sire/` con compras, ventas y genéricos, `LEEME.md`). `xmllint` OK; totales e IGV cuadran; filas de compras = XML salvo los montos mal ubicados de San Juan y mixta; el grep de RUC da solo los de `rucs-prueba.json`. Desvíos: mixta «total 21.48» es valor de venta (importe 23.09); San Juan con valor 0.00 para cuadrar la fila; ICBPER 0.50 por bolsa (sin tarifa en `docs/`). Detalle en `fixtures/LEEME.md`.

## T3 · `MockXmlProvider` (backend · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D3–D6; CA-1, CA-3, CA-4), `plan.md` (Contratos: orden de `obtener`, fixtures), `packages/sunat/src/{puertos,errores,index}.ts`, `packages/sunat/src/mock/{consulta-ruc.mock,consulta-ruc.mock.spec}.ts` (patrón de `fallar` y centinelas), `packages/domain/src/dinero/` (API de `Money`), un fixture de `fixtures/xml/` (forma esperada).
- **Hacer**: `mock/ruta-fixture.ts` (gramática de D6, ruta resuelta dentro de `XML_FIXTURES_DIR` con `realpath` para rechazar enlaces simbólicos que salgan, tope de tamaño), `mock/ubl-sintetico.ts` (UBL 2.1 con una línea, IGV 18 % y totales de la `referencia`, todo con `Money`) y `mock/xml-provider.mock.ts` con el orden del plan, `inyectar`, `fallar`, `registro` y latencia (`XML_MOCK_LATENCIA_MS`, 0 por defecto). Exportar desde `index.ts`. Pruebas mínimas del mock (1 feliz y 1 de error por comportamiento: fixture, sintético, sin fixture ni `referencia`, `fallar` ×3 con `clasificarError`, centinelas) y las de CA-4 completas (`../`, ruta absoluta, serie o número fuera de gramática, enlace simbólico fuera), con un directorio temporal de fixtures propio.
- **Hecho cuando**: `pnpm --filter @contapp/sunat test` y `typecheck`/`eslint` OK; CA-1, CA-3 y CA-4 con prueba; ningún error ni registro contiene la clave del fixture fuera de la ruta pedida. Commit `feat(009): MockXmlProvider con fixtures, UBL sintético y errores inyectables`.

## T4 · `MockSireApiClient` (backend · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D7; CA-5), `plan.md` (Contratos), `packages/sunat/src/{puertos,errores,index}.ts`, `packages/sunat/src/mock/sire-auth.mock.ts` (patrón de `fallar`), `packages/sunat/src/mock/ruta-fixture.ts` (T3, si ya existe; si no, la gramática de `plan.md`), `fixtures/sire/` (T2, si ya existe).
- **Hacer**: `mock/sire-api-client.mock.ts`: lee `fixtures/sire/{ruc}-{libro}-{periodo}.json`, con el conjunto genérico del libro (ajustado al RUC y periodo pedidos) si no existe; valida RUC y periodo `AAAAMM` antes de tocar el disco; `fallar`, centinelas por último dígito del RUC; no conserva el token. Pruebas mínimas (propuesta de ventas sin la boleta 291, compras con los casos, genérico, `fallar`, entrada inválida). Exportar desde `index.ts` (línea propia, commit después de T3).
- **Hecho cuando**: `pnpm --filter @contapp/sunat test`, `typecheck` y `eslint` OK; CA-5 con prueba. Commit `feat(009): MockSireApiClient con propuestas desde fixtures`.

## T5 · Selección por entorno (backend · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D8, D9, D15; CA-6, CA-11), `plan.md` (Contratos: Entorno), `apps/worker/src/trabajos/{trabajos.module,trabajos.module.spec}.ts`, `apps/worker/src/app.module.ts`, `.env.example`.
- **Hacer**: `adaptadores/adaptadores.module.ts` con `ConfiguracionAdaptadoresError` (subclase de `ConfiguracionTrabajosError`, con la variable y sin valores), las fábricas de los 5 puertos (`SIRE_CLIENT`, `SOL_PORTAL`, `RUC_CLIENT`, `XML_PROVIDER`; `SireApiClient` bajo `SIRE_CLIENT`), la guarda de producción y `PERMITIR_ADAPTADORES_MOCK`; mover ahí `sireAuthDesdeEntorno`, `consultaRucDesdeEntorno` y `solAuthDesdeEntorno` y reexportarlas desde `trabajos.module.ts` con el mismo nombre; que `TrabajosService` use las fábricas; registrar el módulo en `app.module.ts`; documentar las variables nuevas (comentadas) en `.env.example`. Pruebas mínimas: entorno vacío → 5 mocks; cada variable con valor no soportado → error con su nombre; producción con mock sin permiso → error, con permiso → `warn`; no producción → sin guarda.
- **Hecho cuando**: `pnpm --filter @contapp/worker test` OK, con `trabajos.module.spec.ts` verde **sin editarlo**; `typecheck` y `eslint` OK; CA-6 y CA-11 con prueba. Commit `feat(009): adaptadores por entorno con guarda de producción`.

## T6 · KeyWrapper del backend al arrancar (backend · sonnet) — nivel A

- **Contexto (leer solo esto)**: `spec.md` (D10; CA-7), `plan.md` (Riesgos), `apps/backend/src/modules/credenciales/{key-wrapper,credenciales.module,key-wrapper.spec,key-wrapper.adv.spec}.ts`, `apps/backend/package.json` (script `dev`), `apps/backend/src/main.ts`.
- **Hacer**: con `NODE_ENV` distinto de `development` y `test` (incluido sin definir), crear el `KeyWrapper` al instanciar el módulo para que `KEK_PRIVATE_KEY_PATH` presente o `KEY_PROVIDER` inválido sea un error de arranque; en `development` y `test` sigue perezoso. No cambiar `crearKeyWrapper`, `entornoDeCifrado` ni nada de `@contapp/crypto`. Pruebas mínimas en `key-wrapper.spec.ts` o archivo nuevo `arranque.spec.ts`: producción con la ruta privada → falla, sin ella → arranca, `development`/`test` → perezoso. Verificar cómo se lanza el backend en desarrollo (`nest start --watch`, origen del `.env`): si sin `NODE_ENV` dejara de arrancar, **no** cambiar scripts y marcar `requiere usuario` (plan, Riesgos).
- **Hecho cuando**: CA-7 con prueba; los `key-wrapper*.spec.ts` y `credenciales*.spec.ts` existentes siguen en verde sin editarlos; `pnpm --filter @contapp/backend test` y `test:int` de credenciales OK; el error no contiene valores de variables. Commit `fix(009): crear el KeyWrapper al arrancar en producción`.

## T7 · Pruebas de cierre de 008 fallan en CI (tester · sonnet) — nivel A (pruebas)

- **Contexto (leer solo esto)**: `spec.md` (D11, D18; CA-8), `apps/worker/src/trabajos/cierre-r1b.adv.int.spec.ts` (líneas 85-100 y 155-190), `apps/worker/src/trabajos/cierre-r2a.adv.int.spec.ts` (líneas 85-100 y 136-150), `apps/worker/vitest.config.mts`.
- **Hacer**: donde hoy hay `ctx.skip()` por `bdDespejada()` falso, con `CI=true` lanzar un error cuyo mensaje nombre la causa (trabajos vivos de otras suites con más de 20 s sin cambios); sin `CI` omitir como hoy. Cambio solo en esa condición: ninguna aserción se borra ni se debilita. Una prueba mínima del helper (`CI` y BD no despejada → falla; sin `CI` → omite), con la lógica de decisión extraída a una función pura si hace falta para probarla sin Redis.
- **Hecho cuando**: CA-8 con prueba; las 3 pruebas siguen en verde con la BD despejada; `git diff` de los dos archivos muestra solo la condición de omisión. Commit `test(009): las pruebas de cierre de 008 fallan en CI en vez de omitirse`.
- **Resultado (2026-11-05)**: la decisión sale a `apps/worker/test/bd-despejada.ts` (`accionBdNoDespejada`, `exigirBdDespejada`, `MENSAJE_BD_NO_DESPEJADA`); con `CI=true` y BD no despejada lanza el error con la causa, sin `CI` omite como antes. Los 3 `ctx.skip()` pasan a `exigirBdDespejada(...)` (r1b ×2, r2a ×1) más el `import`; ninguna aserción tocada. Prueba CA-8: `src/trabajos/cierre-bd-despejada.spec.ts` (6, sin Redis ni BD). Worker: unitarias 161 OK con `CI=true`, las 3 de cierre en verde en serie con BD despejada, `tsc` y `eslint` limpios.

## T8 · Paso aparte en `ci:db` y CI (devops · haiku)

- **Contexto (leer solo esto)**: `spec.md` (D18), `plan.md` (Decisiones; Riesgos), `package.json` (script `ci:db`), `.github/workflows/ci.yml` (job `aislamiento`), `apps/worker/vitest.config.mts`, `apps/worker/package.json`, `apps/worker/test/bd.ts` (conexión admin de pruebas).
- **Hacer**: (1) `vitest.config.mts` del worker excluye `src/trabajos/cierre-*.adv.int.spec.ts` salvo que `CIERRE_APARTE=1`; (2) script `test:int:cierre` en el worker (`CIERRE_APARTE=1`, un solo worker de vitest, solo esos archivos) y script raíz `ci:cierre` que primero ejecuta `apps/worker/test/despejar-bd.ts` (solo si `CI=true`: marca como terminados los `job_registro` vivos con el rol admin de pruebas, sin desactivar RLS ni borrar si hay trigger que lo impida) y luego `test:int:cierre`; (3) quitar las pruebas de cierre del `test:int` normal (ya excluidas) y agregar en `ci.yml` un paso final del job `aislamiento`, después de las coberturas, que corra `pnpm ci:cierre`. No tocar `ci:db` salvo lo imprescindible.
- **Hecho cuando**: `pnpm --filter @contapp/worker test:int` ya no ejecuta las 3 pruebas de cierre; `CI=true pnpm ci:cierre` con BD y Redis levantados las ejecuta en verde y en serie; `ci.yml` válido (`actionlint` si está, o revisión del YAML). Commit `ci(009): pruebas de cierre de 008 en un paso aparte, al final y en serie`.

## T9 · Prueba de humo, RUC de prueba y canario (backend · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D13; CA-2, CA-9), `plan.md` (Contratos: Fixtures), `fixtures/` completo (T2), `packages/sunat/src/mock/{xml-provider.mock,sire-api-client.mock,sire-auth.mock,consulta-ruc.mock,sol-auth.mock}.ts`, `packages/domain/src/dinero/` (`Money`), `packages/shared/src/clientes/ruc.ts`.
- **Hacer**: `packages/sunat/src/fixtures.humo.spec.ts`: (a) cada fila de compras de `fixtures/sire/` con XML en `fixtures/xml/` coincide en total, IGV, ISC, ICBPER y moneda con el XML (parseado con `fast-xml-parser` como `devDependency` de versión exacta, o con regex si se evita la dependencia), y cada caso de CA-2 muestra su dato (ISC separado; 8.97 y 12.51; ICBPER por línea; USD 0.15/0.03/0.18; «zapatillas»); (b) las ventas traen 290 y 292 y no 291; (c) todo RUC presente en `fixtures/` está en `rucs-prueba.json` y es válido, y ningún número ni RUC termina en 7, 8 ni 9; (d) CA-9: con una credencial canario, ninguno de los 5 mocks la devuelve, la deja en sus llamadas registradas ni en sus errores (felices y fallidos); (e) grep de los helpers de pruebas del repo que generen números de comprobante o RUC al azar (informar si alguno puede caer en 7, 8 o 9).
- **Hecho cuando**: `pnpm --filter @contapp/sunat test` OK; CA-2 y CA-9 con prueba. Commit `test(009): humo de fixtures y canario en los mocks`.

## T10 · Documentación de arquitectura (devops · haiku)

- **Contexto (leer solo esto)**: `spec.md` (D2, D8, D16, D17), `docs/03-arquitectura.md` (§3 y el árbol de carpetas, líneas ~66-80, 345-420), `plan.md` (Contratos).
- **Hacer**: en la tabla de §3: `SolAuth` (verificar la clave SOL, R1), `ConsultaRuc` (variable `RUC_CLIENT`), `SireAuth` + `SireApiClient` (bajo `SIRE_CLIENT`), `SolPortal` como «R2, pendiente», y quitar `RucDirectory`; agregar `RUC_CLIENT` a la lista de variables; en el árbol, `puertos.ts` con los nombres reales y `fixtures/xml/` como sintéticos. Sin tocar otras secciones.
- **Hecho cuando**: `grep -n "RucDirectory\|MockRucDirectory" docs/03-arquitectura.md` sin resultados; la tabla coincide con `packages/sunat/src/puertos.ts` (CA-10). Commit `docs(009): nombres reales de los puertos en 03-arquitectura`.

## T11 · Verificar CA-1 a CA-11 (tester · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (todos los CA), `plan.md`, esta lista de tareas con sus resultados, y los archivos de pruebas que cada CA nombra.
- **Hacer**: por cada CA, correr la prueba o el comando que lo demuestra y anotar la evidencia (archivo:línea o salida resumida) en `spec.md`, sin repetir pruebas. Suites: `packages/shared`, `packages/sunat`, `apps/worker` (`test` y `test:int`), `apps/backend` (`test` y `test:int` de credenciales), `pnpm lint` y `pnpm typecheck` completos; el lint de límites (`apps/frontend` y `apps/backend` no importan `@contapp/sunat`); `CI=true pnpm ci:cierre` (CA-8); `grep` de secretos y de RUC en `fixtures/` (CA-9). Si un CA no se puede demostrar, listarlo con lo que falta; no corregir código.
- **Hecho cuando**: tabla CA → evidencia en la respuesta, todos marcados o con el faltante explícito; árbol de trabajo limpio (sin `dump.rdb`). Commit `docs(009): evidencia de criterios de aceptación`.

## T12 · Revisión contra la spec (arquitecto · sonnet)

- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, `git diff main...HEAD --stat`, y línea por línea los diffs de `apps/backend/src/modules/credenciales/*` (T6) y `apps/worker/src/trabajos/cierre-*.adv.int.spec.ts` (T7); de lo demás solo lo que la evidencia de T11 deje en duda.
- **Hacer**: comprobar que cada D se cumple, que T6 no cambió la lógica de cifrado y que T7 no debilitó ninguna aserción; que 009 no registra tipos de trabajo ni escribe en BD (D9); que `ESTADO.md` recibe las notas `[real]` de D12 (se las pasa al orquestador). Listar defectos como `requiere corrección` con tarea sugerida.
- **Hecho cuando**: veredicto «conforme» o lista de hallazgos; si hay hallazgos, se agregan T12a (corrección) y T12b (re-verificación) con el precedente de 007b T20.

## T13 · Cierre (devops · haiku)

- **Contexto (leer solo esto)**: `docs/specs/009-adaptadores-mock/{spec,tasks}.md`.
- **Hacer**: marcar todas las tareas `[x]` con su resultado en una línea; `spec.md` pasa a `Estado: hecha` y los CA a `[x]` según la evidencia de T11; commit con `git add` de esas rutas. No tocar `ESTADO.md` (lo actualiza el orquestador: 009 hecha, notas `[real]`, siguiente 012).
- **Hecho cuando**: `git status` limpio salvo cambios ajenos. Commit `docs(009): cierre de la spec`.
