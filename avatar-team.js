/* ============================================================================
   avatar-team.js — ระบบทีมกลางแบบ Minute of Meeting สำหรับทุกแอพใน Quality Control Forms
   (ยกมาจากระบบที่ใช้งานจริงใน minute-of-meeting.html — การบันทึก/ป๊อบอัพ/ข้อความชุดเดียวกัน)

   เก็บข้อมูลที่ไหน (Supabase โปรเจกต์เดียวกับ MoM — ดู projects/Team-Sync/qc-team-schema.sql)
     qc_jobs   1 แถว = 1 งาน      { name, customer, meta }
     qc_items  1 แถว = 1 รายการย่อย (ซ้อนกันได้)  { parentId, kind, sort, data }
     qc_photos 1 แถว = 1 รูป (ไฟล์อยู่บน Google Drive)  { itemId, slot, driveId, ... }

   ทำอะไรให้แอพ
     - บันทึกทันทีทีละรายการ (รวมการแก้ 0.5 วิ) · ล้มเหลว → ลองใหม่ทุก 15 วิ / ตอนเน็ตกลับ
     - realtime: คนอื่นแก้ → ดึงล่าสุดมารวม แต่ไม่วาดหน้าใหม่ระหว่างพิมพ์
     - รูปขึ้น Drive ทีละรูป · ยังไม่เชื่อม Drive → แถบ "รูปรออัปโหลด" + ปุ่มเชื่อมต่อ
     - รายการงาน / ป้ายซิงค์ / ชิปบัญชี / กล่องยืนยัน / toast — หน้าตาเดียวกับ MoM
     - โหมดออฟไลน์ (เก็บในเครื่อง) + ส่งขึ้นทีม · ส่งออก/นำเข้า JSON

   วิธีใช้
     <script src="avatar-gate.js"></script>                      (ใน <head>)
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="https://cdn.jsdelivr.net/npm/localforage@1.10.0/dist/localforage.min.js"></script>
     <script src="https://accounts.google.com/gsi/client" async defer></script>
     <script src="avatar-team.js"></script>
     const team = AvatarTeam.init({
       app: 'photo-inspection', appTitle: 'Photograph Inspection',
       indicator: 'teamSync',        // element ที่ใส่ป้าย "ซิงค์แล้ว"
       chip: 'teamChip',             // element ที่ใส่ชิปบัญชี
       render(),                     // วาดหน้าจอใหม่ทั้งหมดจาก team.* (เรียกหลังเปิดงาน / มีคนอื่นแก้)
       onPhoto(photo),               // (ไม่บังคับ) รูปโหลดเสร็จ → อัปเดตเฉพาะรูปนั้น (ไม่มี = render())
       seed(team),                   // (ไม่บังคับ) งานใหม่ → สร้างรายการเริ่มต้น
       photoName(photo),             // (ไม่บังคับ) ชื่อไฟล์บน Drive (ไม่ใส่นามสกุล)
       jobLabel(row),                // (ไม่บังคับ) บรรทัดรองในรายการงาน
       legacyLocal(),                // (ไม่บังคับ) งานจากเวอร์ชันก่อนในเครื่อง [{legacyId,name,customer,updatedAt,model}]
       beforeLeave(),                // (ไม่บังคับ) ก่อนเปลี่ยนงาน — คืน false = ยกเลิก
     })
   ============================================================================ */
