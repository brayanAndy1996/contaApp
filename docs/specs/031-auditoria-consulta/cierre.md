# Cierre 031 · Consulta de auditoría con filtros e historial por cliente

Verificada el 2026-11-27 (T11). Nivel B con ronda adversarial acotada (D-8). Rama `claude/bold-gauss-nzljd6` sin mergear, sobre 030. Migración 0088 (siguiente libre: 0089). CI de GitHub sin ejecutar; sin PR (solo cuando el usuario lo pida).

## Qué entregó
- `GET /auditoria` filtra por usuario, cliente, acción y fechas, solos o combinados. El cursor `(ocurridaEn, id)` se reinicia al cambiar un filtro.
- Pantalla `configuracion/auditoria`: filtros en la URL, últimos 30 días por defecto o «todo el historial», y aviso de descifrados cuando hay filtro de usuario.
- Historial por cliente (HU-39): «Ver historial» en la ficha del cliente, solo con `auditoria.ver`.
- `GET /auditoria/opciones` (`auditoria.ver`) para los selectores de usuario y cliente.
- Alcance asignado aplicado también sin filtros. Corrige una brecha de 030: un rol propio con `auditoria.ver` y alcance asignado veía todo el estudio.
- Migración 0088: `auditoria_descifrado_listar` de 8 argumentos (sustituye la de 3 de 017), con el alcance dentro y antes del LIMIT; cuatro índices nuevos; `public.auditoria_ms` IMMUTABLE y LEAKPROOF, con EXECUTE solo para `contapp_worker`.

## Decisiones del usuario (2026-11-27)
- Nivel B, con ronda adversarial acotada.
- P-1 a P-6: opción a) en los seis, todas las recomendadas.
- Aprobó 12 cambios en las pruebas de 017 que adaptan el contrato de alcance (`07657a2`: `auditoria-operacion.spec.ts`, 10 casos; `lectura.spec.ts`, 2).

## Ronda adversarial (T9, probada en `474318b`)
- 54 casos (35 BD, 19 HTTP); sin fallos de alcance.
- 2 hallazgos bajos, corregidos en `9c49632` y cerrados en `HALLAZGOS.md`: H-1 (`q` con NUL daba 500, ahora 400) y H-2 (cursor con fecha imposible daba 200, ahora 400; el cursor es de 017 y lo comparte notificaciones).

## Criterios (T11, evidencia en `resultados.md`)
- CA-1 a CA-10 cumplidos, con prueba o comando por criterio. CA-9 por la medida del plan (escala de CPU y EXPLAIN por filtro); p95 informativo, todo < 300 ms con BD local.

## Riesgos y avisos
- Resuelto (7258f29): el enlace de `compra.operacion` usa `clientes.ver`, que ya existe en el catálogo y exige el destino.
- T7 editó `auditoria.service.spec.ts`, fuera de la regla de backend. Revisado: no se quitó ni relajó ninguna aserción; el unitario solo cubre alcance global (lo cubren BD y HTTP).
- `auditoria.e2e.ts` tenía 2 defectos de la propia prueba, corregidos en T11. No hay defecto de producción.
- Entorno: Node 22 (el repo pide ≥ 24.1) y sin Mailpit; se usó `E2E_CORREO=consola`.
- 5 fallos de `escalada.adv.spec.ts` (funciones de 025 a 028): el rol `contapp_pruebas` es superusuario del entorno. La suite de la base (`f907478`) falla igual contra `contapp_031t3`; no los causa 031.
- Rama distinta de la prevista (`spec/031-auditoria-consulta`) por restricción del entorno.
- Corrección posterior al cierre (7258f29): el enlace de `compra.operacion` usaba el permiso inexistente `compras.ver`; ahora `clientes.ver`. La verificación de T11 no lo detectó porque la prueba simulaba el permiso.

## Notas (van a `ESTADO.md`)
- [031] El enlace «Historial» usa `clientes.ver`; un permiso de compras separado exigiría otra spec.
- [031] `public.auditoria_ms` es LEAKPROOF: redefinirla o extenderla obliga a revisar los índices de `auditoria_descifrado`.
- [R2] De 017: filtros e historial por cliente quedaron en 031; la exportación sigue fuera (P-4).
