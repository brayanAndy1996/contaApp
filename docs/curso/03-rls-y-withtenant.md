# Módulo 03 · Multitenancy, RLS y `withTenant()`

> Anterior: [02 · PostgreSQL](02-postgresql.md) · Siguiente: [04 · Redis](04-redis.md) · [Índice](00-indice.md)

## Lo que aprenderás

- Qué es un *tenant* en ContApp y las tres formas clásicas de aislar a los clientes de un SaaS.
- Qué es Row-Level Security (RLS) en PostgreSQL: `ENABLE` vs `FORCE`, políticas, `USING` / `WITH CHECK`, `PERMISSIVE` vs `RESTRICTIVE`.
- Cómo funciona `withTenant()` por dentro, línea por línea, y sus hermanas `withUsuario`, `withAuth` y `withSistema`.
- Qué pasa si alguien se olvida de usarla (spoiler: no ve nada, y eso es bueno).
- Qué agujeros encontró el adversario en la spec 002 y cómo se taparon.
- Cómo comprobarlo tú mismo en `psql`.

---

## 1. Un estudio = un tenant

Imagina un edificio de oficinas en Miraflores donde cinco estudios contables comparten **el mismo sótano de archivo**. Todos los archivadores están en el mismo cuarto, pero cada folder lleva una etiqueta con el nombre del estudio. El portero del sótano tiene una regla simple: *"Solo te alcanzo los folders cuya etiqueta coincide con el carnet que me muestras"*. Si llegas sin carnet, no te alcanza nada.

Eso es ContApp:

- **Tenant** = un estudio contable (tabla `tenant`). Es quien paga el plan.
- **Folder** = una fila de negocio (un `cliente`, un `job_registro`, una `credencial`...).
- **Etiqueta** = la columna `tenant_id` de cada fila.
- **Carnet** = la variable de sesión `app.tenant_id` que fija `withTenant()`.
- **Portero** = PostgreSQL aplicando RLS.

### Las tres formas de aislar

| Modelo | Cómo es | A favor | En contra |
|---|---|---|---|
| **BD por cliente** | Cada estudio tiene su propia base de datos | Aislamiento físico total | Cientos de bases que migrar, respaldar y monitorear; caro |
| **Esquema por cliente** | Una base, un `schema` por estudio (`estudio_a.cliente`, `estudio_b.cliente`) | Buen aislamiento | Cada migración se repite N veces; el catálogo crece; el pool de conexiones se complica |
| **Columna `tenant_id` + RLS** | Una base, unas tablas, cada fila etiquetada | Una sola migración, un solo pool, barato de operar | Si el filtro falla, se mezclan datos → hay que blindarlo |

ContApp eligió la **tercera** (ver `docs/03-arquitectura.md` §4). El modelo de negocio son muchos estudios pequeños y medianos; mantener una base por cada uno no escala para un equipo chico. El riesgo de la tercera opción ("un `WHERE` olvidado filtra datos de otro estudio") se ataca **no confiando en el programador**: el filtro lo pone la base de datos, no el código.

---

## 2. Row-Level Security en PostgreSQL

### 2.1 `ENABLE` vs `FORCE`

```sql
-- packages/db/migrations/0002_rls_y_grants.sql:7-10
ALTER TABLE public.membresia ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membresia FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cliente ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente FORCE ROW LEVEL SECURITY;
```

- `ENABLE` activa RLS para **todos menos el dueño** de la tabla.
- `FORCE` lo activa **también para el dueño** (`contapp_migrator`). Sin `FORCE`, una consulta que corra como dueño (por ejemplo, desde una función mal escrita) se saltaría el portero.
- Ojo: los **superusuarios** (como `postgres`) y los roles con `BYPASSRLS` se saltan RLS incluso con `FORCE`. Por eso la app nunca se conecta como `postgres`, y el único rol con `BYPASSRLS` (`contapp_platform`, `0000_roles.sql:15`) es `NOLOGIN` y está muy acotado.

