# 15 · Pruebas E2E: la app completa en un navegador real

> Módulo anterior: [14-auditoria-y-notificaciones.md](14-auditoria-y-notificaciones.md) · Índice: [00-indice.md](00-indice.md)
>
> Cubre la spec **018** (pruebas E2E de R1 con Playwright) y, al final, la **020** (deuda técnica de R1). Complementa el [09](09-pruebas-y-calidad.md): allí están SDD, TDD, integración, adversariales y cobertura; aquí solo lo que agrega la E2E.

## Lo que aprenderás

- Qué es una prueba **E2E** y en qué se diferencia de una unitaria o de integración.
- Por qué se eligió **Playwright** y solo **Chromium**.
- Cómo la E2E levanta **su propia pila**: BD `contapp_e2e`, Redis índice 14, backend y worker desde `dist`, `next start` y correo.
- Los flujos **E-01 a E-11** y el flujo de volumen `@volumen`.
- Cómo se escribe una prueba, leyendo un flujo real.
- Qué es una prueba **intermitente** (*flaky*) y cómo se demostró que la suite no lo es.
- El job `e2e` del CI, la caché de Chromium y el artefacto `e2e-fallos`.
- Los defectos de servidor que solo la E2E encontró, y la lección que dejan.
- La spec 020: pruebas de tiempo con mediana, hora de Lima y SHA-256 completo.

---

## 1. Revisar un asiento o auditar el cierre completo

En el módulo 09 viste tres tipos de prueba. Con la E2E (*end-to-end*, de punta a punta) son cuatro:

| Tipo | Qué revisa | Analogía contable |
|---|---|---|
| Unitaria (`*.spec.ts`) | Una función sola, sin BD ni red | Revisar que un asiento cuadre |
| Integración (`*.int.spec.ts`) | Un módulo con PostgreSQL y Redis reales | Revisar que el libro diario pase bien al mayor |
| Adversarial (`*.adv.spec.ts`) | Lo que haga falta para romperlo | El auditor externo buscando el fraude |
| **E2E** (`*.e2e.ts`) | Un navegador que hace clic como el contador, con frontend, backend, worker, cola, BD y correo encendidos | **Auditar el proceso de cierre completo**: desde el comprobante hasta la DJ presentada |

Un asiento puede cuadrar y el cierre salir mal igual: por ejemplo, si nadie pasó el asiento al mayor a tiempo. Con el software pasa lo mismo. Cada pieza de ContApp tiene sus pruebas, pero **entre** las piezas hay huecos: el backend encola, el worker toma el trabajo, avisa por Redis, el backend lo reenvía por SSE y la pantalla se actualiza. La E2E es la única prueba que recorre todo ese camino a la vez.

El costo es que es la prueba más lenta y la más frágil. Por eso no reemplaza a las otras: se usa para los **recorridos de usuario** (historias HU-xx) y las reglas finas se siguen probando con unitarias.

## 2. Playwright y solo Chromium

**Playwright** es una librería de Microsoft que controla un navegador real desde código: abre páginas, escribe en campos, hace clic y comprueba lo que se ve. Trae su propio ejecutor de pruebas (`@playwright/test`), parecido a Vitest: `test(...)` define un caso y `expect(...)` afirma.

Decisiones de la spec 018 (`docs/specs/018-e2e-r1/spec.md`):

- **D-1**: paquete propio `tests/e2e` (`@contapp/tests-e2e`) con `@playwright/test` fijado en versión exacta, `1.63.0` (`tests/e2e/package.json:21`). `apps/frontend` no gana dependencias.
- **P-4 → (a) solo Chromium**: cubre Chrome y Edge, que es lo que usa un estudio en escritorio. Firefox y WebKit duplicarían el tiempo del CI.
- **D-7**: sin reintentos, viewport 1440×900, idioma `es-PE` y zona `America/Lima`.

`tests/e2e/playwright.config.ts:19-40` (fragmento; el `contexto` de las líneas 9-17 fija 1440×900, `es-PE`, `America/Lima`, trazas y capturas al fallar):

```ts
export default defineConfig({
  testDir: "./flujos",
  testMatch: "**/*.e2e.ts",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: CI,
  retries: 0,
  workers: CI ? 2 : 4,
  // … reporter list + html
  globalSetup: "./soporte/pila/global-setup.ts",
  globalTeardown: "./soporte/pila/global-teardown.ts",
  use: contexto,
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...contexto } },
  ],
});
```

