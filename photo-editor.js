/* photo-editor.js — แก้ไขรูป: Crop/ซูม + วาด (ลูกศร/สี่เหลี่ยม/วงกลม) + กล่องข้อความ
   ยกมาจากแอพบันทึกตรวจรับตู้ (QA) ทำเป็นไฟล์กลาง ไม่ผูกกับ Drive / ระบบทีม — แอพเป็นคนเก็บผลเอง
   ใช้:  PhotoEditor.open({ src, edit, onSave(dataUrl, edit) })
     src   = รูปต้นฉบับ (dataURL / URL) — เปิดแก้ซ้ำจากต้นฉบับเสมอ ไม่เสียความคม
     edit  = ค่าที่แก้ครั้งก่อน { crop, anns } (ถ้ามี)
     onSave(dataUrl, edit) = ผลลัพธ์ JPEG 4:3 (1024×768) + ค่าที่แก้ (เก็บไว้เปิดแก้ซ้ำ) */
(function (global) {
  'use strict';
  const FW = 480, FH = 360, OUT_W = 1024, OUT_H = 768, HANDLE = 13;
  const FONT = px => `700 ${px}px Sarabun, sans-serif`;
  let built = false, root, cv, ctx, zoom, txt, img = null, cfg = null, mode = 'crop', tool = 'select', color = '#ef4444';
  let crop = { zoom: 1, ox: 0, oy: 0 }, base = 1, anns = [], sel = -1, drag = null;
  const $ = id => document.getElementById(id);
  const $$ = s => document.querySelectorAll(s);

  const CSS = `
  .pe{position:fixed;inset:0;z-index:300;background:rgba(15,23,42,.6);display:none;align-items:center;justify-content:center;padding:10px;font-family:Sarabun,sans-serif}
  .pe.open{display:flex}
  .pe-box{background:#fff;border-radius:18px;width:min(100%,560px);max-height:96vh;display:flex;flex-direction:column;overflow:auto;box-shadow:0 20px 50px rgba(0,0,0,.4)}
  .pe-head{padding:12px 16px;background:linear-gradient(135deg,#26324a,#121a28);color:#fff;font-weight:700;display:flex;justify-content:space-between;align-items:center}
  .pe-head button{width:34px;height:34px;border:0;border-radius:10px;background:rgba(255,255,255,.12);color:#fff;font-size:20px;cursor:pointer}
  .pe-modes{display:flex;gap:8px;padding:12px 14px 0}
  .pe-mode{flex:1;height:42px;border-radius:12px;border:1px solid #e2e8f0;background:#fff;font:inherit;font-weight:700;font-size:14px;color:#64748b;cursor:pointer}
  .pe-mode.on{background:#1f2937;color:#fff;border-color:#1f2937}
  .pe-stage{background:#0f172a;margin:12px 14px;border-radius:12px;padding:8px;display:flex;justify-content:center}
  #peCanvas{max-width:100%;height:auto;touch-action:none;background:#fff;border-radius:6px;display:block}
  .pe-tools{display:flex;align-items:center;gap:8px;padding:0 14px 12px;flex-wrap:wrap}
  .pe-tools .lab{font-size:13px;font-weight:700;color:#64748b}
  .pe-tools input[type=range]{flex:1;min-width:140px;accent-color:#f97316}
  .pe-tool{width:44px;height:44px;border-radius:12px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#334155;font:inherit;font-weight:800;font-size:17px}
  .pe-tool svg{width:19px;height:19px}
  .pe-tool.on{background:#f97316;border-color:#f97316;color:#fff}
  .pe-sep{width:1px;height:28px;background:#e2e8f0}
  .pe-sw{width:30px;height:30px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px #cbd5e1;cursor:pointer;padding:0}
  .pe-sw.on{box-shadow:0 0 0 2px #1f2937;transform:scale(1.1)}
  #peText{flex:1 1 100%;height:44px;border:1px solid #fb923c;border-radius:12px;padding:0 12px;font:inherit;font-size:16px;outline:0}
  .pe-foot{padding:12px 14px max(12px,env(safe-area-inset-bottom));border-top:1px solid #e2e8f0;display:flex;gap:10px;justify-content:flex-end;background:#f8fafc}
  .pe-foot button{min-width:104px;height:46px;border-radius:12px;font:inherit;font-weight:700;font-size:15px;cursor:pointer}
  .pe-cancel{background:#fff;border:1px solid #e2e8f0;color:#334155}
  .pe-save{background:#f97316;border:0;color:#fff;box-shadow:0 6px 16px rgba(249,115,22,.3)}
  @media print{.pe{display:none!important}}`;

  const HTML = `
  <div class="pe-box">
    <div class="pe-head"><span>แก้ไขรูป</span><button type="button" data-pe-close>×</button></div>
    <div class="pe-modes">
      <button type="button" class="pe-mode on" id="peModeCrop">Crop / ซูม</button>
      <button type="button" class="pe-mode" id="peModeDraw">วาด / ข้อความ</button>
    </div>
    <div class="pe-stage"><canvas id="peCanvas" width="${FW}" height="${FH}"></canvas></div>
    <div class="pe-tools" id="peCropTools">
      <span class="lab">ซูม</span><input type="range" id="peZoom" min="1" max="4" step="0.01" value="1">
    </div>
    <div class="pe-tools" id="peDrawTools" style="display:none">
      <button type="button" class="pe-tool on" data-tool="select" title="เลือก / ย้าย / ย่อขยาย"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 2l7 18 2.5-7L20 11 4 2z"/></svg></button>
      <button type="button" class="pe-tool" data-tool="arrow" title="ลูกศร"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="9 5 19 5 19 15"/></svg></button>
      <button type="button" class="pe-tool" data-tool="rect" title="สี่เหลี่ยม"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="6" width="16" height="12" rx="1"/></svg></button>
      <button type="button" class="pe-tool" data-tool="circle" title="วงกลม"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="8"/></svg></button>
      <button type="button" class="pe-tool" data-tool="text" title="กล่องข้อความ">T</button>
      <span class="pe-sep"></span>
      <button type="button" class="pe-sw on" data-color="#ef4444" style="background:#ef4444"></button>
      <button type="button" class="pe-sw" data-color="#facc15" style="background:#facc15"></button>
      <button type="button" class="pe-sw" data-color="#22c55e" style="background:#22c55e"></button>
      <button type="button" class="pe-sw" data-color="#2563eb" style="background:#2563eb"></button>
      <button type="button" class="pe-sw" data-color="#18181b" style="background:#18181b"></button>
      <span class="pe-sep"></span>
      <button type="button" class="pe-tool" id="peDelete" title="ลบที่เลือก"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
      <input id="peText" placeholder="พิมพ์ข้อความ…" style="display:none" autocomplete="off">
    </div>
    <div class="pe-foot"><button type="button" class="pe-cancel" data-pe-close>ยกเลิก</button><button type="button" class="pe-save" id="peSave">บันทึก</button></div>
  </div>`;

  function build() {
    if (built) return;
    built = true;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.className = 'pe no-print'; root.id = 'pe'; root.innerHTML = HTML;
    document.body.appendChild(root);
    root.addEventListener('click', e => { if (e.target === root || e.target.closest('[data-pe-close]')) close(); });
    cv = $('peCanvas'); ctx = cv.getContext('2d'); zoom = $('peZoom'); txt = $('peText');
    $('peModeCrop').onclick = () => setMode('crop');
    $('peModeDraw').onclick = () => setMode('draw');
    $('peSave').onclick = save;
    $('peDelete').onclick = () => { if (sel >= 0) { anns.splice(sel, 1); sel = -1; select(-1); } };
    zoom.oninput = () => { zoomAround(FW / 2, FH / 2, +zoom.value); draw(); };
    $$('#peDrawTools .pe-tool[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
    $$('#pe .pe-sw').forEach(s => s.onclick = () => { color = s.dataset.color; $$('#pe .pe-sw').forEach(x => x.classList.toggle('on', x === s)); if (sel >= 0) { anns[sel].color = color; draw(); } });
    txt.oninput = () => { if (sel >= 0 && anns[sel].type === 'text') { anns[sel].text = txt.value; draw(); } };
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  function open(o) {
    build();
    cfg = o || {};
    anns = cfg.edit && Array.isArray(cfg.edit.anns) ? JSON.parse(JSON.stringify(cfg.edit.anns)) : [];
    sel = -1; drag = null; tool = 'select';
    img = new Image();
    img.onload = () => {
      base = Math.min(FW / img.naturalWidth, FH / img.naturalHeight);
      if (cfg.edit && cfg.edit.crop) crop = { ...cfg.edit.crop };
      else { crop = { zoom: 1, ox: (FW - img.naturalWidth * base) / 2, oy: (FH - img.naturalHeight * base) / 2 }; }
      zoom.value = crop.zoom; setMode('crop'); root.classList.add('open');
    };
    img.onerror = () => { img = null; if (cfg.onError) cfg.onError(); };
    img.src = cfg.src;
  }
  function close() { if (!root) return; root.classList.remove('open'); cfg = null; img = null; anns = []; sel = -1; drag = null; if (txt) txt.blur(); }
  function setMode(m) {
    mode = m;
    $('peModeCrop').classList.toggle('on', m === 'crop'); $('peModeDraw').classList.toggle('on', m === 'draw');
    $('peCropTools').style.display = m === 'crop' ? 'flex' : 'none';
    $('peDrawTools').style.display = m === 'draw' ? 'flex' : 'none';
    if (m === 'crop') { select(-1); cv.style.cursor = 'grab'; } else setTool(tool);
    draw();
  }
  function setTool(t) { tool = t; $$('#peDrawTools .pe-tool[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); cv.style.cursor = t === 'select' ? 'default' : 'crosshair'; }
  function select(i) {
    // เลิกเลือกกล่องข้อความที่ยังว่าง → ลบทิ้ง
    if (sel >= 0 && sel !== i && anns[sel] && anns[sel].type === 'text' && !anns[sel].text.trim()) { anns.splice(sel, 1); if (i > sel) i--; }
    sel = i;
    const isT = sel >= 0 && anns[sel].type === 'text';
    txt.style.display = isT ? '' : 'none';
    if (isT) txt.value = anns[sel].text;
    draw();
  }
  function zoomAround(cx, cy, nz) { const os = base * crop.zoom, ns = base * nz, ix = (cx - crop.ox) / os, iy = (cy - crop.oy) / os; crop.ox = cx - ix * ns; crop.oy = cy - iy * ns; crop.zoom = nz; }
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) }; };
  const c01 = v => Math.max(0, Math.min(1, v));
  // กล่องข้อความ: มุมบนซ้าย (x1,y1) + ขนาดตัวอักษร fs (สัดส่วนของความสูงรูป)
  function tbox(c, a, W, H) {
    const px = a.fs * H; c.font = FONT(px);
    const w = c.measureText(a.text || 'พิมพ์ข้อความ').width, pad = px * 0.35;
    return { x: a.x1 * W, y: a.y1 * H, w: w + pad * 2, h: px * 1.5, px, pad };
  }
  function shape(c, a, W, H, lw, editing) {
    c.save(); c.strokeStyle = a.color; c.fillStyle = a.color; c.lineWidth = lw; c.lineJoin = 'round'; c.lineCap = 'round';
    if (a.type === 'text') {
      const b = tbox(c, a, W, H);
      c.fillStyle = 'rgba(255,255,255,.92)'; c.fillRect(b.x, b.y, b.w, b.h); c.strokeRect(b.x, b.y, b.w, b.h);
      c.fillStyle = a.text ? a.color : '#a1a1aa'; c.textBaseline = 'middle'; c.font = FONT(b.px);
      if (a.text || editing) c.fillText(a.text || 'พิมพ์ข้อความ', b.x + b.pad, b.y + b.h / 2 + b.px * 0.04);
    } else {
      const x1 = a.x1 * W, y1 = a.y1 * H, x2 = a.x2 * W, y2 = a.y2 * H;
      if (a.type === 'rect') c.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      else if (a.type === 'circle') { c.beginPath(); c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.max(1, Math.abs(x2 - x1) / 2), Math.max(1, Math.abs(y2 - y1) / 2), 0, 0, Math.PI * 2); c.stroke(); }
      else {
        c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
        const ang = Math.atan2(y2 - y1, x2 - x1), len = Math.max(lw * 3.2, 0.03 * W);
        c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - len * Math.cos(ang - 0.42), y2 - len * Math.sin(ang - 0.42)); c.lineTo(x2 - len * Math.cos(ang + 0.42), y2 - len * Math.sin(ang + 0.42)); c.closePath(); c.fill();
      }
    }
    c.restore();
  }
  function paint(c, W, H, lw, editing) {
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    if (img) { const s = base * crop.zoom, k = W / FW; c.drawImage(img, crop.ox * k, crop.oy * k, img.naturalWidth * s * k, img.naturalHeight * s * k); }
    anns.forEach(a => shape(c, a, W, H, lw, editing));
  }
  function draw() {
    paint(ctx, FW, FH, 3, true);
    if (mode === 'draw' && sel >= 0) {
      ctx.save(); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 2;
      handles(anns[sel]).forEach(p => { ctx.beginPath(); ctx.rect(p.x - 6, p.y - 6, 12, 12); ctx.fill(); ctx.stroke(); });
      ctx.restore();
    }
  }
  function handles(a) {
    if (a.type === 'text') { const b = tbox(ctx, a, FW, FH); return [{ x: b.x + b.w, y: b.y + b.h, h: 'fs' }]; }
    const x1 = a.x1 * FW, y1 = a.y1 * FH, x2 = a.x2 * FW, y2 = a.y2 * FH;
    if (a.type === 'arrow') return [{ x: x1, y: y1, h: 'p1' }, { x: x2, y: y2, h: 'p2' }];
    return [{ x: x1, y: y1, h: 'p1' }, { x: x2, y: y1, h: 'x2y1' }, { x: x2, y: y2, h: 'p2' }, { x: x1, y: y2, h: 'x1y2' }];
  }
  function hitBody(a, x, y) {
    if (a.type === 'text') { const b = tbox(ctx, a, FW, FH); return x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4; }
    const x1 = a.x1 * FW, y1 = a.y1 * FH, x2 = a.x2 * FW, y2 = a.y2 * FH;
    if (a.type === 'arrow') { const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy; let t = l2 ? ((x - x1) * dx + (y - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= 9; }
    if (a.type === 'rect') return x >= Math.min(x1, x2) - 6 && x <= Math.max(x1, x2) + 6 && y >= Math.min(y1, y2) - 6 && y <= Math.max(y1, y2) + 6;
    const rx = Math.abs(x2 - x1) / 2 + 5, ry = Math.abs(y2 - y1) / 2 + 5; if (rx < 2 || ry < 2) return false;
    const u = (x - (x1 + x2) / 2) / rx, v = (y - (y1 + y2) / 2) / ry; return u * u + v * v <= 1.2;
  }
  function down(e) {
    if (!img) return;
    e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    const { x, y } = pos(e);
    if (mode === 'crop') { drag = { k: 'pan', sx: x, sy: y, ox: crop.ox, oy: crop.oy }; cv.style.cursor = 'grabbing'; return; }
    if (tool === 'select') {
      if (sel >= 0) { const h = handles(anns[sel]).find(p => Math.hypot(p.x - x, p.y - y) <= HANDLE); if (h) { drag = { k: 'resize', h: h.h }; return; } }
      let hit = -1; for (let i = anns.length - 1; i >= 0; i--) if (hitBody(anns[i], x, y)) { hit = i; break; }
      if (hit >= 0) { select(hit); const a = anns[sel]; drag = { k: 'move', sx: x, sy: y, a: { ...a } }; }
      else select(-1);
      return;
    }
    const nx = x / FW, ny = y / FH;
    if (tool === 'text') {
      anns.push({ type: 'text', x1: c01(nx), y1: c01(ny), fs: 0.08, text: '', color });
      select(anns.length - 1); setTool('select');
      drag = { k: 'move', sx: x, sy: y, a: { ...anns[sel] } };
      txt.focus();
      return;
    }
    anns.push({ type: tool, x1: nx, y1: ny, x2: nx, y2: ny, color }); select(anns.length - 1);
    drag = { k: 'resize', h: 'p2', fresh: true };
  }
  function move(e) {
    if (!drag) return;
    const { x, y } = pos(e);
    if (drag.k === 'pan') { crop.ox = drag.ox + (x - drag.sx); crop.oy = drag.oy + (y - drag.sy); draw(); return; }
    const a = anns[sel]; if (!a) return;
    if (drag.k === 'move') {
      const dx = (x - drag.sx) / FW, dy = (y - drag.sy) / FH;
      a.x1 = drag.a.x1 + dx; a.y1 = drag.a.y1 + dy;
      if (a.type !== 'text') { a.x2 = drag.a.x2 + dx; a.y2 = drag.a.y2 + dy; }
    } else if (drag.h === 'fs') { a.fs = Math.max(0.03, Math.min(0.2, (y / FH - a.y1) / 1.5)); }
    else {
      const nx = c01(x / FW), ny = c01(y / FH), h = drag.h;
      if (h === 'p1') { a.x1 = nx; a.y1 = ny; } else if (h === 'p2') { a.x2 = nx; a.y2 = ny; }
      else if (h === 'x2y1') { a.x2 = nx; a.y1 = ny; } else if (h === 'x1y2') { a.x1 = nx; a.y2 = ny; }
    }
    draw();
  }
  function up() {
    if (!drag) return;
    if (drag.fresh) {
      const a = anns[sel];
      if (a && Math.abs(a.x2 - a.x1) < 0.02 && Math.abs(a.y2 - a.y1) < 0.02) { a.x2 = c01(a.x1 + 0.18); a.y2 = c01(a.y1 + 0.14); }
      setTool('select');
    }
    if (drag.k === 'pan') cv.style.cursor = mode === 'crop' ? 'grab' : 'default';
    drag = null; draw();
  }
  function save() {
    if (!cfg || !img) return;
    anns = anns.filter(a => a.type !== 'text' || a.text.trim());
    const out = document.createElement('canvas'); out.width = OUT_W; out.height = OUT_H;
    paint(out.getContext('2d'), OUT_W, OUT_H, 3 * OUT_W / FW, false);
    const url = out.toDataURL('image/jpeg', 0.82);
    const edit = { crop: { ...crop }, anns: JSON.parse(JSON.stringify(anns)) };
    const cb = cfg.onSave;
    close();
    if (cb) cb(url, edit);
  }

  global.PhotoEditor = { open, close, get isOpen() { return !!(root && root.classList.contains('open')); } };
})(window);
