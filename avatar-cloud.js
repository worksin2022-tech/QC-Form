/* ============================================================================
   avatar-cloud.js — ชั้นกลางสำหรับ "ใช้งานออนไลน์แบบทีม" ของ Avatar QC Forms
   ใช้ร่วมกันได้ทุกแอพในชุด (PM Report, Thermoscan, Photograph Inspection, ...)

   ทำอะไรให้บ้าง
     - ล็อกอิน Google ผ่าน Supabase (session แชร์กันทุกแอพเพราะอยู่โดเมนเดียวกัน)
     - โหมดออฟไลน์ (ไม่ต้องล็อกอิน เก็บงานในเครื่อง)
     - เก็บเอกสารลงตาราง documents (1 แถว = 1 งาน, state เป็น jsonb)
     - รูปภาพเก็บบน Google Drive ไม่เก็บใน database (กัน 500MB เต็ม)
     - รายการงานของทีม + สร้าง/เปิด/ลบ
     - กันเขียนทับ: เช็ค updated_at ก่อนบันทึก ถ้ามีคนบันทึกหลังเราโหลดมาจะเตือนก่อน

   วิธีใช้ (ในไฟล์แอพ)
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="https://cdn.jsdelivr.net/npm/localforage@1.10.0/dist/localforage.min.js"></script>
     <script src="https://accounts.google.com/gsi/client" async defer></script>
     <script src="avatar-cloud.js"></script>
     AvatarCloud.init({ app:'pmform', appTitle:'Smart PM Report', ... })

   ตัวเลือกที่ควรรู้
     applyState(state, meta)  meta = { id, updatedAt } เฉพาะตอนเปิดงาน (ไม่มี = เริ่มงานใหม่/ส่งขึ้นทีม)
     applyEmptyState:true     เปิดงานที่ยังไม่เคยบันทึกแล้วเรียก applyState(null, meta) ด้วย (ไม่งั้นข้าม)
     beforeSwitch()           ก่อนเปลี่ยนงาน/เริ่มใหม่/ออกจากระบบ/สลับโหมด — คืน false = ยกเลิก
     chipCompact:true         ชิปบัญชีเหลือแค่รูปโปรไฟล์วงกลม
     save({ auto:true })      บันทึกอัตโนมัติ: ไม่ถาม/ไม่เด้งหน้าต่าง — throw code 'conflict' | 'drive' แทน
     doc.everSaved            งานนี้เคยบันทึกเนื้อหาแล้วหรือยัง · connectDrive() ขอสิทธิ์ Drive (ต้องมาจากการกด)
     checkRemote() / reload() เช็ค/โหลดเวอร์ชันล่าสุดของงานที่เปิดอยู่ · meta.quietPhotos = ห้ามเด้งขอสิทธิ์ Drive
     saveNow()                (ไม่บังคับ) ขั้นตอนบันทึกของแอพเอง ใช้ตอน "ส่งขึ้นทีม" — คืน true ถ้าสำเร็จ

   หมายเหตุ: ต้องรัน MIGRATION 4 ใน minute-of-meeting-supabase-schema.sql ก่อน
   ============================================================================ */
(function (global) {
'use strict';

/* เลขเวอร์ชันของไฟล์นี้ — เพิ่มทุกครั้งที่แอพต้องใช้ความสามารถใหม่/แก้บั๊กในไฟล์นี้
   แอพเช็คเลขนี้ตอนเปิด (เช่น pmform: NEED_AVATAR_CLOUD_API) → ถ้าไฟล์บนเว็บเก่ากว่าจะเตือนให้อัปโหลด
   2 = แก้ "ส่งขึ้นทีม" กดแล้วไม่มีอะไรเกิดขึ้น (id ตัวเลข vs ข้อความ) + saveNow + อัปรูปทีละ 3 */
const API_VERSION = 2;

/* ---- CONFIG (ชุดเดียวกับ minute-of-meeting.html) ---- */
const SUPABASE_URL         = 'https://axzikauvpsbzpwxyjjlj.supabase.co';
const SUPABASE_ANON_KEY    = 'sb_publishable_3_9pZH5Geg767TI9a6AARA_j4_VYUe1';
const GOOGLE_CLIENT_ID     = '817132088438-k3mr42mv2nj6fgnh4cruv30p83980k84.apps.googleusercontent.com';
const DRIVE_ROOT_FOLDER_ID = '1NTny5sIco7pQLEKEjgAuTd5uNhVfTuG4';
const DRIVE_SCOPE          = 'https://www.googleapis.com/auth/drive';

/* ---- keys (ใช้ร่วมกับ minute-of-meeting.html ตั้งใจให้ token/โหมดใช้ต่อกันได้) ---- */
const DRIVE_TOKEN_KEY = 'avatar_mom_drive_token';
const MODE_KEY        = 'avatar_mom_mode';

const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} };

const sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { flowType: 'pkce' } });

/* ---- state ของชั้นนี้ ---- */
let cfg = null;
let currentUser = null;
let appMode = lsGet(MODE_KEY) === 'offline' ? 'offline' : 'online';
let doc = null;          // { id, name, updatedAt, driveFolderId, driveFolderOwner, everSaved } ของงานที่เปิดอยู่
let photoCache = null;
const offlineStores = {};

/* app/appTitle ส่งเป็นฟังก์ชันได้ — สำหรับหน้าที่มีหลายฟอร์มในไฟล์เดียว (เช่น index.html)
   เปลี่ยนฟอร์มแล้วเรียก AvatarCloud.useApp() เพื่อสลับชุดเอกสาร */
const appKey = () => (typeof cfg.app === 'function' ? cfg.app() : cfg.app);
const appTitleText = () => (typeof cfg.appTitle === 'function' ? cfg.appTitle() : (cfg.appTitle || ''));
function offlineStore() {
  const k = appKey();
  if (!offlineStores[k]) offlineStores[k] = localforage.createInstance({ name: 'avatar_cloud_offline_' + k });
  return offlineStores[k];
}

const isOnline = () => appMode === 'online';
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    }));

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const codedError = (code, msg) => Object.assign(new Error(msg), { code });

function toast(msg, ms) { if (cfg && cfg.onToast) cfg.onToast(msg, ms); }
function status(text, ok) { if (cfg && cfg.onStatus) cfg.onStatus(text, ok !== false); }

/* ========================================================================
   DRIVE
   ======================================================================== */
let driveToken = null, gisClient = null, lastSeenToken = null;

