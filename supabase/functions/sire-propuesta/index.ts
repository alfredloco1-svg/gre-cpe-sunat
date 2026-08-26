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

    // 3) Poll ticket + descarga (endpoints oficiales SIRE)
    console.log('SIRE ticket', numTicket)
    let archivoTexto = ''
    let ultimoEstado: unknown = null
    let nomArchivoReporte = ''
    let codTipoArchivoReporte = '1'
    let codLibroDl = libro === 'rvie' ? '140000' : '080000'
    const maxAttempts = 10
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    async function intentarDescarga(nombre: string, tipoArch: string, libroCod: string) {
      const dlUrl =
        `${baseSire}/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte` +
        `?nomArchivoReporte=${encodeURIComponent(nombre)}` +
        `&codTipoArchivoReporte=${encodeURIComponent(tipoArch)}` +
        `&codLibro=${encodeURIComponent(libroCod)}`
      console.log('SIRE descargando', nombre, 'libro', libroCod, 'tipo', tipoArch)
      const dr = await fetch(dlUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json, application/zip, application/octet-stream, text/plain, */*',
        },
      })
      const buf = new Uint8Array(await dr.arrayBuffer())
      console.log('SIRE download status', dr.status, 'bytes', buf.length)
      if (!dr.ok || buf.length < 20) return ''

      // ¿JSON con base64?
      const asText = new TextDecoder().decode(buf.slice(0, Math.min(buf.length, 200)))
      if (asText.trim().startsWith('{')) {
        try {
          const dj = JSON.parse(new TextDecoder().decode(buf))
          const b64 = dj.archivo || dj.contenido || dj.file || dj.arcContent
          if (typeof b64 === 'string' && b64.length > 50) {
            try {
              const bin = Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0))
              return await extraerTextoDeZipOPlain(bin)
            } catch {
              return b64
            }
          }
        } catch { /* fallthrough */ }
      }
      return await extraerTextoDeZipOPlain(buf)
    }

    async function extraerTextoDeZipOPlain(buf: Uint8Array): Promise<string> {
      // ZIP magic PK
      if (buf[0] === 0x50 && buf[1] === 0x4b) {
        try {
          // Usar JSZip vía esm.sh
          const JSZip = (await import('https://esm.sh/jszip@3.10.1')).default
          const zip = await JSZip.loadAsync(buf)
          const names = Object.keys(zip.files)
          console.log('SIRE zip files', names)
          // Preferir .txt / .csv
          const prefer = names.find((n) => /\.(txt|csv)$/i.test(n)) || names[0]
          if (prefer && !zip.files[prefer].dir) {
            return await zip.files[prefer].async('string')
          }
        } catch (e) {
          console.log('SIRE unzip error', String(e))
        }
      }
      return new TextDecoder().decode(buf)
    }

    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await sleep(4000)
      console.log('SIRE poll', i + 1, '/', maxAttempts)

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
          console.log('SIRE consulta status', stRes.status, stText.slice(0, 220))
          let stData: Record<string, unknown> = {}
          try {
            stData = JSON.parse(stText)
          } catch {
            continue
          }
          ultimoEstado = stData

          // Nombre de archivo: array archivoReporte[] (respuesta típica)
          const arrRep = stData.archivoReporte as { nomArchivoReporte?: string; codTipoArchivoReporte?: string | number }[] | undefined
          if (Array.isArray(arrRep) && arrRep.length && arrRep[0].nomArchivoReporte) {
            nomArchivoReporte = String(arrRep[0].nomArchivoReporte)
            if (arrRep[0].codTipoArchivoReporte != null) {
              codTipoArchivoReporte = String(arrRep[0].codTipoArchivoReporte)
            }
            console.log('SIRE nomArchivo desde archivoReporte', nomArchivoReporte)
          }

          // Estado en registros[]
          const registros = (stData.registros || []) as Record<string, unknown>[]
          let codEst = ''
          let desEst = ''
          if (Array.isArray(registros) && registros.length) {
            const reg = registros.find((r) => String(r.numTicket || '') === numTicket) || registros[0]
            codEst = String(reg.codEstadoProceso || '')
            desEst = String(reg.desEstadoProceso || '')
            if (reg.codLibro) codLibroDl = String(reg.codLibro)
            // a veces el nombre viene dentro del registro
            const ar = reg.archivoReporte as { nomArchivoReporte?: string }[] | { nomArchivoReporte?: string } | undefined
            if (Array.isArray(ar) && ar[0]?.nomArchivoReporte) {
              nomArchivoReporte = String(ar[0].nomArchivoReporte)
            } else if (ar && typeof ar === 'object' && 'nomArchivoReporte' in ar && ar.nomArchivoReporte) {
              nomArchivoReporte = String(ar.nomArchivoReporte)
            }
            if (reg.nomArchivoReporte) nomArchivoReporte = String(reg.nomArchivoReporte)
            console.log('SIRE estado ticket', codEst, desEst)
          }

          // Si hay nombre de archivo (y/o estado terminado), descargar
          const listo = nomArchivoReporte && (codEst === '06' || codEst === '04' || !codEst || /terminado|concluido/i.test(desEst))
          if (listo && nomArchivoReporte) {
            // Probar varios codLibro por si el default no coincide
            const librosTry = [codLibroDl, '080000', '140000', '1', '']
            for (const lb of librosTry) {
              if (lb === '' && librosTry.indexOf(lb) > 0) continue
              const txt = await intentarDescarga(nomArchivoReporte, codTipoArchivoReporte, lb || '080000')
              if (txt && txt.length > 50) {
                archivoTexto = txt
                break
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
          'Ticket listo pero no se pudo descargar el ZIP de la propuesta. ' +
          (nomArchivoReporte ? `Archivo: ${nomArchivoReporte}. ` : '') +
          'Pulsa de nuevo en 30 s. Ticket: ' + numTicket,
        ticket: numTicket,
        periodo,
        libro,
        archivo: nomArchivoReporte || null,
        estado: ultimoEstado,
      }, 200)
    }
    console.log('SIRE archivo OK, chars', archivoTexto.length)

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
