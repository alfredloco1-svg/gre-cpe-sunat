// Cliente Supabase + capa de datos (empresas / tokens)
// Requiere: @supabase/supabase-js (CDN) y config.js

let supabase = null;

function initSupabase() {
  if (!window.USE_SUPABASE) return null;
  if (!window.SUPABASE_URL || window.SUPABASE_URL.includes('TU_PROJECT')) {
    console.warn('Configura SUPABASE_URL y SUPABASE_ANON_KEY en js/config.js');
    return null;
  }
  if (!window.supabase) {
    console.error('Falta el script CDN de @supabase/supabase-js');
    return null;
  }
  supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  return supabase;
}

const DB = {
  client() {
    if (!supabase) initSupabase();
    return supabase;
  },

  async getSession() {
    const c = this.client();
    if (!c) return null;
    const { data } = await c.auth.getSession();
    return data.session;
  },

  async getUser() {
    const session = await this.getSession();
    return session?.user || null;
  },

  async signIn(email, password) {
    const c = this.client();
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async signUp(email, password) {
    const c = this.client();
    const { data, error } = await c.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  },

  async signOut() {
    const c = this.client();
    if (c) await c.auth.signOut();
  },

  async signInWithGoogle() {
    const c = this.client();
    if (!c) throw new Error('Supabase no configurado');
    const redirectTo = window.location.origin + window.location.pathname;
    const { data, error } = await c.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        queryParams: { access_type: 'offline', prompt: 'consent' }
      }
    });
    if (error) throw error;
    return data;
  },

  // ---------- EMPRESAS ----------
  async listEmpresas() {
    const c = this.client();
    const { data, error } = await c
      .from('empresas')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map(mapEmpresaFromDb);
  },

  async saveEmpresa(emp) {
    const c = this.client();
    const user = await this.getUser();
    if (!user) throw new Error('Debes iniciar sesión');

    const isUpdate = emp.id && !String(emp.id).startsWith('e');

    // Seguridad: en edición, secretos vacíos = NO sobrescribir (mantener valor en BD)
    const row = {
      user_id: user.id,
      ruc: emp.ruc,
      nombre: emp.nombre,
      usuario_sol: emp.usuario,
      client_id: emp.clientId || '',
      ambiente: emp.ambiente || 'PRODUCCION',
      ruta_descarga: emp.ruta || 'C:\\GRE\\',
      activa: !!emp.activa
    };

    if (emp.clave) row.clave_sol = emp.clave;
    if (emp.clientSecret) row.client_secret = emp.clientSecret;

    if (!isUpdate) {
      row.clave_sol = emp.clave || '';
      row.client_secret = emp.clientSecret || '';
    }

    if (isUpdate) {
      const { data, error } = await c
        .from('empresas')
        .update(row)
        .eq('id', emp.id)
        .select()
        .single();
      if (error) throw error;
      return mapEmpresaFromDb(data);
    } else {
      const { data, error } = await c
        .from('empresas')
        .insert(row)
        .select()
        .single();
      if (error) throw error;
      return mapEmpresaFromDb(data);
    }
  },

  async deleteEmpresa(id) {
    const c = this.client();
    const { error } = await c.from('empresas').delete().eq('id', id);
    if (error) throw error;
  },

  async setActiva(id) {
    const c = this.client();
    // trigger se encarga de desactivar las demás
    const { error } = await c
      .from('empresas')
      .update({ activa: true })
      .eq('id', id);
    if (error) throw error;
  },

  async getActiva() {
    const list = await this.listEmpresas();
    return list.find(e => e.activa) || null;
  },

  // ---------- TOKENS ----------
  async getToken(empresaId) {
    const c = this.client();
    const { data, error } = await c
      .from('tokens')
      .select('*')
      .eq('empresa_id', empresaId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      access_token: data.access_token,
      expires_at: new Date(data.expires_at).getTime(),
      updated_at: new Date(data.updated_at).getTime(),
      empresa_id: data.empresa_id
    };
  },

  async saveToken(empresaId, tokenObj) {
    const c = this.client();
    const user = await this.getUser();
    if (!user) throw new Error('Debes iniciar sesión');

    const row = {
      user_id: user.id,
      empresa_id: empresaId,
      access_token: tokenObj.access_token,
      expires_at: new Date(tokenObj.expires_at).toISOString(),
      updated_at: new Date().toISOString()
    };

    const { error } = await c
      .from('tokens')
      .upsert(row, { onConflict: 'empresa_id' });
    if (error) throw error;
  },

  async clearToken(empresaId) {
    const c = this.client();
    await c.from('tokens').delete().eq('empresa_id', empresaId);
  }
};

function mapEmpresaFromDb(row) {
  return {
    id: row.id,
    ruc: row.ruc,
    nombre: row.nombre,
    usuario: row.usuario_sol,
    clave: row.clave_sol,
    clientId: row.client_id || '',
    clientSecret: row.client_secret || '',
    ambiente: row.ambiente || 'PRODUCCION',
    ruta: row.ruta_descarga || 'C:\\GRE\\',
    activa: !!row.activa
  };
}

window.DB = DB;
window.initSupabase = initSupabase;
