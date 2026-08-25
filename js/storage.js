// Capa unificada: Supabase (si hay sesión) o LocalStorage (demo/offline)
const Storage = {
  KEY_EMPRESAS: 'gre_empresas',
  KEY_ACTIVA: 'gre_empresa_activa',
  KEY_TOKEN: 'gre_token',

  async useCloud() {
    if (!window.USE_SUPABASE || !window.DB) return false;
    try {
      const user = await DB.getUser();
      return !!user;
    } catch {
      return false;
    }
  },

  // ----- Empresas -----
  async getEmpresas() {
    if (await this.useCloud()) return DB.listEmpresas();
    try { return JSON.parse(localStorage.getItem(this.KEY_EMPRESAS) || '[]'); }
    catch { return []; }
  },

  async saveEmpresa(emp) {
    if (await this.useCloud()) return DB.saveEmpresa(emp);
    let list = JSON.parse(localStorage.getItem(this.KEY_EMPRESAS) || '[]');
    if (emp.id) {
      const i = list.findIndex(x => x.id === emp.id);
      if (i >= 0) list[i] = emp; else list.push(emp);
    } else {
      emp.id = 'e' + Date.now().toString(36);
      list.push(emp);
    }
    localStorage.setItem(this.KEY_EMPRESAS, JSON.stringify(list));
    return emp;
  },

  async deleteEmpresa(id) {
    if (await this.useCloud()) return DB.deleteEmpresa(id);
    let list = JSON.parse(localStorage.getItem(this.KEY_EMPRESAS) || '[]').filter(x => x.id !== id);
    localStorage.setItem(this.KEY_EMPRESAS, JSON.stringify(list));
    if (localStorage.getItem(this.KEY_ACTIVA) === id) {
      localStorage.removeItem(this.KEY_ACTIVA);
      localStorage.removeItem(this.KEY_TOKEN);
    }
  },

  async setActiva(id) {
    if (await this.useCloud()) {
      await DB.setActiva(id);
      return;
    }
    localStorage.setItem(this.KEY_ACTIVA, id);
    // marcar en lista
    let list = JSON.parse(localStorage.getItem(this.KEY_EMPRESAS) || '[]');
    list = list.map(e => ({ ...e, activa: e.id === id }));
    localStorage.setItem(this.KEY_EMPRESAS, JSON.stringify(list));
    localStorage.removeItem(this.KEY_TOKEN);
  },

  async getActiva() {
    if (await this.useCloud()) return DB.getActiva();
    const list = JSON.parse(localStorage.getItem(this.KEY_EMPRESAS) || '[]');
    const id = localStorage.getItem(this.KEY_ACTIVA);
    if (id) return list.find(e => e.id === id) || null;
    return list.find(e => e.activa) || null;
  },

  // ----- Token -----
  async getToken() {
    const emp = await this.getActiva();
    if (!emp) return null;
    if (await this.useCloud()) return DB.getToken(emp.id);
    try {
      const t = JSON.parse(localStorage.getItem(this.KEY_TOKEN) || 'null');
      if (t && t.empresa_id && t.empresa_id !== emp.id) return null;
      return t;
    } catch { return null; }
  },

  async setToken(obj) {
    const emp = await this.getActiva();
    if (!emp) throw new Error('Sin empresa activa');
    if (await this.useCloud()) {
      await DB.saveToken(emp.id, obj);
      return;
    }
    obj.empresa_id = emp.id;
    localStorage.setItem(this.KEY_TOKEN, JSON.stringify(obj));
  },

  async clearToken() {
    const emp = await this.getActiva();
    if (await this.useCloud() && emp) {
      await DB.clearToken(emp.id);
      return;
    }
    localStorage.removeItem(this.KEY_TOKEN);
  }
};
