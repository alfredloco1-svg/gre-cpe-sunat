// Edge Function: descarga propuesta SIRE (RCE compras / RVIE ventas) en el SERVIDOR.
// Evita CORS y no expone Clave SOL / Client Secret al navegador.
//
// Deploy:
//   npx supabase functions deploy sire-propuesta
//
// Body JSON:
//   {
//     "empresa_id": "uuid",
//     "periodo": "202608",          // YYYYMM
//     "libro": "rce" | "rvie"       // default rce
//   }
//
// Respuesta OK:
//   { ok: true, periodo, libro, ticket, total, items: [...] }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const TIPO_DOC: Record<string, string> = {
  '01': 'Factura',
  '03': 'Boleta',
  '07': 'Nota de crédito',
  '08': 'Nota de débito',
  '09': 'GRE Remitente',
  '31': 'GRE Transportista',
  '14': 'Recibo por honorarios',
  '02': 'Recibo por honorarios',
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
    if (!authHeader) return json({ error: 'No autenticado' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!

    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user) return json({ error: 'Sesión inválida' }, 401)

    let body: { empresa_id?: string; periodo?: string; libro?: string }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'JSON inválido' }, 400)
    }

    const empresa_id = body.empresa_id
    const periodo = String(body.periodo || '').trim()
    const libro = (body.libro || 'rce').toLowerCase() === 'rvie' ? 'rvie' : 'rce'

    if (!empresa_id) return json({ error: 'empresa_id requerido' }, 400)
    if (!/^\d{6}$/.test(periodo)) {
      return json({ error: 'periodo inválido (use YYYYMM, ej. 202608)' }, 400)
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
      return json({ error: 'Faltan Client ID / Client Secret' }, 400)
    }
    if (!emp.ruc || !emp.usuario_sol || !emp.clave_sol) {
      return json({ error: 'Faltan RUC / Usuario SOL / Clave SOL' }, 400)
    }

    // 1) Token SIRE
    const isPrueba = emp.ambiente === 'PRUEBA'
    const baseSeguridad = isPrueba
      ? 'https://api-seguridad-test.sunat.gob.pe'
      : 'https://api-seguridad.sunat.gob.pe'

    const tokenUrl = `${baseSeguridad}/v1/clientessol/${encodeURIComponent(emp.client_id)}/oauth2/token/`
    const tokenForm = new URLSearchParams({
      grant_type: 'password',
      scope: 'https://api-sire.sunat.gob.pe',
      client_id: emp.client_id,
      client_secret: emp.client_secret,
      username: emp.ruc + emp.usuario_sol,
      password: emp.clave_sol,
    })

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenForm,
    })
    const tokenText = await tokenRes.text()
    let tokenData: Record<string, unknown>
    try {
      tokenData = JSON.parse(tokenText)
    } catch {
      tokenData = { raw: tokenText }
    }
    if (!tokenRes.ok || !tokenData.access_token) {
      return json({
        error: `Token SIRE: ${tokenData.error_description || tokenData.error || tokenText.slice(0, 220)}`,
        status: tokenRes.status,
      }, 502)
    }
    const accessToken = String(tokenData.access_token)
    console.log('SIRE token OK', { ruc: emp.ruc, periodo, libro })

    // 2) Solicitar propuesta → ticket
    const baseSire = 'https://api-sire.sunat.gob.pe'
    const propuestaPath = libro === 'rvie'
      ? `/v1/contribuyente/migeigv/libros/rvie/propuesta/web/propuesta/${periodo}/exportapropuesta?codTipoArchivo=0`
      : `/v1/contribuyente/migeigv/libros/rce/propuesta/web/propuesta/${periodo}/exportacioncomprobantepropuesta?codTipoArchivo=0&codOrigenEnvio=1`

    const propRes = await fetch(baseSire + propuestaPath, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    })
    const propText = await propRes.text()
    let propData: Record<string, unknown>
    try {
      propData = JSON.parse(propText)
    } catch {
      propData = { raw: propText }
    }
    if (!propRes.ok) {
      return json({
        error: `Propuesta SIRE: ${propData.msg || propData.message || propData.error || propText.slice(0, 220)}`,
        status: propRes.status,
      }, 502)
    }

    const numTicket = String(
      propData.numTicket || propData.ticket || propData.num_ticket || ''
    )
    if (!numTicket) {
      return json({
        error: 'SUNAT no devolvió numTicket',
        raw: propText.slice(0, 300),
      }, 502)
    }

    // 3) Poll ticket con endpoints oficiales SIRE (consultaestadotickets + archivoreporte)
    console.log('SIRE ticket', numTicket)
    let archivoTexto = ''
    let ultimoEstado: unknown = null
    let nomArchivoReporte = ''
    let codTipoArchivoReporte = '0'
    const codLibro = libro === 'rvie' ? '140000' : '080000' // códigos típicos libro; SUNAT puede devolver el real
    const maxAttempts = 8
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await sleep(5000)
      console.log('SIRE poll', i + 1, '/', maxAttempts)

      // Consultar estado del ticket (manual oficial)
      const consultaUrls = [
        `${baseSire}/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets?perIni=${periodo}&perFin=${periodo}&page=1&perPage=20&numTicket=${encodeURIComponent(numTicket)}`,
        `${baseSire}/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte/lista?perIni=${periodo}&perFin=${periodo}&page=1&perPage=20&numTicket=${encodeURIComponent(numTicket)}`,
      ]

      for (const curl of consultaUrls) {
        try {
          const stRes = await fetch(curl, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
            },
          })
          const stText = await stRes.text()
          console.log('SIRE consulta status', stRes.status, stText.slice(0, 180))
          let stData: Record<string, unknown> = {}
          try {
            stData = JSON.parse(stText)
          } catch {
            if (stRes.ok && stText.length > 80 && !stText.trim().startsWith('{')) {
              archivoTexto = stText
              break
            }
            continue
          }
          ultimoEstado = stData

          // Buscar registro del ticket en registros[] o estructura plana
          const registros = (stData.registros || stData.records || stData.data || []) as Record<string, unknown>[]
          let reg: Record<string, unknown> | null = null
          if (Array.isArray(registros) && registros.length) {
            reg = registros.find((r) => String(r.numTicket || r.num_ticket || '') === numTicket) || registros[0]
          } else if (stData.numTicket || stData.codEstadoProceso) {
            reg = stData
          }

          if (reg) {
            const codEst = String(reg.codEstadoProceso || reg.codEstado || reg.estado || '')
            const desEst = String(reg.desEstadoProceso || reg.desEstado || '')
            console.log('SIRE estado ticket', codEst, desEst)
            // 06 = Terminado, 04 = Procesado sin errores
            const archivoInfo = (reg.archivoReporte || reg.detalleTicket || reg) as Record<string, unknown>
            const nom =
              archivoInfo?.nomArchivoReporte ||
              reg.nomArchivoReporte ||
              reg.nomArchivo ||
              ''
            if (nom) nomArchivoReporte = String(nom)
            if (archivoInfo?.codTipoArchivoReporte != null) {
              codTipoArchivoReporte = String(archivoInfo.codTipoArchivoReporte)
            }
            if (reg.codLibro) {
              // preferir el del response
            }

            if ((codEst === '06' || codEst === '04' || /terminado|concluido/i.test(desEst)) && nomArchivoReporte) {
              const dlUrl =
                `${baseSire}/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte` +
                `?nomArchivoReporte=${encodeURIComponent(nomArchivoReporte)}` +
                `&codTipoArchivoReporte=${encodeURIComponent(codTipoArchivoReporte)}` +
                `&codLibro=${encodeURIComponent(String(reg.codLibro || codLibro))}`
              console.log('SIRE descargando', nomArchivoReporte)
              const dr = await fetch(dlUrl, {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: 'application/json, application/zip, text/plain, */*',
                },
              })
              const dt = await dr.text()
              console.log('SIRE download status', dr.status, 'len', dt.length)
              if (dr.ok && dt.length > 50) {
                try {
                  const dj = JSON.parse(dt)
                  const b64 = dj.archivo || dj.contenido || dj.file || dj.arcContent
                  if (typeof b64 === 'string' && b64.length > 50) {
                    try {
                      archivoTexto = atob(b64.replace(/\s/g, ''))
                    } catch {
                      archivoTexto = b64
                    }
                  }
                } catch {
                  archivoTexto = dt
                }
              }
            }
          }
          if (archivoTexto) break
        } catch (e) {
          console.log('SIRE consulta error', String(e))
        }
      }
      if (archivoTexto) break
    }

    if (!archivoTexto) {
      console.log('SIRE archivo no listo', { numTicket, ultimoEstado, nomArchivoReporte })
      return json({
        ok: false,
        error:
          'Ticket generado pero el archivo aún no está listo. ' +
          'Espera 30–60 s y pulsa de nuevo "Cargar propuesta". Ticket: ' + numTicket,
        ticket: numTicket,
        periodo,
        libro,
        estado: ultimoEstado,
      }, 200)
    }
    console.log('SIRE archivo OK, bytes', archivoTexto.length)

    // Si viene ZIP en base64/binario simple, intentar extraer texto (solo plain text)
    // Deno no tiene unzip nativo sencillo; asumimos TXT/CSV o contenido texto.
    const items = parsePropuesta(archivoTexto, libro)

    return json({
      ok: true,
      periodo,
      libro,
      ticket: numTicket,
      total: items.length,
      items,
    })
  } catch (e) {
    return json({ error: (e as Error).message || 'Error interno' }, 500)
  }
})

