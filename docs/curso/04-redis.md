# Módulo 04 · Redis

> Anterior: [03 · RLS y withTenant](03-rls-y-withtenant.md) · Siguiente: [05 · BullMQ y la cola](05-bullmq-y-la-cola.md) · [Índice](00-indice.md)

## Lo que aprenderás

- Qué es Redis y por qué en ContApp **no** es la fuente de verdad.
- Los tipos de datos que usamos: string, set, sorted set (ZSET), hash y list.
- TTL y expiración; el lock con arriendo `SET NX PX`.
- Cómo los cupos de la cola son un ZSET cuyo puntaje es la hora de vencimiento.
- Pub/sub para el SSE (`eventos:{tenantId}`) y `TIME` como reloj único.
- Cómo se nombran las claves, cómo se guarda cifrado el token SIRE y qué pasa si Redis se cae.

---

## 1. ¿Qué es Redis?

Redis es una base de datos **en memoria**, de tipo **clave → valor**, rapidísima (operaciones de microsegundos). Piensa en la **pizarra de la oficina** del estudio: ahí anotas "Juan está declarando el RUC 20100047218, no lo toques" o "faltan 3 trámites del cliente X". Es rápida de leer y escribir, todos la ven, pero **no es el libro contable**. Si alguien la borra por accidente, la puedes reconstruir mirando los libros.

En ContApp, los "libros" son PostgreSQL. La decisión está escrita:

> **D1 Fuente de verdad**: el estado vive en `job_registro` (PostgreSQL, RLS). Redis guarda pendientes por tenant (`pend:{cola}:{tenantId}`), el conjunto de tenants con pendientes, locks y arriendos; si Redis se pierde, se reconstruye desde `job_registro`.
> — `docs/specs/008-cola/spec.md:57`

Por eso Redis guarda solo cosas **temporales o reconstruibles**: quién está ejecutando qué, cuántos cupos hay ocupados, avisos en vivo y un token SIRE en caché.

---

## 2. Los tipos de datos

| Tipo | Qué es | Analogía | Uso en ContApp |
|---|---|---|---|
| **String** | Un valor bajo una clave | Una nota adhesiva | Locks (`lock:ruc:...`), liderazgo, `ejec:{jobId}`, token SIRE cifrado |
| **Set** | Conjunto sin repetidos | Lista de asistencia (nadie firma dos veces) | `tenants:{cola}`: estudios con trabajos pendientes |
| **Sorted set (ZSET)** | Conjunto donde cada miembro tiene un **puntaje** numérico y se ordena por él | Fólderes ordenados por fecha de vencimiento | `pend:{cola}:{tenantId}` (pendientes) y `cupo:...` (arriendos) |
| **Hash** | Un mini-diccionario bajo una clave | Una ficha de cliente con campos | (no lo usa la cola hoy; útil conocerlo) |
| **List** | Lista ordenada, push/pop por los extremos | Bandeja de entrada | BullMQ las usa por dentro (módulo 05) |

### TTL y expiración

Cualquier clave puede tener un **tiempo de vida** (TTL). Cuando vence, Redis la borra sola. `EXPIRE clave 60` (segundos), `PX 30000` (milisegundos) al hacer `SET`, y `TTL`/`PTTL` para consultar cuánto le queda (`-1` = no vence, `-2` = no existe).

Esto es oro para sistemas que pueden morir: si un worker se cae a mitad de un trabajo, **nadie tiene que acordarse de borrar su lock**; vence solo.

---

## 3. El lock con arriendo: `SET NX PX`

`SET clave valor NX PX 30000` significa: "guarda esto **solo si no existe** (`NX`) y bórralo en **30 000 ms** (`PX`)". Responde `OK` si lo lograste o `nil` si ya lo tenía otro. Es atómico: dos procesos a la vez, solo uno gana.

Es un **arriendo** (lease): no eres dueño para siempre, lo alquilas por 30 s y tienes que renovarlo con un latido. Si mueres, el alquiler vence.

```ts
// packages/queue/src/arriendos.ts:153-167
export async function tomarLockRuc(redis, k, t): Promise<boolean> {
  if (!conLock(t)) return true;
  const r = await redis.set(
    k.lockRuc(t.canal, t.ruc),
    t.id,
    "PX",
    ARRIENDO_MS,
    "NX",
  );
  return r === "OK";
}
```

