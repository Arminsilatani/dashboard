const SUPABASE_URL = 'https://vzqicidepdmraygulrey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kqRWgOmLISOE2EuLL1s8fw_WN6FJRTI';
const TELEGRAM_BOT_ID = '5933108036';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// helpers
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

let currentUser = null;
let editingUserId = null;
let openTicketId = null;

function showLoader() {
  document.getElementById('global-loader').classList.remove('hidden');
}
function hideLoader() {
  document.getElementById('global-loader').classList.add('hidden');
}

// Telegram Auth
window.onTelegramAuth = async function(user) {
  showLoader();
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';

  try {
    const params = new URLSearchParams(user);
    const res = await fetch(`${SUPABASE_URL}/functions/v1/telegram-auth?${params.toString()}`);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || 'Telegram login failed');
    }

    const { access_token, refresh_token } = await res.json();
    const { error } = await sb.auth.setSession({ access_token, refresh_token });
    if (error) throw error;

    const { data: { user: authUser }, error: getUserError } = await sb.auth.getUser();
    if (getUserError || !authUser) throw new Error('Could not fetch authenticated user');

    let profile = await db.select('profiles', `id=eq.${authUser.id}`);
    if (!profile || !profile.length) {
      const meta = authUser.user_metadata || {};
      const newProfile = {
        id: authUser.id,
        first_name: meta.first_name || '',
        last_name: meta.last_name || '',
        username: meta.username || '',
        role: 'user',
        created_at: new Date().toISOString()
      };
      await db.insert('profiles', newProfile);
      currentUser = newProfile;
    } else {
      currentUser = profile[0];
    }

    hideLoader();
    showApp();

  } catch (e) {
    console.error(e);
    errEl.textContent = e.message || 'Login failed';
    hideLoader();
    await sb.auth.signOut().catch(() => {});
  }
};

async function signOut() {
  await sb.auth.signOut();
  currentUser = null;
}

window.addEventListener('DOMContentLoaded', async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    try {
      let profile = await db.select('profiles', `id=eq.${session.user.id}`);
      if (profile && profile.length) {
        currentUser = profile[0];
        showApp();
      } else {
        await sb.auth.signOut();
        showAuth();
      }
    } catch (e) {
      console.error('Boot error:', e);
      showAuth();
    }
  } else {
    showAuth();
  }
  bindEvents();
});

function showAuth() {
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('app-screen').classList.remove('active');
}
function showApp() {
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('app-screen').classList.add('active');

  const name = [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ') || currentUser.username || 'User';
  document.getElementById('sidebar-name').textContent = name;
  document.getElementById('sidebar-role').textContent = currentUser.role || 'user';
  const av = document.getElementById('sidebar-avatar');
  av.src = currentUser.photo_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=4ECDC4&color=0d0d0d`;

  if (currentUser.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  }
  loadSection('tickets');
}

function loadSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`section-${name}`).classList.add('active');
  document.querySelector(`.nav-item[data-section="${name}"]`).classList.add('active');

  if (name === 'tickets') loadTickets();
  if (name === 'messages') loadMessages();
  if (name === 'contracts') loadContracts();
  if (name === 'connections') loadConnections();
  if (name === 'users') loadUsers();
}

function bindEvents() {
  document.getElementById('signout-btn').addEventListener('click', async () => {
    await signOut();
    showAuth();
  });
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => loadSection(btn.dataset.section));
  });

  // Tickets
  document.getElementById('new-ticket-btn').addEventListener('click', () => {
    document.getElementById('new-ticket-form').classList.remove('hidden');
  });
  document.getElementById('cancel-ticket-btn').addEventListener('click', () => {
    document.getElementById('new-ticket-form').classList.add('hidden');
  });
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
  document.getElementById('cancel-msg-btn').addEventListener('click', () => {
    document.getElementById('send-message-modal').classList.add('hidden');
  });
  document.getElementById('submit-msg-btn').addEventListener('click', submitMessage);

  // Contracts
  document.getElementById('new-section-btn').addEventListener('click', () => {
    document.getElementById('add-section-modal').classList.remove('hidden');
  });
  document.getElementById('cancel-section-btn').addEventListener('click', () => {
    document.getElementById('add-section-modal').classList.add('hidden');
  });
  document.getElementById('submit-section-btn').addEventListener('click', submitSection);
  document.getElementById('new-contract-btn').addEventListener('click', openAddContractModal);
  document.getElementById('cancel-contract-btn').addEventListener('click', () => {
    document.getElementById('add-contract-modal').classList.add('hidden');
  });
  document.getElementById('submit-contract-btn').addEventListener('click', submitContract);

  // Connections
  document.getElementById('new-conn-btn').addEventListener('click', openConnModal);
  document.getElementById('cancel-conn-btn').addEventListener('click', () => {
    document.getElementById('send-conn-modal').classList.add('hidden');
  });
  document.getElementById('submit-conn-btn').addEventListener('click', submitConnRequest);

  // Users
  document.getElementById('cancel-edit-user-btn').addEventListener('click', () => {
    document.getElementById('edit-user-modal').classList.add('hidden');
  });
  document.getElementById('save-user-btn').addEventListener('click', saveUser);
}

// (تمامی توابع loadTickets, openTicket, submitTicket, … بدون تغییر از نسخه قبلی)
// برای جلوگیری از طولانی شدن این پاسخ، آن‌ها را دقیقاً از فایل JS قبلی خود کپی کنید.

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}