function parsePropuesta(texto: string, libro: string) {
  const lines = String(texto || '').split(/\r?\n/).filter((l) => l.trim())
  const rows: Record<string, unknown>[] = []

  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('RUC|') || t.startsWith('Período') || t.startsWith('Periodo') || t.length < 15) {
      continue
    }
    const parts = t.includes('|') ? t.split('|') : t.split('\t')
    if (parts.length < 6) continue

    // Formatos SIRE varían por versión del anexo. Heurística flexible.
    let tipo = ''
    let serie = ''
    let numero = ''
    let fecha = ''
    let rucEmisor = ''
    let razon = ''
    let monto = ''

    // Buscar un código de tipo de 2 dígitos
    for (let i = 0; i < Math.min(parts.length, 8); i++) {
      const p = parts[i].trim()
      if (/^(0[1-9]|1[0-4]|2[0-9]|3[0-4]|5[0-4])$/.test(p) && !tipo) tipo = p
      if (/^\d{11}$/.test(p) && !rucEmisor) rucEmisor = p
      if (/^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$/.test(p) && !fecha) fecha = p
      if (/^[A-Z0-9]{1,4}$/i.test(p) && p.length <= 4 && !serie && i > 0) serie = p.toUpperCase()
      if (/^\d{1,8}$/.test(p) && Number(p) > 0 && !numero && serie) numero = String(Number(p))
    }

    // Fallback por posición típica RCE
    if (!tipo) tipo = (parts[1] || parts[0] || '').trim()
    if (!serie) serie = (parts[2] || '').trim().toUpperCase()
    if (!numero) numero = (parts[3] || '').trim()
    if (!fecha) fecha = (parts[4] || parts[5] || '').trim()
    if (!rucEmisor) {
      for (const p of parts) {
        if (/^\d{11}$/.test(p.trim())) {
          rucEmisor = p.trim()
          break
        }
      }
    }
    // razón: primer campo no numérico largo
    for (const p of parts) {
      const s = p.trim()
      if (s.length > 8 && !/^\d+$/.test(s) && s !== serie && !razon) razon = s
    }
    // monto: último número decimal
    for (let i = parts.length - 1; i >= 0; i--) {
      const s = parts[i].trim().replace(/,/g, '')
      if (/^\d+(\.\d{1,4})?$/.test(s)) {
        monto = s
        break
      }
    }

    if (!serie && !numero && !rucEmisor) continue

    const tipoNombre = TIPO_DOC[tipo] || tipo || 'Comprobante'
    rows.push({
      tipo,
      tipoNombre,
      serie,
      numero: String(numero),
      fecha,
      rucEmisor,
      razonSocial: razon,
      monto,
      estado: libro === 'rvie' ? 'PROPUESTA RVIE' : 'PROPUESTA RCE',
      ok: true,
      origen: libro === 'rvie' ? 'Propuesta RVIE (SIRE)' : 'Propuesta RCE (SIRE)',
      mensaje: 'Comprobante en propuesta SIRE',
      detalle: {
        Tipo: tipoNombre,
        'Serie-Número': `${serie}-${numero}`,
        Fecha: fecha || '—',
        'RUC Emisor': rucEmisor || '—',
        'Razón social': razon || '—',
        Monto: monto || '—',
        Origen: libro === 'rvie' ? 'Propuesta RVIE (SIRE)' : 'Propuesta RCE (SIRE)',
      },
    })
  }
  return rows
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
