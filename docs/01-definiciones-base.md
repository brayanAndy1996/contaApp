# ContApp — Definiciones base (v0.1)

Fecha: 2026-10-24 · Estado: borrador para validar

## 1. Decisiones tomadas

| # | Tema | Decisión |
|---|------|----------|
| D1 | Modelo de producto | **SaaS multitenant** (web). Se descarta la app de escritorio del docx original. |
| D2 | Cobro | **Por estudio** (tenant). Cada plan tiene un **límite de RUCs** activos. |
| D3 | Acceso | **Roles + permisos + asignación de clientes (RUCs) a usuarios**. Nadie ve un RUC que no se le asignó, salvo dueño/admin. |
| D4 | Entorno | **Todo local para pruebas**. El código queda listo para pasar a nube cambiando configuración, no arquitectura. |

## 2. Modelo de tenancy

```
Plataforma (nosotros: super-admin, planes, soporte)
└── Tenant = Estudio contable (o contador independiente = estudio de 1 persona)
     ├── Suscripción → Plan (max_rucs, max_usuarios, features)
     ├── Miembros (usuario ↔ tenant, con rol)
     ├── Roles (de sistema + personalizados) → Permisos
     ├── Clientes (RUC)
     │    ├── Asignaciones (usuario ↔ cliente)
     │    ├── Credenciales (SOL, API SIRE) — cifradas
     │    ├── Periodos → Propuestas RVIE/RCE, clasificaciones, archivos generados, ajustes posteriores
     │    ├── Buzón (mensajes)
     │    └── Reglas aprendidas (proveedor → DG/DGNG/DNG/ISC…)
     └── Auditoría
```

- **Una sola BD PostgreSQL**, todas las tablas de negocio con `tenant_id`.
- **Row Level Security (RLS)** activado: cada request fija `app.tenant_id` en la sesión y Postgres filtra. Es la red de seguridad si el código olvida un `WHERE`.
- Un **usuario puede pertenecer a varios tenants** (ej. un asistente que trabaja para dos estudios). Al iniciar sesión elige estudio.
- El **mismo RUC en dos estudios** = dos registros independientes, sin compartir datos ni credenciales.
- Lo único global (sin tenant): catálogo de proveedores públicos (RUC, razón social, si es emisor de ISC, etc.), alimentado por todos de forma anónima.

## 3. Planes y límite de RUCs

Los límites viven en la tabla `plan`, nunca en el código.

| Plan | Precio mensual (ref.) | Anual (2 meses gratis) | RUCs activos | Usuarios | Buzón automático | Costo por RUC |
|---|---|---|---|---|---|---|
| Prueba | S/ 0 · 14 días | — | 5 | 1 | 1 vez al día | — |
| Independiente | **S/ 99** | S/ 990 | 30 | 2 | 1 vez al día | ~S/ 3.30 |
| Estudio | **S/ 249** | S/ 2,490 | 100 | 5 | 2 veces al día | ~S/ 2.50 |
| Estudio Pro | **S/ 599** | S/ 5,990 | 300 | 15 | cada 4 h | ~S/ 2.00 |
| Corporativo | desde **S/ 1,200** | a negociar | 600+ | ilimitados | cada 1 h | ≤ S/ 2.00 |

- **RUC adicional** sobre el límite del plan: S/ 4/mes c/u (máx. +20 %; más que eso → subir de plan).
- Precios **sin IGV**. Son hipótesis: hay que contrastarlos con lo que cobran las herramientas que ya usan los contadores (p. ej. Calemi) y con lo que un estudio cobra por RUC al mes.
- Referencia de valor: si el estudio cobra S/ 100–300 por RUC al mes, pagar S/ 2–3 por RUC es < 3 % de su ingreso.
- Campos del plan en BD: `precio_mensual`, `precio_anual`, `max_rucs`, `max_usuarios`, `precio_ruc_extra`, `max_rucs_extra`, `frecuencia_buzon_min`, `features` (JSON: ajustes posteriores, IA, exportaciones…).