Tres líneas importan mucho: `retries: 0` (una prueba que falla no se repite hasta que pase: sección 6), `forbidOnly: CI` (un `test.only` olvidado hace fallar el CI en vez de saltarse el resto) y `trace: "retain-on-failure"` (si falla, queda una **traza**: una grabación paso a paso con DOM, red y consola).

## 3. La pila propia de la E2E

La E2E no usa tu entorno de desarrollo: arma uno nuevo en cada corrida y lo borra al final. Así ninguna corrida hereda basura de la anterior. Los puertos y el nombre de la BD están en `tests/e2e/soporte/pila/entorno.ts:14-20` (`PUERTO_FRONTEND = 3210`, `PUERTO_BACKEND = 4210`, `BD_E2E = "contapp_e2e"`, con el comentario «Nunca es `contapp` (la de desarrollo)»).

| Pieza | Cómo la levanta la E2E | Por qué |
|---|---|---|
| PostgreSQL | BD nueva `contapp_e2e`, migrada **dos veces** y sembrada | Parte de cero; la doble migración prueba que las migraciones se pueden repetir |
| Redis | Índice **14** (`E2E_REDIS_DB`), vaciado al arrancar | El 0 es el de desarrollo (se rechaza) y el 15 es de las pruebas de integración de 008 |
| Backend | `node dist/main.js` en el puerto **4210** | No tiene script `start`; se usa lo compilado, como en producción |
| Worker | `node dist/main.js`, sin puerto | Está listo cuando BullMQ lista al menos un worker |
| Frontend | `next build` y `next start -p 3210` | Igual que en producción, no el modo `dev` |
| Correo | Mailpit en CI, o `E2E_CORREO=consola` | Para leer el enlace de registro o de invitación |

Los puertos 3210 y 4210 son propios para no chocar con `pnpm dev`. Todos los adaptadores van en `mock` (`entorno.ts:133-137`: `SIRE_CLIENT`, `SOL_PORTAL`, `RUC_CLIENT`, `XML_PROVIDER` y `KEY_PROVIDER`), así que **ninguna prueba toca SUNAT**.

El arranque lo hace el `globalSetup`, que corre una sola vez antes de toda la suite. `tests/e2e/soporte/pila/global-setup.ts:82-86` y `:128-134` (fragmento):

```ts
    await ejecutarCliDb("migrar", env);
    await ejecutarCliDb("migrar", env);
    await ejecutarCliDb("seed", env);
    await quitarEsperaPorRuc(config.urlMigraciones);
    await vaciarIndiceRedis(config.urlRedis);
    // … arranca backend, worker y frontend …
    await Promise.all([
      esperarListo(backend, () =>
        respondeCon(`${URL_BACKEND}/auth/sesion`, 401),
      ),
      esperarWorker(worker, config.urlRedis),
      esperarListo(frontend, () => respondeCon(`${URL_FRONTEND}/login`, 200)),
    ]);
```

Fíjate cómo sabe que el backend está listo: no hay ruta de salud, así que pregunta por la sesión y espera un **401** (no has entrado). Un 401 aquí es buena noticia: el backend responde. Y `quitarEsperaPorRuc` pone `espera_ruc_ms = 0` **solo** en `contapp_e2e` (desvío 2 ratificado en `plan.md`): la pausa de 2 s por RUC es una cortesía con SUNAT, y con mocks no hay a quién cuidar.

¿Por qué el correo? El alta (E-01) y la invitación (E-02) llegan por un enlace en un correo. **Mailpit** es un servidor SMTP de pruebas que guarda los correos y los muestra por una API; la prueba busca el correo del destinatario y saca el enlace. Sin Docker, `E2E_CORREO=consola` hace que el backend escriba el correo en su salida, que queda en `<tmp>/backend.log`.

Al terminar, el `globalTeardown` apaga los procesos (SIGTERM y, a los 10 s, SIGKILL) y borra `contapp_e2e`, salvo con `E2E_CONSERVAR_BD=1` (útil para investigar un fallo).

## 4. Los flujos E-01 a E-11

Cada flujo tiene al menos un caso feliz y uno de error (CA-2). El mapa está en `docs/specs/018-e2e-r1/tasks.md`; los conteos son los de `playwright test --list` (Práctica A): 89 pruebas, 87 en la suite normal y 2 con la etiqueta `@volumen`.

