# Spec 040 · Avisos de dependencias de `pnpm audit --prod`

Estado: en curso (2026-11-17). Con evidencia en `tasks.md`: CA-1, CA-2, CA-3 y CA-5 a CA-8. CA-4 sin cumplir: `pnpm test` salió con 1 fallo en el frontend (T6, sin reintento; el frontend pasa en aislado con `TZ=America/Lima` y `TZ=UTC`, T8). Decide el orquestador. CA-9 (CI) lo confirma el orquestador tras el push.
Nivel de riesgo: C — `multer` y `fflate` procesan lo que suben los usuarios (`zip-seguro.ts`) y `fast-xml-parser` lee XML de terceros (UBL de 016 y `lector-xlsx.ts`). Son bibliotecas de E/S y de parseo: no tocan montos ni reglas de negocio. Nivel fijado por el usuario (2026-11-17).
Cubre: RNF-010 (dependencias revisadas; auditoría de vulnerabilidades en CI) · nota [dependencias] de `docs/specs/ESTADO.md`

## Objetivo
La auditoría de producción del 2026-11-17 (`pnpm audit --prod`, 291 dependencias) deja 6 avisos en 4 paquetes: `multer` (alta), `nodemailer` (tres moderadas), `fflate` (moderada) y `fast-xml-parser` (baja). Esta spec sube cada paquete a la versión parcheada más baja de su misma versión mayor y deja `pnpm audit --prod` sin avisos.

## Avisos y acción
Evidencia: `pnpm audit --prod --json`, `pnpm -r why <pkg>` y `pnpm view <pkg> time` (2026-11-17, 17:00 UTC).

| Paquete (hoy) | GHSA | Gravedad | Rango vulnerable | Parcheada (publicada) | Quién lo usa | Tipo | Acción |
|---|---|---|---|---|---|---|---|
| multer (2.4.0) | GHSA-q7qp-rjg7-q26m | alta | >=2.0.0 <2.5.0 | 2.5.0 (2026-10-22) | `@nestjs/platform-express` 12.2.0, directa en `apps/backend`; en `apps/worker` llega como peer de `@nestjs/core` | transitiva | Subir el padre: `@nestjs/platform-express` `^12.0.1` → `12.3.0` exacta (2026-10-27, trae multer 2.5.0). Sin override de multer. |
| nodemailer (10.1.0) | GHSA-8c8m-p3m8-cjg8 | moderada | >=3.0.0 <10.1.4 | 10.1.4 (2026-10-18) | `apps/backend` (`infra/correo/smtp.ts`) | directa | `nodemailer` `10.1.0` → `10.1.4` |
| nodemailer (10.1.0) | GHSA-m943-m63m-w62w | moderada | >=3.0.0 <10.1.4 | 10.1.4 (2026-10-18) | `apps/backend` | directa | Igual que la fila anterior |
| nodemailer (10.1.0) | GHSA-85x2-q946-cp5h | moderada | >=3.0.0 <10.1.4 | 10.1.4 (2026-10-18) | `apps/backend` | directa | Igual que la fila anterior |
| fflate (0.8.2) | GHSA-px8p-9vwx-vf98 | moderada | >=0.8.0 <0.8.3 | 0.8.3 (2026-05-16) | `apps/backend` (`zip-seguro.ts`, `plantilla.ts`, `escritor-xlsx.ts`) y `packages/sunat` (`empaquetar.ts`, lo usa el worker) | directa en 2 paquetes | `fflate` `0.8.2` → `0.8.3` en `apps/backend` y `packages/sunat` |
| fast-xml-parser (5.11.2) | GHSA-474x-hrwr-fgx4 | baja | <=5.11.2 | 5.12.0 (2026-11-03 12:15 UTC) | `packages/domain` (`ubl/leer.ts`, 016) y `apps/backend` (`modules/importacion/lector-xlsx.ts`) | directa en 2 paquetes | `fast-xml-parser` `5.11.2` → `5.12.0` en `packages/domain` y `apps/backend` |

Efectos de la resolución, sin aviso propio:
- `is-unsafe` (transitiva de fast-xml-parser): 5.12.0 exige `^2.0.3`, y el override de 007b (`2.0.2`) quedaría en conflicto. Se sube el override a `2.0.3` (publicada 2026-11-03 07:27 UTC, cumple 2 semanas). La 2.0.3 endurece la comprobación de entidades en contextos de marcado.
- `fast-xml-builder` (transitiva de 5.12.0, rango `^1.3.1`): sin override, pnpm elegiría 1.3.2 (publicada 2026-11-13, 4 días). Se fija `fast-xml-builder: 1.3.1` (publicada 2026-08-14). Sin aviso: es la regla de 2 semanas.
- `@nestjs/platform-express` en el worker: `@nestjs/core` declara `@nestjs/platform-express` como peer, y pnpm lo auto-instala en la versión más alta (12.5.1, 2026-11-16, 1 día) si nadie lo fija. Se fija `"@nestjs/platform-express": 12.3.0` en `overrides`. Sin esto, el worker resuelve 12.5.1 y el lock gana una versión que no cumple las dos semanas.
- `@nodable/entities` 3.1.0 (2026-09-29) y `strnum` 2.5.1 (2026-10-10) son la versión más alta de su rango: no necesitan override.

