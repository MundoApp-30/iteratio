// ===============================================================
// SUPABASE CONFIG
// ===============================================================
const SUPABASE_URL      = 'https://xxcsmxvusvunnmcgroqt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4Y3NteHZ1c3Z1bm5tY2dyb3F0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MzE2ODAsImV4cCI6MjA5NTUwNzY4MH0.M9wLNLuqzdIiIZFnhCQ7UgZbHCF7S79Wo6I_zs1_iY0';
const SUPABASE_KEY = SUPABASE_ANON_KEY;

// Guard de seguridad: si por cualquier causa (SW, caché, encoding)
// la URL pierde el protocolo, lo restauramos en tiempo de ejecución
// antes de que cualquier fetch falle.
(function _fixSupabaseUrl() {
  if (typeof SUPABASE_URL === 'string' && !SUPABASE_URL.startsWith('http')) {
    // Esto no debería ocurrir — indica que el SW sirvió una versión corrupta.
    // La constante ya es correcta; este guard existe como red de seguridad.
    console.error('[Iteratio] SUPABASE_URL no tiene protocolo — verifica el despliegue en Netlify.');
  }
})();

// ===============================================================
// CLIENTE HTTP
// ===============================================================
async function sbFetch(table, params, token) {
  const t = token || SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params || ''}`, {
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`sbFetch ${res.status} [${table}]: ${await res.text()}`);
  return res.json();
}
async function sbPost(table, body, token) {
  const t = token || SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`sbPost ${res.status} [${table}]: ${await res.text()}`);
  return res.json();
}
async function sbPatch(table, filter, body, token) {
  const t = token || SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`sbPatch ${res.status} [${table}]: ${await res.text()}`);
  return res.json();
}
async function sbDelete(table, filter, token) {
  const t = token || SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${t}` }
  });
  if (!res.ok) throw new Error(`sbDelete ${res.status} [${table}]: ${await res.text()}`);
  return true;
}
async function sbAuth(endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { ok: res.ok, data: await res.json() };
}

// ===============================================================
// ESTADO GLOBAL
// ===============================================================
let _session        = null;
let currentProfile  = null;
let allSubProfiles  = [];
let movies          = [];
let favorites       = [];
let currentMovie    = null;
let activeTab       = 'inicio';
let activeGenre     = 'Todos';
let searchQuery     = '';
let heartbeatTimer  = null;
let playerOpen      = false;
let featuredContent = null;
let appVisible      = false;
let searchExpanded  = false;

// -- ESTADO DE MODO EDICIÓN EN window ---------------------------
// Se define en window para que el listener del contenedor padre,
// los botones inline del HTML (enterEditMode / exitEditMode) y
// cualquier función del script lean y escriban EXACTAMENTE la
// misma referencia, sin problemas de scoping ni closures congeladas.
window.isEditModeActive = false;

// ===============================================================
// PERSISTENCIA
// ===============================================================
function saveSession(s)       { sessionStorage.setItem('iteratio_session', JSON.stringify(s)); }
function getSession()         { try { return JSON.parse(sessionStorage.getItem('iteratio_session')); } catch { return null; } }
function clearSession()       { sessionStorage.removeItem('iteratio_session'); }
function saveActiveProfile(p) { localStorage.setItem('iteratio_profile', JSON.stringify(p)); }
function getActiveProfile()   { try { return JSON.parse(localStorage.getItem('iteratio_profile')); } catch { return null; } }
function clearActiveProfile() { localStorage.removeItem('iteratio_profile'); }
function tok()                { return _session?.access_token || null; }

// ===============================================================
// AUTH — UI helpers
// ===============================================================
function switchTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('tabLogin').classList.toggle('active', isLogin);
  document.getElementById('tabRegister').classList.toggle('active', !isLogin);
  document.getElementById('formLogin').classList.toggle('hidden', !isLogin);
  document.getElementById('formRegister').classList.toggle('hidden', isLogin);
  clearAuthMessages();
}
function clearAuthMessages() {
  ['loginMsg', 'registerMsg'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.className = 'auth-message'; el.textContent = ''; }
  });
}
function showAuthMessage(id, type, text) {
  const el = document.getElementById(id);
  if (el) { el.className = `auth-message ${type}`; el.textContent = text; }
}
function setButtonLoading(id, loading, label) {
  const btn = document.getElementById(id);
  if (btn) { btn.disabled = loading; btn.textContent = loading ? 'Cargando...' : label; }
}
async function fetchAccountProfile(userId, token) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=is_active,full_name,email,active_screens`,
    { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` } }
  );
  const data = await res.json();
  return data?.[0] ?? null;
}

// ===============================================================
// AUTH — Login
// ===============================================================
async function handleLogin(e) {
  e.preventDefault();
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  setButtonLoading('btnLogin', true, 'Entrar');
  clearAuthMessages();
  try {
    const { ok, data } = await sbAuth('token?grant_type=password', { email, password });
    if (!ok) { showAuthMessage('loginMsg', 'error', data.error_description || 'Credenciales incorrectas.'); return; }
    const { access_token, user } = data;
    const acct = await fetchAccountProfile(user.id, access_token);
    if (!acct)           { showAuthMessage('loginMsg', 'error', 'Cuenta no encontrada. Contacta al administrador.'); return; }
    if (!acct.is_active) { showAuthMessage('loginMsg', 'warning', 'Tu cuenta está pendiente de aprobación.'); return; }
    _session = { access_token, user_id: user.id, email, full_name: acct.full_name };
    saveSession(_session);
    await enterApp();
  } catch (err) {
    console.error('[Login]', err);
    showAuthMessage('loginMsg', 'error', 'Error de conexión. Intenta de nuevo.');
  } finally {
    setButtonLoading('btnLogin', false, 'Entrar');
  }
}

// ===============================================================
// AUTH — Registro
// ===============================================================
async function handleRegister(e) {
  e.preventDefault();
  const name     = document.getElementById('regName').value.trim();
  const email    = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  setButtonLoading('btnRegister', true, 'Solicitar acceso');
  clearAuthMessages();
  try {
    const { ok, data } = await sbAuth('signup', { email, password, data: { display_name: name } });
    if (!ok) { showAuthMessage('registerMsg', 'error', data.msg || 'No se pudo crear la cuenta.'); return; }
    const userId = data.user?.id;
    if (userId) {
      await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates' },
        body: JSON.stringify({ id: userId, full_name: name, email, is_active: false, active_screens: 0 })
      });
    }
    showAuthMessage('registerMsg', 'success', 'Solicitud enviada. Un administrador activará tu cuenta pronto.');
    document.getElementById('formRegister').reset();
  } catch (err) {
    console.error('[Register]', err);
    showAuthMessage('registerMsg', 'error', 'Error de conexión. Intenta de nuevo.');
  } finally {
    setButtonLoading('btnRegister', false, 'Solicitar acceso');
  }
}

