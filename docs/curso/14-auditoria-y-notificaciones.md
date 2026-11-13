# 14 · Auditoría y notificaciones: quién hizo qué, y a quién avisar

> Módulo anterior: [13-lupa-xml.md](13-lupa-xml.md) · Siguiente: [15-pruebas-e2e.md](15-pruebas-e2e.md) · Índice: [00-indice.md](00-indice.md)
>
> Cubre la spec **017** (auditoría inmutable, notificaciones en la app y autor con nombre; migraciones 0041–0045). Conviene haber leído [02](02-postgresql.md), [03](03-rls-y-withtenant.md) y [06](06-backend-nestjs-sse.md).

## Lo que aprenderás

- Qué es la tabla **`auditoria`**, por qué la llenan **triggers** de la BD y no el código de la app, y cómo se vuelve imposible de editar o borrar.
- Cómo se sabe **quién** hizo algo (`usuario`, `trabajo` o `sistema`) sin creerle a la petición.
- Por qué existe el rol interno **`contapp_registrador`** y qué significan `NOLOGIN`, `NOINHERIT`, `BYPASSRLS` y `SECURITY DEFINER`.
- Cómo las **notificaciones** se entregan exactamente una vez, a quién le llegan y cómo se enteran la campana y el SSE.
- Los avisos de **límite del plan** (90 % y 100 %), la **purga** a 90 días y el **autor con nombre** en las pantallas.
- Tres hallazgos adversariales que enseñan algo de PostgreSQL: `ON CONFLICT DO UPDATE`, grants olvidados y `xmin`.

---

## 1. El problema: «¿quién cambió esto?»

En un estudio con varios contadores, tarde o temprano alguien pregunta: «¿quién archivó a este cliente?», «¿quién le quitó la asignación a Rosa?», «¿quién generó la versión 3 del archivo de octubre?». Y cuando la clave SOL de un cliente deja de funcionar a las 2 a. m., alguien tiene que **enterarse** sin revisar cada cliente a mano (HU-10).

La spec 017 resuelve las dos cosas:

- **Auditoría** (RF-150, RF-152): un registro de **solo agregado** de quién hizo qué. Piensa en el **libro diario legalizado**: se escribe en orden, con fecha, y lo escrito no se borra ni se tacha. Si hubo un error, se registra otro asiento.
- **Notificaciones** (RF-160): avisos en la app, con una **campana** en la barra superior, para el usuario al que le tocan y solo si puede ver ese cliente.

## 2. La tabla `auditoria`: el libro que no se tacha

`packages/db/migrations/0041_auditoria.sql:17-33` (fragmento):

```sql
CREATE TABLE "auditoria" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"ocurrida_en" timestamp with time zone DEFAULT date_trunc('milliseconds', clock_timestamp()) NOT NULL,
	"actor_tipo" text NOT NULL,
	"usuario_id" uuid,
	"trabajo_id" uuid,
	"accion" text NOT NULL,
	"cliente_id" uuid,
	"entidad" text NOT NULL,
	"entidad_id" uuid,
	"datos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- … CHECK de actor coherente, acción del catálogo, formato de entidad
	CONSTRAINT "auditoria_datos_objeto" CHECK (jsonb_typeof("auditoria"."datos") = 'object' AND pg_column_size("auditoria"."datos") <= 4096)
);
```

Cada columna responde a una pregunta del auditor: **cuándo** (`ocurrida_en`), **quién** (`actor_tipo`, `usuario_id`, `trabajo_id`), **qué** (`accion`), **sobre qué** (`cliente_id`, `entidad`, `entidad_id`) y **con qué detalle** (`datos`, máximo 4 KB).

### Un catálogo cerrado de acciones

`accion` no es texto libre: un `CHECK` solo acepta los nombres del catálogo, con el formato `dominio.verbo`. Tras la ronda adversarial (migración 0045) son **31** acciones, por ejemplo `sesion.ingreso`, `miembro.rol_cambiado`, `asignacion.quitada`, `cliente.editado`, `credencial.invalidada`, `compra.operacion`, `periodo.estado_cambiado` y `archivo.generado`. Dos de ellas son especiales: `credencial.descifrada` sale de la tabla `auditoria_descifrado` de 003 (que no se tocó, D-6) y `sunat.envio` está **reservada** para R2. La misma lista vive en TypeScript, en `packages/shared/src/auditoria/acciones.ts:7`.