function setDriveToken(token, ttlSec) {
  if (!token || token === lastSeenToken) return;
  lastSeenToken = token;
  driveToken = { token, exp: Date.now() + (ttlSec || 3500) * 1000 };
  lsSet(DRIVE_TOKEN_KEY, JSON.stringify(driveToken));
  lsSet(DRIVE_TOKEN_KEY + '_seen', token);
  if (currentUser) processDriveCleanup();
}
function restoreDriveToken() {
  lastSeenToken = lsGet(DRIVE_TOKEN_KEY + '_seen');
  try {
    const t = JSON.parse(lsGet(DRIVE_TOKEN_KEY));
    if (t && t.exp > Date.now()) driveToken = t;
  } catch (_) {}
}
function clearDriveToken() { driveToken = null; lsSet(DRIVE_TOKEN_KEY, null); }
function hasDriveToken() { return !!(driveToken && driveToken.exp > Date.now() + 30000); }

function getDriveToken(interactive) {
  if (hasDriveToken()) return Promise.resolve(driveToken.token);
  if (!interactive || !global.google || !global.google.accounts) return Promise.resolve(null);
  return new Promise(resolve => {
    if (!gisClient) gisClient = global.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope: DRIVE_SCOPE, callback: () => {}
    });
    gisClient.callback = resp => {
      if (resp && resp.access_token) { setDriveToken(resp.access_token, resp.expires_in); resolve(resp.access_token); }
      else resolve(null);
    };
    gisClient.error_callback = () => resolve(null);
    gisClient.requestAccessToken({ prompt: '', hint: currentUser && currentUser.email });
  });
}

async function driveFetch(url, opts = {}) {
  const token = await getDriveToken(false);
  if (!token) { const e = new Error('ยังไม่ได้เชื่อมต่อ Google Drive'); e.status = 401; throw e; }
  const res = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {})
  }));
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
  const res = await driveFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true',
    { method: 'POST', body: form });
  return (await res.json()).id;
}
async function driveDownloadDataUrl(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
async function driveTrash(fileId) {
  try {
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
    });
    return true;
  } catch (e) { return e.status === 404; }
}
async function driveFolderIsEmpty(folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return ((await res.json()).files || []).length === 0;
}

/* ลบไฟล์/โฟลเดอร์: My Drive ลบได้เฉพาะเจ้าของ → ถ้าไม่ใช่ของเราเข้าคิวให้เจ้าของลบทีหลัง */
async function driveDelete(fileId, ownerId, isFolder) {
  if (!fileId || !isOnline()) return;
  const mine = !ownerId || ownerId === (currentUser && currentUser.id);
  let done = false;
  if (mine && hasDriveToken()) {
    try { done = isFolder ? (await driveFolderIsEmpty(fileId) && await driveTrash(fileId)) : await driveTrash(fileId); }
    catch (_) { done = false; }
  }
  if (!done) {
    const { error } = await sb.from('drive_cleanup').insert({ drive_file_id: fileId, owner: ownerId || null, is_folder: !!isFolder });
    if (error) console.warn('[cloud] queue cleanup', error.message);
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
  } catch (e) { console.warn('[cloud] cleanup', e); }
  finally { cleanupRunning = false; }
}

async function ensureDocFolder() {
  if (doc.driveFolderId) return doc.driveFolderId;
  const { data } = await sb.from('documents').select('drive_folder_id, drive_folder_owner').eq('id', doc.id).single();
  if (data && data.drive_folder_id) {
    doc.driveFolderId = data.drive_folder_id;
    doc.driveFolderOwner = data.drive_folder_owner;
    return doc.driveFolderId;
  }
  const folderName = `${(doc.name || '').trim() || appTitleText()} [${doc.id.slice(0, 8)}]`;
  const fid = await driveCreateFolder(folderName, DRIVE_ROOT_FOLDER_ID);
  doc.driveFolderId = fid;
  doc.driveFolderOwner = currentUser.id;
  await sb.from('documents').update({ drive_folder_id: fid, drive_folder_owner: currentUser.id }).eq('id', doc.id);
  return fid;
}

/* ========================================================================
   PHOTOS — ย้ายรูปใน DOM ขึ้น Drive แล้วเก็บแค่ id ไว้ใน HTML
   ======================================================================== */
const PHOTO_SEL = '[style*="background-image"], img';

/* อ่านรูปจาก attribute ตรง ๆ — getAttribute แทบไม่เสียเวลา ส่วน el.style.backgroundImage
   serialize ค่าใหม่ทุกครั้ง (รายงาน 200 รูป ≈ 60ms ต่อรอบ → บันทึกอัตโนมัติแล้วหน่วง) */
const photoAttrOf = el => (el.tagName === 'IMG' ? el.getAttribute('src') : el.getAttribute('style')) || '';

function photoElements(root) {
  return Array.from(root.querySelectorAll(PHOTO_SEL)).filter(el => {
    if (el.tagName === 'IMG') return photoAttrOf(el).startsWith('data:') || el.dataset.drive;
    return photoAttrOf(el).includes('data:') || el.dataset.drive;
  });
}
function readPhotoData(el) {
  const a = photoAttrOf(el);
  if (el.tagName === 'IMG') return a.startsWith('data:') ? a : '';
  const i = a.indexOf('url(');
  if (i < 0) return '';
  let j = i + 4;
  const q = (a[j] === '"' || a[j] === "'") ? a[j++] : '';
  if (!a.startsWith('data:', j)) return '';
  const end = a.indexOf(q || ')', j);
  return end > j ? a.slice(j, end) : '';
}
/* แฮชของรูปต่อ element — จำไว้จนกว่ารูปจะเปลี่ยน (ไม่ต้องแฮชรูปเดิมทุกครั้งที่บันทึกอัตโนมัติ) */
const photoHashCache = new WeakMap();   // el → { attr, hash }
function photoHash(el, data) {
  const attr = photoAttrOf(el);
  const c = photoHashCache.get(el);
  if (c && c.attr === attr) return c.hash;
  const hash = hashString(data);
  photoHashCache.set(el, { attr, hash });
  return hash;
}
function writePhotoData(el, dataUrl) {
  if (el.tagName === 'IMG') el.setAttribute('src', dataUrl);
  else el.style.backgroundImage = `url('${dataUrl}')`;
}
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 7) h = ((h << 5) + h + s.charCodeAt(i)) | 0;   // sample ทุก 7 ตัว เร็วพอและชนยาก
  return (h >>> 0).toString(36) + '-' + s.length.toString(36);
}

/* อัปโหลดรูปที่ยังไม่ได้ขึ้น Drive (หรือถูกแก้หลังอัปโหลด) — ตั้ง data-drive ไว้บน element จริง
   interactive:false = ห้ามเด้งหน้าขอสิทธิ์ Drive (บันทึกอัตโนมัติ) → ไม่มี token ก็ throw code 'drive' */
