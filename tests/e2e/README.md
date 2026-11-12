# Pruebas E2E (`@contapp/tests-e2e`)

Pruebas de punta a punta de R1 con Playwright (spec 018). Cada corrida levanta su propia pila con todos
los adaptadores en `mock`: BD `contapp_e2e`, backend en `:4210`, y worker y frontend (`next start`) en
`:3210`. Al terminar apaga todo, también si la corrida falla.

## Requisitos

- Node 24 (`.nvmrc`), pnpm 10.12.1, y `pnpm install` en la raíz.
- Chromium de Playwright 1.63.0: `pnpm exec playwright install --with-deps chromium`, o
  `PLAYWRIGHT_BROWSERS_PATH` apuntando a uno ya instalado.
- `.env` de la raíz con `DATABASE_URL`, `MIGRATIONS_DATABASE_URL` (superusuario) y `REDIS_URL`
  (ver `.env.example`). La E2E nunca imprime sus valores.

## Correr

```bash
pnpm e2e                  # compila, levanta la pila y corre todo menos @volumen
pnpm e2e:volumen          # solo @volumen (E-06); usa los builds de la última `pnpm e2e`
pnpm e2e --trace off      # igual, sin trazas
```

Para una sola prueba, con la pila ya compilada:
`pnpm --filter @contapp/tests-e2e exec playwright test flujos/humo.e2e.ts`.

**Con Docker**: `pnpm servicios:up` levanta PostgreSQL 17, Redis y Mailpit (`docker-compose.yml`). Luego
`pnpm e2e`. El correo va a Mailpit (`E2E_CORREO=mailpit`, por defecto): SMTP en `MAILPIT_SMTP_PORT`
(1025) y API en `MAILPIT_UI_PORT` (8025).

**Sin Docker**: con PostgreSQL 17 y Redis nativos, `E2E_CORREO=consola pnpm e2e`. El correo se escribe
en el stdout del backend, que queda en `<tmp>/backend.log`.

## Variables

| Variable                                | Por defecto     | Efecto                                                                                              |
| --------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `E2E_CORREO`                            | `mailpit`       | `mailpit` (SMTP a Mailpit) o `consola`                                                              |
| `E2E_CONSERVAR_BD`                      | `0`             | `1`: deja `contapp_e2e` al terminar y la reutiliza si ya existe                                     |
| `E2E_REDIS_DB`                          | `14`            | Índice de Redis de la corrida (1 a 15). Se vacía al arrancar; el 0 es el de desarrollo y se rechaza; el 15 es de las pruebas de integración |
| `MAILPIT_SMTP_PORT` · `MAILPIT_UI_PORT` | `1025` · `8025` | Solo con `mailpit`                                                                                  |

## Qué hace una corrida

1. Comprueba que `:3210` y `:4210` estén libres. Si no, falla antes de tocar la BD.
2. Crea `contapp_e2e` (si ya existe, falla salvo con `E2E_CONSERVAR_BD=1`), la migra dos veces y la siembra.
3. Vacía el índice de Redis de la corrida.
4. Arranca backend, worker y frontend, y espera a que estén listos (60 s como máximo). Si un proceso
   muere o no responde, muestra las últimas 40 líneas de su log.
5. Al terminar apaga los procesos (SIGTERM, y SIGKILL a los 10 s), borra `contapp_e2e` y el directorio
   temporal. La BD de desarrollo `contapp` no se toca.

Si una corrida interrumpida dejó `contapp_e2e`, bórrala con `DROP DATABASE contapp_e2e WITH (FORCE);`.

## Reporte y trazas

Al fallar se guarda la traza en `test-results/<prueba>/trace.zip`; el reporte HTML queda en
`playwright-report/`. Las dos carpetas no se versionan.

```bash
pnpm --filter @contapp/tests-e2e exec playwright show-report
pnpm --filter @contapp/tests-e2e exec playwright show-trace test-results/<carpeta>/trace.zip
```

Las trazas solo contienen datos de fixture.

## Estabilidad (CA-4)

Sin reintentos (`retries: 0`). Para que una prueba no dependa del reloj del worker (T11b):

- Un estado de la cola que dura un ciclo del despachador (0 a 500 ms) no se comprueba «al vuelo». «En cola» se
  fuerza con `retenerRuc` (`soporte/cola.ts`), que toma el lock del RUC como el despachador y lo suelta después
  de verlo en pantalla. «Descargando…» no se puede retener: se comprueba en el registro del trabajo (`iniciadoEn`).
- La pila no cambia la concurrencia de las colas: solo `espera_ruc_ms = 0` (T6). Las pruebas no se encolan entre sí
  más de unos milisegundos porque los trabajos del mock tardan menos de 0,2 s.

## CI

El job `e2e` de `.github/workflows/ci.yml` se llama «E2E de R1 (Playwright, Chromium y Mailpit)». Sus servicios son PostgreSQL 17, Redis 7 y Mailpit (`axllent/mailpit:v1.33.0`, el de `docker-compose.yml`). Cada corrida genera la contraseña de `contapp_app`, y el correo va con `E2E_CORREO=mailpit`.

| Evento                               | `pnpm e2e` | `@volumen` (`pnpm e2e:volumen`) |
| ------------------------------------ | ---------- | ------------------------------- |
| `pull_request`                       | sí         | no                              |
| `push` a `main`                      | sí         | sí                              |
| `push` a otra rama                   | no         | no                              |
| `workflow_dispatch` (cualquier rama) | sí         | sí                              |

- Chromium: caché de `~/.cache/ms-playwright` con clave `playwright-<versión>-chromium`, con la versión de `tests/e2e/package.json`. `playwright install --with-deps chromium` corre en cada corrida; con la caché no vuelve a bajar el navegador.
- `workflow_dispatch` lanza todo el workflow: `ci` y `aislamiento` no tienen `if`, así que también corren.
- Si la corrida falla, se sube el artefacto `e2e-fallos` (`playwright-report/` y `test-results/`) por 7 días. Las trazas solo tienen datos de fixture.
- Bloquear el merge exige marcar «E2E de R1 (Playwright, Chromium y Mailpit)» como check requerido en la protección de `main`. Es un ajuste de GitHub, fuera del repo.
