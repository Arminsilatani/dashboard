const SUPABASE_URL = 'https://vzqicidepdmraygulrey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kqRWgOmLISOE2EuLL1s8fw_WN6FJRTI';
const TELEGRAM_BOT_ID = '5933108036';

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
let currentUser = null;   // profile row
let editingUserId = null;
let openTicketId = null;

// ── Loader ──────────────────────────────────────────────────
function showLoader() {
  document.getElementById('global-loader').classList.remove('hidden');
}
function hideLoader() {
  document.getElementById('global-loader').classList.add('hidden');
}

// ── Telegram Auth ───────────────────────────────────────────
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

// ── Boot ────────────────────────────────────────────────────
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

// ── Navigation ──────────────────────────────────────────────
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

// ── Events ──────────────────────────────────────────────────
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

// ── TICKETS ─────────────────────────────────────────────────
async function loadTickets() {
  const list = document.getElementById('ticket-list');
  document.getElementById('ticket-thread').classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    let q = currentUser.role === 'admin'
      ? 'order=created_at.desc'
      : `user_id=eq.${currentUser.id}&order=created_at.desc`;
    const tickets = await db.select('tickets', q);
    if (!tickets || !tickets.length) { list.innerHTML = '<div class="empty-state">No tickets yet.</div>'; return; }

    const uids = [...new Set(tickets.map(t => t.user_id))];
    const profiles = await db.select('profiles', `id=in.(${uids.join(',')})&select=id,first_name,last_name,username`);
    const pMap = {};
    (profiles || []).forEach(p => { pMap[p.id] = p; });

    list.innerHTML = '';
    tickets.forEach(t => {
      const p = pMap[t.user_id] || {};
      const uname = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || t.user_id;
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div>
          <div class="card-title">${esc(t.subject)}</div>
          <div class="card-sub">By ${esc(uname)} · ${fmtDate(t.created_at)}</div>
        </div>
        <span class="badge badge-${t.status}">${t.status}</span>
      `;
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
  const msgs = document.getElementById('thread-messages');
  msgs.innerHTML = 'Loading...';
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
      const b = document.createElement('div');
      b.className = `msg-bubble ${mine ? 'mine' : 'theirs'}`;
      b.innerHTML = `<div class="msg-sender">${esc(name)}</div><div class="msg-text">${esc(r.body)}</div><div class="msg-time">${fmtDate(r.created_at)}</div>`;
      msgs.appendChild(b);
    });
    msgs.scrollTop = msgs.scrollHeight;
    if (currentUser.role === 'admin') {
      document.getElementById('close-ticket-btn').classList.toggle('hidden', ticket.status === 'closed');
    }
  } catch (e) { msgs.innerHTML = e.message; }
}

async function submitTicket() {
  const subject = document.getElementById('ticket-subject').value.trim();
  const body = document.getElementById('ticket-body').value.trim();
  if (!subject || !body) return;
  try {
    const [ticket] = await db.insert('tickets', { user_id: currentUser.id, subject });
    await db.insert('ticket_messages', { ticket_id: ticket.id, sender_id: currentUser.id, body });
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
    document.getElementById('reply-body').value = '';
    const tickets = await db.select('tickets', `id=eq.${openTicketId}`);
    if (tickets && tickets[0]) openTicket(tickets[0]);
  } catch (e) { alert(e.message); }
}

async function closeTicket() {
  if (!openTicketId) return;
  try {
    await db.update('tickets', openTicketId, { status: 'closed' });
    document.getElementById('close-ticket-btn').classList.add('hidden');
    alert('Ticket closed.');
  } catch (e) { alert(e.message); }
}

// ── MESSAGES ─────────────────────────────────────────────────
async function loadMessages() {
  const list = document.getElementById('message-list');
  list.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const q = currentUser.role === 'admin'
      ? `from_id=eq.${currentUser.id}&order=created_at.desc`
      : `to_id=eq.${currentUser.id}&order=created_at.desc`;
    const msgs = await db.select('messages', q);
    if (!msgs || !msgs.length) { list.innerHTML = '<div class="empty-state">No messages.</div>'; return; }

    const ids = [...new Set([...msgs.map(m => m.from_id), ...msgs.map(m => m.to_id)].filter(Boolean))];
    const profs = await db.select('profiles', `id=in.(${ids.join(',')})&select=id,first_name,last_name,username`);
    const pMap = {};
    (profs || []).forEach(p => { pMap[p.id] = p; });

    list.innerHTML = '';
    msgs.forEach(m => {
      const from = pMap[m.from_id] || {};
      const to = pMap[m.to_id] || {};
      const fromName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';
      const toName = [to.first_name, to.last_name].filter(Boolean).join(' ') || to.username || 'Unknown';
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div>
          <div class="card-title">${esc(m.body.substring(0, 80))}${m.body.length > 80 ? '…' : ''}</div>
          <div class="card-sub">From ${esc(fromName)} → ${esc(toName)} · ${fmtDate(m.created_at)}</div>
        </div>
        ${!m.read && currentUser.role !== 'admin' ? '<span class="badge badge-unread">New</span>' : ''}
      `;
      if (!m.read && m.to_id === currentUser.id) {
        db.update('messages', m.id, { read: true }).catch(() => {});
      }
      list.appendChild(card);
    });
  } catch (e) { list.innerHTML = `<div class="empty-state">${e.message}</div>`; }
}

