import { useState } from "react";
import { ESTUDIO } from "../datos/semilla";
import type { EstadoCredencial } from "../datos/tipos";
import { useDemo } from "../estado/store";
import { Boton, Encabezado, Insignia, Tarjeta, claseInput, ir } from "../ui/comunes";
import { puede } from "../ui/permisos";
import { estadoPeriodoTexto } from "./panel";

export function EstadoCredencialInsignia({ e, etiqueta }: { e: EstadoCredencial; etiqueta: string }) {
  if (e === "valida") return <Insignia tono="verde">✓ {etiqueta} válida</Insignia>;
  if (e === "invalida") return <Insignia tono="rojo">✕ {etiqueta} inválida</Insignia>;
  if (e === "verificando") return <Insignia tono="azul">⟳ Verificando {etiqueta}</Insignia>;
  return <Insignia tono="gris">Sin {etiqueta}</Insignia>;
}

export function Clientes() {
  const { estado, usuario, periodo } = useDemo();
  const [q, setQ] = useState("");
  const [resp, setResp] = useState("");
  const lista = estado.clientes.filter((c) => (!q || `${c.ruc} ${c.razonSocial}`.toLowerCase().includes(q.toLowerCase())) && (!resp || c.responsable === resp));
  const activos = estado.clientes.filter((c) => c.activo).length;
  return (
    <>
      <Encabezado
        titulo="Clientes"
        subtitulo={`${activos} de ${ESTUDIO.limiteRucs} RUC del ${ESTUDIO.plan}`}
        acciones={
          puede(usuario?.rol, "clientes.gestionar") && (
            <>
              <Boton onClick={() => ir("/clientes/importar")}>⇪ Importar CSV/Excel</Boton>
              <Boton variante="primario" onClick={() => ir("/clientes/nuevo")} disabled={activos >= ESTUDIO.limiteRucs}>
                + Nuevo cliente
              </Boton>
            </>
          )
        }
      />
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full rounded-full bg-teal-600" style={{ width: `${(activos / ESTUDIO.limiteRucs) * 100}%` }} />
      </div>
      <Tarjeta>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <input className={`${claseInput} w-full sm:w-72`} placeholder="Buscar por RUC o razón social" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={claseInput} value={resp} onChange={(e) => setResp(e.target.value)}>
            <option value="">Todos los responsables</option>
            {estado.usuarios.map((u) => (
              <option key={u.id}>{u.nombre}</option>
            ))}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">RUC / Razón social</th>
                <th className="px-4 py-2">Ubicación</th>
                <th className="px-4 py-2">Régimen</th>
                <th className="px-4 py-2">Credenciales</th>
                <th className="px-4 py-2">Periodo actual</th>
                <th className="px-4 py-2">Responsable</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((c) => {
                const e = estadoPeriodoTexto(periodo(c.id));
                const msj = estado.mensajes.filter((m) => m.clienteId === c.id && !m.atendido).length;
                return (
                  <tr key={c.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => ir(`/clientes/${c.id}`)}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-800">
                        {c.razonSocial} {msj > 0 && <span title="Mensajes nuevos en el buzón">✉️</span>}
                      </div>
                      <div className="text-xs text-slate-500">{c.ruc}</div>
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {c.ubicacion}
                      {c.zonaSelva && (
                        <span className="ml-1">
                          <Insignia tono="verde">Selva</Insignia>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{c.regimen}</td>
                    <td className="space-x-1 px-4 py-2.5">
                      <EstadoCredencialInsignia e={c.credencialSol} etiqueta="SOL" />
                      <EstadoCredencialInsignia e={c.credencialSire} etiqueta="SIRE" />
                    </td>
                    <td className="px-4 py-2.5">
                      <Insignia tono={e.tono}>{e.texto}</Insignia>
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{c.responsable}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Tarjeta>
    </>
  );
}
