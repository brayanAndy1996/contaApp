import { validarRuc } from "@contapp/shared";
import { useEffect, useMemo, useState } from "react";
import { Money, TASA_IGV_18, igvEsperado } from "@contapp/domain";
import type { Destino } from "@contapp/domain";
import type { FilaCompra, MontosPlanos } from "../../datos/tipos";
import { COLUMNAS_COMPRA, ETIQUETA_COLUMNA, claveHallazgo, cuadre, destinoDe, esCero, igvTotal, moverADestino, normalizarMonto, restar, sumaComponentes, sumar } from "../../motor/dominio";
import { descargar } from "../../motor/empaquetar";
import type { ColumnaCompra } from "../../motor/dominio";
import { Aviso, Boton, Campo, Insignia, Modal, Tarjeta, claseInput, fechaDoc, soles } from "../../ui/comunes";
import { SinPropuesta } from "../periodo";
import { Paginacion } from "./ventas";
import { Lupa } from "./lupa";
import { EXPLICACION_REGLA, TONO_REGLA, useCompras } from "./usar-compras";

type Segmento = "todas" | "observadas" | "con_igv" | "sin_igv" | "excluidas";

function CeldaMonto({ valor, editable, alCambiar, resaltar }: { valor: string; editable: boolean; alCambiar: (v: string) => void; resaltar?: boolean }) {
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState(valor);
  const [error, setError] = useState(false);
  if (editando)
    return (
      <input
        autoFocus
        className={`w-24 rounded border px-1 py-0.5 text-right text-xs tabular outline-none ${error ? "border-red-500 bg-red-50" : "border-teal-600 bg-white ring-2 ring-teal-600/20"}`}
        value={texto}
        onChange={(e) => {
          setTexto(e.target.value);
          setError(normalizarMonto(e.target.value) === null);
        }}
        onBlur={() => {
          const n = normalizarMonto(texto);
          if (n !== null && n !== valor) alCambiar(n);
          setEditando(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setTexto(valor);
            setEditando(false);
          }
        }}
      />
    );
  return (
    <span
      onClick={() => {
        if (!editable) return;
        setTexto(valor);
        setError(false);
        setEditando(true);
      }}
      className={`block min-w-16 rounded px-1 py-0.5 text-right ${editable ? "cursor-text hover:bg-teal-50 hover:ring-1 hover:ring-teal-200" : ""} ${esCero(valor) ? "text-slate-300" : ""} ${resaltar && !esCero(valor) ? "bg-amber-100 font-semibold text-amber-900" : ""}`}
    >
      {soles(valor, false)}
    </span>
  );
}

export function VistaCompras({ clienteId }: { clienteId: string }) {
  const h = useCompras(clienteId);
  const { p, cliente, razonSocial, deshacer, rehacer, pendientes, historial, bloqueado, totalPendientes, clasificar, excluir, restaurar, editarFila, aplicarHallazgo, aplicarHistorial, conocidos, cambiarCompras } = h;
  const c = cliente(clienteId)!;
  const [q, setQ] = useState("");
  const [segmento, setSegmento] = useState<Segmento>("todas");
  const [porPagina, setPorPagina] = useState(25);
  const [pagina, setPagina] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [lupa, setLupa] = useState<string | null>(null);
  const [excluirIds, setExcluirIds] = useState<string[] | null>(null);
  const [motivo, setMotivo] = useState("");
  const [agregar, setAgregar] = useState(false);
  const [recalcular, setRecalcular] = useState(true);
  const [mensaje, setMensaje] = useState<string | null>(null);

  // Atajos Ctrl+Z / Ctrl+Y (RF-065) y abrir la lupa desde ?lupa=ID (enlaces de Generar).
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (lupa || (e.target as HTMLElement).tagName === "INPUT") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") (e.preventDefault(), deshacer(clienteId));
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") (e.preventDefault(), rehacer(clienteId));
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [lupa, clienteId, deshacer, rehacer]);
  useEffect(() => {
    const m = window.location.hash.match(/[?&]lupa=([^&]+)/);
    if (m && p.compras.some((f) => f.id === m[1])) setLupa(m[1]!);
  }, [p.compras]);

  const filtradas = useMemo(
    () =>
      p.compras.filter((f) => {
        if (q && !`${f.serie}-${f.numero} ${f.proveedorRuc} ${razonSocial(f.proveedorRuc)}`.toLowerCase().includes(q.toLowerCase())) return false;
        if (segmento === "excluidas") return !!f.excluida;
        if (f.excluida) return segmento === "todas";
        if (segmento === "observadas") return pendientes(f.id).length > 0 || historial(f) !== null;
        if (segmento === "con_igv") return !esCero(igvTotal(f.montos));
        if (segmento === "sin_igv") return esCero(igvTotal(f.montos));
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.compras, q, segmento, h.ev, p.resueltos],
  );

  if (!p.comprasCargadas)
    return (
      <div className="space-y-4">
        <SinPropuesta clienteId={clienteId} libro="compras" />
      </div>
    );

  const visibles = porPagina === 0 ? filtradas : filtradas.slice(pagina * porPagina, (pagina + 1) * porPagina);
  const paginas = porPagina === 0 ? 1 : Math.max(1, Math.ceil(filtradas.length / porPagina));
  const ids = [...sel];

  // Sugerencias que el XML respalda: se pueden aceptar en bloque sin preguntar (RF-080).
  const automaticas = p.compras.flatMap((f) => (f.excluida ? [] : pendientes(f.id).filter((x) => !x.requiereConfirmacion && x.dato === null && x.sugerencia && x.sugerencia.tipo !== "excluir")));
  const historiales = p.compras.map((f) => historial(f)).filter((x) => x !== null);

  const aceptarAutomaticas = () => {
    let errores = 0;
    for (const x of automaticas) if (aplicarHallazgo(x)) errores++;
    setMensaje(`${automaticas.length - errores} sugerencia(s) respaldadas por el XML aplicadas${errores ? `, ${errores} con error` : ""}.`);
  };

  const editarMonto = (f: FilaCompra, col: ColumnaCompra | "total", v: string) => {
    const m: MontosPlanos = { ...f.montos, [col]: v };
    if (col !== "total" && recalcular) m.total = sumaComponentes(m);
    editarFila(f.id, { montos: m }, `${f.serie}-${f.numero}: ${ETIQUETA_COLUMNA[col]} ${f.montos[col]} → ${v}`);
  };

  const exportarCsv = () => {
    const cab = ["Fecha", "Tipo", "Serie", "Numero", "RUC proveedor", "Proveedor", ...COLUMNAS_COMPRA.map((k) => ETIQUETA_COLUMNA[k]), "Total", "Estado", "Observaciones"];
    const lineas = p.compras.map((f) =>
      [fechaDoc(f.fecha), f.tipo, f.serie, f.numero, f.proveedorRuc, `"${razonSocial(f.proveedorRuc)}"`, ...COLUMNAS_COMPRA.map((k) => f.montos[k]), f.montos.total, f.excluida ? "Excluida" : f.agregada ? "Agregada" : "", `"${pendientes(f.id).map((x) => x.regla).join(" ")}"`].join(","),
    );
    descargar(`compras-${c.ruc}-202610.csv`, "﻿" + [cab.join(","), ...lineas].join("\r\n"), "text/csv;charset=utf-8");
  };

  const segmentos: { id: Segmento; texto: string; n: number }[] = [
    { id: "todas", texto: "Todas", n: p.compras.length },
    { id: "observadas", texto: "Con observaciones", n: p.compras.filter((f) => !f.excluida && (pendientes(f.id).length > 0 || historial(f))).length },
    { id: "con_igv", texto: "Con IGV", n: p.compras.filter((f) => !f.excluida && !esCero(igvTotal(f.montos))).length },
    { id: "sin_igv", texto: "Sin IGV (sin crédito fiscal)", n: p.compras.filter((f) => !f.excluida && esCero(igvTotal(f.montos))).length },
    { id: "excluidas", texto: "Excluidas", n: p.compras.filter((f) => f.excluida).length },
  ];

  return (
    <div className="space-y-4">
      {bloqueado && <Aviso tono="ambar">El periodo está marcado como revisado: solo quien tiene el permiso «aprobar y generar» puede editarlo.</Aviso>}
      {totalPendientes > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="text-lg">🤖</span>
          <span className="flex-1">
            El motor de correcciones encontró <b>{totalPendientes}</b> observación(es). Ninguna se aplica sola: revisa cada una con la lupa 🔍 o acepta en bloque las que el XML respalda.
          </span>
          {automaticas.length > 0 && !bloqueado && (
            <Boton chico variante="primario" onClick={aceptarAutomaticas}>
              ✓ Aceptar {automaticas.length} respaldada(s) por XML
            </Boton>
          )}
          {historiales.length > 0 && !bloqueado && (
            <Boton chico variante="primario" onClick={() => historiales.forEach((s) => aplicarHistorial(s!))}>
              ✓ Aplicar {historiales.length} según historial
            </Boton>
          )}
        </div>
      ) : (
        <Aviso tono="verde">✓ Sin observaciones pendientes. Revisa el resumen y pasa a «Generar archivo».</Aviso>
      )}
      {mensaje && (
        <Aviso tono="verde">
          {mensaje}{" "}
          <button className="underline" onClick={() => setMensaje(null)}>
            cerrar
          </button>
        </Aviso>
      )}

      <Tarjeta>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <input className={`${claseInput} w-full sm:w-64`} placeholder="Buscar proveedor, RUC o comprobante" value={q} onChange={(e) => (setQ(e.target.value), setPagina(0))} />
          <div className="flex flex-wrap gap-1">
            {segmentos.map((s) => (
              <button key={s.id} onClick={() => (setSegmento(s.id), setPagina(0))} className={`rounded-full px-3 py-1 text-xs font-medium ${segmento === s.id ? "bg-teal-700 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {s.texto} <span className="opacity-70">{s.n}</span>
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <Boton chico onClick={() => deshacer(clienteId)} disabled={p.deshacer.length === 0 || bloqueado} title="Ctrl+Z">
            ↶ Deshacer
          </Boton>
          <Boton chico onClick={() => rehacer(clienteId)} disabled={p.rehacer.length === 0 || bloqueado} title="Ctrl+Y">
            ↷ Rehacer
          </Boton>
          <Boton chico onClick={exportarCsv}>⤓ Excel</Boton>
          <Boton chico onClick={() => setAgregar(true)} disabled={bloqueado}>
            + Agregar compra
          </Boton>
        </div>

        {sel.size > 0 && !bloqueado && (
          <div className="flex flex-wrap items-center gap-2 border-b border-teal-100 bg-teal-50 px-3 py-2 text-sm">
            <b>{sel.size} seleccionada(s)</b>
            <span className="text-slate-500">Clasificar como:</span>
            {(["DG", "DGNG", "DNG"] as Destino[]).map((d) => (
              <Boton key={d} chico onClick={() => (clasificar(ids, d), setSel(new Set()))}>
                {d}
              </Boton>
            ))}
            <Boton chico variante="peligro" onClick={() => setExcluirIds(ids)}>
              Excluir (no deducible)
            </Boton>
            <Boton chico variante="fantasma" onClick={() => setSel(new Set())}>
              Quitar selección
            </Boton>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular">
            <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-2">
                  <input type="checkbox" checked={visibles.length > 0 && visibles.every((f) => sel.has(f.id))} onChange={(e) => setSel(e.target.checked ? new Set(visibles.map((f) => f.id)) : new Set())} />
                </th>
                <th className="px-1 py-2" />
                <th className="px-2 py-2 text-left">Fecha</th>
                <th className="px-2 py-2 text-left">Comprobante</th>
                <th className="px-2 py-2 text-left">Proveedor</th>
                <th className="px-2 py-2 text-left">Clasif.</th>
                {COLUMNAS_COMPRA.map((k) => (
                  <th key={k} className="px-2 py-2 text-right">
                    {ETIQUETA_COLUMNA[k]}
                  </th>
                ))}
                <th className="px-2 py-2 text-right">Total</th>
                <th className="px-2 py-2 text-left">Reglas</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((f) => {
                const obs = pendientes(f.id);
                const his = historial(f);
                const cu = cuadre(f.montos);
                const d = destinoDe(f.montos);
                const nuevo = !conocidos.includes(f.proveedorRuc);
                const editable = !bloqueado && !f.excluida;
                const resaltar = new Set(obs.flatMap((x) => Object.keys(x.lecturas)));
                return (
                  <tr key={f.id} className={`border-t border-slate-100 ${f.excluida ? "bg-slate-50 text-slate-400 line-through decoration-slate-300" : obs.length ? "bg-amber-50/40" : ""} ${f.agregada ? "bg-emerald-50/60" : ""} hover:bg-slate-50`}>
                    <td className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={sel.has(f.id)}
                        onChange={(e) => {
                          const n = new Set(sel);
                          if (e.target.checked) n.add(f.id);
                          else n.delete(f.id);
                          setSel(n);
                        }}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <button className="rounded p-1 no-underline hover:bg-slate-200" title="Ver detalle del comprobante" onClick={() => setLupa(f.id)}>
                        🔍
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1">{fechaDoc(f.fecha)}</td>
                    <td className="whitespace-nowrap px-2 py-1">
                      <span className="text-slate-400">{f.tipo}</span> {f.serie}-{f.numero}
                      {f.usd && (
                        <span className="ml-1">
                          <Insignia tono="azul" title={`TC ${f.usd.tipoCambio}`}>
                            USD
                          </Insignia>
                        </span>
                      )}
                      {p.xmlEstado[f.id] !== "disponible" && (
                        <span className="ml-1" title="XML no disponible">
                          <Insignia tono="gris">sin XML</Insignia>
                        </span>
                      )}
                    </td>
                    <td className="max-w-56 px-2 py-1">
                      <div className="truncate font-medium text-slate-700" title={razonSocial(f.proveedorRuc)}>
                        {razonSocial(f.proveedorRuc)}
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-slate-400">
                        {f.proveedorRuc} {nuevo && <Insignia tono="violeta">Nuevo</Insignia>}
                      </div>
                    </td>
                    <td className="px-2 py-1">
                      {f.excluida ? (
                        <Boton chico variante="fantasma" onClick={() => restaurar([f.id])} disabled={bloqueado} title={f.motivoExclusion}>
                          Restaurar
                        </Boton>
                      ) : (
                        <select
                          disabled={!editable || d === null}
                          value={d === "MIXTO" || d === null ? "" : d}
                          onChange={(e) => clasificar([f.id], e.target.value as Destino)}
                          className={`rounded border px-1 py-0.5 text-xs font-semibold ${d === "DG" ? "border-sky-200 bg-sky-50 text-sky-800" : d === "DGNG" ? "border-violet-200 bg-violet-50 text-violet-800" : d === "DNG" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-slate-200"}`}
                        >
                          {(d === "MIXTO" || d === null) && <option value="">{d === null ? "—" : "Mixto"}</option>}
                          <option>DG</option>
                          <option>DGNG</option>
                          <option>DNG</option>
                        </select>
                      )}
                    </td>
                    {COLUMNAS_COMPRA.map((k) => (
                      <td key={k} className="px-1 py-1">
                        <CeldaMonto valor={f.montos[k]} editable={editable} resaltar={resaltar.has(k)} alCambiar={(v) => editarMonto(f, k, v)} />
                      </td>
                    ))}
                    <td className="px-1 py-1">
                      <div className="flex items-center justify-end gap-1">
                        {!cu.cuadra && (
                          <span className="text-red-600" title={`No cuadra: diferencia ${cu.diferencia}`}>
                            ●
                          </span>
                        )}
                        <CeldaMonto valor={f.montos.total} editable={editable} resaltar={resaltar.has("total")} alCambiar={(v) => editarMonto(f, "total", v)} />
                      </div>
                    </td>
                    <td className="px-2 py-1">
                      <div className="flex flex-wrap gap-1">
                        {obs.map((x) => (
                          <button key={claveHallazgo(x)} onClick={() => setLupa(f.id)} title={x.explicacion}>
                            <Insignia tono={TONO_REGLA[x.regla]}>{x.regla}</Insignia>
                          </button>
                        ))}
                        {his && (
                          <button onClick={() => setLupa(f.id)} title={`Según historial: ${his.destino}`}>
                            <Insignia tono="teal">R-HIS → {his.destino}</Insignia>
                          </button>
                        )}
                        {f.excluida && <Insignia>{f.motivoExclusion ?? "Excluida"}</Insignia>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={recalcular} onChange={(e) => setRecalcular(e.target.checked)} /> Recalcular el total al editar una celda
          </label>
          <span>Haz clic en cualquier monto para editarlo · ● = la fila no cuadra · Las celdas resaltadas son las que leyó la regla</span>
        </div>
        <Paginacion total={filtradas.length} porPagina={porPagina} setPorPagina={(n) => (setPorPagina(n), setPagina(0))} pagina={pagina} paginas={paginas} setPagina={setPagina} />
      </Tarjeta>

      <ResumenCasilleros originales={p.comprasOriginales} vigentes={p.compras} />

      {lupa && <Lupa clienteId={clienteId} filaId={lupa} ids={filtradas.map((f) => f.id)} alCambiar={setLupa} alCerrar={() => setLupa(null)} />}

      <Modal
        abierto={excluirIds !== null}
        alCerrar={() => setExcluirIds(null)}
        titulo="Excluir como no deducible"
        pie={
          <>
            <Boton onClick={() => setExcluirIds(null)}>Cancelar</Boton>
            <Boton
              variante="peligro"
              onClick={() => {
                excluir(excluirIds ?? [], motivo);
                setExcluirIds(null);
                setSel(new Set());
                setMotivo("");
              }}
            >
              Excluir {excluirIds?.length} compra(s)
            </Boton>
          </>
        }
      >
        <Campo etiqueta="Motivo (opcional)" ayuda="Quedan visibles en «Excluidas» y se pueden restaurar.">
          <input className={claseInput} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Gasto personal del dueño" />
        </Campo>
      </Modal>

      <AgregarCompra
        abierto={agregar}
        alCerrar={() => setAgregar(false)}
        alGuardar={(f) => {
          cambiarCompras(clienteId, (filas) => [...filas, f], `Compra agregada ${f.serie}-${f.numero} (${f.proveedorRuc})`);
          setAgregar(false);
        }}
      />
    </div>
  );
}

function ResumenCasilleros({ originales, vigentes }: { originales: FilaCompra[]; vigentes: FilaCompra[] }) {
  const suma = (filas: FilaCompra[], k: ColumnaCompra | "total") => sumar(filas.filter((f) => !f.excluida).map((f) => f.montos[k]));
  const filas = [...COLUMNAS_COMPRA, "total" as const];
  return (
    <Tarjeta titulo="Resumen por casillero: propuesta SIRE vs. corregida">
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular">
          <thead className="bg-slate-50 text-right text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left">Casillero</th>
              <th className="px-4 py-2">Propuesta SIRE</th>
              <th className="px-4 py-2">Corregida</th>
              <th className="px-4 py-2">Diferencia</th>
            </tr>
          </thead>
          <tbody className="text-right">
            {filas.map((k) => {
              const o = suma(originales, k);
              const v = suma(vigentes, k);
              const d = restar(v, o);
              return (
                <tr key={k} className={`border-t border-slate-100 ${k === "total" ? "font-semibold" : ""}`}>
                  <td className="px-4 py-1.5 text-left">{ETIQUETA_COLUMNA[k]}</td>
                  <td className="px-4 py-1.5">{soles(o, false)}</td>
                  <td className="px-4 py-1.5">{soles(v, false)}</td>
                  <td className={`px-4 py-1.5 ${esCero(d) ? "text-slate-300" : d.startsWith("-") ? "text-red-700" : "text-emerald-700"}`}>{esCero(d) ? "—" : soles(d, false)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Tarjeta>
  );
}

function AgregarCompra({ abierto, alCerrar, alGuardar }: { abierto: boolean; alCerrar: () => void; alGuardar: (f: FilaCompra) => void }) {
  const [ruc, setRuc] = useState("20700001203");
  const [serie, setSerie] = useState("F001");
  const [numero, setNumero] = useState("");
  const [fecha, setFecha] = useState("2026-10-20");
  const [base, setBase] = useState("");
  const [destino, setDestino] = useState<Destino>("DG");
  const b = normalizarMonto(base);
  const valido = validarRuc(ruc) && /^[A-Z0-9]{4}$/.test(serie) && /^\d{1,8}$/.test(numero) && b !== null;
  const guardar = () => {
    if (!b) return;
    const m = { biDg: b, igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
    m.igvDg = igvEsperado(Money.desde(b, "PEN"), TASA_IGV_18).toString();
    m.total = sumar([m.biDg, m.igvDg]);
    alGuardar({ id: `ag-${Date.now()}`, tipo: "01", serie, numero, fecha, proveedorRuc: ruc, montos: destino === "DG" ? m : moverADestino(m, destino), agregada: true });
    setNumero("");
    setBase("");
  };
  return (
    <Modal
      abierto={abierto}
      alCerrar={alCerrar}
      titulo="Agregar compra no propuesta por el SIRE"
      pie={
        <>
          <Boton onClick={alCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={!valido} onClick={guardar}>
            Agregar
          </Boton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Campo etiqueta="RUC del proveedor" ayuda={validarRuc(ruc) ? "RUC válido" : "Dígito verificador inválido"}>
          <input className={claseInput} value={ruc} onChange={(e) => setRuc(e.target.value.replace(/\D/g, "").slice(0, 11))} />
        </Campo>
        <Campo etiqueta="Fecha de emisión">
          <input type="date" className={claseInput} value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </Campo>
        <Campo etiqueta="Serie">
          <input className={claseInput} value={serie} onChange={(e) => setSerie(e.target.value.toUpperCase().slice(0, 4))} />
        </Campo>
        <Campo etiqueta="Número">
          <input className={claseInput} value={numero} onChange={(e) => setNumero(e.target.value.replace(/\D/g, ""))} />
        </Campo>
        <Campo etiqueta="Base imponible (S/)">
          <input className={claseInput} value={base} onChange={(e) => setBase(e.target.value)} placeholder="500.00" />
        </Campo>
        <Campo etiqueta="Clasificación">
          <select className={claseInput} value={destino} onChange={(e) => setDestino(e.target.value as Destino)}>
            <option>DG</option>
            <option>DGNG</option>
            <option>DNG</option>
          </select>
        </Campo>
        <p className="col-span-2 text-xs text-slate-500">En el producto también se puede subir el XML y la fila se arma sola.</p>
      </div>
    </Modal>
  );
}