async function openSendMessageModal() {
  const modal = document.getElementById('send-message-modal');
  const sel = document.getElementById('msg-to-select');
  sel.innerHTML = '<option value="">Loading...</option>';
  modal.classList.remove('hidden');
  try {
    const users = await db.select('profiles', 'order=first_name.asc');
    sel.innerHTML = '';
    (users || []).filter(u => u.id !== currentUser.id).forEach(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || u.email;
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  } catch (e) { sel.innerHTML = `<option>${e.message}</option>`; }
}

async function submitMessage() {
  const to_id = document.getElementById('msg-to-select').value;
  const body = document.getElementById('msg-body').value.trim();
  if (!to_id || !body) return;
  try {
    await db.insert('messages', { from_id: currentUser.id, to_id, body });
    document.getElementById('msg-body').value = '';
    document.getElementById('send-message-modal').classList.add('hidden');
    loadMessages();
  } catch (e) { alert(e.message); }
}

// ── CONTRACTS ────────────────────────────────────────────────
async function loadContracts() {
  const list = document.getElementById('contracts-list');
  list.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const sections = await db.select('contract_sections', 'order=created_at.asc');
    const contracts = await db.select('contracts', 'order=created_at.asc');
    if (!sections || !sections.length) { list.innerHTML = '<div class="empty-state">No sections yet.</div>'; return; }

    list.innerHTML = '';
    sections.forEach(sec => {
      const files = (contracts || []).filter(c => c.section_id === sec.id);
      const block = document.createElement('div');
      block.className = 'contract-section-block';
      const filesHtml = files.length
        ? files.map(f => `<div class="contract-file"><span>${esc(f.title)}</span><a href="${esc(f.file_url)}" target="_blank" rel="noopener">Open ↗</a></div>`).join('')
        : `<div class="contract-file"><span style="color:var(--muted)">No files in this section.</span></div>`;
      block.innerHTML = `
        <div class="contract-section-header">
          <span>📂 ${esc(sec.title)}</span>
          <span style="color:var(--muted);font-size:12px">${files.length} file${files.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="contract-files">${filesHtml}</div>
      `;
      const hdr = block.querySelector('.contract-section-header');
      const body = block.querySelector('.contract-files');
      hdr.addEventListener('click', () => { body.style.display = body.style.display === 'none' ? '' : 'none'; });
      list.appendChild(block);
    });
  } catch (e) { list.innerHTML = `<div class="empty-state">${e.message}</div>`; }
}

async function submitSection() {
  const title = document.getElementById('section-title-input').value.trim();
  if (!title) return;
  try {
    await db.insert('contract_sections', { title });
    document.getElementById('section-title-input').value = '';
    document.getElementById('add-section-modal').classList.add('hidden');
    loadContracts();
  } catch (e) { alert(e.message); }
}

