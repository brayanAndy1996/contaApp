# Cierre 019 · Entorno local con Docker (PostgreSQL 17, Redis 7, Mailpit)

Spec `019-docker-local` · nivel D · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 019-docker-local | D | hecha | — | Pedida por el usuario (2026-11-03). Mergeada en `main`. `docker-compose.yml` con `postgres:17`, `redis:7` y Mailpit; `pnpm servicios:up`/`servicios:down`. Prueba real: migrate ×2, seed y ci:db (2237) en verde. Sin Dockerfiles de apps (spec futura de despliegue). |
