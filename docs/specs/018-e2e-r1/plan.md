# Plan 018 · Pruebas E2E de R1

Nivel C. Sin migraciones ni rutas nuevas: 018 solo agrega el paquete de pruebas, el job de CI y las correcciones de pantalla de P-2 y P-6. D-n, CA-n y P-n son los de `spec.md`.

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `tests/e2e/{package.json,tsconfig.json,eslint.config.mjs,playwright.config.ts,README.md}` | Paquete `@contapp/tests-e2e` con scripts `e2e`, `e2e:volumen`, `e2e:build`, `typecheck` y `lint` (D-1, D-7, CA-12) |
| crear | `tests/e2e/soporte/pila/{entorno,bd,procesos,global-setup,global-teardown}.ts` | Entorno explícito, BD `contapp_e2e`, arranque y apagado de backend, worker y frontend (D-2, D-3) |
| crear | `tests/e2e/soporte/{siembra,sesiones,correo,vigilancia,fixtures}.ts` · `soporte/selectores/<area>.ts` | Datos por SQL, sesión por API, enlace de correo, canarios (D-4, D-5, D-6, D-8) |
| crear | `tests/e2e/flujos/{alta,equipo,clientes,notificaciones,descarga-compras,grilla-compras,lupa,archivo,ventas,aislamiento,volumen,humo}.e2e.ts` | E-01 a E-11 (mapa en `tasks.md`) |
| modificar | `package.json` (raíz: `e2e`, `e2e:volumen`) · `turbo.json` (`build.env: ["BACKEND_URL"]`) | Comando raíz (CA-1); turbo no reutiliza un `.next` compilado para otro backend |
| modificar | `.github/workflows/ci.yml` (`on.workflow_dispatch`, job `e2e`) | P-1, P-5, D-9, CA-11 |
| modificar | `apps/frontend/components/{compras,archivos,ventas}/*.tsx` con región de aviso duplicada, y sus `*.spec.tsx` | P-2 · CA-10 |
| modificar (condicional) | `apps/frontend/**` | Defectos de pantalla de P-6 (tareas «Tna») |

## Contratos
**Arranque comprobado en el código (2026-11-12)**:
- Backend: `apps/backend` no tiene `start`; tras `nest build` se arranca con `node dist/main.js` (escucha `PORT`). No hay ruta de salud: está listo cuando `GET :4210/auth/sesion` responde 401.
- Worker: `node dist/main.js` (`createApplicationContext`, sin puerto). Está listo cuando la cola principal de BullMQ lista al menos un worker (`getWorkers()`), sin depender de logs.
- Frontend: `next build` y `next start -p 3210`. `next.config.ts` reenvía `/api/:path*` a `BACKEND_URL` con `rewrites`, que quedan fijados al compilar: `BACKEND_URL=http://localhost:4210` va en el build y en el start. Está listo cuando `GET :3210/login` responde 200.
- Ni backend ni worker leen `.env` por sí mismos (solo los CLI de `db` usan `--env-file-if-exists`), así que `procesos.ts` pasa el entorno completo.
- BD: `pnpm db:migrate` (con `MIGRATIONS_DATABASE_URL`, superusuario; fija la contraseña de `contapp_app` según `DATABASE_URL`) dos veces y `pnpm db:seed` (idempotente, se niega con `NODE_ENV=production`). Los planes vienen de la migración 0022. Precedente: 017 T18 con `contapp_t18`.
- Correo (`apps/backend/src/config/entorno.ts`): `CORREO_PROVIDER=consola` (por defecto) escribe en stdout `[correo:consola]`, `para:`, `asunto:` y el texto con el enlace; `smtp` exige `SMTP_URL` y `CORREO_REMITENTE`. `docker-compose.yml` trae `axllent/mailpit:v1.33.0` (SMTP 1025, API 8025).

