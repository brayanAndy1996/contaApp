// Spec 023, T1 (CA-8, D-3): HTML de SUNAT → texto plano. Nunca llega HTML al navegador.
// Rojo: sin implementación.
import { describe, expect, it } from "vitest";
import { TOPE_TEXTO_PLANO, htmlATextoPlano } from "./index";

/** Líneas con contenido, recortadas. */
const lineas = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

describe("htmlATextoPlano: contenido ejecutable", () => {
  it("descarta <script> con todo su contenido", () => {
    const r = htmlATextoPlano("Hola<script>alert(1)</script> mundo");
    expect(r).not.toContain("alert");
    expect(r).not.toContain("script");
    expect(r).toContain("Hola");
    expect(r).toContain("mundo");
  });

  it("descarta <script> con mayúsculas mezcladas, atributos y espacios en el cierre", () => {
    const r = htmlATextoPlano(
      'A<ScRiPt type="text/javascript">evil()</SCRIPT >B',
    );
    expect(r).not.toContain("evil");
    expect(r.replace(/\s+/g, "")).toBe("AB");
  });

  it("un script sin cerrar descarta lo que sigue", () => {
    const r = htmlATextoPlano("Antes<script>alert(1) y nunca cierra");
    expect(r.trim()).toBe("Antes");
  });

  it("un script con '</div>' o '<b>' dentro no se corta antes de tiempo", () => {
    const r = htmlATextoPlano("X<script>var h='</div><b>malo</b>';</script>Y");
    expect(r).not.toContain("malo");
    expect(r.replace(/\s+/g, "")).toBe("XY");
  });

  it("descarta <style> con su contenido", () => {
    const r = htmlATextoPlano("<style>p{color:red}</style>Texto");
    expect(r).not.toContain("color");
    expect(r.trim()).toBe("Texto");
  });

  it("descarta comentarios con su contenido, también los de condición y los sin cerrar", () => {
    expect(htmlATextoPlano("a<!-- secreto -->b").replace(/\s+/g, "")).toBe(
      "ab",
    );
    expect(
      htmlATextoPlano("a<!--[if IE]><script>x()</script><![endif]-->b"),
    ).not.toContain("x()");
    expect(htmlATextoPlano("a<!-- sin cerrar b").trim()).toBe("a");
  });

  it("quita los atributos de evento y javascript: junto con la etiqueta", () => {
    const r = htmlATextoPlano(
      '<img src=x onerror="alert(1)">Hola <a href="javascript:alert(2)" onclick=bad()>clic</a>',
    );
    expect(r).not.toContain("onerror");
    expect(r).not.toContain("onclick");
    expect(r).not.toContain("javascript");
    expect(r).not.toContain("alert");
    expect(r).toContain("Hola");
    expect(r).toContain("clic");
  });

  it("un '>' dentro de un atributo entre comillas no termina la etiqueta", () => {
    const r = htmlATextoPlano('<a title="a>b" onclick="x()">visible</a>');
    expect(r.trim()).toBe("visible");
  });

  it("no queda ninguna etiqueta en la salida", () => {
    const r = htmlATextoPlano(
      "<html><head><title>T</title></head><body><div><span>uno</span><b>dos</b><i>tres</i></div></body></html>",
    );
    expect(r).not.toMatch(/<[a-z/!]/i);
    expect(r).toContain("uno");
    expect(r).toContain("dos");
    expect(r).toContain("tres");
  });
});

describe("htmlATextoPlano: estructura", () => {
  it("<br> y <br/> son saltos de línea", () => {
    expect(
      htmlATextoPlano("Linea1<br>Linea2<br/>Linea3<BR />Linea4").trim(),
    ).toBe("Linea1\nLinea2\nLinea3\nLinea4");
  });

  it("los bloques (<p>, <div>) quedan en líneas distintas", () => {
    expect(
      lineas(htmlATextoPlano("<p>Uno</p><p>Dos</p><div>Tres</div>")),
    ).toEqual(["Uno", "Dos", "Tres"]);
  });

  it("los elementos en línea no parten la palabra", () => {
    expect(htmlATextoPlano("Resol<b>ución</b> de multa").trim()).toBe(
      "Resolución de multa",
    );
  });

  it("un '<' suelto seguido de espacio es texto, no una etiqueta", () => {
    expect(htmlATextoPlano("si 2 < 3 y 5 > 4 entonces").trim()).toBe(
      "si 2 < 3 y 5 > 4 entonces",
    );
  });

  it("texto sin HTML pasa igual", () => {
    expect(htmlATextoPlano("Estimado contribuyente: se le notifica.")).toBe(
      "Estimado contribuyente: se le notifica.",
    );
  });

  it("cadena vacía → cadena vacía", () => {
    expect(htmlATextoPlano("")).toBe("");
  });
});