| Flujo | Archivo (`tests/e2e/flujos/`) | Qué recorre | Pruebas |
|---|---|---|---|
| E-01 | `alta.e2e.ts` | Registro → enlace por correo → contraseña → panel; login erróneo con mensaje único | 7 |
| E-02 | `equipo.e2e.ts` | Invitar, aceptar, asignar cliente, rol `lectura`, cambiar de estudio | 8 |
| E-03 | `clientes.e2e.ts` | Alta con RUC mock, CSV, credenciales que nunca se muestran, «Inválida», tope del plan | 11 |
| E-04 | `descarga-compras.e2e.ts` | Descargar 202610 → «En cola» → «5 nuevas»; RUC …68 falla; 409 sin credenciales | 3 |
| E-05 | `grilla-compras.e2e.ts` | Filtros, edición con teclado, masiva, Ctrl+Z, conflicto con otra sesión, Excel | 14 |
| E-06 | `volumen.e2e.ts` (`@volumen`) | 5.000 compras: primeras filas < 2 s y Ctrl+Z de la masiva ≤ 10 s | 2 |
| E-07 | `lupa.e2e.ts` | Lupa XML con teclado, R-MIX y R-ISC (San Juan), «XML no disponible» | 7 |
| E-08 | `archivo.e2e.ts` | Previo con error → corregir → generar → bajar el ZIP con su SHA-256 | 5 |
| E-09 | `ventas.e2e.ts` | RVIE mock, «Falta B001-291», excluir con motivo, USD sin TC | 5 |
| E-10 | `notificaciones.e2e.ts` | Campana en vivo, marcar leídas, auditoría con autor | 10 |
| E-11 | `aislamiento.e2e.ts` | El estudio B abre URLs de A y recibe «no encontrado», igual que un id inexistente | 5 |
| — | `humo.e2e.ts` y `soporte.e2e.ts` | La pila levanta; las utilidades de soporte funcionan | 1 + 11 |

**`@volumen`** es una etiqueta que se pone al `describe`: `test.describe("E-06 volumen", { tag: "@volumen" }, () => {` (`tests/e2e/flujos/volumen.e2e.ts:67`). Sembrar 5.000 compras y medir tiempos es lento, así que no corre en cada PR (P-5): `pnpm e2e` la excluye con `--grep-invert @volumen` y `pnpm e2e:volumen` corre solo esa (`tests/e2e/package.json:7-8`). Los dos tiempos quedan como **anotación** en el reporte (`volumen.e2e.ts:48-50`), y el Ctrl+Z que antes tardaba ~7 s quedó medido en 1,3 a 1,9 s (nota [rendimiento] de `ESTADO.md`).

E-11 merece una mención: es la versión «en pantalla» del aislamiento RLS del módulo 03. Un usuario del estudio B pega en su navegador la URL de un cliente, una compra o un ZIP del estudio A, y la respuesta tiene que ser **idéntica** a la de un id que no existe (CA-7). Si dijera «no tienes permiso», ya estaría confirmando que ese id existe.

## 5. Cómo se escribe una prueba E2E

Este es el caso feliz de E-04. `tests/e2e/flujos/descarga-compras.e2e.ts:22-57` (fragmento):

```ts
test("descarga 202610: en cola, «5 nuevas» y la grilla se actualiza sola", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.contribuyente,
  });
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);
  await api(sesion).cargarCredenciales(cliente.id);

  await page.goto(rutaCompras(cliente.id, PERIODO));
  // …
  await expect(filasDeCompras(page)).toHaveCount(0);

  const descargar = page.getByRole("button", { name: "Descargar", exact: true });
  // … (comentario T11b)
  const retencion = await retenerRuc("sire", RUCS.contribuyente);
  try {
    await descargar.click();
    await expect(estado(page, "En cola · posición 1")).toBeVisible();
  } finally {
    await retencion.soltar();
  }

  // Sin recargar la página: la descarga termina y la grilla pide sola el listado (D-1 de 015, CA-8).
  await expect(page.getByText("5 nuevas, 0 distintas")).toBeVisible({
    timeout: TOPE_TRABAJO_MS,
  });
  await expect(filasDeCompras(page)).toHaveCount(4);
  await expect(estado(page, "4 compras cargadas")).toBeVisible();
  // …
```

Léelo en cuatro bloques:

