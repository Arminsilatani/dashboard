const SUPABASE_URL = 'https://vzqicidepdmraygulrey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kqRWgOmLISOE2EuLL1s8fw_WN6FJRTI';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Helpers ─────────────────────────────────────────────────
async function getToken() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token || null;
}

async function sbFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const token = await getToken();
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${token || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': opts.prefer || 'return=representation',
    ...opts.headers
  };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error_description || res.statusText);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const db = {
  select: (table, query = '') => sbFetch(`${table}?${query}`),
  insert: (table, body) => sbFetch(table, { method: 'POST', body: JSON.stringify(body) }),
  update: (table, id, body) => sbFetch(`${table}?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (table, id) => sbFetch(`${table}?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
};

// ── State ───────────────────────────────────────────────────
let currentUser = null;
let editingUserId = null;
let openTicketId = null;

// ── Loader ──────────────────────────────────────────────────
function showLoader() {
  const globalLoader = document.getElementById('global-loader');
  if (globalLoader) globalLoader.classList.remove('hidden');
  const initialLoader = document.getElementById('initial-loader');
  if (initialLoader) initialLoader.classList.remove('hidden');
}

function hideLoader() {
  const globalLoader = document.getElementById('global-loader');
  if (globalLoader) globalLoader.classList.add('hidden');
  const initialLoader = document.getElementById('initial-loader');
  if (initialLoader) initialLoader.classList.add('hidden');
}

// ── Boot ────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const connectToken = urlParams.get('connect');
  const refUserId = urlParams.get('ref');
  if (refUserId) {
    sessionStorage.setItem('pendingRef', refUserId);
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    try {
      let profile = await db.select('profiles', `id=eq.${session.user.id}`);
      if (profile && profile.length) {
        currentUser = profile[0];
        showApp();
        if (connectToken) {
          await processConnectToken(connectToken);
        }
      } else {
        await sb.auth.signOut();
        showAuth();
        if (connectToken) sessionStorage.setItem('pendingConnectToken', connectToken);
      }
    } catch (e) {
      console.error('Boot error:', e);
      showAuth();
      if (connectToken) sessionStorage.setItem('pendingConnectToken', connectToken);
    }
  } else {
    showAuth();
    if (connectToken) sessionStorage.setItem('pendingConnectToken', connectToken);
  }
  bindEvents();
  initAuthListeners();
});

function showAuth() {
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('app-screen').classList.remove('active');
  showStep('step-1');
  document.getElementById('auth-email').value = '';
  document.getElementById('auth-error').textContent = '';
  const successMsg = document.getElementById('auth-success-msg');
  if (successMsg) successMsg.style.display = 'none';
}

async function showApp() {
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('app-screen').classList.add('active');
  await refreshCurrentUser();
  updateSidebarUI();

  document.getElementById('section-dashboard').classList.add('active');
  loadSection('dashboard');
  updateNotificationBadge();
}

async function refreshCurrentUser() {
  if (!currentUser?.id) return;
  const res = await db.select('profiles', `id=eq.${currentUser.id}`);
  if (res && res.length) currentUser = res[0];
  const { data: { user } } = await sb.auth.getUser();
  if (user?.email) currentUser.email = user.email;
}

function updateSidebarUI() {
  const name = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ') || 'User';
  document.getElementById('sidebar-name').textContent = name;
  document.getElementById('sidebar-role').textContent = currentUser.role || 'viewer';
  const av = document.getElementById('sidebar-avatar');
  av.src = currentUser.photo_url || generateAvatarUrl(name);
  if (currentUser.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  }
}

// ── Auth Flow ────────────────────────────────────────────────
let authEmail = '';

function showStep(stepId) {
  document.querySelectorAll('.auth-step').forEach(el => el.classList.add('hidden'));
  document.getElementById(stepId)?.classList.remove('hidden');
}

