# Curso ContApp: entender la tecnología por dentro

Bienvenido. Este curso explica, con el código real de este repositorio, **qué hace cada pieza de ContApp, por qué se eligió y qué pasaría si no estuviera**. Está pensado para ti, dueño del proyecto: sabes programar algo, pero PostgreSQL, RLS, Redis, BullMQ, NestJS o SSE todavía te suenan a cajas negras.

No necesitas leerlo todo de una vez. Cada módulo se sostiene solo y enlaza a los demás cuando hace falta.

## Lo que aprenderás

- Cómo se reparte el trabajo entre el frontend, el backend y el worker, y por qué están separados.
- Cómo PostgreSQL guarda los datos de cada estudio contable sin que se mezclen con los de otro.
- Cómo se ejecutan los trabajos pesados (descargas SIRE, buzones SOL) sin bloquear la pantalla del usuario.
- Cómo se protegen las claves SOL y las sesiones de los usuarios.
- Cómo se manejan los montos y cómo se prueba que todo lo anterior funciona.

## Cómo usar este curso

1. **Lee el módulo en orden de arriba abajo.** Primero la idea con una analogía contable, luego el código real, luego el impacto.
2. **Ejecuta los ejemplos.** Las consultas SQL son de solo lectura: no modifican nada. Si un comando te da un error, revisa la sección "Errores comunes" del módulo.
3. **Haz los ejercicios.** Las soluciones están escondidas en un bloque desplegable; intenta primero sin mirar.
4. **Sigue las rutas de archivo.** Cada fragmento de código indica de dónde sale, por ejemplo `packages/db/src/with-tenant.ts:182`. Ábrelo en tu editor para ver el contexto completo. Cuando un fragmento está recortado, el módulo lo dice.

> Las rutas y números de línea corresponden al estado del repositorio cuando se escribió el curso (spec 008 terminada). Si el código cambia, busca el nombre de la función con `Ctrl+Shift+F` en tu editor.

## Mapa de módulos

| # | Módulo | En una línea |
|---|---|---|
| 00 | [Índice y glosario](00-indice.md) | Este archivo: cómo usar el curso y diccionario de términos. |
| 01 | [Arquitectura general](01-arquitectura-general.md) | El monorepo, las tres apps, los paquetes compartidos y el recorrido de una petición de punta a punta. |
| 02 | [PostgreSQL](02-postgresql.md) | Tablas, claves, índices, transacciones, roles, migraciones y colación ICU con ejemplos de ContApp. |
| 03 | [RLS y withTenant](03-rls-y-withtenant.md) | Cómo la base de datos separa a un estudio de otro y cómo el código fija "quién está consultando". |
| 04 | [Redis](04-redis.md) | La memoria rápida compartida: locks, arriendos, TTL, cupos y mensajes en tiempo real. |
| 05 | [BullMQ y la cola](05-bullmq-y-la-cola.md) | Cómo se encolan, reparten, reintentan y cancelan los trabajos; el patrón outbox. |
| 06 | [Backend NestJS y SSE](06-backend-nestjs-sse.md) | Controladores, servicios, guards y el canal de eventos que actualiza la pantalla sola. |
| 07 | [Seguridad, cifrado y sesiones](07-seguridad-cifrado-y-sesiones.md) | KEK/DEK para las claves SOL, Argon2id para contraseñas, cookies de sesión y CSRF. |
| 08 | [Dinero y dominio](08-dinero-y-dominio.md) | `Money`, `decimal.js`, redondeo, IGV y por qué nunca se usa `number` para soles. |
| 09 | [Pruebas y calidad](09-pruebas-y-calidad.md) | TDD, pruebas adversariales, cobertura, lint y CI. |

## Orden recomendado

```text
00 → 01 → 02 → 03 ─┬─► 04 → 05 → 06
                   └─► 07 → 08 → 09
```