(function (global) {
'use strict';

const VERSION = 1;

/* ---- CONFIG (ชุดเดียวกับ minute-of-meeting.html) ---- */
const SUPABASE_URL         = 'https://axzikauvpsbzpwxyjjlj.supabase.co';
const SUPABASE_ANON_KEY    = 'sb_publishable_3_9pZH5Geg767TI9a6AARA_j4_VYUe1';
const GOOGLE_CLIENT_ID     = '817132088438-k3mr42mv2nj6fgnh4cruv30p83980k84.apps.googleusercontent.com';
const DRIVE_ROOT_FOLDER_ID = '1XqINnLbpcNcoroabsjQBIiMAYIg5uktU';   // โฟลเดอร์ที่บริษัทแชร์ (ตั้ง 19/11/2569) — รูปของ MoM / ระบบเดิมยังอยู่ที่โฟลเดอร์เก่า 1NTny5…
const DRIVE_SCOPE          = 'https://www.googleapis.com/auth/drive';

/* ---- keys ที่ใช้ร่วมกับ MoM / avatar-cloud (ล็อกอิน + สิทธิ์ Drive ใช้ต่อกันได้ทุกแอพ) ---- */
const DRIVE_TOKEN_KEY = 'avatar_mom_drive_token';
const MODE_KEY        = 'avatar_mom_mode';

const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = v => JSON.parse(JSON.stringify(v));
function uuid() {
  if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
}
const isDuplicate = e => e && (e.code === '23505' || /duplicate key/i.test(e.message || ''));

let sb = null;
let cfg = null;
let currentUser = null;
let appMode = lsGet(MODE_KEY) === 'offline' ? 'offline' : 'online';
const isOnline = () => appMode === 'online';
let photoCache = null;

/* ---- โมเดลของงานที่เปิดอยู่ ----
   job    = { id, name, customer, meta, driveFolderId, driveFolderOwner }
   items  = Map id → { id, parentId, kind, sort, data }
   photos = Map key → { id, itemId, slot, driveId, origDriveId, edit, uploadedBy, dataUrl, origDataUrl, pending, uploading } */
let job = null;
let items = new Map();
let photos = new Map();
const pkey = (itemId, slot) => (itemId || '') + '|' + slot;

const lastJobKey = () => 'avatar_team_last_' + cfg.app;
const offlineKey = () => 'avatar_team_offline_' + cfg.app;

/* ========================================================================
   UI — สไตล์เดียวกับ MoM (ใส่ prefix at- กันชนกับ CSS ของแอพ)
   ======================================================================== */
function injectStyles() {
  if (document.getElementById('atStyles')) return;
  const st = document.createElement('style');
  st.id = 'atStyles';
  st.textContent = `
  .at-root,.at-root *{font-family:'Sarabun','Inter',system-ui,sans-serif;box-sizing:border-box;}
  .at-btn{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;font-size:13px;font-weight:600;border-radius:10px;min-height:44px;cursor:pointer;transition:all .15s;border:1px solid #e2e8f0;background:white;color:#0b1220;white-space:nowrap;}
  .at-btn:hover{background:#f8fafc;border-color:#cbd5e1;}
  .at-btn.primary{background:#0f2744;color:white;border-color:transparent;}
  .at-btn.primary:hover{background:#1f3a5f;}
  .at-ind{font-size:11.5px;display:inline-flex;align-items:center;gap:6px;background:#ecfdf5;color:#047857;font-weight:600;padding:5px 11px;border-radius:999px;white-space:nowrap;}
  .at-ind .dot{width:7px;height:7px;border-radius:50%;background:#10b981;}
  .at-ind.saving{background:#fffbeb;color:#92400e;} .at-ind.saving .dot{background:#f5a623;animation:atPulse 1s infinite;}
  .at-ind.error{background:#fef2f2;color:#b91c1c;} .at-ind.error .dot{background:#ef4444;}
  @keyframes atPulse{50%{opacity:.3;}}
  .at-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 10px 5px 5px;border-radius:999px;}
  .at-chip img{width:24px;height:24px;border-radius:50%;background:#e2e8f0;}
  .at-chip span{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;}
  @media (max-width:1024px){.at-chip span{max-width:80px;}}
  @media (max-width:820px){.at-chip span{display:none;}.at-chip{padding:5px;}.at-ind .text{display:none;}}
  .at-banner{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:350;display:flex;align-items:center;gap:12px;max-width:94vw;background:#0f2744;color:white;border-radius:12px;padding:10px 12px 10px 16px;box-shadow:0 12px 30px -8px rgba(0,0,0,.5);font-size:13px;}
  .at-banner .at-btn{padding:7px 12px;font-size:12.5px;min-height:0;}
  .at-modal-bg{position:fixed;inset:0;background:rgba(11,18,32,.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:400;display:flex;align-items:center;justify-content:center;animation:atFade .2s ease;}
  @keyframes atFade{from{opacity:0}to{opacity:1}}
  .at-modal-box{background:white;border-radius:16px;width:min(94vw,460px);max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 50px -12px rgba(0,0,0,.4);animation:atUp .25s ease;color:#0b1220;}
  @keyframes atUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
  .at-modal-head{padding:18px 22px;background:#0f2744;color:white;font-weight:700;font-size:15px;display:flex;justify-content:space-between;align-items:center;}
  .at-modal-head .at-close{width:30px;height:30px;border-radius:7px;background:rgba(255,255,255,.08);color:white;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;}
  .at-modal-head .at-close:hover{background:rgba(255,255,255,.18);}
  .at-modal-body{padding:20px 22px;overflow-y:auto;flex:1;}
  .at-modal-foot{padding:14px 22px;border-top:1px solid #e2e8f0;display:flex;gap:10px;justify-content:flex-end;background:#fafbfc;}
  .at-hist-list{display:flex;flex-direction:column;gap:8px;max-height:48vh;overflow-y:auto;}
  .at-hist-item{display:flex;align-items:center;gap:10px;border:1px solid #e2e8f0;border-radius:10px;padding:11px 12px;background:white;transition:box-shadow .15s;}
  .at-hist-item:hover{box-shadow:0 2px 8px -2px rgba(0,0,0,.08);}
  .at-hist-info{flex:1;cursor:pointer;min-width:0;}
  .at-hist-name{font-weight:700;font-size:14px;color:#0b1220;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .at-hist-date{font-size:11.5px;color:#64748b;margin-top:2px;}
  .at-hist-tag{font-size:9px;font-weight:800;color:#92400e;background:linear-gradient(135deg,#fef3c7,#fde68a);padding:2px 6px;border-radius:4px;margin-left:6px;}
  .at-hist-del{border:none;background:#fef2f2;color:#ef4444;width:36px;height:36px;border-radius:8px;cursor:pointer;font-size:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;}
  .at-hist-del:hover{background:#fee2e2;}
  .at-continue{width:100%;text-align:left;border:none;border-radius:11px;padding:13px 16px;cursor:pointer;color:white;background:linear-gradient(135deg,#f5a623 0%,#ff8a00 100%);box-shadow:0 4px 12px -2px rgba(245,166,35,.4);}
  #atToast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(20px);background:#0b1220;color:white;padding:11px 20px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 10px 30px -6px rgba(0,0,0,.35);opacity:0;transition:all .25s;pointer-events:none;z-index:600;display:flex;align-items:center;gap:8px;}
  #atToast.show{opacity:1;transform:translateX(-50%) translateY(0);}
  #atToast .ic{width:20px;height:20px;border-radius:50%;background:#10b981;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0;}
  `;
  document.head.appendChild(st);
}

let toastTimer = null;
function toast(msg, ms) {
  let t = document.getElementById('atToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'atToast'; t.className = 'at-root no-print';
    t.innerHTML = '<span class="ic">✓</span><span class="msg"></span>';
    document.body.appendChild(t);
  }
  t.querySelector('.msg').textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
}

function buildModalOverlay(innerHTML, z) {
  const bg = document.createElement('div');
  bg.className = 'at-modal-bg at-root no-print';
  bg.style.zIndex = z || 400;
  bg.innerHTML = `<div class="at-modal-box">${innerHTML}</div>`;
  document.body.appendChild(bg);
  return bg;
}

function confirmDialog({ title = 'ยืนยัน', message = '', confirmText = 'ตกลง', cancelText = 'ยกเลิก', danger = false, icon = true } = {}) {
  return new Promise(resolve => {
    const iconHtml = icon ? `
      <div style="width:52px;height:52px;border-radius:14px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;background:${danger ? '#fef2f2' : '#eff6ff'};color:${danger ? '#ef4444' : '#2563eb'};">
        ${danger
          ? '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>'
          : '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'}
      </div>` : '';
    const bg = buildModalOverlay(`
      <div class="at-modal-body" style="text-align:center;padding:24px 22px 8px;">
        ${iconHtml}
        <div style="font-weight:800;font-size:17px;color:#0b1220;margin-bottom:8px;">${esc(title)}</div>
        <div style="font-size:13.5px;color:#475569;line-height:1.6;">${message}</div>
      </div>
      <div class="at-modal-foot" style="justify-content:stretch;gap:10px;">
        <button class="at-btn" data-no style="flex:1;justify-content:center;">${esc(cancelText)}</button>
        <button class="at-btn ${danger ? '' : 'primary'}" data-ok style="flex:1;justify-content:center;${danger ? 'background:linear-gradient(135deg,#ef4444,#dc2626);color:white;border-color:transparent;' : ''}">${esc(confirmText)}</button>
      </div>`, 440);
    const done = v => { bg.remove(); resolve(v); };
    bg.querySelector('[data-ok]').onclick = () => done(true);
    bg.querySelector('[data-no]').onclick = () => done(false);
    bg.addEventListener('click', e => { if (e.target === bg) done(false); });
  });
}

/* ---- ป้ายสถานะซิงค์ (เหมือน MoM) ---- */
let syncStatus = 'saved';
function setSync(status) {   // 'saving' | 'saved' | 'error'
  syncStatus = status;
  const host = el(cfg && cfg.indicator);
  if (!host) return;
  let ind = host.querySelector('.at-ind');
  if (!ind) {
    host.innerHTML = '<span class="at-ind at-root"><span class="dot"></span><span class="text"></span></span>';
    ind = host.querySelector('.at-ind');
  }
  ind.classList.toggle('saving', status === 'saving');
  ind.classList.toggle('error', status === 'error');
  ind.querySelector('.text').textContent = isOnline()
    ? (status === 'saving' ? 'กำลังซิงค์...' : status === 'error' ? 'รอซิงค์ (ออฟไลน์?)' : 'ซิงค์แล้ว')
    : (status === 'saving' ? 'กำลังบันทึก...' : 'บันทึกในเครื่องแล้ว');
}
function el(x) { return !x ? null : (typeof x === 'string' ? document.getElementById(x) : x); }

/* ---- ชิปบัญชี (เหมือน MoM) ---- */
const OFFLINE_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round"><path d="M1 1l22 22M16.7 11.4A7 7 0 0 0 12 9.5c-1.7 0-3.3.6-4.5 1.7M20 8.5a12 12 0 0 0-3.4-2.3M4 8.5a12 12 0 0 1 3-2.1M8.5 14.5a3.5 3.5 0 0 1 5.1-.3M12 18.5h.01"/></svg>');
function renderChip() {
  const host = el(cfg && cfg.chip);
  if (!host) return;
  let chip = host.querySelector('.at-chip');
  if (!chip) {
    host.innerHTML = '<button class="at-btn at-chip at-root" type="button"><img alt="" referrerpolicy="no-referrer"><span></span></button>';
    chip = host.querySelector('.at-chip');
    chip.onclick = signOutPrompt;
  }
  const img = chip.querySelector('img'), name = chip.querySelector('span');
  if (!isOnline()) {
    img.src = OFFLINE_ICON;
    name.textContent = 'ออฟไลน์ · เข้าสู่ระบบ';
    chip.title = 'อยู่ในโหมดออฟไลน์ — แตะเพื่อเข้าสู่ระบบทีม';
    chip.style.display = '';
    return;
  }
  if (!currentUser) { chip.style.display = 'none'; return; }
  const meta = currentUser.user_metadata || {};
  img.src = meta.avatar_url || meta.picture || '';
  name.textContent = meta.full_name || meta.name || currentUser.email;
  chip.title = 'ออกจากระบบ';
  chip.style.display = '';
}

async function signOutPrompt() {
  if (!isOnline()) {
    const go = await confirmDialog({ title: 'เข้าสู่ระบบทีม', message: 'ตอนนี้อยู่ในโหมดออฟไลน์ (งานเก็บในเครื่องนี้)<br>ต้องการเข้าสู่ระบบเพื่อใช้งานแบบทีมไหม?<br><span style="color:#94a3b8;font-size:12px;">งานออฟไลน์ยังอยู่ในเครื่อง และส่งขึ้นทีมทีหลังได้จากหน้า "รายการงาน"</span>', confirmText: 'เข้าสู่ระบบ' });
    if (go) switchToOnline();
    return;
  }
  const ok = await confirmDialog({ title: 'ออกจากระบบ', message: `ออกจากระบบบัญชี <b>${esc(currentUser ? currentUser.email : '')}</b> ใช่ไหม?`, confirmText: 'ออกจากระบบ' });
  if (!ok) return;
  await flushPendingWrites();
  await sb.auth.signOut();
}

function toLogin() {
  if (global.AvatarGate) global.AvatarGate.toLogin();
  else location.replace('index.html?next=' + encodeURIComponent(location.pathname.split('/').pop() || ''));
}

/* ========================================================================
   DB WRITES — คิวรวมการแก้ + ลองใหม่ (เหมือน MoM)
   ======================================================================== */
let retryQueue = [];
const pendingPatches = new Map();
let patchTimer = null;
const inflight = new Map();   // id → { row, ver, sent } รายการที่สร้างแล้วแต่ server ยังไม่ยืนยัน

/* OUTBOX — คำสั่งที่ยังไม่ถึง server (กำลังส่ง / รอลองใหม่ / รวมการแก้ 0.5 วิ) เก็บลงเครื่องด้วย (IndexedDB)
   เน็ตหลุดแล้วปิดแอพ / iPad ปิดแอพเอง → เปิดใหม่ส่งต่อก่อนเปิดงาน ไม่หาย · ถึง server แล้วลบออก
   spec = คำสั่งในรูปที่เก็บได้ (update / insert / delete / delphoto) */
let outboxStore = null;
const TAB = Math.random().toString(36).slice(2, 10);
const outbox = new Map();   // oid → { key, specFn, at, n }
let outboxN = 0, persistTimer = null, persistedKeys = new Set();
/* แท็บที่ยังเปิดอยู่ (แอพอื่นในเว็บเดียวกัน / แท็บซ้ำ) บอกว่ายังอยู่ทุก 5 วิ — ส่งต่อเฉพาะคิวของแท็บที่ปิดไปแล้ว
   (ไม่งั้นแท็บใหม่จะส่งค่าเก่าของแท็บที่ยังทำงานอยู่ไปทับของที่ใหม่กว่า) */
const TAB_BEAT = 'avatar_team_tab_';
const beat = () => lsSet(TAB_BEAT + TAB, String(Date.now()));
const tabAlive = t => t === TAB || (Date.now() - Number(lsGet(TAB_BEAT + t) || 0)) < 15000;
function outboxAdd(key, specFn) {
  if (!specFn) return null;
  const oid = TAB + '|' + (++outboxN);
  outbox.set(oid, { key, specFn, at: Date.now(), n: outboxN });
  schedulePersist();
  return oid;
}
function outboxDone(oid) { if (oid && outbox.delete(oid)) schedulePersist(); }
function schedulePersist() { if (!outboxStore) return; clearTimeout(persistTimer); persistTimer = setTimeout(persistOutbox, 150); }
async function persistOutbox() {
  clearTimeout(persistTimer);
  if (!outboxStore) return;
  const cur = new Map();
  outbox.forEach((e, oid) => { try { const spec = e.specFn(); if (spec) cur.set(oid, { key: e.key, spec, at: e.at, n: e.n }); } catch (_) {} });
  pendingPatches.forEach((pp, k) => cur.set(TAB + '|pp|' + k, {
    key: k, spec: { t: 'update', table: pp.table, id: pp.id, patch: Object.assign({}, pp.patch, { updated_by: currentUser && currentUser.id }) }, at: Date.now(), n: ++outboxN
  }));
  const old = persistedKeys;
  persistedKeys = new Set(cur.keys());
  try {
    await Promise.all([...old].filter(k => !cur.has(k)).map(k => outboxStore.removeItem(k))
      .concat([...cur].map(([k, v]) => outboxStore.setItem(k, v))));
  } catch (e) { console.warn('[outbox] save', e); }
}
function opFromSpec(sp) {
  if (!sp) return null;
  if (sp.t === 'update') return () => sb.from(sp.table).update(sp.patch).eq('id', sp.id);
  if (sp.t === 'insert') return () => sb.from('qc_items').insert(sp.rows);
  if (sp.t === 'delete') return () => sb.from(sp.table).delete().eq('id', sp.id);
  if (sp.t === 'delphoto') return () => { const q = sb.from('qc_photos').delete().eq('job_id', sp.jobId).eq('slot', sp.slot); return sp.itemId ? q.eq('item_id', sp.itemId) : q.is('item_id', null); };
  return null;
}
/* เปิดแอพ: ส่งคำสั่งที่ค้างจากครั้งก่อน (ทุกแท็บ/ทุกครั้งที่ปิดไป) ตามลำดับเดิม ก่อนเปิดงาน — ส่งซ้ำได้ไม่เสียหาย */
let outboxRestored = null;
function restoreOutbox() {
  if (!outboxRestored) outboxRestored = (async () => {
    if (!outboxStore || !currentUser) return;
    const list = [];
    await outboxStore.iterate((v, k) => { if (v && v.spec && !tabAlive(k.split('|')[0])) list.push([k, v]); }).catch(e => console.warn('[outbox] restore', e));
    // ล้างป้าย "ยังอยู่" ของแท็บที่ปิดไปนานแล้ว
    try { Object.keys(localStorage).filter(k => k.startsWith(TAB_BEAT) && !tabAlive(k.slice(TAB_BEAT.length))).forEach(k => localStorage.removeItem(k)); } catch (_) {}
    if (!list.length) return;
    list.sort((a, b) => (a[1].at - b[1].at) || (a[1].n - b[1].n));
    const runs = [];
    list.forEach(([, v]) => { const op = opFromSpec(v.spec), spec = v.spec; if (op) runs.push(dbWrite(op, v.key, () => spec)); });
    await persistOutbox();                                   // เก็บเป็นของแท็บนี้ก่อน แล้วค่อยลบชุดเดิม
    await Promise.all(list.map(([k]) => outboxStore.removeItem(k).catch(() => {})));
    await Promise.race([Promise.all(runs), new Promise(r => setTimeout(r, 15000))]);
  })();
  return outboxRestored;
}

/* เขียนทีละคำสั่งตามลำดับที่สั่ง — กันคำสั่งแซงกัน (ลูกถึงก่อนแม่ / ลบถึงก่อนสร้างแล้วแถวฟื้น) */
let writeChain = Promise.resolve(), writesInFlight = 0, writeSeq = 0;
function dbWrite(op, key, specFn) {
  if (!isOnline()) { localAutosave(); return Promise.resolve(true); }
  const oid = outboxAdd(key, specFn);
  setSync('saving');
  writesInFlight++;
  writeSeq++;
  const run = writeChain.then(() => dbWriteNow(op, key, oid, specFn)).finally(() => {
    writesInFlight--;
    if (!writesInFlight && !retryQueue.length && !pendingPatches.size && isOnline()) setSync('saved');
    if (!writesInFlight) runDeferredRefresh();
  });
  writeChain = run.catch(() => {});
  return run;
}
async function dbWriteNow(op, key, oid, specFn) {
  try {
    const { error } = await op();
    if (error && !isDuplicate(error)) throw error;
    outboxDone(oid);
    return true;
  } catch (err) {
    console.error('[db]', key, err);
    const i = retryQueue.findIndex(r => r.key === key);
    if (i >= 0) {
      // แถวเดียวกันแก้หลายครั้งตอนเน็ตหลุด → รวมทุกช่องที่แก้ (เดิมเก็บแค่ครั้งล่าสุด เช่น แก้เนื้อหาแล้วย้าย → เนื้อหาหาย)
      const old = retryQueue.splice(i, 1)[0];
      const a = old.specFn && old.specFn(), b = specFn && specFn();
      if (a && b && a.t === 'update' && b.t === 'update') {
        const merged = Object.assign({}, b, { patch: Object.assign({}, a.patch, b.patch) });
        op = opFromSpec(merged); specFn = () => merged;
        const e = outbox.get(oid); if (e) { e.specFn = specFn; schedulePersist(); }
      }
      outboxDone(old.oid);
    }
    retryQueue.push({ key, op, oid, specFn });
    setSync('error');
    return false;
  }
}

let retrying = false, retryAgain = false;
function flushRetryQueue() {
  if (retrying) { retryAgain = true; return; }   // เน็ตกลับมาระหว่างรอบที่กำลังส่ง → ส่งต่ออีกรอบทันทีเมื่อรอบนี้จบ (ไม่ต้องรอ 15 วิ)
  if (!retryQueue.length || !navigator.onLine || !currentUser || !isOnline()) return;
  retrying = true;
  const run = writeChain.then(async () => {
    const list = retryQueue.splice(0);
    const failed = [];
    for (const it of list) {   // ล้มอีก → เก็บไว้ตามลำดับเดิม ลองรอบหน้า (ตัวที่พึ่งตัวก่อนหน้าก็จะล้มตามแล้วผ่านรอบถัดไป)
      try { const { error } = await it.op(); if (error && !isDuplicate(error)) throw error; outboxDone(it.oid); }
      catch (e) { failed.push(it); }
    }
    retryQueue.unshift(...failed);
    setSync(retryQueue.length ? 'error' : 'saved');
    if (!retryQueue.length) { flushPendingUploads(); if (job) refreshDeferred = true; runDeferredRefresh(); }   // ของค้างถึงระบบครบ → ดึงล่าสุดลงจอ (ไม่ต้องรีเฟรชเอง)
  }).finally(() => { retrying = false; if (retryAgain) { retryAgain = false; setTimeout(flushRetryQueue, 0); } });
  writeChain = run.catch(() => {});
  return run;
}

function queueUpdate(table, id, patch) {
  if (!isOnline()) { localAutosave(); return; }
  const key = table + ':' + id;
  const cur = pendingPatches.get(key);
  pendingPatches.set(key, { table, id, patch: Object.assign(cur ? cur.patch : {}, patch) });
  clearTimeout(patchTimer);
  patchTimer = setTimeout(flushPendingWrites, 500);
  schedulePersist();
  setSync('saving');
}

async function flushPendingWrites() {
  clearTimeout(patchTimer);
  if (!isOnline()) { await localAutosave(true); return; }
  const list = [...pendingPatches.values()];
  pendingPatches.clear();
  // สั่งทุกคำสั่งทันที (เข้าคิวเรียงลำดับเอง) — ไม่รอทีละตัว ไม่งั้นตัวที่ยังไม่ได้สั่งไม่อยู่ใน outbox ถ้าแอพถูกปิดกลางทาง
  await Promise.all(list.map(({ table, id, patch }) => {
    patch.updated_by = currentUser && currentUser.id;
    return dbWrite(() => sb.from(table).update(patch).eq('id', id), table + ':' + id, () => ({ t: 'update', table, id, patch }));
  }));
  runDeferredRefresh();
}

/* ========================================================================
   OFFLINE — งานเก็บในเครื่องนี้ (localforage) ไม่ต้องล็อกอิน ไม่ใช้ Drive
   ======================================================================== */
async function getLocalJobs() { await migrateLegacyLocal(); try { return (await localforage.getItem(offlineKey())) || []; } catch (e) { return []; } }
async function setLocalJobs(list) { try { await localforage.setItem(offlineKey(), list); } catch (e) { console.error(e); } }

/* งานจากเวอร์ชันก่อนของแอพ (ประวัติในเครื่อง) → เข้ารายการออฟไลน์ครั้งเดียว ไม่ลบของเดิม */
async function migrateLegacyLocal(force) {
  const report = { found: 0, added: 0 };
  if (!cfg.legacyLocal) return report;
  const flag = 'avatar_team_legacy_migrated_' + cfg.app;
  try {
    if (!force && await localforage.getItem(flag)) return report;
    const legacy = (await cfg.legacyLocal()) || [];
    const list = (await localforage.getItem(offlineKey())) || [];
    const have = new Set(list.map(m => m.legacyId).filter(Boolean));
    report.found = legacy.length;
    legacy.forEach(l => {
      if (!l || !l.model || have.has(l.legacyId)) return;
      const model = normalizeModel(l.model);
      model.job.id = uuid();
      list.push({ id: model.job.id, legacyId: l.legacyId, name: l.name || model.job.name, customer: l.customer || model.job.customer, updatedAt: l.updatedAt || Date.now(), model });
      have.add(l.legacyId); report.added++;
    });
    if (report.added) await localforage.setItem(offlineKey(), list);
    await localforage.setItem(flag, 1);
  } catch (e) { console.error('[migrate]', e); report.error = e.message; }
  return report;
}

/* โมเดล ↔ ก้อนข้อมูลที่เก็บได้ (JSON) — รูปติด dataUrl ไปด้วย */
function snapshotModel() {
  return {
    v: 1,
    job: job ? { id: job.id, name: job.name, customer: job.customer, meta: clone(job.meta || {}) } : null,
    items: [...items.values()].map(i => ({ id: i.id, parentId: i.parentId, kind: i.kind, sort: i.sort, data: clone(i.data || {}) })),
    photos: [...photos.values()].map(p => ({
      itemId: p.itemId, slot: p.slot, dataUrl: p.dataUrl || null, origDataUrl: p.origDataUrl || null,
      edit: p.edit || null, driveId: p.driveId || null, origDriveId: p.origDriveId || null
    }))
  };
}
function normalizeModel(m) {
  m = m || {};
  return {
    job: Object.assign({ id: null, name: '', customer: '', meta: {} }, m.job || {}),
    items: (m.items || []).map(i => ({ id: i.id || uuid(), parentId: i.parentId || null, kind: i.kind || 'item', sort: +i.sort || 0, data: i.data || {} })),
    photos: (m.photos || []).filter(p => p && (p.dataUrl || p.driveId))
  };
}
function loadModel(m) {
  m = normalizeModel(m);
  job = Object.assign({ driveFolderId: null, driveFolderOwner: null }, m.job);
  items = new Map(m.items.map(i => [i.id, i]));
  photos = new Map(m.photos.map(p => [pkey(p.itemId, p.slot), {
    id: null, itemId: p.itemId || null, slot: String(p.slot), driveId: p.driveId || null, origDriveId: p.origDriveId || null,
    edit: p.edit || null, uploadedBy: null, dataUrl: p.dataUrl || null, origDataUrl: p.origDataUrl || null, pending: false, uploading: false
  }]));
}

let localSaveTimer = null;
function localAutosave(immediate) {
  clearTimeout(localSaveTimer);
  const run = async () => {
    if (isOnline() || !job) return;
    setSync('saving');
    const list = await getLocalJobs();
    const entry = { id: job.id, name: job.name, customer: job.customer, updatedAt: Date.now(), model: snapshotModel() };
    const i = list.findIndex(m => m.id === entry.id);
    if (i >= 0) list[i] = Object.assign(list[i], entry); else list.push(entry);
    await setLocalJobs(list);
    setSync('saved');
  };
  if (immediate) return run();
  localSaveTimer = setTimeout(run, 400);
}

async function openLocalJob(id, opts = {}) {
  const m = (await getLocalJobs()).find(x => x.id === id);
  if (!m) throw new Error('not found');
  inflight.clear();
  loadModel(m.model);
  job.id = m.id;
  lsSet(lastJobKey() + '_offline', id);
  if (!opts.keepScreen) render();
  updateDriveBanner();
}

async function createLocalJob(meta) {
  job = { id: uuid(), name: (meta && meta.name) || '', customer: (meta && meta.customer) || '', meta: (meta && meta.meta) || {}, driveFolderId: null, driveFolderOwner: null };
  items = new Map(); photos = new Map();
  const list = await getLocalJobs();
  list.push({ id: job.id, name: job.name, customer: job.customer, updatedAt: Date.now(), model: snapshotModel() });
  await setLocalJobs(list);
  lsSet(lastJobKey() + '_offline', job.id);
  return job.id;
}

async function enterOfflineMode() {
  await flushPendingWrites();
  appMode = 'offline';
  lsSet(MODE_KEY, 'offline');
  if (rtChannel) { sb.removeChannel(rtChannel); rtChannel = null; }
  currentUser = null;
  renderChip();
  setSync('saved');
  leaveJob(true);
  const last = lsGet(lastJobKey() + '_offline');
  if (last) { try { await openLocalJob(last); } catch (_) { lsSet(lastJobKey() + '_offline', null); } }
  showJobList(true);
}

async function switchToOnline() {
  await flushPendingWrites();
  appMode = 'online';
  lsSet(MODE_KEY, 'online');
  leaveJob(true);
  const { data: { session } } = await sb.auth.getSession();
  if (session) await onSignedIn(session);
  else toLogin();
}

/* ========================================================================
   GOOGLE DRIVE (เหมือน MoM)
   ======================================================================== */
let driveToken = null, gisClient = null, lastSeenToken = null, lastDriveError = '';
function setDriveToken(token, ttlSec) {
  if (!token || token === lastSeenToken) return;
  lastSeenToken = token;
  driveToken = { token, exp: Date.now() + (ttlSec || 3500) * 1000 };
  lsSet(DRIVE_TOKEN_KEY, JSON.stringify(driveToken));
  lsSet(DRIVE_TOKEN_KEY + '_seen', token);
  if (job) loadJobPhotos();
  if (allPending().length) flushPendingUploads();
  if (currentUser) processDriveCleanup();
}
function restoreDriveToken() {
  lastSeenToken = lsGet(DRIVE_TOKEN_KEY + '_seen');
  try { const t = JSON.parse(lsGet(DRIVE_TOKEN_KEY)); if (t && t.exp > Date.now()) driveToken = t; } catch (_) {}
}
function clearDriveToken() { driveToken = null; lsSet(DRIVE_TOKEN_KEY, null); }
function hasDriveToken() {
  if (!(driveToken && driveToken.exp > Date.now() + 30000)) {
    // แอพอื่นในแท็บอื่นอาจเพิ่งขอสิทธิ์ใหม่ (ที่เก็บเดียวกัน)
    try { const t = JSON.parse(lsGet(DRIVE_TOKEN_KEY)); if (t && t.exp > Date.now() + 30000) driveToken = t; } catch (_) {}
  }
  return !!(driveToken && driveToken.exp > Date.now() + 30000);
}
let tokenRequest = null;
function getDriveToken(interactive) {
  if (hasDriveToken()) return Promise.resolve(driveToken.token);
  if (!interactive || !global.google || !global.google.accounts) return Promise.resolve(null);
  if (tokenRequest) return tokenRequest;   // ขอซ้อนกัน → callback ของ GIS ถูกทับ
  tokenRequest = new Promise(resolve => {
    if (!gisClient) gisClient = global.google.accounts.oauth2.initTokenClient({ client_id: GOOGLE_CLIENT_ID, scope: DRIVE_SCOPE, callback: () => {} });
    gisClient.callback = resp => {
      if (resp && resp.access_token) { setDriveToken(resp.access_token, resp.expires_in); resolve(resp.access_token); }
      else resolve(null);
    };
    gisClient.error_callback = err => { console.warn('[gis]', err && err.type); resolve(null); };
    gisClient.requestAccessToken({ prompt: '', hint: currentUser && currentUser.email });
  }).finally(() => { tokenRequest = null; });
  return tokenRequest;
}
/* เรียกจาก event ที่ผู้ใช้แตะเอง (popup ของ Google เปิดได้) — ถ้า token หมดอายุจะขอใหม่เงียบๆ */
function ensureDriveTokenFromGesture() {
  if (isOnline() && currentUser && !hasDriveToken()) getDriveToken(true);
}
async function connectDrive() {
  const tok = await getDriveToken(true);
  if (!tok) { toast('เชื่อมต่อ Google Drive ไม่สำเร็จ'); return; }
  updateDriveBanner();
  flushPendingUploads();
  loadJobPhotos();
}

async function driveFetch(url, opts = {}) {
  const token = await getDriveToken(false);
  if (!token) { const e = new Error('no drive token'); e.status = 401; throw e; }
  const res = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {}) }));
  if (res.status === 401) clearDriveToken();
  if (!res.ok) {
    let msg = 'Drive ' + res.status;
    try { const j = await res.json(); if (j.error && j.error.message) msg += ': ' + j.error.message; } catch (_) {}
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return res;
}
async function driveCreateFolder(name, parentId) {
  const res = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  return (await res.json()).id;
}
async function driveUpload(blob, name, folderId) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name, parents: [folderId] })], { type: 'application/json' }));
  form.append('file', blob, name);
  const res = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', { method: 'POST', body: form });
  return (await res.json()).id;
}
async function driveDownloadDataUrl(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob);
  });
}
async function driveTrash(fileId) {
  try {
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
    });
    return true;
  } catch (e) {
    if (e.status === 404) return true;
    console.warn('[drive] trash', fileId, e.message);
    return false;
  }
}
async function driveFolderIsEmpty(folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return ((await res.json()).files || []).length === 0;
}
/* ลบไฟล์/โฟลเดอร์ใน Drive: ลบได้เฉพาะเจ้าของ → ไม่ใช่ของเรา (หรือลบไม่ผ่าน) เข้าคิว drive_cleanup ให้เจ้าของลบ */
async function driveDelete(fileId, ownerId, isFolder) {
  if (!fileId || !isOnline()) return;
  const mine = !ownerId || ownerId === (currentUser && currentUser.id);
  let done = false;
  if (mine && hasDriveToken()) {
    try { done = isFolder ? (await driveFolderIsEmpty(fileId) && await driveTrash(fileId)) : await driveTrash(fileId); }
    catch (e) { done = false; }
  }
  if (!done) {
    const { error } = await sb.from('drive_cleanup').insert({ drive_file_id: fileId, owner: ownerId || null, is_folder: !!isFolder });
    if (error) console.warn('[cleanup] queue', error.message);
  }
}
let cleanupRunning = false;
async function processDriveCleanup() {
  if (cleanupRunning || !isOnline() || !currentUser || !hasDriveToken()) return;
  cleanupRunning = true;
  try {
    const { data, error } = await sb.from('drive_cleanup').select('*')
      .or(`owner.eq.${currentUser.id},owner.is.null`).order('is_folder').limit(50);
    if (error || !data) return;
    for (const row of data) {
      if (!hasDriveToken()) break;
      let ok = false;
      try { ok = row.is_folder ? (await driveFolderIsEmpty(row.drive_file_id) && await driveTrash(row.drive_file_id)) : await driveTrash(row.drive_file_id); }
      catch (e) { ok = e.status === 404; }
      if (ok) await sb.from('drive_cleanup').delete().eq('id', row.id);
    }
  } catch (e) { console.warn('[cleanup]', e); }
  finally { cleanupRunning = false; }
}

