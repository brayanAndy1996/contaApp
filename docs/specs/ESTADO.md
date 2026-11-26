# Tablero de specs

Lo mantiene el **orquestador** (y lo cierra `devops` al terminar cada spec). Orden y roles: [04-metodologia.md §4](../04-metodologia.md).

Estados: `pendiente` · `borrador` · `aprobada` · `en curso` · `verificada` · `hecha` · `bloqueada`

Una línea por spec; el detalle de las cerradas está en `NNN-*/cierre.md` y los hallazgos cerrados en [HALLAZGOS.md](HALLAZGOS.md).

| Spec | Nivel | Estado | Tarea actual | Nota (≤ 200 caracteres) |
|---|---|---|---|---|
| 001-fundaciones | D | hecha | — | Sin Docker (decisión del usuario). TypeScript 6.0.3. CI de GitHub sin ejecutar: el repo no tiene remoto. Detalle: `001-*/cierre.md` |
| 002-db-rls | A | hecha | — | Aprobada por el usuario (D1–D3, D5–D7). Rama `spec/002-db-rls` desde `spec/001-fundaciones`. Detalle: `002-*/cierre.md` |
| 003-cifrado | A | hecha | — | Rama `spec/003-cifrado` sin mergear (desde 002). F2: límite aceptado por el usuario. Detalle: `003-*/cierre.md` |
| 004-auth | A | hecha | — | Rama `spec/004-auth` sin mergear (desde 010). O-2 y límites de T20a aceptados por el usuario. Detalle: `004-*/cierre.md` |
| 005-acceso | A | hecha | — | Rama `spec/005-acceso` sin mergear (desde 004). CI verde (1216e84). Detalle: `005-*/cierre.md` |
| 006-planes | B | hecha | — | Mergeada en `main` (5a9fd7a). Migraciones 0022–0025. Detalle: `006-*/cierre.md` |
| 007a-clientes | B | hecha | — | Mergeada en `main` (5a61f83). Migración 0026. Detalle: `007a-*/cierre.md` |
| 007b-credenciales | B | hecha | — | Mergeada en `main` (87326d4). Migración 0027. Detalle: `007b-*/cierre.md` |
| 008-cola | A | hecha | — | Mergeada en `main` (74d96c9). Revisión final aprobada; 26 hallazgos corregidos. Detalle: `008-*/cierre.md` |
| 009-adaptadores-mock | C | hecha | — | Mergeada en `main` (86311c7). Puertos `XmlProvider` y `SireApiClient` con mocks. Detalle: `009-*/cierre.md` |
| 010-dominio-dinero | A | hecha | — | Rama `spec/010-dominio-dinero` sin mergear (desde 003). Pendiente no bloqueante: caso real USD, sin cifras. Detalle: `010-*/cierre.md` |
| 011-motor-reglas | A | hecha | — | Mergeada en main (11e4cb8). Pendiente no bloqueante: caso real USD, sin cifras. Detalle: `011-*/cierre.md` |
| 012-prevalidacion-archivos | A | hecha | — | Mergeada en `main` (b8be2dc). Formato TXT provisional (`oficial: false`). Detalle: `012-*/cierre.md` |
| 012b-generar-archivo | A | hecha | — | Mergeada en `main` (534656f). Migraciones 0039–0040. Detalle: `012b-*/cierre.md` |
| 013-ventas | B | hecha | — | Mergeada en `main` (9ea92b2). Migraciones 0028–0031. Layout de importación provisional. Detalle: `013-*/cierre.md` |
| 014-compras-backend | B | hecha | — | Mergeada en `main` (2bc3252). Migraciones 0032–0034. Detalle: `014-*/cierre.md` |
| 015-compras-frontend | C | hecha | — | Mergeada en `main` (a065109). Sin cambios de backend ni BD. Detalle: `015-*/cierre.md` |
| 016-lupa-xml | A | hecha | — | Mergeada en `main` (1c79486). Migraciones 0035–0038. Detalle: `016-*/cierre.md` |
| 017-auditoria-notif | B | hecha | — | Mergeada en `main` (c2218de). Migraciones 0041–0045. Detalle: `017-*/cierre.md` |
| 018-e2e-r1 | C | hecha | — | Mergeada en `main` (06e9b6f). Sin migraciones. Pendiente del usuario: exigir el check E2E en la protección de `main`. Detalle: `018-*/cierre.md` |
| 019-docker-local | D | hecha | — | Pedida por el usuario (2026-11-03). Mergeada en `main`. Sin Dockerfiles de apps (spec futura de despliegue). Detalle: `019-*/cierre.md` |
| 020-deuda-r1 | C | hecha | — | Mergeada en `main` (52c8514). Migración 0046. Detalle: `020-*/cierre.md` |
| 021-reglas-aprendidas | A | hecha | — | Mergeada en `main` (5005bca). Migraciones 0047–0052. Detalle: `021-*/cierre.md` |
| 022-rendimiento | B | hecha | — | Mergeada en `main` (8c6ffef). Sin migraciones (0052–0054 liberadas). Detalle: `022-*/cierre.md` |
| 023-buzones-captura | A | hecha | — | Mergeada en `main` (f91c0af). Migraciones 0054–0058. Riesgos aceptados: tipos SUNAT provisionales, Playwright SOL. Detalle: `023-*/cierre.md` |
| 024-bandeja-buzones | B | hecha | — | Mergeada en `main` (96308db). Migraciones 0059–0060; 0059 exige migrar como superusuario. Detalle: `024-*/cierre.md` |
| 025-aprendizaje-arranque | A | hecha | — | Mergeada en `main` (0e6eac6). Migraciones 0061–0064. Detalle: `025-*/cierre.md` |
| 026-prorrata-igv | A | hecha | — | Mergeada en `main` (c7471fd). Migraciones 0065–0068. Pendiente: un contador del equipo revisa la tabla de casos de CA-2; PDT 621 provisional. Detalle: `026-*/cierre.md` |
| 027-gastos-no-deducibles | A | hecha | — | Mergeada en `main` (28872de). Migraciones 0069–0072. Pendiente: un contador del equipo revisa palabras, excepciones, matriz, rubros y feriados. Detalle: `027-*/cierre.md` |
| 028-correo-avisos | A | hecha | — | Mergeada en `main` (df50fd7). Migraciones 0073–0077 (siguiente libre: 0078). Deuda O-1–O-10 en la tarjeta T24. Detalle: `028-*/cierre.md` |
| 029-cuenta-segura | A | hecha | — | Rama spec/029-cuenta-segura sin mergear (desde main). Migraciones 0078–0081 (siguiente libre: 0082). 2 riesgos bajos aceptados. Detalle: `029-*/cierre.md` |
| 030-roles-personalizados | A | en curso | T1–T5 (pruebas) | Spec aprobada (U1–U10 = recomendadas). 18 tareas. Rama desde spec/029 (sin mergear). Migraciones desde 0082. |
| 031-auditoria-consulta | B | pendiente | — | RF-151 · HU-39. |
| 032-envio-sire-ticket | A | pendiente | — | RF-104 · HU-27. Con mock; apagado hasta formato oficial y `SireAuth` real. |
| 033-catalogo-global-icb | A | pendiente | — | RF-084, 087. Curado por super-admin + conteos anónimos desde N estudios (D4 = a). |
| 034-lupa-ventas | C | pendiente | — | Nota [lupa de ventas]. Antes de 035. |
| 035-cruce-emitidos-sol | B | pendiente | — | RF-054 · HU-13. |
| 036-superadmin-estudios | C | pendiente | — | RF-008. |
| 037-eliminar-cliente | A | pendiente | — | RF-038 + purga de auditoría (RNF-020/021). |
| 038-diseno-visual | C | hecha | — | Mergeada en `main` (d1cc8fd). Modo oscuro fuera (P-1). Detalle: `038-*/cierre.md` |
| 039-actualizar-next | D | hecha | — | Decisión del usuario 2026-11-17. `next` → 16.4.5 (GHSA-mfr8-8qww-v76h). CI verde con E2E. Detalle: `039-*/cierre.md` |
| 040-avisos-dependencias | C | hecha | — | Decisión del usuario 2026-11-17. `pnpm audit --prod` de 6 avisos a 0. CI verde con E2E. Detalle: `040-*/cierre.md` |
| 042-acelerar-desarrollo | D | hecha | — | Merge b3255e5 (PR #2). CI completo 2 h 46 min → 27–31 min; nivel 1 en spec/* 6–7 min; cobertura única por app; ESTADO liviano. Detalle: `042-acelerar-desarrollo/cierre.md` |

## Hallazgos adversariales abiertos

Ninguno. Los cerrados están en [HALLAZGOS.md](HALLAZGOS.md).

## Decisiones pendientes del usuario

Ninguna.

## Notas para specs futuras

No son decisiones tomadas ni pendientes del usuario: cada spec las resuelve al planificarse. Hasta 2 líneas por nota; `→` apunta a su texto completo (`cierre.md` de la spec de origen o `HALLAZGOS.md#notas-movidas`), donde también están las ya resueltas.

- [lint] Consultas en repositorios de `packages/db`; el lint también veta `sql` vía `import * as` de `drizzle-orm` (resuelto en 007a T10). → `007a-*/cierre.md`
- [infra] Restringir con `pg_hba` que `contapp_app` no entre a otras bases del clúster (hoy `postgres` conserva `CONNECT` y `TEMP` para PUBLIC).
- [003] Heredar el permiso por columnas de `credencial` (D3).
- [004/005] El backend nunca importa `@contapp/crypto/descifrado`. El lint lo vigila de forma heurística; la barrera real es la migración `0006`.
- [despliegue] Un adaptador KMS/Vault debe implementar `huellaPublica` (opcional) o fallar cerrado en producción; fuera del monorepo, rutas de llaves absolutas. → `HALLAZGOS.md#notas-movidas`
- [011/013] El lint contra `number` solo cubre `dinero/` y `comprobante/`: con montos en otra carpeta, ampliar su `files`. → `HALLAZGOS.md#notas-movidas`
- [013] 010 no trae las columnas de ventas (D4); 013 reutiliza `Money` y un `verificarCuadre` genérico. → `010-*/cierre.md`
- [004] Límites aceptados (O-2): re-hash simultáneo → 401 en el 2.º login; misma cookie + cambio de contraseña → posible 500. → `004-*/cierre.md`
- [007b y siguientes] Escrituras sobre `membresia`, `cliente` o `asignacion`: `filtroAlcance`, `ClienteScopeGuard` y el orden de bloqueo de 005. → `005-*/cierre.md`
- [despliegue] PostgreSQL de producción con colación ICU `und-x-icu`: la migración 0016 falla si falta. El CI (`postgres:17`, run 40524156972) la confirma.
- [despliegue] Riesgo bajo aceptado: Node 24 (Unicode 16) vs ICU de PostgreSQL: la BD puede rechazar letras muy nuevas. → `HALLAZGOS.md#notas-movidas`
- [005] Riesgo bajo aceptado: se rechazan ZWJ/ZWNJ en nombres de invitación (persa, índicos, emojis); no afecta al español. → `005-*/cierre.md`
- [005] Riesgo bajo aceptado: `invitacion_vigente` lee la membresía del invitador sin bloqueo. → `005-*/cierre.md`
- [siguientes] Próxima migración libre: 0082 (ver fila de 029); rangos usados por cada spec hasta 021. → `HALLAZGOS.md#notas-movidas`
- [permisos] Si se separan `clientes.crear` y `clientes.asignar`, revisar `POST /clientes` con `responsableId` y el select de responsable. → `HALLAZGOS.md#notas-movidas`
- [RF-005/006] Un plan asignado a un estudio en Prueba lo deja en `prueba` (decisión 2026-11-03): resolver antes de aplicar vencimientos. → `HALLAZGOS.md#notas-movidas`
- [R3] El Dueño aún no cambia de plan por su cuenta (RF-005); lo hace el super-admin.
- [despliegue] `db:plataforma-alta` lee la lista de contraseñas comunes de `apps/backend` por ruta relativa: correrlo desde un checkout completo. → `HALLAZGOS.md#notas-movidas`
- [006] D4 de la spec dice `FOR UPDATE`; prevalece el bloqueo advisory `plan.cupo:<tenant>` de `plan.md` (ratificado en T15).
- [pruebas] `seed-r2b.adv.spec.ts:29` falló una vez en local (¿timeout del `import` en frío?): si reaparece en CI, subir su timeout. → `HALLAZGOS.md#notas-movidas`
- [004] Precisa D3 (inactividad de 2 h): el stream de trabajos no renueva la sesión; las demás rutas sí (008 D22). → `008-*/cierre.md`
- [007b] Tras cambiar la clave SOL, los trabajos SIRE se cancelan (`credencial_invalida`) hasta verificar de nuevo la credencial (008 D23). → `008-*/cierre.md`
- [real] `SireAuth` real: si distingue la causa (`invalid_client` → `sire_api`; usuario o clave → `sol`), `ErrorCredencial` la indica (008 D23). → `008-*/cierre.md`
- [despliegue] NTP en los hosts de PostgreSQL y Redis: cupos, locks y reconciliador usan `TIME` de Redis. → `HALLAZGOS.md#notas-movidas`
- [despliegue] Límites por proceso: 3 streams SSE por sesión y un token SIRE en caché por worker. → `HALLAZGOS.md#notas-movidas`
- [despliegue] Redis gestionado: confirmar que admite BullMQ 6.5 (scripts Lua), `TIME` y pub/sub (`eventos:{tenantId}`) antes de usarlo.
- [006 y siguientes] El reconciliador solo ve los 100 `ejecutando` más nuevos: si `concurrencia_tenant` suma ≥ 100, paginar. → `HALLAZGOS.md#notas-movidas`
- [014] Pasar el mismo entorno al aplicar, re-evaluar la fila tras cada aplicación y tratar `SugerenciaObsoletaError` y `requiere_dato` como «revisar de nuevo». → `HALLAZGOS.md#notas-movidas`
- [013] La correlatividad (boleta 291, RF-053) va en `packages/domain/src/correlatividad/` y debe ampliar el lint de `number` si maneja montos.
- [diferido] Caso real USD sin cifras: agregarlo en `tests/casos-reales/`; si contradice D7 de 010, reabrir con el usuario. → `010-*/cierre.md`
- [R2] R-GP completo (RF-116 a RF-118), R-ICB, R-HIS y catálogo de proveedores ISC (hoy es dato del contexto).
- [real] Cola `xml` en R1: ~2 trabajos/s por estudio (decisión 2026-11-04, 007b D-3); revisarla con la consulta RUC real. → `007b-*/cierre.md`
- [dependencias] 007b agregó `fast-xml-parser` 5.11.2 y `fflate` al backend, con el override `is-unsafe: 2.0.2` en `pnpm-workspace.yaml`.
- [despliegue] Worker en producción exige `PERMITIR_ADAPTADORES_MOCK=1` sin adaptadores reales; el despliegue debe exigir `NODE_ENV=production` (009 D15). → `009-*/cierre.md`
- [pruebas] `CI=true pnpm ci:cierre` borra los trabajos vivos de la base de `MIGRATIONS_DATABASE_URL`: no usarlo con datos (009 D20). → `009-*/cierre.md`
- [real] Fixtures de 009: RUC de prueba no contrastados con SUNAT; tarifa ICBPER de 0.50 no fijada en `docs/`. → `009-*/cierre.md`
- [014] Mapear `tipoCambio: null` en las filas PEN (si no, bloquean) y quitar una fila agregada que luego se descarta. → `HALLAZGOS.md#notas-movidas`
- [013/oficial] La versión oficial del formato (o 013) debe rechazar `tipo: "ruc"` en los campos de texto de la fila distintos del documento del proveedor (012 D23).
- [oficial] Con el anexo de SUNAT y un archivo aceptado, revisar D18, D24, D14 y D17 del formato provisional. → `HALLAZGOS.md#notas-movidas`
- [proceso] Las pruebas de las tareas de corrección (`correcciones-*.spec.ts`) las escribe el tester, no el backend (nota de la revisión de 012).
- [014] Persistidor común (plan de 013): `PersistidorLibro` + `aplicarComplemento`; reutilizar `claveNormalizada` y `planificarComplemento`. → `013-*/cierre.md`
- [oficial] Sustituir `LAYOUT_VENTAS_PROVISIONAL` y el RVIE `oficial: false`; `validarFilaVenta` no valida fecha ni tipos (013 D25). → `013-*/cierre.md`
- [pruebas] adv-l2/l3/c4 (013 T22a) sensibles a la carga (`retry: 2`, 3 s); si fallan en CI, valorar `turbo run test --concurrency=2`. → `013-*/cierre.md`
- [013] Revisión T22: `leerFilasVentas` sin tope de filas tras D19; el worker no revisa si el cliente se archivó tras encolar. → `013-*/cierre.md`
- [015] Deshacer responde 409 `fila_cambiada` con ids: la grilla debe mostrarlas (014 DU-26); vista previa con `POST …/calcular` (DU-10). → `014-*/cierre.md`
- [lupa de ventas] Spec corta que reutiliza el modal de 016 (P-3); en «Pendiente» la lupa no ofrece «Subir XML».
- [real] `RealXmlProvider` (rutas SOL «E…»/«F…», credencial y canal propios, 016 P-7); `documento_xml_obtencion` queda en `no_encontrado` tras subir. → `016-*/cierre.md`
- [R2] PDF, «Recordar para este proveedor», R-ICB y R-HIS (016 P-8). Firma y CDR sin fuente en R1.
- [mantenimiento] El trigger `compra_version_worker_acotado` (0038) reconoce la compra nueva por `xmin`: dentro de un `SAVEPOINT` falla cerrado (42501). → `HALLAZGOS.md#notas-movidas`
- [despliegue] `XML_SIMULADO_EN_REGLAS=0` en producción (es el valor por defecto) y adaptador S3 de `StorageProvider`.
- [pruebas] Las limpiezas de soporte deben borrar las tablas de 013, 014 y 016 antes del estudio, o `planes.spec.ts` falla (016). → `016-*/cierre.md`
- [mantenimiento] Unificar el escritor xlsx de compras (`escritor-xlsx.ts`) con la plantilla de 007b cuando haga falta un segundo Excel. → `HALLAZGOS.md#notas-movidas`
- [oficial] RVIE oficial: sustituir formato provisional y nombres de archivo; revisar 012 D14/D17/D18/D24; D7 si trae razón social (012b T25). → `012b-*/cierre.md`
- [013] 012b amplió 013: `venta_periodo` (toda escritura crea la fila `abierto` y la bloquea) y `venta_exclusion`. → `012b-*/cierre.md`
- [refactor] Lógica de desborde duplicada en backend (`archivos/desborde.ts`) y worker (`desborde-resumen.ts`): moverla a `packages/domain/src/archivos`. → `HALLAZGOS.md#notas-movidas`
- [frontend] Abierto (012b): desborde de 27 px a 390 px por «Usuarios» en el menú superior. → `012b-*/cierre.md`
- [pruebas] Pruebas del worker que encolan con `encolarGenerar` dejan `job_registro` en `en_cola` (el reconciliador los adopta): cancelarlos en `afterEach`. → `HALLAZGOS.md#notas-movidas`
- [mantenimiento] Purga de auditoría > 5 años (017 D-7, RNF-021): R1 no purga; spec de retención antes de 2031. → `017-*/cierre.md`
- [R2] De 017: filtros de auditoría (RF-151) e historial por cliente de HU-39; correo configurable y de avisos (RF-161/162, cola `notificaciones`); aviso de buzón crítico.
- [mantenimiento] Un trabajo encolado con Redis caído solo lo repone el reconciliador (≤ 30 s); límite aceptado por el usuario (018 T11c). → `018-*/cierre.md`
- [pruebas] `tests/e2e/flujos/lupa.e2e.ts:305` («XML no disponible») falló una vez sin traza antes de T11e; si reaparece en CI, abrir defecto con traza.
- [usuario] Configurar en la protección de `main` el check requerido «E2E de R1 (Playwright, Chromium y Mailpit)» (018 P-1).
- [pruebas] La BD local `contapp` con residuo de corridas viejas rompe ~17 pruebas de aislamiento: recrearla (migrar y sembrar) (020 T9). → `020-*/cierre.md`
- [pruebas] No correr varias suites completas contra una sola BD (se contaminan): el CI corre en serie; para carga, BD propias (020 T9). → `020-*/cierre.md`
- [frontend] «Verificando…» de credenciales es estado local (020 T4): si una «Inválida» vuelve a fallar, sondea hasta 120 s. → `020-*/cierre.md`
- [oficial] Nombre de descarga `_vN` en versiones anteriores del archivo (020 P-6): revisarlo cuando llegue el formato oficial de SUNAT.
- [pruebas] Pruebas de tiempo en BD reutilizada se degradan (10,8 s vs 1,2 s): medir en BD nueva o tras `ANALYZE` (022 T13). → `022-*/cierre.md`
- [mantenimiento] `escribirVersiones` (022 T9) solapa `evaluar` con las escrituras: correcto solo mientras `Evaluar` no lea de la BD. → `022-*/cierre.md`
- [rendimiento] Aceptado por el usuario (022): Ctrl+Z de la masiva ~1,4 s y archivo de compras de 20.000 filas ~2,4 s. → `022-*/cierre.md`
- [frontend] Vistos en 021 T23: «Historial» no cierra con Esc; «Según historial» no quita la fila corregida; periodo futuro da 400. → `021-*/cierre.md`
- [rendimiento] El trigger `compra_version_worker_acotado` (0038) se vuelve lento en una BD reutilizada (~0,9 s → ~3 s; 021 T25c). → `021-*/cierre.md`
- [033] Las confirmaciones de 021 (`regla_confirmacion`, 0049) son solo inserción, RUC 20 y con el aporte encendido; ninguna ruta las lee aún.
- [frontend] De 038 a 390 px: historial de compra desplaza 37 px sin pista; nombres largos truncados; áreas táctiles de ventas solapadas 8 px. → `038-*/cierre.md`
- [dependencias] Overrides de 040 en `pnpm-workspace.yaml` (fast-xml-builder, @nestjs/platform-express): revisarlos en la próxima actualización de dependencias. → `040-*/cierre.md`
- [029] Aceptado: las funciones previas a 029 (plan, gnd, estudios_listar, suscripcion_asignar, invitación y registro) aceptan una sesión pendiente; el guard HTTP las cubre.
- [029] El token de invitación/registro vive solo en memoria (005 D15): quien debe enrolar TOTP reabre el enlace después. → `029-*/cierre.md`
