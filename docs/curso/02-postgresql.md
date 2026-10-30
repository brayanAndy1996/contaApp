# 02 · PostgreSQL en ContApp

> Anterior: [01 · Arquitectura general](01-arquitectura-general.md) · Siguiente: [03 · RLS y withTenant](03-rls-y-withtenant.md)

## Lo que aprenderás

- Qué es una base de datos relacional y cómo se lee una tabla real de ContApp (`job_registro`).
- Cómo las claves, los `CHECK` y los índices impiden datos inválidos o duplicados, incluido el índice único parcial que evita trabajos repetidos.
- Qué es una transacción y cómo `UPDATE … WHERE estado = 'en_cola'` resuelve la "carrera" entre cancelar y despachar.
- Qué roles de base de datos existen, qué puede hacer cada uno y para qué sirven las funciones `SECURITY DEFINER`.
- Cómo funcionan las migraciones con Drizzle y qué es la colación ICU `und-x-icu`.

## 1. Qué es una base de datos relacional

Imagina el archivador del estudio: un cajón por tipo de documento (clientes, credenciales, trabajos), y en cada cajón, fichas con los mismos campos. En PostgreSQL:

| Archivador | PostgreSQL |
|---|---|
| Cajón | **Tabla** (`cliente`, `job_registro`) |
| Ficha | **Fila** |
| Campo de la ficha | **Columna** (con un tipo: `uuid`, `text`, `timestamptz`…) |
| Número de ficha único | **Clave primaria** |
| "Ver ficha del cliente N.º…" | **Clave foránea** |
| Regla del jefe: "el RUC siempre tiene 11 dígitos" | **CHECK** |
| Índice alfabético en la tapa del cajón | **Índice** |

"Relacional" significa que las tablas se relacionan por sus claves: un trabajo apunta a su cliente, el cliente a su estudio.

**Pruébalo** (solo lectura):

```bash
psql -h localhost -U postgres -d contapp
```

```sql
\dt                 -- lista de tablas
\d cliente          -- columnas, restricciones e índices de cliente
\d job_registro     -- la tabla de trabajos
```

> Conectado como `postgres` eres superusuario: **te saltas RLS y ves los datos de todos los estudios**. Está bien para aprender en local; la app nunca se conecta así (ver sección 6).

## 2. Claves primarias y foráneas

Todas las tablas usan como clave primaria un `uuid` generado por la función `uuid_v7()` (definida en `packages/db/migrations/0000_roles.sql`, porque PostgreSQL 17 no la trae). Un UUID v7 empieza con la fecha y hora, así que los nuevos quedan ordenados al final del índice: más rápido que un UUID aleatorio.

```sql
-- packages/db/migrations/0001_esquema_base.sql (fragmento)
CREATE TABLE "cliente" (
  "id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
  "tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
  "ruc" char(11) NOT NULL,
  "razon_social" text NOT NULL,
  CONSTRAINT "cliente_tenant_ruc_unique" UNIQUE("tenant_id","ruc"),
  CONSTRAINT "cliente_tenant_id_unique" UNIQUE("tenant_id","id"),
  CONSTRAINT "cliente_ruc_11_digitos" CHECK ("cliente"."ruc" ~ '^[0-9]{11}$')
);
```

Tres detalles importantes:

1. `tenant_id` tiene un **DEFAULT** que sale del contexto (`app.tenant_id`, que fija `withTenant`). El código nunca lo envía: el estudio lo pone la base de datos.
2. `UNIQUE("tenant_id","ruc")`: un mismo RUC puede ser cliente de dos estudios distintos, pero no dos veces del mismo estudio.
3. `UNIQUE("tenant_id","id")` parece redundante (el `id` ya es único), pero existe para permitir **claves foráneas compuestas**.

### Claves foráneas compuestas con `tenant_id`

```sql
-- packages/db/migrations/0017_trabajos.sql:59
ALTER TABLE "job_registro" ADD CONSTRAINT "job_registro_cliente_fk"
  FOREIGN KEY ("tenant_id","cliente_id") REFERENCES "public"."cliente"("tenant_id","id");
```

Una FK simple (`cliente_id → cliente.id`) solo garantiza que el cliente exista **en algún estudio**. La compuesta garantiza que exista **en el mismo estudio que el trabajo**. Es imposible, aunque haya un error en el código, registrar un trabajo del estudio A sobre un cliente del estudio B. Es como exigir que cada asiento apunte a una cuenta **del mismo plan contable de la empresa**, no de otra.