Reglas:
- Cuenta solo **clientes activos**. Archivar un cliente libera el cupo (sus datos históricos se conservan en solo lectura).
- Al llegar al límite: no se puede crear/importar/reactivar más RUCs. La importación por Excel avisa cuántas filas quedan fuera.
- Si el estudio baja de plan y excede el límite: no se borra nada; queda bloqueado agregar hasta que archive los sobrantes.
- La validación se hace en el backend dentro de una transacción (evita que dos importaciones simultáneas superen el límite).
- La arquitectura apunta a **1,000 RUCs por tenant** sin degradación.

### Límite técnico (SUNAT)
Todo lo que toca SUNAT corre en **cola de trabajos**, nunca en el request web:
- Concurrencia global máxima y **por tenant** (reparto justo: un estudio de 300 RUCs no bloquea a uno de 20).
- Prioridad: acción del usuario en pantalla > tareas programadas (buzones nocturnos).
- Espera mínima entre llamadas al mismo RUC (lo que ya hace el prototipo) y reintentos con backoff.
- Si el login falla por clave errada: el RUC pasa a `credencial_invalida`, se avisa y **no se reintenta** (evita bloquear la clave SOL del cliente).

## 4. Roles, permisos y asignación

### Permisos (atómicos)
| Módulo | Permisos |
|---|---|
| Estudio | `estudio.configurar`, `plan.gestionar` |
| Usuarios | `usuarios.ver`, `usuarios.gestionar`, `roles.gestionar` |
| Clientes | `clientes.ver`, `clientes.crear`, `clientes.editar`, `clientes.archivar`, `clientes.asignar` |
| Credenciales | `credenciales.editar` (nunca hay "ver": son solo escritura) |
| SIRE | `sire.descargar`, `sire.clasificar`, `sire.aprobar_generar` |
| Ajustes | `ajustes.crear`, `ajustes.generar` |
| Buzón | `buzon.ver`, `buzon.marcar_leido` |
| Reglas | `reglas.ver`, `reglas.gestionar` |
| Prorrata | `prorrata.ver` |
| Auditoría | `auditoria.ver` |

### Roles de sistema (el estudio puede crear roles propios combinando permisos)
| Rol | Alcance | Resumen |
|---|---|---|
| **Dueño** | todos los clientes | todo, incluye plan y eliminar estudio. Mínimo 1 por tenant. |
| **Administrador** | todos los clientes | todo menos plan/suscripción |
| **Contador** | solo asignados | descargar, clasificar, aprobar y generar, ajustes, buzón, reglas |
| **Asistente** | solo asignados | descargar y clasificar; **no** aprueba/genera ni edita credenciales |
| **Lectura** | solo asignados | ver propuestas, buzón y reportes |

### Asignación
- Tabla `asignacion(usuario, cliente, tipo)` con `tipo` = `responsable` | `colaborador`.
- Cada cliente tiene **un responsable** (el contador cuyo criterio aprende el sistema) y N colaboradores.
- Permiso efectivo = permisos del rol **∩** clientes visibles (todos si el rol tiene alcance global; si no, solo asignados).
- El dashboard de buzones solo muestra mensajes de los clientes visibles para el usuario.

## 5. Credenciales

### Qué se guarda por RUC
| Credencial | Uso | Persistencia |
|---|---|---|
| Usuario + clave SOL | Buzón, consultas SOL, descargar XML/PDF de comprobantes | Cifrada |
| client_id + client_secret API SIRE | Descargar propuestas, enviar reemplazos | Cifrada |
| Token SIRE | Llamadas a la API | Solo caché en memoria/Redis con su expiración (~1 h) |

### Cifrado (envelope encryption)

> Refinado en [03-arquitectura.md §5](03-arquitectura.md): cifrado híbrido con una DEK por secreto; la API solo puede **cifrar** (llave pública / `kms:Encrypt`) y solo el worker puede **descifrar**. Lo de abajo sigue vigente salvo la "DEK por tenant".