¿Para qué? SUNAT no tolera bien dos sesiones simultáneas del mismo RUC por el mismo canal. El lock `lock:ruc:{canal}:{ruc}` asegura que solo un trabajo a la vez hable con SUNAT por ese RUC y canal (D20). Las constantes: `ARRIENDO_MS = 30_000` y `LATIDO_MS = 10_000` (`packages/queue/src/tipos.ts:89-90`): el ejecutor renueva cada 10 s un arriendo de 30 s.

El mismo patrón se usa para:
- **El líder de la cola** (`despachador.ts:112`): un solo despachador por cola (D4).
- **El arriendo del ejecutor** `ejec:{jobId}` (`arriendos.ts:198`): un solo proceso ejecuta un trabajo.

Y al soltar, **se comprueba que el lock sea tuyo** antes de borrarlo (`soltarLockRuc`, `arriendos.ts:173-185`): si tu arriendo ya venció y otro lo tomó, no le borras el suyo.

---

## 4. Cupos con ZSET: puntaje = vencimiento

¿Cuántos trabajos SIRE puede tener un estudio en paralelo? Por defecto 2 (y 4 en total, D12). Un contador (`INCR`/`DECR`) es peligroso: si el proceso muere entre ambos, el contador queda desfasado para siempre. ContApp usa un **ZSET** donde:

- **miembro** = `jobId`
- **puntaje** = hora (ms) en la que vence ese arriendo

```ts
// packages/queue/src/arriendos.ts:125-130 (dentro de reservarCupos)
const ahora = await horaRedisMs(redis);
const vence = ahora + ARRIENDO_MS;
const enTenant = k.cupoTenant(t.cola, t.tenantId);
const enGlobal = k.cupoGlobal(t.cola);
await redis.zadd(enTenant, vence, t.id);
await redis.zadd(enGlobal, vence, t.id);
```

Para saber cuántos cupos están **vivos**, se podan los vencidos:

```ts
// packages/queue/src/arriendos.ts:53-63 (podar)
for (const id of await redis.zrangebyscore(clave, "-inf", corteMs)) {
  if ((await redis.exists(k.ejec(id))) === 0) await redis.zrem(clave, id);
}
return redis.zcard(clave);
```

Es decir: "dame los que vencieron antes de ahora; si su ejecutor ya no tiene `ejec:`, sácalos; cuenta lo que queda". Si se pasa del límite, se deshace la reserva (`reservarCupos`, `arriendos.ts:114-140`). Analogía: el archivador de expedientes "en trámite" con fecha de caducidad; cada mañana sacas los caducados y cuentas cuántos quedan.

---

## 5. `TIME`: un solo reloj para todos

Si el worker A tiene su reloj adelantado 40 s y el B atrasado, ¿quién decide si un arriendo venció? En la ronda adversarial 2 de la spec 008 aparecieron justo esos fallos (`docs/specs/ESTADO.md`):

- **H-008-2b-1**: un reconciliador con reloj +40 s daba por vencido un trabajo recién despachado; uno no idempotente quedaba en `error` sin ejecutarse.
- **H-008-2b-2**: un ejecutor adelantado que moría dejaba su cupo fechado en el futuro y bloqueaba el cupo de más.
- **H-008-2b-4/2b-5**: relojes atrasados que no podaban o no recuperaban a tiempo.

La corrección: **la hora la da Redis**, siempre.

```ts
// packages/queue/src/arriendos.ts:31-36
export async function horaRedisMs(redis): Promise<number> {
  const [s, us] = await redis.time();
  return Number(s) * 1000 + Math.floor(Number(us) / 1000);
}
```

`TIME` devuelve `[segundos, microsegundos]` del servidor Redis. Como los TTL de `ejec:` y de los locks también los mide Redis, todo queda en el mismo reloj. Es como poner **un solo reloj de pared** en la oficina en vez de que cada quien use el de su celular.

---

## 6. Pub/sub: avisos en vivo para el SSE

Pub/sub es una radio: quien hace `PUBLISH canal mensaje` emite, y quienes hicieron `SUBSCRIBE canal` lo escuchan **en ese momento**. Si nadie escucha, el mensaje se pierde (no se guarda).

ContApp usa el canal `eventos:{tenantId}`. Cuando un trabajo cambia de estado, se publica su vista pública:

```ts
// packages/queue/src/eventos.ts:1-4
// Eventos de cambio de estado (pub/sub `eventos:{tenantId}`), que el backend reenvía por SSE con el
// alcance de cada usuario. El mensaje es exactamente la vista pública (eventoTrabajoSchema): nunca
// lleva RUC, parámetros, resultado ni tenantId. Se publica después del commit y sus errores no se
// propagan (el panel se resincroniza con GET /trabajos).
```

