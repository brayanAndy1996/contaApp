# Cierre 021 · Reglas aprendidas (R-HIS)

Spec `021-reglas-aprendidas` · nivel A · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 021-reglas-aprendidas | A | hecha | — | Mergeada en `main` (5005bca). R-HIS: «Recordar para este proveedor» (fila, masiva de un proveedor, lupa) crea la regla cliente + proveedor; la descarga siguiente aplica sola una versión «Según historial» (reversible, etiqueta y filtro); pantalla de reglas del cliente (editar, activar, eliminar lógico, aplicada/aceptada al revisar) y «Reglas del motor» del estudio (apagar reglas de 011, R-HIS, R-NEW y el aporte al catálogo). Confirmaciones anónimas (RUC 20) listas para 033. Decisiones del usuario P-1 a P-10 y de las rondas. Rondas ADV 1 a 3 (10 hallazgos corregidos). Defecto previo de R-GP con XML corregido. Descarga con 300 reglas 1,5–1,7× sin reglas (por lotes, 0052). Migraciones 0047–0052. CI verde con E2E (dispatch 43967662569). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 11 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `021-reglas-aprendidas`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [frontend] Vistos en 021 T23 (fuera de 021): el panel «Historial» no cierra con Esc; con el filtro «Según historial» una fila corregida sigue en el listado hasta recargar; pedir un periodo futuro (202612, 202701) da 400 sin investigar; la lupa sigue mostrando hallazgos ya aceptados tras aceptar R-GP.
- [rendimiento] El trigger por fila `compra_version_worker_acotado` (0038) se vuelve lento en una BD reutilizada (la descarga sin reglas pasa de ~0,9 s a ~3 s de inserción; 021 T25c).
- [033] Las confirmaciones de 021 (`regla_confirmacion`, 0049) son solo inserción, RUC 20 y con el aporte encendido; ninguna ruta las lee aún.