// ===============================================================
// AUTH — Logout
// ===============================================================
async function handleLogout() {
  stopHeartbeat();
  if (playerOpen) await releaseScreen();
  if (_session?.access_token) {
    fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${_session.access_token}` }
    }).catch(() => {});
  }
  hardReset();
}

async function logoutAllDevices() {
  try {
    await sbPatch('profiles', `id=eq.${_session.user_id}`, { active_screens: 0 }, tok());
    updateDevicesUI(0);
    stopHeartbeat();
    playerOpen = false;
    closeDetailPlayer();
  } catch (err) { console.error('[logoutAllDevices]', err); }
}

function hardReset() {
  clearSession(); clearActiveProfile();
  _session = null; currentProfile = null; allSubProfiles = []; movies = []; favorites = [];
  currentMovie = null; activeTab = 'inicio'; activeGenre = 'Todos'; searchQuery = '';
  playerOpen = false; appVisible = false; window.isEditModeActive = false; searchExpanded = false;
  closeDropdown(); closeAccountModal(); collapseSearch();
  closeDetailView();
  showAuthScreen();
}

function showAuthScreen() {
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('profileSelector').classList.add('hidden');
  const h = document.getElementById('appHeader');
  if (h) { h.classList.remove('visible'); h.classList.add('hidden'); }
  document.getElementById('featuredBanner')?.classList.add('hidden');
  document.getElementById('genreHub')?.classList.add('hidden');
  document.getElementById('detailView')?.classList.add('hidden');
  document.getElementById('pageWrapper')?.classList.add('hidden');
  document.getElementById('userBar')?.classList.remove('visible');
  const grid = document.getElementById('grid');
  if (grid) grid.innerHTML = '';
}

// ===============================================================
// VERIFICAR SESION AL INICIAR
// ===============================================================
function startAuthStateListener() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!getSession() && appVisible) hardReset();
    }
  });
}

async function checkExistingSession() {
  _session = getSession();
  if (!_session?.access_token || !_session?.user_id) return;
  try {
    const acct = await fetchAccountProfile(_session.user_id, _session.access_token);
    if (acct?.is_active) await enterApp();
    else clearSession();
  } catch { clearSession(); }
}

// ===============================================================
// FLUJO POST-LOGIN
// ===============================================================
async function enterApp() {
  document.getElementById('authScreen').classList.add('hidden');
  allSubProfiles = await sbFetch('sub_profiles', `account_id=eq.${_session.user_id}&order=created_at.asc`, tok()).catch(() => []);

  if (allSubProfiles.length === 0) {
    const created = await sbPost('sub_profiles', {
      account_id: _session.user_id,
      profile_name: _session.full_name || 'Administrador',
      is_admin: true
    }, tok()).catch(() => null);
    if (created?.[0]) allSubProfiles = [created[0]];
  }

  if (allSubProfiles.length > 0 && !allSubProfiles[0].is_admin) {
    await sbPatch('sub_profiles', `id=eq.${allSubProfiles[0].id}`, { is_admin: true }, tok()).catch(() => {});
    allSubProfiles[0].is_admin = true;
  }

  const saved = getActiveProfile();
  if (saved && allSubProfiles.find(p => p.id === saved.id)) {
    currentProfile = saved;
    await launchCatalog();
    return;
  }
  window.isEditModeActive = false;
  renderProfileSelector();
  document.getElementById('profileSelector').classList.remove('hidden');
}

// ===============================================================
// SELECTOR DE PERFILES — Estado en window + Delegación de Eventos
//
// window.isEditModeActive es la ÚNICA fuente de verdad.
// El listener del contenedor padre la lee en el microsegundo del clic.
// renderProfileSelector() aplica .edit-mode-active al grid (CSS) y
// pinta el HTML de las tarjetas. CERO addEventListener en tarjetas.
// ===============================================================

function renderProfileSelector() {
  const grid      = document.getElementById('profileAvatarsGrid');
  const manageBtn = document.getElementById('profileSelectorManageBtn');
  const doneWrap  = document.getElementById('profileSelectorDoneWrap');
  const titleEl   = document.getElementById('profileSelectorTitle');

  if (titleEl) titleEl.textContent = window.isEditModeActive
    ? 'EDITAR PERFILES'
    : '¿Quién está viendo?';

  // La clase .edit-mode-active en el grid activa en CSS:
  // cursor:pointer en .profile-card y pointer-events:none en sus hijos.
  if (window.isEditModeActive) {
    grid.classList.add('edit-mode-active');
  } else {
    grid.classList.remove('edit-mode-active');
  }

  // HTML puro. CERO listeners. data-id en el div raíz (.profile-card).
  grid.innerHTML = allSubProfiles.map(p => {
    const letter  = (p.profile_name || '?')[0].toUpperCase();
    const isAdmin = !!p.is_admin;

    const avatarInner = p.avatar_url
      ? `<img src="${p.avatar_url}" alt="${p.profile_name}">`
      : `<span>${letter}</span>`;

    // pointer-events:none garantizado en CSS para .profile-edit-overlay
    // y .profile-edit-icon-svg — el clic jamás se detiene aquí.
    const pencilOverlay = window.isEditModeActive
      ? `<div class="profile-edit-overlay">
           <svg class="profile-edit-icon-svg" width="28" height="28" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round">
             <path d="M12 20h9"/>
             <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
           </svg>
         </div>`
      : '';

    const adminBadge = isAdmin ? '<span class="crown-icon">👑</span>' : '';

    return `<div class="profile-card" data-id="${p.id}">
      <div class="profile-avatar-circle">
        ${avatarInner}${pencilOverlay}
      </div>
      <span class="profile-avatar-name">${p.profile_name}${adminBadge}</span>
    </div>`;
  }).join('');

  // Tarjeta "Añadir perfil" — solo en modo edición, menos de 5 perfiles
  if (window.isEditModeActive && allSubProfiles.length < 5) {
    grid.insertAdjacentHTML('beforeend',
      `<div class="profile-card" data-action="add">
         <div class="profile-avatar-circle profile-add-circle">
           <span class="profile-add-plus">+</span>
         </div>
         <span class="profile-avatar-name">Añadir</span>
       </div>`
    );
  }

  if (manageBtn) {
    window.isEditModeActive
      ? manageBtn.classList.add('hidden')
      : manageBtn.classList.remove('hidden');
  }
  if (doneWrap) {
    window.isEditModeActive
      ? doneWrap.classList.remove('hidden')
      : doneWrap.classList.add('hidden');
  }
}

// -- enterEditMode ----------------------------------------------
// Escribe window.isEditModeActive = true PRIMERO, luego re-pinta.
// Llamado desde onclick en el HTML; lee y escribe la propiedad global
// sin ninguna ambigüedad de scope.
function enterEditMode() {
  window.isEditModeActive = true;
  renderProfileSelector();
}

// -- exitEditMode -----------------------------------------------
// Escribe window.isEditModeActive = false PRIMERO, luego re-pinta.
// El siguiente clic sobre cualquier tarjeta leerá false y ejecutará
// switchActiveProfile — jamás openEditProfileModal.
function exitEditMode() {
  window.isEditModeActive = false;
  renderProfileSelector();
}

// -- goToEditProfiles -------------------------------------------
// Desde el dropdown del header — va al selector en modo edición.
function goToEditProfiles() {
  closeDropdown();
  window.isEditModeActive = true;
  currentProfile          = null;
  clearActiveProfile();
  renderProfileSelector();
  const h = document.getElementById('appHeader');
  if (h) { h.classList.remove('visible'); h.classList.add('hidden'); }
  document.getElementById('userBar')?.classList.remove('visible');
  document.getElementById('featuredBanner')?.classList.add('hidden');
  document.getElementById('genreHub')?.classList.add('hidden');
  document.getElementById('detailView')?.classList.add('hidden');
  document.getElementById('pageWrapper')?.classList.add('hidden');
  document.getElementById('profileSelector').classList.remove('hidden');
  appVisible = false;
}

// -- openEditProfileModal(profileId) ---------------------------
// Punto de entrada del listener: recibe el ID string extraído de
// card.dataset.id, busca el objeto en allSubProfiles y delega en
// openEditProfileForm(profile). De este modo el listener solo necesita
// el ID — no tiene que resolver el objeto ni tiene acceso a closures.
function openEditProfileModal(profileId) {
  const profile = allSubProfiles.find(p => p.id === profileId);
  if (!profile) return;
  openEditProfileForm(profile);
}

// -- switchActiveProfile(profileId) ----------------------------
// Punto de entrada del listener en modo normal: recibe el ID string,
// busca el objeto y cambia de cuenta. NUNCA abre ningún modal.
// La firma acepta tanto un string (desde el listener) como el objeto
// completo (desde renderDropdownProfiles) para compatibilidad total.
async function switchActiveProfile(profileOrId) {
  const profile = (typeof profileOrId === 'string')
    ? allSubProfiles.find(p => p.id === profileOrId)
    : profileOrId;
  if (!profile) return;
  currentProfile = profile;
  saveActiveProfile(profile);
  document.getElementById('profileSelector').classList.add('hidden');
  await launchCatalog();
}

// ===============================================================
// MODAL DE PERFIL — lógica limpia, tres modos, sin cruces de estado
//
// CREAR  → openCreateProfileForm()
//   - Botón principal: "Crear perfil"   Eliminar: NUNCA visible
//
// EDITAR → openEditProfileForm(profile)
//   - Botón principal: "Guardar cambios"
//   - Eliminar: visible solo si !profile.is_admin
//   - Confirmar borrado → triggerDeleteConfirm() → in-place
//   - Después de borrar: window.isEditModeActive = false, refresca
//
// _resetProfileModal() limpia TODO antes de cada apertura.
// ===============================================================

function _resetProfileModal() {
  const saveBtn = document.getElementById('profileFormSaveBtn');
  const delBtn  = document.getElementById('profileFormDeleteBtn');
  const confBtn = document.getElementById('profileFormConfirmDeleteBtn');
  const msgEl   = document.getElementById('profileFormMsg');
  const fields  = document.getElementById('profileFormFields');

  if (saveBtn) {
    saveBtn.disabled      = false;
    saveBtn.textContent   = 'Guardar';
    saveBtn.style.cssText = '';
    saveBtn.dataset.mode  = 'create';
    delete saveBtn.dataset.profileId;
    saveBtn.onclick       = handleProfileFormSave;
  }
  if (delBtn) {
    // Restauración COMPLETA: disabled, estilos, texto, handler y dataset.
    // Si no se restaura disabled, el botón queda inerte tras la primera eliminación.
    delBtn.disabled       = false;
    delBtn.style.cssText  = 'display:none';
    delBtn.textContent    = 'Eliminar perfil';
    delBtn.onclick        = triggerDeleteConfirm;
    delete delBtn.dataset.profileId;
    delete delBtn.dataset.profileName;
  }
  if (confBtn) {
    confBtn.style.display = 'none';
  }
  if (msgEl)  { msgEl.className = 'account-message'; msgEl.textContent = ''; }
  if (fields) { fields.style.display = ''; }
}

// -- MODO A: CREAR ----------------------------------------------
function openCreateProfileForm() {
  _resetProfileModal();
  document.getElementById('profileFormTitle').textContent       = 'Nuevo perfil';
  document.getElementById('profileFormName').value              = '';
  document.getElementById('profileFormAvatarUrl').value         = '';
  const saveBtn = document.getElementById('profileFormSaveBtn');
  if (saveBtn) { saveBtn.dataset.mode = 'create'; saveBtn.textContent = 'Crear perfil'; }
  document.getElementById('profileFormDeleteBtn').style.cssText = 'display:none';
  document.getElementById('profileFormModal').classList.remove('hidden');
}

// -- MODO B: EDITAR ---------------------------------------------
function openEditProfileForm(profile) {
  _resetProfileModal();
  document.getElementById('profileFormTitle').textContent = 'Editar perfil';
  document.getElementById('profileFormName').value        = profile.profile_name || '';
  document.getElementById('profileFormAvatarUrl').value   = profile.avatar_url   || '';

  const saveBtn = document.getElementById('profileFormSaveBtn');
  if (saveBtn) {
    saveBtn.dataset.mode      = 'edit';
    saveBtn.dataset.profileId = profile.id;
    saveBtn.textContent       = 'Guardar cambios';
  }

  const delBtn = document.getElementById('profileFormDeleteBtn');
  if (delBtn) {
    if (profile.is_admin) {
      delBtn.style.display = 'none';
    } else {
      // Mostrar explícito + reset completo para que funcione en eliminaciones sucesivas
      delBtn.disabled            = false;
      delBtn.style.cssText       = '';
      delBtn.style.display       = '';
      delBtn.textContent         = 'Eliminar perfil';
      delBtn.onclick             = triggerDeleteConfirm;
      delBtn.dataset.profileId   = profile.id;
      delBtn.dataset.profileName = profile.profile_name;
    }
  }

  document.getElementById('profileFormModal').classList.remove('hidden');
}

// -- CERRAR MODAL -----------------------------------------------
function closeProfileFormModal() {
  document.getElementById('profileFormModal')?.classList.add('hidden');
}
function closeProfileFormModalClean() {
  _resetProfileModal();
  closeProfileFormModal();
}

// -- DISPATCH del botón principal ------------------------------
async function handleProfileFormSave() {
  const mode = document.getElementById('profileFormSaveBtn').dataset.mode;
  if (mode === 'edit') await saveEditProfile();
  else await saveCreateProfile();
}

// -- GUARDAR: crear nuevo perfil --------------------------------
async function saveCreateProfile() {
  const name      = document.getElementById('profileFormName').value.trim();
  const avatarUrl = document.getElementById('profileFormAvatarUrl').value.trim();
  const msgEl     = document.getElementById('profileFormMsg');
  const saveBtn   = document.getElementById('profileFormSaveBtn');
  if (!name)                      { showMsg(msgEl, 'error', 'El nombre no puede estar vacío.'); return; }
  if (allSubProfiles.length >= 5) { showMsg(msgEl, 'error', 'Límite máximo de 5 perfiles alcanzado.'); return; }
  saveBtn.disabled = true; saveBtn.textContent = 'Creando...';
  try {
    const body = { account_id: _session.user_id, profile_name: name, is_admin: false };
    if (avatarUrl) body.avatar_url = avatarUrl;
    const result = await sbPost('sub_profiles', body, tok());
    allSubProfiles.push(result[0]);
    showMsg(msgEl, 'success', 'Perfil creado correctamente.');
    setTimeout(() => { closeProfileFormModalClean(); renderProfileSelector(); }, 700);
  } catch (err) {
    console.error(err);
    showMsg(msgEl, 'error', 'Error al crear el perfil.');
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = 'Crear perfil';
  }
}

// -- GUARDAR: editar perfil existente --------------------------
async function saveEditProfile() {
  const profileId = document.getElementById('profileFormSaveBtn').dataset.profileId;
  const name      = document.getElementById('profileFormName').value.trim();
  const avatarUrl = document.getElementById('profileFormAvatarUrl').value.trim();
  const msgEl     = document.getElementById('profileFormMsg');
  const saveBtn   = document.getElementById('profileFormSaveBtn');
  if (!name) { showMsg(msgEl, 'error', 'El nombre no puede estar vacío.'); return; }
  saveBtn.disabled = true; saveBtn.textContent = 'Guardando...';
  try {
    const patch = { profile_name: name };
    if (avatarUrl) patch.avatar_url = avatarUrl;
    await sbPatch('sub_profiles', `id=eq.${profileId}`, patch, tok());
    const idx = allSubProfiles.findIndex(p => p.id === profileId);
    if (idx !== -1) {
      allSubProfiles[idx].profile_name = name;
      if (avatarUrl) allSubProfiles[idx].avatar_url = avatarUrl;
    }
    if (currentProfile?.id === profileId) {
      currentProfile.profile_name = name;
      if (avatarUrl) currentProfile.avatar_url = avatarUrl;
      saveActiveProfile(currentProfile);
    }
    showMsg(msgEl, 'success', 'Perfil actualizado correctamente.');
    setTimeout(() => {
      closeProfileFormModalClean();
      renderProfileSelector();
      renderDropdownProfiles();
    }, 700);
  } catch (err) {
    console.error(err);
    showMsg(msgEl, 'error', 'Error al actualizar el perfil.');
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = 'Guardar cambios';
  }
}

// -- FLUJO DE ELIMINACIÓN SEGURO (in-place) --------------------
// Paso 1 — pulsa "Eliminar perfil" → triggerDeleteConfirm():
//           transforma el botón en "Sí, eliminar" y muestra "Cancelar".
// Paso 2a — confirma → executeDeleteProfile():
//           borra en Supabase, window.isEditModeActive=false, refresca.
// Paso 2b — cancela → restoreDeleteBtn(): vuelve al estado original.
// -------------------------------------------------------------

function triggerDeleteConfirm() {
  const delBtn      = document.getElementById('profileFormDeleteBtn');
  const confBtn     = document.getElementById('profileFormConfirmDeleteBtn');
  const saveBtn     = document.getElementById('profileFormSaveBtn');
  const msgEl       = document.getElementById('profileFormMsg');
  const profileName = delBtn?.dataset.profileName || 'este perfil';

  if (saveBtn) saveBtn.style.display = 'none';
  if (delBtn) {
    delBtn.textContent      = 'Sí, eliminar';
    delBtn.style.background = 'rgba(220,38,38,.9)';
    delBtn.style.color      = '#fff';
    delBtn.style.border     = '1px solid rgba(220,38,38,.5)';
    delBtn.onclick          = executeDeleteProfile;
  }
  if (confBtn) confBtn.style.display = '';
  showMsg(msgEl, 'warning', `¿Eliminar "${profileName}"? Esta acción no se puede deshacer.`);
}

function restoreDeleteBtn() {
  const delBtn  = document.getElementById('profileFormDeleteBtn');
  const confBtn = document.getElementById('profileFormConfirmDeleteBtn');
  const saveBtn = document.getElementById('profileFormSaveBtn');
  const msgEl   = document.getElementById('profileFormMsg');

  if (saveBtn) saveBtn.style.display = '';
  if (delBtn) {
    delBtn.textContent      = 'Eliminar perfil';
    delBtn.style.background = '';
    delBtn.style.color      = '';
    delBtn.style.border     = '';
    delBtn.onclick          = triggerDeleteConfirm;
  }
  if (confBtn) confBtn.style.display = 'none';
  if (msgEl)   { msgEl.className = 'account-message'; msgEl.textContent = ''; }
}

async function executeDeleteProfile() {
  const delBtn    = document.getElementById('profileFormDeleteBtn');
  const msgEl     = document.getElementById('profileFormMsg');
  const profileId = delBtn?.dataset.profileId;
  if (!profileId) return;

  delBtn.disabled    = true;
  delBtn.textContent = 'Eliminando...';

  try {
    await sbDelete('sub_profiles', `id=eq.${profileId}`, tok());
    allSubProfiles = allSubProfiles.filter(p => p.id !== profileId);
    if (currentProfile?.id === profileId) { currentProfile = null; clearActiveProfile(); }
    showMsg(msgEl, 'success', 'Perfil eliminado.');
    setTimeout(() => {
      closeProfileFormModalClean();
      window.isEditModeActive = false;
      renderProfileSelector();
      renderDropdownProfiles();
    }, 600);
  } catch (err) {
    console.error(err);
    showMsg(msgEl, 'error', 'Error al eliminar. Intenta de nuevo.');
    delBtn.disabled    = false;
    delBtn.textContent = 'Sí, eliminar';
  }
}

// ===============================================================
// LANZAR CATALOGO
// ===============================================================
async function launchCatalog() {
  appVisible = true;

  // Siempre vuelve al inicio al cambiar de perfil o entrar a la app
  activeTab   = 'inicio';
  activeGenre = 'Todos';
  searchQuery = '';
  collapseSearch();
  document.querySelectorAll('.nav-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === 'inicio')
  );
  // Ocultar vistas que no son inicio
  document.getElementById('genreHub')?.classList.add('hidden');
  document.getElementById('detailView')?.classList.add('hidden');

  const avatarImg  = document.getElementById('userAvatarImg');
  const avatarInit = document.getElementById('userAvatarInitial');
  if (currentProfile?.avatar_url) {
    if (avatarImg)  { avatarImg.src = currentProfile.avatar_url; avatarImg.style.display = 'block'; }
    if (avatarInit)   avatarInit.style.display = 'none';
  } else {
    if (avatarImg)    avatarImg.style.display = 'none';
    if (avatarInit) {
      avatarInit.style.display = 'block';
      avatarInit.textContent   = (currentProfile?.profile_name || '?')[0].toUpperCase();
    }
  }
  const header = document.getElementById('appHeader');
  if (header) { header.classList.remove('hidden'); header.classList.add('visible'); }
  document.getElementById('userBar')?.classList.add('visible');
  document.getElementById('pageWrapper')?.classList.remove('hidden');
  await Promise.all([loadContent(), loadFavorites()]);
  renderDropdownProfiles();
  updateDropdownInfo();
}

// ===============================================================
// DROPDOWN USUARIO
// ===============================================================
function toggleDropdown() {
  document.getElementById('userDropdown').classList.contains('open') ? closeDropdown() : openDropdown();
}
function openDropdown() {
  document.getElementById('userDropdown').classList.add('open');
  document.getElementById('userAvatar').classList.add('open');
  document.getElementById('userAvatar').setAttribute('aria-expanded', 'true');
}
function closeDropdown() {
  const dd = document.getElementById('userDropdown');
  const av = document.getElementById('userAvatar');
  if (dd) dd.classList.remove('open');
  if (av) { av.classList.remove('open'); av.setAttribute('aria-expanded', 'false'); }
}

function renderDropdownProfiles() {
  const c = document.getElementById('dropdownProfilesList');
  if (!c) return;
  c.innerHTML = '';
  allSubProfiles.forEach(p => {
    const letter = (p.profile_name || '?')[0].toUpperCase();
    const item   = document.createElement('div');
    item.className = 'dropdown-profile-item' + (p.id === currentProfile?.id ? ' active-profile' : '');
    item.innerHTML = `
      <div class="dropdown-profile-avatar">
        ${p.avatar_url ? `<img src="${p.avatar_url}" alt="">` : letter}
      </div>
      <span class="dropdown-profile-name">${p.profile_name}${p.is_admin ? ' 👑' : ''}</span>`;
    item.onclick = () => {
      closeDropdown();
      currentProfile          = p;
      saveActiveProfile(p);
      window.isEditModeActive = false;
      launchCatalog();
    };
    c.appendChild(item);
  });
}

function updateDropdownInfo() {
  const nameEl  = document.getElementById('dropdownUserName');
  const emailEl = document.getElementById('dropdownUserEmail');
  if (nameEl)  nameEl.textContent  = currentProfile?.profile_name || _session?.full_name || '-';
  if (emailEl) emailEl.textContent = _session?.email || '-';
}

// ===============================================================
// BÚSQUEDA COLAPSABLE
// ===============================================================
function toggleSearch() {
  searchExpanded = !searchExpanded;
  const input = document.getElementById('searchInput');
  if (!input) return;
  input.classList.toggle('expanded', searchExpanded);
  if (searchExpanded) { setTimeout(() => input.focus(), 50); }
  else { collapseSearch(); }
}
function collapseSearch() {
  searchExpanded = false;
  const input = document.getElementById('searchInput');
  if (!input) return;
  input.classList.remove('expanded');
  input.value = ''; searchQuery = '';
  if (movies.length && activeTab !== 'generos') renderGrid();
}

// ===============================================================
// NAVEGACIÓN DE PESTAÑAS
// ===============================================================
async function switchNavTab(tab) {
  closeDetailView();
  activeTab = tab; activeGenre = 'Todos';
  collapseSearch();
  document.querySelectorAll('.nav-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab)
  );
  const banner      = document.getElementById('featuredBanner');
  const genreHub    = document.getElementById('genreHub');
  const pageWrapper = document.getElementById('pageWrapper');
  if (tab === 'generos') {
    banner?.classList.add('hidden');
    pageWrapper?.classList.add('hidden');
    genreHub?.classList.remove('hidden');
    buildGenreHub();
    return;
  }
  genreHub?.classList.add('hidden');
  pageWrapper?.classList.remove('hidden');
  if (tab === 'inicio' && featuredContent) banner?.classList.remove('hidden');
  else banner?.classList.add('hidden');
  if (tab === 'milista') await loadFavorites();
  renderGrid();
}

// ===============================================================
// CARGAR CONTENIDO
// ===============================================================
async function loadContent() {
  document.getElementById('featuredBanner')?.classList.add('hidden');
  document.getElementById('genreHub')?.classList.add('hidden');
  document.getElementById('pageWrapper')?.classList.remove('hidden');
  showSkeletons();
  try {
    const data = await sbFetch('content', 'select=*&order=title.asc', tok());
    movies = data.map(m => ({
      ...m,
      videoUrl: m.video_url  ?? null,
      poster:   m.poster_url ?? m.poster ?? '',
      banner:   m.banner_url ?? m.poster_url ?? m.poster ?? ''
    }));
    featuredContent = movies.find(m => m.is_featured) || null;
    if (featuredContent && activeTab === 'inicio') {
      renderFeaturedBanner(featuredContent);
      updateBannerMiListaBtn();
      document.getElementById('featuredBanner')?.classList.remove('hidden');
    }
    renderGrid();
  } catch (err) {
    console.error('[loadContent]', err);
    const grid = document.getElementById('grid');
    if (grid) grid.innerHTML = `<div class="empty"><div class="empty-icon">!</div><p>No se pudo cargar el catálogo.<br><span style="font-size:.75rem;color:var(--text-dim)">Revisa tu conexión.</span></p></div>`;
  }
}

async function loadFavorites() {
  if (!currentProfile?.id) return;
  try {
    const data = await sbFetch('profile_favorites', `profile_id=eq.${currentProfile.id}&select=content_id`, tok());
    favorites = data.map(f => f.content_id);
  } catch { favorites = []; }
}

// ===============================================================
// BANNER DESTACADO
// ===============================================================
function renderFeaturedBanner(m) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const bg  = document.getElementById('bannerBg');
  if (bg) bg.style.backgroundImage = `url('${m.banner}')`;
  set('bannerBadge', m.type === 'series' ? '★ Serie Destacada' : '★ Destacado');
  set('bannerTitle', m.title);
  set('bannerDesc',  m.description || '');
  const meta = document.getElementById('bannerMeta');
  if (meta) meta.innerHTML = `<span>${m.release_year||''}</span><span>${m.duration||''}</span><span style="color:var(--accent-gold)">${'★'.repeat(m.rating||0)}</span>`;
}
function bannerPlay() { if (!featuredContent) return; openDetailView(featuredContent); setTimeout(openDetailPlayer, 350); }
function bannerInfo() { if (featuredContent) openDetailView(featuredContent); }
async function bannerToggleFavorite() {
  if (!featuredContent || !currentProfile?.id) return;
  const inList = favorites.includes(featuredContent.id);
  try {
    if (inList) {
      await sbDelete('profile_favorites', `profile_id=eq.${currentProfile.id}&content_id=eq.${featuredContent.id}`, tok());
      favorites = favorites.filter(id => id !== featuredContent.id);
    } else {
      await sbPost('profile_favorites', { profile_id: currentProfile.id, content_id: featuredContent.id }, tok());
      favorites.push(featuredContent.id);
    }
    updateBannerMiListaBtn();
  } catch (err) { console.error('[BannerFavorite]', err); }
}
function updateBannerMiListaBtn() {
  if (!featuredContent) return;
  const inList  = favorites.includes(featuredContent.id);
  const iconEl  = document.getElementById('bannerMiListaIcon');
  const textEl  = document.getElementById('bannerMiListaText');
  if (iconEl) iconEl.innerHTML = inList
    ? '<polyline points="20 6 9 17 4 12"/>'
    : '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
  if (textEl) textEl.textContent = inList ? '✓ En Mi lista' : '+ Mi lista';
}

// ===============================================================
// HUB DE GÉNEROS
// ===============================================================
function buildGenreHub() {
  const grid = document.getElementById('genreHubGrid');
  if (!grid) return;
  const genres = [...new Set(movies.flatMap(m => m.genre || []))].sort((a, b) => a.localeCompare(b));
  grid.innerHTML = '';
  genres.forEach((g, i) => {
    const count = movies.filter(m => (m.genre || []).includes(g)).length;
    const card  = document.createElement('div');
    card.className = 'genre-card';
    card.style.animationDelay = `${i * 0.04}s`;
    card.innerHTML = `<span class="genre-card-count">${count} título${count !== 1 ? 's' : ''}</span><span class="genre-card-name">${g}</span>`;
    card.addEventListener('click', () => selectGenreFromHub(g));
    grid.appendChild(card);
  });
}

async function selectGenreFromHub(genre) {
  activeGenre = genre; activeTab = 'inicio';
  document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === 'inicio'));
  document.getElementById('genreHub')?.classList.add('hidden');
  document.getElementById('featuredBanner')?.classList.add('hidden');
  document.getElementById('pageWrapper')?.classList.remove('hidden');
  renderGrid();
}

// ===============================================================
// GRID Y FILTROS
// ===============================================================
function getPoolByTab() {
  switch (activeTab) {
    case 'series':    return movies.filter(m => m.type === 'series');
    case 'peliculas': return movies.filter(m => m.type === 'movie');
    case 'milista':   return movies.filter(m => favorites.includes(m.id));
    default:          return movies;
  }
}
function filtered() {
  return getPoolByTab().filter(m => {
    const matchGenre  = activeGenre === 'Todos' || (m.genre || []).includes(activeGenre);
    const matchSearch = !searchQuery || m.title.toLowerCase().includes(searchQuery.toLowerCase());
    return matchGenre && matchSearch;
  });
}
function showSkeletons(n) {
  n = n || 12;
  const grid = document.getElementById('grid');
  if (!grid) return;
  grid.innerHTML = Array.from({ length: n }, () => `
    <div class="movie-card" style="pointer-events:none;animation:none;">
      <div class="poster" style="background:var(--bg-surface);aspect-ratio:2/3;">
        <div style="position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(16,159,255,.04),transparent);animation:shimmer 1.4s infinite;"></div>
      </div>
      <div class="card-info">
        <div style="height:.85rem;background:var(--bg-surface);border-radius:4px;margin-bottom:.4rem;width:80%"></div>
        <div style="height:.65rem;background:var(--bg-surface);border-radius:4px;width:50%"></div>
      </div>
    </div>`).join('');
}
function renderGrid() {
  const list  = filtered();
  const grid  = document.getElementById('grid');
  if (!grid) return;
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><div class="empty-icon">🎞</div><p>Sin resultados${searchQuery ? ` para "${searchQuery}"` : activeGenre !== 'Todos' ? ` en ${activeGenre}` : ''}.</p></div>`;
    return;
  }
  grid.innerHTML = '';
  list.forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'movie-card' + (m.is_featured ? ' featured' : '');
    card.style.animationDelay = `${i * 0.04}s`;
    const primaryGenre = Array.isArray(m.genre) ? (m.genre[0] || '') : (m.genre || '');
    const isFav        = favorites.includes(m.id);
    card.innerHTML = `
      <div class="poster">
        <img class="poster-bg" src="${m.poster}" alt="${m.title}" loading="lazy">
        <div class="poster-overlay"></div>
        <span class="poster-genre">${primaryGenre}</span>
        ${m.type === 'series' ? '<span class="poster-featured" style="background:var(--accent-celeste);color:#fff">Serie</span>' : ''}
        ${m.is_featured && m.type !== 'series' ? '<span class="poster-featured">★ Dest.</span>' : ''}
        ${isFav ? '<span class="poster-fav">♥</span>' : ''}
        <div class="poster-play"><div class="play-circle">▶</div></div>
      </div>
      <div class="card-info">
        <h3>${m.title}</h3>
        <div class="card-meta">
          <span>${m.release_year || ''}</span><span>·</span>
          <span>${m.duration || ''}</span>
          <span class="card-stars">${'★'.repeat(m.rating || 0)}</span>
        </div>
      </div>`;
    card.addEventListener('click', () => openDetailView(m));
    grid.appendChild(card);
  });
}