El backend tiene un suscriptor por proceso que escucha `eventos:{tenantId}` de los estudios con pantallas abiertas y reenvía a cada navegador por SSE solo los trabajos que ese usuario puede ver (`apps/backend/src/modules/trabajos/stream.service.ts:83-87`). Como pub/sub no guarda nada, si se pierde un aviso el panel se resincroniza con `GET /trabajos`: otra vez, la verdad está en PostgreSQL. Más detalle en el [módulo 06](06-backend-nestjs-sse.md).

---

## 7. Nombres de claves y prefijos

Todas las claves salen de una sola función pura:

```ts
// packages/queue/src/claves.ts:50-63 (extracto)
export function crearClaves(prefijo: string = PREFIJO_POR_DEFECTO): ClavesCola {
  return {
    pend: (cola, tenantId) => `${prefijo}pend:${cola}:${tenantId}`,
    tenants: (cola) => `${prefijo}tenants:${cola}`,
    cupoTenant: (cola, tenantId) => `${prefijo}cupo:${cola}:${tenantId}`,
    lockRuc: (canal, ruc) => `${prefijo}lock:ruc:${canal}:${ruc}`,
    ejec: (jobId) => `${prefijo}ejec:${jobId}`,
    eventos: (tenantId) => `${prefijo}eventos:${tenantId}`,
    tokenSire: (proceso, tenantId, clienteId) =>
      `${prefijo}sire:token:${proceso}:${tenantId}:${clienteId}`,
    // ...
  };
}
```

- El prefijo por defecto es `contapp:` (`packages/queue/src/tipos.ts:93`). Así, en producción ves claves como `contapp:pend:sire:<uuid>`.
- Los dos puntos son una **convención** (Redis no tiene carpetas), pero permiten buscar con patrones como `contapp:lock:*`.
- **En pruebas** se usa la **base 15** de Redis y un **prefijo aleatorio por archivo** (`packages/queue/src/soporte-pruebas/int.ts:5`, `:101`): las pruebas no pisan tus datos de desarrollo (base 0) ni se pisan entre sí, y `limpiarPrefijo` borra solo lo suyo. Redis trae 16 bases numeradas (0–15) por defecto.

Centralizar las claves evita el error clásico de escribir `lock:ruc` en un archivo y `lock_ruc` en otro.

---

## 8. El token SIRE: cifrado y con TTL

La API SIRE de SUNAT entrega un token con vencimiento. Pedirlo en cada llamada es lento, así que el worker lo guarda en Redis. Pero un token es un **secreto**: no puede quedar en claro en la pizarra.

```ts
// apps/worker/src/trabajos/token-sire/cache-token.ts:1-5
// Token SIRE por cliente (spec 008, RF-045, D14, CA-11). El token se pide con el puerto `SireAuth` y se guarda en Redis
// cifrado con AES-256-GCM: llave de 32 B aleatoria que solo vive en la memoria de este proceso, valor `nonce‖ct‖tag` y
// AAD = nombre de la clave (un valor copiado a otra clave no abre). TTL = vencimiento − margen − ahora. [...]
```

Paso a paso (sin mostrar valores reales):

1. **Llave efímera**: `randomBytes(32)` al crear el objeto (`cache-token.ts:62`). Solo existe en la RAM del proceso; si el proceso reinicia, los tokens guardados ya no se pueden abrir y simplemente se pide uno nuevo.
2. **Sellar** (`cache-token.ts:128-134`): AES-256-GCM con un `nonce` aleatorio de 12 bytes; se guarda `nonce ‖ texto cifrado ‖ etiqueta`.
3. **AAD = nombre de la clave**: si alguien copia el valor a la clave de otro cliente, la etiqueta no cuadra y `abrir` devuelve `null`.
4. **TTL**: `vencimiento − 60 s de margen − ahora`, con `SET ... PX` (`cache-token.ts:116-124`). Redis lo borra antes de que SUNAT lo rechace.
5. **Single-flight**: si 10 trabajos piden el token del mismo cliente a la vez, se hace **una** sola petición a SUNAT (`enVuelo`, `cache-token.ts:76-84`).

Así, aunque alguien lea Redis con `redis-cli`, solo ve bytes ilegibles. Esto respeta la regla del proyecto: *nunca registrar, devolver ni exportar secretos*. El cifrado de las credenciales SOL en sí está en el [módulo 07](07-seguridad-cifrado-y-sesiones.md).