async function uploadPhotos(root, onProgress, interactive = true) {
  if (!isOnline() || !root) return;
  const els = photoElements(root).filter(el => {
    const d = readPhotoData(el);
    if (!d) return false;
    return !(el.dataset.drive && el.dataset.driveHash === photoHash(el, d));
  });
  if (!els.length) return;
  if (!hasDriveToken() && !(await getDriveToken(interactive))) throw codedError('drive', 'ต้องเชื่อมต่อ Google Drive ก่อนบันทึก');
  const folderId = await ensureDocFolder();
  // อัปพร้อมกันทีละ 3 รูป (ส่งงานรูปเยอะขึ้นทีมเร็วขึ้นมาก) — รูปที่ขึ้นแล้วได้ data-drive ทันที
  // ถ้ามีรูปไหนพัง: หยุดรับรูปใหม่ รอรูปที่กำลังอัปเสร็จ แล้วค่อยแจ้ง error (รอบหน้าอัปต่อเฉพาะที่เหลือ)
  let next = 0, done = 0, failed = null;
  const uploadOne = async el => {
    const dataUrl = readPhotoData(el);
    if (!dataUrl) return;
    const blob = await (await fetch(dataUrl)).blob();
    const oldId = el.dataset.drive;
    const id = await driveUpload(blob, `${el.id || 'photo'}_${Date.now()}.jpg`, folderId);
    el.dataset.drive = id;
    el.dataset.driveHash = hashString(dataUrl);
    photoCache.setItem(id, dataUrl);
    if (oldId && oldId !== id) driveDelete(oldId, currentUser.id, false);
  };
  await Promise.all([0, 1, 2].map(async () => {
    while (!failed && next < els.length) {
      const el = els[next++];
      try { await uploadOne(el); } catch (e) { failed = failed || e; return; }
      if (onProgress) onProgress(++done, els.length);
    }
  }));
  if (failed) throw failed;
}

/* state ที่เก็บไว้ (เช่น งานออฟไลน์) มีรูปแบบ data URL ที่ต้องอัปขึ้น Drive ไหม */
function stateHasPhotoData(state) {
  let found = false;
  (function walk(v) {
    if (found || !v) return;
    if (typeof v === 'string') { if (v.includes('data:image')) found = true; return; }
    if (typeof v === 'object') Object.values(v).forEach(walk);
  })(state);
  return found;
}

/* HTML สำหรับเก็บลง database — ถอด dataUrl ออก เหลือแค่ data-drive */
function cleanHtml(root) {
  const clone = root.cloneNode(true);
  clone.querySelectorAll('[data-drive]').forEach(el => {
    if (el.tagName === 'IMG') el.removeAttribute('src');
    else el.style.backgroundImage = '';
  });
  return clone.innerHTML;
}

/* ดึงรูปกลับมาแปะหลังโหลดเอกสาร (ใช้ cache ในเครื่องก่อน ไม่มีค่อยโหลดจาก Drive)
   interactive:false = ไม่มีสิทธิ์ Drive ก็ข้ามไป (ตอนเปิดแอพ/กลับมาที่แอพ ไม่มีการกด → เบราว์เซอร์บล็อกหน้าต่าง Google อยู่ดี) */
async function restorePhotos(root, onProgress, interactive = true) {
  if (!root) return;
  const els = Array.from(root.querySelectorAll('[data-drive]')).filter(el => !readPhotoData(el));
  if (!els.length) return;
  let n = 0;
  const pending = [];
  for (const el of els) {
    const cached = await photoCache.getItem(el.dataset.drive).catch(() => null);
    if (cached) { writePhotoData(el, cached); el.dataset.driveHash = hashString(cached); if (onProgress) onProgress(++n, els.length); }
    else pending.push(el);
  }
  if (!pending.length) return;
  if (!hasDriveToken() && !(await getDriveToken(interactive))) { toast('ยังโหลดรูปไม่ได้ — ต้องเชื่อมต่อ Google Drive'); return; }
  let i = 0;
  await Promise.all([0, 1, 2].map(async () => {
    while (i < pending.length) {
      const el = pending[i++];
      try {
        const dataUrl = await driveDownloadDataUrl(el.dataset.drive);
        writePhotoData(el, dataUrl);
        el.dataset.driveHash = hashString(dataUrl);
        photoCache.setItem(el.dataset.drive, dataUrl);
      } catch (e) { console.warn('[cloud] photo', el.dataset.drive, e.message); }
      if (onProgress) onProgress(++n, els.length);
    }
  }));
}

/* ---- แบบที่ 2: รูปที่แอพเก็บเป็น array ของ dataUrl (เช่น index.html) ----
   เก็บลง state เป็น [{drive:'<id>'}] แทน dataUrl เพื่อไม่ให้ database บวม */
async function uploadDataUrls(arr) {
  if (!Array.isArray(arr) || !arr.length) return [];
  if (!isOnline()) return arr.slice();
  const need = arr.some(x => typeof x === 'string' && x.startsWith('data:'));
  if (need && !hasDriveToken() && !(await getDriveToken(true))) throw new Error('ต้องเชื่อมต่อ Google Drive ก่อนบันทึก');
  const folderId = need ? await ensureDocFolder() : null;
  const out = [];
  for (const item of arr) {
    if (item && typeof item === 'object' && item.drive) { out.push({ drive: item.drive }); continue; }
    if (typeof item !== 'string' || !item.startsWith('data:')) { out.push(item); continue; }
    const blob = await (await fetch(item)).blob();
    const id = await driveUpload(blob, `img_${Date.now()}_${out.length}.jpg`, folderId);
    photoCache.setItem(id, item);
    out.push({ drive: id });
  }
  return out;
}

async function restoreDataUrls(arr) {
  if (!Array.isArray(arr) || !arr.length) return [];
  const out = [];
  for (const item of arr) {
    if (typeof item === 'string') { out.push(item); continue; }
    if (!item || !item.drive) continue;
    let d = await photoCache.getItem(item.drive).catch(() => null);
    if (!d) {
      if (!hasDriveToken() && !(await getDriveToken(true))) { toast('ยังโหลดรูปไม่ได้ — ต้องเชื่อมต่อ Google Drive'); continue; }
      try { d = await driveDownloadDataUrl(item.drive); photoCache.setItem(item.drive, d); }
      catch (e) { console.warn('[cloud] photo', item.drive, e.message); continue; }
    }
    out.push(d);
  }
  return out;
}

/* รวบรวม drive id ทั้งหมดจาก state ที่เก็บไว้ (ใช้ตอนลบเอกสาร)
   ครอบคลุมทั้ง html ที่มี data-drive และ array ของ {drive:id} ที่ซ้อนอยู่ใน state */
function driveIdsInState(state) {
  const ids = [];
  const html = (state && state.html) || '';
  if (html) {
    const dom = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    dom.querySelectorAll('[data-drive]').forEach(el => ids.push(el.dataset.drive));
  }
  (function walk(v) {
    if (!v || typeof v !== 'object') return;
    if (typeof v.drive === 'string') { ids.push(v.drive); return; }
    Object.values(v).forEach(walk);
  })(state);
  return ids;
}

/* ========================================================================
   OFFLINE STORE — งานเก็บในเครื่องนี้ (ไม่ต้องล็อกอิน)
   ======================================================================== */