Con RLS activado y **ninguna política**, la tabla se ve vacía: el portero, sin reglas, no deja pasar nada.

### 2.2 La política `tenant_isolation`

```sql
-- packages/db/migrations/0002_rls_y_grants.sql:12-14
CREATE POLICY tenant_isolation ON public.membresia FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

Pieza por pieza:

- `current_setting('app.tenant_id', true)`: lee una variable de configuración inventada por nosotros (los nombres con punto, como `app.algo`, están permitidos). El `true` significa "si no existe, devuelve NULL en vez de error".
- `nullif(..., '')`: si la variable existe pero está vacía (`''`), la convierte en NULL. Así "vacío" y "no fijado" se tratan igual.
- `tenant_id = NULL` **nunca es verdadero** en SQL (es `NULL`), así que sin tenant no pasa ninguna fila. Esto es **fallar cerrado**.
- `USING (...)`: filtro para **leer** filas existentes (`SELECT`, y las filas candidatas de `UPDATE`/`DELETE`). Las que no cumplen, simplemente no existen para ti.
- `WITH CHECK (...)`: filtro para **escribir** filas nuevas (`INSERT`, y el resultado de un `UPDATE`). Si no cumple, error: `new row violates row-level security policy`.
- `FOR ALL`: aplica a `SELECT`, `INSERT`, `UPDATE` y `DELETE`.

Analogía contable: `USING` es el portero que solo te alcanza tus folders; `WITH CHECK` es el que revisa que el folder que vas a guardar lleve **tu** etiqueta y no la de otro estudio.

Detalle bonito: la columna `tenant_id` de `cliente` tiene como valor por defecto ese mismo `current_setting` (lo ves con `\d cliente`), así que al insertar dentro de `withTenant` ni siquiera hay que pasarla.

### 2.3 `PERMISSIVE` vs `RESTRICTIVE`

Una tabla puede tener varias políticas. PostgreSQL las combina así:

- Las **PERMISSIVE** (el valor por defecto) se unen con **OR**: basta que una deje pasar.
- Las **RESTRICTIVE** se unen con **AND** con el resultado anterior: todas deben dejar pasar.

Ejemplo real en `job_registro` (la tabla de trabajos de la cola):

```sql
-- packages/db/migrations/0018_trabajos_rls.sql:17-21
-- RESTRICTIVE: se combina con AND con tenant_isolation (una permisiva se combinaría con OR y dejaría borrar vivos).
-- Un DELETE del worker sobre en_cola/ejecutando afecta 0 filas, sin error.
CREATE POLICY job_registro_borrar_terminados ON public.job_registro AS RESTRICTIVE FOR DELETE TO contapp_worker
  USING (estado IN ('completado', 'error', 'cancelado'));
