# Spec 018 · Pruebas E2E de R1

Estado: hecha (2026-11-12; CA-3 y CA-11 quedan pendientes de CI, los cierra el orquestador). Aprobada el 2026-11-12 (el usuario eligió la opción recomendada en P-1 a P-6, ver «Decisiones del usuario»). Rama `spec/018-e2e-r1`. Plan: `plan.md` · tareas: `tasks.md`.
Nivel de riesgo: **C**, según el tablero. Por §2.1: (1) no, porque no cambia el cálculo de montos ni el armado de archivos: solo los observa; (2) no, porque no agrega superficie: comprueba el aislamiento que ya existe; (3) no; (4) sí, porque recorre cola, SSE, worker y varias sesiones a la vez, y eso vuelve inestables las pruebas si no se diseñan bien. Ese riesgo lo cubren CA-4 y CA-5.
Cubre: HU-01, 03, 04, 06 a 12, 14 a 18, 20 a 26 · RF-042, RF-150, RF-152, RF-160 · RNF-001, 004, 007, 031 (medición), 071, 072 · 03-arquitectura §12 (fila E2E) · notas [018] de ESTADO.

## Objetivo
Comprobar, con un navegador real y todos los adaptadores en `mock`, que las historias de R1 funcionan de punta a punta: frontend, backend, worker, cola, BD y correo. Así una regresión en cualquier capa se detecta en el CI y no en la siguiente prueba manual. Los escenarios parten de las pruebas manuales 015 T11, 016 T24, 012b T23 y 017 T18.

## Alcance
- Paquete `tests/e2e` (`@contapp/tests-e2e`) con Playwright, la configuración, utilidades de soporte (correo, siembra, sesiones, vigilancia de canarios) y los flujos E-01 a E-11.
- Comando `pnpm e2e` en la raíz y job `e2e` en `.github/workflows/ci.yml`.
- Corrección, antes de las pruebas, de los avisos duplicados en `role="alert"`/`aria-live` (P-2).
- Corrección de los defectos de pantalla pequeños que encuentre la E2E (P-6). Los de servidor se escalan al orquestador.

### Flujos (prioridad 1 = corre siempre y bloquea; 2 = etiqueta `@volumen`, solo en `main` y a mano, P-5)
| ID | Flujo | Historias | Escenarios mínimos (feliz · error) | Prio |
|---|---|---|---|---|
| E-01 | Alta y login | HU-01, 004 | Registro → enlace por correo → contraseña → panel; logout y login · credenciales erróneas con mensaje único; enlace usado | 1 |
| E-02 | Invitación y roles | HU-03, 04, 07, 08 | Dueño invita a un asistente → acepta por correo → se le asigna un cliente → solo ve ese; `lectura` sin botones de escritura; usuario en dos estudios cambia de estudio · invitación revocada o usada | 1 |
| E-03 | Clientes y credenciales | HU-06, 09, 10, 02 | Alta con consulta RUC mock; importación CSV con vista previa; SOL/SIRE guardadas (el campo nunca muestra la clave) y «Verificada» por el worker · RUC centinela con clave rechazada → «Inválida» y aviso en la campana; tope del plan Prueba | 1 |
| E-04 | Descarga SIRE de compras | HU-14, RF-042 | Descargar 202610 → «En cola» → «5 nuevas» y la grilla se actualiza sola (D-1 de 015) · RUC …68 «La descarga falló» con «Reintentar»; sin credenciales (409) | 1 |
| E-05 | Grilla de compras | HU-14 a 18, RNF-072 | Filtros y búsqueda; edición con teclado de F001-3064 con cuadre en vivo; clasificar; excluir y restaurar la zapatilla; agregar y duplicado con «Ubicar»; masiva con informe; Ctrl+Z/Ctrl+Y; revisado y reabrir; exportar Excel · IGV que no cuadra; `fila_cambiada` con una segunda sesión; `version_obsoleta` | 1 |
| E-06 | Volumen | RNF-031 | 5.000 compras sembradas: primeras filas, desplazamiento, masiva sobre 4.850 y Ctrl+Z con tiempo medido | 2 |
| E-07 | Lupa XML | HU-20 a 24 | Abrir con Enter; ←/→/Esc y foco devuelto; aceptar R-MIX (8.97) y R-ISC (San Juan 770.00); descargar el XML · centinela 8 «XML no disponible» → «Subir XML»; XML ajeno rechazado (422) | 1 |
| E-08 | Generar archivo | HU-25, 26 | Previo con error que bloquea y enlace a la fila → corregir → apto → generar → seguir el trabajo → bajar el ZIP (TXT con N líneas, SHA-256 igual al de la API); reabrir y v2 · asistente sin «Generar»; periodo `generado` bloquea la edición | 1 |
| E-09 | Ventas | HU-11, 12 | Descarga RVIE mock; «Falta B001-291»; excluir la venta descuadrada con motivo; generar ventas sin las excluidas · motivo vacío rechazado; USD sin TC bloquea | 1 |
| E-10 | Notificaciones y auditoría | RF-150, 152, 160, HU-10 | La campana sube en vivo al terminar una descarga; marcar leída y «marcar todas»; la auditoría lista las acciones del flujo con el nombre del autor · asistente sin acceso a la auditoría (mensaje y 403) | 1 |
| E-11 | Aislamiento en la UI | RNF-001, 007, HU-08 | Usuario del estudio B abre URLs de cliente, compra, lupa y ZIP de A → «no encontrado», sin datos de A en DOM ni respuestas; asistente no asignado → 404; tras cambiar de estudio, las listas no se mezclan | 1 |