function initAuthListeners() {
  document.getElementById('auth-continue-btn')?.addEventListener('click', async function () {
    const email = document.getElementById('auth-email').value.trim();
    const errorEl = document.getElementById('auth-error');
    if (!email) { errorEl.textContent = 'Please enter an email.'; return; }
    authEmail = email;
    showLoader();
    try {
      const { data: exists, error: rpcError } = await sb.rpc('check_email_exists', { email_to_check: email });
      if (rpcError) throw rpcError;
      if (exists) {
        document.getElementById('auth-user-email').textContent = email;
        showStep('step-2-login');
      } else {
        showStep('step-2-register');
        document.getElementById('reg-form-fields').style.display = '';
        document.getElementById('reg-success').style.display = 'none';
      }
      errorEl.textContent = '';
    } catch (e) { errorEl.textContent = 'Something went wrong. Try again.'; }
    finally { hideLoader(); }
  });

  document.getElementById('auth-signin-btn')?.addEventListener('click', async function () {
    const email = authEmail, password = document.getElementById('auth-password').value,
          errorEl = document.getElementById('auth-error-login');
    if (!email || !password) { errorEl.textContent = 'Please enter your password.'; return; }
    showLoader();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    hideLoader();
    if (error) { errorEl.textContent = error.message; return; }
    currentUser = await fetchProfile(data.user);
    if (!currentUser) { errorEl.textContent = 'Unable to load profile.'; return; }

    // به‌روزرسانی referred_by برای کاربر فعلی (در صورت نیاز)
    const pendingRef = sessionStorage.getItem('pendingRef');
    if (pendingRef && !currentUser.referred_by) {
      await db.update('profiles', currentUser.id, { referred_by: pendingRef });
      try {
        await addNotification(pendingRef, 'system', 'Someone joined via your link', '', '#connections');
      } catch(e) {}
    }

    showApp();

    const pendingToken = sessionStorage.getItem('pendingConnectToken');
    if (pendingToken) {
      sessionStorage.removeItem('pendingConnectToken');
      await processConnectToken(pendingToken);
    }
  });

  document.getElementById('auth-forgot-link')?.addEventListener('click', function (e) {
    e.preventDefault();
    document.getElementById('forgot-email').value = authEmail;
    showStep('step-forgot');
  });

  document.getElementById('auth-send-reset-btn')?.addEventListener('click', async function () {
    const email = document.getElementById('forgot-email').value.trim();
    if (!email) return;
    showLoader();
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    hideLoader();
    if (error) {
      document.getElementById('auth-error-login').textContent = error.message;
      return;
    }
    document.getElementById('auth-success-msg').textContent = 'Password reset link sent.';
    document.getElementById('auth-success-msg').style.display = 'block';
  });

  document.getElementById('auth-back-to-login')?.addEventListener('click', e => {
    e.preventDefault();
    showStep('step-2-login');
  });

  document.getElementById('auth-register-btn')?.addEventListener('click', async function () {
    const firstname = document.getElementById('reg-firstname').value.trim(),
          lastname = document.getElementById('reg-lastname').value.trim(),
          password = document.getElementById('reg-password').value,
          confirm = document.getElementById('reg-confirm').value,
          errorEl = document.getElementById('auth-error-register');

    const nameRegex = /^[A-Za-z]+$/;
    if (!nameRegex.test(firstname)) {
      errorEl.textContent = 'First name must contain only English letters.';
      return;
    }
    if (!nameRegex.test(lastname)) {
      errorEl.textContent = 'Last name must contain only English letters.';
      return;
    }

    if (!firstname || !lastname || !password || !confirm) {
      errorEl.textContent = 'All fields are required.';
      return;
    }
    if (password !== confirm) {
      errorEl.textContent = 'Passwords do not match.';
      return;
    }

    showLoader();

    const pendingToken = sessionStorage.getItem('pendingConnectToken') || '';
    const pendingRef = sessionStorage.getItem('pendingRef') || '';
    const redirectBase = window.location.origin + window.location.pathname;
    let redirectUrl = redirectBase;
    if (pendingToken && pendingRef) {
      redirectUrl = `${redirectBase}?connect=${pendingToken}&ref=${pendingRef}`;
    } else if (pendingToken) {
      redirectUrl = `${redirectBase}?connect=${pendingToken}`;
    } else if (pendingRef) {
      redirectUrl = `${redirectBase}?ref=${pendingRef}`;
    }

    const { error } = await sb.auth.signUp({
      email: authEmail,
      password,
      options: {
        data: { first_name: firstname, last_name: lastname },
        emailRedirectTo: redirectUrl
      }
    });

    hideLoader();

    if (error) {
      errorEl.textContent = error.message;
      return;
    }

    document.getElementById('reg-form-fields').style.display = 'none';
    document.getElementById('reg-success').style.display = 'block';
    errorEl.textContent = '';
  });

  document.getElementById('reg-to-login-btn')?.addEventListener('click', () => {
    document.getElementById('auth-user-email').textContent = authEmail;
    showStep('step-2-login');
  });

  document.querySelectorAll('.auth-step').forEach(step => step.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const map = {
        'step-1': 'auth-continue-btn',
        'step-2-login': 'auth-signin-btn',
        'step-2-register': 'auth-register-btn',
        'step-forgot': 'auth-send-reset-btn'
      };
      document.getElementById(map[step.id])?.click();
    }
  }));

  document.querySelectorAll('.toggle-password-btn').forEach(btn => btn.addEventListener('click', function () {
    const input = document.getElementById(this.dataset.target);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    this.innerHTML = isPassword
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="m14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  }));
}

// ── createInviteConnection (بدون تغییر) ───────────────────
async function createInviteConnection(referrerId, newUserId) {
  try {
    const existing = await db.select('dashboard_connectionrequests',
      `or=(and(from_id.eq.${referrerId},to_id.eq.${newUserId}),and(from_id.eq.${newUserId},to_id.eq.${referrerId}))`);
    if (existing && existing.length > 0) return;

    await db.insert('dashboard_connectionrequests', {
      from_id: referrerId,
      to_id: newUserId,
      status: 'pending'
    });

    let referrerName = 'Someone';
    try {
      const referrerProf = await db.select('profiles',
        `id=eq.${referrerId}&select=first_name,last_name`);
      if (referrerProf?.[0]) {
        referrerName = [referrerProf[0].first_name, referrerProf[0].last_name]
                        .filter(Boolean).join(' ') || 'Someone';
      }
    } catch (profileError) {
      console.warn('Could not fetch referrer profile, using default name:', profileError);
    }

    await addNotification(newUserId, 'connection', 'New connection request',
      `${referrerName} wants to connect with you`, '#connections');
    await addNotification(referrerId, 'connection', 'Connection request sent',
      `Request sent to new user`, '#connections');

    await refreshNotificationUI();
  } catch (e) {
    console.error('Failed to create invite connection:', e);
  }
}

// ── fetchProfile (تنها نسخه) ─────────────────────────────
async function fetchProfile(authUser) {
  let profile = await db.select('profiles', `id=eq.${authUser.id}`);
  if (profile && profile.length) return profile[0];

  const meta = authUser.user_metadata || {};
  const pendingRef = sessionStorage.getItem('pendingRef');
  const newProfileData = {
    id: authUser.id,
    first_name: meta.first_name || '',
    last_name: meta.last_name || '',
    username: meta.username || '',
    role: 'viewer',
    created_at: new Date().toISOString()
  };

  if (pendingRef) {
    newProfileData.referred_by = pendingRef;
    try {
      await addNotification(pendingRef, 'system',
        'New user joined via your link', '', '#connections');
    } catch(e) {}
  }

  const [newProfile] = await db.insert('profiles', newProfileData);

  if (pendingRef) {
    await createInviteConnection(pendingRef, newProfile.id);
    sessionStorage.removeItem('pendingRef'); // پاک‌سازی بعد از انجام کامل
  }

  return newProfile;
}

async function signOut() {
  await sb.auth.signOut();
  currentUser = null;
  showAuth();
}

// ── Navigation ──────────────────────────────────────────────
function loadSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`section-${name}`)?.classList.add('active');
  document.querySelector(`.nav-item[data-section="${name}"]`)?.classList.add('active');
  if (name === 'dashboard') loadDashboard();
  if (name === 'tickets') loadTickets();
  if (name === 'messages') loadMessages();
  if (name === 'contracts') loadContracts();
  if (name === 'connections') loadConnections();
  if (name === 'users') loadUsers();
}