- **Ruta mínima (2–3 horas):** 01, 02 y 03. Con eso entiendes dónde vive cada dato y quién puede verlo.
- **Ruta de trabajos en segundo plano:** 04, 05 y 06, en ese orden (Redis es la base de BullMQ y del SSE).
- **Ruta de seguridad y negocio:** 07, 08 y 09. Se pueden leer en cualquier orden después de 03.

## Cómo correr los ejemplos

### Lo que necesitas instalado

| Herramienta | Versión | Para qué | Notas para Windows |
|---|---|---|---|
| Node.js | 24.x (`>=24.1.0 <25`) | Correr las apps y las pruebas | Instalador oficial de nodejs.org. |
| pnpm | 10.x (`>=10.12.1 <11`) | Gestor de paquetes del monorepo | `corepack enable` y luego `corepack prepare pnpm@10.12.1 --activate`. |
| PostgreSQL | 17 | Base de datos | Instalador oficial (EDB). Incluye `psql` y viene compilado con ICU, que el proyecto necesita. |
| Redis | 7 | Colas, locks y eventos | **No hay versión nativa oficial para Windows.** Usa WSL (Ubuntu + `sudo apt install redis-server`), Memurai (compatible con Redis) o la máquina en la nube del proyecto. |

Las versiones exactas de Node y pnpm están en el `package.json` de la raíz (campo `engines`).

### Primeros comandos

Desde la raíz del repo (en PowerShell o en la terminal de tu editor):

```bash
pnpm install          # instala dependencias de todas las apps y paquetes
pnpm build            # compila packages/* (turbo respeta el orden de dependencias)
pnpm db:migrate       # aplica las migraciones 0000…0021 a la base de datos
pnpm db:seed          # carga datos de ejemplo (estudios, usuarios, clientes)
```

`pnpm db:migrate` y `pnpm db:seed` leen la conexión desde el archivo `.env` de la raíz (tómalo de `.env.example`). **Nunca compartas tu `.env`**: tiene contraseñas. En este curso, donde haga falta una, verás `<contraseña>`.

### Conectarte a la base de datos con psql

```bash
psql -h localhost -U postgres -d contapp
```

Te pedirá `<contraseña>` (la del usuario `postgres` que elegiste al instalar). Ya dentro, prueba:

```sql
\dt                      -- lista las tablas del esquema public
\d job_registro          -- describe una tabla: columnas, índices, CHECK, FK
SELECT current_user;     -- con qué rol estás conectado
\q                       -- salir
```

> En Windows, si `psql` no se reconoce, agrega `C:\Program Files\PostgreSQL\17\bin` a la variable `PATH` o usa "SQL Shell (psql)" del menú Inicio.

### Correr pruebas de un solo paquete

```bash
pnpm --filter @contapp/domain test      # dominio puro: no necesita BD ni Redis
pnpm --filter @contapp/db test          # algunas pruebas necesitan PostgreSQL
pnpm --filter @contapp/queue test       # las *.int.spec.ts necesitan PostgreSQL y Redis
```

La regla del proyecto (CLAUDE.md) es correr solo las pruebas del paquete que tocas mientras trabajas; la batería completa la corre la integración continua.

### Redis en Windows: tres caminos

El backend y el worker necesitan Redis (variable `REDIS_URL` del `.env`). Elige uno:

| Opción | Cómo | Ventaja | Desventaja |
|---|---|---|---|
| **WSL** (recomendada) | En PowerShell: `wsl --install -d Ubuntu`. Dentro de Ubuntu: `sudo apt install redis-server` y `sudo service redis-server start` | Es Redis oficial, igual que en producción | Hay que arrancarlo cada vez que reinicias WSL |
| **Memurai** | Instalador para Windows, corre como servicio | Arranca solo con Windows | Es compatible con Redis, no idéntico |
| **Máquina en la nube** | Trabajar en la máquina remota del proyecto, que ya tiene todo | Nada que instalar | Necesitas conexión |

Para comprobar que responde:

```bash
redis-cli ping        # debe responder PONG (en WSL o en la máquina en la nube)
```

> Sin Redis igual puedes seguir los módulos 01, 02, 03, 08 y la mayor parte del 09: solo necesitan PostgreSQL o nada.