```

El worker puede purgar trabajos viejos, pero **solo** los terminados **y** solo los de su estudio. Si esta política fuera `PERMISSIVE`, quedaría `tenant_isolation OR terminado`: ¡el worker podría borrar trabajos terminados de **cualquier** estudio! El comentario de la migración lo deja escrito para que nadie lo "simplifique".

Otro ejemplo de política permisiva adicional: `membresia_por_usuario` (`0002_rls_y_grants.sql:16-18`) deja ver tus propias membresías **solo cuando no hay tenant fijado**, para que la pantalla "elige tu estudio" funcione antes de entrar a uno.

### 2.4 Los roles: quién es quién

De `packages/db/migrations/0000_roles.sql`:

| Rol | Login | Para qué |
|---|---|---|
| `contapp_app` | **Sí**, `NOINHERIT` | Es el usuario con el que la app se conecta. **No tiene permisos sobre tablas.** Solo puede hacer `SET ROLE` a los otros (línea 32). |
| `contapp_backend` | No | Lo que hace el backend NestJS. |
| `contapp_worker` | No | Lo que hace el worker (cola, SUNAT). |
| `contapp_platform` | No, `BYPASSRLS` | Operaciones de plataforma muy acotadas. |
| `contapp_migrator` | No | Dueño de las tablas; corre migraciones. |

Es decir: hay **dos candados**. Si te conectas como `contapp_app` y no cambias de rol, ni siquiera tienes permiso (`permission denied`). Si cambias a `contapp_backend` pero no fijas tenant, tienes permiso pero RLS te muestra 0 filas.

---

## 3. `withTenant()` paso a paso

Archivo: `packages/db/src/with-tenant.ts`. Lo crea `createDb({ rolApp })` en `packages/db/src/client.ts:46`, y cada proceso elige su rol: el backend `contapp_backend`, el worker `contapp_worker`.

### 3.1 El contrato

```ts
// packages/db/src/client.ts:26-28 (simplificado)
export interface ContappDb {
  withTenant<T>(ctx: ContextoTenant, fn: (tx: Tx) => Promise<T>): Promise<T>;
  withUsuario<T>(ctx: { userId: string }, fn: (tx: Tx) => Promise<T>): Promise<T>;
  withAuth<T>(fn: (a: AuthRepo) => Promise<T>): Promise<T>;
  withSistema<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  // ...
}
```

Le das un `tenantId` (y opcionalmente `userId`) y una función. Dentro de esa función, `tx` solo ve el estudio indicado.

### 3.2 Validar antes de tocar la BD

```ts
// packages/db/src/with-tenant.ts:66-75 (simplificado)
export function ajusteTenant(ctx: unknown): Ajuste {
  const { tenantId, userId } = ctx as Partial<ContextoTenant>;
  if (!uuidValido(tenantId)) throw new ContextoInvalidoError();
  return {
    sql: "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    valores: [tenantId.toLowerCase(), userId === undefined ? "" : userId.toLowerCase()],
  };
}
```

- Si el `tenantId` no es un UUID, falla **antes** de pedir conexión.
- Los valores van como **parámetros** (`$1`, `$2`), nunca concatenados: no hay inyección SQL posible.
- El tercer argumento de `set_config` es `true` = **local a la transacción**. Al hacer `COMMIT` o `ROLLBACK`, desaparece. Esto es clave (ver H1 más abajo).

### 3.3 El cuerpo: `ejecutarEnContexto`

```ts
// packages/db/src/with-tenant.ts:182-230 (simplificado)
export async function ejecutarEnContexto(pool, rolApp, preparar, fn) {
  verificarNoAnidado();                         // 1
  const ajuste = preparar();                    // 2 valida UUID
  const client = await conexionSinTransaccion(pool); // 3
  try {
    await client.query(LIMPIAR_SESION);         // 4
    await client.query("BEGIN");                // 5
    await client.query(SET_ROLE[rolApp]);       // 6 SET LOCAL ROLE contapp_backend
    await client.query(ajuste.sql, ajuste.valores); // 7 set_config(..., true)
    const resultado = await enContexto.run(true, () => fn(tx)); // 8
    await client.query("COMMIT");               // 9
    return resultado;
  } catch (e) {
    await client.query("ROLLBACK");             // 10
    throw e;
  } finally {
    await client.query(LIMPIAR_SESION);         // 11
    client.release(conexionRota);               // 12
  }
}
```

1. **No se anida.** Si ya estás dentro de un `withTenant`, lanza `WithTenantAnidadoError`. ¿Por qué? Un `withTenant` interno abriría *otra conexión* con *otro* contexto; mezclarías dos transacciones y quizá dos estudios. La detección usa `AsyncLocalStorage` guardado en un símbolo global (`with-tenant.ts:52-54`), así funciona aunque el módulo se cargue dos veces.
2. **Valida** el contexto.
3. **Pide una conexión limpia** al pool. Si llega con una transacción ajena abierta (hallazgo H12), la destruye y pide otra.
4. **Limpia la sesión** por si alguien la ensució antes (ver `LIMPIAR_SESION`, línea 113): `CLOSE ALL; RESET ROLE; RESET ALL; UNLISTEN *; DEALLOCATE ALL; SELECT pg_advisory_unlock_all()`.
5. **Abre la transacción.**
6. **Cambia de rol** con `SET LOCAL ROLE`. El texto sale de una tabla fija (`SET_ROLE`, línea 35), nunca de la entrada.
7. **Fija el carnet**: `app.tenant_id` y `app.user_id`, locales a la transacción.
8. **Ejecuta tu código** marcando "estoy dentro" para el chequeo de anidamiento.
9. **Confirma.**
10. Si algo falla, **revierte**. Si ni el `ROLLBACK` funciona, la conexión se marca rota.
11. **Limpia otra vez**, por si tu `fn` hizo algo a nivel de sesión.
12. **Devuelve la conexión** al pool; si quedó en estado dudoso, `release(error)` la **destruye** en lugar de reciclarla.

Además, `tx` deja de funcionar al terminar (`crearTx`, línea 153): si guardas `tx` y lo usas después, recibes "La transacción de withTenant ya terminó".

### 3.4 Uso real en el backend

```ts
// apps/backend/src/modules/clientes/clientes.controller.ts:20-23
listar(@Sesion() sesion: SesionResuelta, @Req() req: PeticionAcceso): Promise<ClienteListado[]> {
  const alcance = alcanceDe(req.acceso);
  return this.db.withTenant(contextoDe(sesion), (tx) => listarClientes(tx, alcance));
}
```

`contextoDe(sesion)` (`apps/backend/src/modules/clientes/contexto.ts:14-17`) saca el estudio activo de la **sesión**, nunca del cuerpo de la petición. Si no hay estudio activo, `AccesoError("estudio_requerido")`.

### 3.5 Redis y eventos: **después** del callback

```ts
// apps/backend/src/modules/trabajos/encolador.ts:34-41
async encolar(ctx, e) {
  const r = await this.db.withTenant(ctx, (tx) => encolar(tx, e));
  if (r.nuevo) await this.publicar(ctx.tenantId, r.trabajo, e);
  return r;
}
```

Esto es el patrón **outbox** (D3 de `docs/specs/008-cola/spec.md`): primero se guarda el trabajo en PostgreSQL y se hace commit; **solo entonces** se avisa a Redis. ¿Por qué no dentro del callback?

- Si publicas dentro y luego la transacción hace `ROLLBACK`, Redis anunció un trabajo que no existe.
- Mientras esperas a Redis, la transacción (y su conexión) queda abierta ocupando el pool.
- Una tarea asíncrona lanzada dentro de `fn` hereda el `AsyncLocalStorage` "estoy dentro" y cualquier `withTenant` que haga fallará como anidado (falla cerrado, nota [004/008]).

Lo mismo hace el reconciliador: "Redis y eventos se tocan después de cada callback" (`packages/queue/src/reconciliador.ts:6`).

### 3.6 Las hermanas

| Función | Qué fija | Para qué |
|---|---|---|
| `withTenant` | `app.tenant_id` + `app.user_id` | Todo el trabajo de negocio de un estudio. |
| `withUsuario` | solo `app.user_id` (`with-tenant.ts:82-89`) | Antes de elegir estudio: listar "mis estudios" (política `membresia_por_usuario`). |
| `withAuth` | ambos vacíos (`with-tenant.ts:96-101`) | Login/sesiones: llama a funciones `auth.*` `SECURITY DEFINER`. Solo con rol `contapp_backend` (`client.ts:69-73`). |
| `withSistema` | ambos vacíos | Tareas del worker sin estudio: enumerar estudios con trabajos, purgas, `config_sistema`. Solo con `contapp_worker` (`client.ts:74-78`). Las tablas de negocio salen **vacías**. |

Todas comparten `ejecutarEnContexto`, así que todas limpian, validan y no se anidan.

---

## 4. ¿Y si alguien se olvida de `withTenant`?

Falla **cerrado**, en dos capas:

1. Consulta directa con el pool (rol `contapp_app`): `ERROR: permission denied for table cliente`.
2. Con el rol correcto pero sin tenant: **0 filas** al leer, error al insertar.

Lo prueba `tests/aislamiento/falla-cerrado.spec.ts` (CA-4). El peor caso de un olvido es una pantalla vacía o un error, **nunca** datos de otro estudio.

---

## 5. Lo que enseñó el adversario (spec 002)

El rol *adversario* intenta romper el aislamiento. Sus hallazgos están en `docs/specs/ESTADO.md` ("Hallazgos adversariales abiertos"). Los más didácticos:

- **H1 (alta) – `set_config(..., false)`.** Si el código dentro de `fn` hacía `set_config('app.tenant_id', X, false)` (de **sesión**, no local), el valor sobrevivía al `COMMIT` y la conexión volvía al pool "con carnet puesto". La siguiente petición, con `withUsuario`, veía datos de otro estudio. Arreglo: `LIMPIAR_SESION` con `RESET ALL` antes y después. Lo puedes ver en la práctica (§6).
- **H8 (baja) – `SET ROLE` sin `LOCAL`.** Misma causa: el rol quedaba pegado a la conexión. Arreglo: `RESET ROLE` (porque `RESET ALL` no incluye el rol).
- **H10 (media) – objetos grandes `lo_*`.** `pg_largeobject` es un almacén **fuera de RLS**: se guardaba un dato desde el estudio A con `lo_from_bytea` y se leía desde B con `lo_get`. Arreglo: `0004_ronda2_lo_y_usuario.sql` quita `EXECUTE` sobre todas esas funciones. Lección: **RLS protege tablas, no todo lo que existe en la base.**
- **H11 (baja) – `PREPARE`.** Una sentencia preparada con datos de A sobrevivía en la conexión y se ejecutaba en `withTenant(B)`. Arreglo: `DEALLOCATE ALL` en la limpieza y vaciar la caché de sentencias de `pg` (`olvidarSentencias`).
- **H4/H5 (media, aceptados) – oráculos de PK.** Si intentas insertar un `cliente` con un `id` que ya existe **en otro estudio**, la PK responde `23505 duplicate key`: no ves la fila, pero sabes que existe. Con UUID v7 aleatorios adivinar es impráctico, así que el usuario lo **aceptó** como límite conocido. Lección: RLS oculta filas, pero los índices únicos son globales.
- **H3 (aceptado)** – un `set_config` a mitad del callback cambia de estudio. Se acepta porque el código dentro de `fn` es nuestro y revisado; RLS protege contra olvidos, no contra código malicioso propio.

### La prueba de catálogo

`tests/aislamiento/catalogo.spec.ts` no prueba datos: **recorre `pg_catalog`** y exige que toda tabla con columna `tenant_id` tenga RLS `ENABLE` + `FORCE` y una política `tenant_isolation` `FOR ALL` con `USING` y `WITH CHECK` sobre `app.tenant_id`. Si mañana alguien crea la tabla `compra` y olvida la política, **el build se cae**. Es un guardián automático que no depende de que el revisor se acuerde.

Esto cumple **HU-40** (`docs/02-requerimientos.md:543`): *"Existe una prueba automática que, con dos tenants, intenta leer datos cruzados [...] y falla el build si devuelve algo"*. La parte de lectura cruzada está en `tests/aislamiento/aislamiento.spec.ts` (simétrica: A contra B y B contra A, para ambos roles).

---

## 6. Práctica en `psql`

Necesitas la BD local con migraciones y seed aplicados. Todo es **solo lectura** o se revierte con `ROLLBACK`.

```bash
psql -h localhost -U postgres -d contapp
```

**Paso 1: los IDs del seed** (como `postgres`, superusuario, ves todo porque se salta RLS):

```sql
SELECT id, nombre FROM tenant;
--  01920000-0000-7000-8000-0000000000a1 | Estudio A (seed)
--  01920000-0000-7000-8000-0000000000b1 | Estudio B (seed)
SELECT tenant_id, count(*) FROM cliente GROUP BY 1;   -- 3 y 3
```

**Paso 2: el rol de login no tiene permisos.**

```sql
BEGIN;
SET LOCAL ROLE contapp_app;
SELECT count(*) FROM cliente;
-- ERROR:  permission denied for table cliente
ROLLBACK;
```

**Paso 3: el rol del backend sin tenant ve 0 filas.**

```sql
BEGIN;
SET LOCAL ROLE contapp_backend;
SELECT current_user, current_setting('app.tenant_id', true) AS tenant;
SELECT count(*) FROM cliente;   -- 0
```

**Paso 4: con carnet, solo tu estudio** (sigue en la misma transacción):

```sql
SELECT set_config('app.tenant_id', '01920000-0000-7000-8000-0000000000a1', true);
SELECT ruc, razon_social FROM cliente ORDER BY ruc;
-- 20100047218 | Cliente A dos
-- 20100070970 | Cliente compartido (A)
-- 20131312955 | Cliente A tres
SELECT set_config('app.tenant_id', '01920000-0000-7000-8000-0000000000b1', true);
SELECT ruc, razon_social FROM cliente ORDER BY ruc;
-- 20100070970 | Cliente compartido (B)   <- mismo RUC, otro estudio, otra fila
-- ...
```

**Paso 5: `WITH CHECK` en acción** (con B fijado, intentar insertar en A):

```sql
INSERT INTO cliente (tenant_id, ruc, razon_social)
VALUES ('01920000-0000-7000-8000-0000000000a1', '20999999991', 'Intruso SAC');
-- ERROR:  new row violates row-level security policy for table "cliente"
ROLLBACK;
```

**Paso 6: local vs sesión (la raíz de H1).**

```sql
BEGIN; SELECT set_config('app.tenant_id', '01920000-0000-7000-8000-0000000000a1', true); COMMIT;
SELECT current_setting('app.tenant_id', true);   -- '' : se fue con el COMMIT
BEGIN; SELECT set_config('app.tenant_id', '01920000-0000-7000-8000-0000000000a1', false); COMMIT;
SELECT current_setting('app.tenant_id', true);   -- ...a1 : ¡quedó pegado a la sesión!
RESET ALL;
SELECT current_setting('app.tenant_id', true);   -- '' : esto hace LIMPIAR_SESION
```

**Paso 7: mirar el catálogo como lo hace la prueba.**

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class WHERE relname IN ('cliente', 'job_registro', 'config_sistema');
SELECT policyname, permissive, cmd, roles FROM pg_policies WHERE tablename = 'job_registro';
-- tenant_isolation               | PERMISSIVE  | ALL    | {public}
-- job_registro_borrar_terminados | RESTRICTIVE | DELETE | {contapp_worker}
```

