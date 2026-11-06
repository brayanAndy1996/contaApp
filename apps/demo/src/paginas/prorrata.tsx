import Decimal from "decimal.js";
import { useState } from "react";
import { PERIODO_ACTUAL } from "../datos/semilla";
import { useDemo } from "../estado/store";
import { normalizarMonto, sumar } from "../motor/dominio";
import { Aviso, Boton, Encabezado, Insignia, Kpi, Tarjeta, claseInput, ir, periodoTexto, soles } from "../ui/comunes";

export function Prorrata({ clienteId }: { clienteId?: string }) {
  const { estado, editarMesProrrata, periodo } = useDemo();
  const conDatos = Object.keys(estado.prorrata);
  const id = clienteId && conDatos.includes(clienteId) ? clienteId : conDatos.includes("c4") ? "c4" : conDatos[0]!;
  const meses = estado.prorrata[id] ?? [];
  const [edit, setEdit] = useState<{ periodo: string; g: string; n: string } | null>(null);
  const completos = meses.filter((m) => m.gravadas && m.noGravadas);
  const g = sumar(completos.map((m) => m.gravadas));
  const n = sumar(completos.map((m) => m.noGravadas));
  // Coeficiente = gravadas / (gravadas + no gravadas): razón, no dinero; se calcula con decimal.js.
  const total = new Decimal(g).plus(n);
  const coef = total.isZero() ? new Decimal(0) : new Decimal(g).div(total);
  const pct = coef.times(100).toDecimalPlaces(2).toFixed(2);
  const max = meses.reduce((m, x) => (x.gravadas && new Decimal(x.gravadas).plus(x.noGravadas).gt(m) ? new Decimal(x.gravadas).plus(x.noGravadas) : m), new Decimal(1));

  // IGV estimado del mes: IGV ventas − crédito DG − crédito DGNG × prorrata (RF-134).
  const p = periodo(id);
  const igvVentas = p.ventasCargadas ? sumar(p.ventas.map((v) => v.igv)) : "0.00";
  const vig = p.compras.filter((f) => !f.excluida);
  const credDg = sumar(vig.map((f) => f.montos.igvDg));
  const credDgng = sumar(vig.map((f) => f.montos.igvDgng));
  const usable = new Decimal(credDgng).times(coef).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const igvPagar = new Decimal(igvVentas).minus(credDg).minus(usable);
  const faltante = meses.find((m) => !m.gravadas);

  return (
    <>
      <Encabezado
        titulo={<span>Prorrata e IGV estimado <Insignia tono="violeta">R2</Insignia></span>}
        subtitulo="Coeficiente con los montos declarados en el PDT 621 de los últimos 12 meses (no con el SIRE)."
        acciones={
          <select className={claseInput} value={id} onChange={(e) => ir(`/prorrata/${e.target.value}`)}>
            {conDatos.map((c) => <option key={c} value={c}>{estado.clientes.find((x) => x.id === c)?.razonSocial}</option>)}
          </select>
        }
      />
      {faltante && (
        <div className="mb-4">
          <Aviso tono="ambar" titulo={`Falta el mes ${periodoTexto(faltante.periodo)}`}>
            SOL no devolvió la declaración de ese mes. Ingrésalo a mano para completar los 12 meses.{" "}
            <button className="font-semibold underline" onClick={() => setEdit({ periodo: faltante.periodo, g: "", n: "" })}>Ingresar ahora</button>
          </Aviso>
        </div>
      )}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi etiqueta="Coeficiente de prorrata" valor={`${pct} %`} nota={`${completos.length} de 12 meses`} />
        <Kpi etiqueta="Ventas gravadas (12 m)" valor={soles(g)} />
        <Kpi etiqueta="Ventas no gravadas (12 m)" valor={soles(n)} />
        <Kpi etiqueta={`IGV estimado ${periodoTexto(PERIODO_ACTUAL)}`} valor={p.comprasCargadas && p.ventasCargadas ? soles(igvPagar.abs().toFixed(2)) : "—"} tono={igvPagar.isNegative() ? "verde" : "rojo"} nota={p.comprasCargadas && p.ventasCargadas ? (igvPagar.isNegative() ? "Saldo a favor" : "Por pagar") : "Descarga ventas y compras del periodo"} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Tarjeta className="lg:col-span-2" titulo="Detalle mes a mes">
          <div className="space-y-1.5 p-4">
            {meses.map((m) => {
              const tot = m.gravadas ? new Decimal(m.gravadas).plus(m.noGravadas) : new Decimal(0);
              const wg = m.gravadas ? new Decimal(m.gravadas).div(max).times(100).toNumber() : 0;
              const wn = m.gravadas ? new Decimal(m.noGravadas).div(max).times(100).toNumber() : 0;
              return (
                <div key={m.periodo} className="grid grid-cols-12 items-center gap-2 text-xs">
                  <span className="col-span-2 text-slate-600">{m.periodo.slice(4)}/{m.periodo.slice(0, 4)}</span>
                  <div className="col-span-6 flex h-4 overflow-hidden rounded bg-slate-100">
                    <div className="bg-teal-600" style={{ width: `${wg}%` }} title={`Gravadas ${m.gravadas}`} />
                    <div className="bg-amber-400" style={{ width: `${wn}%` }} title={`No gravadas ${m.noGravadas}`} />
                  </div>
                  <span className="col-span-2 text-right tabular">{m.gravadas ? soles(tot.toFixed(2), false) : "—"}</span>
                  <span className="col-span-2 flex items-center justify-end gap-1">
                    <Insignia tono={m.origen === "Manual" ? "ambar" : "gris"}>{m.origen === "Manual" ? "Manual" : "PDT 621"}</Insignia>
                    <button className="text-slate-400 hover:text-teal-700" onClick={() => setEdit({ periodo: m.periodo, g: m.gravadas, n: m.noGravadas })}>✎</button>
                  </span>
                </div>
              );
            })}
            <div className="flex gap-4 pt-2 text-[11px] text-slate-500">
              <span><span className="mr-1 inline-block h-2 w-2 rounded bg-teal-600" />Gravadas</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded bg-amber-400" />No gravadas</span>
            </div>
          </div>
        </Tarjeta>
        <Tarjeta titulo={`Cálculo del IGV · ${periodoTexto(PERIODO_ACTUAL)}`}>
          <dl className="space-y-1.5 p-4 text-sm tabular">
            <div className="flex justify-between"><dt>IGV de ventas</dt><dd>{soles(igvVentas)}</dd></div>
            <div className="flex justify-between"><dt>− Crédito DG</dt><dd>{soles(credDg)}</dd></div>
            <div className="flex justify-between"><dt>− Crédito DGNG × {pct} %</dt><dd>{soles(usable.toFixed(2))}</dd></div>
            <div className="flex justify-between text-xs text-slate-400"><dt>(DGNG total {soles(credDgng)})</dt></div>
            <div className="flex justify-between border-t border-slate-200 pt-1.5 font-bold"><dt>{igvPagar.isNegative() ? "Saldo a favor" : "IGV a pagar"}</dt><dd>{soles(igvPagar.abs().toFixed(2))}</dd></div>
            {!(p.comprasCargadas && p.ventasCargadas) && <p className="pt-2 text-xs text-amber-700">Descarga las propuestas de ventas y compras del periodo para ver el cálculo real.</p>}
          </dl>
        </Tarjeta>
      </div>
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={(e) => e.target === e.currentTarget && setEdit(null)}>
          <div className="w-full max-w-sm space-y-3 rounded-xl bg-white p-5 shadow-2xl">
            <h3 className="font-semibold">Ingresar {periodoTexto(edit.periodo)}</h3>
            <input className={`${claseInput} w-full`} placeholder="Ventas gravadas" value={edit.g} onChange={(e) => setEdit({ ...edit, g: e.target.value })} />
            <input className={`${claseInput} w-full`} placeholder="Ventas no gravadas" value={edit.n} onChange={(e) => setEdit({ ...edit, n: e.target.value })} />
            <div className="flex justify-end gap-2">
              <Boton onClick={() => setEdit(null)}>Cancelar</Boton>
              <Boton variante="primario" disabled={!normalizarMonto(edit.g) || !normalizarMonto(edit.n)} onClick={() => { editarMesProrrata(id, edit.periodo, normalizarMonto(edit.g)!, normalizarMonto(edit.n)!); setEdit(null); }}>Guardar</Boton>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
