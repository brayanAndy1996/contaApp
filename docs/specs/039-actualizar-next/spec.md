# Spec 039 · Actualizar Next.js (parche de seguridad en 16.x)

Estado: en curso (2026-11-17)
Nivel de riesgo: D — actualización de parche sin cambios de código: no toca montos, clasificaciones, archivos, datos, credenciales ni concurrencia (§2.1, ninguna respuesta «sí»). La cubren typecheck, lint, las pruebas existentes y los E2E. Nivel fijado por el usuario (2026-11-17).
Cubre: RNF-010 (dependencias revisadas; sin avisos de vulnerabilidad conocidos en producción) · nota [dependencias] de `docs/specs/ESTADO.md`

## Objetivo
`next` 16.4.3 está en el rango vulnerable del aviso GHSA-mfr8-8qww-v76h (moderado: divulgación de información entre root params cuando una función `'use cache'` se llama con `unstable_cache()`). Además, `next build` sale con `SecurityFatalError` en el primer intento de cada ventana de 5 minutos. Esta spec sube `next` a la parche más baja de 16.x que corrige el aviso: **16.4.5**.

Evidencia (2026-11-17):
- `pnpm audit --prod` con 16.4.3: el único aviso de `next` es GHSA-mfr8-8qww-v76h, vulnerable `>=16.3.0 <=16.4.4`, corregida en `>=16.4.5`.
- `pnpm view next versions`: 16.4.5 (publicada 2026-11-03) es la primera 16.x con la corrección; la última 16.x es 16.4.6 (2026-11-09).
- Fuera de `.next`, ni `apps/frontend`, ni `packages`, ni `tests` usan `unstable_cache` ni `'use cache'`: la exposición directa es baja. Se actualiza igual por decisión del usuario.

## Alcance
- `apps/frontend/package.json`: `"next"` pasa de `16.4.3` a `16.4.5` (versión exacta, sin `^`, como hoy).
- `pnpm-lock.yaml` regenerado con `pnpm install`; no se edita a mano.
- Ninguna otra dependencia directa cambia: `apps/frontend` no declara `eslint-config-next` ni `@next/*`. Los `@next/*` transitivos suben con `next`.
- Sin cambios de código, configuración ni de la BD.

## Fuera de alcance
- Otros avisos de `pnpm audit --prod` (`fflate`, `multer`, `nodemailer` x3, `fast-xml-parser`): no son dependencias de `next`; van en otra spec.
- Versiones 17.x o canary (`16.5.0-canary.*`): el criterio es la parche más baja de 16.x que corrige el aviso. Si la corrección exigiera una versión mayor, la spec para y se reporta sin actualizar.
- Cambiar el `engines` de Node del repo (`>=24.1.0 <25`).

## Criterios de aceptación
- [ ] CA-1: `apps/frontend/package.json` declara `"next": "16.4.5"`; `pnpm install` sale con 0 y el diff de `pnpm-lock.yaml` solo toca `next` y sus `@next/*` transitivos.
- [ ] CA-2: `pnpm audit --prod` ya no lista GHSA-mfr8-8qww-v76h.
- [ ] CA-3: `next build` sale con 0 en el primer intento en dos ejecuciones seguidas: una con la caché limpia y otra con más de 5 minutos entre ellas.
- [ ] CA-4: `typecheck`, `lint` y `test` de `@contapp/frontend` en verde con `TZ=America/Lima` y con `TZ=UTC`.
- [ ] CA-5: `pnpm e2e` completo y `pnpm e2e:volumen` (`@volumen`) en verde.
- [ ] CA-6: CI en verde tras el push de la rama. Esta ejecución no hace push: lo confirma el orquestador.

## Dependencias
- Specs: ninguna. Rama `spec/039-actualizar-next` desde `main`.
- Externas: registro npm y base de avisos de npm (`pnpm view`, `pnpm audit`).
- Entorno de verificación: Node 22.22.0. El repo pide Node 24.x (`engines`) y en este entorno no hay 24 instalado.

## Preguntas abiertas
- Antigüedad de 16.4.5: al ejecutar la spec (2026-11-17, 15:56 UTC) tiene 13 días y 22 h. La regla de «≥ 2 semanas» de 007b y 018 aplica a dependencias nuevas y no a esta actualización; aun así, cumple 2 semanas el 2026-11-17 a las 18:01 UTC. La ejecución no esperó, por el criterio de la parche más baja. El orquestador decide si lo acepta.