## 3. CHECK: reglas que la base hace cumplir

La tabla `job_registro` (`packages/db/migrations/0017_trabajos.sql`) tiene doce `CHECK`. Algunos:

```sql
-- packages/db/migrations/0017_trabajos.sql (fragmento)
CONSTRAINT "job_registro_estado_valido" CHECK ("job_registro"."estado" IN
  ('en_cola', 'ejecutando', 'completado', 'error', 'cancelado')),
CONSTRAINT "job_registro_ruc_11_digitos" CHECK ("job_registro"."ruc" ~ '^[0-9]{11}$'),
CONSTRAINT "job_registro_parametros_tamano" CHECK (octet_length("job_registro"."parametros"::text) <= 4096),
CONSTRAINT "job_registro_clave_dedupe_32" CHECK (octet_length("job_registro"."clave_dedupe") = 32),
```

Aunque el código TypeScript ya valida con zod, la base vuelve a validar. Si mañana alguien escribe un script o hay un error, la base dice "no". Es la última línea de defensa.

```sql
-- Ver todos los CHECK de la tabla (solo lectura)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'job_registro'::regclass AND contype = 'c';
```

## 4. Índices y el índice único parcial de dedupe

Un **índice** permite encontrar filas sin leer toda la tabla. ContApp define, por ejemplo, el índice que usa el despachador para encontrar el siguiente trabajo:

```sql
-- packages/db/migrations/0017_trabajos.sql (fragmento)
CREATE INDEX "job_registro_despacho_idx" ON "job_registro"
  USING btree ("tenant_id","cola","estado","prioridad","creado_en");
```

El orden de columnas importa: es como un archivador ordenado por estudio, luego por cola, luego por estado. Encontrar "los `en_cola` de la cola `sire` del estudio X" es directo.

### El índice único **parcial**

```sql
-- packages/db/migrations/0017_trabajos.sql:61
CREATE UNIQUE INDEX "job_registro_dedupe_vivo" ON "job_registro"
  USING btree ("tenant_id","clave_dedupe")
  WHERE "job_registro"."estado" IN ('en_cola', 'ejecutando');
```

Léelo así: **"dentro de un estudio, no puede haber dos trabajos *vivos* con la misma clave de dedupe"**. La `clave_dedupe` es un hash de 32 bytes del tipo de trabajo, el cliente y sus parámetros. El `WHERE` hace que la regla aplique solo a los vivos: cuando un trabajo termina (`completado`, `error`, `cancelado`) sale del índice y se puede volver a pedir lo mismo.

Analogía: no puedes tener dos solicitudes abiertas para "descargar compras de 202609 del RUC 20…", pero una vez cerrada, puedes abrir otra.

El código aprovecha el índice con `ON CONFLICT … DO NOTHING`: si el contador hace doble clic, el segundo `INSERT` no falla con error, simplemente no inserta:

