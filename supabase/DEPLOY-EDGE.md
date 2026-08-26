# Desplegar Edge Function `obtener-token`

Con esta función, **Clave SOL y Client Secret** se usan solo en el servidor de Supabase.

Tu project ref: `psfqhpxyidvhgozlptdd`

## Opción A — CLI (recomendada)

En la PC (PowerShell o Terminal), en la carpeta del proyecto:

```bash
# 1. Node.js instalado (https://nodejs.org)

# 2. Login
npx supabase login

# 3. Vincular proyecto (te pide el access token del dashboard)
npx supabase link --project-ref psfqhpxyidvhgozlptdd

# 4. Desplegar la function
npx supabase functions deploy obtener-token
```

Variables: Supabase inyecta solo `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. **No hace falta** configurarlas a mano.

## Opción B — Desde el panel (si no usas CLI)

1. Supabase → **Edge Functions**
2. **Create a new function** → nombre: `obtener-token`
3. Pega el contenido de `supabase/functions/obtener-token/index.ts`
4. Deploy

## Probar

1. Entra a la app con Google (sesión activa).
2. Empresa activa con RUC, Usuario SOL, Clave, Client ID y Secret guardados en Supabase.
3. **Generar Token** → la app llama a `functions.invoke('obtener-token')`.
4. Si falla, en **Edge Functions → Logs** verás el error de SUNAT o de permisos.

## Tipos

| Body | Uso |
|------|-----|
| `{ "empresa_id": "...", "tipo": "emision" }` | Token GRE/CPE (password grant) |
| `{ "empresa_id": "...", "tipo": "consulta" }` | Token validar facturas/boletas |

## Seguridad

- El JWT del usuario es obligatorio.
- Solo lee empresas del usuario (RLS).
- `service_role` solo en el servidor para guardar el token.
- Nunca pongas `service_role` en el frontend.
