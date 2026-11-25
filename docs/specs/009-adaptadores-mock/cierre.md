# Cierre 009 · Adaptadores mock (XML, propuesta SIRE) y fixtures

Spec `009-adaptadores-mock` · nivel C · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 009-adaptadores-mock | C | hecha | — | Mergeada en `main` (86311c7). Puertos `XmlProvider` y `SireApiClient` con mocks (`MockXmlProvider` con UBL 2.1 sintético, `MockSireApiClient`), `OrigenXml` en `shared`, fixtures sintéticos en `fixtures/` (San Juan ISC, mixta, ICBPER, USD, boleta 291 faltante), `adaptadores.module.ts` del worker con guarda de producción, KeyWrapper del backend comprobado al arrancar y las 3 pruebas de cierre de 008 en el paso `ci:cierre` (fallan en CI en vez de omitirse). CA-1 a CA-11 con evidencia (T11); revisión T12 conforme, 2 menores corregidos (T12a). Decisiones del usuario 2026-11-05/06: P1–P5, P-A (`NODE_ENV=development` en `dev`), P-B (despejar trabajos vivos en CI), Q1 y Q2. CI verde (run 42160930895). |

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [despliegue] El worker en producción exige `PERMITIR_ADAPTADORES_MOCK=1` mientras no haya adaptadores reales (009 D15); sin `NODE_ENV` arranca con los mocks sin aviso (aceptado por el usuario 2026-11-06, Q1): la spec de despliegue debe exigir `NODE_ENV=production` en el worker.
- [pruebas] `CI=true pnpm ci:cierre` en local borra los trabajos vivos de la base de `MIGRATIONS_DATABASE_URL` (009 D20): no usarlo contra una base de desarrollo con datos. `pnpm ci:db` ya no corre las pruebas de cierre; van en `pnpm ci:cierre`.
- [real] Los fixtures de 009 usan RUC de prueba (`fixtures/rucs-prueba.json`, terminados en 0–6) no contrastados con el padrón de SUNAT; la tarifa ICBPER de 0.50 por bolsa no está fijada en `docs/`.
