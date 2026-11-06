import { useEffect, useMemo, useState } from "react";
import type { Confirmacion, Destino, Hallazgo } from "@contapp/domain";
import { HISTORIAL } from "../../datos/semilla";
import type { FilaCompra, MontosPlanos } from "../../datos/tipos";
import { COLUMNAS_COMPRA, ETIQUETA_COLUMNA, aplicar, claveHallazgo, comparar, cuadre, destinoDe, esCero, moneyDe, normalizarMonto, sumaComponentes, sumar } from "../../motor/dominio";
import { descargar } from "../../motor/empaquetar";
import { generarUbl, leerUbl } from "../../motor/ubl";
import { Aviso, Boton, Insignia, Modal, claseInput, fechaDoc, soles } from "../../ui/comunes";
import { EXPLICACION_REGLA, TONO_REGLA, useCompras } from "./usar-compras";

function describirSugerencia(h: Hallazgo): string {
  const s = h.sugerencia;
  if (!s) return "Solo aviso: revisa el comprobante.";
  switch (s.tipo) {
    case "mover":
      return `Mover ${soles(s.monto.toString())} de ${ETIQUETA_COLUMNA[s.origen]} a ${ETIQUETA_COLUMNA[s.destino]}.`;
    case "separar":
      return s.exacto
        ? `Separar: gravado exacto ${soles(s.exacto.toString())} (según XML) en ${ETIQUETA_COLUMNA[s.columnaBi]}; el resto va a No gravado.`
        : `Separar: el gravado está entre ${soles(s.min.toString())} y ${soles(s.max.toString())} (estimado ${soles(s.estimado.toString())}, el IGV viene redondeado). El resto va a No gravado.`;
    case "ajustar":
      return `Ajustar ${Object.entries(s.valores)
        .map(([k, v]) => `${ETIQUETA_COLUMNA[k as keyof typeof ETIQUETA_COLUMNA]} a ${v?.toString()}`)
        .join(", ")}.`;
    case "clasificar":
      return "Elige la clasificación (DG / DGNG / DNG). Con «Recordar» el sistema la propondrá desde el próximo mes.";
    case "excluir":
      return `Excluir como gasto no deducible (categoría «${s.categoria}»).`;
  }
}

function confirmacionPorDefecto(h: Hallazgo, gravado: string, destino: Destino): Confirmacion | undefined {
  if (h.dato === "gravado") return { gravado: moneyDe(gravado) };
  if (h.dato === "destino") return { destino };
  return undefined;
}