---

## 9. ¿Y si Redis se cae?

Diseño **outbox + reconciliador** (D1, D3):

1. Encolar = `INSERT` en `job_registro` dentro de `withTenant`, **commit**, y recién después publicar en Redis (`apps/backend/src/modules/trabajos/encolador.ts:34-41`). Ver [módulo 03](03-rls-y-withtenant.md) §3.5.
2. Si Redis no responde, el error **no se propaga**: `publicar` registra "fallo de Redis en la pista; el reconciliador repone" (`packages/queue/src/encolado.ts:159`). El usuario recibe su trabajo `en_cola` igual.
3. El backend está configurado para no colgarse: conexión perezosa, `maxRetriesPerRequest: 1`, `commandTimeout: 1000` (`apps/backend/src/modules/trabajos/redis.ts:24-30`). Con Redis caído, cada comando cede en ~1 s y las demás rutas siguen respondiendo.
4. Cuando Redis vuelve, el **reconciliador** (`packages/queue/src/reconciliador.ts:1-6`) recorre `job_registro`, repone las pistas de los estudios con trabajos `en_cola` y resuelve los `ejecutando` cuyo arriendo venció.

Resultado: Redis caído = la cola se **pausa**, no se **pierde** nada. Si borraras Redis entero (`FLUSHALL`), el sistema se reconstruye solo. Por eso no hace falta respaldarlo.

---

## 10. Práctica con `redis-cli`

