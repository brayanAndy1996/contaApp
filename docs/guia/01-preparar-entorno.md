# 01 · Preparar tu entorno de prueba

> Anterior: [00 · Índice](00-indice.md) · Siguiente: [02 · Entrar a ContApp](02-entrar-a-contapp.md) · Índice: [00-indice.md](00-indice.md)

Al terminar este módulo tendrás ContApp funcionando en tu computadora, con dos estudios de prueba, sus usuarios y un super-admin. Sabrás dónde leer los correos que envía el sistema (confirmaciones, invitaciones, recuperación de contraseña), cómo apagarlo y cómo empezar de cero.

## Para qué sirve

Antes de usar ContApp con tu equipo necesitas un lugar seguro donde probarlo: tu propia computadora. Es como armar un «estudio de práctica» con clientes ficticios, donde puedes equivocarte sin consecuencias.

El entorno de prueba tiene dos partes:

- **Servicios** que corren en Docker: la base de datos (PostgreSQL 17), Redis 7 (la cola de trabajos) y Mailpit (un buzón de correo de mentira).
- **Las tres aplicaciones** de ContApp, que corren con `pnpm`: la web (lo que ves en el navegador), el backend (las reglas y la seguridad) y el worker (las tareas en segundo plano).

Todo lo que se conecta con SUNAT está **simulado**: nada sale a internet. Lo explica el [índice](00-indice.md#antes-de-empezar-lee-esto).

## Quién puede usarlo

Este módulo no depende de un rol dentro de ContApp: lo hace la persona que instala el sistema en su computadora.

| Quién | Qué hace en este módulo |
|---|---|
| Quien instala (tú) | Instala las herramientas, levanta los servicios, carga los datos de prueba y arranca ContApp. Necesita permiso de administrador en su computadora para instalar Docker. |
| Super-admin de plataforma | Lo crea el seed (o el comando `pnpm db:plataforma-alta`). Gestiona planes y estudios; lo verás en el [módulo 04](04-planes-y-limites.md). |
| Usuarios de los estudios de prueba | Los crea el seed con su rol. Los usarás en los módulos siguientes. |

## Antes de empezar

Necesitas instalado:

| Herramienta | Versión | Para qué | Cómo comprobarla |
|---|---|---|---|
| Node.js | 24.x (`>=24.1.0 <25`) | Correr las aplicaciones | `node -v` muestra `v24.…` |
| pnpm | 10.x (`>=10.12.1 <11`; el proyecto fija `pnpm@10.12.1`) | Instalar y arrancar el proyecto | `pnpm -v` muestra `10.…` |
| Docker con Compose v2 | Docker Desktop actual (la spec 019 se probó con Docker 29) | Levantar PostgreSQL, Redis y Mailpit | `docker compose version` |
| Git | cualquiera reciente | Descargar el código | `git --version` |
| Navegador | Chrome, Edge o Firefox | Usar ContApp | — |

Las versiones exactas de Node y pnpm están en el campo `engines` del `package.json` de la raíz. Para instalar pnpm en Windows: `corepack enable` y luego `corepack prepare pnpm@10.12.1 --activate` (ver el [curso técnico](../curso/00-indice.md#lo-que-necesitas-instalado)).

Ten a mano el código del proyecto: clónalo desde el repositorio que te compartió el equipo y abre una terminal en su carpeta raíz (la que tiene `package.json` y `docker-compose.yml`).

## Paso a paso

### Crear tu archivo de configuración `.env`

1. En la raíz del proyecto, copia el archivo de ejemplo:
   - En Linux, macOS o Git Bash: `cp .env.example .env`
   - En PowerShell: `Copy-Item .env.example .env`
2. No cambies nada por ahora. Los valores de ejemplo ya apuntan a los servicios de Docker y dejan todos los adaptadores en `mock`.

**Resultado esperado:** existe un archivo `.env` en la raíz. Ese archivo no se sube al repositorio (está en `.gitignore`) y **no se comparte**: tiene contraseñas, aunque sean de desarrollo.

### Instalar las dependencias

1. Ejecuta `pnpm install`.
2. Espera a que termine. La primera vez descarga muchos paquetes y puede tardar varios minutos.

**Resultado esperado:** termina sin errores y aparece la carpeta `node_modules`.

### Levantar los servicios (PostgreSQL, Redis y Mailpit)

1. Abre Docker Desktop y espera a que diga que está en ejecución.
2. Ejecuta `pnpm servicios:up` (equivale a `docker compose up -d --wait`).

**Resultado esperado:** el comando espera a que los tres servicios estén sanos y devuelve el control. En Docker Desktop verás el proyecto `contapp` con `postgres`, `redis` y `mailpit` en marcha.

### Compilar y preparar la base de datos

1. Ejecuta `pnpm build`. Compila todos los paquetes; los comandos de base de datos usan lo compilado (`dist/`), así que este paso es obligatorio la primera vez y cada vez que actualices el código.
2. Ejecuta `pnpm db:migrate`. Crea las tablas, las reglas de seguridad y los planes. Puedes repetirlo sin riesgo.
3. Ejecuta `pnpm db:seed`. Carga los estudios, usuarios y clientes de prueba. También se puede repetir: no duplica nada.

**Resultado esperado:** los tres comandos terminan sin mensajes de error. `db:migrate` y `db:seed` leen el `.env` por su cuenta.

### Arrancar ContApp

El backend y el worker **no leen el archivo `.env` por sí solos**: necesitan que sus variables estén cargadas en la terminal desde la que los arrancas. Además, `pnpm dev` usa Turbo, que por defecto no pasa esas variables a las aplicaciones; por eso se agrega `--env-mode=loose`.

1. Carga el `.env` en la terminal:
   - En Linux, macOS o Git Bash:
     ```bash
     set -a; . ./.env; set +a
     ```
   - En PowerShell (copia la línea completa):
     ```powershell
     Get-Content .env | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object { $n, $v = $_ -split '=', 2; [Environment]::SetEnvironmentVariable($n, $v, 'Process') }
     ```
2. En **esa misma terminal**, ejecuta `pnpm dev --env-mode=loose`.
3. Espera a que el frontend diga que está listo y abre `http://localhost:3000` en el navegador. Usa siempre `localhost`, no `127.0.0.1` (ver «Problemas frecuentes»).

**Resultado esperado:** la terminal muestra la salida de las tres aplicaciones (frontend, backend y worker, con la línea `Worker iniciado`), y el navegador te lleva a la pantalla «Ingresar a ContApp».

> Alternativa: con el `.env` cargado, puedes arrancar cada aplicación en su propia terminal con `pnpm --filter @contapp/backend dev`, `pnpm --filter @contapp/worker dev` y `pnpm --filter @contapp/frontend dev`. Antes corre `pnpm build`.

### Entrar con un usuario de prueba

1. En «Ingresar a ContApp», escribe el correo `ua@seed.contapp.test`.
2. En «Contraseña» escribe `desarrollo-contapp-2026` (es la contraseña de desarrollo del seed; solo sirve en tu entorno local).
3. Haz clic en «Ingresar».

**Resultado esperado:** entras directo al «Estudio A (seed)», porque ese usuario pertenece a un solo estudio. El inicio muestra «Plan Corporativo», «RUCs: 3 de 600» y «Usuarios: 2 de ilimitado».

### Crear otro super-admin (opcional)

El seed ya trae un super-admin (`plataforma@seed.contapp.test`). Si quieres otro con tu propio correo y contraseña:

1. Elige una contraseña de prueba de 12 a 128 caracteres que no sea común.
2. Ejecuta, según tu terminal:
   - Linux, macOS o Git Bash:
     ```bash
     CONTAPP_PLATAFORMA_CONTRASENA='mi-clave-de-prueba-2026' pnpm db:plataforma-alta --correo admin@prueba.test --nombre "Admin de prueba"
     ```
   - PowerShell:
     ```powershell
     $env:CONTAPP_PLATAFORMA_CONTRASENA = 'mi-clave-de-prueba-2026'
     pnpm db:plataforma-alta --correo admin@prueba.test --nombre "Admin de prueba"
     Remove-Item Env:CONTAPP_PLATAFORMA_CONTRASENA
     ```

**Resultado esperado:** el comando responde `super-admin creado`. Si el correo ya era de un usuario, responde `super-admin agregado` y no toca su contraseña. Si lo repites, responde `sin cambios`. El comando nunca muestra la contraseña.

### Ver los correos que envía ContApp

ContApp envía correos para confirmar el registro, invitar, recuperar la contraseña y avisar de un bloqueo o de un cambio de contraseña. Dónde los ves depende de `CORREO_PROVIDER` en el `.env`:

| `CORREO_PROVIDER` | Dónde aparece el correo | Cómo se ve |
|---|---|---|
| `consola` (el valor de `.env.example`) | En la terminal donde corre `pnpm dev`, dentro de la salida del backend | Un bloque que empieza con `[correo:consola]`, seguido de `para:`, `asunto:` y el texto con el enlace |
| `smtp` | En Mailpit: abre `http://localhost:8025` | Una bandeja de entrada como la de cualquier correo web |

Para usar Mailpit:

1. Edita el `.env` y deja estas tres líneas así:
   ```text
   CORREO_PROVIDER=smtp
   CORREO_REMITENTE=contapp@prueba.test
   SMTP_URL=smtp://localhost:1025
   ```
2. Detén `pnpm dev` (Ctrl+C), vuelve a cargar el `.env` en la terminal y arráncalo otra vez.

**Resultado esperado:** al pedir, por ejemplo, la recuperación de contraseña, el correo «ContApp: restablece tu contraseña» aparece en Mailpit. Con `smtp`, `CORREO_REMITENTE` es obligatorio: si lo dejas vacío, el backend no arranca.

### Apagar ContApp

1. En la terminal de `pnpm dev`, presiona Ctrl+C.
2. Ejecuta `pnpm servicios:down`.

**Resultado esperado:** los contenedores se detienen. **Los datos se conservan**: la próxima vez basta con `pnpm servicios:up`, cargar el `.env` y `pnpm dev --env-mode=loose`.

### Empezar de cero

Si quieres borrar todo lo que hiciste (clientes, correcciones, estudios registrados, correos de Mailpit) y volver al seed:

1. Detén `pnpm dev` (Ctrl+C).
2. Ejecuta `docker compose down -v`. La opción `-v` **borra** los volúmenes de PostgreSQL, Redis y Mailpit.
3. Ejecuta `pnpm servicios:up`, `pnpm db:migrate` y `pnpm db:seed`.
4. Carga el `.env` y arranca con `pnpm dev --env-mode=loose`.

**Resultado esperado:** ContApp vuelve a tener solo los datos del seed.

## Qué ves en pantalla

### Servicios y puertos

Todos los puertos se abren solo en tu computadora (`127.0.0.1`): nadie de tu red puede entrar.

| Servicio | Dónde | Puerto (variable del `.env`) |
|---|---|---|
| Web de ContApp (frontend) | `http://localhost:3000` | 3000 |
| Backend (API) | `http://localhost:4000` (no lo abras: la web lo usa por ti) | 4000 (`PORT`) |
| Worker | no abre puerto | — |
| PostgreSQL 17 | — | 5432 (`POSTGRES_PORT`) |
| Redis 7 | — | 6379 (`REDIS_PORT`) |
| Mailpit: buzón web | `http://localhost:8025` | 8025 (`MAILPIT_UI_PORT`) |
| Mailpit: SMTP | — | 1025 (`MAILPIT_SMTP_PORT`) |

### Usuarios del seed

Todos usan la contraseña de desarrollo `desarrollo-contapp-2026`, guardada en el repositorio **solo para pruebas locales**.

| Correo | Nombre | Estudio y rol | Qué verás al entrar |
|---|---|---|---|
| `ua@seed.contapp.test` | Usuario A | Estudio A (seed): Dueño | Entra directo al Estudio A |
| `ub@seed.contapp.test` | Usuario B | Estudio B (seed): Dueño | Entra directo al Estudio B |
| `uab@seed.contapp.test` | Usuario AB | Estudio A y Estudio B: Contador en ambos | «Elige tu estudio» con los dos |
| `usin@seed.contapp.test` | Usuario sin estudio | ninguno | «No perteneces a ningún estudio activo…» |
| `plataforma@seed.contapp.test` | Administrador de plataforma | ninguno (es super-admin) | «Elige tu estudio» con el enlace «Administración de plataforma» |

### Estudios y clientes del seed

| Estudio | Plan | Clientes (RUC · razón social) | Asignaciones |
|---|---|---|---|
| Estudio A (seed) | Corporativo, activa | `20100070970` · Cliente compartido (A) · `20100047218` · Cliente A dos · `20131312955` · Cliente A tres | Usuario AB es responsable de «Cliente compartido (A)» |
| Estudio B (seed) | Corporativo, activa | `20100070970` · Cliente compartido (B) · `20100130204` · Cliente B dos · `20601234567` · Cliente B tres | Usuario AB es responsable de «Cliente compartido (B)» |

El RUC `20100070970` está a propósito en los dos estudios: sirve para comprobar que un estudio nunca ve los datos del otro.

### Datos de prueba de SUNAT (`fixtures/`)

El seed **no** trae al contribuyente con propuestas. Lo crearás en el [módulo 05](05-clientes.md):

| Dato | Valor |
|---|---|
| Contribuyente de prueba | RUC `20700000002`, «PRUEBA CONTRIBUYENTE S.A.C.» |
| Periodo con propuestas | `202610` (octubre de 2026), compras y ventas |
| Proveedores de los casos | `20700000011` (San Juan, ISC), `20700000045` (mixta), `20700000053` (ICBPER), `20700000061` (USD), `20700000070` (zapatilla), `20700000096` (genérico) |
| Dónde están | `fixtures/rucs-prueba.json`, `fixtures/sire/` y `fixtures/xml/` (léelo en `fixtures/LEEME.md`) |

Ningún RUC ni número de comprobante de los fixtures termina en 7, 8 ni 9. Esas terminaciones están reservadas para que los simuladores devuelvan **errores a propósito**; los módulos siguientes las usan para probar los casos de error.

## Reglas y límites

| Mensaje que ves | Por qué | Qué hacer |
|---|---|---|
| `el seed de desarrollo no se ejecuta con NODE_ENV=production` | El seed trae una contraseña publicada en el repositorio; nunca se carga en producción. | Quita `NODE_ENV=production` de tu terminal o de tu `.env`. |
| `falta MIGRATIONS_DATABASE_URL` | Corriste `db:migrate`, `db:seed` o `db:plataforma-alta` sin `.env`. | Crea el `.env` desde `.env.example`. |
| `Falta DATABASE_URL para createDb` (al arrancar el backend) | El backend no recibió las variables del `.env`. | Carga el `.env` en la terminal y usa `pnpm dev --env-mode=loose`. |
| `Entorno inválido: CORREO_REMITENTE` o `Entorno inválido: SMTP_URL` | Pusiste `CORREO_PROVIDER=smtp` sin remitente o sin URL. | Completa las dos líneas, o vuelve a `consola`. |
| `contraseña inválida: debe tener entre 12 y 128 caracteres` / `…es una contraseña demasiado común` | `db:plataforma-alta` aplica la misma política que la pantalla. | Elige otra contraseña. |

Otras reglas que conviene saber:

- **No ingreses claves SOL ni credenciales SIRE reales.** En este entorno se cifran con una llave de pruebas cuya parte privada está en el repositorio.
- **`POSTGRES_PASSWORD` solo se aplica al crear la base.** Si la cambias en el `.env` después, no cambia en PostgreSQL: tienes que empezar de cero (`docker compose down -v`).
- **Si cambias un puerto en el `.env`, cambia también su URL** (`DATABASE_URL`, `MIGRATIONS_DATABASE_URL`, `REDIS_URL`).

## Pruébalo con los datos de prueba

1. Entra con `ua@seed.contapp.test`. Debes ver «Estudio A (seed)» en el selector «Estudio» y, en el menú, «Clientes», «Trabajos», «Usuarios» y «Auditoría».
2. Haz clic en «Clientes». Debes ver los tres clientes del Estudio A y, en «Responsable», «Usuario AB» para «Cliente compartido (A)» y «Sin responsable» para los otros dos.
3. Haz clic en «Cerrar sesión» y entra con `uab@seed.contapp.test`. Debes ver «Elige tu estudio» con «Estudio A (seed)» y «Estudio B (seed)». Elige el B: en «Clientes» solo aparece «Cliente compartido (B)», porque un Contador ve solo sus clientes asignados.
4. Cierra sesión y, en «Olvidé mi contraseña», pide el enlace para `ua@seed.contapp.test`. Busca el correo «ContApp: restablece tu contraseña» en la terminal (con `consola`) o en `http://localhost:8025` (con Mailpit). No hace falta que la cambies: basta con ver que llegó.
5. Entra con `plataforma@seed.contapp.test` y haz clic en «Administración de plataforma». Debes ver la tabla «Estudios» con los dos estudios del seed en «Corporativo».

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `pnpm servicios:up` dice que no puede conectar con Docker | Docker Desktop no está abierto o aún está arrancando. | Ábrelo y espera a que diga que está en ejecución. Vuelve a intentarlo. |
| `pnpm servicios:up` falla con «port is already allocated» o «address already in use» | Otro programa usa 5432, 6379, 1025 u 8025 (por ejemplo, un PostgreSQL instalado antes). | Detén ese programa o cambia el puerto en el `.env` (y la URL correspondiente). |
| `pnpm db:migrate` falla con «Cannot find module …/dist/cli/migrar.js» | No compilaste. | Ejecuta `pnpm build` y repite. |
| `pnpm db:migrate` falla con «password authentication failed» | Cambiaste `POSTGRES_PASSWORD` después de crear la base. | Vuelve a la contraseña anterior o empieza de cero. |
| El backend se cae al arrancar con `Falta DATABASE_URL para createDb` | No cargaste el `.env` o arrancaste sin `--env-mode=loose`. | Carga el `.env` en esa terminal y usa `pnpm dev --env-mode=loose`. |
| Al ingresar sale «No se pudo iniciar sesión. Inténtalo de nuevo.» | Abriste `http://127.0.0.1:3000`, o el frontend arrancó en otro puerto (3001) porque el 3000 estaba ocupado: el backend solo acepta peticiones de `APP_ORIGIN` (`http://localhost:3000`). | Usa `http://localhost:3000` y libera el puerto 3000. |
| Ingresas pero vuelves a la pantalla de login | El navegador no guardó la cookie de sesión. | Usa Chrome, Edge o Firefox y entra por `localhost`. |
| No llegan los correos a Mailpit | `CORREO_PROVIDER` sigue en `consola`. | Mira la terminal, o cambia a `smtp` como se explica arriba y reinicia. |
| Los trabajos se quedan en cola | El worker no arrancó (por ejemplo, Redis apagado). | Revisa en la terminal la línea `Worker iniciado` y que `pnpm servicios:up` haya terminado bien. |

### Problemas típicos en Windows

| Síntoma | Causa | Solución |
|---|---|---|
| Docker Desktop pide WSL 2 o no arranca | Docker Desktop en Windows usa WSL 2. | En PowerShell como administrador: `wsl --install`, reinicia la PC y abre Docker Desktop otra vez. |
| «Virtualization must be enabled» | La virtualización está desactivada en la BIOS/UEFI. | Actívala (Intel VT-x o AMD-V) en la configuración de arranque del equipo. |
| El puerto 5432 está ocupado | Instalaste PostgreSQL para Windows y su servicio está activo. | Detén el servicio «postgresql-x64-17» en «Servicios», o usa `POSTGRES_PORT=5433` y cambia el puerto en `DATABASE_URL` y `MIGRATIONS_DATABASE_URL`. |
| No sabes qué programa ocupa un puerto | — | `netstat -ano \| findstr :3000` muestra el número de proceso (PID); búscalo en el Administrador de tareas. |
| `corepack enable` da «acceso denegado» | Corepack escribe en la carpeta de Node. | Abre PowerShell como administrador para ese comando. |
| `set -a` no se reconoce | Ese comando es de bash, no de PowerShell. | Usa la línea de PowerShell de «Arrancar ContApp». |
| Las variables «desaparecen» | Abriste otra ventana de terminal: cada ventana tiene sus propias variables. | Carga el `.env` en la misma ventana donde corres `pnpm dev`. |
| PowerShell no deja ejecutar `pnpm` («la ejecución de scripts está deshabilitada») | Política de ejecución de PowerShell. | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` y abre una terminal nueva. |

## Comprueba lo aprendido

1. Ya tienes todo instalado y ayer apagaste ContApp con `pnpm servicios:down`. ¿Qué comandos ejecutas hoy para volver a usarlo?
2. Arrancas con `pnpm dev` y el backend se cae con `Falta DATABASE_URL para createDb`. ¿Qué pasó y cómo lo arreglas?
3. Quieres ver el correo de invitación en una bandeja de entrada, no en la terminal. ¿Qué cambias?
4. Hiciste muchas pruebas y quieres volver a los datos iniciales. ¿Qué comandos usas y qué se pierde?
5. ¿Con qué usuario del seed compruebas que un Contador solo ve sus clientes asignados, y cuántos clientes debe ver en el Estudio A?

<details>
<summary>Soluciones</summary>

1. `pnpm servicios:up`; luego cargar el `.env` en la terminal y `pnpm dev --env-mode=loose`. No hace falta migrar ni sembrar de nuevo: los datos se conservaron.
2. El backend no recibió las variables del `.env`: no las cargaste en la terminal, o Turbo las filtró. Carga el `.env` (bash: `set -a; . ./.env; set +a`; PowerShell: la línea del paso a paso) y arranca con `pnpm dev --env-mode=loose`.
3. En el `.env`: `CORREO_PROVIDER=smtp`, un `CORREO_REMITENTE` cualquiera y `SMTP_URL=smtp://localhost:1025`. Reinicias `pnpm dev` con el `.env` recargado y abres `http://localhost:8025`.
4. `docker compose down -v`, `pnpm servicios:up`, `pnpm db:migrate` y `pnpm db:seed`. Se pierde todo lo que hiciste: clientes, correcciones, estudios registrados, trabajos y correos de Mailpit.
5. Con `uab@seed.contapp.test` (Contador). En el Estudio A ve un solo cliente: «Cliente compartido (A)», del que es responsable.

</details>

## Para saber más

- Curso técnico: [00 · Índice (instalación y primeros comandos)](../curso/00-indice.md) · [01 · Arquitectura general](../curso/01-arquitectura-general.md)
- Spec: [`docs/specs/019-docker-local/spec.md`](../specs/019-docker-local/spec.md) (entorno local con Docker) · [`docs/specs/009-adaptadores-mock/spec.md`](../specs/009-adaptadores-mock/spec.md) (simuladores y fixtures)
- Datos de prueba: [`fixtures/LEEME.md`](../../fixtures/LEEME.md)
- Requisitos: RNF-081 (entorno local con Docker).