1. **Preparar** (*arrange*). `siembra`, `sesiones` y `api` son **fixtures**: utilidades que Playwright entrega a cada prueba (`tests/e2e/soporte/fixtures.ts`). Cada prueba crea **su propio estudio** por SQL, con correos únicos, así que las pruebas no se pisan aunque corran 4 a la vez. La sesión se abre por la API, no tecleando en el login: así no se agota el límite de 20 intentos por IP cada 10 minutos (D-4). Solo E-01 y E-02 hacen el alta por la pantalla, porque eso es justo lo que prueban.
2. **Mirar el estado inicial**: la grilla tiene 0 filas.
3. **Actuar**: clic en «Descargar». Se busca el botón **por su rol y su nombre** (`getByRole("button", { name: "Descargar" })`), como lo encontraría un lector de pantalla, y no por una clase CSS que cambia con cualquier rediseño (D-6). Los pocos selectores CSS viven solo en `soporte/selectores/`.
4. **Comprobar el resultado**, sin recargar: el texto «5 nuevas, 0 distintas» y la grilla llena. Esto prueba la cadena entera: backend → cola → worker → SIRE mock → BD → aviso por Redis → SSE → pantalla.

Fíjate que **no hay ninguna espera fija** («espera 3 segundos»). `await expect(...).toBeVisible()` es una aserción *web-first*: Playwright reintenta la comprobación hasta que se cumple o vence el tope (aquí `TOPE_TRABAJO_MS = 30_000`, `descarga-compras.e2e.ts:20`). Si el trabajo tarda 200 ms, la prueba sigue a los 200 ms; si tarda 31 s, falla.

**¿Y `retenerRuc`?** El estado «En cola» dura lo que tarda el siguiente ciclo del despachador (0 a 500 ms) y podía no llegar a pintarse. La prueba toma el **lock del RUC** en Redis, igual que lo haría el despachador (`tests/e2e/soporte/cola.ts:24-28`). Mientras lo tiene, el trabajo no puede salir de la cola, así que «En cola · posición 1» se ve siempre. Después lo suelta y la descarga sigue. Es una forma de volver determinista algo que dependía del reloj.

### La vigilancia: un auditor en cada prueba

Además de lo que cada prueba afirma, un fixture automático (`tests/e2e/soporte/vigilancia.ts`, D-8) revisa **todas** las respuestas `/api`, la consola y el DOM final. Hace fallar la prueba si aparece alguno de los valores de credenciales de fixture (`USUPRUEBA`, `CLAVEPRUEBA`, `CIDPRUEBA`, `CSECPRUEBA`), si `window.__pwn` quedó definido (un `<img onerror>` metido en una razón social se ejecutó: XSS) o si hay un error de consola que la prueba no declaró con `vigilancia.permitirError(...)`. Es la regla «nunca devolver secretos» de CLAUDE.md, comprobada en cada clic.

## 6. Intermitencia: cuando la prueba falla «a veces»

Una prueba **intermitente** (*flaky*) pasa o falla con el mismo código. La salida fácil es reintentarla hasta que pase. La spec 018 la prohíbe (CA-4): `retries: 0`, y **un fallo intermitente es un defecto**, no se marca `fixme` ni se reintenta. Es la misma idea del módulo 09, sección 8: antes de culpar a la prueba hay que averiguar si falla el código o la medición.

¿Cómo se demuestra que una suite es estable? Corriéndola muchas veces, en paralelo y con carga:

```bash
pnpm e2e --trace off --repeat-each=3 --workers=4
```

`--repeat-each=3` corre cada prueba 3 veces y `--workers=4` usa 4 navegadores a la vez. Con 86 pruebas en ese momento eran 258 ejecuciones por corrida. Evidencia (T11, tercera verificación, `docs/specs/018-e2e-r1/tasks.md`): **3 corridas seguidas con 258 pasan y 0 fallos** (2,2 a 2,3 min cada una), sin `fixme`. Antes de llegar ahí hubo dos verificaciones fallidas, y cada fallo terminó en una causa concreta: de la prueba (tipo a) o de la app (tipo c).

En el CI se pidieron 3 corridas seguidas en verde. Según `ESTADO.md`, el job `e2e` salió verde en las corridas `workflow_dispatch` 465, 470, 473 y 475.

La higiene también se comprueba con `grep` (CA-5): sin `waitForTimeout`, sin `setTimeout` como espera y sin `test.only` (Práctica B).

## 7. El job del CI

`.github/workflows/ci.yml` tiene un tercer job, `e2e` («E2E de R1 (Playwright, Chromium y Mailpit)», `ci.yml:165-260`). Corre en los `pull_request`, en los `push` a `main` y a mano con `workflow_dispatch` (P-1, `ci.yml:168`). Levanta como servicios `postgres:17`, `redis:7` y `axllent/mailpit:v1.33.0`, genera la contraseña de `contapp_app` en cada corrida (enmascarada, como el job `aislamiento` del módulo 09) y tiene un tope de 20 minutos.

`.github/workflows/ci.yml:236-260` (fragmento; entre medio, instalar Chromium, `pnpm e2e` y, solo en `main` o a mano, `pnpm e2e:volumen`):

