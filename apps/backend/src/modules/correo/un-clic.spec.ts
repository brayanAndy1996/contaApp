// Spec 028 · T20 (H-028-2-8): cuerpo de la baja de un clic de RFC 8058 en urlencoded y `multipart/form-data`. Unitarias de `esCuerpoUnClic`.
import { describe, expect, it } from "vitest";
import { CUERPO_UN_CLIC, esCuerpoUnClic } from "./un-clic.js";

const L = "----limite123";
const parte = (cabeceras: string[], valor = "One-Click"): string => `--${L}\r\n${cabeceras.join("\r\n")}\r\n\r\n${valor}\r\n`;
const multipart = (partes: string[], epilogo = "\r\n"): Buffer => Buffer.from(`${partes.join("")}--${L}--${epilogo}`, "latin1");
const DISP = 'Content-Disposition: form-data; name="List-Unsubscribe"';
const TIPO = `multipart/form-data; boundary=${L}`;

describe("esCuerpoUnClic", () => {
  it("urlencoded: solo el cuerpo exacto (con o sin tipo declarado)", () => {
    expect(esCuerpoUnClic(Buffer.from(CUERPO_UN_CLIC), "application/x-www-form-urlencoded")).toBe(true);
    expect(esCuerpoUnClic(Buffer.from(CUERPO_UN_CLIC), undefined)).toBe(true);
    expect(esCuerpoUnClic(Buffer.from(`${CUERPO_UN_CLIC}&x=1`), "application/x-www-form-urlencoded")).toBe(false);
    expect(esCuerpoUnClic({ "List-Unsubscribe": "One-Click" }, "application/x-www-form-urlencoded")).toBe(false);
  });

  it("multipart: una parte `List-Unsubscribe` = `One-Click` (boundary con o sin comillas, tipo en mayúsculas, con o sin epílogo)", () => {
    expect(esCuerpoUnClic(multipart([parte([DISP])]), TIPO)).toBe(true);
    expect(esCuerpoUnClic(multipart([parte([DISP])], ""), `MULTIPART/FORM-DATA; BOUNDARY="${L}"`)).toBe(true);
    expect(esCuerpoUnClic(multipart([parte(["content-disposition: form-data; name=List-Unsubscribe", "Content-Type: text/plain; charset=utf-8"])]), TIPO)).toBe(true);
  });

  it.each([
    ["otro valor", multipart([parte([DISP], "Otro")]), TIPO],
    ["otro campo", multipart([parte(['Content-Disposition: form-data; name="unsubscribe"'])]), TIPO],
    ["sin partes", Buffer.from(`--${L}--\r\n`), TIPO],
    ["dos partes", multipart([parte([DISP]), parte([DISP])]), TIPO],
    ["con archivo", multipart([parte([`${DISP}; filename="a.txt"`])]), TIPO],
    ["disposición repetida", multipart([parte([DISP, DISP])]), TIPO],
    ["otra cabecera", multipart([parte([DISP, "X-Otra: 1"])]), TIPO],
    ["cabecera sin dos puntos", multipart([parte([DISP, "rara"])]), TIPO],
    ["Content-Type que no es texto", multipart([parte([DISP, "Content-Type: application/json"])]), TIPO],
    ["sin cabeceras ni separador", Buffer.from(`--${L}\r\nOne-Click\r\n--${L}--\r\n`), TIPO],
    ["sin cierre", Buffer.from(parte([DISP])), TIPO],
    ["con preámbulo", Buffer.from(`hola\r\n${multipart([parte([DISP])]).toString("latin1")}`), TIPO],
    ["epílogo con datos", multipart([parte([DISP])], "\r\nmas"), TIPO],
    ["otro boundary", multipart([parte([DISP])]), "multipart/form-data; boundary=otro"],
    ["sin boundary", multipart([parte([DISP])]), "multipart/form-data"],
    ["el cuerpo urlencoded declarado como multipart", Buffer.from(CUERPO_UN_CLIC), TIPO],
    ["multipart declarado como urlencoded", multipart([parte([DISP])]), "application/x-www-form-urlencoded"],
    ["no son bytes", "List-Unsubscribe=One-Click", TIPO],
  ])("%s: no es la baja de un clic", (_n, cuerpo, tipo) => {
    expect(esCuerpoUnClic(cuerpo, tipo)).toBe(false);
  });
});