```ts
// packages/db/src/trabajos/registro.ts:173
const SQL_INSERTAR_SIN_DUPLICAR = `insert into job_registro
  (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
  values ($1, $2, $3, $4, $5, $6, 'en_cola', $7::jsonb, $8, $9, $10)
  on conflict (tenant_id, clave_dedupe) where estado in ('en_cola', 'ejecutando') do nothing
  returning ${COLUMNAS_VISTA}`;
```

¿Por qué no basta con "consultar si existe y luego insertar"? Porque dos peticiones simultáneas pueden consultar a la vez, ver que no existe, e insertar las dos. El índice único es atómico: PostgreSQL lo garantiza aunque lleguen mil peticiones juntas.

```sql
-- Ver los índices de la tabla
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'job_registro';
```

## 5. Transacciones y la carrera "cancelar vs. despachar"

Una **transacción** agrupa varias operaciones que se confirman todas (`COMMIT`) o ninguna (`ROLLBACK`). Como un asiento contable: o se registran el debe y el haber, o no se registra nada.

```sql
BEGIN;
  -- varias operaciones
COMMIT;    -- o ROLLBACK si algo falló
```

En ContApp, cada `withTenant(...)` es **una** transacción (ver `packages/db/src/with-tenant.ts:182`). El nivel de aislamiento es el predeterminado de PostgreSQL, **READ COMMITTED**: cada sentencia ve lo que otros ya confirmaron. Compruébalo:

```sql
SHOW default_transaction_isolation;   -- read committed
```

### La carrera

Un trabajo está `en_cola`. En el mismo instante:

- el **contador** pulsa "Cancelar" (backend), y
- el **despachador** del worker decide ejecutarlo.

Si ambos hicieran "leo el estado, veo `en_cola`, escribo mi nuevo estado", los dos ganarían y tendríamos un trabajo cancelado que igual se ejecuta. La solución es una sola función que pone la condición **dentro del UPDATE**:

```ts
// packages/db/src/trabajos/registro.ts:379-389 (simplificado)
let donde = "id = $1 and estado = $2";               // $2 = estado esperado ("desde")
const texto = `update job_registro set ${sets.join(", ")} where ${donde}`;
const r = await consultar(tx, texto, valores);
return r.rowCount === 1;                             // true = gané; false = otro llegó antes
```

Lo usan los dos lados con `desde = "en_cola"`:

```ts
// apps/backend/src/modules/trabajos/trabajos.service.ts:156
const gano =
  fila.estado === "en_cola" &&
  (await transicionar(tx, trabajoId, "en_cola", "cancelado", { motivo: "cancelado_usuario" }));
if (!gano) throw new TrabajosError("trabajo_iniciado");

// packages/queue/src/despachador.ts:268
if (!(await transicionar(tx, fila.id, "en_cola", "ejecutando"))) { /* perdí: suelto el cupo */ }
```

Qué hace PostgreSQL:

1. El primer `UPDATE` que llega **bloquea la fila** y cambia el estado.
2. El segundo `UPDATE` **espera** a que la primera transacción termine.
3. Cuando la primera confirma, PostgreSQL **vuelve a evaluar** el `WHERE estado = 'en_cola'` sobre la versión nueva de la fila. Ya no se cumple, así que actualiza **0 filas**.
4. El perdedor ve `rowCount = 0` y actúa en consecuencia (el backend responde 409; el despachador suelta su cupo).

Siempre hay **un único ganador**, sin locks manuales. Este patrón se llama *compare-and-set* (comparar y asignar).

## 6. Roles y GRANTs: quién puede hacer qué

PostgreSQL tiene **roles** (usuarios o grupos) y **privilegios** (`GRANT SELECT`, `INSERT`, `UPDATE`… incluso por columna). La app se conecta con un único rol de login, `contapp_app`, que no tiene permisos propios: solo puede **cambiarse** (`SET ROLE`) a otros roles.

```sql
-- packages/db/migrations/0000_roles.sql (fragmento)
CREATE ROLE contapp_app LOGIN NOINHERIT;
-- El rol de login solo puede hacer SET ROLE hacia los roles de la app; no hereda sus privilegios (PG >= 16).
GRANT contapp_backend, contapp_worker, contapp_platform TO contapp_app
  WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
```

Ojo con la historia: `0000` también daba acceso a `contapp_platform`, pero la ronda adversarial lo retiró en `0003_rls_plataforma_y_roles.sql` (`REVOKE contapp_platform FROM contapp_app;`). Hoy `contapp_app` solo puede pasar a backend o worker; el panel de plataforma tendrá su propio login cuando una spec lo necesite. Es un buen ejemplo de "asiento de ajuste" (sección 9).

Es como un empleado que entra al edificio con una credencial de visitante (`contapp_app`) y en recepción recibe el fotocheck del área donde trabajará hoy (`SET LOCAL ROLE contapp_backend`). Sin fotocheck, no abre ninguna puerta.

| Rol | ¿Login? | ¿Salta RLS? | Para qué | Puede (resumen verificado en migraciones) |
|---|---|---|---|---|
| `contapp_app` | Sí | No | Conexión de la app | Nada por sí mismo; solo `SET ROLE` a `contapp_backend` o `contapp_worker` |
| `contapp_backend` | No | No | Proceso backend | `job_registro`: leer, insertar y actualizar solo `estado, motivo, terminado_en, actualizado_en` (cancelar). `credencial`: leer **solo columnas de estado**, nunca `ciphertext` |
| `contapp_worker` | No | No | Proceso worker | `job_registro`: leer, borrar terminados, actualizar 8 columnas del ejecutor; **sin INSERT**. `credencial`: puede leer `ciphertext`, `nonce`, `dek_envuelta` |
| `contapp_platform` | No | **Sí** | Panel super-admin (futuro) | Solo `tenant` y `usuario` (`SELECT, INSERT, UPDATE`); nada de tablas contables. Hoy nadie puede asumirlo |
| `contapp_auth` | No | No | Dueño de las funciones `auth.*` | Lo que necesitan login, sesiones e invitaciones; nadie puede asumirlo (`NOINHERIT`, sin miembros) |
| `contapp_enumerador` | No | **Sí** | Dueño de `sistema.estudios_ids()` y `sistema.estudios_con_trabajos()` | Solo `tenant.id` y tres columnas de `job_registro`; las funciones devuelven únicamente UUID |
| `contapp_migrator` | No | No | Dueño de las tablas | Usado por las migraciones |

Los permisos de backend y worker sobre `job_registro` salen de `packages/db/migrations/0018_trabajos_rls.sql`:

```sql
-- packages/db/migrations/0018_trabajos_rls.sql (fragmento)
-- contapp_backend: lee, encola (tenant_id, intentos y fechas por DEFAULT) y solo cancela (D9).
GRANT SELECT ON public.job_registro TO contapp_backend;
GRANT UPDATE (estado, motivo, terminado_en, actualizado_en) ON public.job_registro TO contapp_backend;
-- contapp_worker: lee, ejecuta (8 columnas del ejecutor) y purga terminados (política de arriba). Sin INSERT.
GRANT SELECT, DELETE ON public.job_registro TO contapp_worker;
```

**Pruébalo:**

```sql
-- Roles del proyecto y sus atributos
SELECT rolname, rolcanlogin, rolbypassrls, rolinherit
FROM pg_roles WHERE rolname LIKE 'contapp%' ORDER BY 1;

-- Qué columnas de credencial puede leer cada rol (fíjate en ciphertext)
SELECT grantee, string_agg(column_name, ', ' ORDER BY column_name)
FROM information_schema.column_privileges
WHERE table_name = 'credencial' AND privilege_type = 'SELECT'
  AND grantee IN ('contapp_backend', 'contapp_worker')
GROUP BY grantee;

-- Una pregunta directa
SELECT has_column_privilege('contapp_backend', 'credencial', 'ciphertext', 'SELECT');  -- false
```

Este es el refuerzo en base de datos de la regla "el backend nunca descifra" (ver [01](01-arquitectura-general.md)): aunque el código del backend lo intentara, PostgreSQL respondería `permission denied`.

## 7. Funciones SECURITY DEFINER y `search_path`

Normalmente una función se ejecuta con los permisos de **quien la llama** (`SECURITY INVOKER`). Una función `SECURITY DEFINER` se ejecuta con los permisos de **su dueño**. Es como una ventanilla: no te dejan entrar al archivo, pero el encargado (dueño) hace la consulta por ti y te entrega solo lo que la ventanilla permite.

El worker necesita saber **qué estudios existen** para recorrerlos, pero con RLS no puede ver todos. Solución:

```sql
-- packages/db/migrations/0018_trabajos_rls.sql:113
CREATE OR REPLACE FUNCTION sistema.estudios_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id FROM public.tenant t ORDER BY t.id
$$;
-- más abajo: dueño contapp_enumerador (BYPASSRLS) y EXECUTE solo para contapp_worker
```

El dueño (`contapp_enumerador`) salta RLS, pero la función solo devuelve UUID: el worker no ve nombres ni datos.

### ¿Por qué `SET search_path = pg_catalog, pg_temp`?

El `search_path` es la lista de esquemas donde PostgreSQL busca un nombre sin prefijo (como el `PATH` de Windows para programas). Si una función con privilegios usara el `search_path` de quien la llama, un atacante podría crear su propia función `lower()` o tabla `tenant` en un esquema suyo y engañar a la función privilegiada. Fijarlo y escribir los nombres completos (`public.tenant`) cierra ese hueco. Por eso **todas** las funciones `SECURITY DEFINER` del repo lo tienen:

```sql
-- Funciones SECURITY DEFINER de auth y sistema, con su dueño y search_path
SELECT n.nspname, p.proname, pg_get_userbyid(p.proowner) AS dueno, p.proconfig
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef AND n.nspname IN ('auth', 'sistema')
ORDER BY 1, 2;
```

## 8. NUMERIC(14,2) vs. float

Los números `float` (`real`, `double precision`) se guardan en binario y **no representan exactamente** valores como 0.10:

```sql
SELECT 0.1::float8 + 0.2::float8 = 0.3        AS float_igual,     -- false
       0.1::numeric + 0.2::numeric = 0.3      AS numeric_igual,   -- true
       (0.1::float8 + 0.2::float8)::text      AS float_texto;     -- 0.30000000000000004
```

Sumando miles de comprobantes, esos restos producen descuadres de céntimos frente a SUNAT. `NUMERIC(14,2)` guarda decimales exactos: hasta 14 dígitos en total, 2 después del punto (máximo 999 999 999 999.99). La convención está en `docs/03-arquitectura.md` §8 y en `CLAUDE.md`. Las tablas con montos (comprobantes, propuestas SIRE) llegan con las specs de compras y ventas; hoy el dinero vive en `packages/domain` con `Money` y `decimal.js` (ver [08](08-dinero-y-dominio.md)).

## 9. Migraciones con Drizzle

Una **migración** es un archivo SQL que lleva la base de un estado al siguiente. ContApp tiene 22, de `0000_roles.sql` a `0021_trabajos_ronda2.sql`, en `packages/db/migrations/`.

- Las tablas se describen en TypeScript (`packages/db/src/schema/*.ts`) y `drizzle-kit generate` produce el SQL.
- Lo que Drizzle no sabe generar (roles, RLS, funciones, GRANTs) se escribe a mano en migraciones *custom* (por eso muchas empiezan con `-- 00NN_... (custom, spec ...)`).
- `migrations/meta/_journal.json` es el **índice** de migraciones: orden, nombre y fecha de cada una.
- `pnpm db:migrate` ejecuta `packages/db/src/cli/migrar.ts`, que llama al `migrate()` de Drizzle y registra lo aplicado en la tabla `drizzle.__drizzle_migrations`.

```sql
-- Qué migraciones están aplicadas (debería haber 22)
SELECT id, left(hash, 12) AS hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id;
```

### Por qué nunca se edita una migración aplicada

Una migración aplicada es como un **asiento contable ya cerrado**: no se borra ni se modifica; si hay un error, se hace un **asiento de ajuste**. Si editas `0017_trabajos.sql`:

- Las bases que ya la aplicaron **no la vuelven a correr** (Drizzle la considera hecha). Tu cambio no llega a producción.
- Una base nueva (CI, otro desarrollador) **sí** corre la versión editada.
- Resultado: dos bases con esquemas distintos y errores imposibles de reproducir.

Por eso el repo corrige con migraciones nuevas. Mira el encabezado de `0021_trabajos_ronda2.sql`: arregla un trigger de 0018 "Mismo cuerpo, firma, atributos, dueño y grants que 0018 (**no se edita 0018**…)". Y las migraciones custom se escriben **repetibles** (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP … IF EXISTS`): por eso `pnpm ci:db` corre `pnpm db:migrate` dos veces seguidas, para comprobar que repetirlas no rompe nada.

## 10. Colación ICU (`und-x-icu`)

Una **colación** define cómo se comparan y ordenan textos y cómo se clasifican sus caracteres: ¿va "Ávila" junto a "avila" o al final?, ¿"Ñ" es una letra?, ¿cuál es la minúscula de "Ú"?

PostgreSQL puede usar dos proveedores:

- **libc**: las reglas del sistema operativo. Cambian entre Linux, Windows y versiones; en Windows dependen del idioma con que se instaló.
- **ICU**: una librería internacional con las mismas reglas en cualquier servidor. `und-x-icu` significa "idioma no determinado" (*undetermined*): reglas raíz de Unicode, válidas para cualquier idioma.

Compruébalo en tu base (la base local se creó con `C.UTF-8`, proveedor libc):

```sql
SELECT datname, datcollate, datlocprovider FROM pg_database WHERE datname = 'contapp';

-- 1) Minúsculas: con la colación "C" la Ñ y la Ú no cambian
SELECT lower('ÑANDÚ ÁVILA' COLLATE "C")         AS con_c,     -- ÑandÚ Ávila
       lower('ÑANDÚ ÁVILA' COLLATE "und-x-icu") AS con_icu;   -- ñandú ávila

-- 2) ¿Son letras? [[:alnum:]] = letra o dígito
SELECT 'Ñandú' COLLATE "C"         ~ '^[[:alnum:]]+$' AS con_c,     -- false
       'Ñandú' COLLATE "und-x-icu" ~ '^[[:alnum:]]+$' AS con_icu;   -- true