async function ensureJobFolder() {
  if (job.driveFolderId) return job.driveFolderId;
  // เช็กอีกรอบจาก DB — เผื่อคนอื่นเพิ่งสร้างโฟลเดอร์ให้งานนี้ไปแล้ว
  const { data } = await sb.from('qc_jobs').select('drive_folder_id, drive_folder_owner').eq('id', job.id).single();
  if (data && data.drive_folder_id) { job.driveFolderId = data.drive_folder_id; job.driveFolderOwner = data.drive_folder_owner; return data.drive_folder_id; }
  const folderName = `${(job.name || '').trim() || cfg.appTitle} [${job.id.slice(0, 8)}]`;
  const fid = await driveCreateFolder(folderName, DRIVE_ROOT_FOLDER_ID);
  job.driveFolderId = fid;
  job.driveFolderOwner = currentUser.id;
  await sb.from('qc_jobs').update({ drive_folder_id: fid, drive_folder_owner: currentUser.id }).eq('id', job.id);
  return fid;
}

function photoFileName(p, original) {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  let base = '';
  try { base = cfg.photoName ? cfg.photoName(p) : ''; } catch (_) {}
  base = String(base || ('รูป_' + p.slot)).replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80);
  return `${base}${original ? '_ต้นฉบับ' : ''}_${stamp}.jpg`;
}

/* ========================================================================
   PHOTOS — อัปโหลดทีละรูป / โหลดจาก Drive (เหมือน MoM)
   ======================================================================== */
/* รูปที่ยังอัปไม่เสร็จของงานที่ "ไม่ได้เปิดอยู่" (เปลี่ยนงาน / ส่งงานอื่นขึ้นทีมต่อ) — อัปต่อเบื้องหลัง ไม่ทิ้ง */
const bgPending = new Map();   // jobId|itemId|slot → photo
const bgKey = p => p.jobId + '|' + pkey(p.itemId, p.slot);
function parkPending() {        // ก่อนเปลี่ยนงาน: เก็บรูปที่ยังค้างของงานเดิมไว้อัปต่อ
  if (!job) return;
  photos.forEach(p => { if (p.pending && p.dataUrl) { p.jobId = p.jobId || job.id; bgPending.set(bgKey(p), p); } });
}
function adoptPending() {       // เปิดงาน: รูปที่ค้างของงานนี้กลับมาอยู่บนจอ (ยังรออัป)
  if (!job) return;
  bgPending.forEach((p, k) => {
    if (p.jobId !== job.id) return;
    if (p.itemId && !items.has(p.itemId)) return;
    photos.set(pkey(p.itemId, p.slot), p);
    bgPending.delete(k);
  });
}
const allPending = () => [...photos.values()].filter(p => p.pending && p.dataUrl).concat([...bgPending.values()]);
/* รูปรออัปโหลดเก็บลงเครื่องด้วย (IndexedDB) — รีโหลด / ปิดแท็บ / iPad ปิดแอพเอง ก่อนเชื่อม Drive ทัน → รูปไม่หาย
   เปิดแอพใหม่ → กลับมาเป็นรูปรออัป (งานที่เปิด = ขึ้นบนจอ, งานอื่น = อัปเบื้องหลัง) · ลบออกเมื่ออัปขึ้นระบบแล้ว / รายการถูกลบ */
let pendingStore = null;
function savePending(p) {
  if (!pendingStore || !p || !p.dataUrl || !(p.jobId || job)) return;
  p.jobId = p.jobId || job.id;
  pendingStore.setItem(bgKey(p), {
    jobId: p.jobId, itemId: p.itemId || null, slot: p.slot, dataUrl: p.dataUrl, origDataUrl: p.origDataUrl || null, edit: p.edit || null,
    id: p.id || null, driveId: p.driveId || null, origDriveId: p.origDriveId || null, uploadedBy: p.uploadedBy || null, savedAt: Date.now()
  }).catch(e => console.warn('[pending] save', e));
}
function dropPending(p) {
  if (!pendingStore || !p || !p.jobId) return;
  pendingStore.removeItem(bgKey(p)).catch(() => {});
}
let pendingRestored = null;
function restorePending() {
  if (!pendingRestored) pendingRestored = (async () => {
    if (!pendingStore) return;
    const list = [];
    await pendingStore.iterate(v => { if (v && v.jobId && v.dataUrl) list.push(v); }).catch(e => console.warn('[pending] restore', e));
    list.forEach(v => {
      const p = Object.assign({ pending: true, uploading: false }, v);
      const k = bgKey(p);
      if (!bgPending.has(k)) bgPending.set(k, p);
    });
    if (list.length) { updateDriveBanner(); flushPendingUploads(); }
  })();
  return pendingRestored;
}
const folderCache = new Map();  // jobId → drive folder id (งานที่ไม่ได้เปิดอยู่)
async function folderFor(jobId) {
  if (job && job.id === jobId) return ensureJobFolder();
  if (folderCache.has(jobId)) return folderCache.get(jobId);
  const { data, error } = await sb.from('qc_jobs').select('name, drive_folder_id').eq('id', jobId).single();
  // ไม่มีเน็ต/server ล่ม ≠ งานถูกลบ — ทิ้งรูปเฉพาะเมื่อถามได้แล้วไม่มีงานนี้จริง (PGRST116) ไม่งั้นเก็บไว้ลองใหม่
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) throw codedErr('gone', 'งานนี้ถูกลบแล้ว');
  let fid = data.drive_folder_id;
  if (!fid) {
    fid = await driveCreateFolder(`${(data.name || '').trim() || cfg.appTitle} [${jobId.slice(0, 8)}]`, DRIVE_ROOT_FOLDER_ID);
    await sb.from('qc_jobs').update({ drive_folder_id: fid, drive_folder_owner: currentUser.id }).eq('id', jobId);
  }
  folderCache.set(jobId, fid);
  return fid;
}
const codedErr = (code, msg) => Object.assign(new Error(msg), { code });
/* Google Drive ตอบว่ายิงถี่เกิน → พักแล้วลองใหม่เอง (ไม่นับเป็นล้ม) */
let driveBackoff = 0, drivePausedUntil = 0;
const isRateLimit = e => e && (e.status === 429 || (e.status === 403 && /rate|quota|limit/i.test(e.message || '')) || e.status === 500 || e.status === 502 || e.status === 503);
async function uploadPhoto(p) {
  if (!isOnline() || !p || !p.dataUrl || p.uploading) return;
  if (!p.jobId) { if (!job) return; p.jobId = job.id; }
  p.pending = true;
  if (!hasDriveToken()) { updateDriveBanner(); return; }   // รอผู้ใช้กด "เชื่อมต่อ Drive"
  p.uploading = true;
  updateDriveBanner();
  // แก้รูป = อัปเป็นไฟล์ใหม่เสมอ ไม่ทับไฟล์เดิม → id เปลี่ยน ทุกเครื่องจึงรู้ว่าต้องโหลดรูปใหม่
  const src = p.dataUrl, origSrc = p.origDataUrl, jobId = p.jobId;
  try {
    if (job && job.id === jobId && !(await waitInserted(p.itemId))) throw new Error('รายการของรูปนี้ยังบันทึกไม่เสร็จ');
    const folderId = await folderFor(jobId);
    let origId = p.origDriveId;
    if (origSrc && !origId) {
      origId = await driveUpload(await (await fetch(origSrc)).blob(), photoFileName(p, true), folderId);
      photoCache.setItem(origId, origSrc);
    }
    const newId = await driveUpload(await (await fetch(src)).blob(), photoFileName(p, false), folderId);
    const row = { job_id: jobId, item_id: p.itemId, slot: p.slot, drive_file_id: newId, original_drive_file_id: origSrc ? origId : null, edit: p.edit || null, uploaded_by: currentUser.id };
    const { data, error } = await sb.from('qc_photos').upsert(row, { onConflict: 'job_id,item_id,slot' }).select('id').single();
    if (error) {
      driveDelete(newId, currentUser.id, false);
      if (error.code === '23503') throw codedErr('gone', 'รายการของรูปนี้ถูกลบแล้ว');   // งาน/รายการถูกลบ → ทิ้งรูปนี้
      throw error;
    }
    driveBackoff = 0;
    lastDriveError = '';
    bgPending.delete(bgKey(p));
    if (p.dataUrl === src && p.origDataUrl === origSrc) dropPending(p);   // ถูกแก้ระหว่างอัป → เก็บตัวใหม่ไว้จนกว่าจะอัปเสร็จ
    const oldId = p.driveId, oldOwner = p.uploadedBy, oldOrig = p.origDriveId;
    Object.assign(p, { id: data.id, driveId: newId, origDriveId: origSrc ? origId : null, uploadedBy: currentUser.id, pending: false });
    photoCache.setItem(newId, src);
    if (oldId && oldId !== newId) driveDelete(oldId, oldOwner, false);
    if (oldOrig && oldOrig !== p.origDriveId) driveDelete(oldOrig, oldOwner, false);
    // realtime อาจสลับ object ใน map ระหว่างอัปโหลด → ให้ตัวปัจจุบันได้ค่าใหม่ด้วย
    const cur = job && job.id === jobId ? photos.get(pkey(p.itemId, p.slot)) : null;
    if (cur && cur !== p && cur.dataUrl === src) Object.assign(cur, { id: p.id, driveId: newId, origDriveId: p.origDriveId, uploadedBy: currentUser.id, pending: false });
    // อัปเสร็จพอดีระหว่างเปิดงานนี้ (ดึงงานไปก่อนแถวรูปถึง server) → ใส่เข้างานที่เปิดอยู่ ไม่งั้นรูปไม่ขึ้นจอจนกว่าจะเปิดใหม่
    else if (!cur && job && job.id === jobId && (!p.itemId || items.has(p.itemId))) photos.set(pkey(p.itemId, p.slot), p);
    if (job && job.id === jobId) notifyPhoto(p);
  } catch (e) {
    console.error('[upload]', e);
    if (e.code === 'gone') { p.pending = false; bgPending.delete(bgKey(p)); dropPending(p); }
    else if (isRateLimit(e)) {
      // Drive ให้รอ — พักทั้งคิวแล้วลองใหม่เอง (เพิ่มเวลารอทีละเท่า สูงสุด 1 นาที)
      driveBackoff = Math.min(60000, (driveBackoff || 2000) * 2);
      drivePausedUntil = Date.now() + driveBackoff;
      lastDriveError = 'Google Drive ให้รอสักครู่ — จะอัปต่อเอง';
      setTimeout(flushPendingUploads, driveBackoff + 100);
    }
    else if (e.status !== 401) {
      lastDriveError = e.message; toast('อัปโหลดรูปไม่สำเร็จ — จะลองใหม่');
      setTimeout(flushPendingUploads, 3000);   // เช่น ออกจากแอพระหว่างอัป (iPad ตัดการเชื่อมต่อ) → ลองใหม่เองเร็ว ๆ ไม่ต้องกดเอง
    }
  }
  p.uploading = false;
  if ((p.dataUrl !== src || p.origDataUrl !== origSrc) && !p.pending) { p.pending = true; return uploadPhoto(p); }   // ถูกแก้ระหว่างอัปโหลด → อัปรอบใหม่
  updateDriveBanner();
}

