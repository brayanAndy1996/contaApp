# Cierre 040 · Avisos de dependencias de `pnpm audit --prod`

Spec `040-avisos-dependencias` · nivel C · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 040-avisos-dependencias | C | hecha | — | Decisión del usuario 2026-11-17. `pnpm audit --prod` de 6 avisos a 0: multer 2.5.0 (vía @nestjs/platform-express 12.3.0), nodemailer 10.1.4, fflate 0.8.3, fast-xml-parser 5.12.0. Overrides en `pnpm-workspace.yaml`: is-unsafe 2.0.3, fast-xml-builder 1.3.1, @nestjs/platform-express 12.3.0. Pruebas adversariales de XML en verde. CI verde con E2E. |

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [dependencias] Overrides de 040 en `pnpm-workspace.yaml` (fast-xml-builder 1.3.1, @nestjs/platform-express 12.3.0) fijan versiones para cumplir la regla de 2 semanas: revisarlos en la próxima actualización de dependencias.