Es como el **plan de cuentas**: no se registra un asiento en una cuenta que no existe.

### Qué entra en `datos` (y qué nunca)

`datos` es una **lista blanca** por acción (D-5): `{rol}`, `{de, a}`, `{libro, periodo, version, sha256Zip}`… Nunca entran claves, cifrados, hashes, tokens, correos, el contenido del XML ni **montos**. Una operación masiva de 5.000 compras deja **una** fila `compra.operacion` con `{tipo, periodo, filas, referenciaId}`; el antes → después de cada compra se reconstruye desde `compra_version`, que ya es inmutable (D-4).

## 3. ¿Por qué triggers y no código en los servicios?

La alternativa obvia sería que cada servicio del backend y del worker llame a `registrarAuditoria(...)` después de hacer su trabajo. La spec la descarta (D-3):

1. **Nadie se puede olvidar.** Con decenas de puntos que cambian datos, basta un servicio nuevo que no llame a la función para que una acción quede sin rastro. El trigger está pegado a la tabla: cualquier `INSERT`, `UPDATE` o `DELETE` lo dispara, venga de donde venga (incluso de SQL escrito a mano).
2. **Misma transacción.** El trigger corre **dentro** de la transacción de la acción (módulo 02). Si la auditoría falla, la acción se revierte: **falla cerrado**, como el descifrado de 003. No hay acción sin registro ni registro de una acción que no ocurrió. Es el asiento con su comprobante: van juntos o no va ninguno.
3. **Sin permisos nuevos para la app.** Como escribe la BD, ni el backend ni el worker necesitan `INSERT` sobre `auditoria`.

Un ejemplo, la captura de asignaciones en `packages/db/migrations/0045_auditoria_ronda_r1.sql:109-117` (fragmento):

```sql
  -- DELETE, o UPDATE que cambia de usuario o de cliente: la asignacion vieja se quita.
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    PERFORM public.auditoria_registrar(OLD.tenant_id, 'asignacion.quitada', OLD.cliente_id, 'asignacion', OLD.id,
      jsonb_build_object('tipo', OLD.tipo, 'usuarioId', OLD.usuario_id));
  END IF;
  -- INSERT, o UPDATE que cambia de usuario o de cliente: la asignacion nueva se agrega.
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.auditoria_registrar(NEW.tenant_id, 'asignacion.agregada', NEW.cliente_id, 'asignacion', NEW.id,
```

`OLD` es la fila como estaba y `NEW` como queda; `TG_OP` dice qué operación la disparó.

## 4. El actor sale del contexto, nunca de la petición

Si el actor viniera en el cuerpo de la petición, cualquiera podría escribir `"usuarioId": "<id del jefe>"`. Por eso `auditoria_registrar` **calcula** el actor con lo que fijó `withTenant()` (módulo 03).

`packages/db/migrations/0041_auditoria.sql:118-133`:

```sql
  IF current_setting('role', true) = 'contapp_worker' AND v_trabajo_ctx IS NOT NULL THEN
    v_trabajo := v_trabajo_ctx::uuid;
    SELECT j.creado_por INTO v_usuario FROM public.job_registro j WHERE j.id = v_trabajo AND j.tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'auditoria: trabajo desconocido';
    END IF;
    v_actor := 'trabajo';
  ELSIF v_usuario_ctx IS NOT NULL THEN
    v_actor := 'usuario';
    v_usuario := v_usuario_ctx::uuid;
  ELSIF p_usuario_fila IS NOT NULL THEN
    v_actor := 'usuario';
    v_usuario := p_usuario_fila;
  ELSE
    v_actor := 'sistema';
  END IF;
```

