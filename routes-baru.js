const multer = require('multer');
const path = require('path');

module.exports = function (app, pool, { requireAdmin, statusBuka }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const aman = (fn, pesan) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error(pesan, e); res.status(500).send(pesan); }
  };

  // ---------- Ikon & helper tampilan ----------
  const P = {
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    check: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 12l2 2 4-4"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    chart: '<path d="M3 3v18h18"/><path d="M8 17V9M13 17V5M18 17v-6"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l8 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  };
  const ic = (n, s = 22) =>
    `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[n] || ''}</svg>`;
  const BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  app.locals.ic = ic;
  app.locals.tglID = (t) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(t || ''));
    return m ? `${Number(m[3])} ${BLN[Number(m[2]) - 1]} ${m[1]}` : (t || '-');
  };

  // ---------- Menu samping & tab bawah (disuntikkan ke semua halaman admin) ----------
  const MENU = [
    ['UTAMA', [['Beranda', '/admin', 'home', 'beranda']]],
    ['WILAYAH', [['Desa & Kelompok', '/admin/wilayah', 'pin', 'wilayah']]],
    ['MUDA-MUDI', [
      ['Daftar Mumi', '/admin/generus', 'users', 'mumi'],
      ['Tambah Mumi', '/admin/generus/baru', 'plus', 'tambah'],
    ]],
    ['KEGIATAN', [
      ['Absen', '/admin/absen', 'check', 'absen'],
      ['Kegiatan', '/admin/kegiatan', 'calendar', 'kegiatan'],
      ['Jurnal', '/admin/jurnal', 'book', 'jurnal'],
      ['Rekap', '/admin/rekap', 'chart', 'rekap'],
    ]],
    ['KOMUNIKASI', [
      ['Pengumuman', '/admin/pengumuman', 'megaphone', 'pengumuman'],
      ['Template WA', '/admin/template-wa', 'chat', 'wa'],
      ['Notifikasi', '/admin/notif', 'bell', 'notif'],
    ]],
    ['AKUN', [
      ['Profil Saya', '/admin/profil', 'user', 'profil'],
      ['Ganti Kata Sandi / Admin', '/admin/password', 'lock', 'password'],
    ]],
  ];
  const TABS = [
    ['Beranda', '/admin', 'home', 'beranda'],
    ['Mumi', '/admin/generus', 'users', 'mumi'],
    ['Absen', '/admin/absen', 'check', 'absen'],
    ['Kegiatan', '/admin/kegiatan', 'calendar', 'kegiatan'],
    ['Rekap', '/admin/rekap', 'chart', 'rekap'],
  ];

  function aktifTab(p) {
    if (p === '/admin' || p === '/admin/') return 'beranda';
    if (p.startsWith('/admin/generus/baru')) return 'tambah';
    if (p.startsWith('/admin/generus')) return 'mumi';
    if (p.startsWith('/admin/absen')) return 'absen';
    if (p.startsWith('/admin/kegiatan')) return 'kegiatan';
    if (p.startsWith('/admin/rekap')) return 'rekap';
    if (p.startsWith('/admin/wilayah')) return 'wilayah';
    if (p.startsWith('/admin/jurnal')) return 'jurnal';
    if (p.startsWith('/admin/profil')) return 'profil';
    if (p.startsWith('/admin/password')) return 'password';
    if (p.startsWith('/admin/pengumuman')) return 'pengumuman';
    if (p.startsWith('/admin/template-wa')) return 'wa';
    if (p.startsWith('/admin/notif')) return 'notif';
    return '';
  }

  function suntikShell(req, html) {
    if (!/<body[^>]*>/i.test(html) || !/<\/body>/i.test(html)) return html;
    const p = req.originalUrl.split('?')[0];
    if (p.startsWith('/admin/login')) return html;
    const aktif = aktifTab(p);
    const m = html.match(/<title>([^<]*)<\/title>/i);
    const judul = m ? m[1].replace(/\s*-\s*SIGJ\s*$/, '') : 'SIGJ';
    const ini = esc((req.session.admin.email || 'AD').slice(0, 2).toUpperCase());

    const atas = `<header class="appbar no-print"><div class="appbar-in">
      <button type="button" class="ibtn" id="btnMenu" aria-label="Menu">${ic('menu')}</button>
      <div class="appbar-title">${judul}</div>
      <a class="ibtn bell" href="/admin/notif" aria-label="Notifikasi">${ic('bell')}<span class="bell-badge" id="bellBadge" hidden>0</span></a>
      <a class="avatar" href="/admin/profil" aria-label="Profil">${ini}</a></div></header>`;

    const drawer = `<div class="drawer-back no-print" id="drawerBack"></div>
      <aside class="drawer no-print" id="drawer">
        <div class="spread" style="margin-bottom:6px">
          <div class="brand"><img class="brand-logo" style="width:44px;height:44px" src="/logo.png" alt="" onerror="this.style.display='none'">
            <div><b>SIGJ</b><br><small class="muted">Generus Jember Kota</small></div></div>
          <button type="button" class="ibtn" id="btnClose" aria-label="Tutup">${ic('x', 20)}</button>
        </div>
        ${MENU.map(([sek, items]) => `<div class="dsec">${sek}</div>` +
          items.map(([t, h, i, k]) =>
            `<a class="ditem ${k === aktif ? 'on' : ''}" href="${h}">${ic(i, 20)}<span>${esc(t)}</span></a>`).join('')).join('')}
        <div class="dsec"></div>
        <a class="ditem out" href="/admin/logout">${ic('logout', 20)}<span>Keluar</span></a>
      </aside>`;

    const bawah = `<nav class="bottomnav no-print"><div class="bottomnav-in">
      ${TABS.map(([t, h, i, k]) =>
        `<a href="${h}" class="${k === aktif ? 'on' : ''}"><span class="bi">${ic(i, 22)}</span>${t}</a>`).join('')}
      </div></nav>
      <script>(function(){var d=document.getElementById('drawer'),b=document.getElementById('drawerBack');
      function o(){d.classList.add('open');b.classList.add('open')}function c(){d.classList.remove('open');b.classList.remove('open')}
      document.getElementById('btnMenu').onclick=o;b.onclick=c;document.getElementById('btnClose').onclick=c;
      document.addEventListener('keydown',function(e){if(e.key==='Escape')c()});})();</script>
      <script src="/konfirmasi.js"></script>
      <script>fetch('/admin/notif/jumlah').then(function(r){return r.json()}).then(function(d){var b=document.getElementById('bellBadge');if(b&&d.n>0){b.textContent=d.n>9?'9+':d.n;b.hidden=false}}).catch(function(){});</script>`;

    return html
      .replace(/<body[^>]*>/i, () => '<body class="has-shell">' + atas)
      .replace(/<\/body>/i, () => drawer + bawah + '</body>');
  }

  // Semua halaman admin (kalau sudah login) otomatis dibungkus menu & tab bawah
  app.use('/admin', (req, res, next) => {
    if (!req.session || !req.session.admin) return next();
    res.render = function (view, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      app.render(view, Object.assign({}, res.locals, options), (err, html) => {
        if (err) return callback ? callback(err) : next(err);
        html = suntikShell(req, html);
        if (callback) return callback(null, html);
        res.send(html);
      });
    };
    next();
  });

  // ---------- Query bersama ----------
  async function daftarKegiatan(limit, where) {
    const r = await pool.query(`
      SELECT k.id, k.nama, to_char(k.tanggal::date, 'YYYY-MM-DD') AS tgl,
             k.aktif, k.jam_buka, k.jam_tutup, k.batas_telat,
        (SELECT COUNT(*)::int FROM absensi a WHERE a.kegiatan_id = k.id AND a.status = 'Hadir') AS hadir,
        (SELECT COUNT(*)::int FROM absensi a WHERE a.kegiatan_id = k.id AND a.status = 'Izin') AS izin
      FROM kegiatan k ${where || ''}
      ORDER BY k.tanggal::date DESC, k.id DESC LIMIT ${Number(limit) || 50}`);
    return r.rows.map(k => Object.assign({}, k, statusBuka(k)));
  }
  const totalGenerus = async () =>
    (await pool.query('SELECT COUNT(*)::int AS c FROM generus')).rows[0].c;
  const hariIniISO = () =>
    new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });

  // ---------- BERANDA ----------
  app.get('/admin', requireAdmin, aman(async (req, res) => {
    const [g, d, kl, hariIni, terbaru, tigaPuluh] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS c FROM generus'),
      pool.query('SELECT COUNT(*)::int AS c FROM desa'),
      pool.query('SELECT COUNT(*)::int AS c FROM kelompok'),
      daftarKegiatan(20, "WHERE k.tanggal::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date"),
      daftarKegiatan(5),
      pool.query(`SELECT COUNT(*) FILTER (WHERE a.status = 'Hadir')::int AS hadir
        FROM kegiatan k LEFT JOIN absensi a ON a.kegiatan_id = k.id
        WHERE k.tanggal::date >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date - 30
        GROUP BY k.id`),
    ]);
    const total = g.rows[0].c;
    const n = tigaPuluh.rows.length;
    const sum = tigaPuluh.rows.reduce((a, r) => a + r.hadir, 0);
    const persen30 = n && total ? Math.min(100, Math.round(sum * 100 / (n * total))) : 0;
    res.render('beranda', {
      admin: req.session.admin, total, desaN: d.rows[0].c, kelompokN: kl.rows[0].c,
      persen30, hariIni, terbaru,
      tanggalHariIni: new Date().toLocaleDateString('id-ID',
        { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }),
    });
  }, 'Gagal memuat beranda.'));

  // ---------- ABSEN (pusat) ----------
  app.get('/admin/absen', requireAdmin, aman(async (req, res) => {
    const [list, total] = await Promise.all([daftarKegiatan(30), totalGenerus()]);
    res.render('absen_hub', { list, total });
  }, 'Gagal memuat halaman absen.'));

  // ---------- KEGIATAN (daftar) ----------
  app.get('/admin/kegiatan', requireAdmin, aman(async (req, res) => {
    res.render('kegiatan_list', { list: await daftarKegiatan(100) });
  }, 'Gagal memuat daftar kegiatan.'));

    // ---------- REKAP & MONITORING ----------
  const tglOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const geser = (iso, n) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  async function hitungRekap(req) {
    const sampai = tglOk(req.query.sampai) ? req.query.sampai : hariIniISO();
    let dari = tglOk(req.query.dari) ? req.query.dari : geser(sampai, -29);
    if (dari > sampai) dari = sampai;
    const desaId = Number(req.query.desa_id) || 0;
    const kelompokId = Number(req.query.kelompok_id) || 0;
    const izinHadir = req.query.izin === '1';
    const prm = [desaId, kelompokId, dari, sampai];

    const [sesiR, orangR, desaR, kelR] = await Promise.all([
      pool.query(`
        SELECT k.id, k.nama, to_char(k.tanggal::date, 'YYYY-MM-DD') AS tgl,
          COUNT(a.id) FILTER (WHERE a.status = 'Hadir')::int AS hadir,
          COUNT(a.id) FILTER (WHERE a.status = 'Izin')::int AS izin
        FROM kegiatan k
        LEFT JOIN (
          SELECT a.id, a.kegiatan_id, a.status FROM absensi a
          JOIN generus g ON g.id = a.generus_id
          JOIN kelompok kl ON kl.id = g.kelompok_id
          WHERE ($1::int = 0 OR kl.desa_id = $1::int) AND ($2::int = 0 OR kl.id = $2::int)
        ) a ON a.kegiatan_id = k.id
        WHERE k.tanggal::date BETWEEN $3::date AND $4::date
        GROUP BY k.id ORDER BY k.tanggal::date DESC, k.id DESC`, prm),
      pool.query(`
        SELECT g.id, g.nama, d.nama AS desa, kl.nama AS kelompok,
          COUNT(a.id) FILTER (WHERE a.status = 'Hadir')::int AS hadir,
          COUNT(a.id) FILTER (WHERE a.status = 'Izin')::int AS izin
        FROM generus g
        JOIN kelompok kl ON kl.id = g.kelompok_id
        JOIN desa d ON d.id = kl.desa_id
        LEFT JOIN (
          SELECT a.id, a.generus_id, a.status FROM absensi a
          JOIN kegiatan k ON k.id = a.kegiatan_id
          WHERE k.tanggal::date BETWEEN $3::date AND $4::date
        ) a ON a.generus_id = g.id
        WHERE ($1::int = 0 OR kl.desa_id = $1::int) AND ($2::int = 0 OR kl.id = $2::int)
        GROUP BY g.id, d.nama, kl.nama ORDER BY g.nama`, prm),
      pool.query('SELECT * FROM desa ORDER BY nama'),
      pool.query('SELECT * FROM kelompok ORDER BY nama'),
    ]);

    const eff = (h, i) => h + (izinHadir ? i : 0);
    const pct = (v, t) => t ? Math.min(100, Math.round(v * 100 / t)) : 0;
    const n = orangR.rows.length;                      // jumlah mumi dalam wilayah terpilih

    const sesi = sesiR.rows.map(r => Object.assign({}, r, { persen: pct(eff(r.hadir, r.izin), n) }));
    const nKeg = sesi.length;
    const sumH = sesi.reduce((a, r) => a + r.hadir, 0);
    const sumI = sesi.reduce((a, r) => a + r.izin, 0);
    const slots = n * nKeg;
    const hadirEf = eff(sumH, sumI);

    // Tren harian
    const perHari = {};
    sesi.forEach(s => {
      if (!perHari[s.tgl]) perHari[s.tgl] = { v: 0, t: 0 };
      perHari[s.tgl].v += eff(s.hadir, s.izin);
      perHari[s.tgl].t += n;
    });
    const tren = Object.keys(perHari).sort()
      .map(t => ({ tgl: t, persen: pct(perHari[t].v, perHari[t].t) })).slice(-30);

    // Per orang
    const orang = orangR.rows.map(o => Object.assign({}, o, {
      alpa: Math.max(nKeg - o.hadir - o.izin, 0),
      persen: pct(eff(o.hadir, o.izin), nKeg),
    })).sort((a, b) => b.persen - a.persen || a.nama.localeCompare(b.nama));

    // Per wilayah: desa (semua daerah) atau kelompok (kalau desa/kelompok dipilih)
    const grupKel = !!(desaId || kelompokId);
    const mp = new Map();
    orang.forEach(o => {
      const key = grupKel ? o.kelompok : o.desa;
      if (!mp.has(key)) mp.set(key, { label: key, jumlah: 0, hadir: 0, izin: 0 });
      const w = mp.get(key); w.jumlah++; w.hadir += o.hadir; w.izin += o.izin;
    });
    const wilayah = [...mp.values()].map(w => Object.assign({}, w, {
      persen: pct(eff(w.hadir, w.izin), w.jumlah * nKeg),
    })).sort((a, b) => b.persen - a.persen);

    return {
      f: { dari, sampai, desaId, kelompokId, izinHadir },
      desaList: desaR.rows, kelList: kelR.rows,
      n, nKeg, sumH, sumI, slots, hadirEf,
      belum: Math.max(slots - sumH - sumI, 0),
      persen: pct(hadirEf, slots),
      sesi, tren, orang, wilayah, grupKel,
      namaDesa: (desaR.rows.find(d => d.id === desaId) || {}).nama || '',
      namaKel: (kelR.rows.find(k => k.id === kelompokId) || {}).nama || '',
    };
  }

  app.get('/admin/rekap', requireAdmin, aman(async (req, res) => {
    const data = await hitungRekap(req);
    const qs = new URLSearchParams({
      dari: data.f.dari, sampai: data.f.sampai,
      desa_id: data.f.desaId, kelompok_id: data.f.kelompokId,
      izin: data.f.izinHadir ? '1' : '0',
    }).toString();
    res.render('rekap', Object.assign({ qs }, data));
  }, 'Gagal memuat rekap.'));

  app.get('/admin/rekap/export', requireAdmin, aman(async (req, res) => {
    const d = await hitungRekap(req);
    const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? "'" + s : s; };
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = [['Nama', 'Desa', 'Kelompok', 'Hadir', 'Izin', 'Belum/Alpa', 'Jumlah Sesi', 'Persen Hadir']
      .map(q).join(';')];
    d.orang.forEach(o => lines.push([q(safe(o.nama)), q(safe(o.desa)), q(safe(o.kelompok)),
      q(o.hadir), q(o.izin), q(o.alpa), q(d.nKeg), q(o.persen + '%')].join(';')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="rekap-${d.f.dari}-sd-${d.f.sampai}.csv"`);
    res.send('\uFEFFsep=;\n' + lines.join('\n'));
  }, 'Gagal mengekspor rekap.'));
  
  // ---------- DAFTAR MUMI ----------
  app.get('/admin/generus/export', requireAdmin, aman(async (req, res) => {
    const r = await pool.query(`
      SELECT g.nama, d.nama AS desa, kl.nama AS kelompok, g.tgl_lahir::text AS tgl_lahir,
             g.no_hp, g.jenis_kelamin
      FROM generus g JOIN kelompok kl ON kl.id = g.kelompok_id JOIN desa d ON d.id = kl.desa_id
      ORDER BY d.nama, kl.nama, g.nama`);
    const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? "'" + s : s; };
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const hp = (v) => v ? '="' + String(v).replace(/[^0-9+]/g, '') + '"' : '';
    const lines = [['Nama', 'Desa', 'Kelompok', 'Tanggal Lahir', 'No. HP', 'Jenis Kelamin'].map(q).join(';')];
    r.rows.forEach(x => lines.push([q(safe(x.nama)), q(safe(x.desa)), q(safe(x.kelompok)),
      q(safe(x.tgl_lahir)), q(hp(x.no_hp)), q(safe(x.jenis_kelamin))].join(';')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="data-muda-mudi.csv"');
    res.send('\uFEFFsep=;\n' + lines.join('\n'));
  }, 'Gagal mengekspor data.'));

  app.get('/admin/generus', requireAdmin, aman(async (req, res) => {
    const q = (req.query.q || '').trim();
    const desaId = Number(req.query.desa_id) || 0;
    const kelompokId = Number(req.query.kelompok_id) || 0;
    const jk = ['Laki-laki', 'Perempuan'].includes(req.query.jk) ? req.query.jk : '';
    const [rows, desa, kelompok] = await Promise.all([
      pool.query(`
        SELECT g.id, g.nama, g.jenis_kelamin, g.no_hp, d.nama AS desa, kl.nama AS kelompok,
          EXTRACT(YEAR FROM age(NULLIF(g.tgl_lahir::text, '')::date))::int AS umur
        FROM generus g
        JOIN kelompok kl ON kl.id = g.kelompok_id
        JOIN desa d ON d.id = kl.desa_id
        WHERE ($1::text = '' OR g.nama ILIKE $2 OR COALESCE(g.no_hp, '') ILIKE $2)
          AND ($3::int = 0 OR d.id = $3::int)
          AND ($4::int = 0 OR kl.id = $4::int)
          AND ($5::text = '' OR g.jenis_kelamin = $5)
        ORDER BY g.nama LIMIT 500`, [q, `%${q}%`, desaId, kelompokId, jk]),
      pool.query('SELECT * FROM desa ORDER BY nama'),
      pool.query('SELECT * FROM kelompok ORDER BY nama'),
    ]);
    res.render('mumi', { rows: rows.rows, desa: desa.rows, kelompok: kelompok.rows, q, desaId, kelompokId, jk });
  }, 'Gagal memuat daftar muda-mudi.'));

  // ---------- TAMBAH MUMI (oleh admin, opsional langsung diabsenkan) ----------
  app.get('/admin/generus/baru', requireAdmin, aman(async (req, res) => {
    const kid = Number(req.query.kegiatan) || 0;
    const [desa, kelompok, kg] = await Promise.all([
      pool.query('SELECT * FROM desa ORDER BY nama'),
      pool.query('SELECT * FROM kelompok ORDER BY nama'),
      kid ? pool.query('SELECT id, nama FROM kegiatan WHERE id = $1', [kid]) : { rows: [] },
    ]);
    res.render('generus_baru', { desa: desa.rows, kelompok: kelompok.rows, k: kg.rows[0] || null });
  }, 'Gagal memuat form.'));

  app.post('/admin/generus/baru', requireAdmin, aman(async (req, res) => {
    const { nama, kelompok_id, tgl_lahir, no_hp, jenis_kelamin, status } = req.body;
    const kid = Number(req.body.kegiatan_id) || 0;
    if (!nama || !nama.trim() || !kelompok_id)
      return res.redirect('/admin/generus/baru' + (kid ? '?kegiatan=' + kid : ''));

    const ada = await pool.query(`
      SELECT id FROM generus
      WHERE LOWER(nama) = LOWER($1) AND tgl_lahir IS NOT DISTINCT FROM $2 LIMIT 1`,
      [nama.trim(), tgl_lahir || null]);
    let gid;
    if (ada.rowCount) gid = ada.rows[0].id;
    else {
      const b = await pool.query(`
        INSERT INTO generus (nama, kelompok_id, tgl_lahir, no_hp, jenis_kelamin)
        VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [nama.trim(), kelompok_id, tgl_lahir || null, no_hp || null, jenis_kelamin || null]);
      gid = b.rows[0].id;
    }

    if (kid && ['Hadir', 'Izin'].includes(status)) {
      const cek = await pool.query('SELECT 1 FROM kegiatan WHERE id = $1', [kid]);
      if (cek.rowCount) {
        const alasan = status === 'Izin'
          ? ((req.body.alasan || '').trim().slice(0, 200) || 'Izin via pengurus') : null;
        await pool.query(`
          INSERT INTO absensi (kegiatan_id, generus_id, status, alasan, terlambat, oleh, device_id)
          VALUES ($1, $2, $3, $4, 0, 'admin', NULL)
          ON CONFLICT (kegiatan_id, generus_id) DO UPDATE SET
            status = EXCLUDED.status, alasan = EXCLUDED.alasan, terlambat = 0,
            oleh = 'admin', device_id = NULL, waktu = NOW()`, [kid, gid, status, alasan]);
      }
    }
    res.redirect(kid ? '/admin/kegiatan/' + kid : '/admin/generus');
  }, 'Gagal menyimpan muda-mudi.'));

  // ---------- PROFIL ----------
  app.get('/admin/profil', requireAdmin, aman(async (req, res) => {
    const n = (await pool.query('SELECT COUNT(*)::int AS c FROM admin')).rows[0].c;
    res.render('profil', { admin: req.session.admin, jumlahAdmin: n });
  }, 'Gagal memuat profil.'));

  // ---------- JURNAL (upload materi) ----------
  const ensureJurnal = pool.query(`
    CREATE TABLE IF NOT EXISTS jurnal (
      id SERIAL PRIMARY KEY,
      judul TEXT NOT NULL,
      tanggal DATE NOT NULL DEFAULT CURRENT_DATE,
      kegiatan_id INTEGER REFERENCES kegiatan(id) ON DELETE SET NULL,
      isi TEXT, link TEXT,
      file_nama TEXT, file_tipe TEXT, file_data BYTEA,
      dibuat_oleh TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('Gagal membuat tabel jurnal:', e));

  const MIME = {
    '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
  };
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      MIME[ext] ? cb(null, true) : cb(new Error('Jenis file tidak didukung. Gunakan PDF, gambar, Word, PowerPoint, Excel, atau TXT.'));
    },
  });

  async function tampilJurnal(req, res, pesan, ok) {
    await ensureJurnal;
    const [list, keg] = await Promise.all([
      pool.query(`
        SELECT j.id, j.judul, to_char(j.tanggal, 'YYYY-MM-DD') AS tgl, j.isi, j.link, j.file_nama,
               (j.file_data IS NOT NULL) AS ada_file, j.dibuat_oleh, k.nama AS kegiatan
        FROM jurnal j LEFT JOIN kegiatan k ON k.id = j.kegiatan_id
        ORDER BY j.tanggal DESC, j.id DESC LIMIT 200`),
      daftarKegiatan(100),
    ]);
    res.render('jurnal', { list: list.rows, keg, pesan: pesan || null, ok: !!ok, hariIni: hariIniISO() });
  }

  app.get('/admin/jurnal', requireAdmin, aman((req, res) => tampilJurnal(req, res), 'Gagal memuat jurnal.'));

  app.post('/admin/jurnal', requireAdmin,
    (req, res, next) => upload.single('berkas')(req, res, (err) => {
      if (err) return tampilJurnal(req, res,
        err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file maksimal 4 MB. Untuk file besar, tempel link Google Drive.' : err.message)
        .catch(e => { console.error(e); res.status(500).send('Gagal memuat jurnal.'); });
      next();
    }),
    aman(async (req, res) => {
      await ensureJurnal;
      const judul = (req.body.judul || '').trim().slice(0, 150);
      if (!judul) return tampilJurnal(req, res, 'Judul wajib diisi.');
      const tgl = /^\d{4}-\d{2}-\d{2}$/.test(req.body.tanggal || '') ? req.body.tanggal : hariIniISO();
      const kid = Number(req.body.kegiatan_id) || null;
      let link = (req.body.link || '').trim().slice(0, 500);
      if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
      let fn = null, ft = null, fd = null;
      if (req.file) {
        fn = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 200);
        ft = MIME[path.extname(fn).toLowerCase()];
        fd = req.file.buffer;
      }
      await pool.query(`
        INSERT INTO jurnal (judul, tanggal, kegiatan_id, isi, link, file_nama, file_tipe, file_data, dibuat_oleh)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [judul, tgl, kid, (req.body.isi || '').trim().slice(0, 2000) || null,
         link || null, fn, ft, fd, req.session.admin.email]);
      res.redirect('/admin/jurnal');
    }, 'Gagal menyimpan jurnal.'));

  app.get('/admin/jurnal/:id/file', requireAdmin, aman(async (req, res) => {
    await ensureJurnal;
    const r = await pool.query('SELECT file_nama, file_tipe, file_data FROM jurnal WHERE id = $1',
      [Number(req.params.id) || 0]);
    const f = r.rows[0];
    if (!f || !f.file_data) return res.status(404).send('File tidak ditemukan.');
    const inline = ['application/pdf', 'image/jpeg', 'image/png'].includes(f.file_tipe);
    res.setHeader('Content-Type', f.file_tipe);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.file_nama)}`);
    res.send(f.file_data);
  }, 'Gagal membuka file.'));

  app.post('/admin/jurnal/:id/hapus', requireAdmin, aman(async (req, res) => {
    await ensureJurnal;
    await pool.query('DELETE FROM jurnal WHERE id = $1', [Number(req.params.id) || 0]);
    res.redirect('/admin/jurnal');
  }, 'Gagal menghapus jurnal.'));
};