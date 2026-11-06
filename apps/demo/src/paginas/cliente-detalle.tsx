import { useState } from "react";
import { PERIODO_ACTUAL, PERIODOS } from "../datos/semilla";
import { useDemo } from "../estado/store";
import { Aviso, Boton, Campo, Encabezado, Insignia, Modal, Tarjeta, claseInput, ir, periodoTexto } from "../ui/comunes";
import { puede } from "../ui/permisos";
import { EstadoCredencialInsignia } from "./clientes";
import { estadoPeriodoTexto } from "./panel";

export function ClienteDetalle({ clienteId }: { clienteId: string }) {
  const { cliente, periodo, estado, usuario, trabajo, actualizarCliente, notificar, auditar, razonSocial, actualizarAprendida } = useDemo();
  const c = cliente(clienteId);
  const [editar, setEditar] = useState(false);
  const [usuarioSol, setUsuarioSol] = useState("");
  const [clave, setClave] = useState("");
  if (!c) return <Aviso tono="rojo">Cliente no encontrado</Aviso>;
  const p = periodo(c.id);
  const e = estadoPeriodoTexto(p);
  const aprendidas = estado.aprendidas[c.id] ?? [];

  const verificar = (nuevaClave: boolean) => {
    actualizarCliente(c.id, { credencialSol: "verificando", ...(usuarioSol ? { usuarioSol } : {}) });
    if (nuevaClave) auditar("Cambio de credenciales", "Clave SOL reemplazada (valor nunca visible)", c.razonSocial);
    trabajo("Verificación de credenciales", ["Worker descifra la clave en memoria (descifrado auditado)", "Login de prueba en SOL (simulado)", "Destruyendo el secreto de la memoria"], {
      cliente: c.razonSocial,
      alTerminar: () => {
        actualizarCliente(c.id, { credencialSol: "valida" });
        notificar(`Credencial SOL válida: ${c.razonSocial}`, "exito", `#/clientes/${c.id}`);
      },
    });
    setEditar(false);
    setClave("");
  };

  return (
    <>
      <Encabezado
        titulo={c.razonSocial}
        subtitulo={`RUC ${c.ruc} · ${c.regimen}`}
        migas={[{ texto: "Clientes", ruta: "/clientes" }, { texto: c.razonSocial }]}
        acciones={
          <>
            <Boton onClick={() => ir(`/clientes/${c.id}/ventas`)}>Ventas</Boton>
            <Boton variante="primario" onClick={() => ir(`/clientes/${c.id}/compras`)}>
              Revisar compras {periodoTexto(PERIODO_ACTUAL)} →
            </Boton>
          </>
        }
      />
      {c.credencialSol === "invalida" && (
        <div className="mb-5">
          <Aviso tono="rojo" titulo="La clave SOL de este cliente dejó de funcionar">
            El último login de prueba falló (SUNAT respondió «usuario o clave incorrecta»). Actualiza la clave para que el sistema pueda revisar sus buzones.{" "}
            <button className="font-semibold underline" onClick={() => setEditar(true)}>
              Actualizar clave SOL
            </button>
          </Aviso>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <Tarjeta titulo="Datos fiscales">
          <dl className="grid grid-cols-3 gap-x-3 gap-y-2.5 p-4 text-sm">
            <dt className="text-slate-500">Ubicación</dt>
            <dd className="col-span-2">{c.ubicacion}</dd>
            <dt className="text-slate-500">Actividad</dt>
            <dd className="col-span-2">{c.actividad}</dd>
            <dt className="text-slate-500">Perfil</dt>
            <dd className="col-span-2 flex flex-wrap gap-1">
              {c.zonaSelva && <Insignia tono="verde">Zona selva</Insignia>}
              {c.ventasExoneradas && <Insignia tono="ambar">Ventas exoneradas → compras a DNG</Insignia>}
              {!c.zonaSelva && !c.ventasExoneradas && <Insignia>Estándar</Insignia>}
            </dd>
            <dt className="text-slate-500">Responsable</dt>
            <dd className="col-span-2">{c.responsable}</dd>
          </dl>
        </Tarjeta>
        <Tarjeta titulo="Credenciales" accion={puede(usuario?.rol, "credenciales.editar") && <Boton chico onClick={() => setEditar(true)}>Actualizar</Boton>}>
          <div className="space-y-3 p-4 text-sm">
            <div className="flex items-center justify-between">
              <span>
                Clave SOL {c.usuarioSol && <span className="font-mono text-xs text-slate-500">({c.usuarioSol})</span>}
              </span>
              <EstadoCredencialInsignia e={c.credencialSol} etiqueta="SOL" />
            </div>
            <div className="flex items-center justify-between">
              <span>Credenciales API SIRE</span>
              <EstadoCredencialInsignia e={c.credencialSire} etiqueta="SIRE" />
            </div>
            <p className="text-xs text-slate-500">Solo escritura: ContApp nunca muestra ni exporta las claves. Cada descifrado queda en la auditoría.</p>
          </div>
        </Tarjeta>
        <Tarjeta titulo="Periodos">
          <ul className="divide-y divide-slate-100">
            {PERIODOS.map((per) => (
              <li key={per} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span className="font-medium">{periodoTexto(per)}</span>
                {per === PERIODO_ACTUAL ? (
                  <span className="flex items-center gap-2">
                    <Insignia tono={e.tono}>{e.texto}</Insignia>
                    <a className="text-xs font-semibold text-teal-700 hover:underline" href={`#/clientes/${c.id}/compras`}>
                      Abrir
                    </a>
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Insignia tono="verde">Presentado</Insignia>
                    <span className="text-[11px] text-slate-400" title="Ajustes posteriores: release 3">
                      Ajustes (R3)
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Tarjeta>
      </div>

      <Tarjeta className="mt-5" titulo={<span>Reglas aprendidas (Smart Mapping) <Insignia tono="violeta">R2</Insignia></span>}>
        {aprendidas.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">Aún no hay reglas. Se crean con «Recordar para este proveedor» en la lupa 🔍 de una compra.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2">Proveedor</th>
                  <th className="px-4 py-2">Clasificación</th>
                  <th className="px-4 py-2">Aplicada / aceptada</th>
                  <th className="px-4 py-2">Estado</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {aprendidas.map((a) => (
                  <tr key={a.proveedorRuc} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      {razonSocial(a.proveedorRuc)} <span className="text-xs text-slate-500">{a.proveedorRuc}</span>
                    </td>
                    <td className="px-4 py-2">
                      <Insignia tono="teal">{a.destino}</Insignia>
                    </td>
                    <td className="px-4 py-2 tabular">
                      {a.aplicada} / {a.aceptada}
                    </td>
                    <td className="px-4 py-2">{a.activa ? <Insignia tono="verde">Activa</Insignia> : <Insignia>Desactivada</Insignia>}</td>
                    <td className="space-x-2 px-4 py-2 text-right">
                      <Boton chico variante="fantasma" onClick={() => actualizarAprendida(c.id, a.proveedorRuc, { activa: !a.activa })}>
                        {a.activa ? "Desactivar" : "Activar"}
                      </Boton>
                      <Boton chico variante="peligro" onClick={() => actualizarAprendida(c.id, a.proveedorRuc, null)}>
                        Eliminar
                      </Boton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Tarjeta>

      <Modal
        abierto={editar}
        alCerrar={() => setEditar(false)}
        titulo="Actualizar clave SOL"
        pie={
          <>
            <Boton onClick={() => setEditar(false)}>Cancelar</Boton>
            <Boton variante="primario" disabled={!clave} onClick={() => verificar(true)}>
              Guardar y verificar
            </Boton>
          </>
        }
      >
        <div className="space-y-3">
          <Campo etiqueta="Usuario SOL">
            <input className={claseInput} defaultValue={c.usuarioSol} onChange={(e) => setUsuarioSol(e.target.value.toUpperCase())} />
          </Campo>
          <Campo etiqueta="Nueva clave SOL" ayuda="Se cifra en el backend y no se vuelve a mostrar. En la demo no se guarda.">
            <input className={claseInput} type="password" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="off" />
          </Campo>
        </div>
      </Modal>
    </>
  );
}