// ── Events ──────────────────────────────────────────────────
let cropper = null, pendingPhotoFile = null;

function bindEvents() {
  document.getElementById('signout-btn').addEventListener('click', async () => {
    await signOut();
    showAuth();
  });
  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => loadSection(btn.dataset.section)));
  document.querySelectorAll('.card-heading.clickable').forEach(el => el.addEventListener('click', () => {
    const nav = el.dataset.nav;
    if (nav) loadSection(nav);
  }));
  document.getElementById('sidebar-profile-trigger')?.addEventListener('click', () => {
    if (!currentUser) return;
    loadSection('dashboard');
  });

  // Profile Edit Modal
  document.getElementById('open-edit-profile-btn')?.addEventListener('click', async () => {
    if (!currentUser) return;
    showLoader();
    try {
      await refreshCurrentUser();
      document.getElementById('edit-first-name').value = currentUser.first_name || '';
      document.getElementById('edit-last-name').value = currentUser.last_name || '';
      document.getElementById('edit-email').value = currentUser.email || '';
      document.getElementById('edit-phone').value = currentUser.phone || '';
      document.getElementById('edit-website').value = currentUser.website || '';
      document.getElementById('edit-avatar-preview').src = currentUser.photo_url || generateAvatarUrl(currentUser.first_name || 'U');
      document.getElementById('edit-photo-input').value = '';
      pendingPhotoFile = null;
      document.getElementById('edit-profile-modal').classList.remove('hidden');
    } catch (err) {
      console.error('Error opening profile modal:', err);
    } finally {
      hideLoader();
    }
  });

  document.getElementById('cancel-edit-profile-btn')?.addEventListener('click', () =>
    document.getElementById('edit-profile-modal').classList.add('hidden'));

  document.getElementById('edit-photo-input')?.addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('crop-image').src = e.target.result;
      document.getElementById('crop-modal').classList.remove('hidden');
      if (cropper) cropper.destroy();
      cropper = new Cropper(document.getElementById('crop-image'), { aspectRatio: 1, viewMode: 1, autoCropArea: 0.8 });
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('cancel-crop-btn')?.addEventListener('click', () => {
    document.getElementById('crop-modal').classList.add('hidden');
    if (cropper) { cropper.destroy(); cropper = null; }
    document.getElementById('edit-photo-input').value = '';
  });

  document.getElementById('confirm-crop-btn')?.addEventListener('click', () => {
    if (!cropper) return;
    const canvas = cropper.getCroppedCanvas({ width: 500, height: 500 });
    canvas.toBlob((blob) => {
      pendingPhotoFile = new File([blob], `avatar_${Date.now()}.webp`, { type: 'image/webp' });
      document.getElementById('edit-avatar-preview').src = URL.createObjectURL(blob);
      document.getElementById('crop-modal').classList.add('hidden');
      cropper.destroy(); cropper = null;
    }, 'image/webp', 0.75);
  });

  document.getElementById('crop-modal')?.addEventListener('click', function (e) {
    if (e.target === this) {
      this.classList.add('hidden');
      if (cropper) { cropper.destroy(); cropper = null; }
      document.getElementById('edit-photo-input').value = '';
    }
  });

  document.getElementById('save-profile-btn')?.addEventListener('click', async () => {
    const first = document.getElementById('edit-first-name').value.trim();
    const last = document.getElementById('edit-last-name').value.trim();
    const email = document.getElementById('edit-email').value.trim();
    const phone = document.getElementById('edit-phone').value.trim();
    const website = document.getElementById('edit-website').value.trim();
    let photo_url = currentUser.photo_url;

    if (pendingPhotoFile) {
      const filePath = `avatars/${currentUser.id}/avatar.webp`;
      try {
        showLoader();
        const { error: uploadError } = await sb.storage.from('avatars').upload(filePath, pendingPhotoFile, { upsert: true, contentType: 'image/webp' });
        if (uploadError) throw uploadError;
        const { data: { publicUrl } } = sb.storage.from('avatars').getPublicUrl(filePath);
        photo_url = publicUrl + '?v=' + Date.now();
        pendingPhotoFile = null;
      } catch (err) {
        alert('Photo upload failed: ' + err.message);
        hideLoader();
        return;
      }
    }

    const body = { updated_at: new Date().toISOString() };
    if (first !== (currentUser.first_name || '')) body.first_name = first;
    if (last !== (currentUser.last_name || '')) body.last_name = last;
    if (email !== (currentUser.email || '')) body.email = email;
    if (phone !== (currentUser.phone || '')) body.phone = phone;
    if (website !== (currentUser.website || '')) body.website = website;
    if (photo_url !== currentUser.photo_url) body.photo_url = photo_url;

    try {
      showLoader();
      await db.update('profiles', currentUser.id, body);
      await refreshCurrentUser();
      updateSidebarUI();
      document.getElementById('dash-fullname').textContent = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ') || 'User';
      document.getElementById('dash-avatar').src = currentUser.photo_url
        || generateAvatarUrl(currentUser.first_name || 'U');
      document.getElementById('dash-email').textContent = currentUser.email || '—';
      document.getElementById('dash-phone').textContent = currentUser.phone || '—';
      document.getElementById('dash-website').textContent = currentUser.website || '—';
      document.getElementById('edit-profile-modal').classList.add('hidden');
    } catch (err) {
      alert(err.message);
    } finally {
      hideLoader();
    }
  });

  document.getElementById('edit-profile-modal')?.addEventListener('click', function (e) {
    if (e.target === this) this.classList.add('hidden');
  });

  // Tickets
  document.getElementById('new-ticket-btn').addEventListener('click', () => document.getElementById('new-ticket-form').classList.remove('hidden'));
  document.getElementById('cancel-ticket-btn').addEventListener('click', () => document.getElementById('new-ticket-form').classList.add('hidden'));
  document.getElementById('submit-ticket-btn').addEventListener('click', submitTicket);
  document.getElementById('back-tickets-btn').addEventListener('click', () => {
    document.getElementById('ticket-thread').classList.add('hidden');
    document.getElementById('ticket-list').classList.remove('hidden');
    openTicketId = null;
  });
  document.getElementById('send-reply-btn').addEventListener('click', sendReply);
  document.getElementById('close-ticket-btn').addEventListener('click', closeTicket);

  // Messages
  document.getElementById('new-message-btn')?.addEventListener('click', openSendMessageModal);
  document.getElementById('cancel-msg-btn').addEventListener('click', () => document.getElementById('send-message-modal').classList.add('hidden'));
  document.getElementById('submit-msg-btn').addEventListener('click', submitMessage);

  // Contracts
  document.getElementById('new-section-btn').addEventListener('click', () => document.getElementById('add-section-modal').classList.remove('hidden'));
  document.getElementById('cancel-section-btn').addEventListener('click', () => document.getElementById('add-section-modal').classList.add('hidden'));
  document.getElementById('submit-section-btn').addEventListener('click', submitSection);
  document.getElementById('new-contract-btn').addEventListener('click', openAddContractModal);
  document.getElementById('cancel-contract-btn').addEventListener('click', () => document.getElementById('add-contract-modal').classList.add('hidden'));
  document.getElementById('submit-contract-btn').addEventListener('click', submitContract);

  // Connections
  let searchTimeout;
  const searchInput = document.getElementById('conn-search-input');
  const searchResults = document.getElementById('conn-search-results');

  searchInput?.addEventListener('input', function () {
    clearTimeout(searchTimeout);
    const term = this.value.trim();
    if (!term) {
      searchResults.style.display = 'none';
      return;
    }
    searchTimeout = setTimeout(() => searchProfiles(term), 300);
  });

  document.getElementById('big-invite-btn')?.addEventListener('click', () => {
    const link = `${window.location.origin}${window.location.pathname}?ref=${currentUser.id}`;
    document.getElementById('conn-share-link').value = link;
    document.getElementById('conn-link-modal').classList.remove('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.conn-search-bar')) {
      searchResults.style.display = 'none';
    }
  });

  document.getElementById('copy-conn-link-btn')?.addEventListener('click', () => {
    const linkInput = document.getElementById('conn-share-link');
    linkInput.select();
    document.execCommand('copy');
    alert('Link copied to clipboard!');
  });

  document.getElementById('close-conn-link-modal-btn')?.addEventListener('click', () => {
    document.getElementById('conn-link-modal').classList.add('hidden');
  });
  document.getElementById('conn-link-modal')?.addEventListener('click', function (e) {
    if (e.target === this) this.classList.add('hidden');
  });

  // Users (Admin)
  document.getElementById('cancel-edit-user-btn').addEventListener('click', () =>
    document.getElementById('edit-user-modal').classList.add('hidden'));
  document.getElementById('save-user-btn').addEventListener('click', saveUser);
}