/* แอพที่มีระบบออฟไลน์ของตัวเองอยู่แล้ว (เช่น pmform ที่มี draft + ประวัติในเครื่อง)
   ให้ตั้ง offlineManagedByApp:true แล้วส่ง localList() มาเอง — ชั้นนี้จะไม่เก็บซ้ำ */
const appManagesOffline = () => !!(cfg && cfg.offlineManagedByApp);

async function localList() {
  if (cfg && cfg.localList) { try { return (await cfg.localList()) || []; } catch (_) { return []; } }
  try { return (await offlineStore().getItem('list')) || []; } catch (_) { return []; }
}
async function localSaveList(list) {
  if (appManagesOffline()) return;
  try { await offlineStore().setItem('list', list); } catch (e) { console.error(e); }
}

async function localSaveDoc(id, name, state) {
  const list = await localList();
  const entry = { id, name, updatedAt: Date.now(), state };
  const i = list.findIndex(x => x.id === id);
  if (i >= 0) list[i] = entry; else list.push(entry);
  await localSaveList(list);
}

/* ========================================================================
   DOCUMENTS (Supabase)
   ======================================================================== */
async function listDocuments() {
  const { data, error } = await sb.from('documents')
    .select('id, name, customer, updated_at').eq('app', appKey())
    .order('updated_at', { ascending: false }).limit(300);
  if (error) throw error;
  return data || [];
}

async function createDocument(name) {
  const id = uuid();
  const { error } = await sb.from('documents').insert({
    id, app: appKey(), name: name || '', customer: (cfg.docCustomer && cfg.docCustomer()) || '',
    state: {}, created_by: currentUser.id, updated_by: currentUser.id
  });
  if (error) throw error;
  return id;
}

async function openDocument(id, opts = {}) {
  const { data, error } = await sb.from('documents').select('*').eq('id', id).single();
  if (error) throw error;
  const hasState = !!(data.state && Object.keys(data.state).length);
  // everSaved = งานนี้เคยถูกบันทึกเนื้อหาแล้ว (งานที่กด "เริ่มงานใหม่" แต่ยังไม่เคยบันทึก = false)
  doc = { id: data.id, name: data.name, updatedAt: data.updated_at, driveFolderId: data.drive_folder_id, driveFolderOwner: data.drive_folder_owner, everSaved: hasState };
  lsSet(lastDocKey(), id);
  // meta = งานที่กำลังเปิด (แอพใช้เทียบกับของที่แก้ค้างไว้ในเครื่อง) — ไม่มี meta = เริ่มงานใหม่
  const meta = { id: data.id, updatedAt: data.updated_at, quietPhotos: !!opts.quietPhotos };
  if (hasState) {
    await cfg.applyState(data.state, meta);
    await restorePhotos(cfg.root(), (n, total) => status(`กำลังโหลดรูป ${n}/${total}...`, true), !opts.quietPhotos);
  } else if (cfg.applyEmptyState) {
    // งานที่สร้างแล้วแต่ยังไม่เคยบันทึก — แอพต้องล้างหน้าจอเอง ไม่งั้นเนื้อหางานก่อนหน้าจะค้างอยู่
    await cfg.applyState(null, meta);
  }
  status('เปิดงานจากระบบทีมแล้ว');
  return doc;
}

/* บันทึกงานปัจจุบัน — อัปรูปขึ้น Drive ก่อน แล้วเขียน state ลง database
   กันเขียนทับ: ถ้า updated_at บนเซิร์ฟเวอร์ใหม่กว่าตอนที่เราโหลดมา = มีคนอื่นบันทึกไปแล้ว
   opts.auto = บันทึกอัตโนมัติ (ไม่มีผู้ใช้เฝ้า) → ห้ามถาม/เด้งหน้าต่าง
     มีคนบันทึกหลังเราเปิด → throw code 'conflict' (ไม่ทับ) · ยังไม่เชื่อม Drive → throw code 'drive' */
async function saveDocument(opts = {}) {
  if (!isOnline()) {
    const state = await cfg.getState();
    await localSaveDoc(doc.id, doc.name, state);
    doc.everSaved = true;
    status('บันทึกในเครื่องแล้ว');
    return true;
  }
  if (!doc) throw new Error('ยังไม่ได้เปิดงาน');

  if (!opts.force) {
    const { data } = await sb.from('documents').select('updated_at, updated_by').eq('id', doc.id).single();
    if (data && doc.updatedAt && new Date(data.updated_at) > new Date(doc.updatedAt)) {
      if (opts.auto) throw codedError('conflict', 'มีคนบันทึกงานนี้หลังจากคุณเปิด');
      const ok = await confirmOverwrite(data.updated_at);
      if (!ok) return false;
    }
  }

  status('กำลังอัปโหลดรูป...', true);
  await uploadPhotos(cfg.root(), (n, total) => status(`กำลังอัปโหลดรูป ${n}/${total}...`, true), !opts.auto);

  const state = await cfg.getState();
  status('กำลังบันทึกขึ้นระบบทีม...', true);
  const name = (cfg.docName && cfg.docName()) || doc.name || '';
  const { data, error } = await sb.from('documents').update({
    name, customer: (cfg.docCustomer && cfg.docCustomer()) || '',
    state, updated_by: currentUser.id
  }).eq('id', doc.id).select('updated_at').single();
  if (error) { status('บันทึกไม่สำเร็จ', false); throw error; }
  doc.name = name;
  doc.updatedAt = data.updated_at;
  doc.everSaved = true;
  status('บันทึกขึ้นระบบทีมแล้ว');
  return true;
}

async function deleteDocument(id) {
  const { data } = await sb.from('documents').select('state, drive_folder_id, drive_folder_owner').eq('id', id).single();
  const { error } = await sb.from('documents').delete().eq('id', id);
  if (error) throw error;
  if (data) {
    for (const fid of driveIdsInState(data.state)) await driveDelete(fid, null, false);
    if (data.drive_folder_id) await driveDelete(data.drive_folder_id, data.drive_folder_owner, true);
    processDriveCleanup();
  }
  if (doc && doc.id === id) { doc = null; lsSet(lastDocKey(), null); }
}

/* งานที่เปิดอยู่ถูกบันทึกบนระบบหลังจากที่เราโหลด/บันทึกล่าสุดไหม
   คืน null = ไม่มีงานเปิดอยู่ · { deleted } = ถูกลบ · { newer, updatedAt, mine } */
async function checkRemote() {
  if (!isOnline() || !currentUser || !doc) return null;
  const { data, error } = await sb.from('documents').select('updated_at, updated_by').eq('id', doc.id).maybeSingle();
  if (error) throw error;
  if (!data) return { deleted: true };
  // งานที่เราสร้างแต่ยังไม่เคยบันทึก (updatedAt = null) → ใหม่กว่าถ้าคนอื่นเป็นคนบันทึกล่าสุด
  const newer = doc.updatedAt ? new Date(data.updated_at) > new Date(doc.updatedAt) : data.updated_by !== currentUser.id;
  return { newer, updatedAt: data.updated_at, mine: data.updated_by === currentUser.id };
}

