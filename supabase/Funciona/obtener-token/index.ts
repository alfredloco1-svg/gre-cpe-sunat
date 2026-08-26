// Edge Function: genera el token SUNAT en el servidor.
// Así Client Secret y Clave SOL NUNCA salen de nuevo al navegador.
//
// Deploy:
//   supabase functions deploy obtener-token --no-verify-jwt=false
//
// Llamada desde el cliente (con sesión del usuario):
//   const { data, error } = await supabase.functions.invoke('obtener-token', {
//     body: { empresa_id: 'uuid-de-la-empresa' }
//   })

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'No autenticado' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Cliente con el JWT del usuario (respeta RLS)
    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user) {
      return json({ error: 'Sesión inválida' }, 401)
    }

    const { empresa_id } = await req.json()
    if (!empresa_id) {
      return json({ error: 'empresa_id requerido' }, 400)
    }

    // Leer credenciales de la empresa del usuario (RLS)
    const { data: emp, error: empErr } = await userClient
      .from('empresas')
      .select('id, ruc, usuario_sol, clave_sol, client_id, client_secret, ambiente')
      .eq('id', empresa_id)
      .single()

    if (empErr || !emp) {
      return json({ error: 'Empresa no encontrada o sin permiso' }, 404)
    }

    if (!emp.client_id || !emp.client_secret || !emp.clave_sol || !emp.usuario_sol) {
      return json({ error: 'Faltan credenciales SOL / API en la empresa' }, 400)
    }

    const base = emp.ambiente === 'PRUEBA'
      ? 'https://api-seguridad-test.sunat.gob.pe'
      : 'https://api-seguridad.sunat.gob.pe'

    const url = `${base}/v1/clientessol/${encodeURIComponent(emp.client_id)}/oauth2/token/`

    const body = new URLSearchParams({
      grant_type: 'password',
      scope: 'https://api-cpe.sunat.gob.pe',
      client_id: emp.client_id,
      client_secret: emp.client_secret,
      username: emp.ruc + emp.usuario_sol,
      password: emp.clave_sol,
    })

    const sunatRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })

    const text = await sunatRes.text()
    let data: Record<string, unknown>
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }

    if (!sunatRes.ok || !data.access_token) {
      return json({
        error: `SUNAT: ${data.error_description || data.error || text.slice(0, 200)}`,
      }, 502)
    }

    const expiresIn = Number(data.expires_in) || 3600
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // Guardar token (service role solo para upsert confiable; user_id del dueño)
    const admin = createClient(supabaseUrl, serviceKey)
    const { error: tokErr } = await admin.from('tokens').upsert(
      {
        user_id: user.id,
        empresa_id: emp.id,
        access_token: data.access_token as string,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'empresa_id' },
    )

    if (tokErr) {
      return json({ error: 'Token obtenido pero no se pudo guardar: ' + tokErr.message }, 500)
    }

    // No devolver el access_token completo si no hace falta; aquí sí porque la app lo usa
    return json({
      access_token: data.access_token,
      expires_at: expiresAt,
      expires_in: expiresIn,
    })
  } catch (e) {
    return json({ error: (e as Error).message || 'Error interno' }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