Usa siempre claves `curso:*` y bórralas al final. En Linux/macOS: `redis-cli`. En **Windows**: instala [Memurai](https://www.memurai.com/) (compatible con Redis) o usa Redis dentro de **WSL** (`sudo apt install redis-server`).

```bash
redis-cli PING                       # PONG
```

**Strings y TTL**

```bash
redis-cli SET curso:saludo "hola contador"   # OK
redis-cli GET curso:saludo                   # "hola contador"
redis-cli EXPIRE curso:saludo 60             # (integer) 1
redis-cli TTL curso:saludo                   # (integer) 60  (y va bajando)
```

**Lock con arriendo**

```bash
redis-cli SET curso:lock:ruc:sire:20100047218 trabajo-1 PX 30000 NX   # OK
redis-cli SET curso:lock:ruc:sire:20100047218 trabajo-2 PX 30000 NX   # (nil)  <- ocupado
redis-cli PTTL curso:lock:ruc:sire:20100047218                        # ~29990 ms
```

**El reloj de Redis**

```bash
redis-cli TIME
# 1) "1793382366"   <- segundos
# 2) "660972"       <- microsegundos
```

**Cupos con ZSET** (en bash, usamos `TIME` para calcular "ahora" en ms):

```bash
AHORA=$(( $(redis-cli TIME | head -1) * 1000 ))
redis-cli ZADD curso:cupo:sire $((AHORA + 30000)) job-a $((AHORA - 5000)) job-b   # 2
redis-cli ZRANGEBYSCORE curso:cupo:sire -inf $AHORA      # job-b  (vencido)
redis-cli ZREMRANGEBYSCORE curso:cupo:sire -inf $AHORA   # 1      (lo poda)
redis-cli ZRANGE curso:cupo:sire 0 -1 WITHSCORES         # job-a y su vencimiento
redis-cli ZCARD curso:cupo:sire                          # 1 cupo vivo
```

(ContApp poda uno por uno con `ZREM` porque antes comprueba `ejec:{jobId}`; aquí `ZREMRANGEBYSCORE` lo hace de golpe.)

**Set, hash y list**

```bash
redis-cli SADD curso:tenants:sire est-a est-b est-a   # 2 (el repetido no cuenta)
redis-cli SMEMBERS curso:tenants:sire
redis-cli HSET curso:cliente:1 ruc 20100047218 razon "Cliente A dos"
redis-cli HGETALL curso:cliente:1
redis-cli RPUSH curso:lista a b ; redis-cli LPOP curso:lista   # "a"
redis-cli TYPE curso:cupo:sire                         # zset
```

**Pub/sub en dos terminales**

```bash
# Terminal 1 (queda escuchando; Ctrl+C para salir)
redis-cli SUBSCRIBE curso:eventos:demo
# Terminal 2
redis-cli PUBLISH curso:eventos:demo '{"estado":"en_cola"}'   # (integer) 1 = un oyente
# En la terminal 1 aparece: message / curso:eventos:demo / {"estado":"en_cola"}
```

**Buscar y limpiar** (nunca uses `KEYS *` en producción: bloquea Redis; `SCAN` va por partes):

```bash
redis-cli SCAN 0 MATCH 'curso:*' COUNT 100
redis-cli --scan --pattern 'curso:*' | xargs redis-cli DEL
redis-cli --scan --pattern 'curso:*'          # ya no sale nada
```

Para curiosear lo que hay en la cola de tu entorno local: `redis-cli --scan --pattern 'contapp:*'`. Solo mira; no borres claves `contapp:*` a mano mientras el worker corre.

---

## Impacto en ContApp

- **Velocidad**: el despachador consulta cupos y locks miles de veces sin cargar PostgreSQL.
- **Autocuración**: con TTL, un worker muerto no deja basura permanente; los cupos y locks vencen en ≤ 30 s.
- **Respeto a SUNAT**: un solo trabajo por RUC y canal, y límites por estudio para que nadie acapare la cola.
- **Tiempo real**: el panel de trabajos se actualiza por SSE gracias a pub/sub.
- **Riesgo acotado**: como no es fuente de verdad, perder Redis no pierde datos; y lo sensible (token SIRE) va cifrado.

## Errores comunes

- Tratar Redis como base de datos principal (guardar algo que no puedes reconstruir).
- Usar contadores `INCR`/`DECR` para cupos: se desfasan si el proceso muere.
- `SET` y luego `EXPIRE` en dos comandos: si mueres entre ambos, la clave queda sin TTL para siempre. Usa `SET ... PX ... NX` en uno.
- Borrar un lock sin comprobar que sigue siendo tuyo.
- Usar `Date.now()` del proceso para decidir vencimientos: usa `TIME` de Redis.
- Publicar en Redis **dentro** del callback de `withTenant`.
- `KEYS *` en producción; usa `SCAN`.
- Correr pruebas contra la base 0: las de la cola usan la 15 con prefijo propio.
- Guardar tokens o secretos en claro en Redis.

## Ejercicios

1. Con `redis-cli`, crea `curso:lock:x` con `SET NX PX 5000`, intenta tomarlo otra vez, espera 6 s y vuelve a intentar. ¿Qué responde cada vez?
2. ¿Por qué los cupos son un ZSET con puntaje = vencimiento y no un contador?
3. Un worker tiene el reloj adelantado 40 s. Si usara su propia hora para fechar su cupo, ¿qué pasaría al morir? ¿Qué lo evita en el código?
4. Redis estuvo caído 5 minutos y un usuario encoló 3 trabajos en ese lapso. ¿Se perdieron? Explica el recorrido.
5. Alguien hace `GET` de una clave `contapp:sire:token:...` y la pega en otra clave `contapp:sire:token:...` de otro cliente. ¿Funciona el token robado?

<details>
<summary>Soluciones</summary>

1. `OK`, luego `(nil)` porque existe; tras 6 s el arriendo venció y vuelve a dar `OK`. Al final: `redis-cli DEL curso:lock:x`.
2. Si el proceso muere, un contador nunca baja y el cupo queda ocupado para siempre. Con el ZSET, el miembro tiene fecha de vencimiento; la poda (`zrangebyscore` hasta ahora + `zrem`) lo saca solo cuando su `ejec:` ya no existe.
3. Su cupo quedaría fechado 40 s más en el futuro y el despachador lo seguiría contando como vivo (H-008-2b-2). Lo evita `horaRedisMs` (`arriendos.ts:31`): `tomarCupos`, `reservarCupos` y la poda usan `TIME` de Redis e ignoran la hora local.
4. No. Se insertaron en `job_registro` (PostgreSQL) y se hizo commit; `publicar` falló en silencio (registró el aviso). Cuando Redis volvió, el reconciliador vio los `en_cola` en la BD y repuso `tenants:{cola}`/`pend:...`; el despachador los tomó.
5. No. El valor está cifrado con AES-256-GCM con una llave que solo vive en la memoria del proceso, y la AAD es el nombre de la clave: en otra clave la verificación falla y `abrir` devuelve `null`. Además, la clave incluye el identificador del proceso: otros procesos no comparten tokens.

</details>

## Para profundizar

- Redis: tipos de datos — https://redis.io/docs/latest/develop/data-types/
- Redis: comando `SET` (opciones `NX`, `PX`) — https://redis.io/docs/latest/commands/set/
- Redis: Pub/Sub — https://redis.io/docs/latest/develop/interact/pubsub/
