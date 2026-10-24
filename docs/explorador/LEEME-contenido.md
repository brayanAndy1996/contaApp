# Guía de contenido: La planta de ContApp

Cada agente edita **un solo archivo** de `datos/`. No toques `motor.js`, `index.html` ni `estilos.css`, y no dibujes SVG: la escena, sus posiciones y sus IDs ya existen.

| Archivo | Qué contiene | Ejemplo completo para copiar el estilo |
|---|---|---|
| `datos/estaciones.js` | Texto de cada estación o zona, en las dos vistas | `"motor-reglas"` |
| `datos/retos.js` | Los mini-retos | `"calculo-gravado"` (tipo `numero`) |
| `datos/tour.js` | Los pasos del tour guiado | `"intro"` y `"motor-reglas"` |

## Reglas generales
- Son JS clásico, no JSON. Las comillas dobles internas se escapan (`\"`). Valida con `node --check datos/<archivo>.js`.
- No cambies la primera línea (`window.CONTAPP_DATA = window.CONTAPP_DATA || {};`) ni la forma de asignar (`Object.assign(...)` o el arreglo del tour).
- Para completar un stub: quítale `pendiente: true` (o ponlo en `false`) y agrega los campos. Mientras siga `pendiente`, el motor muestra "Contenido en preparación".
- Formato de texto: solo `**negrita**` y `` `código` ``. Nada de HTML, porque se escapa y se vería literal.
- Tono: español peruano, claro, de tú, con frases cortas (unas 25 palabras como máximo). Usa los términos de SUNAT tal cual: SIRE, RCE/RVIE, propuesta, clave SOL, DG/DGNG/DNG, PDT 621, "procesado con errores", ticket. Usa montos reales de los docs con 2 decimales y el punto como separador decimal.
- No inventes funciones del producto. Si un dato no está en los docs, no lo pongas.
- La consola del navegador avisa (`[Planta ContApp] Revisa los datos`) cuando hay IDs mal escritos o retos incompletos.

## 1. Estación o zona (`datos/estaciones.js`): objeto con clave = id
```js
"lupa": {
  titulo: "Lupa (detalle con XML)",    // obligatorio, ≤ 35 car.
  icono: "🔍",                         // obligatorio, 1 emoji
  resumen: "…",                        // obligatorio, 1 frase ≤ 140 car.; se ve en las dos vistas
  contador: {                          // vista Contador: qué hace y por qué le importa
    queHace: "…",                      // obligatorio, 2–3 frases
    porQueImporta: "…",                // obligatorio, 1–3 frases
    reglas: [ { codigo: "R-ISC", nombre: "…", texto: "…", principal: true } ],  // 1–6; codigo puede ser ""
    ejemplo: {                         // muy recomendado: caso real con montos
      titulo: "…",
      filas: [ ["Etiqueta", "valor", "estado?"] ],   // estado opcional: "error" | "ok" | "clave"
      conclusion: "…"
    },
    puntos: ["…"]                      // opcional, 2–4 viñetas "Para recordar"
  },
  tecnica: {                           // vista Técnica: componentes, cola, puertos, seguridad
    resumen: "…",                      // obligatorio, 1–2 frases
    componentes: [ { nombre: "apps/worker", rol: "…" } ],      // 1–4
    colas:       [ { cola: "sire", trabajos: "sire.propuesta.descargar", nota: "concurrencia 4" } ], // 0–3, nota opcional
    puertos:     [ { nombre: "XmlProvider", rol: "…" } ],     // 0–3
    seguridad:   ["…"],                                        // 1–4
    fragmento:   { titulo: "…", codigo: "…" }                  // opcional, ≤ 8 líneas de pseudocódigo o SQL
  }
}
```
Una sección vacía no se muestra. Si falta una de las dos vistas, el panel indica que esa vista está en preparación.

## 2. Mini-reto (`datos/retos.js`): objeto con clave = id
Campos comunes: `tipo` (`opcion` | `clasificar` | `numero` | `encontrar`), `estacion` (id de la escena; así el reto aparece en el panel de esa estación), `titulo` (≤ 45 car.), `enunciado` (1–3 frases) y `explicacion` (cierre que se ve al comprobar). `pendiente` y `nota` son solo para los stubs: borra `nota` al completar el reto.

