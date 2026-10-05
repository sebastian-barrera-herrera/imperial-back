# Imperial Law Group — API (`imperial-back`)

API REST de la plataforma de **gestión de casos y recuperación de capital** de Imperial Law Group. La consume el repositorio [`imperial-front`](https://github.com/sebastian-barrera-herrera/imperial-front) (Next.js), que reenvía `/api/*` a este servicio.

**Stack:** NestJS 11 · Prisma 6 · PostgreSQL · JWT en cookies httpOnly · Server-Sent Events para alertas en tiempo real.

## Qué hace

| Área | Descripción |
|---|---|
| **Auth** | Registro con consentimiento de privacidad (queda fecha y versión), login, refresh token rotativo con detección de reutilización, cambio de contraseña, suspensión inmediata. |
| **Perfil** | Cédula y cuenta bancaria **cifradas** (AES‑256‑GCM); índice ciego para unicidad de la cédula. |
| **Documentos** | Carga por categoría (identidad, bancarios, legales, comprobantes), validación por contenido real (PDF/JPG/PNG, 10 MB), duplicados, revisión del personal con motivo de rechazo. |
| **Desembolsos** | Solicitudes con máquina de estados (`Pendiente → Aprobada → En proceso → Desembolsada`, `Rechazada`, `Cancelada`), historial y requisitos previos. Exportación CSV. |
| **Casos** | Etapas, línea de tiempo, documentos requeridos y aislamiento por abogado asignado. |
| **Alertas** | Centro de notificaciones, preferencias por tipo, tiempo real por SSE, alertas manuales y masivas. |
| **Capital e inversiones** | Oportunidades con **valor por unidad**, valoraciones, posiciones por cliente, rescates, portafolio con métricas (valor, ganancia, rentabilidad, anualizado, historial, distribución), simulador. |
| **Documento de aprobación (PDF)** | El **superadmin define sus datos** (emisor, entidad financiera, fecha de solicitud, firmante, lugar, observaciones) y **lo habilita**; solo entonces el cliente puede descargarlo (el personal ve un borrador sellado). Contiene: membrete con logo, marca de agua, monto en cifras y letras, partes, trámite, condiciones, firma y **código de verificación + QR**. Hay una verificación pública (`GET /api/public/verify`) que confirma el documento sin revelar datos personales y deja de validarlo si la solicitud se rechaza después. |
| **Clientes** | Lista con datos (país, teléfono, asesor, total depositado, estado). El superadmin **da de baja** (pierde el acceso al instante, se cierran sus sesiones y se conservan sus datos) y **reactiva**; al intentar entrar el cliente recibe un aviso claro. |
| **Asesor profesional** | El superadmin asigna un abogado o superadmin a cada cliente y este ve su nombre en su panel (si no hay asignado, el abogado de su caso abierto). |
| **Depósitos** | El superadmin registra los depósitos del cliente (monto, fecha, referencia bancaria, nota); el cliente ve el total y su historial. Alta, corrección y baja quedan auditadas con los valores anteriores. |
| **Documentos del despacho** | El superadmin entrega documentos (contratos, constancias, resoluciones…) a un cliente; el cliente recibe una alerta y los ve en su cuenta. Se validan por contenido (PDF/JPG/PNG, 10 MB), con rastro de entrega, descarga y visto. |
| **Editor de imágenes** | Solo superadmin y para **piezas gráficas propias**: el original se conserva inmutable, cada edición de texto es una versión nueva con su autor, fecha y huella SHA-256, y todo queda en la auditoría. |
| **Contenido del sitio** | El superadmin edita el equipo y los testimonios de la web (textos, nombres, fotos, orden, publicar/ocultar). Cada alta o cambio de identidad exige **confirmar la autorización** de la persona y queda registrado. |
| **Panel** | Estadísticas, usuarios y roles, reportes CSV, **auditoría**. |

## Inicio rápido

Requisitos: Node 20+ y Docker (o un PostgreSQL 14+ propio).

```bash
npm install                             # también genera el cliente de Prisma (postinstall)
docker compose up -d db                 # PostgreSQL en localhost:5432
cp .env.example .env                    # funciona tal cual en desarrollo
npm run prisma:migrate                  # crea el esquema (prisma migrate dev)
# Si TypeScript dice que '@prisma/client' no exporta UserStatus/Role…: npm run prisma:generate

# Superadmin inicial
SUPERADMIN_EMAIL=admin@tudespacho.com SUPERADMIN_PASSWORD='UnaClaveLarga123' npm run seed

# (Opcional, solo desarrollo) un cliente inversionista con datos inventados
npm run seed:demo                       # cliente.demo@imperial.test / DemoCliente2026

npm run start:dev                       # http://localhost:4000/api/health
```

Después arranca el front (`imperial-front`) en otra terminal.

> Los valores de `.env.example` son solo para desarrollo: con `NODE_ENV=production` la API **se niega a arrancar** si `JWT_SECRET` o `DATA_ENCRYPTION_KEY` conservan el valor de ejemplo.

## Variables de entorno

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión de PostgreSQL. |
| `JWT_SECRET` | Firma de los tokens de acceso (≥ 32 caracteres). `openssl rand -base64 48` |
| `DATA_ENCRYPTION_KEY` | Clave de 32 bytes (hex o base64) que cifra cédula y cuenta bancaria. **Si se pierde, esos datos son irrecuperables.** `openssl rand -base64 32` |
| `PORT` | Puerto (4000 por defecto). |
| `CORS_ORIGIN` | Origen(es) del front separados por coma. Con el proxy de Next no se usa desde el navegador. |
| `COOKIE_SECURE` | `true` por defecto en producción; `false` solo para pruebas por http. |
| `STORAGE_DIR` | Carpeta de archivos subidos (`storage`). |
| `DEFAULT_CURRENCY` | Moneda de solicitudes y casos (`USD`). |

## Roles y permisos

| Capacidad | Cliente | Abogado | Superadmin |
|---|:-:|:-:|:-:|
| Perfil, documentos, desembolsos, casos, alertas y portafolio **propios** | ✅ | – | – |
| Validar / rechazar documentos de cualquier cliente | – | ✅ | ✅ |
| Cambiar estado de solicitudes de desembolso | – | ✅ | ✅ |
| Ver y gestionar casos | – | solo los **asignados** | todos |
| Reasignar casos | – | – | ✅ |
| Consultar datos personales de un cliente (queda auditado) | – | ✅ | ✅ |
| Alerta a un cliente / alerta masiva | – / – | ✅ / – | ✅ / ✅ |
| Usuarios y roles, auditoría | – | – | ✅ |
| Oportunidades, valoraciones, inversiones y rescates | ver y solicitar participar | – | gestionar |
| Editar el contenido público (equipo, testimonios, fotos) | – | – | ✅ |
| Descargar el PDF de aprobación de un desembolso | solo el suyo | ✅ | ✅ |
| Entregar documentos a un cliente / ver lo entregado | solo ve lo suyo | – | ✅ |
| Definir y habilitar el documento de aprobación | – | solo lo consulta | ✅ |
| Dar de baja / reactivar clientes, asignar asesor, registrar depósitos | – | – | ✅ |
| Ver su asesor y sus depósitos | ✅ | – | – |
| Editor de imágenes | – | – | ✅ |
| Reportes CSV de desembolsos, documentos y casos / de usuarios, capital, inversiones y auditoría | – | ✅ / – | ✅ / ✅ |

No se puede cambiar el propio rol ni suspenderse, y siempre queda al menos un superadmin activo.

## Inversiones y métricas

Cada oportunidad nace con un **valor por unidad de 100.0000**. El superadmin registra valoraciones (fecha + valor), registra la inversión de un cliente (las unidades = capital ÷ valor vigente en la fecha de inversión) y puede rescatarla al valor vigente. Las fórmulas (valor actual, ganancia, rentabilidad, anualizado solo con 30+ días, historial, estadísticas tipo cotización) están en `src/investments/metrics.ts` con pruebas. Son cifras **informativas**: la contabilidad oficial es la del despacho.

## Contenido del sitio

- `GET /api/public/content` (sin sesión) devuelve lo **publicado**; una sección sin filas devuelve `null` y la web usa su contenido de respaldo.
- Administración en `/api/admin/content/*` (solo superadmin): perfiles del equipo, testimonios, orden, fotos y carga del contenido de ejemplo (`POST /samples`).
- **Autorización registrada:** crear un perfil o testimonio, cambiar la cita, el nombre o la foto, o reemplazar un ejemplo exige `authorized: true` (quién y cuándo queda guardado). Los ejemplos se publican rotulados como ilustrativos hasta que se reemplazan.
- Fotos: JPG, PNG o WebP reales (se detectan por los primeros bytes; **sin SVG**), máx. 5 MB. Una foto solo es pública mientras la use un elemento publicado; al reemplazar o eliminar se borra si nadie más la usa, y las subidas que nunca se asocian se limpian a las 24 h.

## Documento de aprobación y documentos del despacho

- El superadmin prepara el documento en `PUT /api/admin/disbursements/:id/approval-document` y lo habilita con `POST …/release` (o lo retira con `…/withdraw`). El cliente descarga con `GET /api/disbursements/:id/approval-pdf` solo si está habilitado; el personal puede descargar un **borrador** sellado en `/api/admin/disbursements/:id/approval-pdf`. Existe solo para solicitudes **aprobadas** (o más avanzadas). Se genera con PDFKit usando los logos de `assets/brand/`. Solo imprime los últimos 4 dígitos de la cuenta y de la cédula.
- El **código de verificación** es un HMAC (con `JWT_SECRET`) del número, monto, moneda, fecha de aprobación, cliente **y todos los datos del documento**: si el superadmin cambia cualquiera, los PDF descargados antes dejan de verificarse. Un borrador nunca se verifica; el QR apunta a `${PUBLIC_SITE_URL}/verificar`. Define `PUBLIC_SITE_URL` en producción. El despacho está en **Miami**: las fechas usan `America/New_York` (`APP_TIMEZONE`) y el lugar de emisión por defecto es «Miami, Florida, EE. UU.» (`DOC_ISSUE_PLACE`).
- **Los textos del PDF (condiciones y encabezados) son una redacción general: que los revise tu asesor jurídico** antes de usarlos con clientes.
- Documentos del despacho: `POST /api/admin/clients/:id/issued-documents` (multipart, solo superadmin) y `GET /api/issued-documents` para el cliente.

## Editor de imágenes

- `/api/admin/studio/*` (solo superadmin). Sube un original, guarda versiones editadas y descárgalas; el original nunca se modifica.
- Pensado para piezas propias del despacho (flyers, publicaciones, tarjetas). **No es una herramienta para modificar documentos, comprobantes o identificaciones de terceros**: no tiene acceso a los documentos de los clientes y cada versión y descarga queda registrada con las huellas del original y del resultado.

## Seguridad

- Contraseñas con bcrypt (coste 12); 10+ caracteres con letra y número.
- JWT de 15 min + refresh token opaco rotativo (hash en base de datos) en cookies `ilg_at` / `ilg_rt` (httpOnly, SameSite=Lax, `Secure` en producción).
- Se consulta el usuario en cada petición: suspensiones y cambios de rol aplican al instante.
- Autorización por rol **y** por propiedad del recurso (un cliente recibe `404` ante recursos ajenos).
- Archivos: tipo por contenido real, nombre aleatorio en disco, descarga siempre como adjunto.
- `helmet`, validación estricta de DTOs, *rate limiting*, CSV a prueba de inyección de fórmulas.
- **Auditoría** de accesos, cambios de estado, consulta de datos personales, descargas del personal, exportaciones e inversiones.

## Pruebas

```bash
# Requiere una base cuyo nombre contenga "test" (los tests la vacían)
createdb imperial_test        # o: psql -c "create database imperial_test"
npm test                      # TEST_DATABASE_URL para usar otra
npm run typecheck
```

94 pruebas e2e contra PostgreSQL real (auth, RBAC, cifrado, documentos, desembolsos, casos, inversiones, contenido del sitio, PDF de aprobación, documentos del despacho, editor de imágenes, gestión de clientes, SSE) y pruebas puras de las fórmulas.

## Despliegue

- **No publiques el puerto de la API**: solo el front debe alcanzarla (confía en `X-Forwarded-For` de un único proxy para el *rate limit* y la auditoría).
- Migraciones: `npm run prisma:deploy`. Haz copias de seguridad de la base y de `STORAGE_DIR`; guarda `DATA_ENCRYPTION_KEY` aparte.
- Archivos en disco local: con varias instancias reemplaza `StorageService` por S3/GCS. Las alertas SSE son en memoria: con varias instancias usa un bus compartido (p. ej. Redis).

## Pendiente

- No se envían correos (ni recuperación de contraseña por correo); el superadmin restablece contraseñas desde el panel.
- Recomendado antes de operar con datos reales: verificación en dos pasos para el personal, antivirus para archivos subidos y política de retención de datos.
