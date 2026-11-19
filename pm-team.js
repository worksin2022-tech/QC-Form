/* ============================================================================
   pm-team.js — PM Report ใช้ระบบทีมแบบ Minute of Meeting (avatar-team.js)
   ใส่ต่อท้าย <body> หลังสคริปต์หลักของ pmform (แทน avatar-cloud.js)

   เก็บอะไรที่ไหน
     qc_items  'section' = หน้าปก / ขอบเขตงาน / หน้าใบสอบเทียบ (html)
               'block'   = ทีละบล็อก (SUB_BLOCK_SELECTOR) — html ที่ถอดรูปออก + กล่องแม่ (home)
     qc_photos  รูปทุกรูปในหน้า (background-image / <img> data:) — แต่ละรูปมี data-pid ของตัวเอง → slot 'p_<pid>'
     qc_jobs    ชื่องาน = ชื่อโครงการบนปก · meta = globals ของ pmform (ตัวนับ/หัวข้อที่เลือก/ชื่อหัวข้อ/ขอบเขต) + ลำดับใน moduleContainer

   ทำงานอย่างไร
     - pmform เดิมเรียก scheduleDraftSave / scheduleTeamAutosave ทุกครั้งที่แก้ (input + MutationObserver)
       → ที่นี่แทนสองตัวนั้นด้วย "หยุดแก้ 3 วิ แล้วเทียบทั้งหน้ากับระบบ ส่งเฉพาะบล็อก/รูปที่เปลี่ยน" (team.reconcile)
     - เปิดงาน / โครงสร้างเปลี่ยน → ประกอบหน้าใหม่แล้วโหลดผ่าน applyDataToDOM เดิม (ได้ retrofit / self-heal ทั้งหมดของ pmform)
       แก้แค่เนื้อหาในบล็อก → แทนเฉพาะบล็อกนั้น (ไม่วาดทั้งหน้าใหม่ — รายงาน 200+ รูป)
     - มีการแก้บนจอที่ยังไม่ส่ง ตอนของจากเครื่องอื่นเข้ามา → ส่งก่อนแล้วค่อยดึง (ไม่ทับของที่เพิ่งแก้)
     - id ในบล็อกมาจากตัวนับ → 2 เครื่องเพิ่มบล็อกชนิดเดียวกันพร้อมกันได้ id ซ้ำ → เปลี่ยนชุด id ของบล็อกที่ tid มากกว่า (ทุกเครื่องกติกาเดียวกัน)
     - ร่าง / ประวัติ 5 ช่อง / avatar-cloud เดิม ไม่ใช้แล้ว → ประวัติในเครื่องขึ้นเป็นงานออฟไลน์ · งานในตาราง documents → "ย้ายเข้าระบบใหม่"
   ============================================================================ */