### Arrancar la aplicación completa

Cada app tiene su script `dev`. Con turbo puedes levantarlas todas juntas:

```bash
pnpm dev                                  # frontend :3000, backend :4000 y worker, en paralelo
pnpm --filter @contapp/backend dev        # solo el backend
```

Abre `http://localhost:3000` en el navegador. Todos los adaptadores externos (SUNAT, SOL, XML, correo) están en modo `mock`: nada sale a internet.

### Lista de comprobación

Antes de empezar el módulo 02, verifica:

- [ ] `node -v` muestra `v24.x`.
- [ ] `pnpm -v` muestra `10.x`.
- [ ] `psql -h localhost -U postgres -d contapp -c "select version();"` muestra PostgreSQL 17.
- [ ] `psql -h localhost -U postgres -d contapp -c "select count(*) from drizzle.__drizzle_migrations;"` devuelve 22 (las migraciones 0000 a 0021).
- [ ] (Para 04–06) `redis-cli ping` responde `PONG`.

## Cómo está escrito cada módulo

Todos los módulos siguen la misma estructura, para que sepas dónde buscar:

| Sección | Para qué |
|---|---|
| **Lo que aprenderás** | Los objetivos, en 3 a 5 puntos. |
| **Explicación** | La idea, con analogías del estudio contable cuando ayudan. |
| **Código real** | Fragmentos copiados del repo con su ruta y línea. Si se recortó algo, dice "fragmento" o "simplificado". |
| **Pruébalo** | Comandos y consultas de solo lectura que puedes ejecutar. |
| **Impacto en ContApp** | Qué pasaría sin esta pieza y qué riesgos evita. |
| **Errores comunes** | Las confusiones típicas y cómo salir de ellas. |
| **Ejercicios** | 3 a 5 preguntas, con soluciones escondidas. |
| **Para profundizar** | Documentación oficial. |

### Cómo leer los comentarios del código

El código de ContApp tiene muchos comentarios con siglas. Así se interpretan:

| Sigla | Significa | Dónde buscarla |
|---|---|---|
| `CA-4` | Criterio de aceptación 4 de la spec | `docs/specs/NNN-*/spec.md` |
| `D2` | Decisión 2 del plan | `docs/specs/NNN-*/plan.md` |
| `T14` | Tarea 14 | `docs/specs/NNN-*/tasks.md` |
| `H-008-2a-1` | Hallazgo adversarial de la spec 008, ronda 2a | `tasks.md` de esa spec y `docs/specs/ESTADO.md` |
| `RF-082`, `HU-24` | Requerimiento funcional, historia de usuario | `docs/02-requerimientos.md` |

## Preguntas frecuentes

**¿Puedo romper algo ejecutando los ejemplos?**
No, si sigues las consultas tal como están: todas son `SELECT` o comandos `\d`. Nunca ejecutes `UPDATE`, `DELETE` o `DROP` en una base que te importe.

**¿Por qué con `psql` veo datos de todos los estudios si existe RLS?**
Porque te conectas como `postgres`, que es superusuario y se salta RLS. La app se conecta con otro rol. Lo explican los módulos [02](02-postgresql.md) y [03](03-rls-y-withtenant.md).

**¿Tengo que entender todo el código que aparece?**
No. Basta con entender la idea y saber dónde vive. Los detalles (por ejemplo, la limpieza de sesión de `withTenant`) están ahí para cuando los necesites.

**¿El curso se actualiza solo?**
No. Si una ruta o un número de línea ya no coincide, busca el nombre de la función; la idea seguirá siendo la misma mientras no cambie la spec.

## Glosario

Ordenado alfabéticamente. La columna "Módulo" indica dónde se explica a fondo.

