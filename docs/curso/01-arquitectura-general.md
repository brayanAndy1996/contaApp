# 01 · Arquitectura general de ContApp

> Módulo anterior: [00 · Índice](00-indice.md) · Siguiente: [02 · PostgreSQL](02-postgresql.md)

## Lo que aprenderás

- Qué es un monorepo y cómo `pnpm` y `turbo` lo mantienen ordenado.
- Qué hace cada una de las tres apps (frontend, backend, worker) y cada paquete de `packages/*`.
- Por qué el backend **nunca** llama a SUNAT ni descifra credenciales, y cómo el repo lo impide.
- El recorrido completo de una petición: desde que el contador abre la pantalla hasta que un trabajo llega a SUNAT (mock).
- Qué significan las reglas de `CLAUDE.md` y qué es SDD.

## 1. La idea en una analogía

Piensa en un estudio contable bien organizado:

| En el estudio contable | En ContApp | Dónde vive |
|---|---|---|
| La **recepción**: atiende al cliente, muestra papeles, no decide nada | Frontend | `apps/frontend` (Next.js) |
| El **jefe de área**: verifica quién pide qué, autoriza, registra el pedido en el cuaderno | Backend | `apps/backend` (NestJS) |
| El **asistente que va a SUNAT**: hace las colas, usa las claves SOL, trae los reportes | Worker | `apps/worker` (NestJS + BullMQ) |
| El **archivador** con los expedientes de cada cliente | PostgreSQL | `packages/db` |
| La **pizarra** de pendientes que todos miran | Redis | `packages/queue` |
| El **manual de procedimientos** que todos siguen | Lógica de negocio pura | `packages/domain` |

La regla de oro: el jefe de área **no va a SUNAT ni guarda las claves SOL en su escritorio**. Si alguien se mete en su oficina (el backend es lo que está expuesto a internet), no encuentra las claves. Solo el asistente, que trabaja en la trastienda sin ventanilla al público, puede usarlas.

## 2. El monorepo: un solo repositorio, muchas piezas

Un **monorepo** es un repositorio que contiene varias aplicaciones y librerías. La ventaja: si cambias un tipo en `packages/shared`, el frontend y el backend ven el cambio en el mismo commit, sin publicar versiones.

```text
contaApp/
├── apps/
│   ├── frontend/     Next.js: pantallas
│   ├── backend/      NestJS: API HTTP, sesiones, permisos, SSE
│   └── worker/       NestJS + BullMQ: ejecuta trabajos, habla con SUNAT
├── packages/
│   ├── shared/       esquemas zod, tipos, permisos (lo único que ve el frontend)
│   ├── domain/       reglas de negocio puras: Money, IGV, prorrata (sin IO)
│   ├── db/           esquema, migraciones, RLS, withTenant
│   ├── crypto/       cifrado de credenciales (KEK/DEK)
│   ├── queue/        encolado, despachador justo, adaptador BullMQ
│   └── sunat/        puertos y adaptadores (mock) hacia SUNAT
├── tests/            pruebas transversales (aislamiento entre estudios, límites)
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

### pnpm workspaces

`pnpm-workspace.yaml` le dice a pnpm qué carpetas son paquetes del monorepo:

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
  - "tests/*"
```

Cada paquete tiene su propio `package.json` con un nombre `@contapp/...`. Cuando el backend declara `"@contapp/db"` como dependencia, pnpm no lo descarga de internet: crea un enlace a `packages/db`. Así se ve la dependencia real de cada app (tomado de sus `package.json`):

| App / paquete | Depende de (`@contapp/*` y librerías clave) |
|---|---|
| `@contapp/frontend` | `@contapp/shared`, `next`, `react` |
| `@contapp/backend` | `@contapp/db`, `@contapp/queue`, `@contapp/shared`, `@nestjs/*`, `@node-rs/argon2`, `ioredis` |
| `@contapp/worker` | `@contapp/crypto`, `@contapp/db`, `@contapp/queue`, `@contapp/shared`, `@contapp/sunat`, `@nestjs/*`, `ioredis` |
| `@contapp/queue` | `@contapp/db`, `@contapp/shared`, `bullmq`, `ioredis`, `zod` |
| `@contapp/db` | `drizzle-orm`, `pg` |
| `@contapp/domain` | `decimal.js` |