(function () {
'use strict';

const W = () => document.getElementById('exportWrapper');
const MC = () => document.getElementById('moduleContainer');
const TEMPLATE = W().innerHTML;                                       // หน้าเปล่าตามแม่แบบ (ก่อนมีบล็อกใด ๆ)
const DEFAULT_GLOBALS = JSON.parse(JSON.stringify(buildDraftGlobals()));
const SECTIONS = ['coverPage', 'scopeSection', 'mod_calibration'];
const SCHEMA = { roots: { sections: 'section', blocks: 'block' }, children: {} };
const SYNC_DELAY = 3000;

let team = null;
let applying = false, dirty = false, syncTimer = null, syncing = null;
/* ผู้ใช้กด/พิมพ์ระหว่างที่กำลังเอาของจากระบบลงจอ (ช่วงสั้น ๆ ไม่กี่มิลลิวินาที) → หลังโหลดอย่าตั้งฐานจากจอ (จะกลืนการแก้นั้น) แต่ส่งเลย */
let touchedWhileApplying = false;
['input', 'change', 'click', 'pointerdown', 'keydown', 'drop'].forEach(ev => document.addEventListener(ev, () => { if (applying) touchedWhileApplying = true; }, true));
let pulledJob;                 // งานที่หน้าจอโหลดมาแล้ว (undefined = ยังไม่เคยโหลด)
let appliedMetaStr = null;     // globals + ลำดับ + โครงหัวข้อ ตอนโหลด/ส่งล่าสุด (เปลี่ยนจากนี้ = เราแก้ / ของระบบเปลี่ยน = ประกอบหน้าใหม่)
/* ฐานเทียบ: หน้าจอตอนโหลด/ส่งล่าสุด ต่อรายการ — ส่งเฉพาะที่ "บนจอนี้" แก้จากฐาน
   (ไม่งั้นบล็อกที่คนอื่นเพิ่งแก้ แต่จอนี้ยังไม่ได้ดึง จะถูกส่งของเก่าไปทับ) */
const baseOf = new Map();      // tid → { html, imgs, home }
let baseOrder = '', baseName = null;
let baseMetaStr = null;        // meta บนจอนี้ตอนโหลด/ส่งล่าสุด (ต่างจากนี้ = จอนี้แก้ → ส่ง) — appliedMetaStr = meta ของระบบที่จอนี้รับมาแล้ว
function sameAsBase(tid, html, imgs, home) {
  const b = baseOf.get(tid);
  if (!b || b.html !== html || (b.home || '') !== (home || '')) return false;
  const ks = Object.keys(imgs), kb = Object.keys(b.imgs);
  return ks.length === kb.length && ks.every(k => b.imgs[k] === imgs[k]);
}
const imgsOf = o => { const r = {}; Object.keys(o).forEach(k => { if (k.indexOf('p_') === 0) r[k] = o[k]; }); return r; };
const orderSig = list => list.map(b => (b._tid || '?') + '@' + (b.home || '')).join('|');

const stable = v => team.stableStr(v);
const photoData = el => dataUrlFromAttr(el, photoAttr(el)) || '';
function putPhoto(el, url) {
  if (el.tagName === 'IMG') el.setAttribute('src', url);
  else el.style.backgroundImage = `url("${url}")`;
}
function clearPhoto(el) {
  if (el.tagName === 'IMG') el.removeAttribute('src');
  else el.style.backgroundImage = '';
}
const later = fn => setTimeout(fn, 0);

/* ---------- หน้าจอ → ก้อนข้อมูล ---------- */
// el ที่ "ยังอยู่บนจอ": ใส่ data-pid ให้รูปที่ยังไม่มี · คืน html ที่ถอดรูปออก + รูป {p_<pid>: dataUrl}
function serializeLive(el, outer) {
  const imgs = {};
  const live = el.querySelectorAll(DRAFT_PHOTO_SEL);
  live.forEach(p => {
    const d = photoData(p);
    if (!d) return;
    if (!p.dataset.pid) p.dataset.pid = team.uuid();
    imgs['p_' + p.dataset.pid] = d;
  });
  const clone = el.cloneNode(true);
  clone.querySelectorAll('[data-pid]').forEach(clearPhoto);
  if (outer) clone.removeAttribute('data-tid');
  clone.querySelectorAll('[data-tid]').forEach(x => x.removeAttribute('data-tid'));
  const html = (outer ? clone.outerHTML : clone.innerHTML).replace(/\bblock-flash-(?:new|goto)\b/g, '');
  return { html, imgs };
}
function collect() {
  syncDOMValues();
  const sectionEls = [], blockEls = [];
  const sections = SECTIONS.map(id => {
    const el = document.getElementById(id);
    if (!el) return null;
    const { html, imgs } = serializeLive(el, false);
    sectionEls.push(el);
    return Object.assign({ _tid: el.dataset.tid, key: id, html }, imgs);
  }).filter(Boolean);
  const blocks = [...W().querySelectorAll(SUB_BLOCK_SELECTOR)].map(el => {
    const { html, imgs } = serializeLive(el, true);
    blockEls.push(el);
    return Object.assign({ _tid: el.dataset.tid, home: (el.parentElement && el.parentElement.id) || 'moduleContainer', html }, imgs);
  });
  // ส่งเฉพาะที่บนจอนี้แก้จากฐาน — ตัวที่ไม่ได้แก้: ไม่ส่งข้อมูล (ย้ายตำแหน่งได้ถ้าจอนี้จัดลำดับใหม่ / ลบบางบล็อก)
  const orderChanged = orderSig(blocks) !== baseOrder;
  const full = { sections: sections.slice(), blocks: blocks.slice() };
  const mark = (o, keepPos) => { if (o._tid && sameAsBase(o._tid, o.html, imgsOf(o), o.home)) { o._keepData = true; o._keepPos = keepPos; } };
  sections.forEach(o => mark(o, true));
  blocks.forEach(o => mark(o, !orderChanged));
  // จอนี้ไม่ได้แก้ แต่ในระบบไม่มีแล้ว = คนอื่นเพิ่งลบ (จอนี้ยังไม่ได้ดึง) → ห้ามส่งกลับไปสร้างใหม่ (การดึงรอบหน้าจะเอาออกจากจอ)
  const goneRemote = o => o._keepData && !team.item(o._tid);
  for (let i = blocks.length - 1; i >= 0; i--) if (goneRemote(blocks[i])) { blocks.splice(i, 1); }
  for (let i = sections.length - 1; i >= 0; i--) if (goneRemote(sections[i])) { sections.splice(i, 1); }
  // รายการในระบบที่จอนี้ยังไม่เคยเห็น (คนอื่นเพิ่งเพิ่ม ยังไม่ได้ดึง) → คงไว้ ห้ามลบ
  const onScreen = new Set([...sections, ...blocks].map(o => o._tid).filter(Boolean));
  if (team.job) team.all('block').concat(team.all('section')).forEach(it => {
    if (!onScreen.has(it.id) && !baseOf.has(it.id)) (it.kind === 'block' ? blocks : sections).push({ _tid: it.id, _keepData: true, _keepPos: true });
  });
  return { roots: { sections, blocks }, sectionEls, blockEls, full };
}
// โครงของแต่ละหัวข้อ (mod_xxx) โดยไม่รวมบล็อกข้างใน — เก็บสถานะเปิด/ซ่อนหัวข้อ + หัวหัวข้อ
function shellsOf(mc) {
  const out = {};
  [...mc.children].forEach(c => {
    if (!c.id || c.id.indexOf('mod_') !== 0) return;
    const clone = c.cloneNode(true);
    clone.querySelectorAll(SUB_BLOCK_SELECTOR).forEach(b => b.remove());
    clone.removeAttribute('data-tid');
    out[c.id] = clone.outerHTML.replace(/block-flash-(?:new|goto)/g, '');
  });
  return out;
}
function metaNow() {
  return { globals: buildDraftGlobals(), order: [...MC().children].map(c => c.id).filter(Boolean), shells: shellsOf(MC()) };
}
const metaKey = m => stable({ globals: m.globals || DEFAULT_GLOBALS, order: m.order || [], shells: m.shells || {} });
const projectName = () => ((document.getElementById('coverInputProject') || {}).value || '').trim();

/* ---------- ส่งขึ้นระบบ ---------- */
function scheduleSync() {
  if (applying || inPrintMode()) return;
  dirty = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncNow(); }, SYNC_DELAY);
}
function syncNow() {
  clearTimeout(syncTimer);
  if (syncing) { dirty = true; return syncing; }
  if (applying || inPrintMode() || !team) return Promise.resolve(false);
  syncing = (async () => {
    dirty = false;
    // อ่านค่าในฟอร์มลง attribute (syncDOMValues) แก้ DOM เอง → อย่านับเป็นการแก้ของผู้ใช้ (แบบเดียวกับ buildDraftObject เดิม)
    suppressDirty = true;
    let roots, sectionEls, blockEls, full, m;
    try { ({ roots, sectionEls, blockEls, full } = collect()); m = metaNow(); }
    finally { setTimeout(() => { suppressDirty = false; }, 0); }
    const ok = await team.reconcile(roots);
    if (!ok) { dirty = true; return false; }
    full.sections.forEach((o, i) => { if (o._tid) sectionEls[i].dataset.tid = o._tid; });
    full.blocks.forEach((o, i) => { if (o._tid) blockEls[i].dataset.tid = o._tid; });
    // ฐานใหม่ = สิ่งที่เพิ่งส่ง (ตัวที่ไม่ได้แก้คงฐานเดิม)
    [...full.sections, ...full.blocks].forEach(o => { if (o._tid && !o._keepData) baseOf.set(o._tid, { html: o.html, imgs: imgsOf(o), home: o.home }); });
    baseOrder = orderSig(full.blocks);
    const j = team.job;
    if (!j) return false;
    const name = projectName();
    const mk = metaKey(m);
    if (mk !== baseMetaStr || (baseName !== null && name !== baseName) || (baseName === null && name !== (j.name || ''))) {
      await team.updateJob({ name, customer: name, meta: m });
      appliedMetaStr = mk;
    }
    baseMetaStr = mk;
    baseName = name;
    pulledJob = j.id;
    return true;
  })().catch(e => { console.error('[pm-team] sync', e); dirty = true; return false; })
    .finally(() => { syncing = null; if (dirty) scheduleSync(); });
  return syncing;
}