| Actor | Cuándo | De dónde sale |
|---|---|---|
| `trabajo` | El worker ejecuta un trabajo | `app.trabajo_id`, validado contra `job_registro` del mismo estudio; además guarda `creado_por` (quién lo lanzó) |
| `usuario` | Una persona actúa desde la pantalla | `app.user_id` de la sesión |
| `usuario` (auth) | Ingreso, alta por invitación o registro | `p_usuario_fila`, solo lo pasan los triggers de auth |
| `sistema` | Nada de lo anterior (por ejemplo, una purga) | — |

El worker fija `app.trabajo_id` con la opción nueva `trabajoId` de `withTenant` (`packages/db/src/with-tenant.ts:90-98`, validada como uuid igual que `userId`), y cada procesador la pasa, por ejemplo `apps/worker/src/trabajos/procesadores/generar-archivo.ts:256`:

```ts
    return await db.withTenant({ tenantId: t.tenantId, trabajoId: t.id }, async (tx) => {
```

Un trabajo inexistente o de otro estudio lanza `42501` y la acción se revierte: el actor no se puede inventar.

## 5. Inmutable para todos

Tres candados, como en `archivo_generado` del módulo 10, pero más estrictos:

**Permisos.** `0041_auditoria.sql:61-64`:

```sql
REVOKE ALL ON public.auditoria
  FROM PUBLIC, contapp_backend, contapp_worker, contapp_platform, contapp_app, contapp_auth, contapp_enumerador, contapp_registrador;
GRANT SELECT ON public.auditoria TO contapp_backend;
GRANT INSERT ON public.auditoria TO contapp_registrador;
```

El backend solo **lee**; el worker, nada.

**Triggers que rechazan cambios.** `0041_auditoria.sql:77-82`:

```sql
CREATE TRIGGER auditoria_inmutable BEFORE UPDATE OR DELETE ON public.auditoria
  FOR EACH ROW EXECUTE FUNCTION public.auditoria_inmutable();--> statement-breakpoint
-- Por sentencia: rechaza aunque la RLS deje 0 filas visibles (el dueño no tiene politica de escritura) y cubre TRUNCATE.
DROP TRIGGER IF EXISTS auditoria_inmutable_sentencia ON public.auditoria;--> statement-breakpoint
CREATE TRIGGER auditoria_inmutable_sentencia BEFORE UPDATE OR DELETE OR TRUNCATE ON public.auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION public.auditoria_inmutable();--> statement-breakpoint
```

La función lanza `42501` «auditoria: un registro no se cambia ni se borra» a todos, **incluido el dueño de la tabla y el superusuario**. ¿Por qué dos triggers? El de fila no corre si el `UPDATE` no encuentra filas (la RLS puede ocultarlas todas) y `TRUNCATE` no pasa por filas; el de sentencia cubre ambos casos.

**RLS forzada** con una sola política `FOR SELECT` por `app.tenant_id`: un estudio solo lee su propia auditoría.

## 6. `contapp_registrador`: el notario que nadie puede suplantar

Aquí hay un nudo. `auditoria` tiene RLS **forzada** y **ninguna** política de escritura. Eso significa que nadie que respete la RLS puede insertar, ni siquiera `contapp_migrator`, el dueño de la tabla. ¿Quién escribe entonces?

`0041_auditoria.sql:40-47` (fragmento):

```sql
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contapp_registrador') THEN
    CREATE ROLE contapp_registrador NOLOGIN BYPASSRLS NOINHERIT;
  END IF;
-- …
ALTER ROLE contapp_registrador NOLOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
```

| Atributo | Qué significa | Por qué |
|---|---|---|
| `NOLOGIN` | Nadie se puede conectar como este rol | No hay contraseña que robar |
| sin miembros | Ningún rol puede hacer `SET ROLE contapp_registrador` | Nadie lo «toma prestado» |
| `NOINHERIT` | No hereda permisos de otros roles | Solo tiene lo que se le da explícitamente |
| `BYPASSRLS` | Se salta la RLS | Es lo único que le permite insertar en una tabla sin política de escritura |

Sus únicos permisos de tabla son sobre las tres tablas de 017 (`auditoria`, `notificacion`, `plan_aviso`). Y es **dueño** de las funciones que escriben: `interno.auditoria_insertar`, `interno.notificar`, `plan_aviso_recalcular`, `notificacion_purgar` y `notificaciones_de_esta_transaccion` (desvíos ratificados en `plan.md`).