Fíjate: **el backend no depende de `@contapp/sunat` ni de `@contapp/crypto`**. No puede llamar a SUNAT ni descifrar aunque quisiera, porque ni siquiera tiene el código instalado.

### turbo

`turbo` ejecuta una tarea (compilar, probar) en todos los paquetes, en el orden correcto y con caché. Su configuración es corta:

```json
// turbo.json (fragmento)
"build": {
  "dependsOn": ["^build"],
  "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
}
```

`"^build"` significa "antes de compilar este paquete, compila los paquetes de los que depende". Por eso `pnpm build` compila primero `shared`, luego `db`, luego `queue`, y al final las apps. Si nada cambió en `packages/domain`, turbo reutiliza el resultado anterior (caché) y no lo vuelve a compilar.

**Pruébalo** (no modifica nada, solo muestra el plan):

```bash
pnpm -r ls --depth -1                                   # lista todos los paquetes del workspace
pnpm turbo run build --filter=@contapp/worker --dry     # qué compilaría turbo para el worker y en qué orden
pnpm --filter @contapp/domain test                      # corre las pruebas de un solo paquete
```

## 3. Las tres apps

Tomado de `docs/03-arquitectura.md` §1 y verificado en el código:

| Proceso | Responsabilidad | Nunca hace |
|---|---|---|
| **frontend** | Pantallas y navegación. Llama al backend por `/api/*` en el mismo origen. | No toca la BD, ni Redis, ni SUNAT. Sin lógica de negocio. |
| **backend** | Login, permisos, CRUD, encolar trabajos, enviar estado por SSE. | No llama a SUNAT. No descifra credenciales. |
| **worker** | Ejecuta trabajos: SIRE, SOL, XML, archivos, buzones, correos. | No expone HTTP público. |

### El frontend reenvía `/api/*` al backend

```ts
// apps/frontend/next.config.ts (fragmento)
// El navegador llama a /api/*; Next lo reenvía al backend (mismo origen para la cookie).
async rewrites() {
  const backend = process.env.BACKEND_URL ?? "http://localhost:4000";
  return [{ source: "/api/:path*", destination: `${backend}/:path*` }];
},
```

El navegador cree que habla con un solo sitio (`localhost:3000`). Eso permite que la cookie de sesión viaje sin configuraciones de CORS riesgosas (ver [07 · Seguridad](07-seguridad-cifrado-y-sesiones.md)).

## 4. Los paquetes compartidos

| Paquete | Qué contiene | Ejemplo real |
|---|---|---|
| `shared` | Esquemas **zod**, tipos y permisos que comparten frontend y backend. | `packages/shared/src/trabajos/esquemas.ts` |
| `domain` | Lógica pura: dinero, reglas, texto. Sin base de datos, sin red. | `packages/domain/src/dinero/money.ts` |
| `db` | Tablas (Drizzle), migraciones SQL, `withTenant`, consultas. | `packages/db/src/with-tenant.ts` |
| `crypto` | Cifrar y descifrar credenciales con KEK/DEK. | `packages/crypto/src/descifrado.ts` |
| `queue` | Encolar con outbox, despachador justo, arriendos, BullMQ. | `packages/queue/src/encolado.ts` |
| `sunat` | **Puertos** (interfaces) y **adaptadores** (mock por ahora). | `packages/sunat/src/puertos.ts` |

### Puertos y adaptadores

Un **puerto** dice *qué* se necesita de afuera; un **adaptador** dice *cómo* se hace. Es como un formato de declaración: el formato es fijo, y quién lo llena (tú, un asistente, un sistema) puede cambiar.

```ts
// packages/sunat/src/puertos.ts (fragmento)
/** Puerto de autenticación OAuth del SIRE. Solo el worker lo usa (el backend nunca llama a SUNAT). */
export interface SireAuth {
  obtenerToken(credencial: CredencialSire): Promise<TokenSire>;
}
```

```ts
// packages/sunat/src/mock/sire-auth.mock.ts (fragmento)
/** Adaptador en memoria de `SireAuth` (`SIRE_CLIENT=mock`): tokens deterministas por RUC y llamada. */
export class MockSireAuth implements SireAuth {
```

Hoy todo corre con adaptadores `mock` (variables `SIRE_CLIENT`, `SOL_PORTAL`, `XML_PROVIDER` en `.env.example`). Cuando llegue la fuente XML real, se escribe un adaptador nuevo y la lógica no cambia.