| Término | Qué significa en ContApp | Módulo |
|---|---|---|
| **Adaptador** | Implementación concreta de un puerto (por ejemplo, el mock del SIRE). Se cambia por configuración (`SIRE_CLIENT=mock`) sin tocar la lógica. | 01 |
| **Argon2id** | Algoritmo para guardar contraseñas de forma que sea muy caro adivinarlas aunque roben la base. Se guarda el *hash*, nunca la contraseña. | 07 |
| **Arriendo (lease)** | Permiso temporal con fecha de vencimiento: "este worker es el único que ejecuta este trabajo durante los próximos N segundos". Si el worker muere, el arriendo vence solo. | 04 |
| **BullMQ** | Librería de Node.js que implementa colas de trabajos sobre Redis. En ContApp solo transporta `{ jobId, tenantId, tipo }`; el estado real vive en `job_registro`. | 05 |
| **CHECK** | Regla que PostgreSQL verifica en cada fila (por ejemplo, que el RUC tenga 11 dígitos). Si no se cumple, la fila no entra. | 02 |
| **CI (integración continua)** | Servidor que, en cada cambio, compila, corre lint y pruebas, y avisa si algo se rompió. | 09 |
| **Clave foránea (FK)** | Columna que apunta a la fila de otra tabla y garantiza que exista. En ContApp suelen ser compuestas: `(tenant_id, cliente_id)`. | 02 |
| **Clave primaria (PK)** | Identificador único de cada fila. En ContApp es un `uuid` v7. | 02 |
| **Cobertura** | Porcentaje de líneas o ramas del código que las pruebas ejecutan. Mide qué se probó, no si se probó bien. | 09 |
| **Cola** | Lista ordenada de trabajos pendientes. ContApp tiene colas por tipo de trabajo: `sire`, `sol`, `xml`, etc. | 05 |
| **Colación ICU** | Reglas para comparar y ordenar texto según el idioma. `und-x-icu` da el mismo resultado en cualquier servidor, con tildes y ñ. | 02 |
| **CSRF** | Ataque en el que otra web hace que tu navegador envíe una petición con tu sesión. Se evita validando el origen de la petición. | 07 |
| **DEK** | *Data Encryption Key*: llave que cifra una credencial concreta (clave SOL). Va guardada cifrada con la KEK. | 07 |
| **Drizzle** | ORM y generador de migraciones de TypeScript que usa ContApp para definir tablas y aplicar migraciones. | 02 |
| **Estudio (tenant)** | Cada estudio contable cliente de ContApp. Es la unidad de aislamiento: sus datos nunca se ven desde otro estudio. | 03 |
| **Guard** | Pieza de NestJS que decide, antes de ejecutar un endpoint, si la petición pasa (sesión válida, permiso, cliente visible). | 06 |
| **Idempotente** | Operación que puede repetirse sin cambiar el resultado. Clave para reintentos: descargar dos veces el mismo periodo no debe duplicar nada. | 05 |
| **Índice** | Estructura que permite a PostgreSQL encontrar filas rápido, como el índice alfabético de un archivador. Un índice único además impide duplicados. | 02 |
| **Job (trabajo)** | Una tarea en segundo plano: descargar una propuesta SIRE, revisar un buzón SOL. Se registra en la tabla `job_registro`. | 05 |
| **KEK** | *Key Encryption Key*: llave maestra que cifra las DEK. Solo el worker tiene la parte privada para descifrar. | 07 |
| **Lock (bloqueo)** | Marca que impide que dos procesos hagan lo mismo a la vez (por ejemplo, dos consultas a SUNAT con el mismo RUC). | 04 |
| **Migración** | Archivo SQL numerado que cambia el esquema de la base. Se aplican en orden y nunca se editan después de aplicadas. | 02 |
| **Money** | Clase de `packages/domain` que representa un monto en soles o dólares con precisión exacta (sobre `decimal.js`). | 08 |
| **Monorepo** | Un solo repositorio con varias apps y paquetes que se versionan juntos. | 01 |
| **NestJS** | Framework de Node.js para servidores, organizado en módulos, controladores y servicios. Lo usan el backend y el worker. | 06 |
| **Next.js** | Framework de React para el frontend. Además reenvía `/api/*` al backend. | 01 |
| **NUMERIC(14,2)** | Tipo de PostgreSQL para montos exactos: hasta 14 dígitos, 2 decimales. Nunca `float`. | 02, 08 |
| **Outbox** | Patrón: primero se guarda el trabajo en la BD (commit) y solo después se avisa a Redis. Si Redis falla, nada se pierde: un reconciliador repone. | 05 |
| **pnpm** | Gestor de paquetes de Node.js, rápido y estricto con las dependencias. Maneja los *workspaces* del monorepo. | 01 |
| **Prueba adversarial** | Prueba escrita por alguien que intenta romper el sistema (fugas entre estudios, carreras, entradas maliciosas). Archivos `*.adv.spec.ts`. | 09 |
| **Puerto** | Interfaz que describe qué necesita el sistema de afuera (por ejemplo, `SireAuth.obtenerToken`), sin decir cómo se hace. | 01 |
| **Redis** | Base de datos en memoria, muy rápida, usada para colas, locks, cupos y mensajes en tiempo real. | 04 |
| **RLS (Row Level Security)** | Función de PostgreSQL que filtra filas automáticamente según una política; en ContApp, según el estudio activo. | 03 |
| **Rol de base de datos** | "Usuario" de PostgreSQL con permisos concretos: `contapp_backend`, `contapp_worker`, etc. | 02 |
| **SECURITY DEFINER** | Función SQL que se ejecuta con los permisos de su dueño, no de quien la llama. Sirve para dar acceso controlado a algo puntual. | 02 |
| **SSE (Server-Sent Events)** | Canal HTTP abierto por el que el servidor empuja eventos al navegador (por ejemplo, "tu trabajo terminó"). | 06 |
| **Transacción** | Grupo de operaciones que se aplican todas o ninguna, como un asiento contable que debe cuadrar completo. | 02 |
| **TDD** | *Test-Driven Development*: primero se escribe la prueba que falla y luego el código que la hace pasar. | 09 |
| **TTL** | *Time To Live*: tiempo tras el cual Redis borra una clave sola. Así un lock olvidado no queda para siempre. | 04 |
| **turbo** | Herramienta que ejecuta tareas (`build`, `test`) en todos los paquetes del monorepo respetando el orden de dependencias y con caché. | 01 |
| **withTenant** | Función de `packages/db` que abre una transacción "a nombre de un estudio": fija rol y estudio para que RLS filtre. | 03 |
| **Worker** | Proceso que toma trabajos de la cola y los ejecuta (llama a SUNAT, descifra credenciales). En ContApp es `apps/worker`. | 05 |
| **zod** | Librería para validar datos en tiempo de ejecución con esquemas (por ejemplo, los parámetros de un trabajo). Vive en `packages/shared`. | 06 |