/* คิวอัปโหลด: ครั้งละ 3 รูป (แอพที่ใส่รูปทีละมาก ๆ เช่น Thermoscan ไม่ยิงพร้อมกันเป็นร้อย) — รูปที่เพิ่มระหว่างทางก็ถูกหยิบต่อ */
let uploadsRunning = false;
async function flushPendingUploads() {
  if (uploadsRunning || !hasDriveToken() || !isOnline()) return;
  uploadsRunning = true;
  const tried = new Set();   // รอบนี้ลองแล้ว (ล้ม) → ไม่วนซ้ำไม่รู้จบ รอรอบหน้า
  // งานที่เปิดอยู่ก่อน แล้วค่อยรูปค้างของงานอื่น
  const next = () => {
    for (const p of photos.values()) if (p.pending && !p.uploading && p.dataUrl && !tried.has(p)) return p;
    for (const p of bgPending.values()) if (p.pending && !p.uploading && p.dataUrl && !tried.has(p)) return p;
    return null;
  };
  try {
    await Promise.all([0, 1, 2].map(async () => {
      let p;
      while (hasDriveToken() && isOnline() && Date.now() >= drivePausedUntil && (p = next())) { tried.add(p); await uploadPhoto(p); if (p.pending) continue; tried.delete(p); }
    }));
  } finally {
    uploadsRunning = false;
    updateDriveBanner();
    if (!allPending().length) finishResumes();
  }
}

function updateDriveBanner() {
  let pending = 0, needLoad = 0;
  if (isOnline()) {
    photos.forEach(p => { if (p.pending) pending++; if (p.driveId && !p.dataUrl && !p.pending) needLoad++; });
    pending += bgPending.size;
  }
  let b = document.getElementById('atDriveBanner');
  if (!pending && !needLoad) { if (b) b.style.display = 'none'; lastDriveError = ''; return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'atDriveBanner'; b.className = 'at-banner at-root no-print';
    b.innerHTML = '<span data-t></span><button class="at-btn primary" type="button" data-b></button>';
    b.querySelector('[data-b]').onclick = connectDrive;
    document.body.appendChild(b);
  }
  const token = hasDriveToken();
  const busy = token && !lastDriveError;   // กำลังอัป/โหลดตามปกติ → ไม่ต้องมีปุ่ม (ปุ่ม "ลองอีกครั้ง" ทำให้เข้าใจว่าพัง)
  const parts = [];
  if (pending) parts.push(busy ? `กำลังอัปโหลดรูป ${pending} รูป…` : `รูป ${pending} รูปรออัปโหลด`);
  if (needLoad) parts.push(busy ? `กำลังโหลดรูป ${needLoad} รูป…` : `รูป ${needLoad} รูปยังไม่ได้โหลด`);
  let text = parts.join(' · ');
  if (!token) text += ' — ต้องเชื่อมต่อ Google Drive';
  else if (lastDriveError) text += ' — ' + lastDriveError;
  b.querySelector('[data-t]').textContent = text;
  const btn = b.querySelector('[data-b]');
  btn.textContent = token ? 'ลองอีกครั้ง' : 'เชื่อมต่อ Drive';
  btn.style.display = busy ? 'none' : '';
  b.style.display = 'flex';
}

function notifyPhoto(p) {
  try { if (cfg.onPhoto) cfg.onPhoto(p); else render(); } catch (e) { console.error(e); }
}

let photoLoadBusy = false, photoLoadAgain = false;
async function loadJobPhotos() {
  if (photoLoadBusy) { photoLoadAgain = true; return; }
  photoLoadBusy = true;
  try {
    const todo = [];
    photos.forEach(p => { if (p.driveId && !p.dataUrl && !p.pending) todo.push(p); });
    for (const p of todo) {
      const cached = await photoCache.getItem(p.driveId).catch(() => null);
      if (cached) { p.dataUrl = cached; notifyPhoto(p); }
    }
    const rest = todo.filter(p => !p.dataUrl);
    if (rest.length && hasDriveToken()) {
      let i = 0;
      await Promise.all([0, 1, 2].map(async () => {
        while (i < rest.length && hasDriveToken()) {
          const p = rest[i++];
          try {
            const d = await driveDownloadDataUrl(p.driveId);
            photoCache.setItem(p.driveId, d);
            if (!p.dataUrl) { p.dataUrl = d; notifyPhoto(p); }
          } catch (e) { console.error('[photo]', p.driveId, e.message); if (e.status !== 401) lastDriveError = e.message; }
        }
      }));
    }
  } finally {
    photoLoadBusy = false;
    updateDriveBanner();
    if (photoLoadAgain) { photoLoadAgain = false; loadJobPhotos(); }
  }
}

/* ต้นฉบับของรูป (ก่อนครอป/วาด) — โหลดตอนต้องใช้เท่านั้น เช่น เปิดหน้าแก้รูป */
async function loadOriginal(p) {
  if (!p) return null;
  if (p.origDataUrl) return p.origDataUrl;
  if (!p.origDriveId) return p.dataUrl;
  let d = await photoCache.getItem(p.origDriveId).catch(() => null);
  if (!d && (hasDriveToken() || await getDriveToken(true))) {
    try { d = await driveDownloadDataUrl(p.origDriveId); photoCache.setItem(p.origDriveId, d); } catch (e) { console.warn('[photo] original', e.message); }
  }
  if (d) p.origDataUrl = d;
  return d || p.dataUrl;
}

/* ก่อน export PDF: โหลดรูปที่ยังไม่ได้โหลดให้ครบ — คืนจำนวนที่ยังขาด */
/* ก่อน export PDF (เหมือน MoM): คืน true = รูปครบ · ไม่ครบ/ยังไม่เชื่อม Drive → บอกผู้ใช้แล้วคืน false
   onBusy(text) = แอพแสดงหน้าต่าง "กำลังโหลดรูป..." (onBusy(null) = ปิด) */
async function ensurePhotosLoaded(onBusy) {
  const missing = () => [...photos.values()].filter(p => p.driveId && !p.dataUrl).length;
  if (!missing()) return true;
  if (!hasDriveToken() && !(await getDriveToken(true))) { toast('ต้องเชื่อมต่อ Google Drive เพื่อโหลดรูปก่อน Export'); return false; }
  if (onBusy) onBusy('กำลังโหลดรูปจาก Google Drive...');
  while (photoLoadBusy) await new Promise(r => setTimeout(r, 200));
  await loadJobPhotos();
  if (onBusy) onBusy(null);
  const n = missing();
  if (n) { toast(`โหลดรูปไม่ครบ (${n} รูป) — ลองใหม่อีกครั้ง`); return false; }
  return true;
}

/* ========================================================================
   JOBS — โหลด/สร้าง/เปิดงาน + realtime ให้ทั้งทีมเห็นพร้อมกัน (เหมือน MoM)
   ======================================================================== */
/* Supabase ตอบไม่เกิน 1000 แถวต่อคำขอ (รวมแถวที่ฝังมากับ select) → งานใหญ่ (Thermoscan 1000+ รายการ / รูป 1500)
   ต้องดึงทีละหน้า ไม่งั้นรายการ/รูปเกิน 1000 จะหายจากจอ (ข้อมูลในระบบยังอยู่ครบ) */
const PAGE = 1000;
async function fetchAllRows(table, jobId, columns) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(columns || '*').eq('job_id', jobId).order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}
async function fetchJobTree(id) {
  const { data, error } = await sb.from('qc_jobs').select('*').eq('id', id).single();
  if (error) throw error;
  const [its, phs] = await Promise.all([fetchAllRows('qc_items', id), fetchAllRows('qc_photos', id)]);
  data.qc_items = its;
  data.qc_photos = phs;
  return data;
}

function rowsToModel(row) {
  return {
    job: { id: row.id, name: row.name, customer: row.customer, meta: row.meta || {}, driveFolderId: row.drive_folder_id, driveFolderOwner: row.drive_folder_owner },
    items: (row.qc_items || []).map(r => ({ id: r.id, parentId: r.parent_id, kind: r.kind, sort: r.sort_order, data: r.data || {} })),
    photos: (row.qc_photos || []).map(r => ({
      id: r.id, itemId: r.item_id, slot: r.slot, driveId: r.drive_file_id, origDriveId: r.original_drive_file_id,
      edit: r.edit, uploadedBy: r.uploaded_by, dataUrl: null, origDataUrl: null, pending: false, uploading: false
    }))
  };
}

function applyRemote(m, fresh) {
  if (fresh) {
    job = m.job;
    items = new Map(m.items.map(i => [i.id, i]));
    photos = new Map(m.photos.map(p => [pkey(p.itemId, p.slot), p]));
    return;
  }
  // อัปเดต object เดิม "ในที่" — closure ที่ค้างอยู่ (กำลังเลือกรูป / แก้รูป / อัปโหลด) ยังชี้ตัวที่อยู่บนหน้าจอ
  Object.assign(job, m.job);
  const next = new Map();
  m.items.forEach(ri => {
    const oi = items.get(ri.id);
    inflight.delete(ri.id);
    if (oi) { Object.assign(oi, ri); next.set(ri.id, oi); } else next.set(ri.id, ri);
  });
  // รายการที่เพิ่งสร้างและ server ยังไม่ทันมี → คงไว้
  items.forEach((oi, id) => { if (!next.has(id) && inflight.has(id)) next.set(id, oi); });
  items = next;
  const nextP = new Map();
  m.photos.forEach(rp => {
    const k = pkey(rp.itemId, rp.slot), op = photos.get(k);
    if (op && op.pending) nextP.set(k, op);   // รูปของเราที่ยังอัปไม่เสร็จ = ใหม่กว่า
    else if (op && op.driveId === rp.driveId) { Object.assign(op, { id: rp.id, uploadedBy: rp.uploadedBy, edit: rp.edit, origDriveId: rp.origDriveId }); nextP.set(k, op); }
    else nextP.set(k, rp);
  });
  photos.forEach((op, k) => { if (!nextP.has(k) && op.pending && (!op.itemId || items.has(op.itemId))) nextP.set(k, op); });
  photos = nextP;
}

let rtChannel = null, rtTimer = null;
function subscribeJob(id) {
  if (rtChannel) { sb.removeChannel(rtChannel); rtChannel = null; }
  const mine = ev => ((ev.new && ev.new.job_id) || (ev.old && ev.old.job_id)) === id;
  // DELETE กรองด้วย filter ไม่ได้ (ข้อจำกัดของ Supabase) → รับทั้งหมดแล้วเช็ค job_id เอง
  rtChannel = sb.channel('qc-' + cfg.app + '-' + id)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'qc_jobs', filter: 'id=eq.' + id }, ev => {
      const a = ev.old || {}, b = ev.new || {};
      // แก้รายการ/รูป → trigger ขยับแค่ updated_at ของงาน ไม่ต้องดึงซ้ำ
      if (a.name === b.name && a.customer === b.customer && JSON.stringify(a.meta) === JSON.stringify(b.meta) && a.drive_folder_id === b.drive_folder_id) return;
      scheduleRemoteRefresh();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'qc_jobs' }, ev => { if (ev.old && ev.old.id === id) scheduleRemoteRefresh(); })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'qc_items', filter: 'job_id=eq.' + id }, scheduleRemoteRefresh)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'qc_items', filter: 'job_id=eq.' + id }, scheduleRemoteRefresh)
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'qc_items' }, ev => { if (mine(ev)) scheduleRemoteRefresh(); })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'qc_photos', filter: 'job_id=eq.' + id }, scheduleRemoteRefresh)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'qc_photos', filter: 'job_id=eq.' + id }, scheduleRemoteRefresh)
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'qc_photos' }, ev => { if (mine(ev)) scheduleRemoteRefresh(); })
    .subscribe();
}
function scheduleRemoteRefresh() { clearTimeout(rtTimer); rtTimer = setTimeout(remoteRefresh, 600); }