## 5. Por qué el backend nunca llama a SUNAT ni descifra

El backend es la pieza **expuesta a internet**: recibe peticiones de cualquiera. Si tuviera la llave para descifrar claves SOL y alguien encontrara una falla en él, podría sacar las claves de todos los clientes de todos los estudios.

Por eso:

1. **El backend solo cifra** (con la parte pública de la KEK) cuando el contador guarda una clave SOL. Cifrar no permite descifrar.
2. **Solo el worker tiene la parte privada** (`KEK_PRIVATE_KEY_PATH` está marcada en `.env.example` como "Solo apps/worker").
3. **La base de datos lo refuerza**: el rol `contapp_backend` no puede leer la columna con el texto cifrado de la credencial (`docs/03-arquitectura.md` §4.3; detalle en [02](02-postgresql.md) y [07](07-seguridad-cifrado-y-sesiones.md)).
4. **El lint lo vigila**: `eslint.config.mjs` usa `no-restricted-imports` y una regla local `limites/imports-relativos` para que ninguna app importe lo que no debe, ni siquiera con una ruta relativa tramposa como `../../packages/sunat`.

Son cuatro capas: si una falla, las otras siguen protegiendo. A esto se le llama **defensa en profundidad**.

## 6. Diagrama general

```text
                       ┌──────────────────────┐
  Navegador ──HTTPS──► │ apps/frontend :3000  │  Next.js (pantallas)
  (contador)           └──────────┬───────────┘
        ▲                         │ /api/*  (rewrite, misma cookie)
        │ SSE (eventos)           ▼
        │              ┌──────────────────────┐   SQL dentro de withTenant (RLS)
        └───────────── │ apps/backend  :4000  │ ─────────────────────────────┐
                       │ NestJS               │                              │
                       └──────────┬───────────┘                              ▼
                     encola (pista)│ ▲ pub/sub de eventos            ┌──────────────┐
                                  ▼ │                                │ PostgreSQL 17│
                       ┌──────────────────────┐                      │ job_registro │
                       │        Redis         │                      │ cliente, ... │
                       │ colas BullMQ, locks, │                      └──────────────┘
                       │ cupos, eventos       │                              ▲
                       └──────────┬───────────┘                              │
                                  │ toma trabajos                            │
                                  ▼                                          │
                       ┌──────────────────────┐   SQL dentro de withTenant   │
                       │ apps/worker          │ ─────────────────────────────┘
                       │ NestJS + BullMQ      │
                       │ descifra (KEK priv.) │ ──► SUNAT (adaptador mock hoy)
                       └──────────────────────┘
```

## 7. Recorrido de punta a punta

### 7.1 El contador ve sus trabajos (lectura)

1. **Navegador** pide `GET /api/trabajos` a `localhost:3000`.
2. **Next.js** lo reenvía a `http://localhost:4000/trabajos` (rewrite del punto 3).
3. **NestJS** enruta al controlador. El decorador `@SoloEstudio()` exige una sesión con estudio activo:

   ```ts
   // apps/backend/src/modules/trabajos/trabajos.controller.ts:23 (fragmento)
   @Controller("trabajos")
   export class TrabajosController {
     @SoloEstudio()
     @Get()
     listar(@Sesion() sesion: SesionResuelta, @Query() query: Record<string, unknown>) {
       return this.trabajos.listar(sesion, query);
     }
   ```

4. **El servicio** abre `withTenant` con el estudio **de la sesión** (nunca de lo que mande el navegador):

   ```ts
   // apps/backend/src/modules/trabajos/trabajos.service.ts:111 (simplificado)
   listar(sesion, query) {
     const filtros = leerFiltros(query);
     return this.db.withTenant(contextoSesion(sesion), async (tx) => {
       const actor = await actorDe(tx, sesion.usuarioId);
       // ...
       return listarTrabajos(tx, actor.alcance, filtros);
     });
   }
   ```

5. **`withTenant`** (en `packages/db/src/with-tenant.ts:182`) hace `BEGIN`, `SET LOCAL ROLE contapp_backend`, fija `app.tenant_id` y ejecuta la consulta. Detalle en [03 · RLS](03-rls-y-withtenant.md).
6. **PostgreSQL** aplica RLS: aunque la consulta de `listarTrabajos` no dice `WHERE tenant_id = ...`, solo devuelve filas del estudio activo.
7. La respuesta vuelve como JSON al navegador.