```yaml
      - name: Caché de Chromium (por versión de Playwright)
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ steps.playwright.outputs.version }}-chromium
      # …
      - name: Reporte y trazas de la E2E (solo si falla, 7 días)
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-fallos
          path: |
            tests/e2e/playwright-report/
            tests/e2e/test-results/
          retention-days: 7
```

- **Caché de Chromium**: así no se baja el navegador en cada corrida. La clave lleva la versión exacta de Playwright (un paso anterior, `ci.yml:229-234`, la lee de `tests/e2e/package.json` y falla si no es exacta). Mientras la versión no cambie, no se vuelve a bajar.
- **`e2e-fallos`**: solo si algo falla (`if: failure()`) se suben el reporte HTML y las trazas por 7 días. Bajas el artefacto, abres la traza y ves exactamente qué vio el navegador. Las trazas solo llevan datos de fixture, nunca secretos reales.
- **`pnpm e2e`** compila antes de correr (`e2e:build`, `tests/e2e/package.json:9`): turbo compila backend, worker y sus paquetes, y el `next build` del frontend va aparte, con `BACKEND_URL=http://localhost:4210` fijado al compilar.

Para que el job **bloquee** el merge falta marcarlo como check requerido en la protección de `main`. Es un ajuste de GitHub que hace el usuario (nota [usuario] de `ESTADO.md`).

## 8. Lo que la E2E encontró entre las piezas

Esta es la parte más valiosa de la 018. Todas las piezas tenían sus pruebas unitarias, de integración y adversariales en verde, y aun así la E2E encontró defectos reales **en las uniones**. Por P-6, los defectos de servidor se escalaban, y el usuario decidió corregirlos dentro de 018.

**a) La carrera del despachador (T11c).** Síntoma: en `descarga-compras.e2e.ts`, a veces, el «Reintentar» después de un error no terminaba en 30 s. La traza mostró un trabajo que empezó ~59 s después de crearse, con la cola libre. Causa (`docs/specs/018-e2e-r1/tasks.md`, T11b): cuando el despachador veía que un estudio ya no tenía pendientes, después del commit borraba la lista del estudio (`SREM` + `DEL`). Si **justo entre** esa lectura y el borrado el backend encolaba un trabajo nuevo del mismo estudio, el borrado se lo llevaba y el trabajo quedaba invisible hasta que el reconciliador lo reponía: de 30 a 60 s de espera. Es otra carrera *check-then-act*, como la del dedupe del módulo 09. Solo aparecía cuando un estudio vaciaba su cola y encolaba enseguida, que es justo lo que hace un usuario al pulsar «Reintentar».

La corrección (`packages/queue/src/despachador.ts`, `cerrarEstudioVacio`) relee y vuelve a publicar en vez de borrar a ciegas. La revisó el adversario con 12 pruebas, que encontraron dos hallazgos más (`ESTADO.md`):

- **H-018-1 (baja)**: el cierre de un estudio vacío borraba la pista de un reintento que tenía el mismo id. Corregido en `c0c8441` releyendo en la BD y volviendo a publicar los que ya están `en_cola`.
- **H-018-2 (media)**: el reconciliador re-encolaba un trabajo `ejecutando` vencido solo con `SADD`, sin `ZADD`, y el cierre del estudio lo perdía. Corregido en `c0c8441`: el reconciliador usa `publicar`.

**b) El evento «terminado» perdido (T11e).** Síntoma: en `archivo.e2e.ts`, a veces, la pantalla no se enteraba de que el archivo ya estaba generado. La pantalla primero **listaba** los trabajos y luego **abría el stream SSE**. Si el trabajo terminaba entre esos dos pasos, el aviso salía cuando nadie escuchaba todavía, y el listado ya era viejo. La corrección invierte el orden: primero se abre el stream y luego se lista. `apps/frontend/lib/trabajos.ts:207-224` (fragmento):

```ts
        // Se abre y se espera antes de listar (T11e). El backend manda el primer byte `: conectado` solo cuando la
        // conexión ya está registrada y suscrita, y Next entrega las cabeceras con ese byte: al resolver `fetch`,
        // todo evento posterior queda en el flujo. […]
        abierto = fetch("/api/trabajos/stream", {
          // … method, credentials, headers, signal
        }).catch(() => null);
        // …
        await esperarConTope(abierto, TOPE_ESPERA_STREAM_MS, senal);
```

El backend también cambió (`stream.service.ts`): manda el primer byte solo cuando la suscripción a Redis ya está confirmada.