**Entorno de la pila** (`entorno.ts`, a partir de `process.env`, que el CI fija y en local sale de `.env` leído solo por `entorno.ts`): `NODE_ENV=development`; `PORT=4210`; `APP_ORIGIN=http://localhost:3210`; `BACKEND_URL=http://localhost:4210`; `TRUST_PROXY=loopback`; `DATABASE_URL` y `MIGRATIONS_DATABASE_URL` con la BD cambiada a `contapp_e2e`, nada más; `REDIS_URL` con el índice `E2E_REDIS_DB` (14 por defecto; el 15 es de las pruebas de integración de 008); `SIRE_CLIENT`, `SOL_PORTAL`, `RUC_CLIENT`, `XML_PROVIDER` y `KEY_PROVIDER` en `mock`; `STORAGE=local` y `STORAGE_DIR=<tmp>/storage`; `XML_SIMULADO_EN_REGLAS=1`; `ARGON2_*` en el piso; correo según `E2E_CORREO` (`mailpit` por defecto: `smtp`, `SMTP_URL=smtp://localhost:${MAILPIT_SMTP_PORT}`, `CORREO_REMITENTE=e2e@contapp.test`; `consola`: stdout del backend a `<tmp>/backend.log`). Variables propias: `E2E_CORREO`, `E2E_CONSERVAR_BD`, `E2E_REDIS_DB`, `MAILPIT_UI_PORT`. Nunca se registra ni se imprime el entorno.

**Soporte que usan los flujos** (`fixtures.ts` extiende `test`):
- `siembra`: `estudio({ plan })` → `{ tenantId, dueno }`; `miembro(tenantId, rol)`; `cliente(tenantId, { ruc, asignadoA? })`; `comprasPorSql(clienteId, periodo, n)` (E-06). Por SQL con `MIGRATIONS_DATABASE_URL`, como `tests/aislamiento/soporte.ts`. Correos `e2e+<uuid>@contapp.test`. Contraseña: la PHC precalculada de `SEED.credenciales` (`@contapp/db`), que corresponde a `SEED.contrasenaDesarrollo`.
- `sesiones`: `entrar(usuario, tenantId)` → `storageState` por `POST /api/auth/login` (y `/api/auth/estudio` si hace falta) con `Origin: http://localhost:3210` y `X-Forwarded-For` de `ipUnica()`. `paginaDe(usuario)` abre un contexto con ese estado.
- `correo`: `enlaceDe(destinatario, asunto)` espera ≤ 30 s el último correo y devuelve el enlace (API de Mailpit `/api/v1/search?query=to:<correo>` o `backend.log`).
- `vigilancia` (fixture automático, D-8): registra respuestas `/api`, consola y DOM final; falla con un centinela de credencial, con `window.__pwn` o con errores de consola no declarados (`vigilancia.permitirError(regex)`).
- `selectores/<area>.ts`: los únicos lugares con `locator('css…')`.

**Etiquetas y comandos**: `@volumen` (E-06). `pnpm e2e` = `e2e:build` + `playwright test --grep-invert @volumen`; `pnpm e2e:volumen` = `--grep @volumen`. `e2e:build` = `turbo run build --filter=@contapp/backend... --filter=@contapp/worker... --filter=@contapp/frontend^...` y luego `next build` del frontend fuera de turbo con `BACKEND_URL`.

**CI** (job `e2e`, `needs: []`): `if: github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/main')`. Servicios `postgres:17` (trust, como `aislamiento`), `redis:7` y `axllent/mailpit:v1.33.0` (`--health-cmd "/mailpit readyz"`). Contraseña de `contapp_app` por corrida, con `::add-mask::`. En los PR, `pnpm e2e`; en `main` y a mano, `pnpm e2e && pnpm e2e:volumen` (sin repetir el build). Caché de `~/.cache/ms-playwright` con clave `playwright-<versión>-chromium`. Artefacto `playwright-report/` y `test-results/` solo con `if: failure()`, `retention-days: 7`. `timeout-minutes: 20`.