const lastDocKey = () => 'avatar_cloud_last_' + (cfg ? appKey() : '');

/* ========================================================================
   UI
   ======================================================================== */
function injectStyles() {
  if (document.getElementById('avatarCloudStyles')) return;
  const s = document.createElement('style');
  s.id = 'avatarCloudStyles';
  s.textContent = `
  .ac-overlay{position:fixed;inset:0;z-index:100050;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f2744,#1f3a5f);font-family:'Sarabun',sans-serif;}
  .ac-card{background:#fff;border-radius:18px;padding:32px 28px 24px;width:min(92vw,380px);text-align:center;box-shadow:0 30px 60px -20px rgba(0,0,0,.6);}
  .ac-logo{width:54px;height:54px;border-radius:14px;margin:0 auto 14px;background:linear-gradient(135deg,#f5a623,#ff8a00);display:flex;align-items:center;justify-content:center;}
  .ac-title{font-weight:800;font-size:20px;color:#0b1220;}
  .ac-sub{font-size:13px;color:#64748b;margin:4px 0 22px;}
  .ac-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;border-radius:10px;border:1px solid #e2e8f0;background:#fff;font-size:15px;font-weight:700;color:#0f2744;cursor:pointer;font-family:inherit;}
  .ac-btn.primary{background:linear-gradient(135deg,#0f2744,#1f3a5f);color:#fff;border-color:transparent;}
  .ac-btn:hover{filter:brightness(1.05);}
  .ac-note{font-size:12px;color:#94a3b8;margin-top:12px;line-height:1.6;}
  .ac-or{display:flex;align-items:center;gap:10px;margin:18px 0 12px;color:#cbd5e1;font-size:11px;}
  .ac-or:before,.ac-or:after{content:'';flex:1;height:1px;background:#e2e8f0;}
  .ac-modal{position:fixed;inset:0;z-index:100040;display:flex;align-items:center;justify-content:center;background:rgba(11,18,32,.6);backdrop-filter:blur(4px);padding:16px;font-family:'Sarabun',sans-serif;}
  .ac-box{background:#fff;border-radius:16px;width:min(94vw,520px);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 50px -12px rgba(0,0,0,.45);}
  .ac-head{background:linear-gradient(135deg,#0f2744,#1f3a5f);color:#fff;padding:14px 18px;font-weight:800;display:flex;align-items:center;justify-content:space-between;}
  .ac-x{cursor:pointer;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:20px;line-height:1;}
  .ac-x:hover{background:rgba(255,255,255,.18);}
  .ac-body{padding:16px 18px;overflow-y:auto;flex:1;}
  .ac-foot{padding:12px 18px;border-top:1px solid #e2e8f0;display:flex;gap:8px;}
  .ac-item{display:flex;align-items:center;gap:10px;border:1px solid #e2e8f0;border-radius:10px;padding:11px 12px;margin-bottom:8px;}
  .ac-item:hover{box-shadow:0 2px 8px -2px rgba(0,0,0,.08);}
  .ac-item .info{flex:1;cursor:pointer;min-width:0;}
  .ac-item .nm{font-weight:700;font-size:14px;color:#0b1220;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .ac-item .dt{font-size:11.5px;color:#64748b;margin-top:2px;}
  .ac-tag{font-size:9px;font-weight:800;color:#92400e;background:#fde68a;padding:2px 6px;border-radius:4px;margin-left:6px;}
  .ac-del{border:none;background:#fef2f2;color:#ef4444;width:34px;height:34px;border-radius:8px;cursor:pointer;flex-shrink:0;}
  .ac-del:hover{background:#fee2e2;}
  .ac-empty{text-align:center;color:#94a3b8;font-size:13px;padding:18px;}
  .ac-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 10px 5px 5px;border:1px solid #e2e8f0;border-radius:9px;background:#fff;cursor:pointer;font-size:12.5px;font-weight:600;color:#0f2744;font-family:'Sarabun',sans-serif;}
  .ac-chip img{width:24px;height:24px;border-radius:50%;background:#e2e8f0;}
  .ac-chip span{max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .ac-chip.compact{width:38px;height:38px;padding:0;gap:0;border-radius:50%;justify-content:center;overflow:hidden;flex-shrink:0;border-width:2px;color:#64748b;}
  .ac-chip.compact:hover{border-color:#a5b4fc;}
  .ac-chip.compact img{width:100%;height:100%;object-fit:cover;}
  .ac-chip.compact span{display:none;}
  .ac-chip.compact b{font-size:15px;font-weight:800;color:#0f2744;}
  `;
  document.head.appendChild(s);
}

const GOOGLE_SVG = '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
const OFFLINE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M1 1l22 22M16.7 11.4A7 7 0 0 0 12 9.5c-1.7 0-3.3.6-4.5 1.7M20 8.5a12 12 0 0 0-3.4-2.3M4 8.5a12 12 0 0 1 3-2.1M8.5 14.5a3.5 3.5 0 0 1 5.1-.3M12 18.5h.01"/></svg>';