La clave es **`SECURITY DEFINER`**: una función así corre con los permisos de su **dueño**, no de quien la llama. Es como el **notario**: tú no puedes escribir en su protocolo, pero puedes pedirle que registre un acto, y él lo hace con su firma y según sus reglas. La cadena es:

```text
 acción de la app (backend/worker)
   └─ trigger de captura (SECURITY DEFINER, dueño contapp_migrator)
        └─ auditoria_registrar  → calcula el actor (sección 4)
             └─ interno.auditoria_insertar (SECURITY DEFINER, dueño contapp_registrador) → INSERT
```

¿Por qué no darle `BYPASSRLS` a `contapp_migrator` y listo? Porque `contapp_migrator` es dueño de casi todas las tablas: con `BYPASSRLS`, cualquier función suya podría leer datos de cualquier estudio. Con un rol aparte, el privilegio peligroso queda encerrado en cinco funciones pequeñas y en tres tablas.

## 7. Notificaciones: exactamente una vez

La tabla `notificacion` (`0043_notificacion.sql:15-30`) tiene `usuario_id` (destinatario), `tipo` (`credencial_invalida`, `trabajo_terminado`, `plan_limite` y `buzon_critico`, este reservado para R2), `cliente_id`, `trabajo_id`, `params` (solo códigos y números, máximo 1 KB), `clave_dedupe`, `creada_en` y `leida_en`.

Todas se insertan con una única función, `0043_notificacion.sql:110-121`:

```sql
  WITH nuevas AS (
    INSERT INTO public.notificacion AS n (tenant_id, usuario_id, tipo, cliente_id, trabajo_id, params, clave_dedupe)
    SELECT p_tenant, x.u, p_tipo, p_cliente, p_trabajo, p_params, p_clave
      FROM (SELECT DISTINCT u FROM unnest(p_usuarios) AS u WHERE u IS NOT NULL) x
    ON CONFLICT (tenant_id, usuario_id, clave_dedupe) DO NOTHING
    RETURNING n.id
  )
  SELECT array_agg(nuevas.id) INTO v_ids FROM nuevas;
  IF v_ids IS NOT NULL THEN
    v_previos := coalesce(current_setting('app.notificaciones_tx', true), '');
    PERFORM set_config('app.notificaciones_tx',
      v_previos || CASE WHEN v_previos = '' THEN '' ELSE ',' END || array_to_string(v_ids, ','), true);
```

Dos ideas hacen la entrega **exactamente una vez** (D-9):

1. **Misma transacción que el hecho.** La notificación la inserta un trigger en la transacción que marca la credencial como inválida o termina el trabajo. Si el hecho se confirma, la notificación existe; si se revierte, no. Antes, con `NotificadorLog` de 008, el aviso era «como máximo una vez»: si el worker moría tras el commit, se perdía.
2. **Clave de deduplicación.** `UNIQUE (tenant_id, usuario_id, clave_dedupe)` con `ON CONFLICT DO NOTHING`. Un trabajo que se reintenta usa la misma clave `trabajo_terminado:{id}`, así que no duplica. Es el **número de comprobante**: el mismo número no se registra dos veces.

### El aviso en vivo: un timbre sin contenido

Después del commit, el backend o el worker publica en Redis **solo a quién avisar** (lo que devolvió `destinatariosNuevos(tx)` dentro de la transacción). El SSE de `/trabajos/stream` (módulo 06) se lo reenvía únicamente a esas personas.

`apps/backend/src/modules/trabajos/stream.service.ts:321-328`:

```ts
    // Spec 017: aviso de notificación nueva, solo a las conexiones de los destinatarios (nunca por visibilidad de cliente).
    const aviso = avisoNotificacionSchema.safeParse(crudo);
    if (aviso.success) {
      const destinatarios = new Set(aviso.data.destinatarios.map((d) => d.toLowerCase()));
      for (const c of conexiones) {
        if (!c.cerrada && destinatarios.has(c.usuarioId.toLowerCase())) c.res.write(MARCO_NOTIFICACION);
      }
      return;
```