/* iPad พักแอปเบื้องหลัง → websocket หลุด/พลาด event → กลับมาหน้าจอให้ดึงข้อมูลล่าสุดเสมอ */
function onAppResume() {
  if (waitingNet) { retryStart(); return; }
  if (!isOnline() || !currentUser) return;
  processDriveCleanup();
  if (!job) return;
  scheduleRemoteRefresh();
  flushRetryQueue();
  flushPendingUploads();
}

/* ห้ามวาดหน้าใหม่ระหว่างพิมพ์: render() สร้างช่องกรอกใหม่ → iPad รีเซ็ตแป้นพิมพ์
   และ realtime ยิงกลับมาหาเราเองทุกครั้งที่บันทึก → เลื่อนไปทำตอนเลิกพิมพ์แทน */
let refreshDeferred = false, suspendDepth = 0;
function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable) && !['file', 'checkbox', 'radio', 'button', 'range', 'color'].includes(a.type);
}
/* ยังมีของเราที่ยังไม่ถึง server (รอรวม / กำลังส่ง / รอส่งซ้ำ / แถวใหม่ยังไม่ยืนยัน) → ห้ามดึงของจาก server มาทับ */
const unsentLocal = () => pendingPatches.size || writesInFlight || retryQueue.length || inflightUnsent();
function runDeferredRefresh() {
  if (refreshDeferred && !isTyping() && !unsentLocal() && !suspendDepth) { refreshDeferred = false; scheduleRemoteRefresh(); }
}

async function remoteRefresh() {
  const id = job && job.id;
  if (!id || !isOnline()) return;
  // กำลังพิมพ์ / มีค่าค้างยังไม่บันทึก / แอพขอพัก (เช่น กำลังสร้าง PDF) → รอก่อน
  if (isTyping() || suspendDepth || unsentLocal()) { refreshDeferred = true; return; }
  try {
    const seq = writeSeq;
    const row = await fetchJobTree(id);
    if (!job || job.id !== id) return;
    // ระหว่างดึง มีการเขียนของเราเกิดขึ้น → ของที่ได้มาอาจเก่ากว่าที่เราเพิ่งแก้ → ทิ้ง แล้วดึงใหม่หลังเขียนเสร็จ
    if (isTyping() || suspendDepth || unsentLocal() || seq !== writeSeq) { refreshDeferred = true; runDeferredRefresh(); return; }
    applyRemote(rowsToModel(row), false);
    render(true);
    updateDriveBanner();
    loadJobPhotos();
  } catch (e) {
    if (e.code === 'PGRST116') { toast('งานนี้ถูกลบออกจากระบบแล้ว'); leaveJob(); showJobList(true); }
    else console.error('[realtime]', e);
  }
}
const inflightUnsent = () => [...inflight.values()].some(f => !f.done);

async function openJob(id, opts = {}) {
  await flushPendingWrites();
  const row = await fetchJobTree(id);
  parkPending();
  inflight.clear();
  applyRemote(rowsToModel(row), true);
  adoptPending();
  if (!opts.keepScreen) render();
  subscribeJob(id);
  lsSet(lastJobKey(), id);
  updateDriveBanner();
  loadJobPhotos();
  if (!opts.noResume) resumePush(id).catch(e => console.warn('[resume push]', e));
  if (allPending().length) flushPendingUploads();
}

function leaveJob(keepLast) {
  if (rtChannel) { sb.removeChannel(rtChannel); rtChannel = null; }
  parkPending();
  job = null; items = new Map(); photos = new Map();
  inflight.clear();
  render();
  updateDriveBanner();
  if (!keepLast) lsSet(isOnline() ? lastJobKey() : lastJobKey() + '_offline', null);
}

async function createJob(meta, extra) {
  const id = uuid();
  const row = {
    id, app: cfg.app,
    name: (meta && meta.name) || '', customer: (meta && meta.customer) || '', meta: (meta && meta.meta) || {},
    created_by: currentUser.id, updated_by: currentUser.id
  };
  if (extra && extra.legacyDocId) row.legacy_doc_id = extra.legacyDocId;
  if (extra && extra.driveFolderId) { row.drive_folder_id = extra.driveFolderId; row.drive_folder_owner = extra.driveFolderOwner || null; }
  const { error } = await sb.from('qc_jobs').insert(row);
  if (error) throw error;
  return id;
}

/* ลบงานทีม: เก็บรายการไฟล์ Drive ไว้ก่อน (cascade จะลบแถว qc_photos ทิ้ง) → ลบ DB → ทิ้งไฟล์/โฟลเดอร์ใน Drive */
async function deleteTeamJob(id) {
  const { data: m } = await sb.from('qc_jobs').select('drive_folder_id, drive_folder_owner').eq('id', id).single();
  if (m) m.qc_photos = await fetchAllRows('qc_photos', id, 'drive_file_id, original_drive_file_id, uploaded_by').catch(() => []);
  const { error } = await sb.from('qc_jobs').delete().eq('id', id);
  if (error) throw error;
  if (!m) return;
  for (const p of (m.qc_photos || [])) {
    await driveDelete(p.drive_file_id, p.uploaded_by, false);
    if (p.original_drive_file_id) await driveDelete(p.original_drive_file_id, p.uploaded_by, false);
  }
  if (m.drive_folder_id) await driveDelete(m.drive_folder_id, m.drive_folder_owner, true);
  processDriveCleanup();
}

/* ยังไม่ได้เปิดงาน (เช่นปิดป๊อบอัพรายการไป) → สร้างงานใหม่ให้เลย จะได้ทำงานต่อได้ทันที */
let ensuring = null;
/* opts.keepScreen = ไม่วาดหน้าจอใหม่หลังสร้างงาน (แอพจะส่งของที่อยู่บนจอขึ้นงานใหม่เอง — ใช้กับ reconcile) */
function ensureJob(opts = {}) {
  if (job) return Promise.resolve(true);
  if (ensuring) return ensuring;
  ensuring = (async () => {
    try {
      if (isOnline()) { if (!currentUser) return false; await openJob(await createJob({}), opts); }
      else await openLocalJob(await createLocalJob({}), opts);
      if (!opts.keepScreen) await runSeed();
      return true;
    } catch (e) {
      console.error(e);
      toast('สร้างงานใหม่ไม่สำเร็จ');
      return false;
    } finally { ensuring = null; }
  })();
  return ensuring;
}

async function runSeed() {
  if (!cfg.seed) return;
  try { await cfg.seed(api); } catch (e) { console.error('[seed]', e); }
  render();
}

async function canLeave() {
  try { return (await (cfg.beforeLeave ? cfg.beforeLeave() : true)) !== false; } catch (e) { console.error(e); return false; }
}

async function startNewJob() {
  if (!(await canLeave())) return;
  await flushPendingWrites();
  let id;
  try { id = isOnline() ? await createJob({}) : await createLocalJob({}); }
  catch (e) { console.error(e); toast('สร้างงานไม่สำเร็จ'); return; }
  if (isOnline()) await openJob(id); else await openLocalJob(id);
  await runSeed();
  toast('เริ่มงานใหม่');
}

/* สร้างงานใหม่ในทีมจากก้อนข้อมูล (งานออฟไลน์ / ไฟล์ JSON) → รูปเข้าคิวอัปโหลด → คืน id */
const pushMapKey = jobId => 'avatar_team_pushmap_' + jobId;
async function pushModelToTeam(src, extra) {
  const m = normalizeModel(src);
  const id = await createJob({ name: m.job.name, customer: m.job.customer, meta: m.job.meta }, extra);
  const idMap = new Map(m.items.map(i => [i.id, uuid()]));
  // จำไว้ในเครื่อง: งานทีม id นี้มาจากงานในเครื่องตัวไหน (รูปต้นฉบับอยู่ที่นั่น) — ปิดแอพกลางทาง เปิดงานนี้ใหม่ = อัปต่อ
  if (extra && extra.localId) await localforage.setItem(pushMapKey(id), { app: cfg.app, localId: extra.localId, idMap: [...idMap] }).catch(() => {});
  const rows = m.items.map(i => ({
    id: idMap.get(i.id), job_id: id, parent_id: i.parentId ? (idMap.get(i.parentId) || null) : null,
    kind: i.kind, sort_order: i.sort, data: i.data, updated_by: currentUser.id
  }));
  // แม่ก่อนลูก (foreign key)
  const done = new Set(), ordered = [];
  let guard = rows.length + 1;
  while (ordered.length < rows.length && guard--) {
    rows.forEach(r => { if (!done.has(r.id) && (!r.parent_id || done.has(r.parent_id))) { ordered.push(r); done.add(r.id); } });
  }
  for (let i = 0; i < ordered.length; i += 200) {
    const { error } = await sb.from('qc_items').insert(ordered.slice(i, i + 200));
    if (error) throw error;
  }
  // รูปที่อยู่บน Drive อยู่แล้ว (ย้ายงานจากระบบเดิม) → ใช้ไฟล์เดิม ไม่อัปโหลดซ้ำ
  const linked = m.photos.filter(p => !p.dataUrl && p.driveId && (!p.itemId || idMap.has(p.itemId))).map(p => ({
    job_id: id, item_id: p.itemId ? idMap.get(p.itemId) : null, slot: String(p.slot), drive_file_id: p.driveId,
    original_drive_file_id: p.origDriveId || null, edit: p.edit || null, uploaded_by: null
  }));
  for (let i = 0; i < linked.length; i += 200) {
    const { error } = await sb.from('qc_photos').insert(linked.slice(i, i + 200));
    if (error) throw error;
  }
  await openJob(id, { noResume: true });   // รูปของงานนี้กำลังจะเข้าคิวด้านล่าง — ไม่ต้องให้ resume ใส่ซ้ำ
  m.photos.forEach(p => {
    const itemId = p.itemId ? idMap.get(p.itemId) : null;
    if (p.itemId && !itemId) return;
    if (!p.dataUrl) return;
    photos.set(pkey(itemId, p.slot), {
      id: null, jobId: id, itemId, slot: String(p.slot), driveId: null, origDriveId: null, edit: p.edit || null, uploadedBy: null,
      dataUrl: p.dataUrl, origDataUrl: p.origDataUrl || null, pending: true, uploading: false
    });
  });
  render();
  updateDriveBanner();
  flushPendingUploads();
  return id;
}

/* เปิดงานทีมที่ส่งขึ้นจากเครื่องนี้ แต่รูปยังขึ้นไม่ครบ (ปิดแอพ / เน็ตหลุด กลางทาง) → อัปรูปที่ขาดจากสำเนาในเครื่องต่อ */
const resumingJobs = new Set();
async function resumePush(jobId) {
  if (!isOnline() || resumingJobs.has(jobId)) return;
  const map = await localforage.getItem(pushMapKey(jobId)).catch(() => null);
  if (!map || map.app !== cfg.app) return;
  resumingJobs.add(jobId);
  try {
    const local = (await getLocalJobs()).find(x => x.id === map.localId);
    if (!local) { await localforage.removeItem(pushMapKey(jobId)); return; }
    const idMap = new Map(map.idMap);
    const m = normalizeModel(local.model);
    let added = 0, incomplete = 0;
    m.photos.forEach(p => {
      if (!p.dataUrl || !job || job.id !== jobId) return;
      const itemId = p.itemId ? idMap.get(p.itemId) : null;
      if (p.itemId && (!itemId || !items.has(itemId))) return;   // รายการถูกลบไปแล้ว — ไม่ต้องอัป
      const k = pkey(itemId, String(p.slot)), cur = photos.get(k);
      if (cur && cur.driveId) return;                  // ขึ้นแล้ว
      incomplete++;
      if (cur && cur.pending) return;                  // อยู่ในคิวแล้ว
      photos.set(k, { id: null, jobId, itemId, slot: String(p.slot), driveId: null, origDriveId: null, edit: p.edit || null, uploadedBy: null,
        dataUrl: p.dataUrl, origDataUrl: p.origDataUrl || null, pending: true, uploading: false });
      added++;
    });
    if (added) { toast(`กำลังอัปรูปที่ยังขาด ${added} รูป จากสำเนาในเครื่อง`, 4000); render(); updateDriveBanner(); flushPendingUploads(); }
    if (!incomplete) await localforage.removeItem(pushMapKey(jobId));   // ทุกรูปขึ้นระบบครบแล้วจริง ๆ
  } finally { resumingJobs.delete(jobId); }
}
function finishResumes() {
  // คิวว่าง = งานที่เปิดอยู่ไม่มีรูปค้าง → ถ้าส่งมาจากเครื่องนี้ ลองเช็คอีกรอบว่าครบ (ครบแล้วลบที่จำไว้)
  if (job && isOnline()) resumePush(job.id).catch(() => {});
}

/* ย้ายงานจากระบบเดิม (ตาราง documents) — ของเดิมไม่ลบไม่แก้ · รูปใช้ไฟล์เดิมบน Drive · โฟลเดอร์งานเดิมใช้ต่อ
   2 คนกดพร้อมกัน → legacy_doc_id ซ้ำไม่ได้ → คนที่สองเปิดงานที่คนแรกย้ายไว้แทน */
async function migrateLegacyDoc(docId) {
  const { data: done } = await sb.from('qc_jobs').select('id').eq('legacy_doc_id', docId).maybeSingle();
  if (done) { await openJob(done.id); return done.id; }
  const { data: doc, error } = await sb.from('documents').select('*').eq('id', docId).single();
  if (error) throw error;
  const model = await cfg.legacyDocs.toModel(doc);
  try {
    return await pushModelToTeam(model, { legacyDocId: docId, driveFolderId: doc.drive_folder_id, driveFolderOwner: doc.drive_folder_owner });
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    const { data: again } = await sb.from('qc_jobs').select('id').eq('legacy_doc_id', docId).maybeSingle();
    if (again) { await openJob(again.id); return again.id; }
    throw e;
  }
}

/* ========================================================================
   AUTH
   ======================================================================== */
async function onSignedIn(session) {
  appMode = 'online';
  lsSet(MODE_KEY, 'online');
  currentUser = session.user;
  if (session.provider_token) setDriveToken(session.provider_token, 3500);
  if (location.hash || /[?&]code=/.test(location.search)) history.replaceState(null, '', location.pathname);
  renderChip();
  setSync('saved');
  processDriveCleanup();
  await restoreOutbox();
  await flushRetryQueue();   // ของค้างจากรอบก่อน (เช่น เปิดแอพตอนไม่มีเน็ต) → ส่งก่อนเปิดงาน
  await restorePending();
  const last = lsGet(lastJobKey());
  if (last) {
    try { await openJob(last); }
    catch (e) {
      // เน็ตยังไม่มา (เปิดแอพตอนไม่มีเน็ต) → อย่าลืมงานล่าสุด รอเน็ตแล้วเปิดให้เอง · ลบเฉพาะเมื่องานไม่มีในระบบแล้วจริง ๆ
      if (!(e && e.code === 'PGRST116')) { console.warn('[team] เปิดงานล่าสุดไม่ได้ — รอเน็ต', e); waitForNet(); return; }
      lsSet(lastJobKey(), null);
    }
  }
  await showJobList(true);
}