-- 3) Orden alfabético
SELECT array_agg(x ORDER BY x COLLATE "C")         AS con_c,
       array_agg(x ORDER BY x COLLATE "und-x-icu") AS con_icu
FROM unnest(ARRAY['zapata','Ávila','avila','Núñez','nunez','Ortiz']) AS x;
-- con_c:   {Núñez,Ortiz,avila,nunez,zapata,Ávila}   ← mayúsculas primero, Ávila al final
-- con_icu: {avila,Ávila,nunez,Núñez,Ortiz,zapata}   ← como en una agenda
```

### Dónde se usa en ContApp

En `packages/db/migrations/0016_acceso_ronda2.sql`, al aceptar una invitación, el nombre de la persona debe contener al menos una letra o dígito:

```sql
-- packages/db/migrations/0016_acceso_ronda2.sql:38 (fragmento)
OR NOT (p_nombre COLLATE pg_catalog."und-x-icu" ~ '[[:alnum:]]') THEN
  RETURN 'invalida';
```

El comentario de la migración explica por qué: con un locale `C`, `[[:alnum:]]` solo reconoce letras ASCII y rechazaría nombres válidos escritos con letras no ASCII, como "李明" (y, en general, el resultado dependería del locale con que se creó cada base). Con ICU, la regla es la misma en el servidor de desarrollo, en CI y en producción.

**Ojo:** `und-x-icu` es una colación *determinista*: `'avila' = 'Ávila'` sigue siendo `false`. Para comparar **sin distinguir mayúsculas**, el proyecto normaliza: los correos se guardan ya en minúsculas, sin espacios y en Unicode NFC (`CHECK` en `0007_auth.sql`), y además hay un índice único sobre `lower(email)`. Con ICU, `lower()` funciona bien también para tildes y eñes.

### Impacto en despliegue

La misma migración verifica al inicio que la colación exista y, si no, **falla de inmediato** en lugar de fallar con el primer usuario:

```sql
-- packages/db/migrations/0016_acceso_ronda2.sql:17 (fragmento)
IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_collation
                WHERE collname = 'und-x-icu' AND collnamespace = 'pg_catalog'::regnamespace) THEN
  RAISE EXCEPTION '0016_acceso_ronda2 requiere la colación ICU pg_catalog."und-x-icu"';
