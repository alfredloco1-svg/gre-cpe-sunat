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

    // 3) Poll ticket + descarga (optimizado)
    // Manual: GET .../masivo/archivoreporte?nomArchivoReporte=&codTipoArchivoReporte=&codLibro=140000|080000
    console.log('SIRE ticket', numTicket)
    let archivoTexto = ''
    let ultimoEstado: unknown = null
    let nomArchivoReporte = ''
    let codTipoArchivoReporte = ''
    let codLibroDl = libro === 'rvie' ? '140000' : '080000'
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const t0 = Date.now()

    // JSZip se carga una sola vez (no en cada descarga)
    let jszipMod: { default: new () => {
      loadAsync: (b: Uint8Array) => Promise<{ files: Record<string, { dir?: boolean; async: (t: string) => Promise<string> }> }>
    } } | null = null
    async function getJSZip() {
      if (!jszipMod) jszipMod = await import('https://esm.sh/jszip@3.10.1')
      return jszipMod.default
    }

    async function extraerTextoDeZipOPlain(buf: Uint8Array): Promise<string> {
      if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
        try {
          const JSZip = await getJSZip()
          const zip = await JSZip.loadAsync(buf)
          const names = Object.keys(zip.files)
          const prefer =
            names.find((n) => /\.(txt|csv)$/i.test(n) && !zip.files[n].dir) ||
            names.find((n) => !zip.files[n].dir)
          if (prefer) return await zip.files[prefer].async('string')
        } catch (e) {
          console.log('SIRE unzip error', String(e))
        }
      }
      return new TextDecoder().decode(buf)
    }

    async function parseBody(buf: Uint8Array): Promise<string> {
      if (buf.length < 50) return ''
      const preview = new TextDecoder().decode(buf.slice(0, Math.min(buf.length, 120)))
      if (preview.trim().startsWith('{')) {
        if (preview.includes('"cod"') || preview.includes('"errors"')) return ''
        try {
          const dj = JSON.parse(new TextDecoder().decode(buf))
          const b64 = dj.archivo || dj.contenido || dj.file || dj.arcContent || dj.content
          if (typeof b64 === 'string' && b64.length > 50) {
            try {
              const bin = Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0))
              const txt = await extraerTextoDeZipOPlain(bin)
              if (txt && txt.length > 40) return txt
            } catch {
              if (b64.length > 40) return b64
            }
          }
        } catch { /* binary */ }
      }
      return await extraerTextoDeZipOPlain(buf)
    }

    /** Descarga: API actual exige perTributario + numTicket + codProceso (manual v30 / comunidad). */
    async function intentarDescarga(nombreRaw: string, codTipo: string, codLibro: string) {
      const base =
        `${baseSire}/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte`
      const baseConsulta =
        `${baseSire}/v1/contribuyente/migeigv/libros/rvierce/gestionconsultas/web/registrolibro/archivoreporte`
      const nom = nombreRaw
      const nomSin = nombreRaw.replace(/\.zip$/i, '')
      const n = encodeURIComponent(nom)
      const nSin = encodeURIComponent(nomSin)
      const L = codLibro || (libro === 'rvie' ? '140000' : '080000')
      const ticketQ = encodeURIComponent(numTicket)
      // codProceso=10 reportado en comunidad para propuesta; otros = variantes export
      const procesos = libro === 'rvie' ? ['10', '27', '1', '28'] : ['10', '1', '61']
      const tipos = [codTipo || '00', '00', '01'].filter((v, i, a) => a.indexOf(v) === i)

      const urls: string[] = []
      // 1) Formato que funciona en 2024–2026 (extra params)
      for (const proc of procesos) {
        for (const t of tipos) {
          urls.push(
            `${base}?nomArchivoReporte=${n}&codTipoArchivoReporte=${t}&codLibro=${L}&perTributario=${periodo}&codProceso=${proc}&numTicket=${ticketQ}`,
          )
          urls.push(
            `${base}?nomArchivoReporte=${nSin}&codTipoArchivoReporte=${t}&codLibro=${L}&perTributario=${periodo}&codProceso=${proc}&numTicket=${ticketQ}`,
          )
        }
      }
      // 2) Manual clásico (3 params)
      for (const t of tipos) {
        urls.push(`${base}?nomArchivoReporte=${n}&codTipoArchivoReporte=${t}&codLibro=${L}`)
      }
      // 3) Endpoint consultas (nombres LE...)
      for (const t of tipos) {
        urls.push(`${baseConsulta}?nomArchivo=${n}&codTipoArchivoReporte=${t}&codOrigen=1`)
        urls.push(`${baseConsulta}?nomArchivo=${n}&codTipoArchivoReporte=${t}&codOrigen=2`)
      }

      const unique = [...new Set(urls)]
      const authHeaders = {
        Authorization: `Bearer ${accessToken}`,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/json',
      }

      // Lotes de 4 en paralelo
      for (let i = 0; i < unique.length; i += 4) {
        const batch = unique.slice(i, i + 4)
        const tasks = batch.map(async (dlUrl) => {
          const qs = dlUrl.slice(dlUrl.indexOf('?'))
          const dr = await fetch(dlUrl, { method: 'GET', headers: authHeaders, redirect: 'follow' })
          const buf = new Uint8Array(await dr.arrayBuffer())
          console.log('SIRE dl', dr.status, buf.length, qs.slice(0, 120))
          if (dr.status >= 400 || buf.length < 50) throw new Error('empty')
          const txt = await parseBody(buf)
          if (!txt || txt.length < 40) throw new Error('parse')
          return txt
        })
        try {
          return await Promise.any(tasks)
        } catch {
          /* siguiente lote */
        }
      }
      return ''
    }

    function extraerMetaDeEstado(stData: Record<string, unknown>) {
      let codEst = ''
      let desEst = ''

      const arrRep = stData.archivoReporte as
        | { nomArchivoReporte?: string; codTipoArchivoReporte?: string | number }[]
        | undefined
      if (Array.isArray(arrRep) && arrRep.length) {
        if (arrRep[0].nomArchivoReporte) nomArchivoReporte = String(arrRep[0].nomArchivoReporte)
        if (arrRep[0].codTipoArchivoReporte != null && String(arrRep[0].codTipoArchivoReporte) !== '') {
          codTipoArchivoReporte = String(arrRep[0].codTipoArchivoReporte)
        }
      }

      const registros = (stData.registros || []) as Record<string, unknown>[]
      if (Array.isArray(registros) && registros.length) {
        const reg =
          registros.find((r) => String(r.numTicket || '') === numTicket) || registros[0]
        codEst = String(reg.codEstadoProceso || '')
        desEst = String(reg.desEstadoProceso || '')
        if (reg.codLibro) codLibroDl = String(reg.codLibro)
        if (reg.nomArchivoReporte) nomArchivoReporte = String(reg.nomArchivoReporte)
        if (reg.codTipoArchivoReporte != null && String(reg.codTipoArchivoReporte) !== '') {
          codTipoArchivoReporte = String(reg.codTipoArchivoReporte)
        }
        const ar = reg.archivoReporte as
          | { nomArchivoReporte?: string; codTipoArchivoReporte?: string | number }[]
          | { nomArchivoReporte?: string; codTipoArchivoReporte?: string | number }
          | undefined
        if (Array.isArray(ar) && ar[0]) {
          if (ar[0].nomArchivoReporte) nomArchivoReporte = String(ar[0].nomArchivoReporte)
          if (ar[0].codTipoArchivoReporte != null && String(ar[0].codTipoArchivoReporte) !== '') {
            codTipoArchivoReporte = String(ar[0].codTipoArchivoReporte)
          }
        } else if (ar && typeof ar === 'object' && ar.nomArchivoReporte) {
          nomArchivoReporte = String(ar.nomArchivoReporte)
          if (ar.codTipoArchivoReporte != null && String(ar.codTipoArchivoReporte) !== '') {
            codTipoArchivoReporte = String(ar.codTipoArchivoReporte)
          }
        }
      }

      const det = (stData.detalleTicket || stData.detalle || {}) as Record<string, unknown>
      if (det.nomArchivoReporte) nomArchivoReporte = String(det.nomArchivoReporte)

      return { codEst, desEst }
    }

    // Poll adaptativo: 2s → 3s → 4s… (máx ~12 intentos ≈ 40–50 s)
    const maxAttempts = 12
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await sleep(Math.min(2000 + i * 1000, 5000))
      console.log('SIRE poll', i + 1, '/', maxAttempts, `${Date.now() - t0}ms`)

      // Una sola consulta principal (la más específica); fallback solo si falla
      const consultaUrls = [
        `${baseSire}/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets?perIni=${periodo}&perFin=${periodo}&page=1&perPage=10&numTicket=${encodeURIComponent(numTicket)}`,
        `${baseSire}/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte/lista?perIni=${periodo}&perFin=${periodo}&page=1&perPage=10&numTicket=${encodeURIComponent(numTicket)}`,
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
          if (!stRes.ok) continue
          const stText = await stRes.text()
          let stData: Record<string, unknown>
          try {
            stData = JSON.parse(stText)
          } catch {
            continue
          }
          ultimoEstado = stData
          const { codEst, desEst } = extraerMetaDeEstado(stData)
          console.log('SIRE meta', nomArchivoReporte, codTipoArchivoReporte, codLibroDl, codEst, desEst)

          const listo =
            !!nomArchivoReporte &&
            (codEst === '06' ||
              codEst === '04' ||
              codEst === '03' ||
              !codEst ||
              /terminado|concluido|procesado|atendido/i.test(desEst))

          if (listo && nomArchivoReporte) {
            const txt = await intentarDescarga(
              nomArchivoReporte,
              codTipoArchivoReporte || '01',
              codLibroDl,
            )
            if (txt && txt.length > 50) {
              archivoTexto = txt
              break
            }
          }
        } catch (e) {
          console.log('SIRE consulta error', String(e))
        }
      }
      if (archivoTexto) break
    }

    if (!archivoTexto) {
      console.log('SIRE archivo no listo', {
        numTicket,
        nomArchivoReporte,
        codTipoArchivoReporte,
        codLibroDl,
        ms: Date.now() - t0,
      })
      return json(
        {
          ok: false,
          error:
            'Ticket generado pero el ZIP aún no se pudo descargar. ' +
            (nomArchivoReporte ? `Archivo: ${nomArchivoReporte}. ` : '') +
            'Espera 20–40 s y pulsa de nuevo. Ticket: ' +
            numTicket,
          ticket: numTicket,
          periodo,
          libro,
          archivo: nomArchivoReporte || null,
          codTipoArchivoReporte: codTipoArchivoReporte || null,
          codLibro: codLibroDl,
          estado: ultimoEstado,
        },
        200,
      )
    }
    console.log('SIRE archivo OK', archivoTexto.length, 'chars', `${Date.now() - t0}ms`)

    const items = parsePropuesta(archivoTexto, libro)

    return json({
      ok: true,
      periodo,
      libro,
      ticket: numTicket,
      total: items.length,
      items,
      archivo: nomArchivoReporte || null,
      ms: Date.now() - t0,
    })
  } catch (e) {
    return json({ error: (e as Error).message || 'Error interno' }, 500)
  }
})

