# Cierre 016 · Lupa del comprobante y XML

Spec `016-lupa-xml` · nivel A · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 016-lupa-xml | A | hecha | — | Mergeada en `main` (1c79486). Lupa del comprobante solo para compras (P-3): parser UBL seguro en `packages/domain/src/ubl/` (sin DOCTYPE/entidades, 1 MiB, 2.000 ítems, profundidad 32; XML ambiguos rechazados), `packages/storage` (mock/local, rutas `xml/{tenant}/{cliente}/{uuid}.xml`), tablas `documento_xml`, `documento_xml_obtencion` y `compra_evaluacion` (evaluación numerada, P-2), trabajo `xml.obtener` (credencial `null`, P-7) encolado tras la descarga por la función acotada `encolar_xml_obtener`, re-evaluación de reglas de 011 con XML de todo el comprobante, «Subir XML» (P-6) y «Agregar desde XML» (P-9: tipo de cambio en USD), aceptar re-evalúa con el XML vigente y la bandera `XML_SIMULADO_EN_REGLAS` (P-4), y la lupa en el frontend (nivel C) con «Editar» hacia la grilla. CA-1 a CA-18 con evidencia (T25); prueba manual T24 con 3 defectos de pantalla corregidos (T24a); revisión T26 aprobada. Rondas adversariales: H-016-1 a H-016-13 corregidos. Decisiones del usuario 2026-11-09/10: P-1–P-9, encolado acotado del worker, «Editar» desde la lupa y Enter en dos pasos. Migraciones 0035–0038. CI verde (run 42861865960). |

## Hallazgos adversariales

Hallazgos de las rondas adversariales: 2 cerrados, en [`../HALLAZGOS.md`](../HALLAZGOS.md) (filas de `016-lupa-xml`).

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [lupa de ventas] Spec corta que reutiliza el modal de 016 (P-3); en «Pendiente» la lupa no ofrece «Subir XML».
- [real] `RealXmlProvider` (rutas SOL «E…»/«F…», credencial y canal propios, 016 P-7); `documento_xml_obtencion` queda en `no_encontrado` tras subir; el texto de `transitorio` sigue tras agotar reintentos.
- [R2] PDF, «Recordar para este proveedor», R-ICB y R-HIS (016 P-8). Firma y CDR sin fuente en R1.
- [pruebas] Las limpiezas de soporte deben borrar las tablas de 013, 014 y 016 antes de borrar el estudio, o `planes.spec.ts` falla con estudios sin suscripción (016, 0e5440e).