Alcanzabilidad (anotada; no justifica dejar avisos, todos se actualizan):
- GHSA-474x: el código corregido corre solo con `stopNodes`. `ubl/leer.ts` y `lector-xlsx.ts` no lo configuran (por defecto `[]`).
- GHSA-px8p: afecta a `unzipSync`. El código de producción usa `Inflate` (en `zip-seguro.ts`) y `zipSync`; `unzipSync` aparece solo en `apps/backend/test/`.
- `multer` no tiene uso directo en `apps/backend/src`: no hay `FileInterceptor` ni `UploadedFile`, y `app.ts` pone `bodyParser: false`.

## Alcance
- `apps/backend/package.json`: `fflate` `0.8.3`, `fast-xml-parser` `5.12.0` y `nodemailer` `10.1.4` (exactas, como hoy); `@nestjs/platform-express` `12.3.0` (exacta).
- `packages/sunat/package.json`: `fflate` `0.8.3`.
- `packages/domain/package.json`: `fast-xml-parser` `5.12.0`.
- `pnpm-workspace.yaml`, bloque `overrides`: `is-unsafe` `2.0.2` → `2.0.3` (comentario de 007b actualizado), nuevo `fast-xml-builder: 1.3.1` y nuevo `"@nestjs/platform-express": 12.3.0`, cada uno con comentario.
- `pnpm-lock.yaml` regenerado con `pnpm install`; no se edita a mano.
- Sin cambios de código fuente, de configuración de la app ni de la BD (sin migraciones).

## Fuera de alcance
- `@nestjs/core` y `@nestjs/common` se quedan en 12.2.0: el peer de `@nestjs/platform-express` 12.3.0 es `^12.0.0`.
- Versiones mayores: ninguna de las correcciones lo exige (multer 2.x, nodemailer 10.x, fflate 0.8.x, fast-xml-parser 5.x). Si alguna lo exigiera, la spec para y se reporta sin actualizar.
- `next` (ya en 039) y el `engines` de Node (`>=24.1.0 <25`).

## Criterios de aceptación
- [x] CA-1: `pnpm audit --prod` sale sin avisos (de 6 a 0).
- [x] CA-2: Toda versión que entra o cambia en el lock (directa, padre, override o transitiva) tiene al menos 2 semanas publicada (`pnpm view <pkg> time`). La lista va en `tasks.md`.
- [x] CA-3: Pruebas adversariales del parser XML en verde: `packages/domain/src/ubl/` (DOCTYPE, entidades, 1 MiB, profundidad 32, 2.000 ítems) y las `*.adv.spec.ts` de `apps/backend/src/modules/importacion/`.
- [ ] CA-4: `typecheck`, `lint` y pruebas unitarias en verde en todos los paquetes.
- [x] CA-5: Integración de `apps/backend` y `apps/worker` en verde, con BD propia `contapp_040`.
- [x] CA-6: `tests/aislamiento` en verde, con BD propia `contapp_040`.
- [x] CA-7: `typecheck`, `lint` y pruebas de `@contapp/frontend` en verde con `TZ=America/Lima` y con `TZ=UTC`.
- [x] CA-8: `pnpm e2e` completo y `pnpm e2e:volumen` en verde.
- [ ] CA-9: CI en verde tras el push. Esta ejecución no hace push: lo confirma el orquestador.

## Dependencias
- Specs: 039 (rama base `spec/039-actualizar-next`); 007b (origen de `fast-xml-parser`, `fflate` y el override de `is-unsafe`); 016 (parser UBL).
- Externas: registro npm (`pnpm view`, `pnpm audit`).
- Entorno: Node 22.22.0 (el `engines` pide 24, igual que en 039); Postgres 17 y Redis locales.

## Preguntas abiertas
- `fast-xml-parser` 5.12.0 cumple las dos semanas por unas 4 horas (publicada 2026-11-03 12:15 UTC). Se usa esa versión; 5.12.1 (2026-11-13) no se toma. El orquestador decide si lo acepta.
- `fflate` es directa también en `packages/sunat`, no solo en el backend como decía el brief. Se actualizan las dos.
- Nivel C: el brief dice que `multer` recibe los archivos de los usuarios, pero hoy ninguna ruta lo activa (ver arriba). La superficie real de subida es `zip-seguro.ts` (fflate) y `lector-xlsx.ts` (fast-xml-parser). Se mantiene el nivel C por decisión del usuario.