/* เปิดแอพตอนไม่มีเน็ต: ของที่ยังไม่ได้ส่ง + รูปรออัป อยู่ในเครื่องแล้ว (outbox / pending) → พอเน็ตกลับมา เริ่มใหม่เอง
   (ส่งของค้าง → เปิดงานล่าสุด) ไม่ต้องรีเฟรชเอง · ไม่ส่งไปหน้าล็อกอินระหว่างไม่มีเน็ต */
let waitingNet = false, netRetrying = false;
function waitForNet() {
  if (waitingNet) return;
  waitingNet = true;
  setSync('error');
  toast('ไม่มีอินเทอร์เน็ต — ของที่ยังไม่ได้ส่งเก็บไว้ในเครื่องแล้ว เน็ตกลับมาจะเปิดงานล่าสุดให้เอง');
}
async function retryStart() {
  if (!waitingNet || netRetrying || !navigator.onLine || !isOnline()) return;
  netRetrying = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { waitingNet = false; toLogin(); return; }
    waitingNet = false;
    await onSignedIn(session);
  } catch (e) { console.warn('[team] retry start', e); waitingNet = true; }
  finally { netRetrying = false; }
}

function onSignedOut() {
  currentUser = null;
  leaveJob();
  renderChip();
  if (!cfg.noLoginRedirect) toLogin();   // หน้า index มีหน้าล็อกอินของตัวเอง (avatar-cloud loginHub)
}

/* ========================================================================
   รายการงาน (เหมือน MoM)
   ======================================================================== */
async function showJobList(force) {
  document.querySelectorAll('.at-modal-bg[data-job-list]').forEach(m => m.remove());
  const online = isOnline();
  const local = (await getLocalJobs()).sort((a, b) => b.updatedAt - a.updatedAt);
  let rows = [];
  if (online) {
    try {
      const { data, error } = await sb.from('qc_jobs')
        .select('id, name, customer, meta, updated_at').eq('app', cfg.app).order('updated_at', { ascending: false }).limit(300);
      if (error) throw error;
      rows = data;
    } catch (e) {
      console.error(e);
      toast('โหลดรายการงานไม่สำเร็จ');
      if (!force) return;
    }
  }
  // งานจากระบบเดิม (avatar-cloud / ตาราง documents) ที่ยังไม่ได้ย้าย
  let legacyRows = [];
  if (online && cfg.legacyDocs) {
    try {
      const [{ data: docs }, { data: moved }] = await Promise.all([
        sb.from('documents').select('id, name, customer, updated_at').eq('app', cfg.legacyDocs.app || cfg.app).order('updated_at', { ascending: false }).limit(300),
        sb.from('qc_jobs').select('legacy_doc_id').eq('app', cfg.app)
      ]);
      const done = new Set((moved || []).map(r => r.legacy_doc_id).filter(Boolean));
      legacyRows = (docs || []).filter(d => !done.has(d.id));
    } catch (e) { console.warn('[legacy docs]', e); }
  }
  const cur = job && job.id;
  const fmt = t => new Date(t).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const label = r => { try { return cfg.jobLabel ? cfg.jobLabel(r) : ''; } catch (_) { return ''; } };
  const curTag = '<span class="at-hist-tag">กำลังเปิด</span>';
  const teamItem = m => `
      <div class="at-hist-item" data-mid="${m.id}">
        <div class="at-hist-info" data-open="${m.id}">
          <div class="at-hist-name">${esc(m.name || 'ไม่ระบุชื่องาน')}${m.id === cur ? curTag : ''}</div>
          <div class="at-hist-date">${esc([m.customer, label(m), fmt(m.updated_at)].filter(Boolean).join(' · '))}</div>
        </div>
        <button class="at-hist-del" data-del="${m.id}" title="ลบ">🗑</button>
      </div>`;
  const localItem = m => `
      <div class="at-hist-item" data-lid="${m.id}">
        <div class="at-hist-info" ${online ? 'style="cursor:default;"' : `data-lopen="${m.id}"`}>
          <div class="at-hist-name">${esc(m.name || 'ไม่ระบุชื่องาน')}${(!online && m.id === cur) ? curTag : ''}</div>
          <div class="at-hist-date">${esc([m.customer, fmt(m.updatedAt)].filter(Boolean).join(' · '))}</div>
        </div>
        ${online ? `<button class="at-btn primary" data-push="${m.id}" style="padding:6px 10px;font-size:12px;min-height:0;">ส่งขึ้นทีม</button>` : ''}
        <button class="at-hist-del" data-ldel="${m.id}" title="ลบออกจากเครื่อง">🗑</button>
      </div>`;
  const legacyItem = m => `
      <div class="at-hist-item" data-gid="${m.id}">
        <div class="at-hist-info" style="cursor:default;">
          <div class="at-hist-name">${esc(m.name || 'ไม่ระบุชื่องาน')}</div>
          <div class="at-hist-date">${esc([m.customer, fmt(m.updated_at)].filter(Boolean).join(' · '))}</div>
        </div>
        <button class="at-btn primary" data-migrate="${m.id}" style="padding:6px 10px;font-size:12px;min-height:0;">ย้ายเข้าระบบใหม่</button>
      </div>`;
  const empty = txt => `<div style="text-align:center;color:#94a3b8;font-size:13px;padding:14px;">${txt}</div>`;
  const sectionTitle = txt => `<div style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:.5px;margin:0 4px 8px;">${txt}</div>`;
  const continueHtml = cur ? `
    <button class="at-continue" data-continue>
      <div style="font-weight:800;font-size:14px;">▶ ทำงานต่อ</div>
      <div style="font-size:12px;opacity:.9;margin-top:2px;">${esc((job.name || '').trim() || 'ไม่ระบุชื่องาน')}</div>
    </button>
    <div style="height:1px;background:#e2e8f0;margin:14px 0;"></div>` : '';
  const listsHtml = online
    ? sectionTitle(`งานทีม (${rows.length})`) +
      `<div class="at-hist-list">${rows.length ? rows.map(teamItem).join('') : empty('ยังไม่มีงานในระบบ')}</div>` +
      (legacyRows.length ? `<div style="height:1px;background:#e2e8f0;margin:14px 0;"></div>` +
        sectionTitle(`งานจากระบบเดิม (${legacyRows.length}) — กด "ย้ายเข้าระบบใหม่" ก่อนแก้ต่อ`) +
        `<div class="at-hist-list">${legacyRows.map(legacyItem).join('')}</div>` : '') +
      (local.length ? `<div style="height:1px;background:#e2e8f0;margin:14px 0;"></div>` +
        sectionTitle(`งานออฟไลน์ในเครื่องนี้ (${local.length}) — กด "ส่งขึ้นทีม" เพื่อย้ายเข้าระบบ`) +
        `<div class="at-hist-list">${local.map(localItem).join('')}</div>` : '')
    : sectionTitle(`งานในเครื่องนี้ (${local.length})`) +
      `<div class="at-hist-list">${local.length ? local.map(localItem).join('') : empty('ยังไม่มีงานในเครื่องนี้')}</div>`;
  const rescanHtml = (cfg.legacyLocal
    ? `<button class="at-btn" data-rescan style="width:100%;justify-content:center;margin-top:12px;font-size:12.5px;color:#64748b;">🔍 ค้นหางานเก่าจากเวอร์ชันก่อนในเครื่องนี้</button>` : '')
    + ((cfg.listExtras || []).length
      ? `<div style="display:flex;gap:8px;margin-top:8px;">${cfg.listExtras.map((x, i) => `<button class="at-btn" data-extra="${i}" style="flex:1;justify-content:center;font-size:12.5px;color:#64748b;">${esc(x.label)}</button>`).join('')}</div>` : '');

  const bg = buildModalOverlay(`
    <div class="at-modal-head"><span>${online ? 'รายการงาน (ทีม)' : 'งานในเครื่องนี้ (ออฟไลน์)'}</span><span class="at-close" data-close>×</span></div>
    <div class="at-modal-body">
      ${continueHtml}
      <input data-search placeholder="ค้นหาชื่องาน / ลูกค้า..." style="width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:9px 12px;font-size:13.5px;margin-bottom:10px;outline:none;">
      ${listsHtml}
      ${rescanHtml}
    </div>
    <div class="at-modal-foot" style="flex-wrap:wrap;gap:8px;">
      <button class="at-btn" data-switch style="flex:1;justify-content:center;">${online ? 'ใช้งานออฟไลน์' : 'เข้าสู่ระบบทีม'}</button>
      <button class="at-btn primary" data-new style="flex:2;justify-content:center;">+ เริ่มงานใหม่</button>
    </div>`);
  bg.dataset.jobList = '1';
  const close = () => bg.remove();
  bg.querySelector('[data-close]').onclick = close;
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  const cont = bg.querySelector('[data-continue]');
  if (cont) cont.onclick = () => { ensureDriveTokenFromGesture(); close(); };
  bg.querySelector('[data-search]').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    bg.querySelectorAll('.at-hist-item').forEach(it => {
      const m = it.dataset.mid ? rows.find(r => r.id === it.dataset.mid) : it.dataset.gid ? legacyRows.find(r => r.id === it.dataset.gid) : local.find(r => r.id === it.dataset.lid);
      it.style.display = !q || (((m && m.name) || '') + ' ' + ((m && m.customer) || '')).toLowerCase().includes(q) ? '' : 'none';
    });
  });
  bg.querySelector('[data-new]').onclick = async () => { ensureDriveTokenFromGesture(); close(); await startNewJob(); };
  bg.querySelector('[data-switch]').onclick = async () => {
    close();
    if (!(await canLeave())) return;
    if (online) await enterOfflineMode(); else await switchToOnline();
  };
  bg.querySelectorAll('[data-extra]').forEach(b => b.onclick = () => { close(); try { cfg.listExtras[+b.dataset.extra].onClick(); } catch (e) { console.error(e); } });
  const rescan = bg.querySelector('[data-rescan]');
  if (rescan) rescan.onclick = async () => {
    close();
    const r = await migrateLegacyLocal(true);
    toast(r.error ? 'สแกนไม่สำเร็จ: ' + r.error : (!r.found ? 'ไม่พบงานจากเวอร์ชันก่อนในเครื่องนี้' : `พบ ${r.found} งาน → เพิ่มใหม่ ${r.added} งาน`), 5000);
    showJobList(true);
  };
  bg.querySelectorAll('[data-open]').forEach(it => it.onclick = async () => {
    ensureDriveTokenFromGesture();
    close();
    if (it.dataset.open === cur) return;
    if (!(await canLeave())) return;
    try { await openJob(it.dataset.open); toast('เปิดงานแล้ว'); }
    catch (e) { console.error(e); toast('เปิดงานไม่สำเร็จ'); showJobList(true); }
  });
  bg.querySelectorAll('[data-lopen]').forEach(it => it.onclick = async () => {
    close();
    if (it.dataset.lopen === cur) return;
    if (!(await canLeave())) return;
    await flushPendingWrites();
    try { await openLocalJob(it.dataset.lopen); toast('เปิดงานแล้ว'); }
    catch (e) { toast('เปิดงานไม่สำเร็จ'); showJobList(true); }
  });
  bg.querySelectorAll('[data-del]').forEach(it => it.onclick = async e => {
    e.stopPropagation();
    const m = rows.find(x => x.id === it.dataset.del);
    const ok = await confirmDialog({
      title: 'ลบงานออกจากระบบทีม',
      message: `ต้องการลบงาน "<b>${esc(m ? (m.name || 'ไม่ระบุชื่องาน') : '')}</b>" ใช่ไหม?<br><span style="color:#94a3b8;font-size:12px;">ทุกคนในทีมจะไม่เห็นงานนี้อีก · รูปใน Google Drive จะถูกย้ายไปถังขยะ (กู้คืนได้ 30 วัน)</span>`,
      confirmText: 'ลบ', cancelText: 'ยกเลิก', danger: true
    });
    if (!ok) return;
    await deleteTeamJob(it.dataset.del).then(() => {
      if (it.dataset.del === cur) leaveJob();
      toast('ลบงานแล้ว');
    }).catch(err => { console.error(err); toast('ลบไม่สำเร็จ'); });
    showJobList(true);
  });
  bg.querySelectorAll('[data-ldel]').forEach(it => it.onclick = async e => {
    e.stopPropagation();
    const m = local.find(x => x.id === it.dataset.ldel);
    const ok = await confirmDialog({
      title: 'ลบงานออกจากเครื่องนี้',
      message: `ต้องการลบงานออฟไลน์ "<b>${esc(m ? (m.name || 'ไม่ระบุชื่องาน') : '')}</b>" ใช่ไหม?<br><span style="color:#94a3b8;font-size:12px;">การลบนี้ย้อนกลับไม่ได้</span>`,
      confirmText: 'ลบ', cancelText: 'ยกเลิก', danger: true
    });
    if (!ok) return;
    await setLocalJobs(local.filter(x => x.id !== it.dataset.ldel));
    if (!online && it.dataset.ldel === cur) leaveJob();
    toast('ลบงานแล้ว');
    showJobList(true);
  });
  bg.querySelectorAll('[data-migrate]').forEach(it => it.onclick = async () => {
    ensureDriveTokenFromGesture();
    close();
    if (!(await canLeave())) return;
    try { await migrateLegacyDoc(it.dataset.migrate); toast('ย้ายเข้าระบบใหม่แล้ว'); }
    catch (e) { console.error(e); toast('ย้ายไม่สำเร็จ — งานเดิมยังอยู่ครบ'); showJobList(true); }
  });
  bg.querySelectorAll('[data-push]').forEach(it => it.onclick = async () => {
    const m = local.find(x => x.id === it.dataset.push);
    if (!m) return;
    const ok = await confirmDialog({
      title: 'ส่งงานขึ้นทีม',
      message: `สร้างงาน "<b>${esc(m.name || 'ไม่ระบุชื่องาน')}</b>" ในระบบทีมจากสำเนาออฟไลน์ใช่ไหม?<br><span style="color:#94a3b8;font-size:12px;">รูปจะถูกอัปโหลดขึ้น Google Drive · สำเนาในเครื่องยังอยู่ ลบเองได้ภายหลัง</span>`,
      confirmText: 'ส่งขึ้นทีม'
    });
    if (!ok) return;
    ensureDriveTokenFromGesture();
    close();
    if (!(await canLeave())) return;
    try { await pushModelToTeam(m.model, { localId: m.id }); toast('ส่งขึ้นทีมแล้ว — กำลังอัปโหลดรูป'); }
    catch (e) { console.error(e); toast('ส่งขึ้นทีมไม่สำเร็จ'); showJobList(true); }
  });
}

/* ========================================================================
   MIRROR — สำหรับแอพที่มีข้อมูลเป็นต้นไม้ของ object อยู่แล้ว (เช่น Thermoscan)
   แอพแก้ object ของตัวเองตามเดิม แล้วเรียก team.reconcile(roots) → เทียบกับแถวในระบบ ส่งเฉพาะที่เปลี่ยน
   team.pull() → สร้าง object จากแถวในระบบ (ใช้ตอนเปิดงาน / มีคนอื่นแก้)
   schema = { roots: { buildings:'building' }, children: { building:{ cabinets:'cabinet' }, ... } }
   - ฟิลด์ที่เป็นรูป ('data:image...') → qc_photos ช่องชื่อเดียวกับฟิลด์
   - ฟิลด์ขึ้นต้นด้วย _ / File / ฟังก์ชัน → ไม่เก็บ · obj._tid = id ของแถว
   - รูปที่ยังโหลดจาก Drive ไม่เสร็จ = LOADING (เทียบแล้วข้าม ไม่ลบรูปบนระบบ)
   ======================================================================== */
