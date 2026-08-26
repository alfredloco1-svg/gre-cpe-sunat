// APIs externas: openruc + SUNAT OAuth
const API = {
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
   * Genera token SUNAT.
   * Preferencia: Edge Function (credenciales no salen del servidor).
   * Fallback: llamada directa desde el navegador (menos seguro).
   */
  async obtenerToken(empresa) {
    // 1) Intentar Edge Function (recomendado)
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
          // Si la function no está desplegada (404), cae al fallback
          if (error && !/404|not found|FunctionsRelayError/i.test(String(error.message || error))) {
            throw new Error(data?.error || error.message || 'Error en Edge Function');
          }
        }
      } catch (ex) {
        // Solo re-lanzar si no es "function missing"
        if (ex.message && !/404|not found|Failed to send|FunctionsHttpError/i.test(ex.message)) {
          // seguir a fallback solo si parece que no hay function
        }
      }
    }

    // 2) Fallback cliente (menos seguro: secretos viajan por el navegador)
    const { ruc, usuario, clave, clientId, clientSecret, ambiente } = empresa;
    if (!ruc || !usuario || !clave || !clientId || !clientSecret) {
      throw new Error('Faltan credenciales (RUC, Usuario SOL, Clave, Client ID o Secret). Si usas Edge Function, verifica que estén guardadas en Supabase.');
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

  // Placeholder: consulta individual de comprobante (se ampliará)
  async consultarComprobante({ tipo, ruc, serie, numero, fecha }) {
    // Por ahora devolvemos estructura de ejemplo / mock para la vista
    // En producción se conectará a APIs de consulta CPE / portal
    return {
      ok: true,
      tipo,
      rucEmisor: ruc,
      serie,
      numero,
      fecha: fecha || new Date().toISOString().slice(0, 10),
      estado: 'CONSULTA LOCAL (pendiente de API de consulta)',
      mensaje: 'La vista individual está lista. La consulta real a SUNAT se conectará en el siguiente paso (API consulta CPE / portal).',
      detalle: {
        'Tipo documento': tipo,
        'RUC Emisor': ruc,
        'Serie': serie,
        'Número': numero,
        'Fecha emisión': fecha || '—',
        'Estado': 'Pendiente de validación en línea'
      }
    };
  }
};
