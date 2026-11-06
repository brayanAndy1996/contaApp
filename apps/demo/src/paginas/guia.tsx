import { Aviso, Encabezado, Insignia, Tarjeta } from "../ui/comunes";

const PASOS: { titulo: string; ruta: string; texto: string; reglas?: string[] }[] = [
  { titulo: "1. Descarga la propuesta de compras", ruta: "/clientes/c1/compras", texto: "En DISTRIBUIDORA ANDINA DEMO presiona «Descargar propuesta SIRE». Mira cómo el worker (simulado) se autentica, pide el ticket, baja los XML y corre el motor." },
  { titulo: "2. Cerveza con ISC enviada a DG", ruta: "/clientes/c1/compras", texto: "F001-1040 de CERVECERÍA SELVA DEMO: base 770 con IGV 0. El XML dice que es ISC. Abre la lupa 🔍 y acepta: el monto pasa a la columna ISC.", reglas: ["R-ISC"] },
  { titulo: "3. Factura mixta 21.48 / 1.61", ruta: "/clientes/c1/compras", texto: "F001-2056: 1.61 no es el 18 % ni el 10 % de 21.48. Sin XML el gravado estaría entre 8.92 y 8.97; el XML da el exacto 8.97 y 12.51 no gravado.", reglas: ["R-MIX"] },
  { titulo: "4. Redondeo en dólares", ruta: "/clientes/c1/compras", texto: "F001-4062 en USD (TC 3.300): la conversión por componente da 0.50 + 0.10 = 0.60, pero el SIRE trae 0.59. Así SUNAT lo devolvería «procesado con errores».", reglas: ["R-RED"] },
  { titulo: "5. Zapatillas en una distribuidora", ruta: "/clientes/c1/compras", texto: "F001-5070: proveedor nuevo y la glosa del XML dice «zapatillas». El sistema sugiere excluirla como gasto personal. Tú decides.", reglas: ["R-NEW", "R-GP"] },
  { titulo: "6. Edición tipo Excel y deshacer", ruta: "/clientes/c1/compras", texto: "Haz clic en cualquier monto, cámbialo y mira el cuadre en vivo. Ctrl+Z deshace. Selecciona varias filas para clasificar en bloque." },
  { titulo: "7. Prevalidación y archivo", ruta: "/clientes/c1/generar", texto: "Si quedan filas que no cuadran, no te deja generar. Corrige, genera el TXT + ZIP (con SHA-256), descárgalo y simula el envío a SUNAT con seguimiento del ticket." },
  { titulo: "8. Ventas: falta la boleta 291", ruta: "/clientes/c1/ventas", texto: "Descarga ventas: la auditoría de correlatividad detecta que falta la B001-291 entre la 290 y la 292. Agrégala desde el aviso." },
  { titulo: "9. Cliente de la selva", ruta: "/clientes/c2/compras", texto: "AGROINDUSTRIAS HUALLAGA DEMO (Huánuco) tiene ventas exoneradas: el SIRE manda todo a DG, pero el historial dice DNG. Acepta en bloque «según historial».", reglas: ["R-HIS"] },
  { titulo: "10. Mixta sin XML y prorrata", ruta: "/clientes/c4/compras", texto: "TRANSPORTES RUTA SUR DEMO: una compra mixta sin XML (el contador confirma el gravado dentro del rango) y el alquiler del local secundario en DGNG. Luego mira Prorrata e IGV." },
  { titulo: "11. Buzones y credenciales", ruta: "/buzones", texto: "Bandeja unificada con mensajes críticos (coactiva, multa, fiscalización). FERRETERÍA EL PERNO tiene la clave SOL inválida: actualízala desde su ficha." },
  { titulo: "12. Roles y auditoría", ruta: "/auditoria", texto: "Sal y entra como Asistente: puede editar pero no generar. Todo lo que hiciste quedó en la auditoría." },
];

export function Guia() {
  return (
    <>
      <Encabezado titulo="Guía de la demo" subtitulo="Un recorrido de 10 minutos por los procesos principales de ContApp" />
      <div className="mb-5">
        <Aviso tono="azul" titulo="¿Qué es real y qué es simulado?">
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li><b>Real (el mismo código del producto):</b> el motor de correcciones (R-ISC, R-MIX, R-RED, R-NEW, R-GP), los cálculos de dinero exactos, la prevalidación SUNAT, el resumen de cambios y la generación del TXT. La demo importa <code>packages/domain</code> sin cambios.</li>
            <li><b>Simulado:</b> SUNAT (API SIRE, SOL, XML), la cola de trabajos, el backend y la base de datos. Todo corre en tu navegador con datos ficticios.</li>
            <li><b>Provisional:</b> la estructura del TXT es la versión de prueba del motor (la oficial de SUNAT se carga después). R-HIS, buzones, prorrata y envío a SUNAT son de la release 2 <Insignia tono="violeta">R2</Insignia>.</li>
          </ul>
        </Aviso>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {PASOS.map((p) => (
          <a key={p.titulo} href={`#${p.ruta}`} className="block">
            <Tarjeta className="h-full p-4 transition hover:border-teal-400 hover:shadow-md">
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className="font-semibold text-slate-900">{p.titulo}</h3>
                {p.reglas?.map((r) => <Insignia key={r} tono="ambar">{r}</Insignia>)}
              </div>
              <p className="mt-1 text-sm text-slate-600">{p.texto}</p>
              <span className="mt-2 inline-block text-xs font-semibold text-teal-700">Ir →</span>
            </Tarjeta>
          </a>
        ))}
      </div>
    </>
  );
}