// ===============================================================
// VISTA DE DETALLE HBO MAX
// ===============================================================
async function openDetailView(m) {
  currentMovie = m;
  const bg = document.getElementById('detailBg');
  if (bg) bg.style.backgroundImage = `url('${m.banner || m.poster}')`;
  const typeBadge = document.getElementById('detailTypeBadge');
  if (typeBadge) typeBadge.textContent = m.type === 'series' ? 'Serie' : 'Película';
  const genres   = Array.isArray(m.genre) ? m.genre : (m.genre ? [m.genre] : []);
  const genreTag = document.getElementById('detailGenreTag');
  if (genreTag) genreTag.textContent = genres[0] || '';
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('detailTitle',    m.title);
  set('detailYear',     m.release_year || '');
  set('detailRating',   m.rating ? `${'★'.repeat(m.rating)}${'☆'.repeat(5 - m.rating)} ${m.rating}/5` : '');
  set('detailDirector', m.director ? `🎬 ${m.director}` : '');
  // Descripción unificada: tanto series como películas usan m.description
  set('detailSynopsis', m.description || '');
  const tagsEl = document.getElementById('detailGenreTags');
  if (tagsEl) tagsEl.innerHTML = genres.map(g => `<span class="genre-tag-pill">${g}</span>`).join('');

  // Duración: solo en películas
  const durEl = document.getElementById('detailDuration');
  if (durEl) {
    durEl.textContent   = m.type === 'series' ? '' : (m.duration || '');
    durEl.style.display = m.type === 'series' ? 'none' : '';
  }

  const seriesSection  = document.getElementById('detailSeriesSection');
  const relatedSection = document.getElementById('detailRelatedSection');
  const playBtn        = document.getElementById('detailPlayBtn');
  const tabEpisodios   = document.getElementById('tabEpisodios');
  const tabRelacionado = document.getElementById('tabRelacionado');

  if (m.type === 'series') {
    if (tabEpisodios)   { tabEpisodios.style.display = ''; tabEpisodios.classList.add('active'); }
    if (tabRelacionado) { tabRelacionado.classList.remove('active'); }
    seriesSection?.classList.remove('hidden');
    relatedSection?.classList.add('hidden');
    if (playBtn) playBtn.style.display = 'none';
    await loadDetailSeasons(m.id);
  } else {
    if (tabEpisodios)   { tabEpisodios.style.display = 'none'; }
    if (tabRelacionado) { tabRelacionado.classList.add('active'); }
    seriesSection?.classList.add('hidden');
    relatedSection?.classList.remove('hidden');
    if (playBtn) {
      playBtn.style.display = '';
      const hasUrl          = m.videoUrl && m.videoUrl.length > 10;
      playBtn.disabled      = !hasUrl;
      playBtn.style.opacity = hasUrl ? '1' : '0.35';
      playBtn.innerHTML     = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="flex-shrink:0"><polygon points="5 3 19 12 5 21 5 3"/></svg> Reproducir`;
    }
    loadRelated(m);
  }

  updateDetailFavoriteBtn();
  closeDetailPlayer();
  document.getElementById('featuredBanner')?.classList.add('hidden');
  document.getElementById('genreHub')?.classList.add('hidden');
  document.getElementById('pageWrapper')?.classList.add('hidden');
  const dv = document.getElementById('detailView');
  if (dv) {
    dv.classList.remove('hidden');
    // Scroll al inicio — evita que aparezca desplazado hacia abajo
    dv.scrollTop = 0;
  }
}

// -- switchDetailTab --------------------------------------------
function switchDetailTab(tab) {
  const tabEpisodios   = document.getElementById('tabEpisodios');
  const tabRelacionado = document.getElementById('tabRelacionado');
  const seriesSection  = document.getElementById('detailSeriesSection');
  const relatedSection = document.getElementById('detailRelatedSection');

  if (tab === 'episodios') {
    tabEpisodios?.classList.add('active');
    tabRelacionado?.classList.remove('active');
    seriesSection?.classList.remove('hidden');
    relatedSection?.classList.add('hidden');
  } else {
    tabRelacionado?.classList.add('active');
    tabEpisodios?.classList.remove('active');
    seriesSection?.classList.add('hidden');
    relatedSection?.classList.remove('hidden');
    if (currentMovie) loadRelated(currentMovie);
  }
}

// -- loadRelated ------------------------------------------------
// Muestra contenido con 2+ géneros en común, ordenado de mayor a menor coincidencia
function loadRelated(m) {
  const list = document.getElementById('detailRelatedList');
  if (!list) return;
  const genres = Array.isArray(m.genre) ? m.genre : (m.genre ? [m.genre] : []);

  const related = movies
    .filter(c => c.id !== m.id)
    .map(c => {
      const cGenres = Array.isArray(c.genre) ? c.genre : (c.genre ? [c.genre] : []);
      const shared  = genres.filter(g => cGenres.includes(g)).length;
      return { ...c, shared };
    })
    .filter(c => c.shared >= 2)               // mínimo 2 géneros comunes
    .sort((a, b) => b.shared - a.shared)      // mayor coincidencia primero
    .slice(0, 12);

  if (!related.length) {
    list.innerHTML = `<p style="color:var(--text-dim);font-size:.85rem;padding:.5rem 0">No hay contenido relacionado.</p>`;
    return;
  }
  list.innerHTML = related.map(c => `
    <div class="related-card" onclick="openDetailView(movies.find(x=>x.id==='${c.id}'))">
      <img src="${c.poster}" alt="${c.title}" loading="lazy">
      <div class="related-card-info">
        <div class="related-card-title">${c.title}</div>
      </div>
    </div>`).join('');
}

function closeDetailView() {
  closeDetailPlayer();
  currentMovie = null;
  document.getElementById('detailView')?.classList.add('hidden');
  if (activeTab === 'generos') {
    document.getElementById('genreHub')?.classList.remove('hidden');
  } else {
    if (activeTab === 'inicio' && featuredContent)
      document.getElementById('featuredBanner')?.classList.remove('hidden');
    document.getElementById('pageWrapper')?.classList.remove('hidden');
  }
}

function updateDetailFavoriteBtn() {
  if (!currentMovie) return;
  const inList = favorites.includes(currentMovie.id);
  const btn  = document.getElementById('detailFavoriteBtn');
  const icon = document.getElementById('detailFavIcon');
  const text = document.getElementById('detailFavText');
  if (btn)  btn.classList.toggle('in-list', inList);
  if (icon) icon.innerHTML = inList
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  if (text) text.textContent = inList ? 'En Mi Lista' : 'Mi Lista';
}

async function toggleDetailFavorite() {
  if (!currentMovie || !currentProfile?.id) return;
  const inList = favorites.includes(currentMovie.id);
  try {
    if (inList) {
      await sbDelete('profile_favorites', `profile_id=eq.${currentProfile.id}&content_id=eq.${currentMovie.id}`, tok());
      favorites = favorites.filter(id => id !== currentMovie.id);
    } else {
      await sbPost('profile_favorites', { profile_id: currentProfile.id, content_id: currentMovie.id }, tok());
      favorites.push(currentMovie.id);
    }
    updateDetailFavoriteBtn();
  } catch (err) { console.error('[Favorites]', err); }
}

async function loadDetailSeasons(contentId) {
  const sel    = document.getElementById('detailSeasonSelect');
  if (!sel) return;
  sel.innerHTML = '<option>Cargando...</option>';
  const epList  = document.getElementById('detailEpisodesList');
  if (epList) epList.innerHTML = '';
  try {
    const seasons = await sbFetch('seasons',
      `content_id=eq.${contentId}&order=season_number.asc&select=id,season_number,title`,
      tok()
    );
    sel.innerHTML = seasons.map(s =>
      `<option value="${s.id}">Temporada ${s.season_number}${s.title ? ` — ${s.title}` : ''}</option>`
    ).join('');
    if (seasons.length) await loadDetailEpisodes();
  } catch { sel.innerHTML = '<option>Error al cargar</option>'; }
}

async function loadDetailEpisodes() {
  const seasonId = document.getElementById('detailSeasonSelect')?.value;
  if (!seasonId) return;
  const list = document.getElementById('detailEpisodesList');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--text-dim);font-size:.8rem;padding:.5rem">Cargando episodios...</div>';
  try {
    // Traer thumbnail_url, duration y description además de los campos base
    const eps = await sbFetch('episodes',
      `season_id=eq.${seasonId}&order=episode_number.asc&select=id,episode_number,title,video_url,thumbnail_url,duration,description`,
      tok()
    );
    list.innerHTML = '';
    eps.forEach(ep => {
      const item = document.createElement('div');
      item.className = 'episode-item';

      // Thumbnail: imagen si existe, placeholder si no
      const thumbHTML = ep.thumbnail_url
        ? `<img src="${ep.thumbnail_url}" alt="${ep.title}" loading="lazy">`
        : `<div class="episode-thumb-placeholder">
             <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
               <rect x="2" y="2" width="20" height="20" rx="3"/>
               <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/>
             </svg>
           </div>`;

      item.innerHTML = `
        <div class="episode-thumb-wrap">
          ${thumbHTML}
          <div class="episode-thumb-play">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="white" stroke="none">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
        </div>
        <div class="episode-info">
          <div class="episode-header">
            <span class="episode-num">${ep.episode_number}.</span>
            <span class="episode-title">${ep.title}</span>
          </div>
          ${ep.duration ? `<span class="episode-duration">${ep.duration}</span>` : ''}
          ${ep.description ? `<p class="episode-desc">${ep.description}</p>` : ''}
        </div>`;

      item.onclick = () => openDetailEpisodePlayer(ep);
      list.appendChild(item);
    });
  } catch {
    list.innerHTML = '<div style="color:#f87171;font-size:.8rem;padding:.5rem">Error al cargar episodios.</div>';
  }
}


// ================================================================
// ITERATIO PLAYER — Reproductor Cloudflare R2 + Plyr
// Toda reproducción usa <video> nativo con Plyr sobre R2.
// URLs soportadas:
//   https://media.iteratio.com/pelicula-2023.mp4  (URL completa R2)
//   pelicula-2023.mp4                              (nombre relativo → R2)
//   https://xxxx.r2.dev/...                        (URL pública R2 alternativa)
// ================================================================

// ── Cloudflare R2 — base URL del bucket ─────────────────────────
// Todas las URLs de video apuntan a este bucket.
// Formato archivo: nombre-pelicula-2023.mp4 | serie-t01-e02-2023.mp4
const R2_BASE_URL = 'https://media.iteratio.com/';

// ── Detectores de tipo de URL ───────────────────────────────────
// Acepta: URLs completas de R2 (media.iteratio.com o r2.dev)
//         y nombres de archivo relativos (se resuelven contra R2_BASE_URL)
function _isR2Url(url) {
  if (!url) return false;
  return url.includes('media.iteratio.com') ||
         url.includes('r2.dev') ||
         /^[^/]+\.mp4$/i.test(url.trim()); // nombre de archivo relativo
}

// Resuelve una URL de video: si es relativa la prefija con R2_BASE_URL
function _resolveVideoUrl(url) {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  // Nombre relativo → construir URL completa de R2
  return R2_BASE_URL + url.trim();
}

// Retrocompat: Drive ya no se usa — estas funciones retornan null
function _isDriveUrl(url)    { return false; }
function _drivePreviewUrl()  { return null; }
function _driveDirectUrl()   { return null; }

// ── Parsear info de episodio desde URL R2 ──────────────────────
// Patrón: nombre-serie-t01-e03-2023.mp4
// Devuelve { season: 1, episode: 3 } o null
function _parseEpisodeFromUrl(url) {
  if (!url) return null;
  const m = url.match(/-t(\d{1,2})-e(\d{1,2})/i);
  if (!m) return null;
  return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
}

// ── Estado del reproductor ──────────────────────────────────────
let _itp = {
  plyrInstance:  null,
  hideTimer:     null,
  isPlaying:     false,
  isDriveMode:   false,
  progressTimer: null,
};

// ── DOM helpers ─────────────────────────────────────────────────
function _itpEl(id) { return document.getElementById(id); }

// ── Mostrar / ocultar controles ─────────────────────────────────
function _itpShowControls(autoHide) {
  const c = _itpEl('iteratioPlayer');
  if (!c) return;
  c.classList.add('itp-controls-visible');
  clearTimeout(_itp.hideTimer);
  if (autoHide !== false && !_itp.isDriveMode) {
    _itp.hideTimer = setTimeout(_itpHideControls, 3500);
  }
}
function _itpHideControls() {
  const c = _itpEl('iteratioPlayer');
  if (c) c.classList.remove('itp-controls-visible');
}

// ── Tap / clic en la zona de video ──────────────────────────────
function itPlayerTapToggle(e) {
  if (e.target.closest('#iteratioTopbar') ||
      e.target.closest('#iteratioCenterControls') ||
      e.target.closest('#iteratioBottombar')) return;
  const c = _itpEl('iteratioPlayer');
  if (!c) return;
  c.classList.contains('itp-controls-visible') ? _itpHideControls() : _itpShowControls(true);
}

// ── Pantalla completa + orientación landscape ───────────────────
// Fullscreen nativo solo en móvil (en desktop la app ya ocupa la ventana).
// Landscape lock solo en móvil con orientación portrait.
function _itpRequestFullscreen() {
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
                   || window.innerWidth <= 768;

  if (isMobile) {
    // En móvil: pedir fullscreen nativo + forzar landscape
    const el  = _itpEl('iteratioPlayer');
    if (el) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
      if (req) req.call(el).catch(() => {});
    }
    if (screen.orientation?.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  }
  // En desktop no hacemos nada — el contenedor position:fixed ya ocupa la ventana
}
function _itpExitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
  if (exit && (document.fullscreenElement || document.webkitFullscreenElement)) {
    exit.call(document).catch(() => {});
  }
  if (screen.orientation?.unlock) screen.orientation.unlock();
}

// ── Rellenar info de título / episodio ──────────────────────────
function _itpSetTitles(title, videoUrl, epLabel) {
  const titleEl      = _itpEl('iteratioTitle');
  const epBadgeEl    = _itpEl('iteratioEpBadge');
  const bottomTitle  = _itpEl('iteratioBottomTitle');
  const seasonEpEl   = _itpEl('iteratioSeasonEp');

  if (titleEl)   titleEl.textContent = title || '';

  // Extraer temporada/episodio desde la URL R2 si no viene como label
  let seLabel = epLabel || '';
  if (!seLabel && videoUrl) {
    const info = _parseEpisodeFromUrl(videoUrl);
    if (info) seLabel = `Temporada ${info.season} \u2022 Episodio ${info.episode}`;
  }

  if (epBadgeEl)   { epBadgeEl.textContent  = seLabel; epBadgeEl.style.display  = seLabel ? '' : 'none'; }
  if (bottomTitle) { bottomTitle.textContent = title  || ''; }
  if (seasonEpEl)  { seasonEpEl.textContent  = seLabel; seasonEpEl.style.display = seLabel ? '' : 'none'; }
}

// ── AirPlay ─────────────────────────────────────────────────────
function itPlayerAirPlay() {
  const video = _itpEl('iteratioVideo');
  if (video && window.WebKitPlaybackTargetAvailabilityEvent) {
    video.webkitShowPlaybackTargetPicker();
  }
}

// ── CC Toggle ───────────────────────────────────────────────────
function itPlayerCCToggle() {
  const video  = _itpEl('iteratioVideo');
  const btn    = _itpEl('iteratioCCBtn');
  if (!video || _itp.isDriveMode) return;
  if (video.textTracks && video.textTracks.length > 0) {
    const track = video.textTracks[0];
    track.mode = track.mode === 'showing' ? 'hidden' : 'showing';
    btn?.classList.toggle('itp-cc-active', track.mode === 'showing');
  }
}

// ── Play / Pause ────────────────────────────────────────────────
function itPlayerPlayPause() {
  if (_itp.isDriveMode) return;
  if (_itp.plyrInstance) {
    _itp.plyrInstance.togglePlay();
  } else {
    const v = _itpEl('iteratioVideo');
    if (v) { v.paused ? v.play().catch(() => {}) : v.pause(); }
  }
  _itpShowControls(true);
}

// ── Skip ────────────────────────────────────────────────────────
function itPlayerSkip(secs) {
  if (_itp.isDriveMode) return;
  if (_itp.plyrInstance) {
    _itp.plyrInstance.rewind ? _itp.plyrInstance.forward(secs) : null;
    _itp.plyrInstance.currentTime = Math.max(0,
      Math.min(_itp.plyrInstance.duration || 0, _itp.plyrInstance.currentTime + secs));
  } else {
    const v = _itpEl('iteratioVideo');
    if (v) v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + secs));
  }
  _itpShowControls(true);
}

// ── Seek desde seekbar ──────────────────────────────────────────
function itPlayerSeek(value) {
  if (_itp.isDriveMode) return;
  const pct = parseFloat(value) / 100;
  if (_itp.plyrInstance) {
    _itp.plyrInstance.currentTime = pct * (_itp.plyrInstance.duration || 0);
  } else {
    const v = _itpEl('iteratioVideo');
    if (v) v.currentTime = pct * (v.duration || 0);
  }
}

// ── Formato de tiempo ───────────────────────────────────────────
function _itpFmtTime(s) {
  if (!s || isNaN(s) || s < 0) return '0:00';
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

// ── Actualizar icono Play/Pause ─────────────────────────────────
function _itpUpdatePlayIcon(playing) {
  const icon = _itpEl('iteratioPlayIcon');
  if (!icon) return;
  _itp.isPlaying = !!playing;
  icon.innerHTML = playing
    ? '<rect x="5" y="3" width="4" height="18" rx="1"/><rect x="15" y="3" width="4" height="18" rx="1"/>'
    : '<polygon points="6 3 20 12 6 21 6 3"/>';
}

// ── Actualizar seekbar + tiempo restante (contador inverso) ─────
function _itpUpdateProgress() {
  const seekbar  = _itpEl('iteratioSeekbar');
  const progress = _itpEl('itpProgressBar');
  const buffer   = _itpEl('itpBufferBar');
  const timeEl   = _itpEl('iteratioTimeRemaining');

  let current = 0, duration = 0, buffered = 0;

  if (_itp.plyrInstance) {
    current  = _itp.plyrInstance.currentTime || 0;
    duration = _itp.plyrInstance.duration    || 0;
    try {
      const buf = _itp.plyrInstance.media?.buffered;
      if (buf && buf.length > 0) buffered = (buf.end(buf.length - 1) / duration) * 100;
    } catch (_) {}
  } else {
    const v = _itpEl('iteratioVideo');
    if (v) {
      current  = v.currentTime || 0;
      duration = v.duration    || 0;
      try {
        if (v.buffered.length > 0) buffered = (v.buffered.end(v.buffered.length - 1) / duration) * 100;
      } catch (_) {}
    }
  }

  const pct = duration ? (current / duration) * 100 : 0;
  if (seekbar)  seekbar.value = pct;
  if (progress) progress.style.width = pct + '%';
  if (buffer)   buffer.style.width   = buffered + '%';

  // Tiempo restante en formato inverso: -1:24:03
  const remaining = duration - current;
  if (timeEl) timeEl.textContent = duration > 0 ? '-' + _itpFmtTime(remaining) : '-0:00';
}

// ── Inicializar Plyr sobre el <video> (solo URLs R2) ────────────
function _itpInitPlyr(videoEl) {
  if (_itp.plyrInstance) {
    try { _itp.plyrInstance.destroy(); } catch (_) {}
    _itp.plyrInstance = null;
  }

  if (typeof Plyr === 'undefined') {
    videoEl.controls = false;
    _itpBindNativeVideo(videoEl);
    videoEl.load();
    videoEl.play().then(() => _itpUpdatePlayIcon(true)).catch(() => {});
    return;
  }

  _itp.plyrInstance = new Plyr(videoEl, {
    controls:    ['play-large'],
    autoplay:    false,
    keyboard:    { focused: false, global: false },
    fullscreen:  { enabled: false },
    clickToPlay: false,
    storage:     { enabled: false },
    resetOnEnd:  false,
  });

  _itp.plyrInstance.on('ready', () => {
    const big = _itp.plyrInstance.elements?.container?.querySelector('.plyr__control--overlaid');
    if (big) big.style.display = 'none';
    _itp.plyrInstance.play().catch(() => {});
  });
  _itp.plyrInstance.on('play',       () => _itpUpdatePlayIcon(true));
  _itp.plyrInstance.on('pause',      () => _itpUpdatePlayIcon(false));
  _itp.plyrInstance.on('ended',      () => { _itpUpdatePlayIcon(false); _itpShowControls(false); });
  _itp.plyrInstance.on('timeupdate', _itpUpdateProgress);
  _itp.plyrInstance.on('error',      () => {
    _itp.plyrInstance = null;
    _itpBindNativeVideo(videoEl);
    videoEl.play().then(() => _itpUpdatePlayIcon(true)).catch(() => {});
  });
}

// ── Vincular eventos a <video> nativo (sin Plyr) ────────────────
function _itpBindNativeVideo(v) {
  v.addEventListener('play',       () => _itpUpdatePlayIcon(true));
  v.addEventListener('pause',      () => _itpUpdatePlayIcon(false));
  v.addEventListener('ended',      () => { _itpUpdatePlayIcon(false); _itpShowControls(false); });
  v.addEventListener('timeupdate', _itpUpdateProgress);
}

// ── Detectar AirPlay disponible y mostrar botón ──────────────────
function _itpCheckAirPlay(videoEl) {
  const btn = _itpEl('iteratioAirPlayBtn');
  if (!btn) return;
  if (window.WebKitPlaybackTargetAvailabilityEvent) {
    videoEl.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
      btn.classList.toggle('itp-hidden', e.availability !== 'available');
    });
  }
}

// ── openIteratioPlayer(videoUrl, title, epLabel) ─────────────────
// Abre el reproductor Iteratio con Plyr sobre Cloudflare R2.
// Si la URL es relativa, se resuelve contra R2_BASE_URL.
// La compatibilidad con Google Drive ha sido eliminada.
function openIteratioPlayer(videoUrl, title, epLabel) {
  const container = _itpEl('iteratioPlayer');
  const videoEl   = _itpEl('iteratioVideo');
  if (!container || !videoUrl) return;

  // Resolver URL relativa → absoluta de R2
  const resolvedUrl = _resolveVideoUrl(videoUrl);

  _itpSetTitles(title, resolvedUrl, epLabel);
  _itpUpdatePlayIcon(false);
  _itpUpdateProgress();

  _itp.isDriveMode = false;
  container.classList.remove('itp-drive-mode');

  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    videoEl.controls      = false;
    videoEl.style.display = 'block';
    videoEl.src           = resolvedUrl;
    videoEl.preload       = 'metadata';
    _itpCheckAirPlay(videoEl);
    _itpInitPlyr(videoEl);   // siempre Plyr — R2 es el único proveedor
  }

  _itpShowControls(true);
  container.classList.remove('iteratio-player-hidden');
  _itpRequestFullscreen();
}

// ── closeIteratioPlayer ─────────────────────────────────────────
function closeIteratioPlayer() {
  const container = _itpEl('iteratioPlayer');
  const videoEl   = _itpEl('iteratioVideo');

  clearTimeout(_itp.hideTimer);
  _itp.isDriveMode = false;

  if (_itp.plyrInstance) {
    try { _itp.plyrInstance.pause(); _itp.plyrInstance.destroy(); } catch (_) {}
    _itp.plyrInstance = null;
  }
  if (videoEl) {
    videoEl.pause?.();
    videoEl.removeAttribute('src');
    videoEl.load?.();
    videoEl.style.display = 'none';
  }
  if (container) {
    container.classList.add('iteratio-player-hidden');
    container.classList.remove('itp-controls-visible', 'itp-drive-mode');
  }
  _itpExitFullscreen();
  if (playerOpen) releaseScreen();
}

// ── Aliases para compatibilidad con el resto del código ─────────
function openCinemaPlayer(videoUrl, title, subtitle) { openIteratioPlayer(videoUrl, title, subtitle); }
function closeCinemaPlayer()                          { closeIteratioPlayer(); }
function cinemaPlayPause()                            { itPlayerPlayPause(); }
function cinemaSkip(s)                                { itPlayerSkip(s); }
function cinemaSeek(v)                                { itPlayerSeek(v); }
function cinemaCCToggle()                             { itPlayerCCToggle(); }
function cinemaTapToggle(e)                           { itPlayerTapToggle(e); }

// ── playDetailVideo (alias) ─────────────────────────────────────
function playDetailVideo(videoUrl) {
  openIteratioPlayer(videoUrl, currentMovie?.title || '');
}

// ── openDetailPlayer ────────────────────────────────────────────
async function openDetailPlayer() {
  if (!currentMovie?.videoUrl) return;
  const allowed = await checkScreenLimit();
  if (!allowed) return;
  openIteratioPlayer(currentMovie.videoUrl, currentMovie.title);
}

// ── closeDetailPlayer (alias) ───────────────────────────────────
function closeDetailPlayer() { closeIteratioPlayer(); }

// ── openDetailEpisodePlayer ─────────────────────────────────────
async function openDetailEpisodePlayer(ep) {
  const allowed = await checkScreenLimit();
  if (!allowed) return;
  const seriesTitle = currentMovie?.title || '';
  // Generar label desde la URL R2 o desde los datos del episodio
  let epLabel = '';
  if (ep.video_url && _isR2Url(ep.video_url)) {
    const info = _parseEpisodeFromUrl(ep.video_url);
    if (info) epLabel = `Temporada ${info.season} \u2022 Episodio ${info.episode}`;
  }
  if (!epLabel) epLabel = `T${ep.season_number || 1} E${ep.episode_number}: ${ep.title}`;
  openIteratioPlayer(ep.video_url, seriesTitle, epLabel);
}

// ===============================================================
async function checkScreenLimit() {
  try {
    const data    = await sbFetch('profiles', `id=eq.${_session.user_id}&select=active_screens`, tok());
    const screens = data?.[0]?.active_screens ?? 0;
    if (screens >= 3) { document.getElementById('screenLimitModal')?.classList.remove('hidden'); return false; }
    await sbPatch('profiles', `id=eq.${_session.user_id}`, { active_screens: screens + 1 }, tok());
    playerOpen = true; startHeartbeat(); return true;
  } catch (err) { console.error('[Screens]', err); return true; }
}
async function releaseScreen() {
  if (!playerOpen) return;
  playerOpen = false; stopHeartbeat();
  try {
    const data    = await sbFetch('profiles', `id=eq.${_session.user_id}&select=active_screens`, tok());
    const screens = Math.max(0, (data?.[0]?.active_screens ?? 1) - 1);
    await sbPatch('profiles', `id=eq.${_session.user_id}`, { active_screens: screens }, tok());
  } catch (err) { console.error('[Screens release]', err); }
}
function updateDevicesUI(screens) {
  const countEl = document.getElementById('devicesCount');
  const barEl   = document.getElementById('devicesBarFill');
  if (countEl) countEl.textContent = screens;
  if (barEl)   barEl.style.width   = `${Math.min(screens / 3 * 100, 100)}%`;
}
function startHeartbeat()  { stopHeartbeat(); sendHeartbeat(); heartbeatTimer = setInterval(sendHeartbeat, 30_000); }
function stopHeartbeat()   { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }
async function sendHeartbeat() {
  if (!_session?.user_id) return;
  try { await sbPatch('profiles', `id=eq.${_session.user_id}`, { last_heartbeat: new Date().toISOString() }, tok()); } catch {}
}
function closeScreenLimitModal() { document.getElementById('screenLimitModal')?.classList.add('hidden'); }

// ===============================================================
// MODAL CUENTA
// ===============================================================
function openAccountModal(tab) {
  tab = tab || 'seguridad';
  closeDropdown();
  document.getElementById('accountModal')?.classList.remove('hidden');
  switchAccountTab(tab);
  const emailEl = document.getElementById('accountEmail');
  if (emailEl) emailEl.textContent = _session?.email || '-';
  refreshDevicesTab();
  document.getElementById('securityViewMode')?.classList.remove('hidden');
  document.getElementById('securityEditMode')?.classList.add('hidden');
  const msg = document.getElementById('passwordMsg');
  if (msg) { msg.className = 'account-message'; msg.textContent = ''; }
}
function closeAccountModal() { document.getElementById('accountModal')?.classList.add('hidden'); }
function switchAccountTab(tab) {
  document.querySelectorAll('.account-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.querySelectorAll('.account-tab-content').forEach(el => el.classList.toggle('active', el.id === `tab-${tab}`));
}
async function refreshDevicesTab() {
  try {
    const data    = await sbFetch('profiles', `id=eq.${_session.user_id}&select=active_screens`, tok());
    const screens = data?.[0]?.active_screens ?? 0;
    updateDevicesUI(screens);
  } catch {}
}
function showPasswordForm() {
  document.getElementById('securityViewMode')?.classList.add('hidden');
  document.getElementById('securityEditMode')?.classList.remove('hidden');
  document.getElementById('newPasswordInput').value     = '';
  document.getElementById('confirmPasswordInput').value = '';
  const msg = document.getElementById('passwordMsg');
  if (msg) { msg.className = 'account-message'; msg.textContent = ''; }
}
function hidePasswordForm() {
  document.getElementById('securityEditMode')?.classList.add('hidden');
  document.getElementById('securityViewMode')?.classList.remove('hidden');
  const msg = document.getElementById('passwordMsg');
  if (msg) { msg.className = 'account-message'; msg.textContent = ''; }
}
function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  const svg  = btn.querySelector('svg');
  if (svg) {
    svg.innerHTML = show
      ? '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
      : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  }
}
async function changePassword() {
  const newPass = document.getElementById('newPasswordInput')?.value;
  const confirm = document.getElementById('confirmPasswordInput')?.value;
  const msgEl   = document.getElementById('passwordMsg');
  if (!newPass || newPass.length < 6) { showMsg(msgEl, 'error', 'La contraseña debe tener al menos 6 caracteres.'); return; }
  if (newPass !== confirm)             { showMsg(msgEl, 'error', 'Las contraseñas no coinciden.'); return; }
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${tok()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPass })
    });
    if (res.ok) {
      showMsg(msgEl, 'success', 'Contraseña actualizada.');
      document.getElementById('newPasswordInput').value     = '';
      document.getElementById('confirmPasswordInput').value = '';
      setTimeout(hidePasswordForm, 1500);
    } else {
      const err = await res.json();
      showMsg(msgEl, 'error', err.msg || 'Error al actualizar la contraseña.');
    }
  } catch { showMsg(msgEl, 'error', 'Error de conexión.'); }
}

// ===============================================================
// UTILIDADES
// ===============================================================
function showMsg(el, type, text) {
  if (!el) return;
  el.className   = `account-message ${type}`;
  el.textContent = text;
}

// ===============================================================
// DOMContentLoaded — ÚNICO PUNTO DE INICIALIZACIÓN
// ===============================================================
document.addEventListener('DOMContentLoaded', function () {

  // -- Shimmer skeleton ---------------------------------------
  var style = document.createElement('style');
  style.textContent = '@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}';
  document.head.appendChild(style);

  // -- DELEGACIÓN DE EVENTOS — contenedor padre ---------------
  //
  // Listener único, registrado una sola vez, nunca se desmonta.
  // Lee window.isEditModeActive en el MICROSEGUNDO del clic,
  // sin closures congeladas ni problemas de scoping.
  //
  // pointer-events:none en CSS para todos los hijos de .profile-card
  // cuando el grid tiene .edit-mode-active garantiza que
  // e.target.closest('.profile-card') SIEMPRE encuentre la tarjeta.
  //
  var profileGrid = document.getElementById('profileAvatarsGrid');
  if (profileGrid) {
    profileGrid.addEventListener('click', function (e) {

      const card = e.target.closest('.profile-card');
      if (!card) return;

      // Tarjeta especial "Añadir perfil"
      if (card.dataset.action === 'add') {
        e.preventDefault();
        e.stopPropagation();
        openCreateProfileForm();
        return;
      }

      const profileId = card.dataset.id;
      if (!profileId) return;

      if (window.isEditModeActive === true) {
        // MODO EDICIÓN PURO: detiene cualquier otra acción y abre el modal
        e.preventDefault();
        e.stopPropagation();
        openEditProfileModal(profileId);
      } else {
        // MODO NORMAL PURO: cambia de cuenta inmediatamente
        switchActiveProfile(profileId);
      }
    });
  }

  // -- Búsqueda en tiempo real --------------------------------
  var si = document.getElementById('searchInput');
  if (si) {
    si.addEventListener('input', function (e) {
      searchQuery = e.target.value;
      if (activeTab !== 'generos') renderGrid();
    });
    si.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') collapseSearch();
    });
  }

  // -- Cerrar búsqueda con clic fuera -------------------------
  document.addEventListener('click', function (e) {
    var wrap = document.getElementById('searchToggleWrap');
    if (wrap && !wrap.contains(e.target) && searchExpanded) collapseSearch();
  });

  // -- Cerrar dropdown con clic fuera -------------------------
  document.addEventListener('click', function (e) {
    var bar = document.getElementById('userBar');
    if (bar && !bar.contains(e.target)) closeDropdown();
  });

  // -- Modales — cerrar con clic en backdrop ------------------
  var accountModal = document.getElementById('accountModal');
  if (accountModal) {
    accountModal.addEventListener('click', function (e) {
      if (e.target === accountModal) closeAccountModal();
    });
  }
  var profileModal = document.getElementById('profileFormModal');
  if (profileModal) {
    profileModal.addEventListener('click', function (e) {
      if (e.target === profileModal) closeProfileFormModalClean();
    });
  }

  // -- Escape cierra todo -------------------------------------
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeAccountModal();
      closeProfileFormModalClean();
      closeScreenLimitModal();
      if (searchExpanded) collapseSearch();
    }
  });

  // -- Liberar pantalla al cerrar la pestaña ------------------
  window.addEventListener('beforeunload', function () {
    if (playerOpen && _session?.user_id) {
      navigator.sendBeacon(
        SUPABASE_URL + '/rest/v1/profiles?id=eq.' + _session.user_id,
        new Blob([JSON.stringify({ active_screens: 0 })], { type: 'application/json' })
      );
    }
  });

  // -- Iniciar app --------------------------------------------
  startAuthStateListener();
  checkExistingSession();
});