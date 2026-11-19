/* avatar-gate.js — ล็อกอินจุดเดียวที่หน้า index.html
   ใส่ใน <head> ของทุกแอพ (ยกเว้น index.html / qc-tools.html) เป็น <script> ตัวแรก ๆ (ไม่ใช่ defer)
   - ยังไม่ล็อกอิน (ไม่มี session ของ Supabase ในเครื่อง) และไม่ได้อยู่โหมดออฟไลน์ → ส่งไปหน้า index.html?next=<หน้านี้>
   - หลังล็อกอินที่ index แล้วจะถูกส่งกลับมาหน้านี้เอง
   - AvatarGate.toLogin() ให้แอพเรียกเมื่อพบว่า session หมด/ออกจากระบบ
   - AvatarGate.email() อีเมลบัญชีที่ล็อกอินอยู่ (ใช้เป็น hint ตอนขอสิทธิ์ Drive) */
(function (global) {
  var SESSION_KEY = 'sb-axzikauvpsbzpwxyjjlj-auth-token';   // ที่เก็บ session ของ supabase-js (ทุกแอพใช้โปรเจกต์เดียวกัน)
  var MODE_KEY = 'avatar_mom_mode';

  function session() {
    try {
      var s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (s && s.currentSession) s = s.currentSession;   // รูปแบบเก่าของ supabase-js
      return s && s.refresh_token ? s : null;
    } catch (_) { return null; }
  }
  function storageWorks() {
    try { localStorage.setItem('__avg', '1'); localStorage.removeItem('__avg'); return true; } catch (_) { return false; }
  }
  function offline() { try { return localStorage.getItem(MODE_KEY) === 'offline'; } catch (_) { return false; } }

  function here() {
    var p = location.pathname.split('/').pop() || 'index.html';
    return p + location.search + location.hash;
  }
  function toLogin() {
    location.replace('index.html?next=' + encodeURIComponent(here()));
  }

  global.AvatarGate = {
    toLogin: toLogin,
    signedIn: function () { return !!session(); },
    email: function () { var s = session(); return (s && s.user && s.user.email) || ''; }
  };

  // เบราว์เซอร์ที่ปิด storage (เช่น private mode บางแบบ) ล็อกอินไม่ได้อยู่แล้ว → ไม่ล็อกคนออก
  if (!storageWorks()) return;
  if (!session() && !offline()) {
    document.documentElement.style.visibility = 'hidden';   // ไม่ให้เห็นหน้าแอพแวบก่อนเด้งไปล็อกอิน
    toLogin();
  }
})(window);
