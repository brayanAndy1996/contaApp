# Curso ContApp en versión web

Página estática generada desde los `.md` de `docs/curso/`. Se abre con doble clic en `index.html`; no necesita servidor ni internet (sin internet usa las fuentes del sistema).

| Archivo | Qué es |
|---|---|
| `index.html` | La página. |
| `curso.css` | Estilos (tema claro y oscuro). |
| `curso.js` | Índice, rutas `#m00` a `#m15`, buscador, avance (en el navegador), ejercicios como tarjetas y botón «Copiar». |
| `simuladores.js` | Simuladores interactivos: `rls` (03), `dinero` (08) y `correlatividad` (11). |
| `contenido.js` | **Generado.** No editar a mano. |
| `construir.mjs` | Convierte los `.md` en `contenido.js` con `herramientas/marked.cjs` (marked 12.0.2, licencia MIT en `herramientas/marked-LICENSE.md`). |

## Después de cambiar un `.md`

```bash
pnpm curso:web
```

## Agregar un simulador

1. Escribe una función `window.SIMULADORES.nombre = function (lugar) { … }` en `simuladores.js`.
2. Pon `<!-- simulador: nombre -->` en el `.md`, en su propia línea, donde debe aparecer. En GitHub no se ve.
3. Reconstruye con `pnpm curso:web`.

Los simuladores son modelos didácticos que siguen las reglas del código real (cada uno cita su archivo); no llaman al backend ni a la base de datos.