1. **Llave maestra (KEK)**: nunca está en la BD.
   - Local: archivo/variable `CONTAPP_MASTER_KEY` fuera del repo (`.env` en `.gitignore`).
   - Nube: AWS KMS / GCP KMS / Vault — mismo código, otro proveedor (`KeyProvider` intercambiable).
2. **Llave de datos por tenant (DEK)**: generada al crear el estudio, guardada **cifrada con la KEK**.
3. Cada secreto: **AES-256-GCM** con la DEK del tenant, nonce único y AAD = `tenant_id|cliente_id|tipo`. Copiar el cifrado a otra fila lo hace inservible.
4. **Solo los workers descifran**, en memoria, justo antes de usar la credencial. El backend nunca devuelve el secreto: muestra `configurada ✓` / `inválida ✗` / `última verificación`.
5. **Auditoría** de cada descifrado: quién/qué trabajo, cuándo, para qué RUC.
6. Importación desde Excel: se procesa en memoria y el archivo se descarta.
7. Rotación: se puede re-cifrar con nueva KEK/DEK sin cambiar las claves de los clientes.

Se descarta el cifrado con contraseña del usuario ("zero-knowledge") porque impediría revisar buzones en segundo plano.

### Legal
Ley 29733 (Protección de Datos Personales): términos de servicio, consentimiento del titular del RUC para guardar su clave SOL, y opción de borrado total de un cliente.

## 6. Entorno local (pruebas)

| Pieza | Local |
|---|---|
| BD | PostgreSQL 17 (ya instalado) |
| Cola | Redis (Docker o Memurai en Windows) |
| Llave maestra | `.env` local, fuera de git |
| Correo (invitaciones, alertas) | Mailpit/consola |
| Archivos (TXT/ZIP/XML) | carpeta local `storage/` (luego S3) |

Ojo: aun en local se usan **claves SOL reales** de clientes reales. Se aplican las mismas reglas de cifrado desde el día 1.

## 7. Reglas de negocio nuevas (transcripción completa)

1. **Ventas**: el SIRE casi no falla, pero a veces omite un comprobante (caso real: faltó la boleta 291 entre 290 y 292 y el contador declaró sin notarlo). → La auditoría de correlatividad es valiosa.
2. **Compras es donde están casi todos los errores.** El SIRE manda todo por defecto a **DG** (columna 1).
3. **Zona de la selva (Huánuco, etc.)**: si las ventas son exoneradas, las compras van mayormente a **DNG** (columna 3): ese IGV no se usa como crédito del mes, termina como gasto en la renta anual.
4. **DGNG (columna 2, prorrata)** solo para casos puntuales: alquiler/luz de un local secundario, o mercadería que se usa para ventas gravadas y exoneradas a la vez. Clasificar mixtos en DGNG por defecto puede hacer pagar de más al cliente.
5. **La clasificación es criterio del contador** → el primer mes lo hace él; el sistema aprende por **cliente + proveedor** (y luego por grupo de proveedor) y propone desde el mes siguiente. Siempre editable.
6. **SUNAT da plazo hasta febrero del próximo año** para corregir lo mal clasificado → los **ajustes posteriores** deben poder mover datos de periodos pasados, no solo los nuevos.
7. **Regla de consistencia ISC/IGV**: si una compra tiene base gravada > 0 pero IGV = 0, o el IGV no corresponde a 18 % ni 10 %, se marca como sospechosa. Caso típico: cerveza con ISC enviada a DG con IGV 0 → mover el monto a ISC.
8. **Origen del XML según serie**: los comprobantes con serie que empieza con **F** los emite el proveedor con su propio sistema; para verlos se usa otra consulta de SOL distinta a la de los emitidos desde el portal SUNAT. El módulo de "ver detalle" debe soportar ambas rutas.