Casos reales que recorren: San Juan ISC, mixta 21.48/1.61, boleta 291 y zapatilla (fixtures de 009). El redondeo USD sigue diferido.

## Fuera de alcance
- Pantallas y adaptadores de R2 y R3: buzones, prorrata, envío a SUNAT, PlaywrightSolPortal y SIRE real. También la lupa de ventas (tiene una nota propia).
- Accesibilidad automática (axe), comparación visual por capturas, móvil y pantallas < 1366 px (RNF-071), y carga y concurrencia de servidor (ya cubiertas en 008 y 012b).
- Rendimiento como criterio bloqueante. E-06 mide con los topes de CA-9 y deja anotado; acelerar el Ctrl+Z de la masiva va a una spec de rendimiento (P-3).
- Firefox y WebKit (P-4).
- Super-admin y planes de plataforma, salvo el tope del plan Prueba visto por el Dueño.

## Decisiones técnicas (arquitecto)
- **D-1 · Ubicación**: `tests/e2e/` como paquete del workspace (`tests/*` ya está en `pnpm-workspace.yaml`), con archivos `*.e2e.ts` (04 §6). `@playwright/test` va fijado en versión exacta: 1.63.0, la del contenedor, publicada hace dos semanas o más (se confirma al instalar). `apps/frontend` no gana dependencias.
- **D-2 · Arranque** (ajustada al planificar): el `globalSetup` levanta la pila, no el `webServer` de Playwright, porque la BD tiene que existir antes que el backend y el worker no abre puerto. Backend y worker van compilados con `node dist/main.js` (no tienen script `start`) y el entorno se pasa explícito, sin `.env`: `NODE_ENV=development`, todo `mock`, `KEY_PROVIDER=mock`, `STORAGE=local` en un directorio temporal compartido, `XML_SIMULADO_EN_REGLAS=1`. El frontend usa `next build && next start`, con `BACKEND_URL` fijado ya al compilar (lo usan los `rewrites`). Usa puertos propios (frontend 3210, backend 4210) para no chocar con `dev`, y `APP_ORIGIN=http://localhost:3210`.
- **D-3 · Datos**: BD nueva `contapp_e2e` y un índice de Redis propio en cada corrida. El `globalSetup` crea, migra y siembra; el `globalTeardown` borra, salvo con `E2E_CONSERVAR_BD=1`. Las URL de la E2E salen de `MIGRATIONS_DATABASE_URL` y `DATABASE_URL` del entorno cambiando solo el nombre de la BD: los roles son de todo el clúster y `db:migrate` fija la contraseña de `contapp_app`, así que otra contraseña rompería la BD de desarrollo. Cada archivo crea sus propios estudios con correos únicos, así que no hay limpieza entre pruebas y el paralelismo es seguro (`fullyParallel`).
- **D-4 · Preparación**: E-01 y E-02 hacen el alta y la invitación por la UI. Los demás flujos preparan estudio, usuarios y clientes con un helper de siembra de BD (como `tests/aislamiento`) para no tocar los límites por IP del registro (006 CA-4). Las credenciales se cargan por la API, porque el backend cifra. (Ajustada al planificar) Sin proyecto `setup`: cada archivo crea sus usuarios y abre su sesión por la API con un `X-Forwarded-For` único por usuario, como `ipUnica()` de `apps/backend/test/soporte.ts`, porque `login_ip` admite 20 intentos cada 10 min por IP y `registro_ip` 5 por hora. Los contextos de navegador de E-01 y E-02 llevan también su propio `X-Forwarded-For`. Las 5.000 compras de E-06 se insertan por SQL, como en 015 T11.
- **D-5 · Correo**: `CORREO_PROVIDER=smtp` (con `SMTP_URL` y `CORREO_REMITENTE`, que el backend exige con `smtp`) contra Mailpit; el helper lee el enlace por la API HTTP de Mailpit filtrando por destinatario. Sin Docker, el respaldo es `E2E_CORREO=consola`, que lee el stdout del backend redirigido a un archivo del directorio temporal.
- **D-6 · Localizadores y esperas**: por rol y nombre accesible (`getByRole`, `getByLabel`) y con los textos de `lib/`. `data-testid` solo donde no haya nombre accesible, y todo lo demás en `soporte/selectores/` (ajustada al planificar: un archivo por área, para que las tareas de flujos vayan en paralelo sin tocar el mismo archivo). Solo aserciones web-first; ninguna espera fija. Los trabajos de la cola se esperan por el estado en pantalla, con un tope explícito de 30 s.
- **D-7 · Configuración**: `retries: 0` en local y en CI, `forbidOnly` en CI, `trace: retain-on-failure`, captura al fallar y sin video. Viewport 1440×900, `locale es-PE` y `timezoneId America/Lima`. En el CI, 2 workers; en local, 4.
- **D-8 · Vigilancia en cada prueba**: un fixture registra las respuestas `/api`, el DOM final y la consola. Hace fallar la prueba si aparecen los valores de las credenciales de fixture (`USUPRUEBA`, `CLAVEPRUEBA`, `CIDPRUEBA`, `CSECPRUEBA`), si `window.__pwn` queda definido o si hay errores de consola que la prueba no declaró.
- **D-9 · CI**: job `e2e` aparte, con servicios `postgres:17`, `redis:7` y `axllent/mailpit:v1.33.0` (el mismo de `docker-compose.yml`). Chromium se instala con `pnpm exec playwright install --with-deps chromium` y una caché de `~/.cache/ms-playwright` por versión. Se compilan solo los paquetes que hacen falta (filtro de turbo); el `next build` del frontend va fuera de turbo, porque turbo 2 filtra las variables no declaradas (`BACKEND_URL`). Si falla, el reporte HTML y las trazas suben como artefacto por 7 días. Las trazas solo contienen datos de fixture.