// ── DASHBOARD ───────────────────────────────────────────────
async function loadDashboard() {
  if (!currentUser) return;
  await refreshCurrentUser();
  const name = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ') || 'User';
  document.getElementById('dash-fullname').textContent = name;
  document.getElementById('dash-role-badge').textContent = currentUser.role || 'viewer';
  document.getElementById('dash-email').textContent = currentUser.email || '—';
  document.getElementById('dash-phone').textContent = currentUser.phone || '—';
  document.getElementById('dash-website').textContent = currentUser.website || '—';
  document.getElementById('dash-avatar').src = currentUser.photo_url || generateAvatarUrl(name);
  await Promise.all([loadMiniCalendar(), loadNotifications()]);
  updateNotificationBadge();
}

async function loadMiniCalendar() {
  const container = document.getElementById('dash-mini-calendar');
  if (!container) return;
  const now = new Date(), year = now.getFullYear(), month = now.getMonth(), today = now.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate(), firstDay = new Date(year, month, 1).getDay();
  let monthEvents = [];
  try {
    const start = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const end = `${year}-${String(month + 1).padStart(2, '0')}-${daysInMonth}`;
    monthEvents = (await db.select('ravlo', `user_id=eq.${currentUser.id}&start_date=gte.${start}&start_date=lte.${end}`)) || [];
  } catch (e) {}
  const eventDays = new Set(monthEvents.map(ev => new Date(ev.start_date).getDate()));
  const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  let html = dayNames.map(d => `<div class="mini-cal-header">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="mini-cal-day"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    let cls = 'mini-cal-day';
    if (d === today) cls += ' today';
    if (eventDays.has(d)) cls += ' has-event';
    html += `<div class="${cls}">${d}</div>`;
  }
  container.innerHTML = html;
}

async function loadNotifications() {
  const c = document.getElementById('dash-notif-list');
  if (!c) return;

  try {
    const notifs = await db.select('notifications', `user_id=eq.${currentUser.id}&order=created_at.desc&limit=5`);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const todayStr = today.toISOString().split('T')[0];
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    let calendarEvents = [];
    try {
      calendarEvents = await db.select('ravlo', `user_id=eq.${currentUser.id}&start_date=gte.${todayStr}&start_date=lte.${tomorrowStr}&order=start_date.asc`);
    } catch (e) {}

    const calendarNotifs = (calendarEvents || []).map(ev => ({
      type: 'calendar',
      title: ev.title || 'Calendar Event',
      body: ev.start_date ? fmtDate(ev.start_date) : '',
      created_at: ev.start_date,
      is_read: true
    }));

    const allNotifs = [...(notifs || []), ...calendarNotifs]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5);

    if (!allNotifs.length) {
      c.innerHTML = '<p class="empty-state">No notifications</p>';
      return;
    }

    c.innerHTML = allNotifs.map(n => {
      const dotClass = {
        calendar: 'notif-dot-calendar',
        contract: 'notif-dot-contract',
        message: 'notif-dot-message',
        ticket: 'notif-dot-ticket',
        connection: 'notif-dot-connection',
        system: 'notif-dot-system'
      }[n.type] || 'notif-dot-system';

      return `<div class="mini-item ${n.is_read ? '' : 'unread-notif'}" data-link="${esc(n.link || '')}">
        <div style="display:flex;align-items:center;">
          <span class="notif-dot-icon ${dotClass}"></span>
          ${esc(n.title)}
        </div>
        <div class="mini-meta">${esc(n.body || '')} · ${fmtDate(n.created_at)}</div>
      </div>`;
    }).join('');

  } catch (e) {
    c.innerHTML = '<div class="mini-item"><div><span class="notif-dot-icon notif-dot-system"></span>Welcome to your dashboard!</div><div class="mini-meta">Just now</div></div>';
  }

  c.addEventListener('click', (e) => {
    const item = e.target.closest('.mini-item');
    if (!item) return;
    const link = item.dataset.link;
    if (link) {
      const section = link.replace('#', '');
      if (section && typeof loadSection === 'function') {
        loadSection(section);
      }
    }
  });
}

// ── TICKETS ─────────────────────────────────────────────────
async function loadTickets() {
  const list = document.getElementById('ticket-list');
  document.getElementById('ticket-thread').classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const q = currentUser.role === 'admin' ? 'order=created_at.desc' : `user_id=eq.${currentUser.id}&order=created_at.desc`;
    const tickets = await db.select('tickets', q);
    if (!tickets || !tickets.length) { list.innerHTML = '<div class="empty-state">No tickets yet.</div>'; return; }
    const uids = [...new Set(tickets.map(t => t.user_id))];
    const profiles = await db.select('profiles', `id=in.(${uids.join(',')})&select=id,first_name,last_name,username`);
    const pMap = {}; (profiles || []).forEach(p => { pMap[p.id] = p; });
    list.innerHTML = '';
    tickets.forEach(t => {
      const p = pMap[t.user_id] || {};
      const uname = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || t.user_id;
      const card = document.createElement('div'); card.className = 'card';
      card.innerHTML = `<div><div class="card-title">${esc(t.subject)}</div><div class="card-sub">By ${esc(uname)} · ${fmtDate(t.created_at)}</div></div><span class="badge badge-${t.status}">${t.status}</span>`;
      card.addEventListener('click', () => openTicket(t));
      list.appendChild(card);
    });
  } catch (e) { list.innerHTML = `<div class="empty-state">${e.message}</div>`; }
}

async function openTicket(ticket) {
  openTicketId = ticket.id;
  document.getElementById('ticket-list').classList.add('hidden');
  document.getElementById('ticket-thread').classList.remove('hidden');
  document.getElementById('thread-subject').textContent = ticket.subject;
  const msgs = document.getElementById('thread-messages'); msgs.innerHTML = 'Loading...';
  try {
    const rows = await db.select('ticket_messages', `ticket_id=eq.${ticket.id}&order=created_at.asc`);
    const sids = [...new Set((rows || []).map(r => r.sender_id).filter(Boolean))];
    let pMap = {};
    if (sids.length) {
      const profs = await db.select('profiles', `id=in.(${sids.join(',')})&select=id,first_name,last_name,username`);
      (profs || []).forEach(p => { pMap[p.id] = p; });
    }
    msgs.innerHTML = '';
    (rows || []).forEach(r => {
      const mine = r.sender_id === currentUser.id;
      const p = pMap[r.sender_id] || {};
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || 'Unknown';
      const b = document.createElement('div'); b.className = `msg-bubble ${mine ? 'mine' : 'theirs'}`;
      b.innerHTML = `<div class="msg-sender">${esc(name)}</div><div class="msg-text">${esc(r.body)}</div><div class="msg-time">${fmtDate(r.created_at)}</div>`;
      msgs.appendChild(b);
    });
    msgs.scrollTop = msgs.scrollHeight;
    if (currentUser.role === 'admin') document.getElementById('close-ticket-btn').classList.toggle('hidden', ticket.status === 'closed');
  } catch (e) { msgs.innerHTML = e.message; }
}

async function submitTicket() {
  const subject = document.getElementById('ticket-subject').value.trim();
  const body = document.getElementById('ticket-body').value.trim();
  if (!subject || !body) return;
  try {
    const [ticket] = await db.insert('tickets', { user_id: currentUser.id, subject });
    await db.insert('ticket_messages', { ticket_id: ticket.id, sender_id: currentUser.id, body });
    try {
      const admins = await db.select('profiles', 'role=eq.admin&select=id');
      const userName = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ') || 'User';
      for (const admin of (admins || [])) {
        await addNotification(admin.id, 'ticket', 'New support ticket', `${userName}: ${subject}`, `#tickets/${ticket.id}`);
      }
    } catch (e) {}
    document.getElementById('ticket-subject').value = '';
    document.getElementById('ticket-body').value = '';
    document.getElementById('new-ticket-form').classList.add('hidden');
    loadTickets();
  } catch (e) { alert(e.message); }
}

