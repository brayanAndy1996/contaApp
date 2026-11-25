# Cierre 018 · Pruebas E2E de R1

Spec `018-e2e-r1` · nivel C · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 018-e2e-r1 | C | hecha | — | Mergeada en `main` (06e9b6f). Paquete `tests/e2e` (Playwright 1.63, solo Chromium, P-4) con pila propia (BD `contapp_e2e` nueva por corrida, Redis índice 14, backend/worker `dist`, `next start` en 3210/4210, Mailpit en CI o `E2E_CORREO=consola`); flujos E-01 a E-11 y E-06 de volumen (`@volumen`, solo push a `main` y a mano, P-5). Job CI «E2E de R1 (Playwright, Chromium y Mailpit)» en PR, push a `main` y `workflow_dispatch` (P-1), caché de Chromium y artefacto `e2e-fallos` solo al fallar. Defectos de pantalla corregidos en 018 (P-2/P-6): avisos únicos (T1), «Cerrar sesión» y remonte al cambiar de estudio (T4a), límite de RUCs (T5a), foco de «Acciones» (T7a), «No se encontró» único (T8a), 401 de la rotación de sesión con reintento (T11a), foco tras Tab y menú «Acciones» (T11d). Defectos de servidor corregidos por decisión del usuario/orquestador (excepción a P-6): carrera del despachador y re-encolado del reconciliador (T11c, ADV 12 pruebas, 2 hallazgos corregidos) y evento «terminado» perdido entre listado y stream SSE (T11e). CA-4: 3 corridas locales seguidas `--repeat-each=3 --workers=4` con 0 fallos; CI: e2e verde en las corridas dispatch 465, 470, 473 y 475. Desvíos ratificados en `plan.md` (T12). Sin migraciones. |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 2 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `018-e2e-r1`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- ~~[rendimiento] Ctrl+Z de la masiva sobre ~4.850 filas: 1,3–1,9 s (018 T9/T11; antes ~7 s). Dentro del tope de 10 s; acelerarlo en una spec de rendimiento (018 P-3).~~ (cerrada por 022)
- ~~[rendimiento] El despachador hace `ZRANGE 0 -1` de la lista de pendientes del estudio en cada atención (018 T11c): O(N) con miles de `en_cola`. Va a la spec de rendimiento (020 P-1 = b, antes DT-9): lectura acotada sin perder las garantías de `cerrarEstudioVacio`.~~ (cerrada por 022)
- [mantenimiento] Un trabajo encolado con Redis caído (SADD por `contarPendientes` sin ZADD) solo lo repone el reconciliador (≤ 30 s) (018 T11c). Límite aceptado por el usuario (020 P-1 = b, antes DT-10): sin pérdida permanente.
- [usuario] Configurar en la protección de `main` el check requerido «E2E de R1 (Playwright, Chromium y Mailpit)» (018 P-1).
- ~~[clientes] La ficha del cliente no refresca el estado de las credenciales tras verificar (visto en 018).~~ (cerrada por 020)
- ~~[frontend] El panel «Generar archivo» tapa columnas de la grilla de compras a 1440 px (visto en 018).~~ (cerrada por 020)