describe("htmlATextoPlano: entidades", () => {
  it("decodifica las nombradas básicas", () => {
    expect(
      htmlATextoPlano("a &amp; b &lt; c &gt; d &quot;e&quot; f&apos;g").trim(),
    ).toBe('a & b < c > d "e" f\'g');
  });

  it("&nbsp; pasa a espacio", () => {
    expect(htmlATextoPlano("a&nbsp;b").replace(/ /g, " ")).toBe("a b");
  });

  it("decodifica las numéricas, decimales y hexadecimales", () => {
    expect(htmlATextoPlano("&#65;&#x42;&#X43; &#241;")).toBe("ABC ñ");
  });

  it("decodifica después de quitar las etiquetas: lo escapado queda como texto literal", () => {
    expect(
      htmlATextoPlano("&lt;script&gt;alert(1)&lt;/script&gt;").trim(),
    ).toBe("<script>alert(1)</script>");
  });

  it("no decodifica dos veces", () => {
    expect(htmlATextoPlano("&amp;lt;b&amp;gt;").trim()).toBe("&lt;b&gt;");
  });

  it("una entidad desconocida o mal formada no rompe nada", () => {
    const r = htmlATextoPlano("a &noexiste; b &amp c &#; d &#xZZ; e");
    expect(r).toContain("a");
    expect(r).toContain("e");
  });

  it("una referencia numérica fuera de rango o NUL no lanza ni deja NUL", () => {
    const r = htmlATextoPlano("a&#0;b&#99999999;c&#xD800;d");
    expect(r).not.toContain("\u0000");
    expect(r).toContain("a");
    expect(r).toContain("d");
  });
});

describe("htmlATextoPlano: tamaño y entradas patológicas", () => {
  it("el tope de salida es de 1 MiB", () => {
    expect(TOPE_TEXTO_PLANO).toBe(1024 * 1024);
  });

  it("entrada de 2 MiB: la salida no pasa de 1 MiB y conserva el comienzo", () => {
    const r = htmlATextoPlano(`<p>${"x".repeat(2 * 1024 * 1024)}</p>`);
    expect(r.length).toBeLessThanOrEqual(TOPE_TEXTO_PLANO);
    expect(r.length).toBeGreaterThan(TOPE_TEXTO_PLANO - 16);
    expect(r.trim().startsWith("xxxx")).toBe(true);
  });

  it("una entrada chica no se trunca", () => {
    const r = htmlATextoPlano(`<p>${"y".repeat(1000)}</p>`);
    expect(r.trim()).toBe("y".repeat(1000));
  });

  it(
    "'<' repetidos de 2 MiB terminan en tiempo razonable (sin retroceso)",
    { timeout: 10_000 },
    () => {
      const r = htmlATextoPlano("<".repeat(2 * 1024 * 1024));
      expect(r.length).toBeLessThanOrEqual(TOPE_TEXTO_PLANO);
    },
  );

  it(
    "comentarios y etiquetas sin cerrar repetidos terminan en tiempo razonable",
    { timeout: 10_000 },
    () => {
      expect(
        htmlATextoPlano("<!--".repeat(500_000)).length,
      ).toBeLessThanOrEqual(TOPE_TEXTO_PLANO);
      expect(htmlATextoPlano("<a ".repeat(700_000)).length).toBeLessThanOrEqual(
        TOPE_TEXTO_PLANO,
      );
      expect(
        htmlATextoPlano("<script>".repeat(250_000)).length,
      ).toBeLessThanOrEqual(TOPE_TEXTO_PLANO);
      expect(
        htmlATextoPlano("&".repeat(2 * 1024 * 1024)).length,
      ).toBeLessThanOrEqual(TOPE_TEXTO_PLANO);
    },
  );
});