## Decisiones
- La pila la levanta el `globalSetup`, no `webServer` — la BD tiene que existir antes del backend y el worker no tiene puerto (ajuste de D-2).
- Sesiones por API con `X-Forwarded-For` único y sin proyecto `setup` — `login_ip` permite 20 intentos por IP cada 10 min y `registro_ip` 5 por hora; con `--repeat-each=3` y 4 workers se agotarían (ajuste de D-4).
- `next build` del frontend fuera de turbo y `BACKEND_URL` declarada en `turbo.json` — turbo 2 trabaja en modo estricto: sin declararla, el build no la ve y la caché podría restaurar un `.next` que apunta a otro backend.
- Mismas credenciales de rol que el entorno, cambiando solo el nombre de la BD — los roles son de todo el clúster y `db:migrate` fija la contraseña de `contapp_app`.
- `baseURL` = `http://localhost:3210`, no `127.0.0.1` — la cookie `__Host-` es `Secure` y el origen tiene que ser igual a `APP_ORIGIN`.
- Selectores en `soporte/selectores/<area>.ts` (ajuste de D-6) — cada tarea de flujos trabaja en archivos propios y pueden ir en paralelo.
- Correcciones de P-2 antes de los flujos de compras, lupa, archivo y ventas — así los localizadores por rol cuentan 1 desde el principio.

## Riesgos
- **Intermitencia por cola y SSE** — todo trabajo se espera por el estado en pantalla con un tope de 30 s; CA-4 (`--repeat-each=3`, 3 corridas en CI) la detecta. Un fallo intermitente es un defecto y vuelve a la tarea del flujo.
- **Pub/sub de Redis no separa por índice** — en local, si `dev` corre a la vez, el backend de la E2E recibe los avisos del worker de `dev`. Los ids no coinciden, así que no mezclan datos; en CI no hay `dev`. Si aparece ruido, la E2E usa otro Redis (`REDIS_URL` propio).
- **`--repeat-each` y datos compartidos** — cada prueba crea su estudio; ningún flujo depende del orden. Lo comprueban `--workers=1` y `--workers=4` (CA-5).
- **Procesos huérfanos** — `procesos.ts` guarda los PID, el teardown manda SIGTERM y SIGKILL a los 10 s, y otra corrida con los puertos 3210/4210 ocupados falla al arrancar con un mensaje claro (CA-1).
- **Secretos en trazas** — las trazas solo llevan datos de fixture; `backend.log` (modo consola) queda en el directorio temporal, que el teardown borra y que no se sube como artefacto.
- **Tiempo del CI (CA-3)** — si la suite pasa de 6 min, primero se ajusta el número de workers y luego se parten archivos. No se quitan escenarios.

## Desvíos ratificados (T12, 2026-11-12)
Revisión del arquitecto contra `spec.md`, con el código de la rama (`git diff main...HEAD`). Los desvíos se separan de los defectos: ninguno abre tarea.