**c) El 401 al cambiar de estudio (T11a).** Al cambiar de estudio la sesión rota, y una petición que ya había salido con la cookie vieja recibía 401 y mandaba al usuario al login. Se corrigió en el frontend: ante un 401 se comprueba la sesión y se reintenta **una sola vez** (`apps/frontend/lib/api.ts`).

**La lección.** Ninguno de estos defectos estaba dentro de una pieza: estaban **entre** dos piezas (backend y despachador, worker y SSE, rotación de sesión y pantalla). Las pruebas de cada pieza eran correctas y pasaban. Como en una auditoría, cada área puede tener sus papeles en orden y el cierre fallar en el traspaso de una a otra. Para eso existe la E2E. Y fíjate en que se encontraron porque se prohibió reintentar: con `retries: 2` estos tres defectos seguirían en producción.

## 9. La spec 020: pagar la deuda de R1

Antes de empezar R2, la 020 cerró las notas abiertas de `ESTADO.md` (nivel C, decisiones P-1 a P-7, todas en la opción recomendada). Los puntos más didácticos:

**Pruebas de tiempo estables (DT-1).** Cuatro pruebas de integración que medían tiempos fallaban a veces en el CI. Por ejemplo, CA-15 de compras: 2,45 s frente a un límite de 2 s, con **cobertura** activada. La cobertura (módulo 09, sección 6) instrumenta el código y lo vuelve más lento, así que medir tiempos con ella era medir con un reloj trucado. Solución (P-4): con `CONTAPP_COBERTURA=1` la parte funcional corre pero el tiempo **no se compara**, y sin instrumentar se toma la **mediana** de varias muestras. `apps/backend/test/tiempos.ts:5-14`:

```ts
/** `CONTAPP_COBERTURA=1` lo fijan solo los `vitest.cobertura*.config.mts`: la instrumentación v8 encarece el tiempo. */
export const BAJO_COBERTURA = process.env.CONTAPP_COBERTURA === "1";

/** Mediana de `n` muestras tomadas en serie; `muestra` devuelve los ms de su ejecución. */
export async function medirMediana(muestra: () => Promise<number>, n: number): Promise<number> {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) ms.push(await muestra());
  ms.sort((a, b) => a - b);
  return ms[Math.floor(ms.length / 2)] ?? 0;
}
```

¿Por qué la mediana y no el promedio? Porque una sola muestra lenta (el CI ocupado un instante) dispara el promedio, pero no mueve la mediana. Es como evaluar el tiempo de cierre de un estudio con el mes típico y no con el mes del incendio. Uso real: `apps/backend/src/modules/compras/lectura.int.spec.ts:491-498` mide 3 veces el listado de 5.000 filas, sale con `return` si `BAJO_COBERTURA` y si no exige `toBeLessThan(2000)` sobre la mediana.

Lo importante: **los límites no se subieron** (CA-2: 2 s, 5 s y la tolerancia de CA-8 siguen igual) y no se puso ningún `retry`. Para demostrar que la prueba de CA-8 de auth (que vigila que nadie descubra qué correos tienen cuenta midiendo cuánto tarda la respuesta) sigue sirviendo, se agregó una prueba que **inyecta 20 ms** solo cuando la cuenta existe y exige que la comparación lo detecte (`apps/backend/src/modules/auth/auth.r1b.adv.int.spec.ts:318-338`). Es probar la alarma activándola a propósito.

**Hora de Lima en toda la app (DT-5, P-3).** La lupa y el Historial mostraban horas en UTC: 5 horas adelantadas. Ahora toda fecha con hora pasa por una sola función, `apps/frontend/lib/fechas.ts:12-16`:

```ts
/** «2026-11-11T17:28:00.000Z» → «11/11/26, 12:28 p. m.» (hora de Lima). */
export function fechaHoraLima(iso: string): string {
  const fecha = new Date(iso);
  return Number.isNaN(fecha.getTime()) ? "—" : FORMATO_FECHA_HORA.format(fecha);
}
```

Las fechas sin hora (emisión, periodo, vencimiento) se formatean desde el texto `AAAA-MM-DD`, sin pasar por `Date`, para que un comprobante del 20/10 nunca aparezca como del 19/10 (P-7, `fechaCorta` en el mismo archivo).

**Versiones de archivo más claras (DT-6).** Cada versión muestra autor, fecha en hora de Lima y el **SHA-256 completo** del ZIP (no recortado: la huella sirve justo para compararla entera, módulo 10). Las versiones anteriores se descargan con el sufijo `_vN` para no sobrescribirse en tu carpeta de descargas (`apps/frontend/lib/archivos.ts:266-267`, P-6); la última conserva el nombre del servidor.

