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
| **Panel** | Estadísticas, usuarios y roles, reportes CSV, **auditoría**. |

## Inicio rápido

Requisitos: Node 20+ y Docker (o un PostgreSQL 14+ propio).

```bash
npm install
docker compose up -d db                 # PostgreSQL en localhost:5432
cp .env.example .env                    # funciona tal cual en desarrollo
npm run prisma:migrate                  # crea el esquema (prisma migrate dev)

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
| Reportes CSV de desembolsos, documentos y casos / de usuarios, capital, inversiones y auditoría | – | ✅ / – | ✅ / ✅ |

No se puede cambiar el propio rol ni suspenderse, y siempre queda al menos un superadmin activo.

## Inversiones y métricas

Cada oportunidad nace con un **valor por unidad de 100.0000**. El superadmin registra valoraciones (fecha + valor), registra la inversión de un cliente (las unidades = capital ÷ valor vigente en la fecha de inversión) y puede rescatarla al valor vigente. Las fórmulas (valor actual, ganancia, rentabilidad, anualizado solo con 30+ días, historial, estadísticas tipo cotización) están en `src/investments/metrics.ts` con pruebas. Son cifras **informativas**: la contabilidad oficial es la del despacho.

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

31 pruebas e2e contra PostgreSQL real (auth, RBAC, cifrado, documentos, desembolsos, casos, inversiones, SSE) y pruebas puras de las fórmulas.

## Despliegue

- **No publiques el puerto de la API**: solo el front debe alcanzarla (confía en `X-Forwarded-For` de un único proxy para el *rate limit* y la auditoría).
- Migraciones: `npm run prisma:deploy`. Haz copias de seguridad de la base y de `STORAGE_DIR`; guarda `DATA_ENCRYPTION_KEY` aparte.
- Archivos en disco local: con varias instancias reemplaza `StorageService` por S3/GCS. Las alertas SSE son en memoria: con varias instancias usa un bus compartido (p. ej. Redis).

## Pendiente

- No se envían correos (ni recuperación de contraseña por correo); el superadmin restablece contraseñas desde el panel.
- Recomendado antes de operar con datos reales: verificación en dos pasos para el personal, antivirus para archivos subidos y política de retención de datos.
