import { PERIODO_ACTUAL } from "../datos/semilla";
import { useDemo } from "../estado/store";
import { Aviso, Boton, Encabezado, Insignia, Pestanas, Tarjeta, periodoTexto } from "../ui/comunes";
import { puede } from "../ui/permisos";
import { estadoPeriodoTexto } from "./panel";
import { VistaCompras } from "./periodo/compras";
import { VistaGenerar } from "./periodo/generar";
import { VistaVentas } from "./periodo/ventas";

export function TrabajoEnCurso({ cliente, tipo }: { cliente: string; tipo: string }) {
  const { estado } = useDemo();
  const t = estado.trabajos.find((x) => x.cliente === cliente && x.tipo.includes(tipo) && (x.estado === "ejecutando" || x.estado === "en_cola"));
  if (!t) return null;
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50 p-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-semibold text-sky-900">⟳ {t.tipo}</span>
        <span className="text-xs text-sky-700">
          Paso {Math.min(t.paso + 1, t.pasos.length)} de {t.pasos.length}
        </span>
      </div>
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-sky-100">
        <div className="h-full rounded-full bg-sky-600 transition-all duration-500" style={{ width: `${(t.paso / t.pasos.length) * 100}%` }} />
      </div>
      <ol className="space-y-1 text-xs">
        {t.pasos.map((s, i) => (
          <li key={s} className={i < t.paso ? "text-emerald-700" : i === t.paso ? "font-semibold text-sky-900" : "text-slate-400"}>
            {i < t.paso ? "✓" : i === t.paso ? "▸" : "○"} {s}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function SinPropuesta({ clienteId, libro }: { clienteId: string; libro: "ventas" | "compras" }) {
  const { cliente, descargarPropuesta, usuario, estado } = useDemo();
  const c = cliente(clienteId)!;
  const enCurso = estado.trabajos.some((t) => t.cliente === c.razonSocial && t.tipo.includes(libro === "compras" ? "RCE" : "RVIE") && (t.estado === "ejecutando" || t.estado === "en_cola"));
  const sinCred = c.credencialSire !== "valida";
  return (
    <Tarjeta>
      <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
        <div className="text-4xl">{libro === "compras" ? "🧾" : "📈"}</div>
        <div>
          <div className="text-lg font-semibold text-slate-900">Aún no descargas la propuesta de {libro} de {periodoTexto(PERIODO_ACTUAL)}</div>
          <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500">
            El worker usa las credenciales SIRE del cliente para pedir la propuesta a SUNAT (simulado). {libro === "compras" ? "Luego descarga los XML y corre el motor de correcciones sobre cada fila." : "Luego audita la correlatividad de la numeración."}
          </p>
        </div>
        {enCurso ? (
          <div className="w-full max-w-lg text-left">
            <TrabajoEnCurso cliente={c.razonSocial} tipo={libro === "compras" ? "RCE" : "RVIE"} />
          </div>
        ) : (
          <div className="flex flex-wrap justify-center gap-2">
            <Boton variante="primario" disabled={sinCred || !puede(usuario?.rol, "sire.editar")} onClick={() => descargarPropuesta(clienteId, libro)}>
              ⤓ Descargar propuesta SIRE
            </Boton>
            <Boton onClick={() => descargarPropuesta(clienteId, libro)} title="RF-051 / RF-060: alternativa a la API">
              ⇪ Importar TXT/Excel de SUNAT
            </Boton>
          </div>
        )}
        {sinCred && !enCurso && <Aviso tono="ambar">Este cliente no tiene credenciales SIRE válidas. Puedes importar el archivo que descargaste de SUNAT Operaciones en Línea.</Aviso>}
      </div>
    </Tarjeta>
  );
}

export function Periodo({ clienteId, vista }: { clienteId: string; vista: "ventas" | "compras" | "generar" }) {
  const { cliente, periodo, marcarRevisado, usuario } = useDemo();
  const c = cliente(clienteId);
  if (!c) return <Aviso tono="rojo">Cliente no encontrado</Aviso>;
  const p = periodo(clienteId);
  const e = estadoPeriodoTexto(p);
  const base = `/clientes/${clienteId}`;
  return (
    <>
      <Encabezado
        titulo={
          <span className="flex flex-wrap items-center gap-2">
            {c.razonSocial} <Insignia tono={e.tono}>{e.texto}</Insignia>
          </span>
        }
        subtitulo={`RUC ${c.ruc} · ${periodoTexto(PERIODO_ACTUAL)} · ${c.ubicacion}`}
        migas={[{ texto: "Clientes", ruta: "/clientes" }, { texto: c.razonSocial, ruta: base }, { texto: periodoTexto(PERIODO_ACTUAL) }]}
        acciones={
          p.comprasCargadas &&
          puede(usuario?.rol, "sire.aprobar_generar") && (
            <Boton variante={p.revisado ? "secundario" : "exito"} onClick={() => marcarRevisado(clienteId, !p.revisado)}>
              {p.revisado ? "🔓 Reabrir periodo" : "✓ Marcar como revisado"}
            </Boton>
          )
        }
      />
      <Pestanas
        activa={vista}
        items={[
          { id: "ventas", texto: "Ventas (RVIE)", ruta: `${base}/ventas` },
          { id: "compras", texto: "Compras (RCE)", ruta: `${base}/compras` },
          { id: "generar", texto: "Generar archivo", ruta: `${base}/generar` },
        ]}
      />
      {vista === "ventas" && <VistaVentas clienteId={clienteId} />}
      {vista === "compras" && <VistaCompras clienteId={clienteId} />}
      {vista === "generar" && <VistaGenerar clienteId={clienteId} />}
    </>
  );
}