**Lo demás**, en una línea cada uno: `restaurarConfig` de las pruebas repone las cuatro colas (DT-2); la ficha del cliente pasa sola de «Verificando…» a «Verificada» o «Inválida» con texto en español (DT-3); «Cancelar» solo aparece a quien puede cancelar; el panel «Generar archivo» ya no tapa columnas (DT-4); si el stream tarda más de 3 s, el panel vuelve a listar una vez (DT-7, cierra el riesgo que dejó T11e); y la migración 0046 valida el CHECK de milisegundos de `notificacion` (DT-8).

Quedó **fuera**, a propósito (P-1, P-2): el `ZRANGE 0 -1` del despachador (va a la spec de rendimiento) y la purga de auditoría a 5 años (spec de retención, fecha límite 2031).

## Práctica

**A. Listar las pruebas sin levantar la pila** (ejecutado aquí). Hace falta instalar el paquete y compilar `shared`, `db` y `queue`, que los fixtures importan desde `dist`:

```bash
pnpm install --frozen-lockfile --filter "@contapp/tests-e2e..."
pnpm --filter "@contapp/tests-e2e^..." run build
pnpm --filter @contapp/tests-e2e exec playwright test --list
# Listing tests:
#   …
#   [chromium] › descarga-compras.e2e.ts:22:1 › descarga 202610: en cola, «5 nuevas» y la grilla se actualiza sola
#   …
# Total: 89 tests in 13 files

cd tests/e2e
pnpm exec playwright test --list --grep-invert @volumen | tail -1
# Total: 87 tests in 12 files
pnpm exec playwright test --list --grep @volumen | tail -1
# Total: 2 tests in 1 file
```

`--list` no ejecuta el `globalSetup`, así que no necesita PostgreSQL ni Redis. (En este contenedor pnpm avisa `Unsupported engine` porque hay Node 22 y el proyecto pide Node 24; para listar no importa.)

**B. Revisar la higiene de CA-5** (ejecutado aquí, desde la raíz):

```bash
grep -rnE "waitForTimeout|setTimeout|test\.only" tests/e2e --include=*.ts --exclude-dir=node_modules
# tests/e2e/flujos/archivo.e2e.ts:41:test.setTimeout(90_000);
# tests/e2e/flujos/volumen.e2e.ts:73:    test.setTimeout(180_000);
# tests/e2e/flujos/volumen.e2e.ts:170:    test.setTimeout(120_000);
# tests/e2e/flujos/lupa.e2e.ts:33:test.setTimeout(90_000);
grep -rnlE "locator\(['\"][.#\[/]|xpath=" tests/e2e --include=*.ts --exclude-dir=node_modules
# tests/e2e/soporte/selectores/compras.ts
```

Los cuatro resultados son `test.setTimeout`: el tope de tiempo de una prueba, no una espera. El único selector CSS está en `soporte/selectores/`, donde debe estar.

**C. Correr la suite** (no ejecutado aquí: necesita PostgreSQL 17, Redis, Node 24 y el build completo de backend, worker y frontend):

```bash
pnpm servicios:up                 # PostgreSQL, Redis y Mailpit con Docker
pnpm e2e                          # compila, levanta la pila y corre todo menos @volumen
pnpm e2e:volumen                  # solo E-06
E2E_CORREO=consola pnpm e2e       # sin Docker: correo en <tmp>/backend.log
pnpm --filter @contapp/tests-e2e exec playwright test flujos/humo.e2e.ts   # un archivo, con la pila ya compilada
```

**D. Abrir un reporte o una traza** tras un fallo (no ejecutado aquí). Sirve igual con el artefacto `e2e-fallos` bajado del CI:

```bash
pnpm --filter @contapp/tests-e2e exec playwright show-report
pnpm --filter @contapp/tests-e2e exec playwright show-trace test-results/<carpeta>/trace.zip
```

## Impacto en ContApp

- Cada PR recorre las historias de R1 en un navegador real antes de entrar a `main`. Una regresión en cualquier capa sale en el CI y no en la próxima demo con un cliente.
- Tres defectos de servidor que ninguna prueba aislada veía (trabajos invisibles 30 a 60 s, avisos perdidos y el 401 al cambiar de estudio) se corrigieron antes de que los viera un contador.
- En cada prueba se comprueba que ninguna credencial de fixture se filtra a la pantalla, a la API ni a la consola, y que una razón social maliciosa no ejecuta código.
- Una corrida roja del CI ahora significa un defecto real (020): ya no hay pruebas de tiempo que fallen por el azar de la carga.
- El contador ve horas de Lima en toda la app y puede comparar el SHA-256 completo de cada versión de archivo.

