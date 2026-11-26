# Cierre 038 · Diseño visual (estilo A, verde petróleo)

Spec `038-diseno-visual` · nivel C · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 038-diseno-visual | C | hecha | — | Mergeada en `main` (d1cc8fd). Estilo A (verde petróleo) en todas las pantallas: menú lateral en escritorio y barra inferior en celular (P-5), «Ventas» desde la ficha del cliente (P-4), grillas con sus alturas (P-2), compras en celular con desplazamiento y «Generar archivo» fijo (P-3), diálogos propios estilados (P-6). Prueba `diseno.estatico.spec.ts` contra colores sueltos. Revisión en navegador (P-7) en 70 vistas a 1440/390 px sobre el build de producción: sin desbordes, contraste AA, foco visible, objetivos de 44 px. E2E 88 + volumen en verde. Modo oscuro fuera (P-1). |

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [frontend] De 038: en el historial de la compra a 390 px «Valor vigente» queda algo cortado (la tabla desplaza 37 px sin pista); los nombres largos de proveedor se truncan con «…»; en las filas de ventas (36 px) las áreas táctiles de 44 px de filas vecinas se solapan 8 px.
