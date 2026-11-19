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

/* เขียนทีละคำสั่งตามลำดับที่สั่ง — กันคำสั่งแซงกัน (ลูกถึงก่อนแม่ / ลบถึงก่อนสร้างแล้วแถวฟื้น) */
let writeChain = Promise.resolve(), writesInFlight = 0;
function dbWrite(op, key) {
  if (!isOnline()) { localAutosave(); return Promise.resolve(true); }
  setSync('saving');
  writesInFlight++;
  const run = writeChain.then(() => dbWriteNow(op, key)).finally(() => {
    writesInFlight--;
    if (!writesInFlight && !retryQueue.length && !pendingPatches.size && isOnline()) setSync('saved');
  });
  writeChain = run.catch(() => {});
  return run;
}
async function dbWriteNow(op, key) {
  try {
    const { error } = await op();
    if (error && !isDuplicate(error)) throw error;
    return true;
  } catch (err) {
    console.error('[db]', key, err);
    const i = retryQueue.findIndex(r => r.key === key);
    if (i >= 0) retryQueue.splice(i, 1);
    retryQueue.push({ key, op });
    setSync('error');
    return false;
  }
}

let retrying = false;
function flushRetryQueue() {
  if (retrying || !retryQueue.length || !navigator.onLine || !currentUser || !isOnline()) return;
  retrying = true;
  const run = writeChain.then(async () => {
    const list = retryQueue.splice(0);
    const failed = [];
    for (const it of list) {   // ล้มอีก → เก็บไว้ตามลำดับเดิม ลองรอบหน้า (ตัวที่พึ่งตัวก่อนหน้าก็จะล้มตามแล้วผ่านรอบถัดไป)
      try { const { error } = await it.op(); if (error && !isDuplicate(error)) throw error; }
      catch (e) { failed.push(it); }
    }
    retryQueue.unshift(...failed);
    setSync(retryQueue.length ? 'error' : 'saved');
    if (!retryQueue.length) { flushPendingUploads(); runDeferredRefresh(); }
  }).finally(() => { retrying = false; });
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
  setSync('saving');
}