El marco es `event: notificacion\ndata: {}` (`stream.service.ts:90`): un **timbre**, no una carta. La campana, al oírlo, pide el conteo y la lista por HTTP, donde se aplican la RLS y el alcance. Si el timbre se pierde (Redis caído), no pasa nada grave: la notificación ya está en la BD y la campana se pone al día al recargar o reconectar.

### La API y la pantalla

`apps/backend/src/modules/notificaciones/notificaciones.controller.ts` expone, todas con `@SoloEstudio`: `GET /notificaciones` (cursor, máx. 50), `GET /notificaciones/no-leidas` (tope 100, que se muestra «99+»), `POST /notificaciones/leidas` `{hasta}` y `POST /notificaciones/:id/leida` (204, idempotente). La RLS de `notificacion` exige `tenant_id = app.tenant_id` **y** `usuario_id = app.user_id` (`0043_notificacion.sql:54-56`): nadie ve las notificaciones de un compañero. Además, una notificación con cliente solo se lista si el usuario aún ve ese cliente (D-10): un Asistente desasignado deja de verla al instante. El backend solo puede cambiar `leida_en`, y un trigger solo acepta pasarlo de NULL a un instante (`0043_notificacion.sql:77-95`).

En el frontend: la `Campana` en la barra superior (`apps/frontend/app/(app)/layout.tsx:150`), su panel con las 10 últimas y la página `notificaciones` con «cargar más». El texto en español se arma en `components/notificaciones/texto-notificacion.tsx` desde `tipo` y `params`, siempre como texto de React (sin HTML inyectable).

## 8. ¿A quién le llega cada aviso?

| Tipo | Cuándo | Destinatarios |
|---|---|---|
| `credencial_invalida` | La credencial pasa a `invalida` | El **responsable** activo del cliente; si no hay, los **Dueños y Administradores** activos (P-4) |
| `trabajo_terminado` | Un trabajo pasa de `ejecutando` a `completado` o `error` | Quien lo lanzó, solo si fue una persona desde la pantalla (prioridad `interactivo`, `creado_por` activo) (P-3) |
| `plan_limite` | El uso de RUCs o usuarios cruza el 90 % o el 100 % | Los **Dueños** activos (P-5) |

La regla de P-4, en `0043_notificacion.sql:142-149`:

```sql
  SELECT array_agg(a.usuario_id) INTO v_usuarios
    FROM public.asignacion a
    JOIN public.membresia m ON m.tenant_id = a.tenant_id AND m.usuario_id = a.usuario_id AND m.desactivada_en IS NULL
   WHERE a.tenant_id = NEW.tenant_id AND a.cliente_id = NEW.cliente_id AND a.tipo = 'responsable';
  IF v_usuarios IS NULL THEN
    SELECT array_agg(m.usuario_id) INTO v_usuarios FROM public.membresia m
     WHERE m.tenant_id = NEW.tenant_id AND m.desactivada_en IS NULL AND m.rol IN ('dueno', 'admin');
  END IF;
```

La de P-3 está en la condición `WHEN` del trigger `notificacion_trabajo_terminado` (`0043_notificacion.sql:192-195`): `OLD.estado = 'ejecutando'`, `NEW.estado IN ('completado', 'error')`, `prioridad = 'interactivo'` y `creado_por` no nulo. Los trabajos programados, los de sistema, los reintentos (`en_cola`) y los cancelados no avisan: nadie está esperando frente a la pantalla.

## 9. Avisos del plan: 90 % y 100 %, una vez por día

`plan_aviso` guarda, por estudio, recurso (`rucs` o `usuarios`) y umbral (90 o 100), si el umbral está `alcanzado` y en qué `ciclo` va. Triggers por sentencia en `cliente`, `membresia`, `invitacion` y `suscripcion` llaman a `plan_aviso_recalcular`: si un umbral pasa de no alcanzado a alcanzado, suma `ciclo` y avisa a los Dueños; si el uso baja, lo «rearma» para la próxima vez. Al desplegar, la migración siembra el estado actual **sin notificar**, para no inundar a nadie.

