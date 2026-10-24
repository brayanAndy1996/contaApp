/* Contenido de estaciones y zonas de la planta.
   Esquema: ver LEEME-contenido.md. Solo texto: el dibujo vive en motor.js. */
window.CONTAPP_DATA = window.CONTAPP_DATA || {};
window.CONTAPP_DATA.estaciones = Object.assign(window.CONTAPP_DATA.estaciones || {}, {

  /* ===================== EJEMPLO COMPLETO DE REFERENCIA ===================== */
  "motor-reglas": {
    titulo: "Motor de reglas",
    icono: "⚙️",
    resumen: "Revisa cada comprobante de la propuesta y marca lo que no cuadra, antes de que tú lo revises.",
    contador: {
      queHace: "Apenas llega la propuesta del SIRE, el motor pasa cada comprobante por un juego de reglas. Si algo no cuadra, la fila queda marcada con la **regla que lo detectó** y una **corrección sugerida**. No cambia nada por su cuenta: tú aceptas, editas o descartas.",
      porQueImporta: "El SIRE manda todo a **DG** por defecto y no revisa si el IGV cuadra con la base. Si declaras así, el reemplazo puede salir **\"procesado con errores\"** o tu cliente usa un crédito fiscal que no le corresponde.",
      reglas: [
        { codigo: "R-MIX", nombre: "Factura mixta", principal: true,
          texto: "Si el IGV no cuadra con 18 % ni con 10 % de la base, la factura probablemente mezcla gravado y no gravado. Se propone **gravado = IGV ÷ tasa** y **no gravado = base − gravado**, y se confirma con el XML." },
        { codigo: "R-ISC", nombre: "ISC mal ubicado", texto: "Base gravada con IGV 0, o proveedor que emite ISC (ej. cerveza): el monto se mueve a ISC." },
        { codigo: "R-RED", nombre: "Redondeo", texto: "La suma de las partes no da el total (típico en dólares por el tipo de cambio): se ajusta a 2 decimales como lo valida SUNAT." },
        { codigo: "R-NUM", nombre: "Numeración", texto: "Salto en la correlatividad de ventas (ej. B001-290 → B001-292): alerta de comprobante faltante." },
        { codigo: "R-NEW", nombre: "Proveedor nuevo", texto: "RUC que el cliente nunca tuvo: te pide clasificarlo y aprende tu decisión." },
        { codigo: "", nombre: "Gasto personal", texto: "La glosa del XML (\"zapatillas…\") delata un gasto del dueño: lo excluyes con un clic." }
      ],
      ejemplo: {
        titulo: "Caso real: factura de S/ 23.09",
        filas: [
          ["Base imponible en la propuesta", "21.48"],
          ["IGV en la propuesta", "1.61"],
          ["IGV esperado al 18 % (21.48 × 0.18)", "3.87 ✗", "error"],
          ["IGV esperado al 10 % (21.48 × 0.10)", "2.15 ✗", "error"],
          ["Gravado = 1.61 ÷ 0.18 (el XML precisa)", "8.97", "clave"],
          ["No gravado = 21.48 − 8.97", "12.51", "clave"],
          ["Control: 8.97 × 0.18", "1.61 ✓", "ok"]
        ],
        conclusion: "La factura era **mixta**. 1.61 ÷ 0.18 da 8.94, pero como el IGV viene redondeado, cualquier gravado entre 8.92 y 8.97 da 1.61; el XML confirma **8.97**. Sin esta corrección, el ajuste posterior sale \"procesado con errores\"."
      }
    },
    tecnica: {
      resumen: "Lógica pura en `packages/domain` (sin BD, HTTP ni SUNAT, se prueba sola). La ejecuta el worker al terminar la descarga y el backend al aplicar una corrección.",
      componentes: [
        { nombre: "packages/domain", rol: "Reglas R-* como funciones puras: reciben la fila y devuelven hallazgos y la fila sugerida." },
        { nombre: "apps/worker", rol: "Tras `sire.propuesta.descargar`, corre las reglas sobre todas las filas y guarda los hallazgos." },
        { nombre: "apps/backend", rol: "Aplica la corrección que acepta el contador y la deja en auditoría (valor anterior → nuevo)." }
      ],
      colas: [
        { cola: "sire", trabajos: "sire.propuesta.descargar → dispara la evaluación de reglas", nota: "concurrencia 4" },
        { cola: "xml", trabajos: "xml.obtener → confirma R-MIX, R-ISC y R-ICB", nota: "concurrencia 8" }
      ],
      puertos: [
        { nombre: "XmlProvider", rol: "Fuente del XML para confirmar la regla: mock ahora, real después." }
      ],
      seguridad: [
        "Toda lectura y escritura pasa por `withTenant`: RLS filtra por `tenant_id` (falla cerrado si no está fijado).",
        "El motor nunca toca credenciales: trabaja sobre filas ya descargadas.",
        "Cada sugerencia aceptada o editada queda en auditoría con usuario y fecha."
      ],
      fragmento: {
        titulo: "R-MIX (pseudocódigo)",
        codigo: "cuadra = [0.18, 0.10].some(t => abs(base*t - igv) <= tol)\nif (!cuadra && igv > 0) {\n  gravado   = round2(igv / 0.18)   // 8.94 ≈ 8.97 (XML)\n  noGravado = round2(base - gravado)\n  hallazgo('R-MIX', { gravado, noGravado, requiereXml: true })\n}"
      }
    }
  },

  /* ===================== STUBS PENDIENTES (estaciones de la cinta) ===================== */
  "sunat-entrada": { titulo: "SUNAT (propuesta)", icono: "🏛️", pendiente: true },
  "descarga":      { titulo: "Descarga", icono: "📥", pendiente: true },
  "lupa":          { titulo: "Lupa (detalle con XML)", icono: "🔍", pendiente: true },
  "clasificacion": { titulo: "Clasificación DG / DGNG / DNG", icono: "🗂️", pendiente: true },
  "prevalidacion": { titulo: "Prevalidación", icono: "✅", pendiente: true },
  "zip":           { titulo: "Archivo TXT / ZIP", icono: "📦", pendiente: true },
  "sunat-salida":  { titulo: "SUNAT (reemplazo)", icono: "📤", pendiente: true },

  /* ===================== STUBS PENDIENTES (zonas alrededor) ===================== */
  "edificio-estudios": { titulo: "Edificio de estudios", icono: "🏢", pendiente: true },
  "recepcion":         { titulo: "Recepción: roles y asignación", icono: "🛎️", pendiente: true },
  "boveda":            { titulo: "Bóveda de credenciales", icono: "🔐", pendiente: true },
  "torre-buzones":     { titulo: "Torre de buzones SOL", icono: "📬", pendiente: true },
  "balanza-prorrata":  { titulo: "Balanza de prorrata", icono: "⚖️", pendiente: true }
});
