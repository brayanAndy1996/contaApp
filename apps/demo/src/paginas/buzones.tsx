import { useState } from "react";
import type { Mensaje } from "../datos/tipos";
import { useDemo } from "../estado/store";
import { descargar } from "../motor/empaquetar";
import { Boton, Encabezado, Insignia, Modal, Tarjeta, Vacio, claseInput, fechaCorta } from "../ui/comunes";

export function Buzones() {
  const { estado, revisarBuzones, atenderMensaje, abrirMensaje } = useDemo();
  const [cliente, setCliente] = useState("");
  const [filtro, setFiltro] = useState<"todos" | "criticos" | "pendientes">("pendientes");
  const [abierto, setAbierto] = useState<Mensaje | null>(null);
  const [comentario, setComentario] = useState("");
  const enCurso = estado.trabajos.some((t) => t.tipo.includes("buzones") && (t.estado === "ejecutando" || t.estado === "en_cola"));
  const lista = estado.mensajes
    .filter((m) => (!cliente || m.clienteId === cliente) && (filtro === "todos" || (filtro === "criticos" ? m.critico : !m.atendido)))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
  const nombre = (id: string) => estado.clientes.find((c) => c.id === id)?.razonSocial ?? id;
  return (
    <>
      <Encabezado
        titulo={<span>Buzones electrónicos SOL <Insignia tono="violeta">R2</Insignia></span>}
        subtitulo="Bandeja unificada de todos los clientes con credenciales válidas. Revisar no marca como leído en SUNAT salvo que abras el mensaje."
        acciones={<Boton variante="primario" disabled={enCurso} onClick={revisarBuzones}>{enCurso ? "⟳ Revisando…" : "⟳ Revisar ahora"}</Boton>}
      />
      <Tarjeta>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <select className={claseInput} value={cliente} onChange={(e) => setCliente(e.target.value)}>
            <option value="">Todos los clientes</option>
            {estado.clientes.map((c) => <option key={c.id} value={c.id}>{c.razonSocial}</option>)}
          </select>
          {(["pendientes", "criticos", "todos"] as const).map((f) => (
            <button key={f} onClick={() => setFiltro(f)} className={`rounded-full px-3 py-1 text-xs font-medium ${filtro === f ? "bg-teal-700 text-white" : "bg-slate-100 text-slate-600"}`}>
              {f === "pendientes" ? "Sin atender" : f === "criticos" ? "Críticos" : "Todos"}
            </button>
          ))}
        </div>
        {lista.length === 0 ? (
          <Vacio titulo="Bandeja al día" icono="✉" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {lista.map((m) => (
              <li key={m.id}>
                <button onClick={() => { setAbierto(m); abrirMensaje(m.id); setComentario(""); }} className={`flex w-full flex-wrap items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 ${m.critico && !m.atendido ? "border-l-4 border-red-500 bg-red-50/40" : ""}`}>
                  <span className="text-lg">{m.critico ? "🚨" : "✉️"}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm ${m.leidoSunat ? "text-slate-700" : "font-semibold text-slate-900"}`}>{m.asunto}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                      {nombre(m.clienteId)} · {m.buzon}
                      <Insignia tono={m.critico ? "rojo" : "gris"}>{m.tipo}</Insignia>
                      {!m.leidoSunat && <Insignia tono="azul">No leído en SUNAT</Insignia>}
                      {m.atendido && <Insignia tono="verde">Atendido por {m.atendido.usuario}</Insignia>}
                    </span>
                  </span>
                  <span className="text-xs text-slate-400">{fechaCorta(m.fecha)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Tarjeta>
      <Modal
        abierto={abierto !== null}
        alCerrar={() => setAbierto(null)}
        ancho="max-w-2xl"
        titulo={abierto?.asunto ?? ""}
        pie={abierto && !estado.mensajes.find((x) => x.id === abierto.id)?.atendido && (
          <>
            <input className={`${claseInput} flex-1`} placeholder="Comentario interno (ej. se coordinó pago con el cliente)" value={comentario} onChange={(e) => setComentario(e.target.value)} />
            <Boton variante="exito" onClick={() => { atenderMensaje(abierto.id, comentario); setAbierto(null); }}>✓ Marcar como atendido</Boton>
          </>
        )}
      >
        {abierto && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2 text-xs text-slate-500">
              <span>{nombre(abierto.clienteId)}</span>·<span>{abierto.buzon}</span>·<span>{fechaCorta(abierto.fecha)}</span>
              <Insignia tono={abierto.critico ? "rojo" : "gris"}>{abierto.tipo}</Insignia>
            </div>
            <p className="rounded-lg bg-slate-50 p-3 leading-relaxed">{abierto.contenido}</p>
            {abierto.adjunto && (
              <Boton chico onClick={() => descargar(abierto.adjunto!.replace(".pdf", ".txt"), `DOCUMENTO FICTICIO DE LA DEMO DE CONTAPP\n\n${abierto.asunto}\n\n${abierto.contenido}\n`, "text/plain")}>📎 {abierto.adjunto}</Boton>
            )}
            {estado.mensajes.find((x) => x.id === abierto.id)?.atendido && (
              <p className="text-xs text-emerald-700">Atendido: {estado.mensajes.find((x) => x.id === abierto.id)?.atendido?.comentario || "sin comentario"}</p>
            )}
            <p className="text-[11px] text-slate-400">Al abrirlo, el mensaje se marcó como leído en SUNAT (RF-126).</p>
          </div>
        )}
      </Modal>
    </>
  );
}