`config_sistema` sale sin RLS: no tiene `tenant_id`, es configuración de plataforma de solo lectura para la app.

> ¿Por qué entramos como `postgres` y no como `contapp_app`? La contraseña de `contapp_app` la fija la herramienta de migración y vive en el `.env`; no la necesitas para practicar. `SET ROLE` desde el superusuario reproduce exactamente lo que hace `withTenant`.

---

## Impacto en ContApp

- **Confianza vendible**: HU-40 es la promesa al dueño del estudio de que nadie más ve sus clientes ni sus claves SOL. Esa promesa la cumple la base de datos, no la disciplina del programador.
- **Costo operativo bajo**: una sola base, una migración, un pool.
- **Errores visibles, no fugas**: un olvido produce listas vacías o `permission denied`, que se detectan en pruebas.
- **Disciplina de transacciones cortas**: como todo pasa dentro de `withTenant`, el código se organiza en "leer/escribir en BD → commit → efectos externos (Redis, SUNAT)". D6 de 008 prohíbe tener la transacción abierta mientras se llama a SUNAT.

## Errores comunes

- Usar `set_config(..., false)` o `SET` sin `LOCAL` "para probar": contamina la conexión del pool (H1/H8). `withTenant` lo limpia, pero no lo hagas.
- Anidar `withTenant` (o lanzar una promesa dentro del callback que llame a otro `withTenant`): `WithTenantAnidadoError`.
- Publicar a Redis o llamar a SUNAT **dentro** del callback.
- Crear una tabla con `tenant_id` sin `ENABLE` + `FORCE` + `tenant_isolation`: la prueba de catálogo te detiene.
- Agregar una política extra como `PERMISSIVE` cuando debía **restringir**: se combina con OR y abre la puerta.
- Probar RLS como `postgres` y creer que "no funciona": el superusuario la ignora.
- Tomar el `tenantId` del cuerpo de la petición en vez de la sesión.

