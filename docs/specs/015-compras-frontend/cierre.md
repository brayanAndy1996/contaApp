# Cierre 015 · Compras (frontend): grilla editable tipo Excel, resumen y acciones masivas

Spec `015-compras-frontend` · nivel C · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 015-compras-frontend | C | hecha | — | Mergeada en `main` (a065109). Pantalla de compras en `apps/frontend`: grilla virtualizada (TanStack Table + Virtual) con carga por cursor, filtros, búsqueda y selección; edición por fila con teclado y cuadre en vivo (`decimal.js` solo en `lib/montos-compras.ts`); acciones por fila (clasificar, sugerencias, excluir/restaurar, duplicar), masivas con informe, deshacer/rehacer (Ctrl+Z/Ctrl+Y, sesión), agregar compra, panel Historial, resumen y diferencias, estados del periodo y exportar a Excel. Lupa y «Subir XML» deshabilitados hasta 016. CA-1 a CA-17 con evidencia (T13); prueba manual T11 con 1 defecto (grilla sin recargar tras descargar) corregido en T12; revisión T14 aprobada. Decisiones del usuario: P-1–P-10. Sin cambios de backend ni BD. CI verde (run 42656672015). |

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- ~~[017] 015 D-13 pide «quién marcó revisado»; el contrato de 014 solo trae el id (`por`) y la fecha, así que la pantalla muestra la fecha y un id corto. El Historial también muestra el autor como id corto.~~ (cerrada por 017)
- ~~[018] Flujos de teclado y prueba manual de 015 T11 (18 puntos en navegador real) como base de E2E. Ctrl+Z de una masiva de unas 4.850 filas tarda unos 7 s (recarga el listado entero).~~ (cerrada por 018)