function parsePropuesta(texto: string, libro: string) {
  /**
   * RVIE (ventas) – columnas típicas del export LE:
   * 0 Ruc empresa | 1 Razón | 2 Periodo | 3 CAR | 4 Fecha | 5 Vcto
   * 6 Tipo CP | 7 Serie | 8 Nro | 9 NroFin | 10 TipoDoc | 11 NroDoc cliente
   * 12 Razón cliente | ... | 25 Total CP
   *
   * RCE (compras) – export propuesta suele traer:
   * 0 Ruc adquiriente | 1 Razón | 2 Periodo | 3 CAR | 4 Fecha | 5 Vcto
   * 6 Tipo CP | 7 Serie | 8 Nro | 9 ... | proveedor en cols 10–13 | totales más adelante
   * A veces el Nro viene con ceros o el CAR concentra tipo+serie+nro.
   */
  const lines = String(texto || '').split(/\r?\n/).filter((l) => l.trim())
  const rows: Record<string, unknown>[] = []
  const isHeader = (s: string) =>
    /^(Ruc|RUC|Per[ií]odo|Periodo|Tipo CP|CAR)/i.test(s) ||
    s.includes('Razon Social|') ||
    s.includes('Razón Social|')

  const isTipoCp = (p: string) => /^(0[0-9]|1[0-4]|2[0-9]|3[0-9]|4[0-2]|5[0-6]|8[78]|9[1-9])$/.test(p)
  const isFecha = (p: string) => /^\d{2}\/\d{2}\/\d{4}$/.test(p) || /^\d{4}-\d{2}-\d{2}$/.test(p)
  const isRuc = (p: string) => /^\d{11}$/.test(p)
  const isSerie = (p: string) => /^[A-Za-z0-9]{1,4}$/.test(p) && /[A-Za-z]/.test(p)
  const isNro = (p: string) => /^\d{1,20}$/.test(p) && Number(p) > 0

  for (const line of lines) {
    let t = line.trim().replace(/^\uFEFF/, '')
    if (!t || isHeader(t) || t.length < 12) continue
    const parts = t.includes('|') ? t.split('|') : t.split('\t')
    if (parts.length < 6) continue
    const g = (i: number) => (parts[i] ?? '').trim()

    let tipo = ''
    let serie = ''
    let numero = ''
    let fecha = ''
    let rucProveedor = ''
    let razon = ''
    let monto = ''
    let rucEmpresa = isRuc(g(0)) ? g(0) : ''

    // 1) Fecha + tipo + serie + número (posiciones fijas más comunes)
    if (isFecha(g(4))) {
      fecha = g(4)
      if (isTipoCp(g(6))) {
        tipo = g(6)
        serie = g(7).toUpperCase()
        numero = g(8).replace(/^0+/, '') || g(8)
      } else if (isTipoCp(g(5))) {
        tipo = g(5)
        serie = g(6).toUpperCase()
        numero = g(7).replace(/^0+/, '') || g(7)
      }
    }

    // 2) Si faltó tipo/serie/nro, escanear
    if (!tipo || !serie) {
      for (let i = 3; i < Math.min(parts.length, 15); i++) {
        if (isTipoCp(g(i)) && !tipo) {
          tipo = g(i)
          if (isSerie(g(i + 1)) || /^[A-Za-z0-9]{1,4}$/.test(g(i + 1))) {
            serie = g(i + 1).toUpperCase()
          }
          // número: col siguiente o la que tenga dígitos
          for (let j = i + 2; j <= i + 4 && j < parts.length; j++) {
            const cand = g(j).replace(/^0+/, '') || g(j)
            if (isNro(cand) || /^\d+$/.test(g(j))) {
              numero = cand
              break
            }
          }
          if (isFecha(g(i - 2))) fecha = fecha || g(i - 2)
          if (isFecha(g(i - 1))) fecha = fecha || g(i - 1)
          break
        }
      }
    }

    // 3) Número vacío: intentar extraer del CAR (col 3)
    // CAR típico ~27 chars: ruc(11)+tipo(2)+serie(4)+nro(8) u variantes
    if ((!numero || numero === '0') && g(3).length >= 20) {
      const car = g(3)
      // buscar bloque tipo(2)+serie(4)+nro al final
      const m = car.match(/(\d{2})([A-Za-z0-9]{4})(\d{1,10})$/)
      if (m) {
        if (!tipo) tipo = m[1]
        if (!serie) serie = m[2].toUpperCase()
        if (!numero) numero = String(Number(m[3]))
      } else {
        const m2 = car.match(/([A-Za-z0-9]{4})(\d{4,10})$/)
        if (m2) {
          if (!serie) serie = m2[1].toUpperCase()
          if (!numero) numero = String(Number(m2[2]))
        }
      }
    }

    // 4) Proveedor / cliente (RUC distinto al de la empresa)
    for (let i = 8; i < Math.min(parts.length, 20); i++) {
      if (isRuc(g(i)) && g(i) !== rucEmpresa) {
        rucProveedor = g(i)
        // razón social suele ser la siguiente col no numérica
        for (let j = i + 1; j <= i + 2 && j < parts.length; j++) {
          const s = g(j)
          if (s.length > 2 && !/^\d+(\.\d+)?$/.test(s) && !isTipoCp(s) && !isFecha(s)) {
            razon = s
            break
          }
        }
        break
      }
    }
    // a veces tipo doc (6) + ruc en col 11/12 sin pasar por isRuc en bucle anterior
    if (!rucProveedor) {
      for (let i = 9; i < Math.min(parts.length, 16); i++) {
        if (/^\d{8,11}$/.test(g(i)) && g(i) !== rucEmpresa) {
          rucProveedor = g(i)
          razon = g(i + 1) || razon
          break
        }
      }
    }

    // 5) Monto total: preferir col junto a PEN/USD, o Total CP
    for (let i = 14; i < Math.min(parts.length, 42); i++) {
      if (/^(PEN|USD|EUR)$/i.test(g(i))) {
        const prev = g(i - 1).replace(/,/g, '')
        if (/^\d+(\.\d{1,6})?$/.test(prev)) {
          monto = prev
          break
        }
      }
    }
    if (!monto) {
      // buscar el mayor decimal razonable en la zona de montos
      let best = ''
      for (let i = 12; i < Math.min(parts.length, 40); i++) {
        const s = g(i).replace(/,/g, '')
        if (/^\d+\.\d{1,6}$/.test(s) && Number(s) > Number(best || 0)) best = s
      }
      monto = best
    }
    if (!monto) {
      for (let i = parts.length - 1; i >= 12; i--) {
        const s = g(i).replace(/,/g, '')
        if (/^\d+(\.\d{1,6})?$/.test(s) && Number(s) > 0) {
          monto = s
          break
        }
      }
    }

    // 6) Fecha si aún falta
    if (!fecha) {
      for (let i = 0; i < Math.min(parts.length, 10); i++) {
        if (isFecha(g(i))) {
          fecha = g(i)
          break
        }
      }
    }

    numero = (numero || '').replace(/^0+(\d)/, '$1')
    monto = (monto || '').replace(/,/g, '')
    if (!/^\d+(\.\d+)?$/.test(monto)) monto = ''

    if (!tipo && !serie && !numero) continue
    if (/razon social|periodo|fecha de/i.test(serie + numero + razon)) continue

    // Compras: mostrar proveedor; Ventas: mostrar cliente
    const rucMostrar = rucProveedor || (libro === 'rvie' ? '' : rucEmpresa) || rucEmpresa || ''
    const tipoNombre = TIPO_DOC[tipo] || tipo || 'Comprobante'
    const serieNum = serie && numero ? `${serie}-${numero}` : serie || numero || '—'

    const esVenta = libro === 'rvie'
    const labelRuc = esVenta ? 'RUC Receptor' : 'RUC Emisor'
    const labelRazon = esVenta ? 'Receptor (cliente)' : 'Emisor (proveedor)'
    rows.push({
      libro,
      tipo,
      tipoNombre,
      serie,
      numero: String(numero || ''),
      fecha,
      // Contraparte: en ventas = cliente (receptor); en compras = proveedor (emisor del CP)
      rucEmisor: rucMostrar,
      rucContraparte: rucMostrar,
      razonSocial: razon,
      monto,
      estado: esVenta ? 'PROPUESTA RVIE' : 'PROPUESTA RCE',
      ok: true,
      origen: esVenta ? 'Propuesta RVIE (SIRE)' : 'Propuesta RCE (SIRE)',
      mensaje: 'Comprobante en propuesta SIRE',
      detalle: {
        Tipo: tipoNombre,
        'Serie-Número': serieNum,
        Fecha: fecha || '—',
        [labelRuc]: rucMostrar || '—',
        [labelRazon]: razon || '—',
        Monto: monto || '—',
        Libro: esVenta ? 'Ventas (emitidos)' : 'Compras (recibidos)',
        Origen: esVenta ? 'Propuesta RVIE (SIRE)' : 'Propuesta RCE (SIRE)',
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
