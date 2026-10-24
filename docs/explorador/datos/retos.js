/* Mini-retos. Tipos: "opcion", "clasificar", "numero", "encontrar".
   Esquema: ver LEEME-contenido.md. Cada reto se vincula con `estacion`. */
window.CONTAPP_DATA = window.CONTAPP_DATA || {};
window.CONTAPP_DATA.retos = Object.assign(window.CONTAPP_DATA.retos || {}, {

  /* ===================== EJEMPLO COMPLETO DE REFERENCIA ===================== */
  "calculo-gravado": {
    tipo: "numero",
    estacion: "motor-reglas",
    titulo: "¿Cuánto es la parte gravada?",
    enunciado: "Esta compra llegó en la propuesta con una base de **21.48** y un IGV de **1.61**. El IGV no cuadra con 18 % (3.87) ni con 10 % (2.15). Aplica la regla R-MIX: ¿cuál es la base **gravada**?",
    datos: [
      ["Base imponible (propuesta)", "21.48"],
      ["IGV (propuesta)", "1.61"],
      ["Tasa a usar", "18 %"]
    ],
    etiqueta: "Base gravada",
    unidad: "S/",
    respuesta: 8.97,
    tolerancia: 0.03,
    rango: [8.92, 8.97],
    pista: "Divide el IGV entre la tasa: 1.61 ÷ 0.18.",
    explicacion: "1.61 ÷ 0.18 = **8.94**, y el XML precisa **8.97** (el IGV viene redondeado: cualquier gravado entre 8.92 y 8.97 da 1.61). El resto, 21.48 − 8.97 = **12.51**, es no gravado. Con esa separación la fila cuadra y el reemplazo no sale \"procesado con errores\"."
  },

  /* ===================== STUBS PENDIENTES ===================== */
  "clasificar-selva": {
    tipo: "clasificar",
    estacion: "clasificacion",
    titulo: "Compras de un cliente de la selva",
    pendiente: true,
    nota: "Cliente de Huánuco con ventas exoneradas: la mayoría de compras va a DNG; casos puntuales en DG o DGNG (ej. alquiler de un local secundario). 6–8 ítems."
  },
  "boleta-faltante": {
    tipo: "encontrar",
    estacion: "prevalidacion",
    titulo: "¿Qué boleta falta?",
    pendiente: true,
    nota: "Ventas serie B001 del 287 al 295 con la B001-291 faltante (caso real: el contador declaró sin notarlo). Usar modo \"faltante\". Regla R-NUM."
  },
  "san-juan-isc": {
    tipo: "opcion",
    estacion: "lupa",
    titulo: "La cerveza que llegó a DG",
    pendiente: true,
    nota: "Compra de cerveza (Cervecería San Juan) con 770 en DG e IGV 0. Respuesta correcta: mover el monto a ISC (regla R-ISC; proveedor con error típico en el catálogo global)."
  }
});