const LOADING = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
function stableStr(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function').sort().map(k => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}';
}
const isPlain = v => v === null || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype;
function splitObj(obj, childKeys) {
  const data = {}, imgs = {};
  Object.keys(obj).forEach(k => {
    if (k[0] === '_' || childKeys.includes(k)) return;
    const v = obj[k];
    if (typeof v === 'string' && v.startsWith('data:image')) { imgs[k] = v; return; }
    if (v === undefined || typeof v === 'function' || !isPlain(v)) return;
    data[k] = v;
  });
  return { data: JSON.parse(JSON.stringify(data)), imgs };
}
let mirrorSchema = null;
/* กันข้อมูลหาย: reconcile ได้เฉพาะเมื่อหน้าจอโหลดจากงานนี้แล้ว (pull) — ไม่งั้นของว่างบนจอจะถูกตีความว่า "ลบทุกอย่าง" */
let mirrorJobId = null;
/* ฐานเทียบของแต่ละรายการ = ตอน pull / ส่งล่าสุด — ส่งเฉพาะที่ "จอนี้" แก้จากฐาน
   (ไม่งั้นจอที่ยังไม่ได้ดึงของล่าสุด จะส่งค่าเก่าไปทับของที่คนอื่นเพิ่งแก้)
   mirrorKnown = รายการที่จอนี้เคยเห็น — ลบได้เฉพาะตัวที่เคยเห็นแล้วหายจากจอ (ตัวที่คนอื่นเพิ่งเพิ่ม ยังไม่ได้ดึง → คงไว้) */
const mirrorBase = new Map();   // id → { data: stableStr, imgs: { slot: dataUrl } }
let mirrorKnown = new Set();
function mirrorKinds(schema) {
  const k = new Set(Object.values(schema.roots));
  Object.values(schema.children || {}).forEach(m => Object.values(m).forEach(x => k.add(x)));
  Object.keys(schema.children || {}).forEach(x => k.add(x));
  return k;
}
async function reconcile(roots, schema) {
  schema = schema || mirrorSchema;
  if (!job) {
    if (!(await ensureJob({ keepScreen: true }))) return false;
    mirrorJobId = job.id;   // งานใหม่ที่เพิ่งสร้างจากของบนจอ — ว่างอยู่ ปลอดภัยที่จะส่งของบนจอขึ้นไป
  }
  if (mirrorJobId !== job.id) { console.warn('[team] reconcile ข้าม: หน้าจอยังไม่ได้โหลดจากงานนี้'); return false; }
  const specs = [], seen = new Set(), photoOps = [];
  const walk = (parentId, arr, kind) => {
    const cm = (schema.children || {})[kind] || {}, ck = Object.keys(cm);
    (arr || []).forEach((obj, i) => {
      if (!obj || typeof obj !== 'object' || seen.has(obj._tid)) return;
      const it = obj._tid && items.get(obj._tid);
      // _keepData = บนจอนี้ไม่ได้แก้รายการนี้ (อาจเป็นของที่คนอื่นเพิ่งแก้ ยังไม่ได้ดึงมา) → ห้ามส่งข้อมูล/รูปของเราไปทับ
      // _keepPos  = ห้ามย้ายตำแหน่งด้วย · ทั้งสองแบบยังนับว่า "ยังอยู่" (ไม่ถูกลบ)
      if (it && obj._keepData) {
        if (!obj._keepPos && ((it.parentId || null) !== (parentId || null) || it.sort !== i)) api.moveItem(it.id, { parentId, sort: i });
        seen.add(it.id);
        photosOf(it.id);   // (ไม่แตะรูป)
        ck.forEach(k => walk(it.id, obj[k], cm[k]));
        return;
      }
      const { data, imgs } = splitObj(obj, ck);
      const base = it ? mirrorBase.get(it.id) : null;
      const dataStr = stableStr(data);
      if (!it) {
        // มี _tid แต่ไม่มีในระบบแล้ว + จอนี้ไม่ได้แก้ = คนอื่นเพิ่งลบ → ไม่สร้างกลับ
        if (obj._tid && mirrorKnown.has(obj._tid) && mirrorBase.has(obj._tid) && mirrorBase.get(obj._tid).data === dataStr) return;
        obj._tid = uuid();
        specs.push({ id: obj._tid, parentId, kind, sort: i, data });
        mirrorBase.set(obj._tid, { data: dataStr, imgs: {} });
      } else {
        if ((it.parentId || null) !== (parentId || null) || it.sort !== i) api.moveItem(it.id, { parentId, sort: i });
        if ((!base || base.data !== dataStr) && dataStr !== stableStr(it.data)) api.setItemData(it.id, data);
        if (base) base.data = dataStr; else mirrorBase.set(it.id, { data: dataStr, imgs: {} });
      }
      const id = obj._tid;
      seen.add(id);
      mirrorKnown.add(id);
      const b = mirrorBase.get(id);
      Object.entries(imgs).forEach(([slot, v]) => {
        if (v === LOADING) return;
        if (b.imgs[slot] !== v) photoOps.push([id, slot, v]);   // จอนี้เปลี่ยนรูปช่องนี้
        b.imgs[slot] = v;
      });
      // ช่องรูปที่จอนี้เคยมีแล้วหายไป = ลบรูป · ช่องที่จอนี้ไม่เคยมี (คนอื่นเพิ่งใส่) → คงไว้
      if (it) photosOf(id).forEach(p => { if (!(p.slot in imgs) && (p.slot in b.imgs)) { photoOps.push([id, p.slot, null]); delete b.imgs[p.slot]; } });
      ck.forEach(k => walk(id, obj[k], cm[k]));
    });
  };
  Object.entries(schema.roots).forEach(([k, kind]) => walk(null, roots[k], kind));
  if (specs.length) await api.addItems(specs);
  photoOps.forEach(([id, slot, v]) => {
    const p = api.photo(id, slot);
    if (v == null) { if (p) api.removePhoto(id, slot); }
    else if (!p || p.dataUrl !== v) api.setPhoto(id, slot, { dataUrl: v });
  });
  const kinds = mirrorKinds(schema);
  [...items.values()].filter(it => kinds.has(it.kind) && !seen.has(it.id) && mirrorKnown.has(it.id) && (!it.parentId || seen.has(it.parentId)))
    .forEach(it => { api.removeItem(it.id); mirrorKnown.delete(it.id); mirrorBase.delete(it.id); });
  return true;
}
const photosOf = itemId => [...photos.values()].filter(p => (p.itemId || null) === (itemId || null));
function pull(schema) {
  schema = schema || mirrorSchema;
  const index = new Map();
  mirrorBase.clear();
  mirrorKnown = new Set();
  const build = it => {
    const o = clone(it.data || {});
    o._tid = it.id;
    const bi = {};
    photosOf(it.id).forEach(p => { o[p.slot] = p.dataUrl || LOADING; bi[p.slot] = p.dataUrl || LOADING; });
    mirrorBase.set(it.id, { data: stableStr(it.data || {}), imgs: bi });
    mirrorKnown.add(it.id);
    const cm = (schema.children || {})[it.kind] || {};
    Object.entries(cm).forEach(([k, kind]) => { o[k] = children(it.id, kind).map(build); });
    index.set(it.id, o);
    return o;
  };
  const roots = {};
  Object.entries(schema.roots).forEach(([k, kind]) => { roots[k] = children(null, kind).map(build); });
  mirrorJobId = job ? job.id : null;
  return { roots, index };
}
/* ต้นไม้ของ object (เช่น ประวัติในเครื่องเวอร์ชันก่อน) → โมเดลสำหรับ "ส่งขึ้นทีม" / นำเข้า — ไม่แตะงานที่เปิดอยู่ */
function modelFromRoots(roots, schema, jobFields, jobPhotos) {
  const out = { job: Object.assign({ name: '', customer: '', meta: {} }, jobFields || {}), items: [], photos: [] };
  (jobPhotos || []).forEach(p => { if (p && p.dataUrl) out.photos.push({ itemId: null, slot: p.slot, dataUrl: p.dataUrl }); });
  const walk = (parentId, arr, kind) => {
    const cm = (schema.children || {})[kind] || {}, ck = Object.keys(cm);
    (arr || []).forEach((obj, i) => {
      if (!obj || typeof obj !== 'object') return;
      const { data, imgs } = splitObj(obj, ck), id = uuid();
      out.items.push({ id, parentId, kind, sort: i, data });
      Object.entries(imgs).forEach(([slot, v]) => { if (v !== LOADING) out.photos.push({ itemId: id, slot, dataUrl: v }); });
      ck.forEach(k => walk(id, obj[k], cm[k]));
    });
  };
  Object.entries(schema.roots).forEach(([k, kind]) => walk(null, roots[k], kind));
  return out;
}

/* ========================================================================
   API ให้แอพ
   ======================================================================== */
let startedResolve = () => {};
const started = new Promise(r => { startedResolve = r; });

/* เปลี่ยนชุดงาน (หน้าเดียวมีหลายฟอร์ม) → เปิดงานล่าสุดของฟอร์มนั้น + รายการงาน (เหมือนเข้าแอพ MoM) */
async function useApp(app, appTitle, opts = {}) {
  await started;
  if (cfg.app === app && job && !opts.force) { setSync(syncStatus); return; }
  await flushPendingWrites();
  if (rtChannel) { sb.removeChannel(rtChannel); rtChannel = null; }
  parkPending();   // รูปที่ยังรออัปของงานเดิม → อัปต่อเบื้องหลัง
  job = null; items = new Map(); photos = new Map(); inflight.clear(); mirrorJobId = null;
  cfg.app = app; cfg.appTitle = appTitle || app;
  if (opts.indicator) cfg.indicator = opts.indicator;
  if (opts.legacyDocs !== undefined) cfg.legacyDocs = opts.legacyDocs;
  setSync(syncStatus);
  updateDriveBanner();
  if (isOnline() && !currentUser) { render(); if (!cfg.noLoginRedirect) toLogin(); return; }
  if (isOnline()) { await restoreOutbox(); await restorePending(); }
  // opts.noOpen = แอพมีหน้ารายการงานของตัวเอง (เช่น ของขาดแบ่งเดือน/JOB) → ไม่เปิดงานล่าสุดเอง ไม่ขึ้นป๊อบอัพ
  if (opts.noOpen) { render(); return; }
  const key = isOnline() ? lastJobKey() : lastJobKey() + '_offline';
  const last = lsGet(key);
  if (last) {
    try { if (isOnline()) await openJob(last); else await openLocalJob(last); }
    catch (_) { lsSet(key, null); }
  }
  if (!job) render();
  await showJobList(true);
}