END IF;
```

Consecuencias prácticas:

- El servidor PostgreSQL debe estar **compilado con ICU**. El instalador oficial de Windows, los paquetes de Linux (PGDG) y la imagen Docker oficial lo están. Algunas imágenes mínimas o servicios gestionados raros podrían no estarlo: verifícalo antes de elegir proveedor.
- Si se actualiza la librería ICU del servidor, PostgreSQL puede avisar que la versión de la colación cambió y pedir reindexar los índices que dependan de ella.

```sql
SELECT collname, collprovider, collversion FROM pg_collation WHERE collname = 'und-x-icu';
-- collprovider = 'i' significa ICU
```

## Impacto en ContApp

| Sin esto… | Pasaría… |
|---|---|
| FK compuestas con `tenant_id` | Un error de código podría ligar un trabajo de un estudio a un cliente de otro |
| Índice único parcial de dedupe | Un doble clic encolaría dos descargas iguales y consumiría cupo de SUNAT |
| `UPDATE … WHERE estado = 'en_cola'` | Un trabajo cancelado podría ejecutarse igual |
| Roles y GRANTs por columna | Un fallo en el backend permitiría leer el texto cifrado de las claves SOL |
| `SECURITY DEFINER` con `search_path` fijo | Un atacante podría secuestrar funciones privilegiadas |
| `NUMERIC` | Descuadres de céntimos acumulados |
| Migraciones inmutables | Bases con esquemas distintos entre local, CI y producción |
| Colación ICU | Nombres con tildes o eñes rechazados o mal ordenados según el servidor |

## Errores comunes

| Error | Explicación |
|---|---|
| "Con `psql` veo los datos de todos los estudios, ¡RLS no funciona!" | Estás como `postgres` (superusuario, salta RLS). La app usa `contapp_app` + `SET ROLE` (ver [03](03-rls-y-withtenant.md)). |
| Editar una migración ya aplicada | No se reaplica en bases existentes. Crea una migración nueva. |
| Leer y luego escribir para "verificar" un estado | Hay carrera. Pon la condición en el `WHERE` del `UPDATE` y revisa `rowCount`. |
| Usar `float`/`double precision` o `number` para montos | Usa `NUMERIC(14,2)` en la base y `Money` en el código. |
| Crear una función `SECURITY DEFINER` sin `SET search_path` | Agujero de seguridad; copia el patrón de las migraciones existentes. |
| Error `requiere la colación ICU` al migrar | Tu PostgreSQL no tiene ICU; instala la distribución oficial. |

## Ejercicios

1. Con `\d job_registro`, encuentra las tres claves foráneas. ¿Cuáles son compuestas?
2. Escribe una consulta que muestre cuántos trabajos hay por `estado` en toda la base. ¿Por qué como `postgres` ves todos los estudios?
3. Un trabajo con `clave_dedupe = X` está `completado`. ¿Se puede insertar otro `en_cola` con la misma clave en el mismo estudio? ¿Y si estuviera `ejecutando`?
4. ¿Qué devuelve `has_column_privilege('contapp_worker', 'credencial', 'ciphertext', 'SELECT')`? ¿Y para `contapp_backend`? Relaciónalo con la regla de CLAUDE.md.
5. Ordena `ARRAY['Ñuñoa','Nazca','ñandú','Oxapampa']` con `COLLATE "C"` y con `COLLATE "und-x-icu"`. ¿Cuál se parece a un directorio telefónico?

<details>
<summary>Soluciones</summary>

1. `job_registro_tenant_id_tenant_id_fk` (simple, a `tenant`), `job_registro_cliente_fk` (compuesta `tenant_id, cliente_id` → `cliente`) y `job_registro_creado_por_fk` (compuesta `tenant_id, creado_por` → `membresia(tenant_id, usuario_id)`).
2. `SELECT estado, count(*) FROM job_registro GROUP BY estado;`. `postgres` es superusuario y los superusuarios ignoran RLS. En local puede devolver 0 filas si nunca encolaste nada.
3. Sí: el índice parcial solo cubre `en_cola` y `ejecutando`, así que una fila `completado` no cuenta. Si estuviera `ejecutando`, el `INSERT` chocaría con `job_registro_dedupe_vivo` (con `ON CONFLICT … DO NOTHING` no inserta y no da error).
4. `true` para el worker y `false` para el backend. Es la regla "el backend nunca descifra credenciales" aplicada por la propia base.
5. `SELECT array_agg(x ORDER BY x COLLATE "C"), array_agg(x ORDER BY x COLLATE "und-x-icu") FROM unnest(ARRAY['Ñuñoa','Nazca','ñandú','Oxapampa']) x;`
   - `C`: `{Nazca,Oxapampa,Ñuñoa,ñandú}`: compara bytes, así que las palabras con Ñ/ñ van al final.
   - `und-x-icu`: `{ñandú,Nazca,Ñuñoa,Oxapampa}`: las reglas raíz tratan la ñ como "n con tilde", por eso "ñandú" (n-a-n…) va antes que "Nazca" (n-a-z…).
   - Sorpresa: ninguno es el orden de un directorio peruano, donde la Ñ es una letra aparte después de la N. Para eso existe la colación española: `COLLATE "es-x-icu"` da `{Nazca,ñandú,Ñuñoa,Oxapampa}`. ContApp usa `und-x-icu` porque solo necesita **clasificar** caracteres (¿es letra?) igual en todos los servidores, no ordenar alfabéticamente en español.

</details>

## Para profundizar

- PostgreSQL 17, restricciones (PK, FK, CHECK, UNIQUE): <https://www.postgresql.org/docs/17/ddl-constraints.html>
- PostgreSQL 17, aislamiento de transacciones: <https://www.postgresql.org/docs/17/transaction-iso.html>
- PostgreSQL 17, soporte de colaciones e ICU: <https://www.postgresql.org/docs/17/collation.html>