## Criterios de aceptación
- [x] CA-1: `pnpm e2e`, con PostgreSQL, Redis y Mailpit arriba (o con `E2E_CORREO=consola`), compila, levanta los tres procesos en `mock`, corre la suite y termina con 0. Deja el reporte HTML y no quedan procesos ni la BD `contapp_e2e` (salvo con `E2E_CONSERVAR_BD=1`).
- [x] CA-2: cada flujo E-01 a E-11 tiene en verde al menos su caso feliz y su caso de error de la tabla. `tasks.md` mapea cada escenario a su archivo.
- [ ] CA-3: tiempo. En CI, la suite de prioridad 1 tarda ≤ 6 min y el job `e2e` completo (instalar, compilar, servicios y suite) ≤ 15 min. En local, con 4 workers, ≤ 5 min. Los tiempos quedan en el Resultado de la verificación. **Pendiente: CI** (lo cierra el orquestador).
- [x] CA-4: estabilidad sin reintentos (`retries: 0`). La suite completa pasa con `--repeat-each=3` en local con 0 fallos, y 3 corridas seguidas del job en CI salen en verde sin cambios entre ellas. Un fallo intermitente es un defecto: no se marca `fixme` ni se reintenta. Cumplido en local (tercera verificación de T11); la corrida de CI queda pendiente, como CA-3 y CA-11.
- [x] CA-5: higiene. En `tests/e2e` no hay `waitForTimeout`, `setTimeout` ni `test.only`, y no hay selectores CSS ni XPath fuera de `soporte/selectores/` (se comprueba con grep). Cada archivo pasa corrido solo, y la suite pasa con `--workers=1` y con `--workers=4`.
- [x] CA-6: secretos y canarios (D-8). En todas las pruebas: 0 apariciones de las credenciales de fixture en las respuestas, el DOM y la consola; `window.__pwn` sin definir tras cargar razón social, glosa y motivo canario (`<img src=x onerror=…>`, `=1+1`); el Excel exportado guarda `=1+1` como texto.
- [x] CA-7: aislamiento en la UI (E-11). Con ids de otro estudio o de un cliente no asignado, la pantalla y la API responden igual que con un id inexistente (404), sin datos ajenos en el DOM ni en las respuestas.
- [x] CA-8: regresiones. Cada defecto de pantalla corregido en 015 T12, 016 T24a, 012b T23a y 017 T18a que se vea en el navegador tiene una aserción E2E que falla si vuelve. Como mínimo, la grilla se refresca al terminar la descarga (D-1 de 015).
- [x] CA-9: volumen (E-06, etiqueta `@volumen`). Con 5.000 compras, las primeras filas se ven en < 2 s (RNF-031) y el Ctrl+Z de la masiva sobre 4.850 filas termina en ≤ 10 s (P-3). Los dos tiempos quedan como anotación en el reporte y en el Resultado de la verificación, y la nota de rendimiento pasa a ESTADO. `pnpm e2e` no corre `@volumen`; `pnpm e2e:volumen` corre solo esa etiqueta.
- [x] CA-10: avisos únicos (P-2). Antes de las pruebas de flujo, cada aviso de la grilla, la lupa, el archivo y ventas aparece una sola vez en el árbol de accesibilidad: `getByRole('alert'|'status', { name })` cuenta 1 en la E2E y en una prueba de componente por pantalla corregida. Incluye «Sugerencia aceptada.», «La sugerencia cambió…», «Otra persona cambió esta compra…» y el error de fila de 015 T11 (f). Excepción aceptada en T12: «La sugerencia cambió…» y el error de fila de 015 T11 (f) solo tienen prueba de componente.
- [ ] CA-11: el job `e2e` del CI (P-1, P-5) corre en los `pull_request` y en los `push` a `main`, y en las demás ramas solo con `workflow_dispatch`. En los PR corre sin `@volumen`; en `main` y a mano, con `@volumen`. Sube el reporte HTML y las trazas al fallar (D-9). Que el job bloquee el merge depende de marcarlo como check requerido en la protección de `main` (ajuste de GitHub, fuera del repo). **Pendiente: CI** (lo cierra el orquestador).
- [x] CA-12: `tests/e2e/README.md` (≤ 1 página) explica cómo correr con y sin Docker, las variables y cómo abrir una traza. Typecheck y lint de `tests/e2e` limpios (DoD C). Observación aceptada en T12: el README tiene 90 líneas y puede pasar de una página; no se recortó porque T13 no lo pedía.
- [x] Casos reales aplicables: San Juan ISC, mixta 21.48/1.61, boleta 291 y zapatilla (vía fixtures mock).

