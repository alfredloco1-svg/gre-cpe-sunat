// App principal GRE + CPE SUNAT Pro (Supabase + LocalStorage)
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const titles = {
    dashboard: 'Inicio',
    empresas: 'Empresas',
    token: 'Token SUNAT',
    gre: 'Guías de Remisión',
    cpe: 'Comprobantes CPE',
    visor: 'Visor / Verificar'
  };

  function navigate(view) {
    $$('.view').forEach(v => v.classList.add('hidden'));
    const el = $(`#view-${view}`);
    if (el) el.classList.remove('hidden');
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $('#pageTitle').textContent = titles[view] || view;
    $('#sidebar').classList.add('-translate-x-full');
    $('#overlay').classList.add('hidden');
    if (view === 'empresas') renderEmpresas();
    if (view === 'dashboard') renderDashboard();
    if (view === 'token') renderToken();
  }
  window.navigate = navigate;

  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.view)));
  $('#btnMenu')?.addEventListener('click', () => {
    $('#sidebar').classList.toggle('-translate-x-full');
    $('#overlay').classList.toggle('hidden');
  });
  $('#overlay')?.addEventListener('click', () => {
    $('#sidebar').classList.add('-translate-x-full');
    $('#overlay').classList.add('hidden');
  });

  function toast(msg, type = 'info') {
    const box = $('#toast');
    const div = document.createElement('div');
    div.className = type === 'ok' ? 'toast-ok' : type === 'err' ? 'toast-err' : 'toast-info';
    div.textContent = msg;
    box.innerHTML = '';
    box.appendChild(div);
    box.classList.remove('hidden');
    setTimeout(() => box.classList.add('hidden'), 3500);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ---------- Auth ----------
  // Login obligatorio antes de ver la app. Autorización solo en Supabase.

  function showApp() {
    document.body.classList.add('is-authenticated');
    $('#loginScreen')?.classList.add('hidden');
    $('#btnLogout')?.classList.remove('hidden');
  }

  function showLogin() {
    document.body.classList.remove('is-authenticated');
    $('#loginScreen')?.classList.remove('hidden');
    $('#btnLogout')?.classList.add('hidden');
  }

  async function checkAuth() {
    if (!window.USE_SUPABASE) {
      showApp();
      return true;
    }
    initSupabase();
    if (!window.SUPABASE_URL || window.SUPABASE_URL.includes('TU_PROJECT')) {
      window.USE_SUPABASE = false;
      showApp();
      toast('Configura js/config.js con tu proyecto Supabase (modo local activo)', 'info');
      return true;
    }
    const user = await DB.getUser();
    if (user) {
      showApp();
      return true;
    }
    showLogin();
    return false;
  }

  $('#formLogin')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim();
    const pass = $('#loginPassword').value;
    const err = $('#loginError');
    err.classList.add('hidden');
    try {
      await DB.signIn(email, pass);
      showApp();
      await boot();
      toast('Sesión iniciada', 'ok');
    } catch (ex) {
      err.textContent = ex.message || 'Error al iniciar sesión';
      err.classList.remove('hidden');
    }
  });

  $('#btnRegister')?.addEventListener('click', async () => {
    const email = $('#loginEmail').value.trim();
    const pass = $('#loginPassword').value;
    const err = $('#loginError');
    err.classList.add('hidden');
    if (!email || pass.length < 6) {
      err.textContent = 'Email y contraseña (mín. 6) requeridos';
      err.classList.remove('hidden');
      return;
    }
    try {
      await DB.signUp(email, pass);
      err.textContent = 'Cuenta creada. Revisa tu email si pide confirmación, o inicia sesión.';
      err.classList.remove('hidden');
      err.classList.remove('text-red-600');
      err.classList.add('text-emerald-600');
    } catch (ex) {
      err.textContent = ex.message || 'Error al registrar';
      err.classList.remove('hidden');
      err.classList.add('text-red-600');
    }
  });

  $('#btnGoogle')?.addEventListener('click', async () => {
    const err = $('#loginError');
    err.classList.add('hidden');
    try {
      await DB.signInWithGoogle();
      // Redirige a Google; al volver, checkAuth carga la sesión
    } catch (ex) {
      err.textContent = ex.message || 'Error con Google';
      err.classList.remove('hidden');
      err.classList.add('text-red-600');
    }
  });

  $('#btnLogout')?.addEventListener('click', async () => {
    await DB.signOut();
    location.reload();
  });

  // ---------- Empresas ----------
  async function renderEmpresas(filtro = '') {
    const list = await Storage.getEmpresas();
    const activa = await Storage.getActiva();
    const tbody = $('#tablaEmpresas');
    const empty = $('#emptyEmpresas');
    const q = (filtro || '').trim().toLowerCase();
    const filtered = list.filter(e =>
      !q || (e.nombre || '').toLowerCase().includes(q) || (e.ruc || '').includes(q)
    );

    tbody.innerHTML = '';
    if (!filtered.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    filtered.forEach(e => {
      const isActiva = activa && activa.id === e.id;
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50';
      tr.innerHTML = `
        <td class="px-4 py-3">
          <button data-activar="${e.id}" class="text-xs px-2 py-1 rounded-full ${isActiva ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">
            ${isActiva ? '★ Activa' : 'Activar'}
          </button>
        </td>
        <td class="px-4 py-3 font-medium">${escapeHtml(e.nombre)}</td>
        <td class="px-4 py-3 font-mono text-xs">${escapeHtml(e.ruc)}</td>
        <td class="px-4 py-3 text-xs">${escapeHtml(e.ambiente || 'PRODUCCION')}</td>
        <td class="px-4 py-3 text-right space-x-1">
          <button data-editar="${e.id}" class="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200">Editar</button>
          <button data-eliminar="${e.id}" class="text-xs px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100">Eliminar</button>
        </td>`;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('[data-activar]').forEach(b => b.addEventListener('click', async () => {
      try {
        await Storage.setActiva(b.dataset.activar);
        await Storage.clearToken();
        await renderEmpresas($('#buscarEmpresa')?.value || '');
        await updateHeader();
        toast('Empresa activada', 'ok');
      } catch (ex) { toast(ex.message, 'err'); }
    }));
    tbody.querySelectorAll('[data-editar]').forEach(b => b.addEventListener('click', () => openModalEmpresa(b.dataset.editar)));
    tbody.querySelectorAll('[data-eliminar]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta empresa?')) return;
      try {
        await Storage.deleteEmpresa(b.dataset.eliminar);
        await renderEmpresas($('#buscarEmpresa')?.value || '');
        await updateHeader();
        toast('Empresa eliminada', 'ok');
      } catch (ex) { toast(ex.message, 'err'); }
    }));
  }

  $('#buscarEmpresa')?.addEventListener('input', e => renderEmpresas(e.target.value));
  $('#btnNuevaEmpresa')?.addEventListener('click', () => openModalEmpresa(null));

  async function openModalEmpresa(id) {
    const form = $('#formEmpresa');
    form.reset();
    $('#empId').value = '';
    $('#empRucMsg').textContent = '';
    if (id) {
      const list = await Storage.getEmpresas();
      const e = list.find(x => x.id === id);
      if (!e) return;
      $('#modalEmpresaTitulo').textContent = 'Editar Empresa';
      $('#empId').value = e.id;
      $('#empRuc').value = e.ruc;
      $('#empNombre').value = e.nombre;
      $('#empUsuario').value = e.usuario || '';
      // Seguridad: no rellenar secretos en el formulario (dejar vacío = no cambiar)
      $('#empClave').value = '';
      $('#empClave').placeholder = e.clave ? '•••••••• (sin cambios si vacío)' : '';
      $('#empClientId').value = e.clientId || '';
      $('#empClientSecret').value = '';
      $('#empClientSecret').placeholder = e.clientSecret ? '•••••••• (sin cambios si vacío)' : '';
      $('#empAmbiente').value = e.ambiente || 'PRODUCCION';
      $('#empRuta').value = e.ruta || 'C:\\GRE\\';
    } else {
      $('#modalEmpresaTitulo').textContent = 'Nueva Empresa';
    }
    $('#modalEmpresa').classList.remove('hidden');
  }

  $$('[data-close-modal]').forEach(el => el.addEventListener('click', () => {
    $('#modalEmpresa').classList.add('hidden');
  }));

  $('#btnBuscarRuc')?.addEventListener('click', async () => {
    const ruc = $('#empRuc').value.trim();
    if (!/^\d{11}$/.test(ruc)) {
      $('#empRucMsg').textContent = 'RUC debe tener 11 dígitos';
      $('#empRucMsg').className = 'text-xs mt-1 text-red-600';
      return;
    }
    $('#empRucMsg').textContent = 'Consultando SUNAT...';
    $('#empRucMsg').className = 'text-xs mt-1 text-slate-500';
    try {
      const data = await API.consultarRuc(ruc);
      if (data.razonSocial) {
        $('#empNombre').value = data.razonSocial;
        $('#empRucMsg').textContent = `${data.estado || ''} · ${data.condicion || ''}`.trim();
        $('#empRucMsg').className = 'text-xs mt-1 text-emerald-600';
        toast('Razón social encontrada', 'ok');
      } else {
        $('#empRucMsg').textContent = 'No se encontró razón social';
        $('#empRucMsg').className = 'text-xs mt-1 text-amber-600';
      }
    } catch (err) {
      $('#empRucMsg').textContent = err.message || 'Error al consultar';
      $('#empRucMsg').className = 'text-xs mt-1 text-red-600';
    }
  });

  $('#formEmpresa')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emp = {
      id: $('#empId').value || undefined,
      ruc: $('#empRuc').value.trim(),
      nombre: $('#empNombre').value.trim(),
      usuario: $('#empUsuario').value.trim(),
      clave: $('#empClave').value,
      clientId: $('#empClientId').value.trim(),
      clientSecret: $('#empClientSecret').value,
      ambiente: $('#empAmbiente').value,
      ruta: $('#empRuta').value.trim() || 'C:\\GRE\\'
    };
    if (!/^\d{11}$/.test(emp.ruc)) {
      toast('RUC inválido', 'err');
      return;
    }
    if (!emp.id && !emp.clave) {
      toast('Clave SOL obligatoria al crear empresa', 'err');
      return;
    }
    try {
      const list = await Storage.getEmpresas();
      if (!emp.id && list.some(x => x.ruc === emp.ruc)) {
        toast('Ya existe una empresa con ese RUC', 'err');
        return;
      }
      await Storage.saveEmpresa(emp);
      // si no hay activa, activar esta
      const activa = await Storage.getActiva();
      if (!activa) {
        const updated = await Storage.getEmpresas();
        const found = updated.find(x => x.ruc === emp.ruc);
        if (found) await Storage.setActiva(found.id);
      }
      $('#modalEmpresa').classList.add('hidden');
      await renderEmpresas($('#buscarEmpresa')?.value || '');
      await updateHeader();
      toast('Empresa guardada', 'ok');
    } catch (ex) {
      toast(ex.message || 'Error al guardar', 'err');
    }
  });

  // ---------- Token ----------
  async function generarToken() {
    const emp = await Storage.getActiva();
    if (!emp) {
      toast('Selecciona una empresa activa primero', 'err');
      navigate('empresas');
      return;
    }
    const btn = $('#btnGenerarToken');
    btn.disabled = true;
    btn.textContent = 'Generando...';
    try {
      const token = await API.obtenerToken(emp);
      await Storage.setToken(token);
      await renderToken();
      await updateHeader();
      toast('Token generado correctamente', 'ok');
    } catch (err) {
      toast(err.message || 'Error al generar token', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generar / Renovar Token';
    }
  }
  $('#btnGenerarToken')?.addEventListener('click', generarToken);

  async function renderToken() {
    const t = await Storage.getToken();
    if (!t || !t.access_token) {
      $('#tokenValor').textContent = '—';
      $('#tokenExpira').textContent = '—';
      $('#tokenActualizado').textContent = '—';
      return;
    }
    // Seguridad: no mostrar el token completo en pantalla
    const tok = t.access_token || '';
    $('#tokenValor').textContent = tok.length > 16
      ? tok.slice(0, 8) + '…' + tok.slice(-6) + '  (' + tok.length + ' chars)'
      : '••••••••';
    $('#tokenValor').title = 'Token oculto por seguridad. Úsalo solo vía API de la app.';
    $('#tokenExpira').textContent = new Date(t.expires_at).toLocaleString('es-PE');
    $('#tokenActualizado').textContent = new Date(t.updated_at).toLocaleString('es-PE');
  }

  // ---------- Visor ----------
  $('#btnVerificar')?.addEventListener('click', async () => {
    const tipo = $('#visorTipo').value;
    const ruc = $('#visorRuc').value.trim();
    const serie = $('#visorSerie').value.trim();
    const numero = $('#visorNumero').value.trim();
    const fecha = $('#visorFecha').value;
    const monto = $('#visorMonto')?.value;
    if (!ruc || !serie || !numero || !fecha) {
      toast('Completa RUC, Serie, Número y Fecha', 'err');
      return;
    }
    const emp = await Storage.getActiva();
    if (!emp) {
      toast('Activa una empresa primero', 'err');
      return;
    }
    const cont = $('#visorContenido');
    cont.innerHTML = '<div class="text-center text-slate-500 py-16">Consultando SUNAT...</div>';
    try {
      const data = await API.consultarComprobante({ tipo, ruc, serie, numero, fecha, monto, empresa: emp });
      renderVisor(data);
      toast(data.estado || 'Consulta OK', data.ok ? 'ok' : 'info');
    } catch (err) {
      cont.innerHTML = `<div class="text-center text-red-600 py-16 px-4 text-sm">${escapeHtml(err.message)}</div>`;
      toast(err.message || 'Error', 'err');
    }
  });

  function renderVisor(data) {
    const cont = $('#visorContenido');
    const rows = Object.entries(data.detalle || {})
      .map(([k, v]) => `<div class="visor-row"><span class="visor-label">${escapeHtml(k)}</span><span class="visor-value">${escapeHtml(String(v))}</span></div>`)
      .join('');
    const badge = data.ok
      ? 'bg-emerald-100 text-emerald-800'
      : (data.estado === 'ERROR' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800');
    cont.innerHTML = `
      <div class="visor-card mb-4">
        <div class="flex items-start justify-between mb-3">
          <div>
            <div class="text-xs text-slate-500 uppercase tracking-wide">${escapeHtml(data.tipoNombre || 'Comprobante')}</div>
            <div class="font-semibold text-lg">${escapeHtml(data.serie)}-${escapeHtml(String(data.numero))}</div>
          </div>
          <span class="text-xs px-2.5 py-1 rounded-full ${badge}">${escapeHtml(String(data.estado || ''))}</span>
        </div>
        ${rows}
      </div>
      <p class="text-sm text-slate-600">${escapeHtml(data.mensaje || '')}</p>
      <p class="text-xs text-slate-400 mt-4">Consulta de validez vía API SUNAT. La descarga del XML original del emisor puede requerir servicio adicional o archivo propio.</p>`;
    $('#btnVisorXML')?.classList.add('hidden');
    $('#btnVisorPDF')?.classList.add('hidden');
  }

  // Resultados CPE en memoria para exportar
  let ultimoLoteCPE = [];

  function renderTablaCPE(rows) {
    const tbody = $('#tablaCPE');
    const empty = $('#emptyCPE');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '';
      empty?.classList.remove('hidden');
      $('#btnExportarCPE')?.classList.add('hidden');
      return;
    }
    empty?.classList.add('hidden');
    $('#btnExportarCPE')?.classList.remove('hidden');
    tbody.innerHTML = rows.map((r, idx) => {
      const badge = r.ok
        ? 'bg-emerald-100 text-emerald-700'
        : (r.estado === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800');
      return `<tr class="hover:bg-slate-50">
        <td class="px-3 py-2">${escapeHtml(r.tipoNombre || r.tipo || '')}</td>
        <td class="px-3 py-2 font-medium">${escapeHtml(r.serie)}-${escapeHtml(String(r.numero))}</td>
        <td class="px-3 py-2">${escapeHtml(r.fecha || '—')}</td>
        <td class="px-3 py-2">${escapeHtml(r.monto || '—')}</td>
        <td class="px-3 py-2"><span class="text-xs px-2 py-0.5 rounded-full ${badge}">${escapeHtml(String(r.estado || ''))}</span></td>
        <td class="px-3 py-2 text-right">
          <button type="button" data-cpe-idx="${idx}" class="btn-ver-cpe text-xs text-primary-600 hover:underline">Ver</button>
        </td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('.btn-ver-cpe').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.getAttribute('data-cpe-idx'));
        const row = ultimoLoteCPE[i];
        if (!row) return;
        navigate('visor');
        renderVisor(row);
      });
    });
  }

  $('#btnValidarLoteCPE')?.addEventListener('click', async () => {
    const emp = await Storage.getActiva();
    if (!emp) return toast('Activa una empresa primero', 'err');

    const tipo = $('#cpeDoc')?.value || '01';
    const rucEmisor = $('#cpeRuc')?.value.trim();
    const serie = $('#cpeSerie')?.value.trim();
    const n1 = parseInt($('#cpeNumDesde')?.value, 10);
    const n2 = parseInt($('#cpeNumHasta')?.value, 10);
    const fecha = $('#cpeFecha')?.value;
    const monto = $('#cpeMonto')?.value;

    if (!rucEmisor || !/^\d{11}$/.test(rucEmisor)) return toast('RUC emisor inválido', 'err');
    if (!serie) return toast('Indica la serie', 'err');
    if (!fecha) return toast('Indica la fecha de emisión', 'err');
    if (!n1 || !n2 || n2 < n1) return toast('Rango de números inválido', 'err');
    if (n2 - n1 > 50) return toast('Máximo 50 comprobantes por lote (protección)', 'err');

    const items = [];
    for (let n = n1; n <= n2; n++) {
      items.push({ tipo, rucEmisor, serie, numero: n, fecha, monto });
    }

    const prog = $('#cpeProgreso');
    const btn = $('#btnValidarLoteCPE');
    btn.disabled = true;
    prog.textContent = 'Obteniendo token de consulta...';

    try {
      const tokenObj = await API.obtenerTokenConsulta(emp);
      prog.textContent = `0 / ${items.length}`;
      ultimoLoteCPE = await API.validarCpeLote({
        empresa: emp,
        accessToken: tokenObj.access_token,
        items,
        onProgress: (done, total) => {
          prog.textContent = `${done} / ${total}`;
        }
      });
      renderTablaCPE(ultimoLoteCPE);
      const okCount = ultimoLoteCPE.filter(r => r.ok).length;
      toast(`Lote listo: ${okCount} OK de ${ultimoLoteCPE.length}`, 'ok');
      prog.textContent = `Listo · ${okCount}/${ultimoLoteCPE.length} aceptados`;
    } catch (ex) {
      toast(ex.message || 'Error en lote', 'err');
      prog.textContent = '';
    } finally {
      btn.disabled = false;
    }
  });

  $('#btnExportarCPE')?.addEventListener('click', () => {
    if (!ultimoLoteCPE.length) return toast('No hay resultados para exportar', 'err');
    const csv = API.resultadosACsv(ultimoLoteCPE);
    const stamp = new Date().toISOString().slice(0, 10);
    API.descargarTexto(`cpe-validacion-${stamp}.csv`, csv);
    toast('CSV descargado', 'ok');
  });

  // ---------- Header / Dashboard ----------
  async function updateHeader() {
    const emp = await Storage.getActiva();
    const t = await Storage.getToken();
    const badgeEmp = $('#badgeEmpresa');
    const badgeTok = $('#badgeToken');
    const side = $('#empresaActivaSidebar');
    if (emp) {
      badgeEmp.textContent = emp.nombre;
      side.textContent = emp.nombre + ' · ' + emp.ruc;
    } else {
      badgeEmp.textContent = 'Sin empresa';
      side.textContent = 'Sin empresa activa';
    }
    if (t && t.expires_at > Date.now()) {
      badgeTok.classList.remove('hidden');
      badgeTok.textContent = 'Token OK';
    } else {
      badgeTok.classList.add('hidden');
    }
  }

  async function renderDashboard() {
    const emp = await Storage.getActiva();
    const t = await Storage.getToken();
    const list = await Storage.getEmpresas();
    $('#dashEmpresa').textContent = emp ? emp.nombre : 'Ninguna';
    $('#dashRuc').textContent = emp ? 'RUC ' + emp.ruc : '—';
    $('#dashCount').textContent = list.length;
    if (t && t.access_token) {
      const valid = t.expires_at > Date.now();
      $('#dashToken').textContent = valid ? 'Válido' : 'Vencido';
      $('#dashTokenExpira').textContent = new Date(t.expires_at).toLocaleString('es-PE');
    } else {
      $('#dashToken').textContent = 'No generado';
      $('#dashTokenExpira').textContent = '—';
    }
  }

  $('#btnListarGRE')?.addEventListener('click', async () => {
    if (!(await Storage.getActiva())) return toast('Activa una empresa primero', 'err');
    toast('Listado GRE: se conectará en el siguiente paso', 'info');
  });
  $('#btnDescargarGRE')?.addEventListener('click', () => toast('Descarga masiva: próximo paso', 'info'));
  // Listar CPE reemplazado por validación en lote (btnValidarLoteCPE)

  async function boot() {
    await updateHeader();
    await renderDashboard();
    navigate('dashboard');
  }

  // Init
  (async () => {
    const ok = await checkAuth();
    if (ok) await boot();
  })();
})();
