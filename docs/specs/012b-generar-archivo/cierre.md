# Cierre 012b · Generar el archivo SIRE: guardado, versiones, descarga y pantalla

Spec `012b-generar-archivo` · nivel A · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 012b-generar-archivo | A | hecha | — | Mergeada en `main` (534656f). Guardado, versiones, descarga y pantalla del archivo SIRE de compras y ventas: previo (`GET …/archivo/previo` con resumen, errores, avisos y huella), trabajo `archivo.generar` en la cola `archivos` (canal `ninguno`) que en una `withTenant` fija `generado`, genera TXT/ZIP, lo guarda en `packages/storage` (`archivos/{tenant}/{cliente}/{uuid}.zip`) y crea la versión en `archivo_generado` (inmutable, SHA-256); descarga verificada (`leerVerificado`). P-5: un TXT idéntico no crea versión. Ventas: estado del periodo (`venta_periodo`, escrituras 409/403 con FOR SHARE), excluir/restaurar ventas con error (`venta_exclusion`, P-8) y RVIE provisional. Worker acotado por triggers (`periodo_worker_acotado`, inserción solo de la versión siguiente). Panel «Generar archivo» en compras y ventas (nivel C). CA-1 a CA-16 con evidencia (T24); prueba manual T23 con 3 defectos de pantalla corregidos (T23a); revisión T25 aprobada sin bloqueantes. Rondas adversariales: H-012b-1 a H-012b-6 corregidos. Decisiones del usuario 2026-11-10/11: P-1–P-10 y H-012b-6 («devolver sin tocar estado»). Migraciones 0039–0040. CI verde (run 42980905246). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 2 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `012b-generar-archivo`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [oficial] RVIE oficial: sustituir el formato provisional de ventas (`provisional-rve.ts`, `oficial: false`) y los nombres de archivo oficiales; revisar 012 D14/D17/D18/D24; si el RVIE oficial trae razón social, `ventaAFila` debe aplicar D7 (recorte a 100 y aviso), como compras (012b T25).
- [013] 012b amplió 013: estado del periodo de ventas (`venta_periodo`, P-1/P-9; toda escritura de ventas crea la fila `abierto` y la bloquea FOR SHARE) y exclusión de ventas del SIRE con error (`venta_exclusion`, P-8).
- ~~[rendimiento] `leerExistentesCompras` (`packages/db/src/compras/existentes.ts:13`) usa el join plano `UNION_ORIGINAL` que en `leerFilasReemplazo` daba O(n²): aplicar el mismo `join lateral … offset 0` (012b T25).~~ (cerrada por 022)
- ~~[rendimiento] Excluir/restaurar venta lee todas las ventas del periodo para encontrar una (`exclusion.service.ts:91-95`): leer por id. `avisos[]` del previo no tiene tope (sí `errores[]` y `excluidas[]`, 1.000): poner el mismo tope con `avisosOmitidos` (012b T25).~~ (cerrada por 022)
- ~~[frontend] Deuda menor de 012b: `resumen_fuera_de_rango` falta en `CODIGOS_ERROR_ARCHIVO` y `MENSAJES_ARCHIVO` (el panel muestra el mensaje genérico); la lista de versiones no muestra usuario ni SHA-256 y todas bajan con el mismo nombre de ZIP; los códigos de ventas (`CUADRE`, `USD_SIN_TC`, `SALTO_CORRELATIVIDAD`) salen sin traducir~~ (cerrada por 020). Sigue abierto: desborde de 27 px a 390 px por «Usuarios» en el menú superior.