## Dependencias
- Specs: 001 a 017 y 019 (todas hechas).
- Externas: ninguna. Chromium y Playwright ya están en el contenedor (`/opt/pw-browsers`); en el CI los instala D-9.

## Decisiones del usuario (2026-11-12)
Eligió en todas la opción recomendada:
- P-1 → (b) El job `e2e` corre y bloquea en los PR y en los push a `main`; en las demás ramas solo se lanza a mano (`workflow_dispatch`). CA-11.
- P-2 → (a) Los avisos duplicados en `role="alert"`/`aria-live` de la lupa y de la grilla (y los de archivo y ventas, si los hay) se corrigen en 018, con una tarea de frontend previa a las pruebas de flujo. CA-10.
- P-3 → (b) E-06 mide el Ctrl+Z de la masiva con un tope de 10 s; acelerarlo queda anotado para una spec de rendimiento. CA-9.
- P-4 → (a) Solo Chromium. Además, la cookie `__Host-contapp_sid` exige `Secure` y Chromium la acepta en `http://localhost`.
- P-5 → (b) E-06 (5.000 filas) corre solo en `main` y a mano, con la etiqueta `@volumen`. CA-9, CA-11.
- P-6 → (a) Los defectos de pantalla pequeños que encuentre la E2E se corrigen en 018 (tareas condicionales «Tna» de `tasks.md`); los de servidor se escalan al orquestador, y la prueba afectada no se marca `fixme` (CA-4).

