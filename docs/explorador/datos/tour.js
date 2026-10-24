/* Pasos del tour guiado, en orden de reproducción (el orden del arreglo ES el orden del tour).
   Esquema: ver LEEME-contenido.md. `target` = id de estación/zona, o null para la vista completa.
   Ejemplos completos: "intro" y "motor-reglas". El resto son stubs con `pendiente: true`. */
window.CONTAPP_DATA = window.CONTAPP_DATA || {};
window.CONTAPP_DATA.tour = [
  {
    id: "intro",
    target: null,
    titulo: "Bienvenido a la planta",
    texto: "Cada tarjetita de la cinta es un comprobante de tu cliente. Sale de SUNAT, se corrige, se clasifica y vuelve a SUNAT como archivo de reemplazo. Alrededor están las zonas que lo hacen posible."
  },
  { id: "sunat-entrada",     target: "sunat-entrada",     pendiente: true },
  { id: "descarga",          target: "descarga",          pendiente: true },
  {
    id: "motor-reglas",
    target: "motor-reglas",
    titulo: "El motor de reglas",
    texto: "Aquí se revisa cada comprobante. Caso real: base 21.48 con IGV 1.61. No cuadra ni con 18 % ni con 10 %, así que es una factura mixta: 8.97 gravado y 12.51 no gravado. El motor lo marca y tú decides.",
    vista: "contador",
    abrirPanel: true
  },
  { id: "lupa",              target: "lupa",              pendiente: true },
  { id: "clasificacion",     target: "clasificacion",     pendiente: true },
  { id: "prevalidacion",     target: "prevalidacion",     pendiente: true },
  { id: "zip",               target: "zip",               pendiente: true },
  { id: "sunat-salida",      target: "sunat-salida",      pendiente: true },
  { id: "edificio-estudios", target: "edificio-estudios", pendiente: true },
  { id: "recepcion",         target: "recepcion",         pendiente: true },
  { id: "boveda",            target: "boveda",            pendiente: true },
  { id: "torre-buzones",     target: "torre-buzones",     pendiente: true },
  { id: "balanza-prorrata",  target: "balanza-prorrata",  pendiente: true },
  { id: "cierre",            target: null,                pendiente: true }
];
