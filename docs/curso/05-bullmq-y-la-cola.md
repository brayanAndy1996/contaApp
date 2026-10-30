# Módulo 05 · BullMQ y la cola de trabajos

> Anterior: [04 · Redis](04-redis.md) · Siguiente: [06 · Backend NestJS y SSE](06-backend-nestjs-sse.md) · [Índice](00-indice.md)

## Lo que aprenderás

- Por qué ContApp no llama a SUNAT "en vivo" desde la petición HTTP y usa una **cola de trabajos**.
- Los conceptos de **BullMQ**: `Queue`, `Worker`, `Job`, `jobId`, `attempts`, `lockDuration`/*stalled* y trabajos repetibles.
- Lo **particular** de ContApp: PostgreSQL (`job_registro`) es la fuente de verdad y BullMQ solo es el mensajero.
- Cómo funcionan el *outbox*, la deduplicación, el despachador justo (round-robin), el lock por RUC, los arriendos con latido, el reconciliador y los reintentos.
- Qué encontró el equipo adversarial y qué lección deja cada hallazgo.

---

## 1. ¿Por qué una cola?

SUNAT es **lenta e inestable**: una descarga del SIRE puede tardar minutos, el portal SOL a veces no responde y además limita cuántas sesiones abre un mismo RUC. Si el backend hiciera la llamada dentro de la petición HTTP, el contador se quedaría mirando una ruedita, el navegador cortaría a los 30–60 s y un reintento manual duplicaría el trabajo.

**Analogía del estudio contable.** Piensa en la *bandeja de pendientes* del estudio:

- El contador deja un papel en la bandeja ("descargar compras de 20123456789, periodo 2026-09") y sigue con lo suyo. Eso es **encolar**.
- Un **asistente** revisa la bandeja por turnos: atiende un papel de cada contador para que nadie acapare la bandeja. Eso es el **despachador**.
- Otros asistentes salen a SUNAT a hacer el trámite. Esos son los **workers**.
- En el **libro de control** (no en la bandeja) se anota qué papel está en espera, en trámite o terminado. Ese libro es `job_registro` en PostgreSQL.

El usuario **no espera**: el backend responde al instante con el trabajo `en_cola` y luego le avisa por SSE (módulo 06) cuando cambia de estado.

---

## 2. BullMQ en 5 minutos

[BullMQ](https://docs.bullmq.io/) es una librería de Node.js que implementa colas sobre Redis (módulo 04).

| Concepto | Qué es | Analogía |
|---|---|---|
| `Queue` | Productor: agrega jobs a una cola con nombre | La bandeja |
| `Worker` | Consumidor: toma jobs y ejecuta una función | El asistente que hace el trámite |
| `Job` | Un mensaje con `name`, `data` y opciones | El papel |
| `jobId` | Id del job; si ya existe uno con ese id, `add` lo ignora | El número del papel |
| `attempts` | Cuántas veces BullMQ reintenta por su cuenta | "Si falla, vuelve a intentarlo N veces" |
| `concurrency` | Jobs simultáneos por `Worker` | Cuántos trámites lleva a la vez un asistente |
| `lockDuration` | Mientras procesa, el worker renueva un candado del job; si deja de renovarlo, el job queda *stalled* (atascado) | "Si no das señales de vida en 10 s, asumo que te desmayaste" |
| `maxStalledCount` | Cuántas veces se reentrega un job atascado | — |
| Job scheduler / repetible | Job que BullMQ agrega solo según un patrón cron | Tarea diaria del calendario |

Así se configura en ContApp (`packages/queue/src/worker/index.ts:67-77` y `:139-146`):

```ts
// Productor
await cola(nombre).add(payload.tipo, payloadTrabajoSchema.parse(payload), {
  jobId: idJobBull(payload.jobId, opciones?.intento),
  attempts: 1,               // BullMQ NO reintenta: lo decide el ejecutor
  removeOnComplete: true,
  removeOnFail: true,
});

// Consumidor
const w = new Worker(cola, (job) => procesarJob(cola, job, o.procesar), {
  connection: o.conexion,
  prefix: prefijoBull(o.prefijo),          // "contapp:bull"
  concurrency: Math.max(1, concurrencia),  // = concurrencia_global de config_sistema
  maxStalledCount: 0,                      // un job atascado NUNCA se reentrega
  lockDuration: ARRIENDO_BULL_MS,          // 10 s
  stalledInterval: REVISION_STALLED_MS,    // 5 s
});
```

Fíjate en dos decisiones raras a primera vista: `attempts: 1` y `maxStalledCount: 0`. ContApp **apaga** los reintentos automáticos de BullMQ porque la decisión de reintentar depende del tipo de error y de si el trabajo es idempotente, y eso vive en PostgreSQL (sección 6).

---

## 3. Lo particular de ContApp: el libro manda, BullMQ solo transporta

### 3.1 `job_registro` es la fuente de verdad (D1)

Redis se puede perder (reinicio, memoria llena). Por eso el estado de cada trabajo vive en `job_registro` (migración `packages/db/migrations/0017_trabajos.sql:19-56`), con RLS por estudio (módulo 03). Columnas clave: `estado`, `intentos`, `motivo`, `disponible_desde`, `prioridad`, `ruc`, `canal`, `clave_dedupe`.

Las transiciones son atómicas con `UPDATE … WHERE id = $1 AND estado = $2` (D2): si dos procesos intentan mover el mismo trabajo, **solo uno** cambia la fila y el otro recibe `false`.

### Ciclo de vida

```
                 encolar (backend, dentro de la transacción)
                                │
                                ▼
                         ┌────────────┐  cancelar (usuario) / acceso retirado /
                         │  en_cola   │──── credencial inválida ───────────────┐
                         └─────┬──────┘                                        │
            despachador:       │  ▲  reintento (ErrorTransitorio,              ▼
            cupo + lock RUC    │  │  intentos < reintentos, con backoff)  ┌───────────┐
                               ▼  │  o reconciliador (idempotente)        │ cancelado │
                         ┌────────────┐                                   └───────────┘
                         │ ejecutando │──────────────┐
                         └─────┬──────┘              │ ErrorCredencial / ErrorDatos /
                       éxito   │                     │ ErrorPortal / reintentos agotados /
                               ▼                     ▼ caída sin idempotencia ("interrumpido")
                         ┌────────────┐         ┌─────────┐
                         │ completado │         │  error  │
                         └────────────┘         └─────────┘
```

### 3.2 Payload mínimo (CA-15)

Lo que viaja por BullMQ es exactamente `{ jobId, tenantId, tipo }` (`packages/queue/src/encolado.ts:173-177`). Ni RUC, ni parámetros, ni credenciales. El worker valida con zod `.strict()` y luego carga la fila **dentro de `withTenant(tenantId)`**; si no existe en ese estudio, si el tipo no coincide o si no está `ejecutando`, termina sin hacer nada (`apps/worker/src/trabajos/ejecutor.ts:197-218`). Un payload forjado con el `jobId` de otro estudio no encuentra la fila (RLS) y no ejecuta nada.

### 3.3 Outbox: primero el libro, después la bandeja (D3)

Problema clásico: si escribes en PostgreSQL y en Redis "a la vez", puede fallar uno de los dos y quedas inconsistente. El **patrón outbox** lo resuelve así:

1. `encolar` solo **inserta en la BD**, dentro de la transacción del caso de uso.
2. Después del `COMMIT`, `publicar` deja la pista en Redis.
3. Si Redis falla en el paso 2, no pasa nada grave: el **reconciliador** repone la pista desde la BD.

En el backend (`apps/backend/src/modules/trabajos/encolador.ts:34-41`):

```ts
async encolar(ctx: ContextoEncolar, e: EntradaEncolar): Promise<ResultadoEncolar> {
  const r = await this.db.withTenant(ctx, (tx) => encolar(tx, e)); // BD; al salir hace COMMIT
  if (r.nuevo) await this.publicar(ctx.tenantId, r.trabajo, e);    // Redis, DESPUÉS del commit
  return r;
}
```

¿Por qué fuera del callback de `withTenant`? Porque una tarea asíncrona lanzada dentro hereda el contexto del estudio y podría ejecutarse antes del commit (el trabajo aún no "existe" para otros) o fallar cerrado.

`publicar` (`encolado.ts:147-170`) hace `ZADD pend:{cola}:{tenant}` con un **puntaje** que pone todo `interactivo` antes que todo `programado` (`encolado.ts:136-141`) y `SADD tenants:{cola}` para que el despachador sepa qué estudios tienen pendientes. Sus errores se registran sin datos y **no se propagan**.

### 3.4 Deduplicación (D8)

Si el contador hace doble clic, no queremos dos descargas iguales. `claveDedupe` (`packages/queue/src/claves.ts:27-35`) es un SHA-256 de `[tipo, clienteId, parámetros]` en JSON canónico (claves ordenadas). Un índice único parcial lo garantiza en la BD:

```sql
-- 0017_trabajos.sql:52
CREATE UNIQUE INDEX "job_registro_dedupe_vivo" ON "job_registro"
  USING btree ("tenant_id","clave_dedupe") WHERE estado IN ('en_cola', 'ejecutando');
```

Si ya hay uno vivo, `encolar` devuelve ese mismo trabajo con `nuevo: false` (`encolado.ts:63-66`) y el backend no publica nada. Además hay un tope de pendientes por estudio y cola (`max_pendientes_tenant`, 2,000 por defecto) que responde `429 cola_llena`.

---

## 4. El despachador: el asistente que reparte por turnos

BullMQ por sí solo es FIFO: si el estudio A encola 1,000 trabajos y luego B encola uno, B esperaría detrás de los 1,000. Por eso ContApp **no** mete los trabajos a BullMQ al encolar: un **despachador** propio decide qué sale y cuándo (`packages/queue/src/despachador.ts`). Corre cada 500 ms (`apps/worker/src/trabajos/iniciar.ts:83-87`).

**Liderazgo.** Puede haber varios procesos worker, pero solo uno despacha cada cola: el que gana `SET lider:{cola} <id> PX 30000 NX` (`despachador.ts:109-118`).

**Round-robin.** Recorre los estudios ordenados empezando por el siguiente al último atendido (`despachador.ts:124-133`) y despacha **como máximo uno por estudio y ciclo**.

**Cupos.** Dos límites por cola, leídos de `config_sistema` (por defecto `sire`: 4 global y 2 por estudio; `sol`: 2 y 1; `xml`: 8 y 4, ver `0018_trabajos_rls.sql:45-50`):

```ts
// despachador.ts:141-156 (simplificado)
if (await cuposVivos(redis, k, k.cupoGlobal(cola), ms) >= cfg.concurrenciaGlobal) return;   // cola llena
if (await cuposVivos(redis, k, k.cupoTenant(cola, tenantId), ms) >= cfg.concurrenciaTenant) continue; // este estudio ya tiene su parte
```

**Prioridad.** Los candidatos salen de PostgreSQL ordenados `order by (prioridad = 'programado'), creado_en, id` (`packages/db/src/trabajos/registro.ts:317-320`): interactivo antes que programado.

**Ventana de 20 candidatos (D21).** Si el primer trabajo del estudio es de un RUC ocupado, no se bloquea toda la fila: se miran hasta `VENTANA_CANDIDATOS = 20` (`despachador.ts:45`) y se despacha el primero con RUC libre (`despachador.ts:212-221`). Riesgo aceptado: si los 20 primeros tienen el RUC ocupado, ese estudio no despacha en ese ciclo.

**Lock por RUC entre estudios (D20).** SUNAT limita por RUC, así que dos estudios que atienden al mismo cliente no pueden golpear SUNAT a la vez con ese RUC. El lock es global (`lock:ruc:{canal}:{ruc}`), se toma con `SET NX PX` (`arriendos.ts:153-167`) y al terminar **no se borra**: se deja vivo `espera_ruc_ms` (2 s por defecto) para dar un respiro a SUNAT (`arriendos.ts:173-185`). Los trabajos de canal `ninguno` no usan lock.

Antes de despachar, además, se revalida que quien encoló siga teniendo acceso al cliente (si no, `cancelado/acceso_retirado`) y que la credencial no esté marcada inválida (si no, `cancelado/credencial_invalida`, CA-9) (`despachador.ts:222-247`).

Al final, **orden importante** (`despachador.ts:248-281`): tomar lock → reservar cupos de forma atómica → `UPDATE en_cola → ejecutando` → commit → recién entonces `agregarACola` a BullMQ con el payload mínimo.

---

## 5. Arriendos con latido: nada de contadores

Un contador "trabajos en curso = 3" se corrompe si el proceso muere sin restar. ContApp usa **arriendos con TTL** (`packages/queue/src/arriendos.ts`): todo vence solo en ≤ 30 s (`ARRIENDO_MS`).

| Clave Redis | Qué representa |
|---|---|
| `cupo:{cola}` y `cupo:{cola}:{tenant}` | ZSET `jobId → vencimiento` (cupos global y del estudio) |
| `lock:ruc:{canal}:{ruc}` | Lock del RUC, valor = `jobId` |
| `ejec:{jobId}` | "Este proceso está ejecutando este trabajo", valor = id propio de la ejecución |
| `lider:{cola}` | Quién despacha esa cola |

El ejecutor renueva todo con un **latido** cada 10 s (`arriendos.ts:207-225` y `:245-254`). Toda la hora sale de `TIME` de Redis (`arriendos.ts:31-36`), nunca del reloj local (ver hallazgos, sección 11).

---

## 6. El ejecutor, los errores y los reintentos

`Ejecutor.ejecutarJob` (`apps/worker/src/trabajos/ejecutor.ts:191-330`) hace cinco pasos:

1. `withTenant` corto: carga y valida la fila (CA-15).
2. Toma `ejec:{jobId}` con un valor aleatorio propio (`ejecutor.ts:222-226`). Si otro ya lo tiene, termina.
3. Ejecuta el **procesador sin transacción abierta** (D6: no dejar una conexión de BD tomada minutos mientras SUNAT responde), con latido.
4. `withTenant` corto con el resultado: `completado`, reintento (`en_cola`) o `error`.
5. Después del commit: libera cupos, deja el lock del RUC con la espera y publica el evento.

### Clasificación de errores (`packages/sunat/src/errores.ts`)

| Clase | Ejemplo | ¿Reintenta? | Motivo final |
|---|---|---|---|
| `ErrorTransitorio` (`:27`) | timeout, 5xx, red caída | Sí, hasta `reintentos` | `sunat_no_responde` |
| `ErrorCredencial` (`:36`) | 401/403 del OAuth | No | `credencial_invalida` |
| `ErrorDatos` | 4xx de negocio | No | `datos_invalidos` |
| `ErrorPortal` | SUNAT cambió el portal | No | `portal_cambio` |
| Cualquier otra cosa | — | Cuenta como transitorio | — |

El mensaje de cada clase es **fijo**: la causa cruda se descarta para que nunca llegue a un log (CA-16). El ejecutor solo guarda la *clase* (`ejecutor.ts:376-379`).

### Backoff exponencial con jitter (`packages/queue/src/reintentos.ts:24-30`)

```ts
export function calcularBackoffMs(n: number, baseMs: number, azar = Math.random): number {
  return Math.round(baseMs * 2 ** (n - 1) * (0.8 + 0.4 * azar()));
}
```

Con `backoff_base_ms = 5000`: 1.er reintento entre 4 y 6 s, 2.º entre 8 y 12 s, 3.º entre 16 y 24 s. El *jitter* (±20 %) evita que 500 trabajos que fallaron juntos vuelvan a golpear SUNAT en el mismo milisegundo. El reintento no usa BullMQ: el trabajo vuelve a `en_cola` con `disponible_desde` en el futuro, y el despachador lo ignora hasta entonces. `decidirTrasError` (`reintentos.ts:39-60`) lo decide como función **pura**, fácil de probar.

### Credencial inválida (CA-9)

Con `ErrorCredencial`, en la **misma transacción** del cierre se marca `credencial.estado = 'invalida'` (`ejecutor.ts:480-495`), se avisa una sola vez al `Notificador` (sin esperarlo, `:279-289`) y, desde ese momento, el despachador cancela los pendientes de ese cliente que usan esa credencial. Así no se bloquea la clave SOL del cliente con 50 intentos fallidos.

### Token SIRE single-flight

Si 10 trabajos del mismo cliente piden token a la vez, solo uno va a SUNAT; los demás esperan **la misma promesa** (`apps/worker/src/trabajos/token-sire/cache-token.ts:76-84`):

```ts
const previo = this.enVuelo.get(id);
if (previo !== undefined) return previo;               // ya hay uno en vuelo: compártelo
const p = this.resolver(ctx).finally(() => this.enVuelo.delete(id));
this.enVuelo.set(id, p);
```

El token se guarda en Redis cifrado con AES-256-GCM y una llave que solo vive en memoria. Tras un 401 se renueva **una sola vez** (`cache-token.ts:87-103`); si vuelve a fallar, se convierte en `ErrorCredencial`.

---

## 7. El reconciliador: el que revisa el libro cada 30 s

`packages/queue/src/reconciliador.ts` corre cada 30 s y hace dos cosas:

- **Repone pistas**: si un estudio tiene `en_cola` pero Redis no lo sabe (Redis cayó al encolar), vuelve a hacer `SADD tenants:{cola}`.
- **Resuelve huérfanos**: un trabajo `ejecutando` sin `ejec:{jobId}` y con cupo vencido es de un worker que murió (`reconciliador.ts:201-210`). Entonces:

```ts
// reconciliador.ts:132-157 (simplificado)
if (idempotente && fila.intentos < reintentos) {
  transicionar(tx, id, "ejecutando", "en_cola", { intentos: fila.intentos + 1 }, guarda); // se reintenta
} else {
  transicionar(tx, id, "ejecutando", "error", { motivo: "interrumpido" }, guarda);       // no se arriesga
}
```

¿Por qué la diferencia? Descargar un reporte dos veces no hace daño (**idempotente**). Pero enviar una rectificación a SUNAT dos veces sí podría: si no sabemos si llegó, es mejor marcar `interrumpido` y que el contador revise. Cada tipo declara si es idempotente en el **catálogo** (`packages/queue/src/catalogo.ts:19-27`).

---

## 8. Trabajos de sistema: `kek.rotar` y `auth.purgar`

No pertenecen a ningún estudio, así que **no** usan `job_registro` (D10). Viajan por la cola `programados` con payload validado por una unión discriminada estricta (`worker/index.ts:172-177`):

- `auth.purgar`: limpia sesiones vencidas. Es **repetible** con un *job scheduler* de BullMQ, todos los días a las 03:30 de Lima (`worker/index.ts:209-219`):
  ```ts
  await cola().upsertJobScheduler("auth.purgar",
    { pattern: "30 3 * * *", tz: "America/Lima" },
    { name: "auth.purgar", data: { tipo: "auth.purgar" }, opts: OPCIONES_JOB_SISTEMA });
  ```
  `upsert` es idempotente: aunque arranquen 3 workers, queda un solo programa.
- `kek.rotar`: re-envuelve las llaves de cifrado (módulo 07). Lo encola el operador con `pnpm --filter @contapp/worker trabajos:kek-rotar --desde <kekId>`.

---

## 9. Cierre ordenado del worker

Al recibir SIGTERM (un despliegue, por ejemplo), `detener` (`apps/worker/src/trabajos/iniciar.ts:303-329`):

1. Deja de despachar y de reconciliar (máx. 5 s).
2. Cierra los `Worker` de BullMQ para no tomar jobs nuevos.
3. Espera a los trabajos en curso hasta 30 s.
4. Si no terminan: suelta sus arriendos y deja de escribir; el reconciliador los resolverá.

Todo tiene **tope de tiempo**, incluso con Redis o la BD caídos (hallazgos H-008-1b-6 y H-008-2a-5).

---

## 10. Historia: A encola 1,000 trabajos y B uno solo

Cola `sire` con 4 cupos globales y 2 por estudio.

1. 09:00:00 — El Estudio A pide descargar 1,000 periodos. El backend inserta 1,000 filas `en_cola`, hace commit y publica: `pend:sire:A` con 1,000 ids y `tenants:sire = {A}`. Responde en milisegundos.
2. 09:00:00.5 — El despachador lidera `sire`, ve solo a A y despacha 1 (uno por estudio y ciclo). En los ciclos siguientes llega a 2 (el tope de A). Los otros 2 cupos globales quedan libres porque nadie más espera.
3. 09:00:05 — El Estudio B encola **un** trabajo. `tenants:sire = {A, B}`.
4. Siguiente ciclo — round-robin: después de A le toca a B. B tiene 0 en curso (< 2) y hay cupo global: **sale de inmediato**. No espera a los 1,000 de A.
5. Si B pide el **mismo RUC** que A está atendiendo, B espera a que el lock de ese RUC se libere (+2 s de espera). Si B tenía otros trabajos con RUC libre dentro de sus 20 primeros, sale uno de esos.
6. A sigue a su ritmo: 2 a la vez, hasta terminar.

Esto es exactamente lo que verifica la prueba `packages/queue/src/despacho.int.spec.ts:69` ("A con 1,000 pendientes y C también: B (1 trabajo) empieza al liberarse el primer cupo y nadie pasa de 2 por estudio ni de 4 en total").

---

## 11. Hallazgos adversariales y sus lecciones

El rol *adversario* intenta romper cada spec. En la 008 encontró 26 hallazgos, todos corregidos (`docs/specs/ESTADO.md`, líneas 90–115 de la tabla de hallazgos). Cuatro ejemplos:

**Dos líderes a la vez (H-008-1b-1, H-008-2a-1/2b-6).** El liderazgo vence a los 30 s; si un ciclo se demora más, otro proceso se vuelve líder y ambos despachan: un estudio llegó a 3 en ejecución con límite 2. Corrección: `reservarCupos` agrega y **luego** cuenta, y deshace si se pasó (`arriendos.ts:114-140`); y si se pierde la transición, se relee la fila para no soltar el cupo del ganador (`despachador.ts:268-278`).
*Lección:* un lock con TTL no garantiza exclusión; toda reserva debe validarse donde ocurre.

**`ejec` con valor por ejecución (H-008-1b-3, severidad alta).** Antes, `ejec:{jobId}` guardaba el `jobId`. Un ejecutor congelado 25 s perdía su arriendo, el trabajo se re-despachaba y, al despertar, el viejo cerraba el trabajo con su resultado y borraba el `ejec` del nuevo. Corrección: valor aleatorio por ejecución (`ejecutor.ts:222`) y transición final con guarda `intentos` (`ejecutor.ts:473-478`).
*Lección:* "soltar el lock" siempre debe comprobar que el lock **sigue siendo tuyo**.

**Relojes desfasados (H-008-2b-1 a 2b-5).** Un proceso con el reloj adelantado 40 s daba por vencidos trabajos recién despachados y los marcaba `interrumpido` sin ejecutarlos. Corrección: una sola fuente de tiempo, `TIME` de Redis (`arriendos.ts:31-36`).
*Lección:* en sistemas distribuidos, nunca compares horas de máquinas distintas.

**Carrera de dedupe 23505 (H-008-1a-2, H-008-2b-7).** Dos `encolar` simultáneos de lo mismo: ambos ven "no hay vivo", ambos insertan y uno revienta con `23505` (violación de unicidad) → 500 al usuario. Detectado como intermitente en CI. Corrección: `INSERT … ON CONFLICT DO NOTHING`, relectura del vivo y hasta 3 intentos (`encolado.ts:95-107`).
*Lección:* "comprobar y luego insertar" no es atómico; deja que la BD arbitre.

---

## Impacto en ContApp

- **Experiencia**: el contador nunca espera a SUNAT; ve el avance en vivo.
- **Justicia multitenant**: un estudio grande no deja sin servicio a uno pequeño (CA-2).
- **Protección del cliente**: el lock por RUC y la cancelación por credencial inválida evitan bloqueos de la clave SOL.
- **Resiliencia**: si Redis o un worker mueren, el libro (PostgreSQL) permite reconstruir todo.
- **Seguridad**: Redis nunca ve RUC, parámetros, ni secretos; el token SIRE va cifrado.

---

## Práctica

### A. Correr las pruebas de integración de la cola

Requieren PostgreSQL y Redis reales, con las migraciones aplicadas y el `.env` en la raíz (copiado de `.env.example`, con tus propios valores; nunca lo subas al repo).

```bash
pnpm db:migrate                                  # una vez
pnpm --filter @contapp/queue test                # unitarias (sin BD ni Redis), rápidas
pnpm --filter @contapp/queue test:int            # *.int.spec.ts, en un solo hilo, ~minutos
pnpm --filter @contapp/queue test:int despacho   # solo ese archivo (filtro por nombre de vitest)
```

Abre `packages/queue/src/despacho.int.spec.ts` y lee los títulos de los `it(...)` (líneas 69, 140, 170, 190, 225, 279, 296, 333, 356, 393): son la especificación ejecutable de CA-2, CA-3, D21 y CA-15. La prueba de la línea 393 vuelca todo Redis y comprueba que ningún valor contiene RUC ni parámetros.

### B. Consultas SQL de solo lectura

`job_registro` tiene RLS con `FORCE`: sin estudio fijado verás **cero filas**, incluso como dueño de la tabla. Fija el estudio dentro de una transacción que luego descartas:

```sql
BEGIN READ ONLY;
SET LOCAL app.tenant_id = '<uuid-del-estudio>';

-- ¿Cuántos trabajos hay por estado y cola?
SELECT cola, estado, count(*) FROM job_registro GROUP BY 1, 2 ORDER BY 1, 2;

-- Los próximos candidatos, en el mismo orden que usa el despachador
SELECT id, tipo, prioridad, intentos, disponible_desde
FROM job_registro
WHERE cola = 'sire' AND estado = 'en_cola' AND disponible_desde <= now()
ORDER BY (prioridad = 'programado'), creado_en, id
LIMIT 20;

-- Errores recientes y su motivo
SELECT tipo, motivo, count(*) FROM job_registro
WHERE estado = 'error' AND terminado_en > now() - interval '1 day' GROUP BY 1, 2;
ROLLBACK;

-- config_sistema no tiene RLS (es de plataforma)
SELECT * FROM config_sistema ORDER BY cola;
```

---

## Errores comunes

- **Meter datos sensibles en el payload de BullMQ.** Solo `{ jobId, tenantId, tipo }`. Lo demás se lee de la BD.
- **Publicar en Redis dentro de `withTenant`.** Rompe el outbox: publica después del commit.
- **Activar `attempts` o la reentrega de *stalled* de BullMQ.** Duplicaría ejecuciones de trabajos no idempotentes.
- **Usar `Date.now()` para decidir vencimientos.** Usa `horaRedisMs`.
- **Registrar el error crudo de SUNAT.** Puede traer RUC, usuario o token. Solo la clase y el código.
- **Olvidar la fila en `config_sistema`.** Una cola sin fila falla cerrado con `ColaNoConfiguradaError` (500).

---

## Ejercicios

1. Con `backoff_base_ms = 5000` y `reintentos = 3`, ¿cuántas veces como máximo se ejecuta un trabajo que siempre lanza `ErrorTransitorio`, y entre qué valores cae la espera antes del 3.er reintento?

<details><summary>Solución</summary>

4 ejecuciones (1 + 3 reintentos; por eso `maxIntentos = config.reintentos + 1` en `encolado.ts:87`). El 3.er reintento usa `n = 3`: `5000 · 2² · (0.8…1.2)` = entre 16,000 y 24,000 ms. Después, `decidirTrasError` devuelve `terminar` con `sunat_no_responde`.
</details>

2. Un trabajo **no idempotente** está `ejecutando` y el servidor del worker se apaga de golpe (`kill -9`). ¿Qué estado tendrá al final y quién lo cambia?

<details><summary>Solución</summary>

Nadie renueva `ejec:{jobId}` ni los cupos; vencen en ≤ 30 s. BullMQ no lo reentrega (`maxStalledCount: 0`). En su siguiente pasada, el reconciliador ve el arriendo vencido y, como no es idempotente, lo pasa a `error` con motivo `interrumpido` (`reconciliador.ts:146-157`).
</details>

3. El contador hace doble clic en "Descargar compras 2026-09" del mismo cliente. ¿Cuántas filas se crean y qué devuelve el segundo clic?

<details><summary>Solución</summary>

Una sola fila. Mismo tipo, cliente y parámetros → misma `clave_dedupe`. El segundo `encolar` encuentra el vivo y devuelve ese trabajo con `nuevo: false`; el `Encolador` no publica nada en Redis. Si ambos clics llegan a la vez, el índice `job_registro_dedupe_vivo` y `ON CONFLICT DO NOTHING` arbitran.
</details>

4. ¿Por qué el despachador hace `agregarACola` (BullMQ) **después** del commit de `en_cola → ejecutando`, y qué pasa si BullMQ falla justo ahí?

<details><summary>Solución</summary>

Si se agregara antes, un worker podría tomar el job y no encontrar la fila `ejecutando` (aún no confirmada) y descartarlo. Si `agregarACola` falla después del commit, el trabajo queda `ejecutando` con arriendo de despacho; al vencer (30 s) sin `ejec:`, el reconciliador lo reencola (si es idempotente) o lo marca `interrumpido` (`despachador.ts:326-331`).
</details>

5. Dos estudios distintos atienden al mismo RUC. ¿Pueden ejecutar a la vez un trabajo SIRE de ese RUC? ¿Y uno de canal `ninguno`?

<details><summary>Solución</summary>

SIRE: no. El lock `lock:ruc:sire:{ruc}` es global entre estudios (D20), y al soltarse queda vivo `espera_ruc_ms`. Canal `ninguno`: sí, porque `claveLockRuc` devuelve `null` y no se usa lock (lo comprueba `despacho.int.spec.ts:279`).
</details>

---

## Para profundizar

- BullMQ, guía oficial (Workers, *stalled jobs*, *job schedulers*): https://docs.bullmq.io/
- Redis `SET` con `NX`/`PX` y patrones de lock: https://redis.io/docs/latest/commands/set/
- PostgreSQL, `INSERT … ON CONFLICT`: https://www.postgresql.org/docs/current/sql-insert.html
