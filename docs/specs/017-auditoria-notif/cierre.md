# Cierre 017 · Auditoría y notificaciones en la app

Spec `017-auditoria-notif` · nivel B · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 017-auditoria-notif | B | hecha | — | Mergeada en `main` (c2218de). Auditoría inmutable (`auditoria`, solo SELECT al backend, triggers que bloquean UPDATE/DELETE/TRUNCATE) escrita por triggers en la misma transacción de la acción, con actor del contexto (`usuario`, `trabajo` vía `withTenant({trabajoId})`, `sistema`) y catálogo cerrado de 31 acciones; consulta en `configuracion/auditoria` (lista paginada por fecha, sin filtros, P-2) con permiso `auditoria.ver`. Notificaciones en la app (`notificacion`, en la misma transacción: entrega exactamente una vez) con aviso SSE `event: notificacion` solo a los destinatarios, campana y página; destinatarios: responsable del cliente o Dueños (P-4); trabajos solo si los lanzó una persona (P-3); avisos del plan al 90 % y 100 % (P-5) una vez por día por Dueño, recurso y umbral (`plan_aviso`); purga a 90 días dentro de `auth.purgar` (P-7). Rol interno `contapp_registrador` (NOLOGIN, NOINHERIT, BYPASSRLS, sin miembros) dueño de las funciones que escriben. Autor con nombre `{id, nombre, activo}` en estado del periodo, Historial, «XML subido por» y versiones de archivo (cierra las notas [017] de 015/016). CA-1 a CA-16 con evidencia (T19); p95 con auditoría: acción sobre fila 30,5 ms, detalle de 500 ítems 20,4 ms; prueba manual T18 con defectos de pantalla corregidos (T18a); revisión T20 aprobada con desvíos ratificados en `plan.md`. Ronda adversarial: H-017-1 a H-017-3 corregidos. Decisiones del usuario 2026-11-11: P-1–P-7, avisos del plan, H-017-2 («auditarlas con triggers») y «una vez por día». Migraciones 0041–0045. CI verde (run 43090425346, tras re-ejecutar una vez CA-13 de 012b por tiempo). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 3 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `017-auditoria-notif`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [mantenimiento] Purga de auditoría con más de 5 años (017 D-7, RNF-021): R1 no purga. Fuera de 020 (P-2 = a): va a una spec de retención (RNF-020/021, Ley 29733); fecha límite 2031, cuando la primera fila cumple 5 años.
- [R2] De 017: filtros de auditoría (RF-151) e historial por cliente de HU-39; correo configurable y de avisos (RF-161/162, cola `notificaciones`); aviso de buzón crítico.
