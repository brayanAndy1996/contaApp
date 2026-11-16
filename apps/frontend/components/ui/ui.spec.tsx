// Spec 038 (T4, nivel C): un caso feliz y uno de error o borde por componente base del estilo A.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./index";

afterEach(cleanup);

describe("Button", () => {
  it("es type=button por omisión, usa la variante principal y responde al clic", async () => {
    const alPulsar = vi.fn();
    render(<Button onClick={alPulsar}>Generar</Button>);
    const boton = screen.getByRole("button", { name: "Generar" });
    expect(boton.getAttribute("type")).toBe("button");
    expect(boton.className).toContain("bg-primario");
    await userEvent.click(boton);
    expect(alPulsar).toHaveBeenCalledTimes(1);
  });

  it("deshabilitado no dispara; con asChild se vuelve el enlace hijo sin type", async () => {
    const alPulsar = vi.fn();
    render(
      <>
        <Button disabled onClick={alPulsar}>
          Generar
        </Button>
        <Button asChild variant="secundario">
          <a href="/ventas">Ventas</a>
        </Button>
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Generar" }));
    expect(alPulsar).not.toHaveBeenCalled();
    const enlace = screen.getByRole("link", { name: "Ventas" });
    expect(enlace.getAttribute("type")).toBeNull();
    expect(enlace.className).toContain("border-linea-control");
  });
});

describe("Input, Label y Select", () => {
  it("la etiqueta da nombre al campo", () => {
    render(
      <Label>
        RUC
        <Input defaultValue="20700000002" />
      </Label>,
    );
    expect((screen.getByLabelText("RUC") as HTMLInputElement).value).toBe("20700000002");
  });

  it("aria-invalid queda en el campo y el select nativo conserva sus opciones", () => {
    render(
      <>
        <Input aria-label="RUC" aria-invalid="true" />
        <Select aria-label="Régimen" defaultValue="rg">
          <option value="rg">Régimen General (RG)</option>
        </Select>
      </>,
    );
    expect(screen.getByLabelText("RUC").getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByLabelText("Régimen") as HTMLSelectElement).value).toBe("rg");
  });
});

describe("Badge y Alert", () => {
  it("el chip lleva texto y su tono", () => {
    render(<Badge tono="ok">Verificada</Badge>);
    expect(screen.getByText("Verificada").className).toContain("text-ok");
  });

  it("error y aviso se anuncian como alert; info y ok como status", () => {
    render(
      <>
        <Alert tono="error">
          <AlertTitle>No se puede generar</AlertTitle>
          <AlertDescription>1.61 no es 18 % ni 10 % de 21.48</AlertDescription>
        </Alert>
        <Alert tono="ok">Archivo generado.</Alert>
      </>,
    );
    expect(screen.getByRole("alert").textContent).toContain("1.61 no es 18 %");
    expect(screen.getByRole("status").textContent).toBe("Archivo generado.");
  });
});

describe("Card y Table", () => {
  it("la tarjeta muestra su título y contenido", () => {
    render(
      <Card aria-labelledby="t">
        <CardTitle id="t">Credenciales</CardTitle>
        <CardContent>Clave SOL</CardContent>
      </Card>,
    );
    expect(screen.getByRole("region", { name: "Credenciales" })).toBeTruthy();
  });

  it("una celda numérica se alinea a la derecha con cifras tabulares; la tabla va en un contenedor desplazable", () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell numerico>1,090.19</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const celda = screen.getByRole("cell", { name: "1,090.19" });
    expect(celda.className).toContain("text-right");
    expect(celda.className).toContain("cifras");
    expect(screen.getByRole("table").parentElement?.className).toContain("overflow-x-auto");
  });
});

describe("Tabs", () => {
  it("muestra la pestaña elegida y se recorre con las flechas", async () => {
    render(
      <Tabs defaultValue="con">
        <TabsList aria-label="Compras">
          <TabsTrigger value="con">Con IGV</TabsTrigger>
          <TabsTrigger value="sin">Sin IGV</TabsTrigger>
        </TabsList>
        <TabsContent value="con">Cuatro compras</TabsContent>
        <TabsContent value="sin">Una compra</TabsContent>
      </Tabs>,
    );
    expect(screen.getByText("Cuatro compras")).toBeTruthy();
    screen.getByRole("tab", { name: "Con IGV" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Sin IGV" }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByText("Una compra")).toBeTruthy();
  });

  it("una pestaña deshabilitada no se activa", async () => {
    render(
      <Tabs defaultValue="con">
        <TabsList aria-label="Compras">
          <TabsTrigger value="con">Con IGV</TabsTrigger>
          <TabsTrigger value="exc" disabled>
            Excluidas
          </TabsTrigger>
        </TabsList>
        <TabsContent value="con">Cuatro compras</TabsContent>
        <TabsContent value="exc">Ninguna</TabsContent>
      </Tabs>,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Excluidas" }));
    expect(screen.getByRole("tab", { name: "Con IGV" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Dialog", () => {
  it("se abre con su título y se cierra con Esc devolviendo el foco", async () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Excluir</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Excluir F001-5070</DialogTitle>
          <DialogDescription>El motivo es opcional.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const abrir = screen.getByRole("button", { name: "Excluir" });
    await userEvent.click(abrir);
    expect(screen.getByRole("dialog", { name: "Excluir F001-5070" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(abrir);
  });

  it("el botón «Cerrar» lo cierra; sin mostrarCerrar no aparece", async () => {
    const { rerender } = render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Lupa</DialogTitle>
          <DialogDescription>Comprobante</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    rerender(
      <Dialog open>
        <DialogContent mostrarCerrar={false}>
          <DialogTitle>Lupa</DialogTitle>
          <DialogDescription>Comprobante</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole("button", { name: "Cerrar" })).toBeNull();
  });
});

describe("DropdownMenu", () => {
  it("se abre con el teclado y ejecuta la opción elegida", async () => {
    const alElegir = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secundario">Acciones</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={alElegir}>Aceptar sugerencias</DropdownMenuItem>
          <DropdownMenuItem peligro>Excluir</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    screen.getByRole("button", { name: "Acciones" }).focus();
    await userEvent.keyboard("{Enter}");
    const opcion = await screen.findByRole("menuitem", { name: "Aceptar sugerencias" });
    expect(screen.getByRole("menuitem", { name: "Excluir" }).className).toContain("text-error");
    await userEvent.click(opcion);
    expect(alElegir).toHaveBeenCalledTimes(1);
  });

  it("una opción deshabilitada no se ejecuta", async () => {
    const alElegir = vi.fn();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Acciones</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled onSelect={alElegir}>
            Restaurar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const opcion = await screen.findByRole("menuitem", { name: "Restaurar" });
    expect(opcion.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(opcion).catch(() => undefined);
    expect(alElegir).not.toHaveBeenCalled();
  });
});
