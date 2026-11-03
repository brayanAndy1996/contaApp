# Spec 019 · Entorno local con Docker (PostgreSQL 17, Redis 7, Mailpit)

Estado: verificada (usuario, 2026-11-03: "si, usemos docker haz lo necesario"; prueba real de T3 el mismo día, ver `tasks.md`)
Nivel de riesgo: D — tooling local (compose, variables y docs); no toca esquema, lógica de negocio ni datos de producción
Cubre: RNF-081 (revierte para estos servicios la desviación "sin Docker" de 001) · sin RF/HU (andamiaje técnico)

## Objetivo
El entorno local usa las mismas imágenes que el job de aislamiento del CI (`postgres:17`, `redis:7`), para que una diferencia de Unicode/ICU entre el PostgreSQL local y el del CI no vuelva a romper pruebas (pasó en 006). Lo usan el equipo de desarrollo y los agentes.

## Alcance
- `docker-compose.yml` en la raíz: `postgres:17` (BD `contapp`, superusuario para migrar), `redis:7` y `axllent/mailpit`, con healthchecks y volúmenes con nombre.
- Puertos por variables: `POSTGRES_PORT` (5432), `REDIS_PORT` (6379), `MAILPIT_SMTP_PORT` (1025), `MAILPIT_UI_PORT` (8025).
- Autenticación de PostgreSQL con usuario y contraseña de desarrollo leídos de `.env`, con valor por defecto (no `trust`).
- `.env.example` con las URLs apuntando al compose.
- Scripts raíz `pnpm servicios:up` y `pnpm servicios:down`.
- Docs: `docs/03-arquitectura.md` (§10 y árbol), `docs/01-definiciones-base.md` (§6) y `apps/worker/README.md` (arranque de Redis).

## Fuera de alcance
- Dockerfiles de las apps (frontend, backend, worker) y su despliegue: spec futura. Las apps siguen con `pnpm dev`.
- Reescribir las specs 001–018: su texto histórico no cambia. `docs/specs/ESTADO.md` lo actualiza el orquestador.
- `pnpm setup:local`, citado en 03-arquitectura y que no existe en `package.json`: no se implementa aquí; se anota en los docs.
- Autenticación de Redis y `CORREO_PROVIDER=smtp` por defecto (sigue en `consola`).

## Criterios de aceptación
- [x] CA-1: Dado `docker compose up -d --wait`, cuando termina, entonces `postgres`, `redis` y `mailpit` están en ejecución y PostgreSQL y Redis pasan su healthcheck.
- [x] CA-2: Con los servicios arriba, `pnpm db:migrate` (dos veces), `pnpm db:seed` y `pnpm ci:db` pasan.
- [x] CA-3: Los datos persisten en volúmenes con nombre tras `docker compose down`; `docker compose down -v` deja la BD vacía.
- [x] CA-4: Los puertos se configuran por variables: `POSTGRES_PORT` (5432), `REDIS_PORT` (6379), `MAILPIT_SMTP_PORT` (1025), `MAILPIT_UI_PORT` (8025).
- [x] CA-5: `.env.example` y los docs explican el flujo de arranque y cómo se fija la contraseña de `contapp_app`.
- [x] CA-6: No hay secretos reales versionados: las contraseñas del compose y de `.env.example` son solo de desarrollo, y los puertos se publican en `127.0.0.1`.
- [x] Casos reales aplicables: ninguno

## Dependencias
- Specs: 001 (decisión "sin Docker", reemplazada solo para los servicios locales), 002 (roles `contapp_*` y migraciones), 008 (Redis).
- Externas: Docker 29 con Compose v2 y acceso a Docker Hub para `postgres:17`, `redis:7` y `axllent/mailpit`.

## Preguntas abiertas
- Ninguna. Las decisiones de implementación están en `plan.md`.