## Ejercicios de calentamiento

1. Usando el glosario, explica con tus palabras la diferencia entre **KEK** y **DEK**.
2. ¿Qué módulo leerías primero si quieres entender por qué un estudio no puede ver los clientes de otro?
3. Ejecuta la lista de comprobación. ¿Cuántas migraciones tiene aplicadas tu base?

<details>
<summary>Soluciones</summary>

1. La DEK cifra una credencial concreta; la KEK es la llave maestra que cifra las DEK. Así, cambiar la KEK no obliga a volver a cifrar cada clave SOL, solo a "re-envolver" sus DEK (módulo 07).
2. El [03 · RLS y withTenant](03-rls-y-withtenant.md), después de repasar roles en el [02](02-postgresql.md).
3. 22 (de `0000_roles` a `0021_trabajos_ronda2`), si corriste `pnpm db:migrate` con el repo al día.

</details>

## Para profundizar

- Documentos del propio proyecto: [01-definiciones-base](../01-definiciones-base.md), [02-requerimientos](../02-requerimientos.md), [03-arquitectura](../03-arquitectura.md) y [04-metodologia](../04-metodologia.md).
- Documentación oficial de PostgreSQL 17 (en inglés): <https://www.postgresql.org/docs/17/>
- Documentación de pnpm workspaces: <https://pnpm.io/workspaces>