| # | Desvío | Dónde | Veredicto | Razón y condición |
|---|---|---|---|---|
| 1 | Redis índice 14 (`E2E_REDIS_DB`), no el 15 | `soporte/pila/entorno.ts:86` | Ratificado | El 15 es de las pruebas de integración de 008 y el 0 es el de desarrollo (se rechaza). `vaciarIndiceRedis` hace `FLUSHDB` solo de ese índice. Ajusta D-3 sin cambiar su intención |
| 2 | `config_sistema.espera_ruc_ms = 0` en `contapp_e2e` | `soporte/pila/bd.ts:92-103` (`quitarEsperaPorRuc`) | Ratificado | Solo toca la BD de la E2E, antes de arrancar el worker, y no cambia código: la cortesía de 2 s por RUC es de SUNAT y con mocks no hay a quién cuidar; sin esto, las pruebas en paralelo con el RUC de fixture pasarían del tope de 30 s. La espera real sigue cubierta por las pruebas de integración de 008. Queda dicho en el README |
| 3 | T11a: ante un 401, comprobar la sesión y reintentar una vez | `apps/frontend/lib/api.ts` · `api-401.spec.ts` | Ratificado | Es un defecto real de pantalla (P-6): la petición salió con la cookie rotada y el cambio de estudio echaba al login. Un solo reintento, comprobación de sesión compartida, `X-Estudio` y CSRF recalculados, sin bucle. Un 401 rechaza antes de ejecutar, así que reintentar un POST no lo duplica. El servidor no cambia |
| 4 | `permitirError(/status of 401/)` y `permitirError(/status of 409/)` | `equipo.e2e.ts:285,291,346,352` · `aislamiento.e2e.ts` | Ratificado | Son el 401 de la rotación (recuperado por T11a) y el 409 `estudio_desfasado` de la campana (contrato 004 D12, que `api.ts` ya maneja). El navegador los anota en consola aunque la app se recupere. Las aserciones no se tocaron y solo está declarado en las pruebas que cambian de estudio con la pantalla cargada. Condición: no ampliar a otras pruebas sin causa medida |
| 5 | Correcciones de app dentro de 018 | | Ratificado (5a a 5c) | Ninguna adapta una prueba a un defecto; cada una se encontró con una prueba en rojo y tiene prueba propia |
| 5a | T11c · despachador y reconciliador | `packages/queue/src/despachador.ts`, `reconciliador.ts`, `tipos.ts` | Ratificado | Es código de servidor, fuera de la regla «se escala» de P-6, y se hizo por decisión del usuario (nivel de la tarea: TDD y ADV). Carrera real (30 a 60 s de trabajo invisible). 4 pruebas de integración en rojo con el código anterior y 12 adversariales; sin Lua, compatible con el Redis falso |
| 5b | T11d · foco tras Tab y menú «Acciones» | `grilla-compras.tsx`, `foco-grilla.ts`, `acciones-fila-compras.tsx` | Ratificado | Defecto de pantalla pequeño (P-6). El menú: la causa quedó por mecanismo, no reproducida; se corrigió con un criterio que no oculta nada (cierra si el botón se movió) y 30 ejecuciones lo pasan |
| 5c | T11e · stream SSE | `apps/backend/src/modules/trabajos/stream.service.ts`, `apps/frontend/lib/trabajos.ts` | Ratificado, con nota | Es servidor (excepción a P-6, autorizada por el orquestador y el usuario). El primer byte sale tras confirmar la suscripción Redis y el frontend espera el stream antes de listar, con tope de 3 s (`TOPE_ESPERA_STREAM_MS`). Con el tope vencido se lista igual y el evento perdido solo se recupera al recargar el listado (≤ 5 min): es el mismo riesgo de antes, ahora acotado a un backend lento. Pruebas unitaria e int del backend y del frontend |

Comprobaciones de la revisión:
- Sin `fixme`, `skip` ni `test.only` en `tests/e2e`; `retries: 0` (`playwright.config.ts:25`). Los `setTimeout` son `test.setTimeout(…)` (tope por prueba), no esperas.
- Ningún selector CSS ni XPath fuera de `soporte/selectores/`.
- `apps/frontend/package.json` no cambia en la rama (`git diff main...HEAD`): el frontend no gana dependencias. El cambio de `pnpm-lock.yaml` en el importador del frontend es el sufijo de pares de `next` (`@playwright/test@1.63.0`), no una dependencia.
- Trazas y artefacto: solo el reporte y `test-results/` de `tests/e2e`, con retención de 7 días y `if: failure()`. Contienen los valores de fixture (`USUPRUEBA`, `CLAVEPRUEBA`, etc.), las cookies de sesión de usuarios de una BD que el job descarta y la contraseña de fixture de `SEED`; la contraseña de `contapp_app` del CI se enmascara (`::add-mask::`) y no pasa por las pruebas. No hay secretos reales. `backend.log` no se sube.
- `ci.yml`: el job `e2e` cubre exactamente P-1 y P-5 (PR, `main`, `workflow_dispatch`); `@volumen` solo en `main` y a mano; `ci` y `aislamiento` sin cambios.