Archivar y reactivar un cliente justo en el borde del 90 % podría avisar una y otra vez. Por decisión del usuario, se avisa **una vez por día por Dueño, recurso y umbral**, en `0045_auditoria_ronda_r1.sql:214-219`:

```sql
      -- Una vez por dia: fuera el Dueño con un aviso del mismo recurso y umbral de hace menos de 24 h (sobre `notificacion`).
      SELECT array_agg(d) INTO v_destino FROM unnest(u.duenos) AS d
       WHERE NOT EXISTS (SELECT 1 FROM public.notificacion n
                          WHERE n.tenant_id = p_tenant AND n.usuario_id = d AND n.tipo = 'plan_limite'
                            AND n.params ->> 'recurso' = r.recurso AND n.params ->> 'umbral' = r.umbral::text
                            AND n.creada_en > now() - interval '24 hours');
```

## 10. Purga, consulta y autor con nombre

**Purga a 90 días (P-7).** Las notificaciones, leídas o no, se borran a los 90 días dentro del trabajo de sistema `auth.purgar`. `apps/worker/src/trabajos/procesadores/auth-purgar.ts:76-80`:

```ts
  for (const tenantId of estudios) {
    const r = await o.db.withTenant({ tenantId }, async (tx) => ({
      trabajos: await purgarTerminados(tx, corte),
      notificaciones: await purgarNotificaciones(tx, notificacionesDias),
    }));
```

`NOTIFICACIONES_DIAS = 90` está en la línea 26. La **auditoría no se purga**: se conserva 5 años (RNF-021) y la purga queda como tarea futura.

**La consulta de auditoría.** `GET /auditoria?cursor=` en `apps/backend/src/modules/auditoria/auditoria.controller.ts:13-18` exige `@Permiso("auditoria.ver")`, que tienen el Dueño y el Administrador; el resto recibe 403. La pantalla `configuracion/auditoria` es una tabla paginada por fecha, **sin filtros** en R1 (P-2), y el enlace de la barra solo aparece con el permiso (`layout.tsx:147-148`). Incluye los descifrados de 003 como `credencial.descifrada`.

**Autor con nombre (D-12).** Donde antes salía un id corto («revisado por», Historial, «XML subido por», versiones de archivo), ahora el backend devuelve `autor { id, nombre, activo }` (`packages/shared/src/autor.ts:6-10`; `nombre: null` = id que no es miembro del estudio). El frontend lo convierte en texto en `apps/frontend/lib/autor.ts:14-17`: «Nombre», «Nombre (inactivo)» o «Usuario desconocido». Nunca se filtra el nombre de alguien de otro estudio, ni su correo o rol.

## 11. Lo que encontró el adversario

**H-017-1 (media): `ON CONFLICT DO UPDATE` dispara UPDATE, no INSERT.** Promover a alguien a responsable usa este SQL, `packages/db/src/acceso/asignaciones.ts:58-60`:

```ts
const SQL_INSERTAR_POR_USUARIO = `insert into asignacion (cliente_id, usuario_id, tipo)
  select c, $2::uuid, $3 from unnest($1::uuid[]) c
  on conflict (tenant_id, cliente_id, usuario_id) do update set tipo = excluded.tipo, updated_at = now()`;
```

Parece un `INSERT`, pero si la asignación ya existe, PostgreSQL ejecuta un **UPDATE** de la fila existente, y lo que se dispara son los triggers `AFTER UPDATE`, no los `AFTER INSERT`. La captura de 0042 solo escuchaba `INSERT OR DELETE` en `asignacion`, así que cambiar de colaborador a responsable no dejaba rastro. La lección: **un trigger escucha lo que la base hace, no lo que el SQL aparenta**. La 0045 agregó `asignacion.tipo_cambiado` con `{de, a, usuarioId}` y un trigger `AFTER UPDATE` (fragmento de la sección 3).

**H-017-2 (baja): grants sin rastro.** Los permisos permitían `DELETE` de `membresia` y `cliente` y `UPDATE` de `asignacion` e `invitacion` sin auditoría ni recálculo de `plan_aviso`. El usuario decidió **auditarlos con triggers**, sin tocar grants: nacieron `miembro.eliminado`, `cliente.eliminado` e `invitacion.modificada` (solo los **nombres** de los campos cambiados, nunca el correo ni la fecha), y los `DELETE` recalculan el plan.

