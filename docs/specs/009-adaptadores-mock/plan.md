# Plan 009 · Adaptadores mock (XML, propuesta SIRE) y fixtures

Nivel C: este plan es más corto que un plan de A/B y solo fija lo que otros consumen. CA y D = `spec.md`. **Sin migración**: no hay tablas nuevas (la próxima libre sigue siendo la 0028 por si una spec posterior la necesita).

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| modificar | `packages/sunat/src/{puertos,index}.ts` · `packages/sunat/package.json` | `XmlProvider`, `SireApiClient` y sus tipos; dependencia `@contapp/domain` (workspace) para `Money` |
| crear | `packages/sunat/src/mock/{xml-provider,sire-api-client}.mock.ts` (+ `.spec.ts`) · `src/mock/ubl-sintetico.ts` · `src/mock/ruta-fixture.ts` | D3–D7; la gramática de la clave y la contención de ruta (D6) en un solo archivo |
| crear | `packages/shared/src/xml/{origen,index}.ts` · modificar `packages/shared/src/index.ts` | `OrigenXml` y `origenXmlSchema` (RF-097b) |
| crear | `fixtures/xml/*.xml` · `fixtures/sire/*.json` · `fixtures/rucs-prueba.json` · `fixtures/LEEME.md` | D17: casos sintéticos y lista de RUC de prueba |
| crear | `apps/worker/src/adaptadores/adaptadores.module.ts` (+ `.spec.ts`) | D8, D15: fábricas de los 5 puertos, errores y guarda de producción |
| modificar | `apps/worker/src/trabajos/trabajos.module.ts` · `app.module.ts` · `.env.example` | las `…DesdeEntorno` salen a `adaptadores.module.ts` y se reexportan; `PERMITIR_ADAPTADORES_MOCK`, `XML_MOCK_LATENCIA_MS`, `XML_FIXTURES_DIR` comentadas |
| modificar | `apps/backend/src/modules/credenciales/{credenciales.module,key-wrapper}.ts` (+ specs) | D10 (código de cifrado, ver Riesgos) |
| modificar | `apps/worker/src/trabajos/cierre-r1b.adv.int.spec.ts` · `cierre-r2a.adv.int.spec.ts` · `apps/worker/vitest.config.mts` · `apps/worker/package.json` · `package.json` (`ci:db`) · `.github/workflows/ci.yml` · crear `apps/worker/test/despejar-bd.ts` | D11/D18 (pruebas adversariales de 008, nivel A) |
| modificar | `docs/03-arquitectura.md` §3 y árbol de carpetas | D2; `fixtures/xml/` pasa de «reales/anónimos» a sintéticos (D17) |

## Contratos
**`packages/sunat/src/puertos.ts`**
- `XmlProvider.obtener(s: SolicitudXml): Promise<RespuestaXml>`. `SolicitudXml { rucEmisor; tipo; serie; numero; referencia?: ReferenciaXml }`; `ReferenciaXml { fechaEmision (AAAA-MM-DD); moneda: "PEN"|"USD"; tipoCambio?; baseGravada; igv; noGravado; isc; icbper; otros; total }` (montos como cadenas decimales). `RespuestaXml { xml: string; origen: OrigenXml; fuente: "fixture"|"sintetico"|"inyectado" }`.
- `SireApiClient.descargarPropuesta(token: TokenSire, s: { ruc; periodo: "AAAAMM"; libro: "compras"|"ventas" }): Promise<{ libro; periodo; filas: FilaPropuestaSire[] }>`. `FilaPropuestaSire { tipo; serie; numero; rucContraparte; fechaEmision; moneda; tipoCambio?; biDg; igvDg; biDgng; igvDgng; biDng; igvDng; noGravado; isc; icbper; otros; total }` (cadenas decimales; en ventas solo se usan `biDg`, `igvDg`, `noGravado`, `isc`, `icbper`, `otros`, `total`).
- `OrigenXml = "simulado" | "real"` en `@contapp/shared` (el mock siempre devuelve `"simulado"`, también con fixture).

**Mocks** (`inyectar(clave, caso)`, `fallar(modo, {veces?})`, `registro()` sin credenciales): `MockXmlProvider({ dirFixtures?, latenciaMs? })`, `MockSireApiClient({ dirFixtures? })`. Clave de un comprobante: `{ruc}-{tipo}-{serie}-{numero}`.