export function Lupa({ clienteId, filaId, ids, alCambiar, alCerrar }: { clienteId: string; filaId: string; ids: string[]; alCambiar: (id: string) => void; alCerrar: () => void }) {
  const h = useCompras(clienteId);
  const { p, ev, cliente, razonSocial, pendientes, historial, aplicarHallazgo, aplicarHistorial, descartar, clasificar, excluir, restaurar, editarFila, conocidos, bloqueado, estado, recordarProveedor, reintentarXml, subirXml } = h;
  const c = cliente(clienteId)!;
  const f = p.compras.find((x) => x.id === filaId);
  const [gravado, setGravado] = useState("");
  const [destinoNuevo, setDestinoNuevo] = useState<Destino>(c.ventasExoneradas ? "DNG" : "DG");
  const [recordar, setRecordar] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<MontosPlanos | null>(null);
  const [verXml, setVerXml] = useState(false);
  const [motivo, setMotivo] = useState("");

  const obs = f ? pendientes(f.id) : [];
  const his = f ? historial(f) : null;
  const xml = f && p.xmlEstado[f.id] === "disponible" ? p.xml[f.id] : undefined;
  const pos = ids.indexOf(filaId);

  useEffect(() => {
    setError(null);
    setEditando(null);
    const mix = obs.find((x) => x.sugerencia?.tipo === "separar");
    if (mix && mix.sugerencia?.tipo === "separar") setGravado((mix.sugerencia.exacto ?? mix.sugerencia.estimado).toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filaId]);

  // Vista previa: la fila corregida que propone el sistema (aplicar sobre una copia).
  const preview = useMemo(() => {
    if (!f) return null;
    const h0 = obs.find((x) => x.sugerencia && x.sugerencia.tipo !== "excluir");
    if (!h0) return null;
    try {
      return { h: h0, montos: aplicar(f, h0, confirmacionPorDefecto(h0, gravado || "0.00", destinoNuevo), ev.entorno).montos };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, obs.length, gravado, destinoNuevo, ev]);

  const aceptar = (x: Hallazgo) => {
    setError(null);
    if (x.dato === "gravado") {
      const g = normalizarMonto(gravado);
      if (!g) return setError("Escribe el gravado con dos decimales.");
    }
    const e = aplicarHallazgo(x, confirmacionPorDefecto(x, gravado, destinoNuevo), recordar);
    if (e) setError(e);
  };

  useEffect(() => {
    const t = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      if (e.key === "ArrowRight" && pos < ids.length - 1) alCambiar(ids[pos + 1]!);
      if (e.key === "ArrowLeft" && pos > 0) alCambiar(ids[pos - 1]!);
      if (e.key === "Enter" && !bloqueado) {
        if (obs[0]) aceptar(obs[0]);
        else if (his) aplicarHistorial(his);
      }
    };
    window.addEventListener("keydown", t);
    return () => window.removeEventListener("keydown", t);
  });

  if (!f) return null;
  const d = destinoDe(f.montos);
  const nuevo = !conocidos.includes(f.proveedorRuc);
  const origenPortal = f.serie.startsWith("E");
  const hist = HISTORIAL[clienteId]?.[f.proveedorRuc] ?? [];
  const aprendida = (estado.aprendidas[clienteId] ?? []).find((a) => a.proveedorRuc === f.proveedorRuc);
  const sire = {
    gravado: sumar([f.montos.biDg, f.montos.biDgng, f.montos.biDng]),
    igv: sumar([f.montos.igvDg, f.montos.igvDgng, f.montos.igvDng]),
    noGravado: f.montos.noGravado,
    isc: f.montos.isc,
    icbper: f.montos.icbper,
    total: f.montos.total,
  };
  const xmlPen = xml && xml.moneda === "PEN" ? xml : null;
  const cmp = [
    ["Base gravada", sire.gravado, xmlPen?.gravado],
    ["IGV", sire.igv, xmlPen?.igv],
    ["No gravado", sire.noGravado, xmlPen?.noGravado],
    ["ISC", sire.isc, xmlPen?.isc],
    ["ICBPER", sire.icbper, xmlPen?.icbper],
    ["Total", sire.total, xmlPen?.total],
  ] as const;

  const imprimir = () => {
    if (!xml) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>${f.serie}-${f.numero}</title><style>body{font-family:Arial;padding:24px;font-size:13px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px;text-align:left}.r{text-align:right}.demo{background:#fde68a;padding:6px;text-align:center;font-weight:bold}</style></head><body>
      <div class="demo">REPRESENTACIÓN IMPRESA SIMULADA · DOCUMENTO FICTICIO · SIN VALOR TRIBUTARIO</div>
      <h2>${razonSocial(f.proveedorRuc)}</h2><p>RUC ${f.proveedorRuc}<br/>FACTURA ELECTRÓNICA ${f.serie}-${f.numero}<br/>Fecha: ${fechaDoc(f.fecha)} · Moneda: ${xml.moneda}</p>
      <p>Adquiriente: ${c.razonSocial} · RUC ${c.ruc}</p>
      <table><tr><th>Cant.</th><th>Unidad</th><th>Descripción</th><th class="r">P. unit.</th><th class="r">Valor</th></tr>
      ${xml.items.map((i) => `<tr><td>${i.cantidad}</td><td>${i.unidad}</td><td>${i.descripcion}</td><td class="r">${i.precioUnitario}</td><td class="r">${i.valor}</td></tr>`).join("")}
      </table><p class="r">Gravado ${xml.gravado} · Exonerado/Inafecto ${xml.noGravado} · IGV ${xml.igv} · ISC ${xml.isc} · ICBPER ${xml.icbper}<br/><b>TOTAL ${xml.moneda} ${xml.total}</b></p>
      <script>window.print()</script></body></html>`);
    w.document.close();
  };

  return (
    <Modal
      abierto
      alCerrar={alCerrar}
      ancho="max-w-5xl"
      titulo={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">
            🔍 {f.tipo === "07" ? "Nota de crédito" : "Factura"} {f.serie}-{f.numero}
          </span>
          {f.excluida && <Insignia>Excluida</Insignia>}
          {xml && !xml.subido && <Insignia tono="violeta">XML simulado</Insignia>}
          {xml?.subido && <Insignia tono="azul">XML subido</Insignia>}
          <span className="ml-auto flex items-center gap-1 text-xs font-normal text-slate-500">
            <Boton chico disabled={pos <= 0} onClick={() => alCambiar(ids[pos - 1]!)}>
              ←
            </Boton>
            {pos + 1} de {ids.length}
            <Boton chico disabled={pos >= ids.length - 1} onClick={() => alCambiar(ids[pos + 1]!)}>
              →
            </Boton>
          </span>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          {/* 1. Cabecera */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-3">
              <div className="font-semibold text-slate-900">
                {razonSocial(f.proveedorRuc)} {nuevo && <Insignia tono="violeta">Proveedor nuevo</Insignia>} {estado.emisoresIsc.includes(f.proveedorRuc) && <Insignia tono="rojo">Catálogo: emisor de ISC</Insignia>}
              </div>
              <div className="text-xs text-slate-500">RUC {f.proveedorRuc}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-slate-400">Emisión</div>
              {fechaDoc(f.fecha)}
            </div>
            <div>
              <div className="text-[11px] uppercase text-slate-400">Moneda</div>
              {f.usd ? `USD · TC ${f.usd.tipoCambio}` : "PEN"}
            </div>
            <div>
              <div className="text-[11px] uppercase text-slate-400">Origen</div>
              {origenPortal ? "Portal SUNAT (E…)" : "Sistema propio del emisor (F…)"}
            </div>
          </div>

          {/* 2. Ítems */}
          {xml ? (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Ítems del XML</h4>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-xs tabular">
                  <thead className="bg-slate-50 text-[10px] uppercase text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Descripción</th>
                      <th className="px-2 py-1.5 text-right">Cant.</th>
                      <th className="px-2 py-1.5 text-right">P. unit.</th>
                      <th className="px-2 py-1.5 text-right">Valor</th>
                      <th className="px-2 py-1.5 text-left">Afectación</th>
                      <th className="px-2 py-1.5 text-right">IGV</th>
                      <th className="px-2 py-1.5 text-right">ISC</th>
                      <th className="px-2 py-1.5 text-right">ICBPER</th>
                    </tr>
                  </thead>
                  <tbody>
                    {xml.items.map((it, i) => {
                      const gp = obs.find((x) => x.sugerencia?.tipo === "excluir");
                      const marca = gp?.sugerencia?.tipo === "excluir" && it.descripcion.toLowerCase().includes(gp.sugerencia.palabra.slice(0, 6));
                      return (
                        <tr key={i} className={`border-t border-slate-100 ${marca ? "bg-red-50" : ""}`}>
                          <td className="px-2 py-1.5">{it.descripcion}</td>
                          <td className="px-2 py-1.5 text-right">
                            {it.cantidad} <span className="text-slate-400">{it.unidad}</span>
                          </td>
                          <td className="px-2 py-1.5 text-right">{it.precioUnitario}</td>
                          <td className="px-2 py-1.5 text-right">{it.valor}</td>
                          <td className="px-2 py-1.5">
                            <Insignia tono={it.afectacion === "Gravado" ? "azul" : "ambar"}>{it.afectacion}</Insignia>
                          </td>
                          <td className="px-2 py-1.5 text-right">{it.igv}</td>
                          <td className={`px-2 py-1.5 text-right ${!esCero(it.isc) ? "bg-amber-100 font-semibold" : ""}`}>{it.isc}</td>
                          <td className={`px-2 py-1.5 text-right ${!esCero(it.icbper) ? "bg-amber-100 font-semibold" : ""}`}>{it.icbper}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Boton chico onClick={() => setVerXml(!verXml)}>{verXml ? "Ocultar XML" : "</> Ver XML"}</Boton>
                <Boton chico onClick={() => descargar(`${f.proveedorRuc}-${f.tipo}-${f.serie}-${f.numero}.xml`, generarUbl(f, xml, razonSocial(f.proveedorRuc), c.ruc, c.razonSocial), "application/xml")}>⤓ Descargar XML</Boton>
                <Boton chico onClick={imprimir}>🖨 PDF (representación impresa)</Boton>
              </div>
              {verXml && <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-[10px] leading-relaxed text-emerald-200">{generarUbl(f, xml, razonSocial(f.proveedorRuc), c.ruc, c.razonSocial)}</pre>}
              {xml.moneda === "USD" && <p className="mt-2 text-xs text-slate-500">XML en USD (TC {xml.tipoCambio}). El SIRE trae la fila convertida a soles; el motor compara la conversión componente por componente.</p>}
            </div>
          ) : (
            <Aviso tono="ambar" titulo="XML no disponible">
              <p>El simulador no encontró el XML de este comprobante en el primer intento (como pasa en SOL a veces). Se muestran solo los datos del SIRE.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Boton chico variante="primario" disabled={p.xmlEstado[f.id] === "pendiente"} onClick={() => reintentarXml(clienteId, f.id)}>
                  {p.xmlEstado[f.id] === "pendiente" ? "Descargando…" : "⟳ Reintentar descarga"}
                </Boton>
                <label className="inline-flex cursor-pointer items-center rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium">
                  ⇪ Subir XML
                  <input
                    type="file"
                    accept=".xml"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const r = leerUbl(await file.text());
                      if (!r) return setError("El archivo no es un XML UBL 2.1 legible.");
                      if (r.ruc && r.ruc !== f.proveedorRuc) return setError(`El XML es de otro emisor (${r.ruc}); no corresponde a este comprobante.`);
                      subirXml(clienteId, f.id, r.xml);
                    }}
                  />
                </label>
              </div>
            </Aviso>
          )}

          {/* 3. Comparación SIRE vs XML */}
          <div>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Comparación SIRE vs XML</h4>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs tabular">
                <thead className="bg-slate-50 text-[10px] uppercase text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Concepto</th>
                    <th className="px-2 py-1.5 text-right">SIRE</th>
                    <th className="px-2 py-1.5 text-right">XML</th>
                  </tr>
                </thead>
                <tbody>
                  {cmp.map(([k, a, b]) => {
                    const dif = b !== undefined && comparar(a, b) !== 0;
                    return (
                      <tr key={k} className={`border-t border-slate-100 ${dif ? "bg-red-50" : ""}`}>
                        <td className="px-2 py-1.5">{k}</td>
                        <td className={`px-2 py-1.5 text-right ${dif ? "font-semibold text-red-700" : ""}`}>{soles(a, false)}</td>
                        <td className={`px-2 py-1.5 text-right ${dif ? "font-semibold text-emerald-700" : ""}`}>{b === undefined ? "—" : soles(b, false)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Edición tipo Excel */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Montos de la fila (PEN)</h4>
              {!editando && !f.excluida && !bloqueado && (
                <Boton chico onClick={() => setEditando({ ...f.montos })}>
                  ✎ Editar montos
                </Boton>
              )}
            </div>
            <EditorMontos
              montos={editando ?? f.montos}
              editable={!!editando}
              alCambiar={setEditando}
              alGuardar={() => {
                if (!editando) return;
                editarFila(f.id, { montos: editando }, `${f.serie}-${f.numero}: edición manual de montos`);
                setEditando(null);
              }}
              alCancelar={() => setEditando(null)}
            />
          </div>
        </div>

        {/* Columna derecha: decisiones */}
        <div className="space-y-3 lg:col-span-2">
          {error && <Aviso tono="rojo">{error}</Aviso>}
          {obs.length === 0 && !his && !f.excluida && <Aviso tono="verde">✓ Sin observaciones del motor para esta fila.</Aviso>}
          {obs.map((x) => (
            <div key={claveHallazgo(x)} className="rounded-lg border border-slate-200 p-3">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <Insignia tono={TONO_REGLA[x.regla]}>{x.regla}</Insignia>
                <span className="text-sm font-semibold text-slate-800">{EXPLICACION_REGLA[x.regla]}</span>
                {x.destino && <Insignia>{x.destino}</Insignia>}
              </div>
              <p className="text-sm text-slate-700">{x.explicacion}</p>
              <p className="mt-1 text-xs text-slate-500">{describirSugerencia(x)}</p>
              <p className="mt-1 text-[11px] text-slate-400">{x.requiereConfirmacion ? "Requiere tu confirmación." : "Respaldada por el XML."}</p>
              {!bloqueado && (
                <div className="mt-2 space-y-2">
                  {x.dato === "gravado" && x.sugerencia?.tipo === "separar" && (
                    <div className="flex items-center gap-2 text-xs">
                      Gravado:
                      <input className={`${claseInput} w-28 py-1 text-xs`} value={gravado} onChange={(e) => setGravado(e.target.value)} />
                      <span className="text-slate-400">
                        rango {x.sugerencia.min.toString()} – {x.sugerencia.max.toString()}
                      </span>
                    </div>
                  )}
                  {x.dato === "destino" && (
                    <div className="space-y-1.5">
                      <div className="flex gap-1">
                        {(["DG", "DGNG", "DNG"] as Destino[]).map((dd) => (
                          <button key={dd} onClick={() => setDestinoNuevo(dd)} className={`flex-1 rounded border px-2 py-1 text-xs font-semibold ${destinoNuevo === dd ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300 bg-white"}`}>
                            {dd}
                          </button>
                        ))}
                      </div>
                      {c.ventasExoneradas && <p className="text-[11px] text-amber-700">Cliente de zona selva con ventas exoneradas: lo usual es DNG.</p>}
                      <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={recordar} onChange={(e) => setRecordar(e.target.checked)} /> Recordar para este proveedor
                      </label>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {x.sugerencia?.tipo === "excluir" ? (
                      <>
                        <Boton chico variante="peligro" onClick={() => aceptar(x)}>
                          Excluir (no deducible)
                        </Boton>
                        <Boton chico onClick={() => descartar([claveHallazgo(x)])}>
                          Es del negocio
                        </Boton>
                      </>
                    ) : x.sugerencia ? (
                      <>
                        <Boton chico variante="primario" onClick={() => aceptar(x)}>
                          ✓ Aceptar sugerencia <span className="opacity-60">⏎</span>
                        </Boton>
                        <Boton chico variante="fantasma" onClick={() => descartar([claveHallazgo(x)])}>
                          Descartar
                        </Boton>
                      </>
                    ) : (
                      <Boton chico onClick={() => descartar([claveHallazgo(x)])}>
                        Entendido
                      </Boton>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
          {his && (
            <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3">
              <div className="mb-1 flex items-center gap-1.5">
                <Insignia tono="teal">R-HIS</Insignia>
                <span className="text-sm font-semibold">Según historial</span>
                <Insignia tono="violeta">R2</Insignia>
              </div>
              <p className="text-sm text-slate-700">
                Este proveedor se clasificó como <b>{his.destino}</b> en meses anteriores para este cliente. El SIRE lo mandó a {d}.
              </p>
              {!bloqueado && (
                <div className="mt-2 flex gap-1.5">
                  <Boton chico variante="primario" onClick={() => aplicarHistorial(his)}>
                    ✓ Pasar a {his.destino}
                  </Boton>
                  <Boton chico variante="fantasma" onClick={() => descartar([his.clave])}>
                    Descartar
                  </Boton>
                </div>
              )}
            </div>
          )}

          {preview && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
              <h4 className="mb-1 text-xs font-semibold uppercase text-emerald-800">Fila corregida propuesta ({preview.h.regla})</h4>
              <table className="w-full text-xs tabular">
                <tbody>
                  {[...COLUMNAS_COMPRA, "total" as const]
                    .filter((k) => !esCero(f.montos[k]) || !esCero(preview.montos[k]))
                    .map((k) => {
                      const cambia = comparar(f.montos[k], preview.montos[k]) !== 0;
                      return (
                        <tr key={k}>
                          <td className="py-0.5 text-slate-600">{ETIQUETA_COLUMNA[k]}</td>
                          <td className={`py-0.5 text-right ${cambia ? "text-slate-400 line-through" : ""}`}>{f.montos[k]}</td>
                          <td className={`py-0.5 text-right ${cambia ? "font-bold text-emerald-800" : ""}`}>{preview.montos[k]}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}

          {/* Acciones de la fila */}
          {!bloqueado && (
            <div className="rounded-lg border border-slate-200 p-3">
              <h4 className="mb-2 text-xs font-semibold uppercase text-slate-500">Acciones</h4>
              {f.excluida ? (
                <div className="space-y-2">
                  <p className="text-sm text-slate-600">Excluida: {f.motivoExclusion}</p>
                  <Boton chico onClick={() => restaurar([f.id])}>
                    Restaurar compra
                  </Boton>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div>
                    <div className="mb-1 text-xs text-slate-500">Clasificación actual: {d ?? "—"}</div>
                    <div className="flex gap-1">
                      {(["DG", "DGNG", "DNG"] as Destino[]).map((dd) => (
                        <button key={dd} disabled={d === null} onClick={() => clasificar([f.id], dd)} className={`flex-1 rounded border px-2 py-1 text-xs font-semibold disabled:opacity-40 ${d === dd ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300 bg-white hover:bg-slate-50"}`}>
                          {dd}
                        </button>
                      ))}
                    </div>
                  </div>
                  {d && d !== "MIXTO" && (
                    <Boton chico variante="fantasma" onClick={() => recordarProveedor(clienteId, f.proveedorRuc, d)}>
                      ★ Recordar {d} para este proveedor {aprendida ? `(hoy: ${aprendida.destino})` : ""}
                    </Boton>
                  )}
                  <div className="flex gap-1.5">
                    <input className={`${claseInput} flex-1 py-1 text-xs`} placeholder="Motivo (opcional)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
                    <Boton chico variante="peligro" onClick={() => excluir([f.id], motivo)}>
                      No deducible
                    </Boton>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 5. Historial */}
          <div className="rounded-lg border border-slate-200 p-3">
            <h4 className="mb-1.5 text-xs font-semibold uppercase text-slate-500">Historial de este proveedor en el cliente</h4>
            {hist.length === 0 ? (
              <p className="text-xs text-slate-500">Nunca apareció en meses anteriores.</p>
            ) : (
              <ul className="space-y-0.5 text-xs">
                {hist.map((x) => (
                  <li key={x.periodo} className="flex justify-between">
                    <span>
                      {x.periodo.slice(4)}/{x.periodo.slice(0, 4)}
                    </span>
                    <Insignia tono="teal">{x.destino}</Insignia>
                  </li>
                ))}
              </ul>
            )}
            {aprendida && <p className="mt-1.5 text-[11px] text-teal-700">Regla aprendida: {aprendida.destino} ({aprendida.activa ? "activa" : "desactivada"})</p>}
          </div>
          <p className="text-[11px] text-slate-400">Atajos: ← → navegar · Enter aceptar · Esc cerrar. Cada decisión queda en la auditoría.</p>
        </div>
      </div>
    </Modal>
  );
}

function EditorMontos({ montos, editable, alCambiar, alGuardar, alCancelar }: { montos: MontosPlanos; editable: boolean; alCambiar: (m: MontosPlanos) => void; alGuardar: () => void; alCancelar: () => void }) {
  const [textos, setTextos] = useState<Record<string, string>>({});
  const valor = (k: keyof MontosPlanos) => textos[k] ?? montos[k];
  const cu = cuadre(montos);
  const cambiar = (k: keyof MontosPlanos, t: string) => {
    setTextos({ ...textos, [k]: t });
    const n = normalizarMonto(t);
    if (n === null) return;
    const m = { ...montos, [k]: n };
    if (k !== "total") m.total = sumaComponentes(m);
    alCambiar(m);
  };
  return (
    <div className="rounded-lg border border-slate-200 p-2">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {[...COLUMNAS_COMPRA, "total" as const].map((k) => (
          <label key={k} className="text-[10px] uppercase text-slate-500">
            {ETIQUETA_COLUMNA[k]}
            <input
              readOnly={!editable}
              className={`mt-0.5 w-full rounded border px-1.5 py-1 text-right text-xs tabular ${editable ? "border-slate-300 bg-white" : "border-transparent bg-slate-50"} ${normalizarMonto(valor(k)) === null ? "border-red-500" : ""}`}
              value={valor(k)}
              onChange={(e) => cambiar(k, e.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className={cu.cuadra ? "text-emerald-700" : "font-semibold text-red-700"}>{cu.cuadra ? "✓ Cuadra: Σ componentes = total" : `✕ No cuadra: diferencia ${cu.diferencia}`}</span>
        {editable && (
          <span className="flex gap-1.5">
            <Boton
              chico
              onClick={() => {
                setTextos({});
                alCancelar();
              }}
            >
              Cancelar
            </Boton>
            <Boton
              chico
              variante="primario"
              onClick={() => {
                setTextos({});
                alGuardar();
              }}
            >
              Guardar
            </Boton>
          </span>
        )}
      </div>
    </div>
  );
}