**H-017-3 (baja): `xmin` de la transacción en curso.** `notificaciones_de_esta_transaccion()` leía los ids de `app.notificaciones_tx`, una variable que cualquier sesión puede fijar con `set_config`. Como la función corre con `BYPASSRLS`, alguien podía poner ahí el id de una notificación ajena y averiguar su destinatario. La corrección usa **`xmin`**: cada fila de PostgreSQL guarda, en esa columna oculta, el número de la transacción que la creó, como el **número de asiento** sellado en un comprobante. `0045_auditoria_ronda_r1.sql:291-301` (fragmento):

```sql
  WITH tx AS (SELECT pg_current_xact_id_if_assigned()::text::bigint AS xid)
  SELECT DISTINCT n.usuario_id FROM public.notificacion n CROSS JOIN tx
   WHERE tx.xid IS NOT NULL
     -- … mismo estudio y id en app.notificaciones_tx
     AND CASE WHEN age(n.xmin) <= 0 THEN
           pg_xact_status((tx.xid + /* … reconstruye el xid de 64 bits … */)::text::xid8) = 'in progress'
         ELSE false END
```

Una fila que tú ves y cuya transacción sigue «en curso» solo puede ser **tuya**: las filas de otras transacciones en curso no son visibles. Así la variable de sesión ya no basta para espiar.

> **0044 y 0046.** La 0044 agregó un `CHECK` para que `ocurrida_en` y `creada_en` tengan solo milisegundos (el cursor de paginación viaja como `Date` y con microsegundos repetía o saltaba filas). Quedó `NOT VALID` porque la auditoría no se reescribe. La spec 020 (migración 0046) validó el de `notificacion`; el de `auditoria` sigue `NOT VALID` a propósito.

## Práctica

**A. Correr las pruebas de los contratos** (catálogo de acciones, esquemas de notificación y autor; no necesitan BD):

```bash
pnpm --filter @contapp/shared test auditoria notificaciones autor
#  Test Files  4 passed (4)
#       Tests  143 passed (143)
```

**B. Contar el catálogo de acciones directamente desde la migración** (desde la raíz del repo):

```bash
node -e '
const fs = require("fs");
const sql = fs.readFileSync("packages/db/migrations/0045_auditoria_ronda_r1.sql", "utf8");
const check = sql.match(/auditoria_accion_valida" CHECK \(.*?IN \((.*?)\)\)/)[1];
const acciones = check.match(/\x27([a-z_.]+)\x27/g).map(s => s.slice(1, -1));
console.log("acciones en el CHECK:", acciones.length);
console.log("nuevas en 0045:", acciones.filter(a => !fs.readFileSync("packages/db/migrations/0041_auditoria.sql","utf8").includes("\x27"+a+"\x27")).join(", "));
'
# acciones en el CHECK: 31
# nuevas en 0045: invitacion.modificada, miembro.eliminado, asignacion.tipo_cambiado, cliente.eliminado
```

**C. Mirar la auditoría y los avisos del plan** (con la app levantada y `psql` como `postgres`; consultas de solo lectura, **no ejecutadas** al escribir este módulo porque no había BD disponible):

```sql
-- Las últimas acciones auditadas
SELECT ocurrida_en, actor_tipo, accion, entidad, datos
FROM auditoria ORDER BY ocurrida_en DESC LIMIT 10;

-- Atributos del rol interno
SELECT rolname, rolcanlogin, rolinherit, rolbypassrls FROM pg_roles WHERE rolname = 'contapp_registrador';
```

## Impacto en ContApp

- Ante un reclamo («¿quién archivó a este cliente?») hay una respuesta con fecha y autor, que nadie de la app puede editar ni borrar.
- Ningún servicio nuevo puede «olvidarse» de auditar: si toca una tabla del catálogo, el trigger registra.
- Cuando la clave SOL de un cliente falla, su responsable se entera en la campana, aunque el worker se caiga justo después del commit.
- Los Dueños se enteran antes de llegar al tope del plan, sin una lluvia de avisos.
- Las pantallas muestran nombres de personas en lugar de ids.

