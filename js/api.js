// APIs externas: openruc + SUNAT OAuth + consulta CPE
const API = {
  TIPO_DOC: {
    '01': 'Factura',
    '03': 'Boleta',
    '07': 'Nota de crédito',
    '08': 'Nota de débito',
    '09': 'GRE Remitente',
    '31': 'GRE Transportista'
  },

  async consultarRuc(ruc) {
    const url = `https://openruc.com/api/ruc/${ruc}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('No se pudo consultar el RUC');
    const data = await res.json();
    return {
      ruc: data.ruc || ruc,
      razonSocial: data.razon_social || data.razonSocial || data.nombre_o_razon_social || '',
      estado: data.estado || '',
      condicion: data.condicion || '',
      direccion: data.direccion || ''
    };
  },

  /**
   * Token para emisión GRE/CPE (password grant · clientessol)
   */
  async obtenerToken(empresa) {
    if (window.USE_SUPABASE && window.DB && empresa.id && !String(empresa.id).startsWith('e')) {
      try {
        const c = DB.client();
        if (c) {
          const { data, error } = await c.functions.invoke('obtener-token', {
            body: { empresa_id: empresa.id }
          });
          if (!error && data && data.access_token) {
            return {
              access_token: data.access_token,
              expires_at: data.expires_at
                ? new Date(data.expires_at).getTime()
                : Date.now() + (Number(data.expires_in) || 3600) * 1000,
              updated_at: Date.now()
            };
          }
        }
      } catch (_) { /* fallback */ }
    }

    const { ruc, usuario, clave, clientId, clientSecret, ambiente } = empresa;
    if (!ruc || !usuario || !clave || !clientId || !clientSecret) {
      throw new Error('Faltan credenciales (RUC, Usuario SOL, Clave, Client ID o Secret).');
    }
    const base = ambiente === 'PRUEBA'
      ? 'https://api-seguridad-test.sunat.gob.pe'
      : 'https://api-seguridad.sunat.gob.pe';
    const url = `${base}/v1/clientessol/${encodeURIComponent(clientId)}/oauth2/token/`;

    const body = new URLSearchParams({
      grant_type: 'password',
      scope: 'https://api-cpe.sunat.gob.pe',
      client_id: clientId,
      client_secret: clientSecret,
      username: ruc + usuario,
      password: clave
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${data.error_description || data.error || text.slice(0, 200)}`);
    }
    if (!data.access_token) throw new Error('No se recibió access_token');

    const expiresIn = Number(data.expires_in) || 3600;
    return {
      access_token: data.access_token,
      expires_at: Date.now() + expiresIn * 1000,
      updated_at: Date.now()
    };
  },

  /**
   * Token para consulta de validez de comprobantes (client_credentials · extranet)
   * Requiere credenciales de API con alcance de consulta en SOL.
   */
  async obtenerTokenConsulta(empresa) {
    const { clientId, clientSecret, ambiente } = empresa;
    if (!clientId || !clientSecret) {
      throw new Error('Faltan Client ID / Client Secret para consulta CPE');
    }
    const base = ambiente === 'PRUEBA'
      ? 'https://api-seguridad-test.sunat.gob.pe'
      : 'https://api-seguridad.sunat.gob.pe';
    const url = `${base}/v1/clientesextranet/${encodeURIComponent(clientId)}/oauth2/token/`;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes',
      client_id: clientId,
      client_secret: clientSecret
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      throw new Error(
        `Token consulta HTTP ${res.status}: ${data.error_description || data.error || text.slice(0, 180)}. ` +
        'En SOL crea/activa credenciales con alcance de consulta de comprobantes.'
      );
    }
    if (!data.access_token) throw new Error('No se recibió token de consulta');

    return {
      access_token: data.access_token,
      expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      updated_at: Date.now()
    };
  },

  _fmtFechaSunat(fecha) {
    if (!fecha) return '';
    // YYYY-MM-DD → DD/MM/YYYY
    if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      const [y, m, d] = fecha.split('-');
      return `${d}/${m}/${y}`;
    }
    return fecha;
  },

  /**
   * Consulta oficial de validez de CPE (factura, boleta, NC, ND)
   * API: POST .../contribuyentes/{rucConsultante}/validarcomprobante
   */
  async validarCpe({ empresa, accessToken, tipo, rucEmisor, serie, numero, fecha, monto }) {
    const rucConsultante = (empresa && empresa.ruc) || rucEmisor;
    if (!accessToken) throw new Error('Sin token de consulta');
    if (!rucEmisor || !serie || !numero) throw new Error('RUC emisor, serie y número son obligatorios');

    const base = empresa?.ambiente === 'PRUEBA'
      ? 'https://api-cpe-test.sunat.gob.pe'
      : 'https://api.sunat.gob.pe';

    // Endpoint oficial de consulta integrada
    const url = `${base}/v1/contribuyente/contribuyentes/${encodeURIComponent(rucConsultante)}/validarcomprobante`;

    const payload = {
      numRuc: String(rucEmisor).trim(),
      codComp: String(tipo).padStart(2, '0'),
      numeroSerie: String(serie).trim().toUpperCase(),
      numero: String(parseInt(String(numero).replace(/\D/g, ''), 10) || numero),
      fechaEmision: this._fmtFechaSunat(fecha),
      monto: monto !== undefined && monto !== '' ? String(Number(monto).toFixed(2)) : '0.00'
    };

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      throw new Error(
        'No se pudo conectar con SUNAT (posible bloqueo CORS desde el navegador). ' +
        'Usa un servidor/Edge Function o extensión que permita la llamada. Detalle: ' + (e.message || e)
      );
    }

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const estadoCp = data.estadoCp || data.data?.estadoCp || data.success || null;
    const estadoRuc = data.estadoRuc || data.data?.estadoRuc || '';
    const condDomi = data.condDomiRuc || data.data?.condDomiRuc || '';
    const observaciones = data.observaciones || data.data?.observaciones || [];

    // Códigos típicos estadoCp: 0 no existe, 1 aceptado, 2 anulado, 3 autenticado, etc.
    const mapEstado = {
      '0': 'NO EXISTE',
      '1': 'ACEPTADO',
      '2': 'ANULADO',
      '3': 'AUTENTICADO',
      '4': 'NO AUTORIZADO',
      true: 'OK',
      false: 'RECHAZADO'
    };
    const estadoTxt = mapEstado[String(estadoCp)] || (res.ok ? 'CONSULTADO' : 'ERROR');

    if (!res.ok && !data.estadoCp && data.estadoCp !== 0) {
      throw new Error(`SUNAT HTTP ${res.status}: ${data.message || data.error || text.slice(0, 200)}`);
    }

    return {
      ok: res.ok || estadoCp === '1' || estadoCp === 1,
      tipo,
      tipoNombre: this.TIPO_DOC[tipo] || tipo,
      rucEmisor,
      serie: payload.numeroSerie,
      numero: payload.numero,
      fecha: fecha || '',
      monto: payload.monto,
      estado: estadoTxt,
      estadoCodigo: estadoCp,
      estadoRuc,
      condicionDomicilio: condDomi,
      observaciones: Array.isArray(observaciones) ? observaciones : [],
      mensaje: estadoTxt === 'ACEPTADO'
        ? 'Comprobante encontrado y aceptado en SUNAT.'
        : `Resultado SUNAT: ${estadoTxt}`,
      detalle: {
        'Tipo': this.TIPO_DOC[tipo] || tipo,
        'RUC Emisor': rucEmisor,
        'Serie-Número': `${payload.numeroSerie}-${payload.numero}`,
        'Fecha emisión': payload.fechaEmision || '—',
        'Monto consultado': payload.monto,
        'Estado comprobante': estadoTxt,
        'Estado RUC': estadoRuc || '—',
        'Condición domicilio': condDomi || '—',
        'Observaciones': (Array.isArray(observaciones) && observaciones.length)
          ? observaciones.join('; ')
          : '—'
      },
      raw: data
    };
  },

  /**
   * Validación en lote (secuencial, con pausa corta para no saturar)
   */
  async validarCpeLote({ empresa, accessToken, items, onProgress }) {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        const r = await this.validarCpe({
          empresa,
          accessToken,
          tipo: it.tipo,
          rucEmisor: it.rucEmisor,
          serie: it.serie,
          numero: it.numero,
          fecha: it.fecha,
          monto: it.monto
        });
        results.push({ ...r, error: null });
      } catch (ex) {
        results.push({
          ok: false,
          tipo: it.tipo,
          tipoNombre: this.TIPO_DOC[it.tipo] || it.tipo,
          rucEmisor: it.rucEmisor,
          serie: it.serie,
          numero: String(it.numero),
          fecha: it.fecha || '',
          monto: it.monto || '',
          estado: 'ERROR',
          mensaje: ex.message || String(ex),
          error: ex.message || String(ex),
          detalle: {}
        });
      }
      if (onProgress) onProgress(i + 1, items.length, results[results.length - 1]);
      // pausa breve entre llamadas
      if (i < items.length - 1) await new Promise(r => setTimeout(r, 350));
    }
    return results;
  },

  /** Alias usado por el visor */
  async consultarComprobante(opts) {
    const empresa = opts.empresa || await (window.Storage && Storage.getActiva());
    if (!empresa) throw new Error('Activa una empresa primero');

    let tokenObj = null;
    try {
      tokenObj = await this.obtenerTokenConsulta(empresa);
    } catch (e1) {
      // Intento con token de emisión guardado (puede no servir para consulta)
      const stored = window.Storage ? await Storage.getToken() : null;
      if (stored && stored.access_token && stored.expires_at > Date.now()) {
        tokenObj = stored;
      } else {
        throw e1;
      }
    }

    return this.validarCpe({
      empresa,
      accessToken: tokenObj.access_token,
      tipo: opts.tipo,
      rucEmisor: opts.ruc,
      serie: opts.serie,
      numero: opts.numero,
      fecha: opts.fecha,
      monto: opts.monto
    });
  },

  /** Genera CSV para “descargar” resultados del lote */
  resultadosACsv(rows) {
    const headers = ['Tipo', 'RUC Emisor', 'Serie', 'Numero', 'Fecha', 'Monto', 'Estado', 'Mensaje'];
    const lines = [headers.join(',')];
    for (const r of rows) {
      const cells = [
        r.tipoNombre || r.tipo,
        r.rucEmisor,
        r.serie,
        r.numero,
        r.fecha,
        r.monto,
        r.estado,
        (r.mensaje || r.error || '').replace(/"/g, '""')
      ].map(v => `"${v == null ? '' : v}"`);
      lines.push(cells.join(','));
    }
    return lines.join('\n');
  },

  descargarTexto(filename, content, mime = 'text/csv;charset=utf-8') {
    const blob = new Blob(['\ufeff' + content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
};

window.API = API;