async function sendReply() {
  const body = document.getElementById('reply-body').value.trim();
  if (!body || !openTicketId) return;
  try {
    await db.insert('ticket_messages', { ticket_id: openTicketId, sender_id: currentUser.id, body });
    const tickets = await db.select('tickets', `id=eq.${openTicketId}`);
    if (tickets && tickets[0]) {
      const ticket = tickets[0];
      const senderName = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ') || 'Someone';
      if (currentUser.role === 'admin') {
        await addNotification(ticket.user_id, 'ticket', 'New reply to your ticket', body.substring(0, 100), `#tickets/${openTicketId}`);
      } else {
        try {
          const admins = await db.select('profiles', 'role=eq.admin&select=id');
          for (const admin of (admins || [])) {
            await addNotification(admin.id, 'ticket', `Reply from ${senderName}`, body.substring(0, 100), `#tickets/${openTicketId}`);
          }
        } catch (e) {}
      }
    }
    document.getElementById('reply-body').value = '';
    if (tickets && tickets[0]) openTicket(tickets[0]);
  } catch (e) { alert(e.message); }
}

async function closeTicket() {
  if (!openTicketId) return;
  try {
    await db.update('tickets', openTicketId, { status: 'closed' });
    const tickets = await db.select('tickets', `id=eq.${openTicketId}`);
    if (tickets && tickets[0]) {
      await addNotification(tickets[0].user_id, 'ticket', 'Ticket closed', 'Your ticket has been resolved', '#tickets');
    }
    document.getElementById('close-ticket-btn').classList.add('hidden');
    alert('Ticket closed.');
  } catch (e) { alert(e.message); }
}