## Preguntas abiertas (resueltas el 2026-11-12, ver arriba)
- **P-1 · ¿Cuándo corre la E2E en el CI?** (a) En cada push y PR, y bloquea. (b) En PR y en push a `main`, y bloquea; en las otras ramas, solo a mano con `workflow_dispatch` **(Recom.)**. (c) Solo de noche o a mano, sin bloquear.
- **P-2 · Avisos duplicados en `role="alert"`/`aria-live` (016 T24 (a), 015 T11 (f))**. (a) Se corrigen en 018 con una tarea de frontend previa a las pruebas: es un defecto de accesibilidad, porque el lector de pantalla los lee dos veces, y los localizadores por rol necesitan un solo aviso **(Recom.)**. (b) Se dejan; las pruebas toleran el duplicado y la corrección va a otra spec.
- **P-3 · Ctrl+Z de una masiva de ~4.850 filas tarda ~7 s** (recarga el listado entero). (a) Se corrige en 018: recargar solo las filas afectadas, con meta ≤ 2 s. (b) Queda fuera: E-06 lo mide con un tope de 10 s y se anota para una spec de rendimiento **(Recom.)**. (c) Se excluye de la E2E.
- **P-4 · Navegadores**. (a) Solo Chromium: cubre Chrome y Edge, el uso de escritorio esperado, y es el único instalado en el contenedor **(Recom.)**. (b) Chromium y Firefox, con más o menos el doble de tiempo en el CI. (c) Chromium, Firefox y WebKit (WebKit en Linux no equivale a Safari).
- **P-5 · E-06 (5.000 filas) en el CI**. (a) En cada corrida, y bloquea. (b) Solo en `main` y a mano, con la etiqueta `@volumen` **(Recom.)**. (c) Fuera de 018 y solo manual.
- **P-6 · Defectos que encuentre la E2E en código de producción**. (a) Los de pantalla pequeños (una tarea) se corrigen en 018; los de servidor se escalan al orquestador **(Recom.)**. (b) Todos se registran y se corrigen en specs aparte, y la prueba queda en `fixme` (choca con CA-4).