/* ---------- ระบบ → หน้าจอ ---------- */
function fillPhotos(root, obj) {
  root.querySelectorAll('[data-pid]').forEach(p => {
    const d = obj['p_' + p.dataset.pid];
    if (d) putPhoto(p, d); else clearPhoto(p);
  });
}
function buildHtml(roots, order, shells) {
  const box = document.createElement('div');
  box.innerHTML = TEMPLATE;
  const q = id => box.querySelector('#' + CSS.escape(id));
  Object.entries(shells || {}).forEach(([id, html]) => {
    const el = q(id), t = document.createElement('div');
    t.innerHTML = html;
    const nel = t.firstElementChild;
    if (el && nel) el.replaceWith(nel);
    else if (nel) q('moduleContainer').appendChild(nel);
  });
  roots.sections.forEach(s => {
    const el = q(s.key);
    if (!el) return;
    el.innerHTML = s.html;
    el.setAttribute('data-tid', s._tid);
    fillPhotos(el, s);
  });
  const mc = q('moduleContainer');
  roots.blocks.forEach(b => {
    const t = document.createElement('div');
    t.innerHTML = b.html;
    const el = t.firstElementChild;
    if (!el) return;
    el.setAttribute('data-tid', b._tid);
    fillPhotos(el, b);
    ((b.home && q(b.home)) || mc).appendChild(el);
  });
  (order || []).forEach(id => {
    const el = [...mc.children].find(c => c.id === id);
    if (el) mc.appendChild(el);
  });
  return box.innerHTML;
}
function postLoad() {
  try { if (typeof renderSidebarQuickAdd === 'function') renderSidebarQuickAdd(); } catch (e) { console.warn(e); }
  try { if (typeof ensureBaseTitleEditable === 'function') ensureBaseTitleEditable(); } catch (e) { console.warn(e); }
  document.querySelectorAll('select').forEach(s => { try { updateResultColor(s); } catch (_) {} });
  document.querySelectorAll('input[oninput*="adjustCoverFontSize"]').forEach(i => { try { adjustCoverFontSize(i); } catch (_) {} });
  updateCurrentHistoryIndicator();
}
function setBaseFromPull(roots, j) {
  baseOf.clear();
  roots.sections.forEach(o => baseOf.set(o._tid, { html: o.html, imgs: imgsOf(o), home: o.home }));
  roots.blocks.forEach(o => baseOf.set(o._tid, { html: o.html, imgs: imgsOf(o), home: o.home }));
  baseOrder = orderSig(roots.blocks);
  baseName = j ? (j.name || '') : null;
}
function fullBuild() {
  const scroller = document.getElementById('a4ScrollArea');
  const keep = scroller ? scroller.scrollTop : 0;
  applying = true;
  const j = team.job;
  try {
    if (!j) { applyDataToDOM({ globals: DEFAULT_GLOBALS, html: TEMPLATE }); baseOf.clear(); baseOrder = ''; baseName = null; appliedMetaStr = null; baseMetaStr = null; }
    else {
      const { roots } = team.pull();
      setBaseFromPull(roots, j);
      const m = j.meta || {};
      applyDataToDOM({ globals: m.globals || DEFAULT_GLOBALS, html: buildHtml(roots, m.order, m.shells) });
      appliedMetaStr = metaKey(m);
    }
    pulledJob = j ? j.id : null;
    postLoad();
  } catch (e) {
    console.error('[pm-team] โหลดงานไม่สำเร็จ', e);
    showAlert({ title: 'เปิดงานไม่สำเร็จ', message: 'ข้อมูลในระบบยังอยู่ครบ — ลองรีโหลดหน้านี้', variant: 'danger' });
  } finally {
    // applyDataToDOM ปลดล็อก dirty ด้วย setTimeout(0) — ปลดของเราหลังจากนั้น
    later(() => { later(() => { applying = false; dirty = false; afterApply(); }); });
    if (scroller) scroller.scrollTop = keep;
  }
}
// แก้แค่เนื้อหาในบล็อก/หน้าปก (โครงสร้างเท่าเดิม) → แทนเฉพาะส่วนที่เปลี่ยน · โครงสร้างเปลี่ยน → ประกอบหน้าใหม่
function incremental() {
  const j = team.job;
  const { roots } = team.pull();
  const m = j.meta || {};
  if (metaKey(m) !== appliedMetaStr) return fullBuild();
  const liveBlocks = [...W().querySelectorAll(SUB_BLOCK_SELECTOR)];
  const liveOrder = liveBlocks.map(b => b.dataset.tid + '@' + ((b.parentElement && b.parentElement.id) || ''));
  const wantOrder = roots.blocks.map(b => b._tid + '@' + (b.home || ''));
  if (liveOrder.join('|') !== wantOrder.join('|')) return fullBuild();
  setBaseFromPull(roots, j);
  applying = true;
  suppressDirty = true;
  try {
    syncDOMValues();
    roots.sections.forEach(s => {
      const el = document.getElementById(s.key);
      if (!el) return;
      const cur = serializeLive(el, false);
      if (cur.html !== s.html) { el.innerHTML = s.html; fillPhotos(el, s); }
      else patchPhotos(el, cur.imgs, s);
      el.dataset.tid = s._tid;
    });
    roots.blocks.forEach((b, i) => {
      const el = liveBlocks[i];
      const cur = serializeLive(el, true);
      if (cur.html !== b.html) {
        const t = document.createElement('div');
        t.innerHTML = b.html;
        const nel = t.firstElementChild;
        nel.dataset.tid = b._tid;
        fillPhotos(nel, b);
        el.replaceWith(nel);
        nel.querySelectorAll('select').forEach(s => { try { updateResultColor(s); } catch (_) {} });
      } else patchPhotos(el, cur.imgs, b);
    });
  } finally {
    later(() => { suppressDirty = false; applying = false; dirty = false; afterApply(); });
  }
}
function patchPhotos(el, curImgs, want) {
  el.querySelectorAll('[data-pid]').forEach(p => {
    const k = 'p_' + p.dataset.pid, d = want[k];
    if (d && d !== curImgs[k] && !(d === team.LOADING && curImgs[k])) putPhoto(p, d);
    else if (!d && curImgs[k]) clearPhoto(p);
  });
}
function onRender() {
  const j = team.job, jid = j ? j.id : null;
  // งานเดิม + มีการแก้บนจอที่ยังไม่ส่ง → ส่งก่อน แล้วค่อยดึงของล่าสุด
  if (jid && jid === pulledJob && (dirty || syncing)) {
    syncNow().then(() => setTimeout(() => team.refresh(), 300));
    return;
  }
  if (jid && jid === pulledJob && appliedMetaStr) incremental();
  else fullBuild();
}
function onPhoto(p) {
  if (!p.dataUrl || !p.slot || p.slot.indexOf('p_') !== 0) return;
  const el = W().querySelector(`[data-pid="${CSS.escape(p.slot.slice(2))}"]`);
  if (el && photoData(el) !== p.dataUrl) putPhoto(el, p.dataUrl);
  const host = el && (el.closest('[data-tid]'));
  const b = host && baseOf.get(host.dataset.tid);
  if (b && b.imgs[p.slot] === team.LOADING) b.imgs[p.slot] = p.dataUrl;
}