9. **Proveedores con error conocido**: Cervecería San Juan *siempre* llega con el ISC en DG. → Catálogo global de proveedores con "error típico", aplicado a todos los tenants.
10. **Desdoblamiento de mixtos por incongruencia IGV/base** (caso real): base 21.48 con IGV 1.61. Al 18 % debería ser 3.87, al 10 % 2.15, así que no cuadra con ninguna tasa. La factura era mixta. Estimado sin XML: gravado ≈ 1.61 / 0.18 = **8.94**; como el IGV viene redondeado, cualquier gravado entre **8.92 y 8.97** produce 1.61. El XML da el valor exacto: gravado **8.97** y no gravado 21.48 − 8.97 = **12.51**.
    - **Regla**: si `IGV ≠ base × tasa` (18 % o 10 %, con tolerancia), estimar `gravado ≈ IGV / tasa` como **rango** (por el redondeo del IGV) y `no_gravado = base − gravado`; el monto final se toma del XML (o lo confirma el contador si no hay XML).
    - Si no se corrige, el ajuste posterior sale "procesado con errores" porque el IGV no cuadra.
11. **Error de redondeo (facturas en dólares)**: la suma de las partes no daba el total y SUNAT devolvía "procesado con errores", así que el ticket no se aceptaba.
    - **Regla**: antes de generar el TXT, recalcular cada fila con las mismas reglas de validación de SUNAT (redondeo a 2 decimales, tipo de cambio). Avisar la diferencia y proponer el monto corregido.
    - Objetivo: que **ningún** archivo generado salga "procesado con errores".
12. **ICBPER** (impuesto a las bolsas plásticas): puede venir mal ubicado igual que el ISC. Se valida con el XML y se mueve a su columna.
13. **Alerta de proveedor nuevo**: cuando aparece un RUC proveedor que el cliente nunca tuvo, el contador define dónde va y esa decisión alimenta el aprendizaje (regla 5).
14. **Edición total tipo Excel**: además del desplegable DG/DGNG/DNG, se debe poder editar cualquier celda de una fila (bases, IGV, ISC, ICBPER, no gravado, otros tributos) con recálculo de totales. El prototipo no lo permite y es una queja explícita.
15. **Glosa para detectar gastos personales**: el detalle del XML ("zapatillas…") permite ver que es un gasto propio del dueño y excluirlo con un clic.
16. **XML legible**: el XML de SUNAT es "puro códigos". La app debe interpretarlo y mostrar ítems, cantidades, precio unitario, IGV, ISC e ICBPER por línea, y resaltar el dato que justifica la corrección sugerida.
17. **Prorrata desde la declaración** (confirmado): el porcentaje se calcula con los montos del PDT 621 declarado, no con el SIRE.

### Modal de detalle del comprobante (botón 🔍 por fila)
Cada fila de compras y ventas tiene una **lupa**. Al presionarla se abre un modal con la factura de esa fila para revisar y decidir sin salir de la tabla.

**Contenido del modal**
1. **Cabecera**: emisor (RUC, razón social, si es proveedor nuevo), tipo y serie-número, fecha de emisión, moneda y tipo de cambio, origen (portal SUNAT "E…" / sistema propio "F…").
2. **Ítems** (desde el XML, en lenguaje humano): descripción, cantidad, unidad, precio unitario, valor de venta, tipo de afectación (gravado / exonerado / inafecto) e IGV, ISC e ICBPER por línea.
3. **Comparación SIRE vs XML**, lado a lado por columna (BI DG/DGNG/DNG, IGV, no gravado, ISC, ICBPER, otros, total). Las diferencias se **resaltan** y se muestra la regla que las detectó (R-ISC, R-MIX…) con su explicación ("IGV 1.61 no cuadra con 18 % ni 10 % de 21.48").
4. **Sugerencia del sistema**: la fila corregida propuesta.
5. **Historial**: cómo se clasificó este proveedor para este cliente en meses anteriores.