function showLogin(show) {
  let el = document.getElementById('acLogin');
  if (!show) { if (el) el.remove(); return; }
  if (el) return;
  el = document.createElement('div');
  el.id = 'acLogin';
  el.className = 'ac-overlay';
  el.innerHTML = `
    <div class="ac-card">
      <div class="ac-logo"><svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M4 19 L12 4 L20 19 Z" fill="white" opacity=".95"/><circle cx="12" cy="14" r="2.5" fill="#1f3a5f"/></svg></div>
      <div class="ac-title">Avatar Electric</div>
      <div class="ac-sub">${esc(appTitleText())} · ระบบทีม</div>
      <button class="ac-btn primary" id="acLoginBtn">${GOOGLE_SVG} เข้าสู่ระบบด้วย Google</button>
      <div class="ac-note">ใช้บัญชี Google ที่ได้รับสิทธิ์จากทีมเท่านั้น<br>ครั้งแรกอาจเจอหน้า “Google hasn't verified this app” → กด Advanced → Go to app</div>
      <div class="ac-or">หรือ</div>
      <button class="ac-btn" id="acOfflineBtn">${OFFLINE_SVG} ใช้งานออฟไลน์ (เก็บในเครื่องนี้)</button>
      <div class="ac-note">ไม่ต้องล็อกอิน · งานและรูปเก็บในเครื่องนี้เท่านั้น</div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#acLoginBtn').onclick = signIn;
  el.querySelector('#acOfflineBtn').onclick = () => enterOffline();
}

function renderChip() {
  if (!cfg.chipContainer) return;
  const host = typeof cfg.chipContainer === 'string' ? document.getElementById(cfg.chipContainer) : cfg.chipContainer;
  if (!host) return;
  let chip = document.getElementById('acChip');
  if (!chip) {
    chip = document.createElement('button');
    chip.id = 'acChip';
    chip.className = 'ac-chip';
    chip.onclick = accountAction;
    host.appendChild(chip);
  }
  // chipCompact = แสดงแค่รูปโปรไฟล์วงกลม (แถบเมนูที่ปุ่มแน่น เช่น pmform) ชื่อย้ายไปอยู่ใน tooltip
  chip.classList.toggle('compact', !!cfg.chipCompact);
  if (!isOnline()) {
    chip.innerHTML = `${OFFLINE_SVG}<span>ออฟไลน์ · เข้าสู่ระบบ</span>`;
    chip.title = 'อยู่ในโหมดออฟไลน์ — แตะเพื่อเข้าสู่ระบบทีม';
    return;
  }
  if (!currentUser) {   // ยังไม่ได้ล็อกอิน (หน้าที่ใช้ silentStart)
    chip.innerHTML = `${GOOGLE_SVG}<span>เข้าสู่ระบบ</span>`;
    chip.title = 'เข้าสู่ระบบเพื่อใช้งานแบบทีม';
    return;
  }
  const meta = currentUser.user_metadata || {};
  const name = meta.full_name || meta.name || currentUser.email || '';
  const pic = meta.avatar_url || meta.picture || '';
  const initial = `<b>${esc((name.trim()[0] || '?').toUpperCase())}</b>`;
  chip.innerHTML = (pic ? `<img src="${esc(pic)}" referrerpolicy="no-referrer" alt="">` : initial) + `<span>${esc(name)}</span>`;
  const img = chip.querySelector('img');
  if (img) img.onerror = () => { img.outerHTML = initial; };   // รูป Google โหลดไม่ได้ → ใช้ตัวอักษรแรกแทน
  chip.title = cfg.chipCompact ? `${name}${currentUser.email && currentUser.email !== name ? ' (' + currentUser.email + ')' : ''}\nแตะเพื่อออกจากระบบ` : 'ออกจากระบบ';
}

function modal(title, bodyHtml, footHtml, opts = {}) {
  const bg = document.createElement('div');
  bg.className = 'ac-modal';
  bg.innerHTML = `<div class="ac-box">
      <div class="ac-head"><span>${esc(title)}</span><span class="ac-x" data-close>×</span></div>
      <div class="ac-body">${bodyHtml}</div>
      ${footHtml ? `<div class="ac-foot">${footHtml}</div>` : ''}
    </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-close]').onclick = close;
  if (!opts.sticky) bg.addEventListener('click', e => { if (e.target === bg) close(); });
  return { bg, close };
}

function confirmDialog({ title, message, confirmText = 'ตกลง', cancelText = 'ยกเลิก', danger }) {
  return new Promise(resolve => {
    const { bg, close } = modal(title,
      `<div style="font-size:13.5px;color:#475569;line-height:1.7;">${message}</div>`,
      `<button class="ac-btn" data-no style="flex:1;">${esc(cancelText)}</button>
       <button class="ac-btn ${danger ? '' : 'primary'}" data-yes style="flex:1;${danger ? 'background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;border-color:transparent;' : ''}">${esc(confirmText)}</button>`,
      { sticky: true });
    bg.querySelector('[data-yes]').onclick = () => { close(); resolve(true); };
    bg.querySelector('[data-no]').onclick = () => { close(); resolve(false); };
    bg.querySelector('[data-close]').onclick = () => { close(); resolve(false); };
  });
}

function confirmOverwrite(remoteTime) {
  return confirmDialog({
    title: 'มีคนบันทึกงานนี้หลังจากคุณเปิด',
    message: `งานนี้ถูกบันทึกล่าสุดเมื่อ <b>${esc(new Date(remoteTime).toLocaleString('th-TH'))}</b> ซึ่งใหม่กว่าตอนที่คุณเปิดมา<br><br>ถ้าบันทึกต่อ ข้อมูลของคนนั้นจะถูกแทนที่ด้วยของคุณทั้งหมด`,
    confirmText: 'บันทึกทับ', cancelText: 'ยกเลิก', danger: true
  });
}

