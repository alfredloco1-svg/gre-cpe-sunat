// Edge Function: genera el token SUNAT en el SERVIDOR.
// Client Secret y Clave SOL NO viajan de nuevo al navegador en esta llamada.
//
// Deploy (CLI):
//   npx supabase login
//   npx supabase link --project-ref psfqhpxyidvhgozlptdd
//   npx supabase functions deploy obtener-token
//
// Body JSON:
//   { "empresa_id": "uuid", "tipo": "emision" | "consulta" }
//   tipo por defecto = "emision"

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Método no permitido' }, 405)
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'No autenticado' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Cliente con JWT del usuario → RLS aplica
    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user) {
      return json({ error: 'Sesión inválida' }, 401)
    }

    let body: { empresa_id?: string; tipo?: string }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'JSON inválido' }, 400)
    }

    const empresa_id = body.empresa_id
    const tipo = (body.tipo || 'emision').toLowerCase() // emision | consulta

    if (!empresa_id) {
      return json({ error: 'empresa_id requerido' }, 400)
    }

    const { data: emp, error: empErr } = await userClient
      .from('empresas')
      .select('id, ruc, usuario_sol, clave_sol, client_id, client_secret, ambiente')
      .eq('id', empresa_id)
      .single()

    if (empErr || !emp) {
      return json({ error: 'Empresa no encontrada o sin permiso' }, 404)
    }

    if (!emp.client_id || !emp.client_secret) {
      return json({ error: 'Faltan Client ID / Client Secret en la empresa' }, 400)
    }

    const isPrueba = emp.ambiente === 'PRUEBA'
    const baseSeguridad = isPrueba
      ? 'https://api-seguridad-test.sunat.gob.pe'
      : 'https://api-seguridad.sunat.gob.pe'

    let tokenUrl: string
    let form: URLSearchParams

    if (tipo === 'consulta') {
      // Token para validar CPE (client_credentials · extranet)
      tokenUrl = `${baseSeguridad}/v1/clientesextranet/${encodeURIComponent(emp.client_id)}/oauth2/token/`
      form = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes',
        client_id: emp.client_id,
        client_secret: emp.client_secret,
      })
    } else {
      // Token emisión GRE/CPE (password · clientessol)
      if (!emp.clave_sol || !emp.usuario_sol || !emp.ruc) {
        return json({ error: 'Faltan RUC / Usuario SOL / Clave SOL' }, 400)
      }
      tokenUrl = `${baseSeguridad}/v1/clientessol/${encodeURIComponent(emp.client_id)}/oauth2/token/`
      form = new URLSearchParams({
        grant_type: 'password',
        scope: 'https://api-cpe.sunat.gob.pe',
        client_id: emp.client_id,
        client_secret: emp.client_secret,
        username: emp.ruc + emp.usuario_sol,
        password: emp.clave_sol,
      })
    }

    const sunatRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form,
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
        error: `SUNAT (${tipo}): ${data.error_description || data.error || text.slice(0, 220)}`,
        status: sunatRes.status,
      }, 502)
    }

    const expiresIn = Number(data.expires_in) || 3600
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // Guardar solo tokens de emisión (consulta es más efímero)
    if (tipo !== 'consulta') {
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
        // Token OK aunque no se guarde; avisar
        return json({
          access_token: data.access_token,
          expires_at: expiresAt,
          expires_in: expiresIn,
          tipo,
          warning: 'Token OK pero no se guardó en BD: ' + tokErr.message,
        })
      }
    }

    return json({
      access_token: data.access_token,
      expires_at: expiresAt,
      expires_in: expiresIn,
      tipo,
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