/* ---------- id ซ้ำ (2 เครื่องเพิ่มบล็อก/ช่องรูปชนิดเดียวกันพร้อมกัน) ---------- */
function renameWithin(el, oldStr, newStr) {
  const safe = oldStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${safe}(?=[^a-zA-Z0-9_]|$)`, 'g');
  const t = document.createElement('div');
  t.innerHTML = el.outerHTML.replace(re, newStr);
  const nel = t.firstElementChild;
  if (nel && el.parentNode) el.parentNode.replaceChild(nel, el);
  return nel || el;
}
function dedupeBlocks() {
  const keepers = new Map(), losers = [];
  [...W().querySelectorAll(SUB_BLOCK_SELECTOR)].forEach(b => {
    if (!b.id) return;
    const o = keepers.get(b.id);
    if (!o) { keepers.set(b.id, b); return; }
    // ตัวที่ tid น้อยกว่าเก็บ id เดิม — ทุกเครื่องได้ผลเหมือนกัน
    if ((b.dataset.tid || '') < (o.dataset.tid || '')) { keepers.set(b.id, b); losers.push(o); } else losers.push(b);
  });
  losers.forEach(el => {
    const m = el.id.match(/^block_([a-z_]+_)(\d+)$/);
    if (!m) return;
    let n = parseInt(m[2], 10) + 1;
    while (document.getElementById(`block_${m[1]}${n}`)) n++;
    renameWithin(el, `${m[1]}${m[2]}`, `${m[1]}${n}`);
  });
  return losers.length;
}
/* ฐาน = สิ่งที่อยู่บนจอจริงหลังโหลด (applyDataToDOM ของ pmform ปรับ html ของงานเก่า/retrofit เล็กน้อย)
   — ไม่งั้นจอที่เพิ่งเปิดงานจะนึกว่าทุกบล็อกถูกแก้ แล้วส่งทุกบล็อกกลับไปทับของที่คนอื่นเพิ่งแก้ */
function rebaseFromScreen() {
  if (!team || !team.job) return;
  suppressDirty = true;
  try {
    syncDOMValues();
    const list = [];
    SECTIONS.forEach(id => {
      const el = document.getElementById(id);
      if (!el || !el.dataset.tid) return;
      const { html, imgs } = serializeLive(el, false);
      baseOf.set(el.dataset.tid, { html, imgs, home: undefined });
    });
    W().querySelectorAll(SUB_BLOCK_SELECTOR).forEach(el => {
      const home = (el.parentElement && el.parentElement.id) || 'moduleContainer';
      list.push({ _tid: el.dataset.tid, home });
      if (!el.dataset.tid) return;
      const { html, imgs } = serializeLive(el, true);
      baseOf.set(el.dataset.tid, { html, imgs, home });
    });
    baseOrder = orderSig(list);
    baseMetaStr = metaKey(metaNow());
  } finally { setTimeout(() => { suppressDirty = false; }, 0); }
}
function afterApply() {
  const touched = touchedWhileApplying;
  touchedWhileApplying = false;
  if (!touched) rebaseFromScreen();   // แตะระหว่างโหลด → ฐานคงเป็นของที่ดึงมา แล้วส่งของบนจอ (รวมสิ่งที่ผู้ใช้เพิ่งแก้)
  const renamed = dedupeBlocks();
  const before = W().innerHTML.length;
  try { ensureAllModuleContainers(); } catch (e) { console.warn(e); }   // ชื่อช่องรูปซ้ำ + ซิงก์ตัวนับ (ของเดิม pmform)
  if (touched || renamed || W().innerHTML.length !== before) scheduleSync();
}

/* ---------- งานเก่า → โมเดลระบบใหม่ ---------- */
// html ของงานเดิม (ร่าง / ประวัติ / documents) → แยกเป็นหน้าปก + บล็อก + รูป
//   รูปที่ฝังเป็น data: → อัปขึ้น Drive ตอนส่งขึ้นทีม · data-drive (ระบบเดิม) → ใช้ไฟล์เดิม · data-draft-photo → ดึงจากที่เก็บร่าง
async function modelFromDraft(draft, name) {
  const box = document.createElement('div');
  box.innerHTML = draft.html || '';
  const items = [], photos = [];
  const take = async (el, itemId) => {
    for (const p of [...el.querySelectorAll(DRAFT_PHOTO_SEL + ', [data-drive], [data-draft-photo]')]) {
      let d = photoData(p), driveId = p.getAttribute('data-drive') || null;
      const dk = p.getAttribute('data-draft-photo');
      if (!d && dk) d = await draftPhotoStore.getItem(dk).catch(() => null);
      if (!d && !driveId) continue;
      const pid = team.uuid();
      p.setAttribute('data-pid', pid);
      p.removeAttribute('data-drive'); p.removeAttribute('data-draft-photo');
      clearPhoto(p);
      photos.push(d ? { itemId, slot: 'p_' + pid, dataUrl: d } : { itemId, slot: 'p_' + pid, driveId });
    }
  };
  for (const id of SECTIONS) {
    const el = box.querySelector('#' + CSS.escape(id));
    if (!el) continue;
    const itemId = team.uuid();
    await take(el, itemId);
    items.push({ id: itemId, kind: 'section', sort: items.length, data: { key: id, html: el.innerHTML } });
  }
  const blocks = [...box.querySelectorAll(SUB_BLOCK_SELECTOR)];
  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i], itemId = team.uuid();
    await take(el, itemId);
    items.push({ id: itemId, kind: 'block', sort: i, data: { home: (el.parentElement && el.parentElement.id) || 'moduleContainer', html: el.outerHTML.replace(/\bblock-flash-(?:new|goto)\b/g, '') } });
  }
  const mc = box.querySelector('#moduleContainer');
  const proj = box.querySelector('#coverInputProject');
  const nm = name || (proj && (proj.getAttribute('value') || '').trim()) || '';
  return { job: { name: nm, customer: nm, meta: { globals: draft.globals || DEFAULT_GLOBALS, order: mc ? [...mc.children].map(c => c.id).filter(Boolean) : [], shells: mc ? shellsOf(mc) : {} } }, items, photos };
}
async function legacyLocal() {
  const out = [];
  try {
    for (const m of (await getHistoryIndex())) {
      const h = await getHistoryItem(m.id);
      if (h && h.html) out.push({ legacyId: 'hist:' + h.id, name: h.name, updatedAt: Date.parse(h.savedAt) || Date.now(), model: await modelFromDraft(h, h.name) });
    }
  } catch (e) { console.warn('[pm-team] legacy history', e); }
  try {
    const d = await localforage.getItem('smart_pm_draft');
    if (d && d.html && d.globals) out.push({ legacyId: 'draft', name: 'งานที่ค้างไว้ในเครื่อง', updatedAt: Date.now(), model: await modelFromDraft(d) });
  } catch (e) { console.warn('[pm-team] legacy draft', e); }
  return out;
}

/* ---------- งานใหม่: บล็อกตั้งต้นแบบเดียวกับตอนเปิดแอพครั้งแรก ---------- */
async function seed() {
  while (applying) await new Promise(r => setTimeout(r, 10));   // รอหน้าเปล่าของงานใหม่โหลดเสร็จก่อน
  addCustomScope('');
  addGeneralCheckBlock();
  addInsulationBlock();
  addDielectricBlock();
  addGroundingBlock();
  addGcBlock();
  addContactBlock();
  addTripBlock();
  addPhotoGroup('bf');
  addPhotoGroup('cl');
  addPhotoGroup('af');
  postLoad();
  await new Promise(r => setTimeout(r, 0));
  await syncNow();
}

/* ---------- แทนระบบบันทึกเดิมของ pmform ---------- */
loadDraft = async () => true;                       // ไม่ใส่บล็อกตั้งต้น/ร่างเดิมตอนเปิด — งานมาจากระบบทีม
scheduleDraftSave = () => scheduleSync();
scheduleTeamAutosave = () => scheduleSync();
flushDraftSave = () => syncNow();
saveDraft = () => syncNow();
runTeamAutosave = () => syncNow();
saveToTeam = () => syncNow();
autoSnapshotOnExport = () => syncNow();
saveTeamAfterExport = () => syncNow();
checkTeamDocUpdate = () => {};
updateTeamSaveBadge = () => {};
openHistoryModal = () => team && team.openList();
showStartupModal = () => team && team.openList();
openSaveToHistoryModal = async () => { await syncNow(); showToast('ซิงค์ขึ้นระบบแล้ว'); };
startNewReport = () => team && team.newJob();
clearDraft = async () => {
  const ok = await showConfirm({
    title: 'เริ่มรายงานใหม่?',
    message: 'จะเปิดรายงานเปล่าเป็นงานใหม่\n\n* งานที่ทำอยู่บันทึกแล้ว เปิดกลับได้จากปุ่ม "งาน"',
    confirmText: 'เริ่มงานใหม่', cancelText: 'ยกเลิก'
  });
  if (ok && team) team.newJob();
};
updateCurrentHistoryIndicator = () => {
  const bar = document.getElementById('currentHistoryIndicator');
  const nm = document.getElementById('currentHistoryName');
  const j = team && team.job;
  if (!bar) return;
  bar.style.display = j ? 'flex' : 'none';
  if (nm) nm.textContent = j ? (j.name || 'ไม่ระบุชื่องาน') : '';
};
// นำเข้าไฟล์ JSON = สร้างงานใหม่ (ไม่ทับงานที่เปิดอยู่)
importData = event => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const draft = JSON.parse(e.target.result);
      if (!draft || !draft.html || !draft.globals) throw new Error('ไม่ใช่ไฟล์รายงาน PM');
      await team.importModel(await modelFromDraft(draft));
      showToast('นำเข้าเป็นงานใหม่แล้ว');
    } catch (err) {
      showAlert({ title: 'ไฟล์เสียหาย', message: 'ไฟล์ข้อมูลไม่ถูกต้อง หรือเสียหาย: ' + err.message, variant: 'danger' });
    }
    event.target.value = '';
  };
  reader.readAsText(file);
};
// ส่งออก / พิมพ์ / Word: โหลดรูปจาก Drive ให้ครบก่อน + พัก realtime ระหว่างทำ
const wrapExport = fn => async function (...args) {
  if (team && !(await team.ensurePhotosLoaded(t => { if (t) showSaveStatus('<i class="fa-solid fa-cloud-arrow-down"></i> ' + t, false); }))) return;
  if (team) team.suspend();
  try { return await fn.apply(this, args); } finally { if (team) team.resume(); }
};
exportData = wrapExport(exportData);
generateNativePDF = wrapExport(generateNativePDF);
exportToWord = wrapExport(exportToWord);

/* ---------- เริ่มระบบ (แทน initTeamCloud เดิม ซึ่งถูกเรียกท้าย DOMContentLoaded) ---------- */
initTeamCloud = async () => {
  // แถบบน: ไม่มีปุ่มบันทึก (บันทึกทันทีแบบ MoM) · "ประวัติ" → "งาน" · ป้ายซิงค์อยู่ในแถบชื่องาน
  // ซ่อนด้วย CSS (purgePrintArtifacts ของ pmform ล้าง inline display:none ของ .no-print ทุกครั้งที่โหลดงาน)
  const st = document.createElement('style');
  st.textContent = 'button[onclick="openSaveToHistoryModal()"],#saveStatus{display:none!important;}';
  document.head.appendChild(st);
  const histBtn = document.querySelector('button[onclick="openHistoryModal()"]');
  if (histBtn) { const l = histBtn.querySelector('span'); if (l) l.textContent = 'งาน'; histBtn.title = 'รายการงาน'; }
  const lbl = document.querySelector('#currentHistoryIndicator .shrink-0 + .shrink-0');
  if (lbl && /กำลังแก้รายงาน/.test(lbl.textContent)) lbl.textContent = 'กำลังแก้งาน:';

  team = AvatarTeam.init({
    app: 'pmform', appTitle: 'Smart PM Report',
    indicator: 'teamSaveBadge', chip: 'acChipHost',
    render: onRender,
    onPhoto,
    seed,
    photoName: p => {
      const el = W().querySelector(`[data-pid="${CSS.escape((p.slot || '').slice(2))}"]`);
      const blk = el && el.closest(SUB_BLOCK_SELECTOR);
      const title = blk && blk.querySelector('.block-base-title');
      return [projectName(), title ? title.textContent.trim() : (el && el.closest('#coverPage') ? 'Cover' : ''), 'รูป'].filter(Boolean).join('_');
    },
    jobLabel: () => '',
    legacyLocal,
    legacyDocs: { app: 'pmform', toModel: doc => modelFromDraft(doc.state || {}, doc.name) }
  });
  team.setSchema(SCHEMA);
  window.pmTeam = { team: () => team, syncNow, collect, state: () => ({ applying, dirty, syncing: !!syncing, pulledJob }) };
};

})();