## Errores comunes

- **«La prueba falla a veces: le pongo `retries: 2`.»** No. `retries: 0` es una decisión (CA-4): un fallo intermitente se investiga con la traza. Tres defectos reales salieron así.
- **«Agrego `page.waitForTimeout(3000)` y ya pasa.»** Una espera fija es lenta cuando sobra y falla cuando falta. Usa una aserción *web-first* (`await expect(...).toBeVisible()`) con un tope.
- **«Busco el botón por `.btn-primary`.»** Busca por rol y nombre (`getByRole`). Si de verdad no hay nombre accesible, el selector va en `soporte/selectores/`.
- **«`pnpm e2e` dice que el puerto 3210 está ocupado.»** Quedó una corrida anterior viva u otro proceso usa el puerto. Ciérralo; si quedó la BD, `DROP DATABASE contapp_e2e WITH (FORCE);` (README de `tests/e2e`).
- **«Mi prueba usa el estudio que creó otra prueba.»** Cada prueba crea el suyo. Si dependes de otra, fallará con `--repeat-each` o con otro número de workers.
- **«La prueba de tiempo falló en el CI: subo el límite.»** No (020, CA-2). Si la mediana sin cobertura pasa del límite, es un defecto de rendimiento y se escala.

## Ejercicios

1. ¿Por qué la E2E usa `contapp_e2e` y el índice 14 de Redis en vez de la BD `contapp` y el índice 0 de tu `pnpm dev`?
2. En `descarga-compras.e2e.ts`, ¿qué pasaría con la línea de «En cola · posición 1» si se quitara `retenerRuc`?
3. Un usuario del estudio B abre la URL del ZIP de un cliente del estudio A. ¿Qué debe responder la app y por qué no «403 sin permiso»?
4. Con `retries: 2`, la carrera del despachador (T11c) probablemente no se habría descubierto. ¿Por qué?
5. En la 020, ¿por qué no basta con multiplicar por 3 el límite de tiempo cuando la cobertura está activa?

<details><summary>Soluciones</summary>

1. Para partir de cero en cada corrida y no tocar tus datos: el `globalSetup` crea, migra y siembra `contapp_e2e` y vacía el índice 14, y el `globalTeardown` la borra. El índice 0 es el de desarrollo (`leerConfig` lo rechaza) y el 15 es de las pruebas de integración de 008 (D-3, desvío 1 de `plan.md`).
2. Sería intermitente: «En cola» dura hasta el siguiente ciclo del despachador (0 a 500 ms) y a veces el trabajo saldría de la cola antes de que la pantalla lo pintara. Con el lock del RUC retenido, el trabajo no puede salir hasta que la prueba lo suelte (T11b).
3. Lo mismo que con un id inexistente: «no encontrado» (404), sin datos de A en el DOM ni en las respuestas (CA-7, E-11). Un 403 confirmaría que el id existe en otro estudio.
4. Porque el trabajo quedaba invisible 30 a 60 s y luego el reconciliador lo reponía: en un reintento la prueba probablemente habría pasado y el fallo se habría tomado por «inestabilidad». Con `retries: 0` el fallo quedó a la vista, y la traza mostró un trabajo que empezó ~59 s después de crearse.
5. Porque un factor fijo es adivinar cuánto encarece la cobertura, y con carga del CI puede no alcanzar (o esconder una lentitud real). La 020 separa las dos cosas: bajo cobertura la prueba comprueba el funcionamiento y no compara el tiempo; sin instrumentar compara la mediana de varias muestras contra el límite original (P-4, CA-2, CA-3).

</details>

## Para profundizar

- Specs del proyecto: [018 spec](../specs/018-e2e-r1/spec.md) y [020 spec](../specs/020-deuda-r1/spec.md), con sus `plan.md` y `tasks.md` (T11, T11b y T11c de la 018 cuentan la investigación completa de los fallos).
- `tests/e2e/README.md`: cómo correr con y sin Docker, variables y trazas.
- `docs/specs/ESTADO.md`: filas de 018 y 020 y los hallazgos H-018-1 y H-018-2.
- Playwright, buenas prácticas: <https://playwright.dev/docs/best-practices>
- Localizadores: <https://playwright.dev/docs/locators>
- Visor de trazas: <https://playwright.dev/docs/trace-viewer>
- Mailpit: <https://mailpit.axllent.org/>
