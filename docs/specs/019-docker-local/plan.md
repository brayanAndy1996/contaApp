# Plan 019 · Entorno local con Docker

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `docker-compose.yml` | postgres 17, redis 7 y mailpit: healthchecks, volúmenes con nombre, puertos por variable |
| modificar | `.env.example` | URLs de BD, Redis y SMTP apuntan al compose; variables de puertos y de la contraseña de desarrollo |
| modificar | `package.json` | scripts `servicios:up` y `servicios:down` |
| modificar | `docs/03-arquitectura.md` | §10 (tabla y arranque) y árbol: `docker-compose.yml` en la raíz |
| modificar | `docs/01-definiciones-base.md` | §6: BD, cola y correo locales en Docker |
| modificar | `apps/worker/README.md` | arranque de Redis con `pnpm servicios:up` |
| crear | `docs/specs/019-docker-local/{spec,plan,tasks}.md` | esta spec |

## Contratos
| Servicio | Imagen | Puerto en el host (variable · defecto) | Healthcheck | Volumen con nombre |
|---|---|---|---|---|
| postgres | `postgres:17` | `POSTGRES_PORT` · 5432 | `pg_isready -h 127.0.0.1 -U $POSTGRES_USER -d $POSTGRES_DB` | `postgres-data` → `/var/lib/postgresql/data` |
| redis | `redis:7` | `REDIS_PORT` · 6379 | `redis-cli ping` | `redis-data` → `/data` |
| mailpit | `axllent/mailpit:v1.33.0` | `MAILPIT_SMTP_PORT` · 1025 (SMTP) y `MAILPIT_UI_PORT` · 8025 (UI) | `/mailpit readyz` | `mailpit-data` → `/data` (`MP_DATABASE=/data/mailpit.db`) |

- Variables que Compose lee de `.env` o del entorno, con defecto: `POSTGRES_USER` (`postgres`), `POSTGRES_PASSWORD` (`contapp_dev`) y los cuatro puertos.
- Todos los puertos se publican en `127.0.0.1`. `name: contapp` fija el nombre del proyecto, y con él el de los volúmenes.
- Roles: `MIGRATIONS_DATABASE_URL` usa el superusuario (`postgres`). `DATABASE_URL` usa `contapp_app`, cuya contraseña fija `db:migrate` en la BD.
- Scripts raíz: `servicios:up` = `docker compose up -d --wait`; `servicios:down` = `docker compose down` (conserva los datos).

## Decisiones
- Mismas imágenes que el job `aislamiento` del CI (`postgres:17`, `redis:7`), para que la ICU y el Unicode sean los del CI. Mailpit va fijado a la versión verificada en la máquina (v1.33.0).
- PostgreSQL con contraseña (SCRAM, el valor por defecto de la imagen), no `trust` como en el CI. La contraseña es de desarrollo y sale de `POSTGRES_PASSWORD`, con defecto `contapp_dev`.
- El healthcheck de PostgreSQL usa TCP (`-h 127.0.0.1`). Durante `initdb` la imagen arranca un servidor temporal solo por socket Unix, y `pg_isready` por socket daría "listo" antes de tiempo.
- Puertos en `127.0.0.1`: las contraseñas de desarrollo no quedan expuestas en la red local.
- Redis sin contraseña, como en el CI. Persiste con el RDB por defecto en `redis-data`.
- Sin `restart:`: los servicios los levanta `servicios:up` de forma explícita.
- `POSTGRES_PASSWORD` solo se aplica al crear el volumen. Para cambiarla hay que hacer `down -v`.
- Rol `contapp_app`: `0000_roles.sql` lo crea sin contraseña, y `migrar.ts` la fija desde `DATABASE_URL` como verificador SCRAM. Por eso `DATABASE_URL` debe llevar contraseña (si no, `db:migrate` falla con "DATABASE_URL no tiene contrasena"). Para cambiarla: editar `DATABASE_URL` y volver a correr `db:migrate`.
- `.env` no se modifica. Verificado: `--env-file` y `process.loadEnvFile` no sobrescriben variables ya definidas, así que las de la línea de comando ganan.
- Las URLs de `.env.example` no admiten expansión. Si cambias un puerto, cambia también su URL.
- La spec 001 no se edita: su texto es histórico. "Sin Docker" queda reemplazado solo para los servicios locales.

## Riesgos
- Docker Hub limita las descargas anónimas (429): reintentar más tarde o hacer `docker login`.
- Un PostgreSQL nativo en 5432 choca con el compose: detenerlo, o cambiar `POSTGRES_PORT` y las dos URLs de BD a la vez.
- Si `ci:db` falla por colación o Unicode con el PostgreSQL local, es justo lo que se busca detectar: se reporta con detalle y no se cambian pruebas.
- El repo pide Node 24 (`.nvmrc`). La prueba real de 019 se corre con Node 22.22.0, porque en la máquina no hay Node 24. El resultado se anota con esa versión.
