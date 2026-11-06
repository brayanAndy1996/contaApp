import { ESTUDIO, PERIODO_ACTUAL } from "../datos/semilla";
import { useDemo } from "../estado/store";
import { Aviso, Encabezado, Insignia, Kpi, Tarjeta, fechaCorta, periodoTexto } from "../ui/comunes";
import { EstadoCredencialInsignia } from "./clientes";

export function estadoPeriodoTexto(p: { comprasCargadas: boolean; ventasCargadas: boolean; revisado: boolean; versiones: { ticket?: { estado: string } }[] }) {
  if (p.versiones.some((v) => v.ticket?.estado === "procesado")) return { texto: "Enviado a SUNAT", tono: "verde" as const };
  if (p.versiones.length > 0) return { texto: "Archivo generado", tono: "teal" as const };
  if (p.revisado) return { texto: "Revisado", tono: "azul" as const };
  if (p.comprasCargadas || p.ventasCargadas) return { texto: "En revisión", tono: "ambar" as const };
  return { texto: "Sin descargar", tono: "gris" as const };
}

export function Panel() {
  const { estado, usuario, periodo } = useDemo();
  const activos = estado.clientes.filter((c) => c.activo);
  const criticos = estado.mensajes.filter((m) => m.critico && !m.atendido);
  const invalidas = activos.filter((c) => c.credencialSol === "invalida" || c.credencialSire === "invalida");
  const pendientes = activos.filter((c) => periodo(c.id).versiones.length === 0);
  return (
    <>
      <Encabezado titulo={`Hola, ${usuario?.nombre.split(" ")[0]} 👋`} subtitulo={`Periodo en curso: ${periodoTexto(PERIODO_ACTUAL)} · ${ESTUDIO.nombre}`} />
      {estado.auditoria.length < 3 && (
        <div className="mb-5">
          <Aviso tono="azul" titulo="¿Primera vez? Empieza por aquí">
            Abre <a className="font-semibold underline" href="#/clientes/c1/compras">DISTRIBUIDORA ANDINA DEMO → Compras</a> y presiona «Descargar propuesta SIRE». Verás el motor de correcciones actuar sobre casos reales de contadores (ISC en DG,
            factura mixta, redondeo en dólares, gasto personal). La <a className="font-semibold underline" href="#/guia">guía de la demo</a> tiene el recorrido completo.
          </Aviso>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi etiqueta="Clientes activos" valor={`${activos.length}/${ESTUDIO.limiteRucs}`} nota={ESTUDIO.plan} />
        <Kpi etiqueta="Periodos por presentar" valor={pendientes.length} nota={periodoTexto(PERIODO_ACTUAL)} tono={pendientes.length ? "ambar" : "verde"} />
        <Kpi etiqueta="Mensajes críticos" valor={criticos.length} nota="Buzones SOL sin atender" tono={criticos.length ? "rojo" : "verde"} />
        <Kpi etiqueta="Credenciales con problema" valor={invalidas.length} nota="Revisar clave SOL / SIRE" tono={invalidas.length ? "rojo" : "verde"} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Tarjeta className="xl:col-span-2" titulo={`Clientes · ${periodoTexto(PERIODO_ACTUAL)}`} accion={<a href="#/clientes" className="text-xs font-medium text-teal-700 hover:underline">Ver todos →</a>}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Cliente</th>
                  <th className="px-4 py-2">Credenciales</th>
                  <th className="px-4 py-2">Estado del periodo</th>
                  <th className="px-4 py-2">Buzón</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {activos.map((c) => {
                  const p = periodo(c.id);
                  const e = estadoPeriodoTexto(p);
                  const msj = estado.mensajes.filter((m) => m.clienteId === c.id && !m.atendido);
                  return (
                    <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <a href={`#/clientes/${c.id}`} className="font-medium text-slate-800 hover:text-teal-700">
                          {c.razonSocial}
                        </a>
                        <div className="text-xs text-slate-500">
                          RUC {c.ruc} · {c.responsable}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <EstadoCredencialInsignia e={c.credencialSol} etiqueta="SOL" />
                      </td>
                      <td className="px-4 py-2.5">
                        <Insignia tono={e.tono}>{e.texto}</Insignia>
                      </td>
                      <td className="px-4 py-2.5">
                        {msj.length > 0 ? <Insignia tono={msj.some((m) => m.critico) ? "rojo" : "azul"}>{msj.length} nuevo(s)</Insignia> : <span className="text-xs text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <a href={`#/clientes/${c.id}/compras`} className="text-xs font-semibold text-teal-700 hover:underline">
                          Abrir compras →
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Tarjeta>

        <div className="space-y-5">
          <Tarjeta titulo="Buzones: mensajes críticos" accion={<a href="#/buzones" className="text-xs font-medium text-teal-700 hover:underline">Bandeja →</a>}>
            <ul className="divide-y divide-slate-100">
              {criticos.slice(0, 4).map((m) => (
                <li key={m.id} className="px-4 py-2.5">
                  <a href="#/buzones" className="block text-sm font-medium text-slate-800 hover:text-teal-700">
                    {m.asunto}
                  </a>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                    <Insignia tono="rojo">{m.tipo}</Insignia>
                    {estado.clientes.find((c) => c.id === m.clienteId)?.razonSocial}
                  </div>
                </li>
              ))}
              {criticos.length === 0 && <li className="px-4 py-6 text-center text-sm text-slate-500">Sin mensajes críticos 🎉</li>}
            </ul>
          </Tarjeta>
          <Tarjeta titulo="Actividad reciente" accion={<a href="#/auditoria" className="text-xs font-medium text-teal-700 hover:underline">Auditoría →</a>}>
            <ul className="divide-y divide-slate-100">
              {estado.auditoria.slice(0, 6).map((a) => (
                <li key={a.id} className="px-4 py-2 text-sm">
                  <span className="font-medium text-slate-800">{a.accion}</span>
                  <span className="text-slate-500"> · {a.detalle}</span>
                  <div className="text-[11px] text-slate-400">
                    {a.usuario} · {fechaCorta(a.fecha)}
                  </div>
                </li>
              ))}
              {estado.auditoria.length === 0 && <li className="px-4 py-6 text-center text-sm text-slate-500">Aún no hay actividad</li>}
            </ul>
          </Tarjeta>
        </div>
      </div>
    </>
  );
}
