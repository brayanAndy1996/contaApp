// Navegación, avance, búsqueda y ejercicios del curso. El contenido viene de contenido.js (generado desde los .md).
(function () {
  "use strict";
  const CURSO = window.CURSO;
  const modulos = CURSO.modulos;
  const porId = new Map(modulos.map((m) => [m.id, m]));
  const $ = (sel, raiz) => (raiz || document).querySelector(sel);
  const crear = (etiqueta, props, hijos) => {
    const el = document.createElement(etiqueta);
    Object.assign(el, props || {});
    for (const h of [].concat(hijos || [])) el.append(h);
    return el;
  };

  // ---------- Almacenamiento (puede no existir: ventana privada, vista previa) ----------
  const guardado = {
    leer(clave, porDefecto) {
      try {
        const v = localStorage.getItem("curso-contapp." + clave);
        return v === null ? porDefecto : JSON.parse(v);
      } catch (e) {
        return porDefecto;
      }
    },
    escribir(clave, valor) {
      try {
        localStorage.setItem("curso-contapp." + clave, JSON.stringify(valor));
      } catch (e) {
        /* sin almacenamiento: el avance dura lo que dure la pestaña */
      }
    },
  };
  let completados = new Set(guardado.leer("completados", []));

  // ---------- Tema ----------
  const temas = ["auto", "claro", "oscuro"];
  let tema = guardado.leer("tema", "auto");
  if (!temas.includes(tema)) tema = "auto";
  function aplicarTema() {
    const raiz = document.documentElement;
    if (tema === "claro") raiz.setAttribute("data-theme", "light");
    else if (tema === "oscuro") raiz.setAttribute("data-theme", "dark");
    else raiz.removeAttribute("data-theme");
    $("#boton-tema").textContent = tema === "auto" ? "Tema auto" : tema === "claro" ? "Claro" : "Oscuro";
  }
  $("#boton-tema").addEventListener("click", () => {
    tema = temas[(temas.indexOf(tema) + 1) % temas.length];
    guardado.escribir("tema", tema);
    aplicarTema();
  });
  aplicarTema();

  // ---------- Índice lateral ----------
  const lateral = $("#lateral");
  const botonIndice = $("#boton-indice");
  function cerrarLateral() {
    lateral.classList.remove("abierta");
    botonIndice.setAttribute("aria-expanded", "false");
  }
  botonIndice.addEventListener("click", () => {
    const abierta = lateral.classList.toggle("abierta");
    botonIndice.setAttribute("aria-expanded", String(abierta));
  });

  const contables = modulos.filter((m) => m.id !== "00");
  function pintarAvance() {
    const hechos = contables.filter((m) => completados.has(m.id)).length;
    const pct = Math.round((hechos / contables.length) * 100);
    const av = $("#avance");
    av.replaceChildren(
      crear("div", { className: "avance-cifra", innerHTML: `Tu avance: <span>${hechos} de ${contables.length}</span> módulos` }),
      crear("div", { className: "avance-barra", role: "progressbar", ariaValueNow: String(pct), ariaValueMin: "0", ariaValueMax: "100", ariaLabel: "Módulos completados" }, [
        crear("div", { style: `width:${pct}%` }),
      ]),
    );
  }
  function pintarIndice(actual) {
    const ol = $("#indice");
    ol.replaceChildren(
      ...modulos.map((m) => {
        const a = crear("a", { href: "#m" + m.id, title: m.descripcion });
        if (m.id === actual) a.setAttribute("aria-current", "page");
        const titulo = crear("span", { textContent: m.titulo });
        if (m.simuladores.length) titulo.append(crear("span", { className: "indice-sim", textContent: "simulador" }));
        a.append(
          crear("span", { className: "indice-folio", textContent: m.id }),
          titulo,
          crear("span", { className: "indice-marca", textContent: completados.has(m.id) ? "✓" : "", ariaLabel: completados.has(m.id) ? "completado" : "" }),
        );
        return crear("li", {}, [a]);
      }),
    );
  }

  // ---------- Contenido de un módulo ----------
  const principal = $("#principal");

  function mejorarCodigo(raiz) {
    for (const pre of raiz.querySelectorAll("pre")) {
      if (pre.closest(".simulador")) continue;
      const envoltura = crear("div", { className: "bloque-codigo" });
      pre.replaceWith(envoltura);
      const boton = crear("button", { type: "button", className: "copiar", textContent: "Copiar" });
      boton.addEventListener("click", () => {
        const texto = pre.innerText;
        const listo = () => {
          boton.textContent = "Copiado";
          setTimeout(() => (boton.textContent = "Copiar"), 1500);
        };
        const seleccionar = () => {
          const r = document.createRange();
          r.selectNodeContents(pre);
          const s = getSelection();
          s.removeAllRanges();
          s.addRange(r);
          boton.textContent = "Seleccionado: Ctrl+C";
        };
        try {
          navigator.clipboard.writeText(texto).then(listo, seleccionar);
        } catch (e) {
          seleccionar();
        }
      });
      envoltura.append(pre, boton);
    }
    for (const tabla of raiz.querySelectorAll("table")) {
      if (tabla.closest(".simulador")) continue;
      const envoltura = crear("div", { className: "tabla" });
      tabla.replaceWith(envoltura);
      envoltura.append(tabla);
    }
  }

  // «Ejercicios»: la lista de preguntas y la lista de soluciones (dentro de <details>) se vuelven tarjetas.
  function mejorarEjercicios(raiz) {
    const h2 = [...raiz.querySelectorAll("h2")].find((h) => /^Ejercicios/i.test(h.textContent.trim()));
    if (!h2) return;
    const tramo = [];
    for (let n = h2.nextElementSibling; n && n.tagName !== "H2"; n = n.nextElementSibling) tramo.push(n);
    const preguntas = tramo.find((n) => n.tagName === "OL");
    const detalles = tramo.find((n) => n.tagName === "DETAILS");
    const soluciones = detalles && detalles.querySelector("ol");
    if (!preguntas || !soluciones) return;
    const p = [...preguntas.children];
    const s = [...soluciones.children];
    if (p.length !== s.length) return;
    let vistas = 0;
    const resumen = crear("p", { className: "ejercicios-resumen" });
    const actualizar = () => (resumen.textContent = `Respuestas vistas: ${vistas} de ${p.length}. Intenta responder antes de mirar.`);
    const lista = crear("ol", { className: "ejercicios" });
    p.forEach((li, i) => {
      const respuesta = crear("div", { className: "ejercicio-respuesta", hidden: true });
      respuesta.append(...s[i].childNodes);
      const boton = crear("button", { type: "button", className: "boton", textContent: "Ver respuesta" });
      boton.setAttribute("aria-expanded", "false");
      boton.addEventListener("click", () => {
        const abrir = respuesta.hidden;
        respuesta.hidden = !abrir;
        boton.textContent = abrir ? "Ocultar respuesta" : "Ver respuesta";
        boton.setAttribute("aria-expanded", String(abrir));
        if (abrir && !boton.dataset.vista) {
          boton.dataset.vista = "1";
          vistas++;
          actualizar();
        }
      });
      const cuerpo = crear("div");
      cuerpo.append(...li.childNodes);
      lista.append(
        crear("li", { className: "ejercicio" }, [
          crear("div", { className: "ejercicio-pregunta" }, [cuerpo]),
          crear("div", { className: "ejercicio-acciones" }, [boton]),
          respuesta,
        ]),
      );
    });
    actualizar();
    preguntas.replaceWith(lista);
    lista.after(resumen);
    detalles.remove();
  }

  function montarSimuladores(raiz) {
    for (const lugar of raiz.querySelectorAll(".simulador[data-simulador]")) {
      const fabrica = window.SIMULADORES && window.SIMULADORES[lugar.dataset.simulador];
      if (fabrica) {
        try {
          fabrica(lugar);
        } catch (e) {
          lugar.textContent = "No se pudo cargar este simulador.";
        }
      } else lugar.remove();
    }
  }

  function temario(raiz) {
    const lista = crear("ul", { className: "temario", ariaLabel: "Secciones del módulo" });
    for (const h of raiz.querySelectorAll("h2")) {
      const b = crear("button", { type: "button", textContent: h.textContent.replace(/^\d+\.\s*/, "") });
      b.addEventListener("click", () => h.scrollIntoView({ behavior: "smooth", block: "start" }));
      lista.append(crear("li", {}, [b]));
    }
    return lista;
  }

  function cierre(m) {
    const i = modulos.indexOf(m);
    const anterior = modulos[i - 1];
    const siguiente = modulos[i + 1];
    const caja = crear("section", { className: "cierre", ariaLabel: "Fin del módulo" });
    if (m.id !== "00") {
      const hecho = completados.has(m.id);
      const boton = crear("button", {
        type: "button",
        className: "boton " + (hecho ? "" : "boton-primario"),
        textContent: hecho ? "Marcar como pendiente" : "Marcar como completado",
      });
      boton.addEventListener("click", () => {
        if (completados.has(m.id)) completados.delete(m.id);
        else completados.add(m.id);
        guardado.escribir("completados", [...completados]);
        pintarAvance();
        pintarIndice(m.id);
        caja.replaceWith(cierre(m));
      });
      caja.append(
        crear("div", { className: "cierre-estado" }, [
          boton,
          crear("span", { className: "sim-ayuda", textContent: hecho ? "Completado." : "¿Terminaste los ejercicios? Márcalo para llevar tu avance." }),
        ]),
      );
    }
    const nav = crear("nav", { className: "cierre-navegacion", ariaLabel: "Módulo anterior y siguiente" });
    if (anterior) nav.append(crear("a", { href: "#m" + anterior.id, innerHTML: `<small>Anterior · ${anterior.id}</small>` }, [anterior.titulo]));
    if (siguiente) nav.append(crear("a", { href: "#m" + siguiente.id, className: "siguiente", innerHTML: `<small>Siguiente · ${siguiente.id}</small>` }, [siguiente.titulo]));
    caja.append(nav);
    return caja;
  }

  function bienvenida() {
    const pendiente = contables.find((m) => !completados.has(m.id));
    const caja = crear("section", { className: "bienvenida" });
    caja.append(
      crear("h2", { textContent: completados.size ? "Sigue donde lo dejaste" : "Empieza por aquí" }),
      crear("p", {
        textContent: pendiente
          ? `Próximo módulo sin completar: ${pendiente.id} · ${pendiente.titulo}.`
          : "Completaste todos los módulos. Puedes volver a cualquiera desde el índice.",
      }),
    );
    const acciones = crear("div", { className: "bienvenida-acciones" });
    if (pendiente) acciones.append(crear("a", { href: "#m" + pendiente.id, className: "boton boton-primario", textContent: "Abrir módulo " + pendiente.id }));
    const conSim = modulos.filter((m) => m.simuladores.length);
    if (conSim.length)
      acciones.append(
        crear("span", { className: "sim-ayuda", textContent: "Con simulador: " + conSim.map((m) => m.id).join(", ") + "." }),
      );
    caja.append(acciones);
    return caja;
  }

  function mostrarModulo(id, ancla) {
    const m = porId.get(id) || modulos[0];
    const hoja = crear("article", { className: "hoja" });
    const contenido = crear("div", { className: "contenido", innerHTML: m.html });
    const h1 = contenido.querySelector("h1");
    const folio = crear("div", { className: "folio" }, [
      crear("span", { className: "folio-numero", textContent: m.id === "00" ? "Índice" : `Módulo ${m.id} de ${contables[contables.length - 1].id}` }),
      m.simuladores.length ? crear("span", { textContent: "Con simulador interactivo" }) : "",
    ]);
    if (h1) {
      h1.innerHTML = h1.innerHTML.replace(/^(Módulo\s+)?\d\d\s*·\s*/, "");
      h1.before(folio);
      h1.after(temario(contenido));
    }
    // La línea «Módulo anterior · Siguiente · Índice» del .md sobra: la web navega con el índice y el pie.
    for (const p of contenido.querySelectorAll("blockquote p")) {
      if (/^(Módulo anterior|Anterior|Siguiente|Índice):/.test(p.textContent.trim())) {
        const bq = p.closest("blockquote");
        p.remove();
        if (bq && !bq.textContent.trim()) bq.remove();
      }
    }
    mejorarEjercicios(contenido);
    mejorarCodigo(contenido);
    montarSimuladores(contenido);
    hoja.append(m.id === "00" ? bienvenida() : "", contenido, cierre(m));
    principal.replaceChildren(hoja);
    pintarIndice(m.id);
    document.title = (m.id === "00" ? "" : m.id + " · " + m.titulo + " · ") + "Curso ContApp";
    guardado.escribir("ultimo", m.id);
    if (ancla) {
      const destino = document.getElementById(ancla);
      if (destino) return destino.scrollIntoView({ block: "start" });
    }
    window.scrollTo(0, 0);
    principal.focus({ preventScroll: true });
  }

  // ---------- Búsqueda ----------
  const normalizar = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const escapar = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const indiceBusqueda = [];
  for (const m of modulos)
    for (const s of m.secciones) indiceBusqueda.push({ m, s, plano: normalizar(s.titulo + " " + s.texto) });

  function fragmento(texto, terminos) {
    const plano = normalizar(texto);
    const pos = Math.max(0, plano.indexOf(terminos[0]));
    const inicio = Math.max(0, pos - 70);
    let trozo = (inicio ? "…" : "") + texto.slice(inicio, pos + 160) + (pos + 160 < texto.length ? "…" : "");
    let html = escapar(trozo);
    for (const t of terminos) {
      // Resalta sobre el texto original comparando sin tildes.
      const planoTrozo = normalizar(html);
      let salida = "";
      let i = 0;
      let j;
      while ((j = planoTrozo.indexOf(t, i)) !== -1 && t) {
        salida += html.slice(i, j) + "<mark>" + html.slice(j, j + t.length) + "</mark>";
        i = j + t.length;
      }
      html = salida + html.slice(i);
    }
    return html;
  }

  function mostrarBusqueda(consulta) {
    const terminos = normalizar(consulta).split(/\s+/).filter((t) => t.length > 1);
    const hoja = crear("article", { className: "hoja contenido" });
    hoja.append(crear("h1", { textContent: `Buscar: «${consulta}»` }));
    if (!terminos.length) {
      hoja.append(crear("p", { textContent: "Escribe al menos dos letras." }));
      principal.replaceChildren(hoja);
      return;
    }
    const hallados = indiceBusqueda
      .map((e) => {
        let puntos = 0;
        for (const t of terminos) {
          const n = e.plano.split(t).length - 1;
          if (!n) return null;
          puntos += n + (normalizar(e.s.titulo).includes(t) ? 10 : 0);
        }
        return { ...e, puntos };
      })
      .filter(Boolean)
      .sort((a, b) => b.puntos - a.puntos)
      .slice(0, 40);
    hoja.append(crear("p", { className: "sim-ayuda", textContent: hallados.length ? `${hallados.length} secciones encontradas.` : "No hay resultados. Prueba con otra palabra (sin importar tildes)." }));
    const lista = crear("ul", { className: "resultados" });
    for (const r of hallados) {
      const a = crear("a", { href: "#m" + r.m.id, innerHTML: `<small>${r.m.id} · ${escapar(r.m.titulo)}</small><strong>${escapar(r.s.titulo)}</strong><p>${fragmento(r.s.texto, terminos)}</p>` });
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        cerrarLateral();
        $("#buscar").value = "";
        if (location.hash === "#m" + r.m.id) mostrarModulo(r.m.id, r.s.ancla);
        else {
          anclaPendiente = r.s.ancla;
          location.hash = "m" + r.m.id;
        }
      });
      lista.append(crear("li", {}, [a]));
    }
    hoja.append(lista);
    principal.replaceChildren(hoja);
    window.scrollTo(0, 0);
  }
  let temporizador;
  $("#buscar").addEventListener("input", (ev) => {
    clearTimeout(temporizador);
    const v = ev.target.value.trim();
    temporizador = setTimeout(() => (v ? mostrarBusqueda(v) : ruta()), 180);
  });

  // ---------- Rutas: #m00 … #m15 ----------
  let anclaPendiente = null;
  function ruta() {
    const m = location.hash.match(/^#m(\d\d)$/);
    const id = m && porId.has(m[1]) ? m[1] : "00";
    const ancla = anclaPendiente;
    anclaPendiente = null;
    cerrarLateral();
    mostrarModulo(id, ancla);
  }
  window.addEventListener("hashchange", ruta);

  // ← y → pasan de módulo cuando no se está escribiendo.
  document.addEventListener("keydown", (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(document.activeElement.tagName)) return;
    const actual = (location.hash.match(/^#m(\d\d)$/) || [])[1] || "00";
    const i = modulos.findIndex((m) => m.id === actual);
    const destino = ev.key === "ArrowRight" ? modulos[i + 1] : ev.key === "ArrowLeft" ? modulos[i - 1] : null;
    if (destino) location.hash = "m" + destino.id;
  });

  pintarAvance();
  ruta();
})();