## Errores comunes

- **«Voy a registrar la auditoría desde el servicio.»** No hace falta y no se puede: ningún rol de la app tiene `INSERT`. Basta con que la acción toque su tabla; el trigger hace el resto.
- **«Paso `usuarioId` en el cuerpo para que la auditoría lo use.»** Se ignora (y en las rutas estrictas da 400). El actor sale de la sesión o del trabajo.
- **«En el worker abro `withTenant({ tenantId })` sin `trabajoId`.»** Entonces el actor queda como `sistema` o el de la sesión, no como el trabajo. Dentro de un trabajo, pasa `trabajoId`.
- **«Uso `ON CONFLICT DO UPDATE` y mi trigger `AFTER INSERT` no se dispara.»** Es H-017-1: en el conflicto corre el UPDATE.
- **«Limpio la BD de pruebas con `DELETE FROM auditoria`.»** El trigger lo rechaza; las limpiezas usan `session_replication_role = replica` (riesgo anotado en `plan.md`).
- **«Mando el texto de la notificación por SSE.»** No: el SSE es un timbre vacío; el contenido se pide por HTTP, con RLS y alcance.

## Ejercicios

1. ¿Por qué la auditoría se escribe en la **misma** transacción que la acción y no en un trabajo de la cola después?
2. Un Contador ejecuta `UPDATE auditoria SET accion = 'cliente.creado' WHERE …` desde la sesión del backend. ¿Qué lo detiene? ¿Y si lo intenta el dueño de la tabla?
3. ¿Por qué `contapp_registrador` es `NOLOGIN` y no tiene miembros, si igual tiene `BYPASSRLS`?
4. Un trabajo de descarga falla, se reintenta y termina con éxito. ¿Cuántas notificaciones `trabajo_terminado` recibe quien lo lanzó?
5. El cliente X no tiene responsable y su clave SOL deja de funcionar. ¿Quién recibe el aviso? Si después nombran responsable a una Contadora y la clave vuelve a fallar tras reemplazarla, ¿a quién le llega?

<details><summary>Soluciones</summary>

1. Para fallar cerrado: si la auditoría no se puede escribir, la acción se revierte, y no existe una acción sin registro ni un registro de algo que no pasó (D-3). Un trabajo posterior podría perderse si el proceso muere entre el commit y el encolado.
2. Primero los permisos: el backend solo tiene `SELECT` y recibe `permission denied`. Al dueño (o al superusuario) lo detiene el trigger `auditoria_inmutable`, que lanza `42501` (CA-3).
3. Porque `BYPASSRLS` es un privilegio peligroso. Si nadie puede conectarse como ese rol ni hacer `SET ROLE` a él, la única forma de usarlo es a través de las funciones `SECURITY DEFINER` de las que es dueño, que hacen operaciones acotadas sobre tres tablas.
4. Una. El reintento vuelve a `en_cola` (no avisa) y la clave `trabajo_terminado:{id}` es la misma, así que `ON CONFLICT DO NOTHING` evita duplicados (CA-9).
5. Primero, a los Dueños y Administradores activos (P-4). Después, solo a la Contadora responsable: la nueva invalidación tiene otra clave (`credencial_invalida:{id}:{estado_at}`), así que sí se crea otra notificación (CA-8).

</details>

## Para profundizar

- Specs del proyecto: [017 spec](../specs/017-auditoria-notif/spec.md), [plan](../specs/017-auditoria-notif/plan.md) (incluye los «Desvíos ratificados») y `tasks.md`; hallazgos H-017-1 a H-017-3 en [ESTADO.md](../specs/ESTADO.md).
- Migraciones `packages/db/migrations/0041` a `0045` (y `0046` de la spec 020).
- PostgreSQL: [triggers](https://www.postgresql.org/docs/current/sql-createtrigger.html), [`SECURITY DEFINER`](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY), [`INSERT … ON CONFLICT`](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT) y [columnas de sistema (`xmin`)](https://www.postgresql.org/docs/current/ddl-system-columns.html).
