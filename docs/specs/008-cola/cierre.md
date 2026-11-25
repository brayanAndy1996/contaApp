# Cierre 008 · Cola de trabajos, despachador justo, locks por RUC y estado en tiempo real

Spec `008-cola` · nivel A · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 008-cola | A | hecha | — | Hecha. Mergeada en `main` (74d96c9). Revisión final (T18) aprobada; 26 hallazgos de las rondas 1 y 2 corregidos; CA-1 a CA-17 con evidencia (T17). Formato en `1daa35d`. |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 26 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `008-cola`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [004] Precisa D3 (inactividad de 2 h): el stream de trabajos (`GET /trabajos/stream` y su revalidación) no renueva la sesión (008 D22, `auth.sesion_consultar`); las demás rutas renuevan como antes. Documentos de 004 sin cambios.
- [007b] Cambio de la clave SOL (008 D23, limitación aceptada): el aviso «si cambió la clave SOL, guarde o verifique de nuevo la credencial SIRE» y la verificación (HU-09) devuelven `sire_api` a `verificada`; hasta entonces los trabajos SIRE se cancelan con `credencial_invalida`.
- [real] Adaptador real de `SireAuth` detrás del puerto de `packages/sunat/src/puertos.ts` (008 deja el mock). Si con los errores reales de SUNAT distingue la causa (`invalid_client` → `sire_api`; usuario o clave → `sol`), `ErrorCredencial` indica la credencial que falló (008 D23, opción a) en vez de marcar siempre `sire_api`.
- ~~[017] Reemplazar `NotificadorLog` por el notificador real (la notificación en la app es de 017, HU-10). Hasta entonces el `Notificador` de 008 entrega «como máximo una vez».~~ (cerrada por 017)