// ── MESSAGES ────────────────────────────────────────────────
async function loadMessages() {
  const list = document.getElementById('message-list'); list.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const q = currentUser.role === 'admin'
      ? `from_id=eq.${currentUser.id}&order=created_at.desc`
      : `to_id=eq.${currentUser.id}&order=created_at.desc`;
    const msgs = await db.select('messages', q);
    if (!msgs || !msgs.length) { list.innerHTML = '<div class="empty-state">No messages.</div>'; return; }
    const ids = [...new Set([...msgs.map(m => m.from_id), ...msgs.map(m => m.to_id)].filter(Boolean))];
    const profs = await db.select('profiles', `id=in.(${ids.join(',')})&select=id,first_name,last_name,username`);
    const pMap = {}; (profs || []).forEach(p => { pMap[p.id] = p; });
    list.innerHTML = '';
    msgs.forEach(m => {
      const from = pMap[m.from_id] || {}, to = pMap[m.to_id] || {};
      const fromName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';
      const toName = [to.first_name, to.last_name].filter(Boolean).join(' ') || to.username || 'Unknown';
      const card = document.createElement('div'); card.className = 'card';
      card.innerHTML = `<div><div class="card-title">${esc(m.body.substring(0, 80))}${m.body.length > 80 ? '…' : ''}</div><div class="card-sub">From ${esc(fromName)} → ${esc(toName)} · ${fmtDate(m.created_at)}</div></div>${!m.read && currentUser.role !== 'admin' ? '<span class="badge badge-unread">New</span>' : ''}`;
      if (!m.read && m.to_id === currentUser.id) db.update('messages', m.id, { read: true }).catch(() => {});
      list.appendChild(card);
    });
  } catch (e) { list.innerHTML = `<div class="empty-state">${e.message}</div>`; }
}

async function openSendMessageModal() {
  const modal = document.getElementById('send-message-modal'), sel = document.getElementById('msg-to-select');
  sel.innerHTML = '<option value="">Loading...</option>'; modal.classList.remove('hidden');
  try {
    const users = await db.select('profiles', 'order=first_name.asc');
    sel.innerHTML = '';
    (users || []).filter(u => u.id !== currentUser.id).forEach(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || u.email;
      const opt = document.createElement('option'); opt.value = u.id; opt.textContent = name; sel.appendChild(opt);
    });
  } catch (e) { sel.innerHTML = `<option>${e.message}</option>`; }
}

async function submitMessage() {
  const to_id = document.getElementById('msg-to-select').value;
  const body = document.getElementById('msg-body').value.trim();
  if (!to_id || !body) return;
  try {
    await db.insert('messages', { from_id: currentUser.id, to_id, body });
    const senderName = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ') || 'Someone';
    await addNotification(to_id, 'message', `New message from ${senderName}`, body.substring(0, 100), '#messages');
    document.getElementById('msg-body').value = '';
    document.getElementById('send-message-modal').classList.add('hidden');
    loadMessages();
  } catch (e) { alert(e.message); }
}

// ── CONTRACTS ────────────────────────────────────────────────
async function loadContracts() {
  const list = document.getElementById('contracts-list'); list.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const sections = await db.select('contract_sections', 'order=created_at.asc');
    const contracts = await db.select('contracts', 'order=created_at.asc');
    if (!sections || !sections.length) { list.innerHTML = '<div class="empty-state">No sections yet.</div>'; return; }
    list.innerHTML = '';
    sections.forEach(sec => {
      const files = (contracts || []).filter(c => c.section_id === sec.id);
      const block = document.createElement('div'); block.className = 'contract-section-block';
      const filesHtml = files.length
        ? files.map(f => `<div class="contract-file"><span>${esc(f.title)}</span><a href="${esc(f.file_url)}" target="_blank" rel="noopener">Open ↗</a></div>`).join('')
        : `<div class="contract-file"><span style="color:var(--muted)">No files in this section.</span></div>`;
      block.innerHTML = `<div class="contract-section-header"><span>📂 ${esc(sec.title)}</span><span style="color:var(--muted);font-size:12px">${files.length} file${files.length !== 1 ? 's' : ''}</span></div><div class="contract-files">${filesHtml}</div>`;
      const hdr = block.querySelector('.contract-section-header'), bdy = block.querySelector('.contract-files');
      hdr.addEventListener('click', () => { bdy.style.display = bdy.style.display === 'none' ? '' : 'none'; });
      list.appendChild(block);
    });
  } catch (e) { list.innerHTML = `<div class="empty-state">${e.message}</div>`; }
}

async function submitSection() {
  const title = document.getElementById('section-title-input').value.trim(); if (!title) return;
  try {
    await db.insert('contract_sections', { title });
    document.getElementById('section-title-input').value = '';
    document.getElementById('add-section-modal').classList.add('hidden');
    loadContracts();
  } catch (e) { alert(e.message); }
}

async function openAddContractModal() {
  const modal = document.getElementById('add-contract-modal'), sel = document.getElementById('contract-section-select');
  sel.innerHTML = '<option value="">Loading...</option>'; modal.classList.remove('hidden');
  try {
    const sections = await db.select('contract_sections', 'order=title.asc');
    sel.innerHTML = '';
    (sections || []).forEach(s => {
      const opt = document.createElement('option'); opt.value = s.id; opt.textContent = s.title; sel.appendChild(opt);
    });
  } catch (e) { sel.innerHTML = `<option>${e.message}</option>`; }
}

async function submitContract() {
  const section_id = document.getElementById('contract-section-select').value;
  const title = document.getElementById('contract-title-input').value.trim();
  const file_url = document.getElementById('contract-url-input').value.trim();
  if (!section_id || !title || !file_url) return;
  try {
    await db.insert('contracts', { section_id, title, file_url });
    document.getElementById('contract-title-input').value = '';
    document.getElementById('contract-url-input').value = '';
    document.getElementById('add-contract-modal').classList.add('hidden');
    loadContracts();
  } catch (e) { alert(e.message); }
}