**Orden de `MockXmlProvider.obtener`** (sale de D4/D5/D6): validar la gramática (D6) → inyectado → centinela por último dígito del número (`…7` → `ErrorTransitorio`, `…8` → `ErrorDatos`, `…9` → `ErrorCredencial`, como `MockConsultaRuc`) → fixture → UBL sintético con `referencia` → `ErrorDatos`. Los fixtures no usan números terminados en 7, 8 ni 9 (lo comprueba la prueba de humo de T9). `MockSireApiClient` usa el mismo criterio con el último dígito del RUC; los RUC de los fixtures no terminan en 7, 8 ni 9.

**Fixtures**: `fixtures/xml/{ruc}-{tipo}-{serie}-{numero}.xml` (UBL 2.1; tributos 1000, 2000, 7152, 9997, 9998) y `fixtures/sire/{ruc}-{libro}-{periodo}.json`. `XML_FIXTURES_DIR` por defecto se resuelve desde la ubicación del archivo del mock (misma profundidad en `src` y `dist`), no desde el `cwd`, porque el worker corre en `apps/worker`. Casos y cifras (todo sintético, RUC de `fixtures/rucs-prueba.json`):
| Caso | Dato que debe estar en el XML y en su fila SIRE (con el monto mal ubicado) |
|---|---|
| San Juan | base 770 en DG con IGV 0 en la fila; el XML trae ISC 2000 por 770 |
| Mixta | total 21.48, IGV 1.61; XML con gravado 8.97 y no gravado 12.51; fila con todo en DG |
| ICBPER | ICBPER 7152 por línea (tarifa documentada en `docs/`; si no hay, 0.50 por bolsa y se anota en `LEEME.md`) |
| Redondeo USD | BI 0.15, IGV 0.03, total 0.18 con TC 3.300 (010 CA-13, sintético) |
| Zapatilla | descripción de línea «zapatillas» |
| Boleta 291 | ventas con boletas B001-290 y B001-292, sin la 291 |

**Entorno** (`adaptadores.module.ts`): `SIRE_CLIENT`, `SOL_PORTAL`, `RUC_CLIENT`, `XML_PROVIDER` (ausente = `mock`; otro valor → `ConfiguracionAdaptadoresError`, subclase de `ConfiguracionTrabajosError`, con la variable y sin valores). `NODE_ENV=production` con algún `mock` y sin `PERMITIR_ADAPTADORES_MOCK=1` → el mismo error nombrando las variables; con `1`, `warn` en el log. Exporta los 5 puertos por token de inyección (D9: nadie los consume todavía salvo `trabajos.module.ts`).

## Decisiones
- Todo en `packages/sunat` sin IO distinto de leer fixtures con `node:fs` en el mock; ninguna app importa los fixtures por ruta.
- Las pruebas de nivel C son 1 caso feliz y 1 de error por comportamiento público, escritas por `backend` junto al código; las de seguridad de ruta (CA-4) y canario (CA-9) se escriben completas porque son criterios, no extras.
- Las `…DesdeEntorno` se mueven sin cambiar su comportamiento y `trabajos.module.ts` las reexporta con el mismo nombre; `trabajos.module.spec.ts` no se edita.
- Las pruebas de cierre de 008 se separan del paso principal con un filtro de `vitest.config.mts` activado por variable (`CIERRE_APARTE=1`) y un script propio; se despeja la BD solo con `CI=true`.

## Riesgos
- Código de nivel A tocado: `key-wrapper`/`credenciales.module` (cifrado de 003/007b, T6) y los dos `*.adv.int.spec.ts` de 008 (T7). No se toca el ejecutor de 008 ni `@contapp/crypto`, y P1 se difirió justamente para no tocarlo. Medidas: los `key-wrapper*.spec.ts` y `*.adv.spec.ts` existentes siguen en verde sin edición; la revisión del arquitecto (T12) mira esos dos diffs línea por línea; no se baja ninguna aserción.
- Con `NODE_ENV` sin definir el backend se considera «producción» (H-007b-3, falla cerrado): si `nest start` no fija `NODE_ENV` y el `.env` raíz trae `KEK_PRIVATE_KEY_PATH`, el backend dejaría de arrancar en desarrollo. T6 lo comprueba y, si ocurre, informa al orquestador antes de cambiar scripts.
- Centinelas por último dígito: un RUC o número al azar en pruebas de otras specs puede caer en 7, 8 o 9 y fallar de forma intermitente (precedente `rucNuevo()` de 007b T9). Los helpers de pruebas ajenos no los usan hoy; T9 lo comprueba con un grep.
- Falsos rojos de T7/T8: otra corrida deja trabajos vivos de más de 20 s y las pruebas de cierre fallarían siempre. Por eso el paso aparte despeja los trabajos vivos antes (solo `CI=true`, rol admin de pruebas) y corre en serie.
- Un fixture y su fila SIRE pueden desalinearse al editarlos: lo cubre la prueba de humo de T9.
