# GRE + CPE SUNAT Pro (Web + Supabase)

Aplicación web multiempresa para token oficial SUNAT, gestión de empresas, GRE/CPE y visor de comprobantes.

## 1. Configurar Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com)
2. Ve a **SQL Editor** → New query
3. Copia y ejecuta el archivo `supabase/schema.sql`
4. Ve a **Project Settings → API** y copia:
   - Project URL
   - anon public key
5. Edita `js/config.js`:

```js
window.SUPABASE_URL = 'https://xxxxx.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOi...';
window.USE_SUPABASE = true;
```

6. En **Authentication → Providers** deja Email habilitado.
7. (Opcional) En Authentication → Settings desactiva "Confirm email" para pruebas rápidas.

## 2. Credenciales SUNAT (como el video)

Por cada empresa necesitas:

| Campo | Origen |
|-------|--------|
| RUC | 11 dígitos |
| Usuario SOL | Solo el usuario (ej. MODDATOS), **sin** el RUC |
| Clave SOL | Contraseña de SOL |
| Client ID | SOL → Empresas → Credenciales de API SUNAT |
| Client Secret | Misma pantalla (clave de la app Desktop / GRE) |

Al crear la app en SUNAT: marca los alcances de GRE y **Desktop**, luego valida.

## 3. Cómo correr

```bash
# Local
python3 -m http.server 8080
# Abre http://localhost:8080
```

O sube la carpeta a GitHub + Vercel/Netlify.

## 4. Flujo de uso

1. Crear cuenta / Iniciar sesión
2. Empresas → Nueva → RUC → Buscar en SUNAT → completar SOL + Client ID/Secret
3. Activar empresa
4. Token SUNAT → Generar Token
5. Visor → consulta individual de comprobante

## 5. Modo sin Supabase

En `js/config.js` pon `USE_SUPABASE = false` y usará solo LocalStorage (demo offline).

## Estructura

```
gre-sunat-web/
  index.html
  css/styles.css
  js/config.js
  js/supabase-client.js
  js/storage.js
  js/api.js
  js/app.js
  supabase/schema.sql
  README.md
```

## 6. Autenticación con Google

### A. Google Cloud Console

1. Ve a [Google Cloud Console](https://console.cloud.google.com/)
2. Crea un proyecto (o usa uno existente)
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
4. Tipo: **Web application**
5. Authorized JavaScript origins:
   - `http://localhost:8080` (desarrollo)
   - `https://tu-dominio.com` (producción)
6. Authorized redirect URIs:
   - `https://TU_PROJECT_REF.supabase.co/auth/v1/callback`
7. Copia **Client ID** y **Client Secret**

### B. Supabase

1. **Authentication → Providers → Google** → Enable
2. Pega Client ID y Client Secret de Google
3. Guarda
4. En **Authentication → URL Configuration**:
   - Site URL: `http://localhost:8080` (o tu dominio)
   - Redirect URLs: agrega `http://localhost:8080` y tu dominio de producción

### C. Probar

1. Abre la app
2. En el login, pulsa **Google**
3. Elige la cuenta → vuelve autenticado

> Nota: el callback de OAuth es manejado por Supabase; la app detecta la sesión al recargar.