### 7.2 Un trabajo: del clic a SUNAT (escritura en segundo plano)

1. **Backend encola** con el patrón *outbox*: primero guarda en la BD, y **solo después del commit** avisa a Redis:

   ```ts
   // apps/backend/src/modules/trabajos/encolador.ts:34
   async encolar(ctx: ContextoEncolar, e: EntradaEncolar): Promise<ResultadoEncolar> {
     const r = await this.db.withTenant(ctx, (tx) => encolar(tx, e));
     if (r.nuevo) await this.publicar(ctx.tenantId, r.trabajo, e);
     return r;
   }
   ```

   La fila nace en `job_registro` con `estado = 'en_cola'`. Si Redis está caído, el trabajo no se pierde: un reconciliador del worker lo repone después.
2. **Redis** guarda una "pista" (aviso de que hay trabajo) y publica el evento `en_cola`, que el backend reenvía al navegador por **SSE**.
3. **El despachador del worker** (`packages/queue/src/despachador.ts`) revisa la BD estudio por estudio (turno rotativo, para que un estudio con 500 trabajos no tape a los demás), reserva cupo en Redis, respeta un lock por RUC y cambia la fila a `ejecutando`. Recién entonces mete el trabajo en la cola de **BullMQ**, que solo transporta `{ jobId, tenantId, tipo }`.
4. **El ejecutor del worker** (`apps/worker/src/trabajos/ejecutor.ts`) toma el job, verifica la fila, obtiene un arriendo para ser el único ejecutor, y llama al procesador. Ahí se descifra la credencial y se usa el puerto de SUNAT (hoy el mock).
5. Al terminar, otra transacción corta pasa la fila a `completado`, `error` o la reprograma (`en_cola` con reintento), y se publica el evento. El navegador se actualiza solo.

> Estado actual (spec 008 hecha): la infraestructura de cola está completa y probada con un tipo de prueba (`prueba.eco` en `packages/queue/src/catalogo.ts`) y procesadores internos (`auth-purgar`, `kek-rotar`). Los trabajos de negocio, como descargar la propuesta SIRE, llegan con las specs 009 y siguientes.

Los detalles de cada paso están en [04 · Redis](04-redis.md), [05 · BullMQ](05-bullmq-y-la-cola.md) y [06 · Backend y SSE](06-backend-nestjs-sse.md).

## 8. Las reglas de CLAUDE.md, explicadas

| Regla | Qué significa | Qué evita |
|---|---|---|
| Nada se implementa sin spec aprobada | Primero se escribe y aprueba qué se hará | Construir algo que no era lo pedido |
| `apps/frontend` solo depende de `packages/shared` | La UI no tiene acceso a BD, Redis ni lógica | Lógica duplicada o secretos en el navegador |
| `apps/backend` nunca llama a SUNAT ni descifra | Ver sección 5 | Robo masivo de claves SOL |
| Lógica de negocio pura en `packages/domain` | Cálculos sin IO, fáciles de probar | Reglas contables enterradas en controladores |
| Todo lo externo detrás de un puerto | SUNAT, XML, storage se cambian por configuración | Depender de que SUNAT esté arriba para probar |
| Montos con `Money`/`decimal.js` y `NUMERIC(14,2)` | Nunca `number` para dinero | Errores de céntimos (ver [02](02-postgresql.md) y [08](08-dinero-y-dominio.md)) |
| Toda consulta de negocio dentro de `withTenant()` | RLS siempre activo | Que un estudio vea datos de otro |
| Nunca registrar ni devolver secretos | Ni en logs, ni en respuestas, ni en exportes | Filtrar claves SOL por un log |
| Adaptadores en `mock` por defecto | El sistema arranca sin tocar SUNAT | Llamadas reales accidentales en desarrollo |
| Conventional Commits, rama `spec/NNN-nombre` | Historial legible por funcionalidad | Commits imposibles de rastrear |
| `*.spec.ts` y `*.adv.spec.ts` | Pruebas normales y adversariales | Mezclar pruebas de diseño con ataques |

## 9. SDD en una página

**SDD (Spec-Driven Development)** significa: cada funcionalidad tiene una carpeta `docs/specs/NNN-nombre/` con tres archivos (ver `docs/04-metodologia.md` §1):