/* รายการงาน */
async function showDocList(opts = {}) {
  const online = isOnline();
  let rows = [], local = await localList();
  if (online) {
    try { rows = await listDocuments(); }
    catch (e) { console.error(e); toast('โหลดรายการงานไม่สำเร็จ'); }
  }
  // updatedAt อาจเป็น timestamp, ISO string หรือข้อความไทยที่แอพเก็บไว้เอง — รองรับทุกแบบ
  const tnum = t => (typeof t === 'number' ? t : (isNaN(Date.parse(t)) ? 0 : Date.parse(t)));
  const fmt = t => {
    const d = new Date(typeof t === 'number' ? t : t);
    return isNaN(d.getTime()) ? String(t || '')
      : d.toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  local.sort((a, b) => tnum(b.updatedAt) - tnum(a.updatedAt));
  const cur = doc && doc.id;
  const teamItem = m => `<div class="ac-item" data-id="${m.id}">
      <div class="info" data-open="${m.id}">
        <div class="nm">${esc(m.name || 'ไม่ระบุชื่องาน')}${m.id === cur ? '<span class="ac-tag">กำลังเปิด</span>' : ''}</div>
        <div class="dt">${esc([m.customer, fmt(m.updated_at)].filter(Boolean).join(' · '))}</div>
      </div>
      <button class="ac-del" data-del="${m.id}" title="ลบ">🗑</button>
    </div>`;
  const localItem = m => `<div class="ac-item" data-lid="${m.id}">
      <div class="info" ${online ? 'style="cursor:default;"' : `data-lopen="${m.id}"`}>
        <div class="nm">${esc(m.name || 'ไม่ระบุชื่องาน')}${(!online && m.id === cur) ? '<span class="ac-tag">กำลังเปิด</span>' : ''}</div>
        <div class="dt">${esc(fmt(m.updatedAt))}</div>
      </div>
      ${online ? `<button class="ac-btn primary" data-push="${m.id}" style="width:auto;padding:6px 10px;font-size:12px;">ส่งขึ้นทีม</button>` : ''}
      ${appManagesOffline() ? '' : `<button class="ac-del" data-ldel="${m.id}" title="ลบออกจากเครื่อง">🗑</button>`}
    </div>`;
  const sec = t => `<div style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:.5px;margin:0 2px 8px;">${esc(t)}</div>`;
  const body = online
    ? sec(`งานทีม (${rows.length})`) + (rows.length ? rows.map(teamItem).join('') : `<div class="ac-empty">ยังไม่มีงานในระบบ</div>`)
      + (local.length ? `<div style="height:1px;background:#e2e8f0;margin:14px 0;"></div>`
          + sec(`${appManagesOffline() ? 'ประวัติในเครื่องนี้' : 'งานออฟไลน์ในเครื่องนี้'} (${local.length}) — กด "ส่งขึ้นทีม" เพื่อย้ายเข้าระบบ`)
          + local.map(localItem).join('') : '')
    : sec(`งานในเครื่องนี้ (${local.length})`) + (local.length ? local.map(localItem).join('') : `<div class="ac-empty">ยังไม่มีงานในเครื่องนี้</div>`);

  const { bg, close } = modal(online ? 'รายการงาน (ทีม)' : 'งานในเครื่องนี้ (ออฟไลน์)', body,
    `<button class="ac-btn" data-switch style="flex:1;">${online ? 'ใช้งานออฟไลน์' : 'เข้าสู่ระบบทีม'}</button>
     <button class="ac-btn primary" data-new style="flex:2;">+ เริ่มงานใหม่</button>`,
    { sticky: !!opts.sticky });

  bg.querySelector('[data-new]').onclick = async () => { close(); await startNew(); };
  bg.querySelector('[data-switch]').onclick = async () => {
    close();
    if (!(await canSwitch())) return;
    online ? await enterOffline() : await switchToOnline();
  };
  bg.querySelectorAll('[data-open]').forEach(el => el.onclick = async () => {
    close();
    if (el.dataset.open === cur) return;
    try {
      if (!(await canSwitch())) return;
      await openDocument(el.dataset.open); toast('เปิดงานแล้ว');
    }
    catch (e) { console.error(e); toast('เปิดงานไม่สำเร็จ'); }
  });
  // id งานในเครื่องอาจเป็นตัวเลข (ประวัติของ pmform ใช้ Date.now()) แต่ data-* เป็นข้อความเสมอ → เทียบเป็นข้อความ
  const sameId = (a, b) => String(a) === String(b);
  bg.querySelectorAll('[data-lopen]').forEach(el => el.onclick = async () => {
    close();
    const m = local.find(x => sameId(x.id, el.dataset.lopen));
    if (!m) return;
    if (!(await canSwitch())) return;
    doc = { id: m.id, name: m.name, updatedAt: m.updatedAt };
    lsSet(lastDocKey(), m.id);
    await cfg.applyState(m.state);
    toast('เปิดงานแล้ว');
  });
  bg.querySelectorAll('[data-del]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    const m = rows.find(x => x.id === el.dataset.del);
    if (!await confirmDialog({
      title: 'ลบงานออกจากระบบทีม',
      message: `ต้องการลบงาน "<b>${esc(m ? m.name : '')}</b>" ใช่ไหม?<br><span style="color:#94a3b8;font-size:12px;">ทุกคนในทีมจะไม่เห็นงานนี้อีก · รูปใน Google Drive จะถูกย้ายไปถังขยะ (กู้คืนได้ 30 วัน)</span>`,
      confirmText: 'ลบ', danger: true
    })) return;
    try { await deleteDocument(el.dataset.del); toast('ลบงานแล้ว'); }
    catch (err) { console.error(err); toast('ลบไม่สำเร็จ'); }
    close(); showDocList(opts);
  });
  bg.querySelectorAll('[data-ldel]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    const m = local.find(x => sameId(x.id, el.dataset.ldel));
    if (!await confirmDialog({
      title: 'ลบงานออกจากเครื่องนี้',
      message: `ต้องการลบงานออฟไลน์ "<b>${esc(m ? m.name : '')}</b>" ใช่ไหม?<br><span style="color:#94a3b8;font-size:12px;">การลบนี้ย้อนกลับไม่ได้</span>`,
      confirmText: 'ลบ', danger: true
    })) return;
    await localSaveList(local.filter(x => !sameId(x.id, el.dataset.ldel)));
    toast('ลบงานแล้ว');
    close(); showDocList(opts);
  });
  bg.querySelectorAll('[data-push]').forEach(el => el.onclick = async () => {
    const m = local.find(x => sameId(x.id, el.dataset.push));
    if (!m) { toast('ไม่พบงานนี้ในเครื่อง'); return; }
    if (!await confirmDialog({
      title: 'ส่งงานขึ้นทีม',
      message: `สร้างงาน "<b>${esc(m.name)}</b>" ในระบบทีมจากสำเนาออฟไลน์ใช่ไหม?<br><span style="color:#94a3b8;font-size:12px;">รูปจะถูกอัปโหลดขึ้น Google Drive · สำเนาในเครื่องยังอยู่</span>`,
      confirmText: 'ส่งขึ้นทีม'
    })) return;
    close();
    // ขอสิทธิ์ Drive ทันทีตอนกด (ยังนับเป็นการกดของผู้ใช้) — ถ้ารอไปขอตอนอัปโหลด เบราว์เซอร์จะบล็อกหน้าต่าง Google
    if (stateHasPhotoData(m.state) && !hasDriveToken() && !(await getDriveToken(true))) {
      toast('ต้องเชื่อมต่อ Google Drive ก่อน (ใช้อัปโหลดรูป) — ลองกด "ส่งขึ้นทีม" อีกครั้ง');
      return;
    }
    try {
      if (!(await canSwitch())) return;
      toast('กำลังส่งงานขึ้นทีม...');
      const id = await createDocument(m.name);
      doc = { id, name: m.name, updatedAt: null, everSaved: false };
      lsSet(lastDocKey(), id);
      await cfg.applyState(m.state);
      // แอพมีขั้นตอนบันทึกของตัวเอง (สถานะ/ร่างในเครื่อง) → ใช้อันนั้น
      const ok = cfg.saveNow ? await cfg.saveNow() : await saveDocument({ force: true });
      toast(ok ? 'ส่งขึ้นทีมแล้ว' : 'ส่งขึ้นทีมยังไม่สำเร็จ — งานเปิดอยู่แล้ว กด "บันทึก" เพื่อลองใหม่');
    } catch (e) { console.error(e); toast('ส่งขึ้นทีมไม่สำเร็จ — ถ้างานเปิดอยู่แล้ว กด "บันทึก" เพื่อลองใหม่'); }
  });
  return { close };
}

/* ========================================================================
   MODE / AUTH
   ======================================================================== */
/* สร้าง "ที่เก็บ" งานใหม่แล้วผูกไว้ โดยไม่แตะข้อมูลบนหน้าจอ
   (ใช้ตอนผู้ใช้กรอกฟอร์มไว้แล้วเพิ่งกดบันทึกครั้งแรก — ห้ามล้างของที่พิมพ์ไว้) */
async function bindNewDoc(name) {
  const docName = name || (cfg.docName && cfg.docName()) || 'งานใหม่';
  if (isOnline()) {
    const id = await createDocument(docName);
    doc = { id, name: docName, updatedAt: null, everSaved: false };
  } else {
    doc = { id: uuid(), name: docName, updatedAt: Date.now() };
  }
  lsSet(lastDocKey(), doc.id);
  return doc;
}

