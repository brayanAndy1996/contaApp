// Simuladores del curso. Cada uno se monta donde un .md tenga `<!-- simulador: nombre -->`.
// Son modelos didácticos que siguen las reglas del código real (se cita el archivo en cada uno);
// no llaman al backend ni a la base de datos.
(function () {
  "use strict";
  const crear = (etiqueta, props, hijos) => {
    const el = document.createElement(etiqueta);
    Object.assign(el, props || {});
    for (const h of [].concat(hijos || [])) if (h !== null && h !== undefined) el.append(h);
    return el;
  };
  let contador = 0;
  const nuevoId = (base) => `${base}-${++contador}`;

  function marco(lugar, titulo, explicacion) {
    const cuerpo = crear("div", { className: "sim-cuerpo" });
    lugar.replaceChildren(
      crear("div", { className: "sim-cabecera" }, [
        crear("span", { className: "sim-etiqueta", textContent: "Simulador" }),
        crear("h3", { className: "sim-titulo", textContent: titulo }),
      ]),
      cuerpo,
    );
    if (explicacion) cuerpo.append(crear("p", { className: "sim-ayuda", textContent: explicacion }));
    return cuerpo;
  }
  function campo(etiqueta, control) {
    control.id = control.id || nuevoId("sim");
    return crear("label", { className: "sim-campo", htmlFor: control.id }, [crear("span", { textContent: etiqueta }), control]);
  }
  function pestanas(cuerpo, nombres, alCambiar) {
    const barra = crear("div", { className: "sim-pestanas", role: "tablist" });
    const botones = nombres.map((n, i) => {
      const b = crear("button", { type: "button", role: "tab", textContent: n });
      b.setAttribute("aria-selected", String(i === 0));
      b.addEventListener("click", () => {
        botones.forEach((x) => x.setAttribute("aria-selected", String(x === b)));
        alCambiar(i);
      });
      return b;
    });
    barra.append(...botones);
    cuerpo.append(barra);
  }
  function veredicto(tipo, html) {
    return crear("div", { className: "sim-veredicto " + tipo, innerHTML: html });
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ===================================================================================
  // Dinero exacto: decimales como BigInt escalado (lo que hace Money con decimal.js).
  // ===================================================================================
  const RE_MONTO = /^-?\d{1,12}(\.\d{1,6})?$/;
  function leerDecimal(texto) {
    const t = String(texto).trim();
    if (!RE_MONTO.test(t)) return null;
    const neg = t.startsWith("-");
    const [ent, dec = ""] = t.replace("-", "").split(".");
    const v = BigInt(ent + dec);
    return { v: neg ? -v : v, e: dec.length };
  }
  const p10 = (n) => 10n ** BigInt(n);
  function aEscala(d, e) {
    return d.v * p10(e - d.e);
  }
  function textoDecimal(v, e) {
    const neg = v < 0n;
    let s = (neg ? -v : v).toString().padStart(e + 1, "0");
    const r = e ? s.slice(0, -e) + "." + s.slice(-e) : s;
    return (neg ? "-" : "") + r;
  }
  // Half-up alejándose de cero, como redondearSunat (packages/domain/src/dinero/redondeo.ts).
  function aCentimos(v, e) {
    if (e <= 2) return v * p10(2 - e);
    const d = p10(e - 2);
    const neg = v < 0n;
    const a = neg ? -v : v;
    let q = a / d;
    if (2n * (a % d) >= d) q += 1n;
    return neg ? -q : q;
  }
  const soles = (c) => textoDecimal(c, 2);

  window.SIMULADORES = window.SIMULADORES || {};

  window.SIMULADORES.dinero = function (lugar) {
    const cuerpo = marco(
      lugar,
      "number contra Money",
      "Cambia los valores y compara lo que hace JavaScript con number y lo que hace ContApp con montos exactos y el redondeo SUNAT.",
    );
    const zona = crear("div", { className: "sim-cuerpo", style: "padding:0" });
    const vistas = [vistaSuma, vistaIgv, vistaCuadre];
    pestanas(cuerpo, ["Sumar céntimos", "IGV y redondeo", "¿Cuadra el comprobante?"], (i) => vistas[i]());
    cuerpo.append(zona);
    vistaSuma();

    function vistaSuma() {
      const monto = crear("input", { type: "text", value: "0.10", inputMode: "decimal" });
      const veces = crear("input", { type: "text", value: "10", inputMode: "numeric" });
      const salida = crear("div", { className: "sim-cuerpo", style: "padding:0" });
      const calcular = () => {
        const d = leerDecimal(monto.value);
        const k = /^\d{1,4}$/.test(veces.value.trim()) ? Number(veces.value.trim()) : NaN;
        if (!d || !(k >= 1 && k <= 5000)) {
          salida.replaceChildren(veredicto("error", "Escribe un monto como <code>0.10</code> (punto decimal) y un número de veces entre 1 y 5000."));
          return;
        }
        let s = 0;
        for (let i = 0; i < k; i++) s += Number(monto.value.trim());
        const exacto = textoDecimal(d.v * BigInt(k), d.e);
        const igual = s === Number(exacto) && String(s) === String(Number(exacto));
        salida.replaceChildren(
          crear("div", { className: "sim-comparar" }, [
            crear("div", { className: "sim-caja " + (igual ? "buena" : "mala") }, [
              crear("h4", { textContent: "Con number (s += monto)" }),
              crear("div", { className: "sim-cifra", textContent: String(s) }),
            ]),
            crear("div", { className: "sim-caja buena" }, [
              crear("h4", { textContent: "Con montos exactos" }),
              crear("div", { className: "sim-cifra", textContent: exacto }),
            ]),
          ]),
          igual
            ? veredicto("ok", "Esta vez coinciden. Prueba con <code>0.10</code> diez veces o <code>0.01</code> cien veces.")
            : veredicto("error", `<strong>No coinciden.</strong> number guarda ${esc(monto.value.trim())} en binario como una aproximación, y al sumar ${k} veces el error asoma.`),
        );
      };
      monto.addEventListener("input", calcular);
      veces.addEventListener("input", calcular);
      const ejemplos = crear("div", { className: "sim-ejemplos" }, ["Ejemplos:"]);
      for (const [m, k] of [["0.10", "10"], ["0.01", "100"], ["0.20", "3"], ["0.25", "4"]]) {
        const b = crear("button", { type: "button", textContent: `${m} × ${k}` });
        b.addEventListener("click", () => {
          monto.value = m;
          veces.value = k;
          calcular();
        });
        ejemplos.append(b);
      }
      zona.replaceChildren(crear("div", { className: "sim-controles" }, [campo("Monto (S/)", monto), campo("Veces que se suma", veces)]), ejemplos, salida);
      calcular();
    }

    function vistaIgv() {
      const base = crear("input", { type: "text", value: "2.25", inputMode: "decimal" });
      const tasa = crear("select");
      tasa.append(crear("option", { value: "18", textContent: "18 %" }), crear("option", { value: "10", textContent: "10 %" }));
      const salida = crear("div", { className: "sim-cuerpo", style: "padding:0" });
      const calcular = () => {
        const d = leerDecimal(base.value);
        if (!d || d.e > 2) {
          salida.replaceChildren(veredicto("error", "Money solo acepta montos con hasta 2 decimales y punto decimal, por ejemplo <code>2.25</code> o <code>-8.94</code>."));
          return;
        }
        const t = BigInt(tasa.value);
        const exacto4 = aEscala(d, 2) * t; // base en céntimos × tasa = escala 4
        const sunat = aCentimos(exacto4, 4);
        const f = Number(base.value.trim()) * (Number(tasa.value) / 100);
        const fixed = f.toFixed(2);
        const redondeoComun = String(Math.round(f * 100) / 100);
        const bienFixed = fixed === soles(sunat) || (fixed === "-0.00" && sunat === 0n);
        salida.replaceChildren(
          crear("div", { className: "sim-comparar" }, [
            crear("div", { className: "sim-caja " + (bienFixed ? "" : "mala") }, [
              crear("h4", { textContent: "Con number" }),
              crear("div", { className: "sim-fila" }, [crear("span", { textContent: "base × tasa" }), crear("span", { textContent: String(f) })]),
              crear("div", { className: "sim-fila" }, [crear("span", { textContent: ".toFixed(2)" }), crear("span", { textContent: fixed })]),
              crear("div", { className: "sim-fila" }, [crear("span", { textContent: "Math.round(x*100)/100" }), crear("span", { textContent: redondeoComun })]),
            ]),
            crear("div", { className: "sim-caja buena" }, [
              crear("h4", { textContent: "Con ContApp" }),
              crear("div", { className: "sim-fila" }, [crear("span", { textContent: "MontoExacto" }), crear("span", { textContent: textoDecimal(exacto4, 4) })]),
              crear("div", { className: "sim-fila" }, [crear("span", { textContent: "redondearSunat" }), crear("span", { textContent: soles(sunat) })]),
              crear("div", { className: "sim-cifra", textContent: "IGV S/ " + soles(sunat) }),
            ]),
          ]),
          bienFixed
            ? veredicto("ok", "Aquí <code>toFixed(2)</code> acierta, pero por casualidad. Prueba la base <code>2.25</code>: el exacto es 0.4050 y SUNAT sube a 0.41.")
            : veredicto("error", `<strong>toFixed(2) da ${esc(fixed)}, SUNAT da ${soles(sunat)}.</strong> En binario el resultado queda un pelo por debajo del medio céntimo y toFixed redondea hacia abajo.`),
        );
      };
      base.addEventListener("input", calcular);
      tasa.addEventListener("change", calcular);
      const ejemplos = crear("div", { className: "sim-ejemplos" }, ["Ejemplos:"]);
      for (const b of ["2.25", "-2.25", "8.94", "21.48", "0.03"]) {
        const btn = crear("button", { type: "button", textContent: b });
        btn.addEventListener("click", () => {
          base.value = b;
          calcular();
        });
        ejemplos.append(btn);
      }
      zona.replaceChildren(crear("div", { className: "sim-controles" }, [campo("Base imponible (S/)", base), campo("Tasa", tasa)]), ejemplos, salida);
      calcular();
    }

    function vistaCuadre() {
      const campos = {
        bi: crear("input", { type: "text", value: "21.48", inputMode: "decimal" }),
        igv: crear("input", { type: "text", value: "1.61", inputMode: "decimal" }),
        ng: crear("input", { type: "text", value: "0.00", inputMode: "decimal" }),
        total: crear("input", { type: "text", value: "23.09", inputMode: "decimal" }),
      };
      const salida = crear("div", { className: "sim-cuerpo", style: "padding:0" });
      const calcular = () => {
        const d = {};
        for (const k in campos) {
          d[k] = leerDecimal(campos[k].value);
          if (!d[k] || d[k].e > 2) {
            salida.replaceChildren(veredicto("error", "Todos los montos van con hasta 2 decimales y punto decimal."));
            return;
          }
        }
        const c = Object.fromEntries(Object.entries(d).map(([k, x]) => [k, aEscala(x, 2)]));
        const suma = c.bi + c.igv + c.ng;
        const diferencia = c.total - suma;
        const esperado = (t) => aCentimos(c.bi * BigInt(t), 4);
        const e18 = esperado(18);
        const e10 = esperado(10);
        const abs = (x) => (x < 0n ? -x : x);
        const cuadra18 = abs(c.igv - e18) <= 1n;
        const cuadra10 = abs(c.igv - e10) <= 1n;
        const numberSuma = Number(campos.bi.value) + Number(campos.igv.value) + Number(campos.ng.value);
        const items = [];
        items.push(
          diferencia === 0n
            ? veredicto("ok", `<strong>Cuadre:</strong> ${soles(c.bi)} + ${soles(c.igv)} + ${soles(c.ng)} = ${soles(suma)}, igual al total (tolerancia 0.00).`)
            : veredicto("error", `<strong>CUADRE:</strong> el total es ${soles(c.total)} y los componentes suman ${soles(suma)}. Diferencia ${soles(diferencia)}. Bloquea la generación.`),
        );
        if (c.igv === 0n && c.bi !== 0n)
          items.push(veredicto("aviso", `<strong>Aviso R-ISC:</strong> base gravada ${soles(c.bi)} con IGV 0.00. No bloquea (D18 de 012); puede ser un ISC mal registrado, como el caso San Juan.`));
        else if (cuadra18 || cuadra10)
          items.push(veredicto("ok", `<strong>IGV:</strong> ${soles(c.igv)} cuadra con el ${cuadra18 ? "18 %" : "10 %"} de ${soles(c.bi)} (esperado ${soles(cuadra18 ? e18 : e10)}, tolerancia ±0.01).`));
        else
          items.push(veredicto("error", `<strong>IGV:</strong> «${soles(c.igv)} no es 18 % ni 10 % de ${soles(c.bi)}». Esperado ${soles(e18)} (18 %) o ${soles(e10)} (10 %). Bloquea la generación.`));
        items.push(
          crear("p", {
            className: "sim-ayuda",
            innerHTML: `Con number, la suma de componentes da <code>${esc(String(numberSuma))}</code>${String(numberSuma) === soles(suma) ? "" : " en vez de " + soles(suma)}.`,
          }),
        );
        salida.replaceChildren(...items);
      };
      for (const k in campos) campos[k].addEventListener("input", calcular);
      const ejemplos = crear("div", { className: "sim-ejemplos" }, ["Casos del curso:"]);
      const casos = [
        ["Mixta sin corregir", ["21.48", "1.61", "0.00", "23.09"]],
        ["Mixta corregida", ["8.97", "1.61", "12.51", "23.09"]],
        ["San Juan", ["770.00", "0.00", "0.00", "770.00"]],
        ["Descuadre de 0.01", ["100.00", "18.00", "0.00", "118.01"]],
      ];
      for (const [nombre, v] of casos) {
        const b = crear("button", { type: "button", textContent: nombre });
        b.addEventListener("click", () => {
          [campos.bi.value, campos.igv.value, campos.ng.value, campos.total.value] = v;
          calcular();
        });
        ejemplos.append(b);
      }
      zona.replaceChildren(
        crear("div", { className: "sim-controles" }, [
          campo("Base gravada (BI DG)", campos.bi),
          campo("IGV", campos.igv),
          campo("No gravado", campos.ng),
          campo("Total del comprobante", campos.total),
        ]),
        ejemplos,
        salida,
      );
      calcular();
    }
  };

  // ===================================================================================
  // RLS: el portero del sótano. Modelo de 0002_rls_y_grants.sql y withTenant (with-tenant.ts).
  // ===================================================================================
  window.SIMULADORES.rls = function (lugar) {
    const ESTUDIOS = {
      A: { nombre: "Estudio Quispe", uuid: "0a1b…a001", chip: "a" },
      B: { nombre: "Contadores Huamán", uuid: "0b2c…b002", chip: "b" },
      C: { nombre: "Estudio Rojas", uuid: "0c3d…c003", chip: "c" },
    };
    const filas = [
      { ruc: "20700000011", razon: "Comercial San Juan SAC", t: "A" },
      { ruc: "20700000045", razon: "Distribuidora Mixta EIRL", t: "A" },
      { ruc: "20700000053", razon: "Bodega Rímac SAC", t: "B" },
      { ruc: "20700000061", razon: "Transportes Lurín SRL", t: "B" },
      { ruc: "20700000070", razon: "Agroexport Chancay SA", t: "C" },
    ];
    let siguienteRuc = 20700000088;
    let ultimaNueva = null;

    const cuerpo = marco(
      lugar,
      "El portero de RLS",
      "Elige con qué rol te conectas y qué carnet (app.tenant_id) muestras. Luego ejecuta una consulta y mira qué filas te alcanza PostgreSQL.",
    );
    const rol = crear("select");
    rol.append(
      crear("option", { value: "backend", textContent: "contapp_backend (vía withTenant)" }),
      crear("option", { value: "app", textContent: "contapp_app (sin SET ROLE)" }),
      crear("option", { value: "postgres", textContent: "postgres (superusuario)" }),
    );
    const carnet = crear("select");
    carnet.append(crear("option", { value: "", textContent: "Ninguno (olvidé withTenant)" }));
    for (const [k, e] of Object.entries(ESTUDIOS)) carnet.append(crear("option", { value: k, textContent: `${e.nombre} (${k})` }));
    carnet.value = "A";
    const operacion = crear("select");
    operacion.append(
      crear("option", { value: "select", textContent: "Leer: SELECT * FROM cliente" }),
      crear("option", { value: "insert-propio", textContent: "Guardar un cliente de mi estudio" }),
      crear("option", { value: "insert-ajeno", textContent: "Guardar un cliente con la etiqueta de otro estudio" }),
    );
    const verOcultas = crear("input", { type: "checkbox", id: nuevoId("ocultas") });
    const ejecutar = crear("button", { type: "button", className: "boton boton-primario", textContent: "Ejecutar" });
    const salida = crear("div", { className: "sim-cuerpo", style: "padding:0" });

    cuerpo.append(
      crear("div", { className: "sim-controles" }, [campo("Rol de la conexión", rol), campo("Carnet: app.tenant_id", carnet), campo("Operación", operacion)]),
      crear("div", { className: "sim-ejemplos" }, [
        ejecutar,
        crear("label", { htmlFor: verOcultas.id, style: "display:flex;gap:.4rem;align-items:center" }, [verOcultas, "Mostrar lo que el portero oculta"]),
      ]),
      salida,
    );
    rol.addEventListener("change", () => (carnet.disabled = rol.value !== "backend"));

    function sqlDe(r, t, op, etiqueta) {
      const consulta =
        op === "select"
          ? "SELECT ruc, razon_social, tenant_id FROM cliente;"
          : `INSERT INTO cliente (ruc, razon_social${op === "insert-ajeno" ? ", tenant_id" : ""})\n  VALUES ('${siguienteRuc}', 'Cliente nuevo SAC'${op === "insert-ajeno" ? `, '${ESTUDIOS[etiqueta].uuid}'` : ""});`;
      if (r !== "backend") return `-- conectado como ${r === "app" ? "contapp_app" : "postgres"}\n${consulta}`;
      return [
        "BEGIN;",
        "SET LOCAL ROLE contapp_backend;",
        `SELECT set_config('app.tenant_id', '${t ? ESTUDIOS[t].uuid : ""}', true);`,
        consulta,
        "COMMIT;",
      ].join("\n");
    }

    function tablaFilas(visibles, mostrarOcultas) {
      const tbody = crear("tbody");
      for (const f of filas) {
        const ve = visibles(f);
        if (!ve && !mostrarOcultas) continue;
        const tr = crear("tr", { className: (ve ? "visible" : "oculta") + (f === ultimaNueva ? " nueva" : "") });
        tr.append(
          crear("td", { className: "mono", textContent: f.ruc }),
          crear("td", { textContent: f.razon }),
          crear("td", {}, [crear("span", { className: "chip " + ESTUDIOS[f.t].chip, textContent: ESTUDIOS[f.t].nombre })]),
        );
        tbody.append(tr);
      }
      const tabla = crear("table");
      tabla.append(
        crear("thead", {}, [crear("tr", {}, [crear("th", { textContent: "ruc" }), crear("th", { textContent: "razon_social" }), crear("th", { textContent: "tenant_id (etiqueta)" })])]),
        tbody,
      );
      return crear("div", { className: "sim-tabla" }, [tabla]);
    }

    function correr() {
      const r = rol.value;
      const t = r === "backend" ? carnet.value : "";
      const op = operacion.value;
      const otros = Object.keys(ESTUDIOS).filter((k) => k !== t);
      const etiqueta = op === "insert-ajeno" ? otros[0] : t;
      const partes = [crear("pre", { className: "sim-sql", textContent: sqlDe(r, t, op, etiqueta) })];
      const mostrar = verOcultas.checked;

      if (r === "app") {
        partes.push(veredicto("error", "<strong>ERROR: permission denied for table cliente.</strong> El rol de login no tiene permisos sobre las tablas: primer candado. Solo puede hacer SET ROLE."));
      } else if (r === "postgres") {
        if (op === "select") {
          partes.push(veredicto("aviso", `<strong>${filas.length} filas, de todos los estudios.</strong> El superusuario se salta RLS incluso con FORCE. Por eso la app nunca se conecta como postgres.`));
          partes.push(tablaFilas(() => true, false));
        } else {
          partes.push(veredicto("aviso", "<strong>INSERT 0 1.</strong> El superusuario escribe donde quiera, sin pasar por el portero. La app jamás usa este rol."));
        }
      } else if (!t) {
        if (op === "select") {
          partes.push(veredicto("ok", "<strong>0 filas.</strong> Sin carnet, <code>tenant_id = NULL</code> nunca es verdadero: la política falla cerrada. Lo peor de olvidar withTenant es una pantalla vacía, nunca datos ajenos."));
          if (mostrar) partes.push(tablaFilas(() => false, true));
        } else {
          partes.push(veredicto("ok", "<strong>ERROR: new row violates row-level security policy for table \"cliente\".</strong> Sin carnet, WITH CHECK rechaza cualquier fila nueva."));
        }
      } else if (op === "select") {
        const n = filas.filter((f) => f.t === t).length;
        partes.push(veredicto("ok", `<strong>${n} filas.</strong> USING (tenant_id = app.tenant_id) solo deja pasar las filas de ${esc(ESTUDIOS[t].nombre)}. Las demás no existen para esta consulta.`));
        partes.push(tablaFilas((f) => f.t === t, mostrar));
      } else if (op === "insert-propio") {
        const nueva = { ruc: String(siguienteRuc++), razon: "Cliente nuevo SAC", t };
        filas.push(nueva);
        ultimaNueva = nueva;
        partes.push(veredicto("ok", `<strong>INSERT 0 1.</strong> No hizo falta escribir tenant_id: su valor por defecto es el carnet. WITH CHECK confirma que la etiqueta es la de ${esc(ESTUDIOS[t].nombre)}.`));
        partes.push(tablaFilas((f) => f.t === t, mostrar));
      } else {
        partes.push(
          veredicto(
            "ok",
            `<strong>ERROR: new row violates row-level security policy for table "cliente".</strong> Intentaste guardar un folder con la etiqueta de ${esc(ESTUDIOS[etiqueta].nombre)} mostrando el carnet de ${esc(ESTUDIOS[t].nombre)}: WITH CHECK lo rechaza.`,
          ),
        );
      }
      salida.replaceChildren(...partes);
    }
    ejecutar.addEventListener("click", correr);
    verOcultas.addEventListener("change", correr);
    correr();
  };

  // ===================================================================================
  // Correlatividad: reglas de analizarCorrelatividad (packages/domain/src/correlatividad/index.ts).
  // ===================================================================================
  window.SIMULADORES.correlatividad = function (lugar) {
    const cuerpo = marco(
      lugar,
      "Buscar la boleta 291",
      "Escribe una venta por línea: tipo, serie y número (por ejemplo 03 B001-290). El análisis se actualiza mientras escribes.",
    );
    const texto = crear("textarea", {
      rows: 8,
      spellcheck: false,
      value: ["03 B001-289", "03 B001-290", "03 b001-0000000292", "03 B001-296", "03 B001-ABC", "01 F001-1040", "01 F001-1041"].join("\n"),
    });
    const salida = crear("div", { className: "sim-series", ariaLive: "polite" });
    const justificados = new Map(); // clave tipo|serie|desde|hasta → comentario
    cuerpo.append(campo("Ventas del periodo", texto), salida);

    const CEROS_IZQUIERDA = /^0+(?=[\s\S])/;
    const DIGITOS_1_A_8 = /^[0-9]{1,8}$/;
    const mayusculasAscii = (s) => s.replace(/[a-z]/g, (c) => c.toUpperCase());

    function analizar() {
      const grupos = new Map();
      let ignoradas = 0;
      for (const linea of texto.value.split("\n")) {
        const l = linea.trim();
        if (!l) continue;
        const m = l.match(/^(?:(\d{2})\s+)?([A-Za-z0-9]{1,4})[-\s]+(\S+)$/);
        if (!m) {
          ignoradas++;
          continue;
        }
        const tipo = m[1] || "03";
        const serie = mayusculasAscii(m[2]);
        const clave = tipo + "|" + serie;
        if (!grupos.has(clave)) grupos.set(clave, { tipo, serie, numeros: new Set(), noEvaluables: 0 });
        const g = grupos.get(clave);
        const sinCeros = m[3].replace(CEROS_IZQUIERDA, "");
        if (DIGITOS_1_A_8.test(sinCeros)) g.numeros.add(Number(sinCeros));
        else g.noEvaluables++;
      }
      const series = [...grupos.values()].sort((a, b) => (a.tipo + a.serie < b.tipo + b.serie ? -1 : 1));
      const piezas = [];
      for (const g of series) {
        const nums = [...g.numeros].sort((a, b) => a - b);
        const faltantes = [];
        for (let i = 1; i < nums.length; i++) if (nums[i] - nums[i - 1] > 1) faltantes.push({ desde: nums[i - 1] + 1, hasta: nums[i] - 1 });
        const caja = crear("div", { className: "sim-caja" });
        const rango = nums.length ? `del ${nums[0]} al ${nums[nums.length - 1]}` : "sin números evaluables";
        caja.append(
          crear("h4", { textContent: `Tipo ${g.tipo} · serie ${g.serie} · ${rango}` }),
        );
        if (nums.length && nums[nums.length - 1] - nums[0] <= 120) {
          const tira = crear("div", { className: "sim-tira", ariaHidden: "true" });
          for (let n = nums[0]; n <= nums[nums.length - 1]; n++) {
            const f = faltantes.find((x) => n >= x.desde && n <= x.hasta);
            const just = f && justificados.has(`${g.tipo}|${g.serie}|${f.desde}|${f.hasta}`);
            tira.append(crear("span", { className: !f ? "presente" : just ? "justificado" : "falta", textContent: String(n) }));
          }
          caja.append(tira);
        } else if (nums.length) caja.append(crear("p", { className: "sim-ayuda", textContent: "Rango grande: se listan solo los faltantes (como rangos, sin gastar memoria)." }));

        if (!faltantes.length && nums.length)
          caja.append(veredicto("ok", "<strong>Serie completa.</strong> No falta ningún número entre el menor y el mayor del periodo."));
        const lista = crear("ul", { className: "sim-faltantes" });
        for (const f of faltantes) {
          const clave = `${g.tipo}|${g.serie}|${f.desde}|${f.hasta}`;
          const aviso =
            f.desde === f.hasta ? `Falta ${g.serie}-${f.desde}` : `Faltan ${g.serie}-${f.desde} a ${g.serie}-${f.hasta}`;
          const li = crear("li");
          if (justificados.has(clave)) {
            const revertir = crear("button", { type: "button", className: "boton", textContent: "Revertir" });
            revertir.addEventListener("click", () => {
              justificados.delete(clave);
              analizar();
            });
            li.append(crear("span", { className: "chip b", textContent: "justificado" }), crear("span", { textContent: `${aviso}: «${justificados.get(clave)}»` }), revertir);
          } else {
            const comentario = crear("input", { type: "text", placeholder: "Comentario (1 a 500 caracteres), p. ej. «Anulada»", maxLength: 500 });
            comentario.setAttribute("aria-label", "Comentario para justificar " + aviso);
            const justificar = crear("button", { type: "button", className: "boton", textContent: "Justificar" });
            justificar.addEventListener("click", () => {
              const c = comentario.value.trim();
              if (!c) {
                comentario.focus();
                comentario.placeholder = "Escribe por qué falta (es obligatorio)";
                return;
              }
              justificados.set(clave, c);
              analizar();
            });
            li.append(crear("span", { className: "chip", textContent: "pendiente" }), crear("strong", { textContent: aviso }), comentario, justificar);
          }
          lista.append(li);
        }
        if (faltantes.length) caja.append(lista);
        if (g.noEvaluables)
          caja.append(
            veredicto("aviso", `<strong>${g.noEvaluables} número${g.noEvaluables > 1 ? "s" : ""} no evaluable${g.noEvaluables > 1 ? "s" : ""}.</strong> Sin ceros a la izquierda deben quedar de 1 a 8 dígitos. Se cuentan aparte y nunca inventan un hueco.`),
          );
        piezas.push(caja);
      }
      if (!piezas.length) piezas.push(veredicto("aviso", "Escribe al menos una venta, por ejemplo <code>03 B001-290</code>."));
      piezas.push(
        crear("div", { className: "leyenda" }, [
          crear("span", { innerHTML: '<i style="background:var(--ok-fondo);outline:1px solid var(--ok)"></i>presente' }),
          crear("span", { innerHTML: '<i style="background:var(--error-fondo);outline:1px dashed var(--error)"></i>falta' }),
          crear("span", { innerHTML: '<i style="background:var(--aviso-fondo);outline:1px solid var(--aviso)"></i>justificado' }),
          ignoradas ? crear("span", { textContent: `${ignoradas} línea${ignoradas > 1 ? "s" : ""} sin formato «tipo serie-número» ignorada${ignoradas > 1 ? "s" : ""}.` }) : null,
        ]),
        crear("p", { className: "sim-ayuda", textContent: "Solo alerta: ningún faltante bloquea la generación del archivo (P-6 de 013). En la app, justificar guarda quién y cuándo, y revertir no borra nada." }),
      );
      salida.replaceChildren(...piezas);
    }
    let espera;
    texto.addEventListener("input", () => {
      clearTimeout(espera);
      espera = setTimeout(analizar, 150);
    });
    analizar();
  };
})();