| Archivo | Responde |
|---|---|
| `spec.md` | **Qué** y **por qué**: alcance, criterios de aceptación (CA-1, CA-2…), nivel de riesgo A–D |
| `plan.md` | **Cómo**: archivos, contratos, decisiones (D1, D2…) |
| `tasks.md` | **Pasos**: tareas atómicas, con el rol y modelo que las hace |

El tablero `docs/specs/ESTADO.md` muestra en qué va cada una. Cuando en el código veas comentarios como `(D2, CA-4)` o `H-008-2a-1`, apuntan a una decisión, un criterio de aceptación o un hallazgo adversarial de esa spec. Así cada línea "rara" tiene una razón escrita.

## Impacto en ContApp

- **Sin la separación backend/worker**, una sola falla en la API expondría las claves SOL de todos los estudios.
- **Sin el monorepo**, cambiar un tipo compartido obligaría a publicar versiones y sincronizar tres repositorios.
- **Sin puertos y mocks**, cada prueba dependería de que SUNAT responda, y SUNAT tiene límites de llamadas por RUC.
- **Sin outbox**, un corte de Redis justo después del clic podría dejar un trabajo "fantasma" (en Redis pero no en la BD) o perdido.

## Errores comunes

| Error | Por qué pasa | Cómo se resuelve |
|---|---|---|
| `Cannot find module '@contapp/db'` al correr una app | Los paquetes no están compilados (`dist/` vacío) | `pnpm build` (o `pnpm --filter @contapp/db build`) |
| Importar `@contapp/sunat` desde el backend | Parece cómodo para "probar rápido" | El lint lo rechaza; ese código va en el worker |
| Poner lógica de cálculo en un componente de React | La pantalla "ya tiene los datos" | Va a `packages/domain`; el frontend solo muestra |
| Correr `pnpm test` en la raíz para un cambio pequeño | Corre todo el monorepo, lento | `pnpm --filter <paquete> test` |
| Pensar que el frontend habla con `:4000` directo | En desarrollo funciona, pero rompe la cookie | Siempre por `/api/*` |

## Ejercicios

1. Abre `apps/backend/package.json` y `apps/worker/package.json`. ¿Qué dos paquetes `@contapp/*` tiene el worker que el backend no tiene? ¿Por qué?
2. En `turbo.json`, ¿qué pasaría si quitas `"^build"` de `dependsOn` en la tarea `build`?
3. Sigue el recorrido 7.2 y responde: si Redis se cae justo después del commit de `encolar`, ¿el trabajo se pierde?
4. Ejecuta `pnpm -r ls --depth -1`. ¿Cuántos paquetes tiene el workspace y cuál de ellos no está en `apps/` ni en `packages/`?
5. Busca en el repo la palabra `SoloEstudio` (`Ctrl+Shift+F`). ¿En qué archivo se define y qué crees que hace?

<details>
<summary>Soluciones</summary>

1. `@contapp/crypto` y `@contapp/sunat`. El worker descifra credenciales y habla con SUNAT; el backend no debe poder hacer ninguna de las dos cosas (sección 5).
2. turbo podría compilar una app antes que los paquetes que usa, y fallaría porque `dist/` de esos paquetes aún no existe (o tendría una versión vieja).
3. No. La fila ya está en `job_registro` con `en_cola`. Lo que falla es el aviso a Redis; el encolador no propaga ese error y el reconciliador del worker repone la pista después (comentario en `apps/backend/src/modules/trabajos/encolador.ts`).
4. Las apps, los seis `packages/*` y los de `tests/*` (`tests/aislamiento` y `tests/limites`), además de la raíz. Los de `tests/` no son ni apps ni paquetes: son pruebas transversales.
5. Es un decorador del módulo de acceso del backend; marca rutas que exigen una sesión con un estudio activo (si no hay estudio, se responde error). Se ve junto con los guards en [06](06-backend-nestjs-sse.md).

</details>

## Para profundizar

- pnpm workspaces: <https://pnpm.io/workspaces>
- Turborepo, configuración de tareas: <https://turborepo.com/docs/reference/configuration>
- Arquitectura hexagonal (puertos y adaptadores), artículo original de Alistair Cockburn: <https://alistair.cockburn.us/hexagonal-architecture/>