async function openAddContractModal() {
  const modal = document.getElementById('add-contract-modal');
  const sel = document.getElementById('contract-section-select');
  sel.innerHTML = '<option value="">Loading...</option>';
  modal.classList.remove('hidden');
  try {
    const sections = await db.select('contract_sections', 'order=title.asc');
    sel.innerHTML = '';
    (sections || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title;
      sel.appendChild(opt);
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

// ── CONNECTIONS ──────────────────────────────────────────────
async function loadConnections() {
  const list = document.getElementById('connections-list');
  const reqList = document.getElementById('conn-requests-list');
  list.innerHTML = '<div class="empty-state">Loading connections...</div>';
  reqList.innerHTML = '';

  try {
    const all = await db.select('connection_requests',
      `or=(from_id.eq.${currentUser.id},to_id.eq.${currentUser.id})&order=created_at.desc`);

    const ids = [...new Set((all || []).flatMap(r => [r.from_id, r.to_id]))];
    let pMap = {};
    if (ids.length) {
      const profs = await db.select('profiles', `id=in.(${ids.join(',')})&select=id,first_name,last_name,username`);
      (profs || []).forEach(p => { pMap[p.id] = p; });
    }

    const accepted = (all || []).filter(r => r.status === 'accepted');
    const pending = (all || []).filter(r => r.status === 'pending');

    if (!accepted.length) {
      list.innerHTML = '<div class="empty-state">No connections yet.</div>';
    } else {
      list.innerHTML = '<div style="color:var(--muted);font-size:12px;margin-bottom:6px">Connected</div>';
      accepted.forEach(r => {
        const otherId = r.from_id === currentUser.id ? r.to_id : r.from_id;
        const p = pMap[otherId] || {};
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || otherId;
        const card = document.createElement('div');
        card.className = 'card';
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
        const card = document.createElement('div');
        card.className = 'card';
        card.style.flexWrap = 'wrap';
        card.innerHTML = `
          <div>
            <div class="card-title">${isIncoming ? 'From' : 'To'}: ${esc(name)}</div>
            <div class="card-sub">${fmtDate(r.created_at)}</div>
          </div>
          <div style="display:flex;gap:8px">
            ${isIncoming
              ? `<button class="btn-accent" onclick="respondConn('${r.id}','accepted')">Accept</button>
                 <button class="btn-ghost" onclick="respondConn('${r.id}','rejected')">Reject</button>`
              : `<span class="badge badge-pending">Pending</span>`}
          </div>
        `;
        reqList.appendChild(card);
      });
    }
  } catch (e) { list.innerHTML = `<div class="empty-state">${e.message}</div>`; }
}

async function openConnModal() {
  const modal = document.getElementById('send-conn-modal');
  const sel = document.getElementById('conn-to-select');
  sel.innerHTML = '<option value="">Loading...</option>';
  modal.classList.remove('hidden');
  try {
    const users = await db.select('profiles', 'order=first_name.asc&select=id,first_name,last_name,username');
    sel.innerHTML = '';
    (users || []).filter(u => u.id !== currentUser.id).forEach(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || u.id;
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  } catch (e) { sel.innerHTML = `<option>${e.message}</option>`; }
}

async function submitConnRequest() {
  const to_id = document.getElementById('conn-to-select').value;
  if (!to_id) return;
  try {
    await db.insert('connection_requests', { from_id: currentUser.id, to_id, status: 'pending' });
    document.getElementById('send-conn-modal').classList.add('hidden');
    loadConnections();
  } catch (e) { alert(e.message); }
}

async function respondConn(id, status) {
  try {
    await db.update('connection_requests', id, { status });
    loadConnections();
  } catch (e) { alert(e.message); }
}

// ── USERS ────────────────────────────────────────────────────
async function loadUsers() {
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted)">Loading...</td></tr>';
  try {
    const users = await db.select('profiles', 'order=created_at.desc');
    tbody.innerHTML = '';
    (users || []).forEach(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(name)}</td>
        <td>${esc(u.username || '—')}</td>
        <td>${esc(u.email || '—')}</td>
        <td><span class="badge ${u.role === 'admin' ? 'badge-accepted' : 'badge-open'}">${esc(u.role || 'user')}</span></td>
        <td>${esc(u.telegram_id || '—')}</td>
        <td>${fmtDate(u.created_at)}</td>
        <td><button class="btn-ghost" onclick="openEditUser('${u.id}')">Edit</button></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { tbody.innerHTML = `<tr><td colspan="7">${e.message}</td></tr>`; }
}

async function openEditUser(uid) {
  editingUserId = uid;
  try {
    const [u] = await db.select('profiles', `id=eq.${uid}`);
    document.getElementById('edit-first-name').value = u.first_name || '';
    document.getElementById('edit-last-name').value = u.last_name || '';
    document.getElementById('edit-username').value = u.username || '';
    document.getElementById('edit-role').value = u.role || 'user';
    document.getElementById('edit-telegram').value = u.telegram_id || '';
    document.getElementById('edit-user-modal').classList.remove('hidden');
  } catch (e) { alert(e.message); }
}

async function saveUser() {
  if (!editingUserId) return;
  const body = {
    first_name: document.getElementById('edit-first-name').value.trim(),
    last_name: document.getElementById('edit-last-name').value.trim(),
    username: document.getElementById('edit-username').value.trim(),
    role: document.getElementById('edit-role').value,
    telegram_id: document.getElementById('edit-telegram').value.trim(),
    updated_at: new Date().toISOString()
  };
  try {
    await db.update('profiles', editingUserId, body);
    document.getElementById('edit-user-modal').classList.add('hidden');
    loadUsers();
  } catch (e) { alert(e.message); }
}

// ── Utils ────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}