async function flushPendingWrites() {
  clearTimeout(patchTimer);
  if (!isOnline()) { await localAutosave(true); return; }
  const list = [...pendingPatches.values()];
  pendingPatches.clear();
  for (const { table, id, patch } of list) {
    patch.updated_by = currentUser && currentUser.id;
    await dbWrite(() => sb.from(table).update(patch).eq('id', id), table + ':' + id);
  }
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

async function openLocalJob(id) {
  const m = (await getLocalJobs()).find(x => x.id === id);
  if (!m) throw new Error('not found');
  inflight.clear();
  loadModel(m.model);
  job.id = m.id;
  lsSet(lastJobKey() + '_offline', id);
  render();
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
  if (job) { flushPendingUploads(); loadJobPhotos(); }
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
async function uploadPhoto(p) {
  if (!isOnline() || !p || !p.dataUrl || p.uploading || !job) return;
  p.pending = true;
  if (!hasDriveToken()) { updateDriveBanner(); return; }   // รอผู้ใช้กด "เชื่อมต่อ Drive"
  p.uploading = true;
  updateDriveBanner();
  // แก้รูป = อัปเป็นไฟล์ใหม่เสมอ ไม่ทับไฟล์เดิม → id เปลี่ยน ทุกเครื่องจึงรู้ว่าต้องโหลดรูปใหม่
  const src = p.dataUrl, origSrc = p.origDataUrl, jobId = job.id;
  try {
    if (!(await waitInserted(p.itemId))) throw new Error('รายการของรูปนี้ยังบันทึกไม่เสร็จ');
    if (!job || job.id !== jobId) { p.uploading = false; return; }
    const folderId = await ensureJobFolder();
    let origId = p.origDriveId;
    if (origSrc && !origId) {
      origId = await driveUpload(await (await fetch(origSrc)).blob(), photoFileName(p, true), folderId);
      photoCache.setItem(origId, origSrc);
    }
    const newId = await driveUpload(await (await fetch(src)).blob(), photoFileName(p, false), folderId);
    const row = { job_id: jobId, item_id: p.itemId, slot: p.slot, drive_file_id: newId, original_drive_file_id: origSrc ? origId : null, edit: p.edit || null, uploaded_by: currentUser.id };
    const { data, error } = await sb.from('qc_photos').upsert(row, { onConflict: 'job_id,item_id,slot' }).select('id').single();
    if (error) { driveDelete(newId, currentUser.id, false); throw error; }
    const oldId = p.driveId, oldOwner = p.uploadedBy, oldOrig = p.origDriveId;
    Object.assign(p, { id: data.id, driveId: newId, origDriveId: origSrc ? origId : null, uploadedBy: currentUser.id, pending: false });
    photoCache.setItem(newId, src);
    if (oldId && oldId !== newId) driveDelete(oldId, oldOwner, false);
    if (oldOrig && oldOrig !== p.origDriveId) driveDelete(oldOrig, oldOwner, false);
    // realtime อาจสลับ object ใน map ระหว่างอัปโหลด → ให้ตัวปัจจุบันได้ค่าใหม่ด้วย
    const cur = photos.get(pkey(p.itemId, p.slot));
    if (cur && cur !== p && cur.dataUrl === src) Object.assign(cur, { id: p.id, driveId: newId, origDriveId: p.origDriveId, uploadedBy: currentUser.id, pending: false });
    notifyPhoto(p);
  } catch (e) {
    console.error('[upload]', e);
    if (e.status !== 401) { lastDriveError = e.message; toast('อัปโหลดรูปไม่สำเร็จ — จะลองใหม่'); }
  }
  p.uploading = false;
  if ((p.dataUrl !== src || p.origDataUrl !== origSrc) && !p.pending) { p.pending = true; return uploadPhoto(p); }   // ถูกแก้ระหว่างอัปโหลด → อัปรอบใหม่
  updateDriveBanner();
}

let uploadsRunning = false;
async function flushPendingUploads() {
  if (uploadsRunning || !hasDriveToken() || !isOnline()) return;
  uploadsRunning = true;
  try {
    for (const p of [...photos.values()]) {
      if (p.pending && !p.uploading) await uploadPhoto(p);
      if (!hasDriveToken()) return;
    }
  } finally { uploadsRunning = false; updateDriveBanner(); }
}

function updateDriveBanner() {
  let pending = 0, needLoad = 0;
  if (isOnline()) photos.forEach(p => { if (p.pending && !p.uploading) pending++; if (p.driveId && !p.dataUrl && !p.pending) needLoad++; });
  let b = document.getElementById('atDriveBanner');
  if (!pending && !needLoad) { if (b) b.style.display = 'none'; lastDriveError = ''; return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'atDriveBanner'; b.className = 'at-banner at-root no-print';
    b.innerHTML = '<span data-t></span><button class="at-btn primary" type="button" data-b></button>';
    b.querySelector('[data-b]').onclick = connectDrive;
    document.body.appendChild(b);
  }
  const parts = [];
  if (pending) parts.push(`รูป ${pending} รูปรออัปโหลด`);
  if (needLoad) parts.push(`รูป ${needLoad} รูปยังไม่ได้โหลด`);
  let text = parts.join(' · ');
  if (!hasDriveToken()) text += ' — ต้องเชื่อมต่อ Google Drive';
  else if (lastDriveError) text += ' — ' + lastDriveError;
  b.querySelector('[data-t]').textContent = text;
  b.querySelector('[data-b]').textContent = hasDriveToken() ? 'ลองอีกครั้ง' : 'เชื่อมต่อ Drive';
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
async function fetchJobTree(id) {
  const { data, error } = await sb.from('qc_jobs').select('*, qc_items(*), qc_photos(*)').eq('id', id).single();
  if (error) throw error;
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
function runDeferredRefresh() {
  if (refreshDeferred && !isTyping() && !pendingPatches.size && !suspendDepth) { refreshDeferred = false; scheduleRemoteRefresh(); }
}

async function remoteRefresh() {
  const id = job && job.id;
  if (!id || !isOnline()) return;
  // กำลังพิมพ์ / มีค่าค้างยังไม่บันทึก / แอพขอพัก (เช่น กำลังสร้าง PDF) → รอก่อน
  if (isTyping() || pendingPatches.size || suspendDepth || inflightUnsent()) { refreshDeferred = true; return; }
  try {
    const row = await fetchJobTree(id);
    if (!job || job.id !== id) return;
    if (isTyping() || pendingPatches.size || suspendDepth) { refreshDeferred = true; return; }
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

async function openJob(id) {
  await flushPendingWrites();
  const row = await fetchJobTree(id);
  inflight.clear();
  applyRemote(rowsToModel(row), true);
  render();
  subscribeJob(id);
  lsSet(lastJobKey(), id);
  updateDriveBanner();
  loadJobPhotos();
}

function leaveJob(keepLast) {
  if (rtChannel) { sb.removeChannel(rtChannel); rtChannel = null; }
  job = null; items = new Map(); photos = new Map();
  inflight.clear();
  render();
  updateDriveBanner();
  if (!keepLast) lsSet(isOnline() ? lastJobKey() : lastJobKey() + '_offline', null);
}

async function createJob(meta) {
  const id = uuid();
  const { error } = await sb.from('qc_jobs').insert({
    id, app: cfg.app,
    name: (meta && meta.name) || '', customer: (meta && meta.customer) || '', meta: (meta && meta.meta) || {},
    created_by: currentUser.id, updated_by: currentUser.id
  });
  if (error) throw error;
  return id;
}

/* ลบงานทีม: เก็บรายการไฟล์ Drive ไว้ก่อน (cascade จะลบแถว qc_photos ทิ้ง) → ลบ DB → ทิ้งไฟล์/โฟลเดอร์ใน Drive */
async function deleteTeamJob(id) {
  const { data: m } = await sb.from('qc_jobs')
    .select('drive_folder_id, drive_folder_owner, qc_photos(drive_file_id, original_drive_file_id, uploaded_by)').eq('id', id).single();
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
function ensureJob() {
  if (job) return Promise.resolve(true);
  if (ensuring) return ensuring;
  ensuring = (async () => {
    try {
      if (isOnline()) { if (!currentUser) return false; await openJob(await createJob({})); }
      else await openLocalJob(await createLocalJob({}));
      await runSeed();
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
async function pushModelToTeam(src) {
  const m = normalizeModel(src);
  const id = await createJob({ name: m.job.name, customer: m.job.customer, meta: m.job.meta });
  const idMap = new Map(m.items.map(i => [i.id, uuid()]));
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
  await openJob(id);
  m.photos.forEach(p => {
    const itemId = p.itemId ? idMap.get(p.itemId) : null;
    if (p.itemId && !itemId) return;
    if (!p.dataUrl) return;
    photos.set(pkey(itemId, p.slot), {
      id: null, itemId, slot: String(p.slot), driveId: null, origDriveId: null, edit: p.edit || null, uploadedBy: null,
      dataUrl: p.dataUrl, origDataUrl: p.origDataUrl || null, pending: true, uploading: false
    });
  });
  render();
  updateDriveBanner();
  flushPendingUploads();
  return id;
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
  const last = lsGet(lastJobKey());
  if (last) { try { await openJob(last); } catch (e) { lsSet(lastJobKey(), null); } }
  await showJobList(true);
}

function onSignedOut() {
  currentUser = null;
  leaveJob();
  renderChip();
  toLogin();
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
      (local.length ? `<div style="height:1px;background:#e2e8f0;margin:14px 0;"></div>` +
        sectionTitle(`งานออฟไลน์ในเครื่องนี้ (${local.length}) — กด "ส่งขึ้นทีม" เพื่อย้ายเข้าระบบ`) +
        `<div class="at-hist-list">${local.map(localItem).join('')}</div>` : '')
    : sectionTitle(`งานในเครื่องนี้ (${local.length})`) +
      `<div class="at-hist-list">${local.length ? local.map(localItem).join('') : empty('ยังไม่มีงานในเครื่องนี้')}</div>`;
  const rescanHtml = cfg.legacyLocal
    ? `<button class="at-btn" data-rescan style="width:100%;justify-content:center;margin-top:12px;font-size:12.5px;color:#64748b;">🔍 ค้นหางานเก่าจากเวอร์ชันก่อนในเครื่องนี้</button>` : '';

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
      const m = it.dataset.mid ? rows.find(r => r.id === it.dataset.mid) : local.find(r => r.id === it.dataset.lid);
      it.style.display = !q || (((m && m.name) || '') + ' ' + ((m && m.customer) || '')).toLowerCase().includes(q) ? '' : 'none';
    });
  });
  bg.querySelector('[data-new]').onclick = async () => { ensureDriveTokenFromGesture(); close(); await startNewJob(); };
  bg.querySelector('[data-switch]').onclick = async () => {
    close();
    if (!(await canLeave())) return;
    if (online) await enterOfflineMode(); else await switchToOnline();
  };
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
    try { await pushModelToTeam(m.model); toast('ส่งขึ้นทีมแล้ว — กำลังอัปโหลดรูป'); }
    catch (e) { console.error(e); toast('ส่งขึ้นทีมไม่สำเร็จ'); showJobList(true); }
  });
}

/* ========================================================================
   API ให้แอพ
   ======================================================================== */
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
  const op = async () => {
    const live = fs.filter(([it]) => items.has(it.id));
    if (!live.length) return { error: null };
    const ids = new Set(live.map(([it]) => it.id)), done = new Set(), rows = [];
    let guard = live.length + 1;
    while (rows.length < live.length && guard--) live.forEach(([it, f]) => {
      if (done.has(it.id) || (it.parentId && ids.has(it.parentId) && !done.has(it.parentId))) return;
      done.add(it.id); f.sentVer = f.ver;
      rows.push({ id: it.id, job_id: jobId, parent_id: it.parentId, kind: it.kind, sort_order: it.sort, data: it.data, updated_by: currentUser.id });
    });
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
  dbWrite(op, 'qc_items:new:' + list[0].id);
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
  moveItem(id, { parentId, after, before, sort } = {}) {
    const it = items.get(id);
    if (!it) return;
    if (parentId !== undefined) it.parentId = parentId || null;
    it.sort = sort != null ? sort : nextSort(it.parentId, { after, before });
    if (!isOnline()) { localAutosave(); return; }
    const f = inflight.get(id);
    if (f && !f.done) { f.ver++; return; }
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
    retryQueue = retryQueue.filter(r => ![...gone].some(i => r.key === 'qc_items:new:' + i || r.key === 'qc_items:' + i));
    if (!isOnline()) { localAutosave(); updateDriveBanner(); return; }
    await dbWrite(() => sb.from('qc_items').delete().eq('id', id), 'qc_items:del:' + id);
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
    uploadPhoto(p);
    updateDriveBanner();
    return p;
  },
  async removePhoto(itemId, slot) {
    slot = String(slot);
    const k = pkey(itemId, slot), p = photos.get(k);
    if (!p) return;
    photos.delete(k);
    if (!isOnline()) { localAutosave(); return; }
    updateDriveBanner();
    if (p.id) await dbWrite(() => sb.from('qc_photos').delete().eq('id', p.id), 'qc_photos:del:' + p.id);
    else if (job) await dbWrite(() => {
      let q = sb.from('qc_photos').delete().eq('job_id', job.id).eq('slot', slot);
      q = itemId ? q.eq('item_id', itemId) : q.is('item_id', null);
      return q;
    }, 'qc_photos:del:' + k);
    if (p.driveId) await driveDelete(p.driveId, p.uploadedBy, false);
    if (p.origDriveId) await driveDelete(p.origDriveId, p.uploadedBy, false);
  },
  loadOriginal,
  ensurePhotosLoaded,
  // ขั้นตอน
  ensureJob,
  openList: () => showJobList(true),
  newJob: startNewJob,
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
  sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { flowType: 'pkce' } });
  photoCache = localforage.createInstance({ name: 'avatar_team_photo_cache' });
  restoreDriveToken();
  renderChip();
  setSync('saved');

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onAppResume(); });
  window.addEventListener('online', () => { flushRetryQueue(); onAppResume(); });
  window.addEventListener('focus', onAppResume);
  document.addEventListener('focusout', () => setTimeout(runDeferredRefresh, 300));
  setInterval(() => { if (refreshDeferred) runDeferredRefresh(); }, 1500);   // กันพลาด: บางเครื่องไม่ยิง focusout
  setInterval(flushRetryQueue, 15000);
  // ปิด/ซ่อนแอพ → ส่งค่าที่ค้างในคิวทันที
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPendingWrites(); });
  window.addEventListener('pagehide', () => { flushPendingWrites(); });

  (async () => {
    sb.auth.onAuthStateChange((event, session) => {
      if (session && session.provider_token) setDriveToken(session.provider_token, 3500);
      if (event === 'SIGNED_OUT' && isOnline()) onSignedOut();
    });
    const { data: { session } } = await sb.auth.getSession();
    if (!isOnline()) { await enterOfflineMode(); return; }
    if (session) await onSignedIn(session);
    else toLogin();
  })().catch(e => { console.error('[team] init', e); toast('เริ่มระบบทีมไม่สำเร็จ'); });

  return api;
}

global.AvatarTeam = { init, version: VERSION, _debug: () => ({ job, items, photos, pendingPatches, retryQueue, inflight, writesInFlight, refreshDeferred }) };

})(window);
