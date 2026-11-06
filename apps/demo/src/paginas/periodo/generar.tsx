import { useMemo, useState } from "react";
import { PERIODO_ACTUAL } from "../../datos/semilla";
import { generarArchivo, prevalidarPeriodo } from "../../motor/dominio";
import type { ArchivoGenerado } from "../../motor/dominio";
import { aBase64, deBase64, descargar, empaquetar } from "../../motor/empaquetar";
import { Aviso, Boton, Insignia, Kpi, Tarjeta, fechaCorta, ir, soles } from "../../ui/comunes";
import { puede } from "../../ui/permisos";
import { SinPropuesta } from "../periodo";
import { useCompras } from "./usar-compras";

const ETIQUETA_ERROR: Record<string, string> = {
  CUADRE: "No cuadra",
  IGV: "IGV no corresponde",
  CONVERSION_USD: "Conversión USD",
  DUPLICADO: "Duplicado",
  RUC_INVALIDO: "RUC inválido",
  FECHA_POSTERIOR_AL_PERIODO: "Fecha fuera del periodo",
  CAMPO_OBLIGATORIO: "Falta un campo",
  SIN_FILAS: "Sin filas",
};

export function VistaGenerar({ clienteId }: { clienteId: string }) {
  const h = useCompras(clienteId);
  const { p, cliente, razonSocial, usuario, guardarVersion, enviarSunat, totalPendientes, estado, conocidos } = h;
  const c = cliente(clienteId)!;
  const [ultimo, setUltimo] = useState<ArchivoGenerado | null>(null);
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entrada = useMemo(
    () => ({
      ruc: c.ruc,
      periodo: PERIODO_ACTUAL,
      vigentes: p.compras,
      originales: p.comprasOriginales,
      razonSocial,
      xmls: Object.fromEntries(Object.entries(p.xml).filter(([id]) => p.xmlEstado[id] === "disponible")),
      conocidos,
      emisoresIsc: estado.emisoresIsc,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.compras, p.comprasOriginales, p.xml, p.xmlEstado, c.ruc, conocidos, estado.emisoresIsc],
  );
  const pre = useMemo(() => (p.comprasCargadas ? prevalidarPeriodo(entrada) : null), [entrada, p.comprasCargadas]);

  if (!p.comprasCargadas) return <SinPropuesta clienteId={clienteId} libro="compras" />;
  if (!pre) return null;
  const { resultado, resumen } = pre;
  const autorizado = puede(usuario?.rol, "sire.aprobar_generar");

  const generar = async () => {
    setError(null);
    setGenerando(true);
    try {
      const a = generarArchivo(entrada);
      const z = await empaquetar(a.bytesTxt, { nombreTxt: a.nombreTxt, nombreZip: a.nombreZip });
      guardarVersion(clienteId, {
        nombreZip: a.nombreZip,
        nombreTxt: a.nombreTxt,
        sha256Txt: z.sha256Txt,
        sha256Zip: z.sha256Zip,
        lineas: a.lineas,
        usuario: usuario?.nombre ?? "",
        fecha: new Date().toISOString(),
        formato: a.formato,
        zipBase64: aBase64(z.zip),
      });
      setUltimo(a);
    } catch (e) {
      const err = e as { codigo?: string; message?: string };
      setError(`${err.codigo ?? "ERROR"}: ${err.message}`);
    } finally {
      setGenerando(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi etiqueta="Filas modificadas" valor={resumen.modificadas} />
        <Kpi etiqueta="Excluidas" valor={resumen.excluidas} />
        <Kpi etiqueta="Agregadas" valor={resumen.agregadas} />
        <Kpi etiqueta="Impacto en IGV (crédito)" valor={soles(resumen.impactoIgv.total.toString())} tono={resumen.impactoIgv.total.esNegativo() ? "rojo" : resumen.impactoIgv.total.esCero() ? undefined : "verde"} nota={`DG ${resumen.impactoIgv.DG.toString()} · DGNG ${resumen.impactoIgv.DGNG.toString()} · DNG ${resumen.impactoIgv.DNG.toString()}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Tarjeta titulo={<span>Prevalidación SUNAT {resultado.apto ? <Insignia tono="verde">Apto para generar</Insignia> : <Insignia tono="rojo">{resultado.errores.length} error(es) bloqueantes</Insignia>}</span>}>
          <div className="space-y-2 p-4">
            {resultado.apto ? (
              <Aviso tono="verde">✓ Todas las filas pasan las reglas de estructura y cuadre: el archivo no saldrá «procesado con errores».</Aviso>
            ) : (
              <Aviso tono="rojo">No se permite generar hasta corregir estas filas (RF-088). Ábrelas con la lupa para ver la sugerencia del motor.</Aviso>
            )}
            <ul className="divide-y divide-slate-100">
              {resultado.errores.map((e, i) => {
                const f = p.compras.find((x) => x.id === e.filaId);
                return (
                  <li key={i} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <Insignia tono="rojo">{ETIQUETA_ERROR[e.codigo] ?? e.codigo}</Insignia>
                    <span className="flex-1">
                      {f && (
                        <b>
                          {f.serie}-{f.numero}
                        </b>
                      )}{" "}
                      {e.explicacion}
                      {e.sugerencia && <span className="text-xs text-slate-500"> · sugerencia {e.sugerencia.regla}</span>}
                    </span>
                    {f && (
                      <Boton chico onClick={() => ir(`/clientes/${clienteId}/compras?lupa=${f.id}`)}>
                        🔍 Corregir
                      </Boton>
                    )}
                  </li>
                );
              })}
              {resultado.avisos.map((a, i) => {
                const f = p.compras.find((x) => x.id === a.filaId);
                return (
                  <li key={`a${i}`} className="flex flex-wrap items-center gap-2 py-2 text-sm text-slate-600">
                    <Insignia tono="ambar">Aviso {a.codigo}</Insignia>
                    <span className="flex-1">
                      {f && `${f.serie}-${f.numero}: `}
                      {a.explicacion}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-slate-400">
              Formato {resultado.formato.id} v{resultado.formato.version} {!resultado.formato.oficial && "· provisional: la estructura oficial de SUNAT se carga en una versión futura (spec 012)"}
            </p>
          </div>
        </Tarjeta>

        <Tarjeta titulo="Generar archivo de reemplazo (RCE)">
          <div className="space-y-3 p-4">
            {totalPendientes > 0 && resultado.apto && <Aviso tono="ambar">Hay {totalPendientes} observación(es) sin revisar que no bloquean (avisos). Puedes generar igual.</Aviso>}
            {!p.revisado && <Aviso tono="azul">Consejo: marca el periodo como «revisado» antes de generar para bloquear la edición.</Aviso>}
            {!autorizado && <Aviso tono="ambar">Tu rol ({usuario?.rol}) no tiene el permiso «aprobar y generar». Entra como Contador o Administrador.</Aviso>}
            {error && <Aviso tono="rojo">{error}</Aviso>}
            <Boton variante="primario" disabled={!resultado.apto || !autorizado || generando} onClick={generar} className="w-full">
              {generando ? "Generando…" : "⚙ Generar TXT + ZIP"}
            </Boton>
            {ultimo && (
              <div className="rounded-lg border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs">
                  <b>{ultimo.nombreTxt}</b>
                  <span className="text-slate-500">{ultimo.lineas} línea(s)</span>
                </div>
                <pre className="max-h-48 overflow-auto bg-slate-900 p-3 text-[10px] leading-relaxed text-emerald-200">{ultimo.txt}</pre>
              </div>
            )}
          </div>
        </Tarjeta>
      </div>

      <Tarjeta titulo="Versiones generadas">
        {p.versiones.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">Aún no hay archivos. Cada generación guarda versión, usuario, fecha y hash SHA-256.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2">Versión</th>
                  <th className="px-4 py-2">Archivo</th>
                  <th className="px-4 py-2">Generado por</th>
                  <th className="px-4 py-2">SHA-256 (ZIP)</th>
                  <th className="px-4 py-2">SUNAT</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {[...p.versiones].reverse().map((v) => (
                  <tr key={v.version} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-semibold">v{v.version}</td>
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs">{v.nombreZip}</div>
                      <div className="text-[11px] text-slate-500">
                        {v.lineas} líneas · {v.formato}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {v.usuario}
                      <div className="text-slate-500">{fechaCorta(v.fecha)}</div>
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-slate-500" title={v.sha256Zip}>
                      {v.sha256Zip.slice(0, 16)}…
                    </td>
                    <td className="px-4 py-2">
                      {!v.ticket && <span className="text-xs text-slate-400">No enviado</span>}
                      {v.ticket?.estado === "enviado" && <Insignia tono="azul">⟳ Ticket {v.ticket.numero}</Insignia>}
                      {v.ticket?.estado === "procesado" && <Insignia tono="verde">✓ Procesado · {v.ticket.numero}</Insignia>}
                    </td>
                    <td className="space-x-1 whitespace-nowrap px-4 py-2 text-right">
                      <Boton chico onClick={() => descargar(v.nombreZip, deBase64(v.zipBase64), "application/zip")}>
                        ⤓ ZIP
                      </Boton>
                      {!v.ticket && autorizado && (
                        <Boton chico variante="primario" onClick={() => enviarSunat(clienteId, v.version)} title="RF-104 (R2): envío por API SIRE y seguimiento del ticket">
                          Enviar a SUNAT <span className="ml-1 rounded bg-white/20 px-1 text-[9px]">R2</span>
                        </Boton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Tarjeta>
    </div>
  );
}