// ── CONNECTIONS ─────────────────────────────────────────────
async function searchProfiles(term) {
  const resultsDiv = document.getElementById('conn-search-results');
  resultsDiv.style.display = 'block';
  resultsDiv.innerHTML = '<div class="empty-state">Searching...</div>';
  try {
    const query = `or=(first_name.ilike.*${term}*,last_name.ilike.*${term}*,username.ilike.*${term}*)&order=first_name.asc&limit=10`;
    const profiles = await db.select('profiles', query);
    if (!profiles || !profiles.length) {
      resultsDiv.innerHTML = '<div class="empty-state">No users found.</div>';
      return;
    }
    const connections = await db.select('dashboard_connectionrequests',
      `or=(from_id.eq.${currentUser.id},to_id.eq.${currentUser.id})&status=eq.accepted`);
    const connectedIds = new Set((connections || []).flatMap(r => [r.from_id, r.to_id]));

    resultsDiv.innerHTML = '';
    profiles.forEach(p => {
      if (p.id === currentUser.id) return;
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || 'User';
      const isConnected = connectedIds.has(p.id);
      const div = document.createElement('div');
      div.className = 'card';
      div.innerHTML = `
        <div>
          <div class="card-title">${esc(name)}</div>
          <div class="card-sub">${esc(p.username || p.email || '')}</div>
        </div>
        ${isConnected
          ? '<span class="badge badge-accepted">Connected</span>'
          : `<button class="btn-accent send-conn-btn" data-uid="${p.id}">Send Request</button>`
        }
      `;
      resultsDiv.appendChild(div);
    });

    document.querySelectorAll('.send-conn-btn').forEach(btn => {
      btn.addEventListener('click', () => sendConnectionRequest(btn.dataset.uid));
    });
  } catch (e) {
    resultsDiv.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
  }
}

async function sendConnectionRequest(toUserId) {
  try {
    const [newReq] = await db.insert('dashboard_connectionrequests', {
      from_id: currentUser.id,
      to_id: toUserId,
      status: 'pending'
    });
    const base = `${window.location.origin}${window.location.pathname}`;
    const link = `${base}?connect=${newReq.id}`;
    document.getElementById('conn-share-link').value = link;
    document.getElementById('conn-link-modal').classList.remove('hidden');
    const senderName = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ') || 'Someone';
    await addNotification(toUserId, 'connection', 'New connection request', `${senderName} wants to connect`, '#connections');
    document.getElementById('conn-search-results').style.display = 'none';
    document.getElementById('conn-search-input').value = '';
    loadConnections();
  } catch (e) {
    alert('Failed to send request: ' + e.message);
  }
}

async function processConnectToken(requestId) {
  try {
    const reqs = await db.select('dashboard_connectionrequests', `id=eq.${requestId}`);
    if (!reqs || !reqs.length) {
      alert('Invalid or expired connection request.');
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }
    const request = reqs[0];
    if (request.to_id !== currentUser.id) {
      alert('This invitation is not for you.');
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }
    if (request.status !== 'pending') {
      alert(`This request has already been ${request.status}.`);
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }
    const accept = confirm('You have a connection invitation. Do you want to accept?');
    const newStatus = accept ? 'accepted' : 'rejected';
    await db.update('dashboard_connectionrequests', requestId, { status: newStatus });

    const responderName = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ') || 'Someone';
    await addNotification(request.from_id, 'connection',
      accept ? 'Connection accepted!' : 'Connection declined',
      accept ? `${responderName} accepted your request` : `${responderName} declined your request`,
      '#connections'
    );
    alert(`Request ${newStatus}.`);
    window.history.replaceState({}, document.title, window.location.pathname);
    loadSection('connections');
  } catch (e) {
    alert('Error processing invitation: ' + e.message);
  }
}

async function loadConnections() {
  const list = document.getElementById('connections-list');
  const reqList = document.getElementById('conn-requests-list');
  const bigBtn = document.getElementById('conn-invite-big-btn');
  list.innerHTML = '<div class="empty-state">Loading connections...</div>';
  reqList.innerHTML = '';

  try {
    const all = await db.select('dashboard_connectionrequests', `or=(from_id.eq.${currentUser.id},to_id.eq.${currentUser.id})&order=created_at.desc`);
    const ids = [...new Set((all || []).flatMap(r => [r.from_id, r.to_id]))];
    let pMap = {};
    if (ids.length) {
      const profs = await db.select('profiles', `id=in.(${ids.join(',')})&select=id,first_name,last_name,username`);
      (profs || []).forEach(p => { pMap[p.id] = p; });
    }
    const accepted = (all || []).filter(r => r.status === 'accepted');
    const pending = (all || []).filter(r => r.status === 'pending');

    if (accepted.length === 0 && pending.length === 0) {
      if (bigBtn) bigBtn.style.display = 'block';
    } else {
      if (bigBtn) bigBtn.style.display = 'none';
    }

    if (!accepted.length) {
      list.innerHTML = '<div class="empty-state">No connections yet.</div>';
    } else {
      list.innerHTML = '<div style="color:var(--muted);font-size:12px;margin-bottom:6px">Connected</div>';
      accepted.forEach(r => {
        const otherId = r.from_id === currentUser.id ? r.to_id : r.from_id;
        const p = pMap[otherId] || {};
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || otherId;
        const card = document.createElement('div'); card.className = 'card';
        card.innerHTML = `<div><div class="card-title">${esc(name)}</div></div><span class="badge badge-accepted">Connected</span>`;
        list.appendChild(card);
      });
    }

    if (pending.length) {
      const header = document.createElement('div');
      header.style.cssText = 'color:var(--muted);font-size:12px;margin:14px 0 6px';
      header.textContent = 'Pending Requests';
      reqList.appendChild(header);
      pending.forEach(r => {
        const isIncoming = r.to_id === currentUser.id;
        const otherId = isIncoming ? r.from_id : r.to_id;
        const p = pMap[otherId] || {};
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || otherId;
        const card = document.createElement('div'); card.className = 'card'; card.style.flexWrap = 'wrap';
        card.innerHTML = `<div><div class="card-title">${isIncoming ? 'From' : 'To'}: ${esc(name)}</div><div class="card-sub">${fmtDate(r.created_at)}</div></div><div style="display:flex;gap:8px">${isIncoming ? `<button class="btn-accent" onclick="respondConn('${r.id}','accepted')">Accept</button><button class="btn-ghost" onclick="respondConn('${r.id}','rejected')">Reject</button>` : `<span class="badge badge-pending">Pending</span>`}</div>`;
        reqList.appendChild(card);
      });
    }
  } catch (e) {
    list.innerHTML = `<div class="empty-state">${e.message}</div>`;
    if (bigBtn) bigBtn.style.display = 'none';
  }
}