/* ถามแอพก่อนเปลี่ยนงาน/โหมด — beforeSwitch คืน false = ผู้ใช้ยกเลิก (เช่น เลือก "ยกเลิก" ในกล่องงานยังไม่บันทึก) */
async function canSwitch() {
  try { return (await cfg.beforeSwitch?.()) !== false; }
  catch (e) { console.error(e); return false; }
}

async function startNew(name) {
  if (!(await canSwitch())) return false;
  // ห้ามเอาชื่อจาก cfg.docName() ตรงนี้ — ฟอร์มบนจอยังเป็นของงานเก่า งานใหม่จะได้ชื่องานเก่าติดไป
  // ชื่อจริงจะถูกตั้งตอนกดบันทึก (saveDocument อ่าน cfg.docName() จากฟอร์มของงานใหม่)
  await bindNewDoc(name || 'งานใหม่');
  await cfg.applyState(null);
  toast('เริ่มงานใหม่');
  return true;
}

function signIn() {
  return sb.auth.signInWithOAuth({
    provider: 'google',
    options: { scopes: DRIVE_SCOPE, redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } }
  });
}

async function accountAction() {
  if (isOnline() && !currentUser) { showLogin(true); return; }   // ยังไม่ล็อกอิน → เปิดหน้าเข้าสู่ระบบ
  if (!isOnline()) {
    if (await confirmDialog({
      title: 'เข้าสู่ระบบทีม',
      message: 'ตอนนี้อยู่ในโหมดออฟไลน์ (งานเก็บในเครื่องนี้)<br>ต้องการเข้าสู่ระบบเพื่อใช้งานแบบทีมไหม?<br><span style="color:#94a3b8;font-size:12px;">งานออฟไลน์ยังอยู่ในเครื่อง และส่งขึ้นทีมทีหลังได้จากหน้า "รายการงาน"</span>',
      confirmText: 'เข้าสู่ระบบ'
    }) && await canSwitch()) await switchToOnline();
    return;
  }
  if (await confirmDialog({
    title: 'ออกจากระบบ',
    message: `ออกจากระบบบัญชี <b>${esc(currentUser ? currentUser.email : '')}</b> ใช่ไหม?`,
    confirmText: 'ออกจากระบบ'
  }) && await canSwitch()) await sb.auth.signOut();
}

async function enterOffline() {
  appMode = 'offline';
  lsSet(MODE_KEY, 'offline');
  currentUser = null;
  doc = null;
  showLogin(false);
  renderChip();
  // แอพจัดการออฟไลน์เอง → ชั้นนี้ไม่ยุ่งกับข้อมูล ปล่อยให้แอพใช้ระบบเดิมของตัวเอง
  if (!appManagesOffline()) {
    const last = lsGet(lastDocKey());
    const list = await localList();
    const m = last && list.find(x => x.id === last);
    if (m) { doc = { id: m.id, name: m.name, updatedAt: m.updatedAt }; await cfg.applyState(m.state); }
    else doc = { id: uuid(), name: (cfg.docName && cfg.docName()) || '', updatedAt: Date.now() };
  }
  cfg.onReady?.('offline');
}

async function switchToOnline() {
  appMode = 'online';
  lsSet(MODE_KEY, 'online');
  const { data: { session } } = await sb.auth.getSession();
  if (session) await onSignedIn(session);
  else showLogin(true);
}

async function onSignedIn(session) {
  appMode = 'online';
  lsSet(MODE_KEY, 'online');
  currentUser = session.user;
  if (session.provider_token) setDriveToken(session.provider_token, 3500);
  if (location.hash || /[?&]code=/.test(location.search)) history.replaceState(null, '', location.pathname);
  showLogin(false);
  renderChip();
  processDriveCleanup();
  const last = lsGet(lastDocKey());
  if (last) { try { await openDocument(last, { quietPhotos: true }); } catch (_) { doc = null; lsSet(lastDocKey(), null); } }
  if (!doc && !cfg.silentStart) await showDocList();
  cfg.onReady?.('online');
}

function onAppResume() {
  if (!isOnline() || !currentUser) return;
  processDriveCleanup();
}

/* ========================================================================
   PUBLIC API
   ======================================================================== */
const AvatarCloud = {
  async init(options) {
    cfg = options;
    photoCache = localforage.createInstance({ name: 'avatar_cloud_photos' });
    injectStyles();
    restoreDriveToken();

    sb.auth.onAuthStateChange((event, session) => {
      if (session && session.provider_token) setDriveToken(session.provider_token, 3500);
      if (event === 'SIGNED_OUT' && isOnline()) { currentUser = null; doc = null; renderChip(); showLogin(true); }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onAppResume(); });
    window.addEventListener('online', onAppResume);

    const fromOAuth = /[?&]code=/.test(location.search) || location.hash.includes('access_token');
    const { data: { session } } = await sb.auth.getSession();
    if (!isOnline() && !fromOAuth) { await enterOffline(); return; }
    if (session) { await onSignedIn(session); return; }
    // silentStart = หน้าที่ไม่ควรถูกบังคับล็อกอิน (เช่นหน้ารวมแอพ) — ค่อยขอตอนกดบันทึก/ประวัติ
    if (cfg.silentStart) { renderChip(); cfg.onReady?.(isOnline() ? 'online' : 'offline'); return; }
    showLogin(true);
  },

  version: API_VERSION,

  // สถานะ
  isOnline, get user() { return currentUser; }, get doc() { return doc; },
  hasDriveToken,
  checkRemote,                // งานที่เปิดอยู่มีเวอร์ชันใหม่กว่าบนระบบไหม (ใช้ตอนกลับมาที่แอพ)
  reload: () => (doc ? openDocument(doc.id, { quietPhotos: true }) : Promise.resolve(null)),   // โหลดงานที่เปิดอยู่ใหม่จากระบบ
  connectDrive: () => getDriveToken(true),   // ต้องเรียกจากการกดของผู้ใช้ (เด้งหน้าต่าง Google)
  hasDoc: () => !!doc,
  signedIn: () => isOnline() && !!currentUser,   // พร้อมใช้งานระบบทีมจริงหรือยัง

  // การทำงานหลัก
  save: saveDocument,
  openList: showDocList,
  startNew,
  bindNewDoc,                 // ผูกงานใหม่โดยไม่ล้างฟอร์มที่กรอกไว้
  signOutOrLogin: accountAction,

  /* หน้าที่มีหลายฟอร์ม (index.html): เรียกหลังสลับฟอร์ม เพื่อผูกกับชุดเอกสารของฟอร์มนั้น */
  async useApp() {
    doc = null;
    if (!isOnline() || !currentUser) return null;
    const last = lsGet(lastDocKey());
    if (last) { try { await openDocument(last); } catch (_) { doc = null; lsSet(lastDocKey(), null); } }
    return doc;
  },

  // รูป
  uploadPhotos, restorePhotos, cleanHtml, uploadDataUrls, restoreDataUrls,

  // เผื่ออยากเรียกเอง
  confirmDialog, toast
};

global.AvatarCloud = AvatarCloud;

})(window);
