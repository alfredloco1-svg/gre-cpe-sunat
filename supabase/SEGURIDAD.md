# Seguridad — GRE + CPE SUNAT Pro

Los datos (Clave SOL, Client Secret, tokens) son **altamente sensibles**. Sigue esta checklist.

## 1. Obligatorio en Supabase (panel)

### Auth solo por invitación
1. **Authentication → Providers → Email**
   - Desactiva **Enable sign ups**
2. **Authentication → Users → Add user → Send invitation**
   - Solo invita a personas de confianza
3. **Authentication → Providers → Google**
   - Activa Google OAuth (Client ID + Secret de Google Cloud)
4. **Authentication → URL Configuration**
   - Site URL = `https://tu-dominio.com` (nunca `*`)
   - Redirect URLs = solo tus dominios reales + localhost para pruebas

### Schema + RLS
1. SQL Editor → ejecuta `supabase/schema.sql`
2. Verifica que RLS esté **ON** en `empresas` y `tokens`
3. Nunca uses la clave `service_role` en el frontend (solo en Edge Functions / servidor)

### API keys
- `anon` key → sí puede ir en el frontend (protegida por RLS)
- `service_role` → **NUNCA** en HTML/JS público

## 2. Token SUNAT en el servidor (recomendado)

Sin Edge Function, el navegador llama a SUNAT con Client Secret y Clave SOL → se ven en DevTools.

Con Edge Function `obtener-token`:
1. Instala CLI: `npm i -g supabase`
2. `supabase login` y `supabase link --project-ref TU_REF`
3. `supabase functions deploy obtener-token`
4. En la app, el botón “Generar Token” llama a la function (código ya preparado en `js/api.js`)

Las credenciales se leen en el servidor y no se reenvían al cliente al generar el token.

## 3. Buenas prácticas operativas

| Práctica | Por qué |
|----------|---------|
| Solo HTTPS en producción | Evita que alguien intercepte la sesión |
| Rotar Client Secret si se filtra | Limita el daño |
| No compartir cuentas Supabase | Cada persona = 1 usuario invitado |
| No usar modo LocalStorage en producción | Los secretos quedarían en el disco del PC |
| Cerrar sesión en PCs compartidos | Tokens de sesión en el navegador |
| Revisar Authentication → Users periódicamente | Eliminar usuarios que ya no trabajen |

## 4. Qué protege el schema

- **RLS**: usuario A no puede leer empresas ni tokens del usuario B
- **anon** sin políticas: sin login no hay acceso a tablas
- **UNIQUE (user_id, ruc)**: un RUC por usuario
- **Una sola empresa activa** por usuario (trigger)
- **ON DELETE CASCADE**: al borrar usuario, se borran sus datos

## 5. Limitaciones honestas

- Mientras el frontend pueda leer `clave_sol` / `client_secret` (necesario para editar o para token en cliente), un usuario autenticado malicioso con acceso físico al PC puede verlos en memoria/red.
- La mitigación fuerte es **Edge Function** + no devolver secretos en listados (solo flags “configurado / no configurado”).
- Para máxima seguridad empresarial: backend propio, HSM o vault, y sin secretos en el browser en absoluto.