async function respondConn(id, status) {
  try {
    await db.update('dashboard_connectionrequests', id, { status });
    const reqs = await db.select('dashboard_connectionrequests', `id=eq.${id}`);
    if (reqs && reqs[0]) {
      const req = reqs[0];
      const responderName = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ') || 'Someone';
      const otherPerson = req.from_id === currentUser.id ? req.to_id : req.from_id;
      if (status === 'accepted') {
        await addNotification(otherPerson, 'connection', 'Connection accepted!', `${responderName} accepted your request`, '#connections');
      } else {
        await addNotification(otherPerson, 'connection', 'Connection declined', `${responderName} declined your request`, '#connections');
      }
    }
    loadConnections();
  } catch (e) { alert(e.message); }
}

// ── USERS (Admin) ────────────────────────────────────────────
async function loadUsers() {
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '<tr><td colspan="8" style="color:var(--muted)">Loading...</td></tr>'; // colspan = 8

  try {
    const users = await db.select('profiles', 'order=created_at.desc');

    const referrals = await db.select('profiles', 'referred_by=neq.null&select=referred_by');
    const countMap = {};
    (referrals || []).forEach(r => {
      if (r.referred_by) {
        countMap[r.referred_by] = (countMap[r.referred_by] || 0) + 1;
      }
    });

    tbody.innerHTML = '';
    (users || []).forEach(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || '—';
      const invitedCount = countMap[u.id] || 0;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(name)}</td>
        <td>${esc(u.username || '—')}</td>
        <td>${esc(u.email || '—')}</td>
        <td><span class="badge ${u.role === 'admin' ? 'badge-accepted' : 'badge-open'}">${esc(u.role || 'user')}</span></td>
        <td>${esc(u.telegram_id || '—')}</td>
        <td>${fmtDate(u.created_at)}</td>
        <td>${invitedCount}</td> <!-- ستون جدید -->
        <td><button class="btn-ghost" onclick="openEditUser('${u.id}')">Edit</button></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8">${e.message}</td></tr>`; // colspan = 8
  }
}

async function openEditUser(uid) {
  editingUserId = uid;
  try {
    const [u] = await db.select('profiles', `id=eq.${uid}`);
    document.getElementById('edit-user-first-name').value = u.first_name || '';
    document.getElementById('edit-user-last-name').value = u.last_name || '';
    document.getElementById('edit-user-username').value = u.username || '';
    document.getElementById('edit-user-role').value = u.role || 'user';
    document.getElementById('edit-user-telegram').value = u.telegram_id || '';
    document.getElementById('edit-user-modal').classList.remove('hidden');
  } catch (e) { alert(e.message); }
}

async function saveUser() {
  if (!editingUserId) return;
  const body = {
    first_name: document.getElementById('edit-user-first-name').value.trim(),
    last_name: document.getElementById('edit-user-last-name').value.trim(),
    username: document.getElementById('edit-user-username').value.trim(),
    role: document.getElementById('edit-user-role').value,
    telegram_id: document.getElementById('edit-user-telegram').value.trim(),
    updated_at: new Date().toISOString()
  };
  try {
    await db.update('profiles', editingUserId, body);
    document.getElementById('edit-user-modal').classList.add('hidden');
    loadUsers();
  } catch (e) { alert(e.message); }
}

// ── Notification Helper ──────────────────────────────────────
async function addNotification(userId, type, title, body = '', link = '') {
  console.log('addNotification called with:', { userId, type, title, body, link });
  try {
    const url = `${SUPABASE_URL}/rest/v1/notifications`;
    const token = await getToken();
    console.log('Token:', token ? 'exists' : 'null');
    const headers = {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token || SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    };
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ user_id: userId, type, title, body, link })
    });
    console.log('Notification response status:', res.status);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Notification insert failed:', err);
    } else {
      console.log('Notification inserted successfully');
    }
  } catch (e) {
    console.error('Notification error:', e);
  }
}

// ── به‌روزرسانی نشان و لیست اعلان‌ها (برای کاربر جاری) ─────
async function refreshNotificationUI() {
  await updateNotificationBadge();
  const dashSection = document.getElementById('section-dashboard');
  if (dashSection && dashSection.classList.contains('active')) {
    await loadNotifications();
  }
}

// ── Notification Badge ──────────────────────────────────────
async function updateNotificationBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  try {
    const notifs = await db.select('notifications', `user_id=eq.${currentUser.id}&is_read=eq.false&select=id`);
    const unreadCount = (notifs || []).length;
    if (unreadCount > 0) {
      badge.classList.add('active');
    } else {
      badge.classList.remove('active');
    }
  } catch (e) {
    badge.classList.remove('active');
  }
}

// ── Utils ────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function generateAvatarUrl(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 100;
  canvas.height = 100;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4ECDC4';
  ctx.fillRect(0, 0, 100, 100);
  ctx.fillStyle = '#0d0d0d';
  ctx.font = 'bold 40px Kalameh, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const initials = name.split(' ').map(w => w[0]?.toUpperCase()).join('').slice(0, 2);
  ctx.fillText(initials || '?', 50, 50);
  return canvas.toDataURL();
}