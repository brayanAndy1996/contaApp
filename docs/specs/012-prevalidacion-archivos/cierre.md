# Cierre 012 · Prevalidación SUNAT, formatos TXT versionados y ZIP

Spec `012-prevalidacion-archivos` · nivel A · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 012-prevalidacion-archivos | A | hecha | — | Mergeada en `main` (b8be2dc). Núcleo puro: prevalidación (`prevalidar`, bloqueo por estructura, cuadre, IGV, USD y duplicados; R-ISC/R-NEW/R-GP solo avisan), `resumirCambios` (RF-102), formatos TXT versionados en `packages/domain/src/formatos/` con versión provisional `oficial: false` que no genera en producción, y `empaquetar` (ZIP + SHA-256) en `packages/sunat`. Solo compras. CA-1 a CA-11 con evidencia (T17); revisión final T18 aprobada. 2 rondas adversariales: 21 hallazgos H-012 corregidos (incluye un ajuste mínimo en `reglas/r-isc.ts` de 011). Decisiones del usuario 2026-11-06: P-1–P-13 (D9–D24). 012b (guardado, versiones, descarga y pantalla) va después de 014. CI verde (run 42257688405). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 21 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `012-prevalidacion-archivos`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [013/oficial] La versión oficial del formato (o 013) debe rechazar `tipo: "ruc"` en los campos de texto de la fila distintos del documento del proveedor (012 D23).
- [proceso] Las pruebas de las tareas de corrección (`correcciones-*.spec.ts`) las escribe el tester, no el backend (nota de la revisión de 012).