| tipo | Campos propios |
|---|---|
| `opcion` | `opciones: [{ texto, correcta: true/false, explicacion }]`: 3–4 opciones, **una** correcta, y cada una con su explicación (se muestran todas al comprobar). |
| `clasificar` | `categorias: [{ id, nombre, ayuda? }]` y `items: [{ texto, detalle?, categoria, explicacion }]`: 5–8 ítems, `categoria` = id de una categoría. Para DG/DGNG/DNG usa los ids `dg`, `dgng`, `dng`. |
| `numero` | `datos: [["Etiqueta","valor"]]`, `etiqueta`, `unidad` ("S/"), `respuesta` (número), `tolerancia` (por defecto 0.01) o `rango: [min, max]`, y `pista`. |
| `encontrar` | `modo: "error"`: `items: [{ texto, detalle?, error: true/false, explicacion? }]` con exactamente un `error: true`. `modo: "faltante"`: lista ordenada `items` y el que va **antes** del hueco lleva `faltaDespues: true`; se agrega `respuestaFaltante: "B001-291"`. |

El motor se encarga del arrastre, del teclado y de dar feedback por ítem. Tú solo pones los datos.

## 3. Paso del tour (`datos/tour.js`): arreglo, y el orden del arreglo es el orden del tour
```js
{ id: "lupa", target: "lupa", titulo: "…", texto: "…", vista: "contador", abrirPanel: false, duracion: 9000 }
```
- `target`: un id de la escena, o `null` para mostrar la planta completa. La cámara se acerca al elemento y lo resalta.
- `texto`: obligatorio, entre 25 y 55 palabras, narrado como un video ("Aquí…", "Fíjate…"). Debe tener un dato concreto.
- Campos opcionales: `vista` cambia la vista global, `abrirPanel` abre el detalle (solo en escritorio) y `duracion` está en ms (por defecto se calcula según el largo del texto).
- No cambies `id` ni `target` de los stubs: el orden ya está definido.

## 4. IDs pendientes y de dónde sacar el contenido
`D1` = `docs/01-definiciones-base.md`, `D3` = `docs/03-arquitectura.md`. Lee solo la sección indicada.

**Estaciones de la cinta** (en orden de recorrido)
| id | Fuente |
|---|---|
| `sunat-entrada` | D1 §5 (API SIRE, token), D3 §1 y §6.2 (límites SUNAT, reparto justo) |
| `descarga` | D3 §6.1 cola `sire`, §6.2, §6.3 (SSE), §6.4 (errores) |
| `lupa` | D1 §7 "Modal de detalle" y reglas 8, 15 y 16; D3 §6.1 cola `xml` |
| `clasificacion` | D1 §7 reglas 2–6 y 9 (DG/DGNG/DNG, selva, aprendizaje por proveedor, R-HIS) |
| `prevalidacion` | D1 §7 reglas 1, 10 y 11 (R-NUM, R-RED, "procesado con errores") |
| `zip` | D3 §6.1 cola `archivos` (`archivo.generar`), D3 §1 (Storage) |
| `sunat-salida` | D3 §6.1 (`sire.reemplazo.enviar`, `sire.ticket.consultar`), D1 §7 regla 6 (ajustes hasta febrero) |

**Zonas**
| id | Fuente |
|---|---|
| `edificio-estudios` | D1 §2 (cada piso es un estudio/tenant), D3 §4.1–4.3 (RLS, `withTenant`) |
| `recepcion` | D1 §4 (permisos, roles, asignación), D3 §4.4 (`ClientScopeGuard`) |
| `boveda` | D1 §5, D3 §5: **el backend solo cifra y solo el worker descifra**, AAD, auditoría de cada descifrado |
| `torre-buzones` | D1 §2 (buzón por cliente), §4 (buzón visible según asignación), D3 §6.1 cola `sol`/`programados` |
| `balanza-prorrata` | D1 §7 reglas 4 y 17 (prorrata desde el PDT 621, no desde el SIRE) |

**Retos** (stubs con `nota` que describe el caso)
| id | tipo | Fuente |
|---|---|---|
| `clasificar-selva` | clasificar | D1 §7 reglas 3–4 |
| `boleta-faltante` | encontrar (`modo: "faltante"`) | D1 §7 regla 1, tabla R-NUM |
| `san-juan-isc` | opcion | D1 §7 reglas 7 y 9, tabla R-ISC |

Puedes agregar retos nuevos (máximo uno por estación) con un id en kebab-case.

**Tour**: `sunat-entrada`, `descarga`, `lupa`, `clasificacion`, `prevalidacion`, `zip`, `sunat-salida`, `edificio-estudios`, `recepcion`, `boveda`, `torre-buzones`, `balanza-prorrata` y `cierre` (`target: null`: resumen de todo y una invitación a los retos). Usa las mismas fuentes que la estación o zona correspondiente.
