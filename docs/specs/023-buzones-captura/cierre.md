# Cierre 023 · Buzones SOL: captura y aviso crítico

Spec `023-buzones-captura` · nivel A · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 023-buzones-captura | A | hecha | — | Mergeada en `main` (f91c0af). RF-120, 122, 123, 126 · HU-33. Puerto `SolPortal` + `MockSolPortal` (D3 = a: el real va en spec aparte). Migraciones 0054–0058 (la siguiente libre es 0059). Decisiones del usuario: fecha no legible → fecha de captura; reloj de la BD; categoría crítica con `critico=false` → rechazar; sin espera tras credencial inválida. Revisión final T25: R-1 (alta, captura sin fin con página vacía y `siguiente`) y R-2 (baja, `cancelado` + `credencial_invalida`) corregidos en de47d5d (tope `MAX_PAGINAS_LECTURA` = 500). CI verde (run 44673860668). Riesgos aceptados: códigos de tipo de SUNAT provisionales; rendimiento de Playwright SOL (720 clientes en 3 h exige < 30 s por captura); con más de ~100k mensajes conocidos el buzón queda en el tope de 500 páginas; abrir un adjunto en pestaña nueva da 409; `maxPaginasLectura` no se valida (solo lo fijan las pruebas); `CATALOGO_BUZON.version` sigue en 1; el relleno cuesta una relectura completa. Intermitentes vistos en local (no en CI): 016 `generar-archivo.int.spec.ts` CA-2/CA-13 si el hash aleatorio de `clave_dedupe` contiene «987660»; 022 CA-7 razón de tiempos bajo carga; `revisar-buzon.int` una vez. |