/* สำหรับแอพที่ทำหน้ารายการงานเอง: งานทั้งหมดของแอพนี้ (ออนไลน์ = ทีม · ออฟไลน์ = ในเครื่อง) */
async function listJobs() {
  if (!isOnline()) {
    return (await getLocalJobs()).map(m => ({ id: m.id, name: m.name || '', customer: m.customer || '', meta: (m.model && m.model.job && m.model.job.meta) || {}, updated_at: new Date(m.updatedAt || 0).toISOString(), local: true }));
  }
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('qc_jobs').select('id, name, customer, meta, updated_at')
      .eq('app', cfg.app).order('updated_at', { ascending: false }).range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

let renderDepth = 0;
function render(remote) {
  if (!cfg || !cfg.render) return;
  renderDepth++;
  try { cfg.render({ remote: !!remote }); } catch (e) { console.error('[render]', e); }
  finally { renderDepth--; }
}

function sortOf(parentId) {
  return [...items.values()].filter(i => (i.parentId || null) === (parentId || null));
}
function children(parentId, kind) {
  return sortOf(parentId).filter(i => !kind || i.kind === kind).sort((a, b) => (a.sort - b.sort) || String(a.id).localeCompare(String(b.id)));
}

/* sort ใหม่: ต่อท้าย / แทรกหลังรายการ after / ก่อนรายการ before */
function nextSort(parentId, opts = {}) {
  const sib = children(parentId);
  if (opts.after) {
    const i = sib.findIndex(s => s.id === opts.after);
    if (i >= 0) return i + 1 < sib.length ? (sib[i].sort + sib[i + 1].sort) / 2 : sib[i].sort + 1;
  }
  if (opts.before) {
    const i = sib.findIndex(s => s.id === opts.before);
    if (i >= 0) return i > 0 ? (sib[i - 1].sort + sib[i].sort) / 2 : sib[i].sort - 1;
  }
  return sib.length ? sib[sib.length - 1].sort + 1 : 0;
}

/* เขียนแถวใหม่ (ทีละหลายแถวในคำสั่งเดียว) — ถ้ามีการแก้ระหว่างที่คำสั่งสร้างยังไม่ถึง server ให้ตามไปเป็น update (ไม่หาย) */
function insertItemRows(list) {
  if (!list.length) return;
  const jobId = job.id;
  const fs = list.map(it => { const f = { ver: 0, sentVer: -1, done: false }; inflight.set(it.id, f); return [it, f]; });
  // op ถูกเรียกซ้ำได้จากคิวลองใหม่ — อ่านค่าล่าสุดตอนส่งเสมอ, แม่ก่อนลูก, ข้ามแถวที่ถูกลบไปแล้ว
  const rowsNow = mark => {
    const live = fs.filter(([it]) => items.has(it.id));
    const ids = new Set(live.map(([it]) => it.id)), done = new Set(), rows = [];
    let guard = live.length + 1;
    while (rows.length < live.length && guard--) live.forEach(([it, f]) => {
      if (done.has(it.id) || (it.parentId && ids.has(it.parentId) && !done.has(it.parentId))) return;
      done.add(it.id); if (mark) f.sentVer = f.ver;
      rows.push({ id: it.id, job_id: jobId, parent_id: it.parentId, kind: it.kind, sort_order: it.sort, data: it.data, updated_by: currentUser && currentUser.id });
    });
    return { live, rows };
  };
  const op = async () => {
    const { live, rows } = rowsNow(true);
    if (!live.length) return { error: null };
    const r = await sb.from('qc_items').insert(rows);
    if (!r.error || isDuplicate(r.error)) {
      live.forEach(([it, f]) => {
        f.done = true;
        if (f.ver !== f.sentVer && items.has(it.id)) queueUpdate('qc_items', it.id, { data: it.data, sort_order: it.sort, parent_id: it.parentId });
      });
      setTimeout(runDeferredRefresh, 0);
    }
    return r;
  };
  dbWrite(op, 'qc_items:new:' + list[0].id, () => { const { rows } = rowsNow(false); return rows.length ? { t: 'insert', rows: JSON.parse(JSON.stringify(rows)) } : null; });
}
/* รอจนรายการถูกสร้างบน server แล้ว (ใช้ก่อนผูกรูปกับรายการ) — คืน false ถ้ารอนานเกิน */
async function waitInserted(id, ms = 60000) {
  const t0 = Date.now();
  while (id && inflight.has(id) && !inflight.get(id).done) {
    if (Date.now() - t0 > ms || !items.has(id)) return false;
    await new Promise(r => setTimeout(r, 300));
  }
  return true;
}

const api = {
  version: VERSION,
  // สถานะ
  get job() { return job; },
  get user() { return currentUser; },
  get client() { return sb; },   // ใช้อ่านตารางอื่นของบัญชีเดียวกัน (เช่น qc_signatures ลายเซ็นโปรไฟล์)
  isOnline, hasDriveToken,
  // รายการ
  item: id => items.get(id) || null,
  children,
  all: kind => [...items.values()].filter(i => !kind || i.kind === kind),
  async addItem({ parentId = null, kind, data = {}, after, before, sort } = {}) {
    if (!job && !(await ensureJob())) return null;
    const it = { id: uuid(), parentId: parentId || null, kind: kind || 'item', sort: sort != null ? sort : nextSort(parentId, { after, before }), data: clone(data) };
    items.set(it.id, it);
    if (isOnline()) insertItemRows([it]); else localAutosave();
    return it;
  },
  /* สร้างหลายรายการในคำสั่งเดียว (เช่น โครงหัวข้อของงานใหม่) — ส่ง id เองได้เพื่อผูกแม่-ลูกในชุดเดียวกัน */
  async addItems(specs) {
    if (!job && !(await ensureJob())) return [];
    const made = [];
    for (const sp of specs || []) {
      const it = { id: sp.id || uuid(), parentId: sp.parentId || null, kind: sp.kind || 'item', sort: 0, data: clone(sp.data || {}) };
      it.sort = sp.sort != null ? sp.sort : nextSort(it.parentId, { after: sp.after, before: sp.before });
      items.set(it.id, it);
      made.push(it);
    }
    if (isOnline()) insertItemRows(made); else localAutosave();
    return made;
  },
  /* แก้ข้อมูลของรายการ — patch จะ merge เข้า data เดิม (ส่งทั้งก้อน data ของรายการนั้น) */
  updateItem(id, patch) {
    const it = items.get(id);
    if (!it) return;
    Object.assign(it.data, clone(patch));
    if (!isOnline()) { localAutosave(); return; }
    const f = inflight.get(id);
    if (f && !f.done) { f.ver++; return; }   // ยังสร้างไม่เสร็จ → ค่าจะตามไปกับคำสั่งสร้าง/ตามด้วย update
    queueUpdate('qc_items', id, { data: it.data });
  },
  /* แทนข้อมูลทั้งก้อน (ฟิลด์ที่หายไปก็หายจากระบบด้วย) */
  setItemData(id, data) {
    const it = items.get(id);
    if (!it) return;
    it.data = clone(data || {});
    if (!isOnline()) { localAutosave(); return; }
    const f = inflight.get(id);
    if (f && !f.done) { f.ver++; schedulePersist(); return; }
    queueUpdate('qc_items', id, { data: it.data });
  },
  moveItem(id, { parentId, after, before, sort } = {}) {
    const it = items.get(id);
    if (!it) return;
    if (parentId !== undefined) it.parentId = parentId || null;
    it.sort = sort != null ? sort : nextSort(it.parentId, { after, before });
    if (!isOnline()) { localAutosave(); return; }
    const f = inflight.get(id);
    if (f && !f.done) { f.ver++; schedulePersist(); return; }
    queueUpdate('qc_items', id, { parent_id: it.parentId, sort_order: it.sort });
  },
  async removeItem(id) {
    const gone = new Set([id]);
    let grew = true;
    while (grew) { grew = false; items.forEach(i => { if (i.parentId && gone.has(i.parentId) && !gone.has(i.id)) { gone.add(i.id); grew = true; } }); }
    const files = [];
    photos.forEach((p, k) => { if (p.itemId && gone.has(p.itemId)) { if (p.driveId) files.push([p.driveId, p.uploadedBy]); if (p.origDriveId) files.push([p.origDriveId, p.uploadedBy]); photos.delete(k); } });
    gone.forEach(i => { items.delete(i); inflight.delete(i); pendingPatches.delete('qc_items:' + i); });
    // คำสั่งสร้าง/แก้ของแถวที่ถูกลบที่ยังค้างในคิวลองใหม่ → ทิ้ง (ไม่งั้นแถวฟื้นหลังลบ)
    retryQueue = retryQueue.filter(r => { const drop = [...gone].some(i => r.key === 'qc_items:new:' + i || r.key === 'qc_items:' + i); if (drop) outboxDone(r.oid); return !drop; });
    schedulePersist();
    if (!isOnline()) { localAutosave(); updateDriveBanner(); return; }
    await dbWrite(() => sb.from('qc_items').delete().eq('id', id), 'qc_items:del:' + id, () => ({ t: 'delete', table: 'qc_items', id }));
    for (const [fid, owner] of files) await driveDelete(fid, owner, false);
    updateDriveBanner();
  },
  // งาน
  async updateJob(patch) {
    if (!job && !(await ensureJob())) return;
    const db = {};
    if ('name' in patch) { job.name = patch.name || ''; db.name = job.name; }
    if ('customer' in patch) { job.customer = patch.customer || ''; db.customer = job.customer; }
    if (patch.meta) { job.meta = Object.assign(job.meta || {}, clone(patch.meta)); db.meta = job.meta; }
    if (!isOnline()) { localAutosave(); return; }
    queueUpdate('qc_jobs', job.id, db);
  },
  // รูป
  photo: (itemId, slot) => photos.get(pkey(itemId, String(slot))) || null,
  photosOf: itemId => [...photos.values()].filter(p => (p.itemId || null) === (itemId || null)),
  /* ใส่/เปลี่ยนรูป: { dataUrl, origDataUrl?, edit? } — origDataUrl = ต้นฉบับก่อนครอป/วาด (ไม่ส่ง = ใช้ต้นฉบับเดิมของช่องนี้) */
  async setPhoto(itemId, slot, { dataUrl, origDataUrl, edit } = {}) {
    if (!job && !(await ensureJob())) return null;
    slot = String(slot);
    const k = pkey(itemId, slot);
    let p = photos.get(k);
    if (!p) { p = { id: null, itemId: itemId || null, slot, driveId: null, origDriveId: null, edit: null, uploadedBy: null, dataUrl: null, origDataUrl: null, pending: false, uploading: false }; photos.set(k, p); }
    if (origDataUrl !== undefined && origDataUrl !== p.origDataUrl) { p.origDataUrl = origDataUrl || null; p.origDriveId = null; }
    p.dataUrl = dataUrl;
    p.edit = edit === undefined ? p.edit : (edit || null);
    if (!isOnline()) { localAutosave(); return p; }
    p.pending = true;
    p.jobId = p.jobId || job.id;
    savePending(p);
    if (p.uploading) { updateDriveBanner(); return p; }   // กำลังอัปรูปเดิมอยู่ → uploadPhoto จะอัปรอบใหม่ให้เองเมื่อเสร็จ
    updateDriveBanner();
    if (uploadsRunning) return p;   // คิวที่ทำงานอยู่จะหยิบไปเอง
    flushPendingUploads();
    return p;
  },
  async removePhoto(itemId, slot) {
    slot = String(slot);
    const k = pkey(itemId, slot), p = photos.get(k);
    if (!p) return;
    photos.delete(k);
    if (!isOnline()) { localAutosave(); return; }
    if (p.pending) { p.pending = false; dropPending(p); }
    updateDriveBanner();
    if (p.id) await dbWrite(() => sb.from('qc_photos').delete().eq('id', p.id), 'qc_photos:del:' + p.id, () => ({ t: 'delete', table: 'qc_photos', id: p.id }));
    else if (job) { const jid = job.id; await dbWrite(() => {
      let q = sb.from('qc_photos').delete().eq('job_id', jid).eq('slot', slot);
      q = itemId ? q.eq('item_id', itemId) : q.is('item_id', null);
      return q;
    }, 'qc_photos:del:' + k, () => ({ t: 'delphoto', jobId: jid, itemId: itemId || null, slot })); }
    if (p.driveId) await driveDelete(p.driveId, p.uploadedBy, false);
    if (p.origDriveId) await driveDelete(p.origDriveId, p.uploadedBy, false);
  },
  loadOriginal,
  ensurePhotosLoaded,
  // สะท้อนต้นไม้ของ object ของแอพ (ดู MIRROR)
  LOADING,
  setSchema(schema) { mirrorSchema = schema; },
  reconcile, pull,
  modelFromRoots: (roots, jobFields, jobPhotos, schema) => modelFromRoots(roots, schema || mirrorSchema, jobFields, jobPhotos),
  stableStr,
  // ขั้นตอน
  ensureJob, useApp,
  refresh: () => scheduleRemoteRefresh(),   // ดึงงานล่าสุดจากระบบใหม่
  openList: () => showJobList(true),
  newJob: startNewJob,
  // หน้ารายการงานของแอพเอง (ดู listJobs / useApp noOpen)
  listJobs,
  async open(id) {
    if (job && job.id === id) return true;
    if (!(await canLeave())) return false;
    ensureDriveTokenFromGesture();
    if (isOnline()) await openJob(id); else { await flushPendingWrites(); await openLocalJob(id); }
    return true;
  },
  /* ออกจากงานที่เปิดอยู่ (หน้าว่าง) — งานใหม่จะถูกสร้างเองเมื่อเริ่มกรอก (ไม่สร้างงานเปล่าทิ้งไว้) */
  async leave() {
    if (!(await canLeave())) return false;
    await flushPendingWrites();
    if (job) leaveJob();
    return true;
  },
  async deleteJob(id, label) {
    const ok = await confirmDialog({
      title: isOnline() ? 'ลบงานออกจากระบบทีม' : 'ลบงานออกจากเครื่องนี้',
      message: `ต้องการลบ "<b>${esc(label || 'ไม่ระบุชื่องาน')}</b>" ใช่ไหม?<br><span style="color:#94a3b8;font-size:12px;">${isOnline() ? 'ทุกคนในทีมจะไม่เห็นงานนี้อีก · รูปใน Google Drive จะถูกย้ายไปถังขยะ (กู้คืนได้ 30 วัน)' : 'การลบนี้ย้อนกลับไม่ได้'}</span>`,
      confirmText: 'ลบ', cancelText: 'ยกเลิก', danger: true
    });
    if (!ok) return false;
    try {
      if (isOnline()) await deleteTeamJob(id);
      else await setLocalJobs((await getLocalJobs()).filter(x => x.id !== id));
      if (job && job.id === id) leaveJob();
      toast('ลบงานแล้ว');
      return true;
    } catch (e) { console.error(e); toast('ลบไม่สำเร็จ'); return false; }
  },
  flush: flushPendingWrites,
  /* พักการวาดหน้าใหม่จาก realtime (เช่น ระหว่างสร้าง PDF / ลากจัดเรียง) — เรียก resume() เมื่อเสร็จ */
  suspend() { suspendDepth++; },
  resume() { suspendDepth = Math.max(0, suspendDepth - 1); runDeferredRefresh(); },
  // ไฟล์ JSON
  exportModel: () => snapshotModel(),
  async importModel(model, name) {
    const m = normalizeModel(model);
    if (name) m.job.name = name;
    if (isOnline()) { if (!currentUser) return null; return pushModelToTeam(m); }
    await flushPendingWrites();
    m.job.id = uuid();
    const list = await getLocalJobs();
    list.push({ id: m.job.id, name: m.job.name, customer: m.job.customer, updatedAt: Date.now(), model: m });
    await setLocalJobs(list);
    await openLocalJob(m.job.id);
    return m.job.id;
  },
  // UI ชุดเดียวกับ MoM
  confirmDialog, toast, connectDrive, ensureDriveTokenFromGesture, uuid,
  get syncStatus() { return syncStatus; }
};

/* ========================================================================
   INIT
   ======================================================================== */
function init(options) {
  if (cfg) return api;
  cfg = options;
  injectStyles();
  // หน้าเดียวกันมี avatar-cloud.js อยู่แล้ว (index) → ใช้ client ตัวเดียวกัน กันต่ออายุ token ซ้อนกัน
  sb = cfg.client || global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { flowType: 'pkce' } });
  photoCache = localforage.createInstance({ name: 'avatar_team_photo_cache' });
  pendingStore = localforage.createInstance({ name: 'avatar_team_pending_photos' });
  outboxStore = localforage.createInstance({ name: 'avatar_team_outbox' });
  beat(); setInterval(beat, 5000);
  window.addEventListener('pagehide', () => lsSet(TAB_BEAT + TAB, null));   // ปิดแท็บปกติ → คิวที่เหลือส่งต่อได้ทันทีเมื่อเปิดใหม่
  restoreDriveToken();
  renderChip();
  setSync('saved');

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onAppResume(); });
  window.addEventListener('online', () => { if (waitingNet) { retryStart(); return; } flushRetryQueue(); onAppResume(); });
  window.addEventListener('focus', onAppResume);
  document.addEventListener('focusout', () => setTimeout(runDeferredRefresh, 300));
  setInterval(() => { if (refreshDeferred) runDeferredRefresh(); }, 1500);   // กันพลาด: บางเครื่องไม่ยิง focusout
  setInterval(() => { if (waitingNet) { retryStart(); return; } flushRetryQueue(); if (allPending().some(p => p.pending && !p.uploading)) flushPendingUploads(); }, 15000);   // รูปที่อัปล้ม → ลองใหม่เอง
  // ปิด/ซ่อนแอพ → ส่งค่าที่ค้างในคิวทันที
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { flushPendingWrites(); persistOutbox(); } });
  window.addEventListener('pagehide', () => { flushPendingWrites(); persistOutbox(); });
  // ยังมีรูปรออัปโหลด → เบราว์เซอร์ถามก่อนปิด/รีโหลด (ปิดไปก็ไม่หาย: รูปเก็บใน avatar_team_pending_photos เปิดแอพใหม่จะอัปต่อ)
  window.addEventListener('beforeunload', e => { if (isOnline() && allPending().length) { e.preventDefault(); e.returnValue = ''; } });

  (async () => {
    sb.auth.onAuthStateChange((event, session) => {
      if (session && session.provider_token) setDriveToken(session.provider_token, 3500);
      if (event === 'SIGNED_OUT' && isOnline()) onSignedOut();
    });
    const { data: { session } } = await sb.auth.getSession();
    // autoStart:false = หน้าที่ยังไม่ได้เข้าฟอร์ม (เช่น index) — แค่รู้ว่าใครล็อกอิน รอแอพเรียก useApp()
    if (cfg.autoStart === false) {
      if (isOnline() && session) { currentUser = session.user; if (session.provider_token) setDriveToken(session.provider_token, 3500); processDriveCleanup(); }
      renderChip(); setSync('saved');
      startedResolve();
      return;
    }
    if (!isOnline()) { await enterOfflineMode(); startedResolve(); return; }
    if (session) await onSignedIn(session);
    else if (!navigator.onLine) waitForNet();
    else toLogin();
    startedResolve();
  })().catch(e => { console.error('[team] init', e); toast('เริ่มระบบทีมไม่สำเร็จ'); startedResolve(); });

  return api;
}

global.AvatarTeam = { init, version: VERSION, _debug: () => ({ job, items, photos, pendingPatches, retryQueue, inflight, writesInFlight, refreshDeferred, bgPending, outbox }) };

})(window);