## Ejercicios

1. En `psql`, con `contapp_backend` y el tenant A fijado, ¿cuántas filas devuelve `SELECT count(*) FROM job_registro`? ¿Y sin tenant?
2. Explica con tus palabras por qué `job_registro_borrar_terminados` es `RESTRICTIVE`. ¿Qué pasaría si fuera `PERMISSIVE`?
3. ¿Qué devuelve `current_setting('app.tenant_id', true)` después de un `ROLLBACK` si se fijó con `true`? Compruébalo.
4. Un compañero escribe `await db.withTenant(ctx, async (tx) => { await tx.query(...); await redis.publish(...); })`. ¿Qué le dirías?
5. Vas a crear la tabla `compra` con `tenant_id`. ¿Qué tres sentencias SQL no pueden faltar, y qué prueba te avisa si faltan?

<details>
<summary>Soluciones</summary>

1. Depende del estado de tu BD (en una base recién sembrada, 0 en ambos casos). Lo importante: con tenant ves solo los del estudio A; sin tenant **siempre** 0, aunque haya filas de otros estudios. Compara con `SELECT count(*) FROM job_registro` como `postgres` (ve todas).
2. Las permisivas se combinan con OR. Como `PERMISSIVE` quedaría `tenant_isolation OR estado terminal`, y el worker podría borrar trabajos terminados de cualquier estudio. `RESTRICTIVE` obliga a `tenant_isolation AND estado terminal`.
3. Cadena vacía `''` (o NULL si nunca se fijó en esa sesión). El `nullif(..., '')` de la política trata ambos igual.
4. Que mueva el `publish` fuera: `const r = await db.withTenant(ctx, (tx) => ...); await publicar(...)`. Si la transacción revierte, Redis habría anunciado algo inexistente; además retiene la conexión. Es el patrón outbox (D3 de 008), y si Redis falla el reconciliador repone.
5. `ALTER TABLE compra ENABLE ROW LEVEL SECURITY;`, `ALTER TABLE compra FORCE ROW LEVEL SECURITY;` y `CREATE POLICY tenant_isolation ON compra FOR ALL USING (...) WITH CHECK (...)` (más los `GRANT` por rol). La prueba `tests/aislamiento/catalogo.spec.ts` falla si falta alguna.

</details>

## Para profundizar

- PostgreSQL: Row Security Policies — https://www.postgresql.org/docs/17/ddl-rowsecurity.html
- PostgreSQL: `CREATE POLICY` — https://www.postgresql.org/docs/17/sql-createpolicy.html
- PostgreSQL: funciones de configuración (`set_config`, `current_setting`) — https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET
