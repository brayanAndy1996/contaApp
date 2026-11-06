import { Money, TASA_IGV_18, igvEsperado } from "@contapp/domain";
import { useMemo, useState } from "react";
import type { FilaVenta } from "../../datos/tipos";
import { useDemo } from "../../estado/store";
import { normalizarMonto, sumar } from "../../motor/dominio";
import { Aviso, Boton, Campo, Insignia, Modal, Tarjeta, claseInput, fechaDoc, soles } from "../../ui/comunes";
import { SinPropuesta, TrabajoEnCurso } from "../periodo";

const TIPOS: Record<string, string> = { "01": "Factura", "03": "Boleta", "07": "Nota de crédito", "08": "Nota de débito" };

interface Hueco {
  tipo: string;
  serie: string;
  faltantes: string[];
  antes: string;
  despues: string;
}

/** RF-053: ordena por tipo y serie y busca saltos de numeración (comparación sin number para montos). */
function auditarCorrelatividad(ventas: FilaVenta[]): Hueco[] {
  const grupos = new Map<string, FilaVenta[]>();
  for (const v of ventas) grupos.set(`${v.tipo}|${v.serie}`, [...(grupos.get(`${v.tipo}|${v.serie}`) ?? []), v]);
  const huecos: Hueco[] = [];
  for (const [k, lista] of grupos) {
    const [tipo, serie] = k.split("|") as [string, string];
    const nums = lista.map((v) => BigInt(v.numero)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < nums.length; i++) {
      const dif = nums[i]! - nums[i - 1]!;
      if (dif > 1n) {
        const faltantes: string[] = [];
        for (let n = nums[i - 1]! + 1n; n < nums[i]! && faltantes.length < 20; n++) faltantes.push(String(n));
        huecos.push({ tipo, serie, faltantes, antes: String(nums[i - 1]), despues: String(nums[i]) });
      }
    }
  }
  return huecos;
}

export function VistaVentas({ clienteId }: { clienteId: string }) {
  const { periodo, cliente, agregarVenta } = useDemo();
  const p = periodo(clienteId);
  const c = cliente(clienteId)!;
  const [q, setQ] = useState("");
  const [tipo, setTipo] = useState("");
  const [porPagina, setPorPagina] = useState(25);
  const [pagina, setPagina] = useState(0);
  const [nueva, setNueva] = useState<{ tipo: string; serie: string; numero: string } | null>(null);
  const [base, setBase] = useState("");
  const [fecha, setFecha] = useState("2026-10-15");
  const [lupa, setLupa] = useState<FilaVenta | null>(null);

  const huecos = useMemo(() => auditarCorrelatividad(p.ventas), [p.ventas]);
  const ordenadas = useMemo(
    () => [...p.ventas].sort((a, b) => a.tipo.localeCompare(b.tipo) || a.serie.localeCompare(b.serie) || (BigInt(a.numero) < BigInt(b.numero) ? -1 : 1)),
    [p.ventas],
  );
  const filtradas = ordenadas.filter((v) => (!tipo || v.tipo === tipo) && (!q || `${v.serie}-${v.numero} ${v.nombreCliente} ${v.docCliente}`.toLowerCase().includes(q.toLowerCase())));
  const visibles = porPagina === 0 ? filtradas : filtradas.slice(pagina * porPagina, (pagina + 1) * porPagina);
  const paginas = porPagina === 0 ? 1 : Math.max(1, Math.ceil(filtradas.length / porPagina));

  const resumen = useMemo(() => {
    const tipos = [...new Set(p.ventas.map((v) => v.tipo))];
    return tipos.map((t) => {
      const l = p.ventas.filter((v) => v.tipo === t);
      return { tipo: t, n: l.length, base: sumar(l.map((v) => v.base)), igv: sumar(l.map((v) => v.igv)), exonerado: sumar(l.map((v) => v.exonerado)), total: sumar(l.map((v) => v.total)) };
    });
  }, [p.ventas]);

  if (!p.ventasCargadas)
    return (
      <div className="space-y-4">
        <TrabajoEnCurso cliente={c.razonSocial} tipo="RVIE" />
        <SinPropuesta clienteId={clienteId} libro="ventas" />
      </div>
    );

  const baseNorm = normalizarMonto(base);
  const igvNueva = baseNorm ? igvEsperado(Money.desde(baseNorm, "PEN"), TASA_IGV_18).toString() : "0.00";

  return (
    <div className="space-y-4">
      {huecos.length > 0 ? (
        <Aviso tono="rojo" titulo={`⚠ Auditoría de correlatividad: ${huecos.reduce((n, h) => n + h.faltantes.length, 0)} comprobante(s) faltante(s)`}>
          <ul className="mt-1 space-y-1">
            {huecos.map((h) => (
              <li key={`${h.serie}-${h.antes}`} className="flex flex-wrap items-center gap-2">
                Falta {TIPOS[h.tipo] ?? h.tipo} <b>{h.faltantes.map((n) => `${h.serie}-${n}`).join(", ")}</b> entre la {h.antes} y la {h.despues}. El SIRE no lo trajo: verifica si se emitió y agrégalo.
                <Boton chico variante="primario" onClick={() => setNueva({ tipo: h.tipo, serie: h.serie, numero: h.faltantes[0]! })}>
                  + Agregar {h.serie}-{h.faltantes[0]}
                </Boton>
              </li>
            ))}
          </ul>
        </Aviso>
      ) : (
        <Aviso tono="verde" titulo="✓ Numeración completa">
          No hay saltos de numeración en ninguna serie.
        </Aviso>
      )}

      <Tarjeta titulo="Resumen del periodo por tipo de comprobante">
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular">
            <thead className="bg-slate-50 text-right text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left">Tipo</th>
                <th className="px-4 py-2">Cantidad</th>
                <th className="px-4 py-2">Base imponible</th>
                <th className="px-4 py-2">IGV</th>
                <th className="px-4 py-2">Exonerado</th>
                <th className="px-4 py-2">Total</th>
              </tr>
            </thead>
            <tbody className="text-right">
              {resumen.map((r) => (
                <tr key={r.tipo} className="border-t border-slate-100">
                  <td className="px-4 py-2 text-left">{TIPOS[r.tipo] ?? r.tipo}</td>
                  <td className="px-4 py-2">{r.n}</td>
                  <td className="px-4 py-2">{soles(r.base)}</td>
                  <td className="px-4 py-2">{soles(r.igv)}</td>
                  <td className="px-4 py-2">{soles(r.exonerado)}</td>
                  <td className="px-4 py-2 font-semibold">{soles(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tarjeta>

      <Tarjeta>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <input className={`${claseInput} w-full sm:w-64`} placeholder="Buscar serie, número o cliente" value={q} onChange={(e) => (setQ(e.target.value), setPagina(0))} />
          <select className={claseInput} value={tipo} onChange={(e) => (setTipo(e.target.value), setPagina(0))}>
            <option value="">Todos los tipos</option>
            {Object.entries(TIPOS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <div className="flex-1" />
          <Boton onClick={() => setNueva({ tipo: "03", serie: "B001", numero: "" })}>+ Agregar venta</Boton>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="w-10 px-2 py-2" />
                <th className="px-3 py-2 text-left">Fecha</th>
                <th className="px-3 py-2 text-left">Comprobante</th>
                <th className="px-3 py-2 text-left">Cliente</th>
                <th className="px-3 py-2 text-right">Base</th>
                <th className="px-3 py-2 text-right">IGV</th>
                <th className="px-3 py-2 text-right">Exonerado</th>
                <th className="px-3 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((v) => (
                <tr key={v.id} className={`border-t border-slate-100 hover:bg-slate-50 ${v.agregada ? "bg-emerald-50/50" : ""}`}>
                  <td className="px-2 py-1.5 text-center">
                    <button className="rounded p-1 hover:bg-slate-200" title="Ver detalle" onClick={() => setLupa(v)}>
                      🔍
                    </button>
                  </td>
                  <td className="px-3 py-1.5">{fechaDoc(v.fecha)}</td>
                  <td className="px-3 py-1.5">
                    <span className="text-xs text-slate-500">{TIPOS[v.tipo]}</span> {v.serie}-{v.numero} {v.agregada && <Insignia tono="verde">Agregada</Insignia>}
                  </td>
                  <td className="px-3 py-1.5">
                    {v.nombreCliente} <span className="text-xs text-slate-400">{v.docCliente}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right">{soles(v.base, false)}</td>
                  <td className="px-3 py-1.5 text-right">{soles(v.igv, false)}</td>
                  <td className="px-3 py-1.5 text-right">{soles(v.exonerado, false)}</td>
                  <td className="px-3 py-1.5 text-right font-medium">{soles(v.total, false)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Paginacion total={filtradas.length} porPagina={porPagina} setPorPagina={(n) => (setPorPagina(n), setPagina(0))} pagina={pagina} paginas={paginas} setPagina={setPagina} />
      </Tarjeta>

      <Modal
        abierto={nueva !== null}
        alCerrar={() => setNueva(null)}
        titulo="Agregar venta faltante"
        pie={
          <>
            <Boton onClick={() => setNueva(null)}>Cancelar</Boton>
            <Boton
              variante="primario"
              disabled={!baseNorm || !nueva?.numero}
              onClick={() => {
                if (!nueva || !baseNorm) return;
                agregarVenta(clienteId, {
                  id: `v-${Date.now()}`,
                  tipo: nueva.tipo,
                  serie: nueva.serie,
                  numero: nueva.numero,
                  fecha,
                  docCliente: "-",
                  nombreCliente: "Clientes varios",
                  base: baseNorm,
                  igv: igvNueva,
                  exonerado: "0.00",
                  total: sumar([baseNorm, igvNueva]),
                  agregada: true,
                });
                setNueva(null);
                setBase("");
              }}
            >
              Agregar
            </Boton>
          </>
        }
      >
        {nueva && (
          <div className="grid grid-cols-2 gap-3">
            <Campo etiqueta="Tipo">
              <select className={claseInput} value={nueva.tipo} onChange={(e) => setNueva({ ...nueva, tipo: e.target.value })}>
                {Object.entries(TIPOS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo etiqueta="Fecha de emisión">
              <input type="date" className={claseInput} value={fecha} onChange={(e) => setFecha(e.target.value)} />
            </Campo>
            <Campo etiqueta="Serie">
              <input className={claseInput} value={nueva.serie} onChange={(e) => setNueva({ ...nueva, serie: e.target.value.toUpperCase() })} />
            </Campo>
            <Campo etiqueta="Número">
              <input className={claseInput} value={nueva.numero} onChange={(e) => setNueva({ ...nueva, numero: e.target.value.replace(/\D/g, "") })} />
            </Campo>
            <Campo etiqueta="Base imponible (S/)">
              <input className={claseInput} value={base} onChange={(e) => setBase(e.target.value)} placeholder="100.00" />
            </Campo>
            <Campo etiqueta="IGV 18 % (calculado)">
              <input className={`${claseInput} bg-slate-50`} readOnly value={`${igvNueva} → total ${baseNorm ? sumar([baseNorm, igvNueva]) : "0.00"}`} />
            </Campo>
            <p className="col-span-2 text-xs text-slate-500">También se podría subir el XML de la venta para leerlo automáticamente.</p>
          </div>
        )}
      </Modal>

      <Modal abierto={lupa !== null} alCerrar={() => setLupa(null)} titulo={lupa ? `${TIPOS[lupa.tipo]} ${lupa.serie}-${lupa.numero}` : ""}>
        {lupa && (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-500">Emisor</dt>
            <dd>
              {c.razonSocial} ({c.ruc})
            </dd>
            <dt className="text-slate-500">Cliente</dt>
            <dd>
              {lupa.nombreCliente} {lupa.docCliente}
            </dd>
            <dt className="text-slate-500">Fecha</dt>
            <dd>{fechaDoc(lupa.fecha)}</dd>
            <dt className="text-slate-500">Base / IGV</dt>
            <dd className="tabular">
              {soles(lupa.base)} / {soles(lupa.igv)}
            </dd>
            <dt className="text-slate-500">Exonerado</dt>
            <dd className="tabular">{soles(lupa.exonerado)}</dd>
            <dt className="text-slate-500">Total</dt>
            <dd className="font-semibold tabular">{soles(lupa.total)}</dd>
            <dt className="text-slate-500">Origen</dt>
            <dd>{lupa.serie.startsWith("E") ? "Portal SUNAT" : "Sistema propio del emisor"}</dd>
          </dl>
        )}
      </Modal>
    </div>
  );
}

export function Paginacion({ total, porPagina, setPorPagina, pagina, paginas, setPagina }: { total: number; porPagina: number; setPorPagina: (n: number) => void; pagina: number; paginas: number; setPagina: (n: number) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
      <span>{total} comprobante(s)</span>
      <span className="flex items-center gap-2">
        Por página
        <select className="rounded border border-slate-300 px-1.5 py-1" value={porPagina} onChange={(e) => setPorPagina(Number(e.target.value))}>
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={0}>Todas</option>
        </select>
        <Boton chico disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>
          ‹
        </Boton>
        {pagina + 1} / {paginas}
        <Boton chico disabled={pagina + 1 >= paginas} onClick={() => setPagina(pagina + 1)}>
          ›
        </Boton>
      </span>
    </div>
  );
}