**Acciones**
- Aceptar la sugerencia.
- Editar cualquier monto (con recálculo y validación de cuadre en vivo).
- Cambiar clasificación DG / DGNG / DNG.
- **No deducible / excluir** (gasto personal, ajeno al negocio) con motivo opcional.
- "Recordar para este proveedor" → crea o actualiza la regla aprendida.
- Ver o descargar el XML y el PDF (representación impresa).
- Anterior / siguiente comprobante sin cerrar el modal (atajos de teclado ← →, Enter = aceptar).

**Si no hay XML disponible**: el modal muestra solo los datos del SIRE y ofrece "Subir XML" (arrastrar archivo) o "Reintentar descarga". El XML descargado se guarda una vez por comprobante y se reutiliza.

Cada decisión tomada en el modal queda en la auditoría (usuario, fecha, valor anterior → nuevo).

### Reglas del motor de correcciones (resumen para Fase 3)
| Código | Detecta | Acción sugerida | Requiere XML |
|---|---|---|---|
| R-ISC | IGV = 0 con base gravada > 0, o proveedor marcado como emisor de ISC | Mover el monto a ISC | Confirmación |
| R-MIX | IGV que no cuadra con 18 % ni con 10 % | Separar gravado y no gravado | Confirmación |
| R-RED | Suma de componentes ≠ total, o diferencia por tipo de cambio | Ajustar el redondeo | No |
| R-ICB | ICBPER en una columna incorrecta | Mover a ICBPER | Sí |
| R-NUM | Salto en la numeración de ventas | Alertar comprobante faltante | No |
| R-NEW | Proveedor nuevo para el cliente | Pedir clasificación y aprender | No |
| R-HIS | Proveedor con regla aprendida | Aplicar la clasificación del historial | No |

## 8. Pendientes

- Con esto el material de ambos videos está completo (la segunda media hora vino en un archivo aparte).
- Validar precios/límites de los planes.
- **Descarga de XML**: el equipo entregará después la fuente y su API. Mientras tanto se usa un proveedor simulado (`MockXmlProvider`) detrás de la interfaz `XmlProvider` (ver RF-097a en 02-requerimientos.md).
## 9. Stack

| Capa | Elección |
|---|---|
| Frontend | **Next.js** (App Router) + TypeScript, TanStack Table (grilla editable tipo Excel), Tailwind + shadcn/ui |
| Backend API | **Node.js + TypeScript** con **NestJS** (módulos, guards para roles/permisos, inyección de dependencias) |
| Workers | Mismo código Node, proceso aparte, colas **BullMQ** sobre Redis |
| Automatización SOL | **Playwright** (buzones, consultas, descarga de XML) |
| BD | PostgreSQL 17 + **Drizzle ORM** (permite fijar `app.tenant_id` por transacción para RLS sin pelear con el ORM) |
| Dinero | `decimal.js`. Nunca `number` para montos. |
| Validación | **zod**: los mismos esquemas en front, API y workers |
| Repo | Monorepo pnpm + Turborepo: `apps/frontend`, `apps/backend`, `apps/worker`, `packages/shared` |

**Por qué Node y no Go:**
- **Un solo lenguaje** con Next.js: tipos y validaciones (zod) compartidos entre front, API y workers. Un cambio en la estructura del comprobante se rompe en compilación, no en producción.
- **Playwright es nativo de Node.** Automatizar SOL es el corazón de buzones y XML; en Go solo hay un port mantenido por la comunidad.
- **El cuello de botella es SUNAT, no la CPU.** Las llamadas tienen límite de velocidad y esperas; la ventaja de rendimiento de Go no se aprovecha.
- **Ecosistema para este dominio**: Excel (exceljs), XML UBL (fast-xml-parser), ZIP, colas con límites de velocidad (BullMQ).
- Go tendría sentido si más adelante hay un proceso pesado puntual (por ejemplo procesar millones de comprobantes). Se puede sacar como microservicio sin rehacer el resto.

El backend va **separado** de Next.js (no en API routes): los workers corren solos, en segundo plano y con su propia escala.
