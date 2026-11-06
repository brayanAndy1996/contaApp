import { useState } from "react";
import { useDemo } from "../estado/store";
import { Encabezado, Tarjeta, Vacio, claseInput, fechaCorta } from "../ui/comunes";

export function Auditoria() {
  const { estado } = useDemo();
  const [usuario, setUsuario] = useState("");
  const [q, setQ] = useState("");
  const lista = estado.auditoria.filter((a) => (!usuario || a.usuario === usuario) && (!q || `${a.accion} ${a.detalle} ${a.cliente ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <Encabezado titulo="Auditoría" subtitulo="Registro de solo agregado: inicios de sesión, cambios de credenciales, cada cambio en filas (antes → después), exclusiones, archivos generados y envíos a SUNAT." />
      <Tarjeta>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <input className={`${claseInput} w-full sm:w-72`} placeholder="Buscar acción, cliente o detalle" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={claseInput} value={usuario} onChange={(e) => setUsuario(e.target.value)}>
            <option value="">Todos los usuarios</option>
            {estado.usuarios.map((u) => <option key={u.id}>{u.nombre}</option>)}
          </select>
        </div>
        {lista.length === 0 ? (
          <Vacio titulo="Sin eventos" icono="🛡">Todo lo que hagas en la demo aparece aquí.</Vacio>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2">Fecha</th>
                  <th className="px-4 py-2">Usuario</th>
                  <th className="px-4 py-2">Acción</th>
                  <th className="px-4 py-2">Cliente</th>
                  <th className="px-4 py-2">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((a) => (
                  <tr key={a.id} className="border-t border-slate-100">
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">{fechaCorta(a.fecha)}</td>
                    <td className="whitespace-nowrap px-4 py-2">{a.usuario}</td>
                    <td className="px-4 py-2 font-medium">{a.accion}</td>
                    <td className="px-4 py-2 text-xs">{a.cliente ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-600">{a.detalle}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Tarjeta>
    </>
  );
}
