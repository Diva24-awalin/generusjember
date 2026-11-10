module.exports = function (app, pool, { requireAdmin }) {
  // ---------- Tabel (dibuat otomatis, log lebih dari 180 hari dihapus) ----------
  const siap = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS log_aktivitas (
      id SERIAL PRIMARY KEY,
      waktu TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      admin_email TEXT, aksi TEXT NOT NULL, kategori TEXT NOT NULL,
      detail TEXT, ip TEXT)`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_log_waktu ON log_aktivitas (waktu DESC)');
    await pool.query(`DELETE FROM log_aktivitas WHERE waktu < NOW() - INTERVAL '180 days'`);
  })().catch(e => console.error('Gagal menyiapkan log aktivitas:', e));

  async function catat(pelaku, aksi, kat, detail, ip) {
    try {
      await siap;
      await pool.query(
        'INSERT INTO log_aktivitas (admin_email, aksi, kategori, detail, ip) VALUES ($1, $2, $3, $4, $5)',
        [pelaku, aksi, kat, String(detail || '').slice(0, 500), ip || null]);
    } catch (e) { console.error('Gagal mencatat log:', e.message); }
  }

  // ---------- Pencarian nama untuk detail log ----------
  const B = (req) => req.body || {};
  const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
  const keg = async (id) => ((await q1('SELECT nama FROM kegiatan WHERE id = $1', [Number(id) || 0])) || {}).nama || '#' + id;
  const gen = async (id) => ((await q1('SELECT nama FROM generus WHERE id = $1', [Number(id) || 0])) || {}).nama || '#' + id;
  const desaN = async (id) => ((await q1('SELECT nama FROM desa WHERE id = $1', [Number(id) || 0])) || {}).nama || '#' + id;
  const kelN = async (id) => ((await q1('SELECT nama FROM kelompok WHERE id = $1', [Number(id) || 0])) || {}).nama || '#' + id;
  const jumlahAdmin = async () => (await q1('SELECT COUNT(*)::int AS c FROM admin')).c;

  // ---------- Aturan: apa yang dicatat ----------
  // pra(m, req): dijalankan SEBELUM aksi (supaya nama yang akan dihapus masih ada)
  // akhir(m, req, pra): dijalankan sesudahnya; return null = jangan dicatat
  const R = [
    { m: 'GET', re: /^\/admin\/logout$/, aksi: 'logout', kat: 'login',
      ok: (c) => c === 302, pra: async () => 'Keluar dari akun' },

    { m: 'GET', re: /^\/admin\/kegiatan\/(\d+)\/export$/, aksi: 'ekspor_absensi', kat: 'ekspor',
      pra: async (m) => 'Rekap kegiatan: ' + await keg(m[1]) },
    { m: 'GET', re: /^\/admin\/generus\/export$/, aksi: 'ekspor_mumi', kat: 'ekspor',
      pra: async () => 'Data seluruh muda-mudi' },
    { m: 'GET', re: /^\/admin\/rekap\/export$/, aksi: 'ekspor_rekap', kat: 'ekspor',
      pra: async (m, req) => `Rekap ${req.query.dari || '-'} s.d. ${req.query.sampai || '-'}` },

    { m: 'POST', re: /^\/admin\/kegiatan\/(\d+)\/tandai$/, aksi: 'tandai_absensi', kat: 'absensi',
      pra: async (m, req) => `${await gen(B(req).generus_id)} → ${B(req).status} di ${await keg(m[1])}` },
    { m: 'POST', re: /^\/admin\/kegiatan\/(\d+)\/batal\/(\d+)$/, aksi: 'batal_absensi', kat: 'absensi',
      pra: async (m) => `${await gen(m[2])} dibatalkan di ${await keg(m[1])}` },
    { m: 'POST', re: /^\/admin\/kegiatan\/(\d+)\/ganti-qr$/, aksi: 'ganti_qr', kat: 'absensi',
      pra: async (m) => 'QR kegiatan: ' + await keg(m[1]) },
    { m: 'POST', re: /^\/admin\/kegiatan\/(\d+)\/toggle$/, aksi: 'buka_tutup', kat: 'absensi',
      pra: async (m) => 'Buka/tutup absensi: ' + await keg(m[1]) },
    { m: 'POST', re: /^\/admin\/kegiatan\/(\d+)\/jadwal$/, aksi: 'jadwal', kat: 'absensi',
      pra: async (m) => 'Jadwal kegiatan: ' + await keg(m[1]) },

    { m: 'POST', re: /^\/admin\/kegiatan$/, aksi: 'buat_kegiatan', kat: 'data',
      pra: async (m, req) => 'Kegiatan: ' + (B(req).nama || '') },
    { m: 'POST', re: /^\/admin\/kegiatan\/(\d+)\/edit$/, aksi: 'edit_kegiatan', kat: 'data',
      pra: async (m) => 'Kegiatan: ' + await keg(m[1]) },
    { m: 'POST', re: /^\/admin\/kegiatan\/(\d+)\/hapus$/, aksi: 'hapus_kegiatan', kat: 'data',
      pra: async (m) => 'Kegiatan: ' + await keg(m[1]) },

    { m: 'POST', re: /^\/admin\/generus\/baru$/, aksi: 'tambah_mumi', kat: 'data',
      pra: async (m, req) => {
        const b = B(req);
        return 'Muda-mudi: ' + (b.nama || '') +
          (b.kegiatan_id && b.status ? ` · langsung ${b.status} di ${await keg(b.kegiatan_id)}` : '');
      } },
    { m: 'POST', re: /^\/admin\/generus\/(\d+)\/edit$/, aksi: 'edit_mumi', kat: 'data',
      pra: async (m) => 'Muda-mudi: ' + await gen(m[1]) },
    { m: 'POST', re: /^\/admin\/generus\/(\d+)\/hapus$/, aksi: 'hapus_mumi', kat: 'data',
      pra: async (m) => 'Muda-mudi: ' + await gen(m[1]) },

    { m: 'POST', re: /^\/admin\/desa$/, aksi: 'tambah_desa', kat: 'data',
      pra: async (m, req) => 'Desa: ' + (B(req).nama || '') },
    { m: 'POST', re: /^\/admin\/kelompok$/, aksi: 'tambah_kelompok', kat: 'data',
      pra: async (m, req) => `${await desaN(B(req).desa_id)}: ${String(B(req).nama || '').split('\n').map(s => s.trim()).filter(Boolean).join(', ')}` },
    { m: 'POST', re: /^\/admin\/desa\/(\d+)\/hapus$/, aksi: 'hapus_desa', kat: 'data',
      pra: async (m) => 'Desa: ' + await desaN(m[1]) },
    { m: 'POST', re: /^\/admin\/kelompok\/(\d+)\/hapus$/, aksi: 'hapus_kelompok', kat: 'data',
      pra: async (m) => 'Kelompok: ' + await kelN(m[1]) },

    // Form dengan upload file: isi form baru terbaca setelah selesai, jadi pakai "akhir"
    { m: 'POST', re: /^\/admin\/jurnal$/, aksi: 'jurnal_tambah', kat: 'data',
      akhir: async (m, req) => 'Jurnal: ' + (B(req).judul || '') },
    { m: 'POST', re: /^\/admin\/jurnal\/(\d+)\/hapus$/, aksi: 'jurnal_hapus', kat: 'data',
      pra: async (m) => 'Jurnal: ' + (((await q1('SELECT judul FROM jurnal WHERE id = $1', [Number(m[1])])) || {}).judul || '#' + m[1]) },
    { m: 'POST', re: /^\/admin\/pengumuman$/, aksi: 'pengumuman_tambah', kat: 'data',
      akhir: async (m, req) => 'Pengumuman: ' + (B(req).judul || '') },
    { m: 'POST', re: /^\/admin\/pengumuman\/(\d+)\/hapus$/, aksi: 'pengumuman_hapus', kat: 'data',
      pra: async (m) => 'Pengumuman: ' + (((await q1('SELECT judul FROM pengumuman WHERE id = $1', [Number(m[1])])) || {}).judul || '#' + m[1]) },

    { m: 'POST', re: /^\/admin\/template-wa\/(\w+?)(\/reset)?$/, aksi: 'template_wa', kat: 'lainnya',
      pra: async (m) => m[1] === 'setting' ? 'Ubah salam & penutup'
        : (m[2] ? 'Kembalikan bawaan: ' : 'Ubah template: ') + m[1] },

    // Hasilnya (berhasil/gagal) tidak terlihat dari status HTTP, jadi dibandingkan sebelum dan sesudah
    { m: 'POST', re: /^\/admin\/password$/, aksi: 'ganti_password', kat: 'lainnya', ok: () => true,
      pra: async (m, req) => ((await q1('SELECT password FROM admin WHERE id = $1', [req.session.admin.id])) || {}).password,
      akhir: async (m, req, awal) => {
        const skrg = ((await q1('SELECT password FROM admin WHERE id = $1', [req.session.admin.id])) || {}).password;
        return skrg && skrg !== awal ? 'Mengganti password akun sendiri' : null;
      } },
    { m: 'POST', re: /^\/admin\/admin-baru$/, aksi: 'tambah_admin', kat: 'lainnya', ok: () => true,
      pra: async () => await jumlahAdmin(),
      akhir: async (m, req, awal) =>
        (await jumlahAdmin()) > awal ? 'Admin baru: ' + (B(req).email || '') : null },

    // Peserta yang absen lewat QR (tanpa login)
    { m: 'POST', re: /^\/absen\/([\w-]+)$/, peserta: true, kat: 'absensi',
      pra: async (m, req) => {
        const b = B(req);
        const k = await q1('SELECT nama FROM kegiatan WHERE token = $1', [m[1]]);
        const nama = b.mode === 'lama' ? await gen(b.generus_id) : (b.nama || '-');
        return `${nama} · ${b.status || '-'} · ${k ? k.nama : 'QR tidak dikenal'}`;
      } },
  ];

  // ---------- Middleware pencatat (harus terdaftar SEBELUM route lain) ----------
  app.use(async (req, res, next) => {
    try {
      const isLogin = req.method === 'POST' && req.path === '/admin/login';
      const a = R.find(r => r.m === req.method && r.re.test(req.path));
      if (!a && !isLogin) return next();

      const sess = req.session && req.session.admin;
      const aktor = sess ? sess.email : null;
      if (a && !a.peserta && !aktor) return next();   // belum login: bukan aktivitas admin

      const m = a ? req.path.match(a.re) : null;
      let pra = null;
      if (a && a.pra) { try { pra = await a.pra(m, req); } catch (e) { pra = ''; } }

      let hasilRender = null;
      if (a && a.peserta) {
        const asli = res.render;
        res.render = function (view, opts) {
          if (view === 'selesai') hasilRender = opts;
          return asli.apply(this, arguments);
        };
      }

      const rekam = async () => {
        const code = res.statusCode;
        let aksi, kat, detail, pelaku = aktor;
        if (isLogin) {
          const email = String(B(req).email || '').slice(0, 150);
          pelaku = email; kat = 'login';
          if (code >= 300 && code < 400) { aksi = 'login'; detail = 'Berhasil masuk'; }
          else { aksi = 'login_gagal'; detail = code === 429 ? 'Diblokir: terlalu banyak percobaan' : 'Email atau password salah'; }
        } else if (a.peserta) {
          if (!hasilRender) return;
          pelaku = null; kat = a.kat;
          aksi = hasilRender.ok ? 'absen_peserta' : 'absen_ditolak';
          detail = pra + (hasilRender.ok ? '' : ' · ditolak: ' + hasilRender.pesan);
        } else {
          const sukses = a.ok ? a.ok(code)
            : (req.method === 'GET' ? code === 200 : code >= 300 && code < 400);
          if (!sukses) return;
          detail = a.akhir ? await a.akhir(m, req, pra) : pra;
          if (detail === null) return;
          aksi = a.aksi; kat = a.kat;
        }
        await catat(pelaku, aksi, kat, detail, req.ip);
      };

      // Catat dulu baru kirim respons (penting di Vercel: proses bisa berhenti setelah respons terkirim)
      const endAsli = res.end;
      let sudah = false;
      res.end = function (...args) {
        if (sudah) return endAsli.apply(res, args);
        sudah = true;
        Promise.resolve().then(rekam).catch(() => {}).then(() => endAsli.apply(res, args));
        return res;
      };
    } catch (e) { console.error('Middleware log:', e.message); }
    next();
  });

  // ---------- Halaman Log Aktivitas (didaftarkan SETELAH routes-baru) ----------
  const KAT = [['', 'Semua'], ['login', 'Login'], ['ekspor', 'Ekspor'],
    ['absensi', 'Absensi'], ['data', 'Data'], ['lainnya', 'Lainnya']];
  const LABEL = {
    login: 'login', login_gagal: 'login gagal', logout: 'logout',
    ekspor_absensi: 'ekspor', ekspor_mumi: 'ekspor', ekspor_rekap: 'ekspor',
    tandai_absensi: 'tandai absen', batal_absensi: 'batal absen',
    absen_peserta: 'absen peserta', absen_ditolak: 'absen ditolak',
    ganti_qr: 'ganti QR', buka_tutup: 'buka/tutup', jadwal: 'jadwal',
    buat_kegiatan: 'buat kegiatan', edit_kegiatan: 'edit kegiatan', hapus_kegiatan: 'hapus kegiatan',
    tambah_mumi: 'tambah mumi', edit_mumi: 'edit mumi', hapus_mumi: 'hapus mumi',
    tambah_desa: 'tambah desa', tambah_kelompok: 'tambah kelompok',
    hapus_desa: 'hapus desa', hapus_kelompok: 'hapus kelompok',
    jurnal_tambah: 'tambah jurnal', jurnal_hapus: 'hapus jurnal',
    pengumuman_tambah: 'pengumuman', pengumuman_hapus: 'hapus pengumuman',
    template_wa: 'template WA', ganti_password: 'ganti password', tambah_admin: 'tambah admin',
  };

  function halaman() {
    app.get('/admin/log', requireAdmin, async (req, res) => {
      try {
        await siap;
        const q = (req.query.q || '').trim().slice(0, 100);
        const kat = KAT.some(k => k[0] && k[0] === req.query.kat) ? req.query.kat : '';
        const hal = Math.max(1, Number(req.query.hal) || 1);
        const per = 50;
        const where = `($1::text = '' OR kategori = $1)
          AND ($2::text = '' OR COALESCE(admin_email, 'peserta') ILIKE $3 OR detail ILIKE $3 OR aksi ILIKE $3)`;
        const [rows, tot] = await Promise.all([
          pool.query(`
            SELECT to_char(waktu AT TIME ZONE 'Asia/Jakarta', 'DD/MM/YYYY HH24:MI:SS') AS waktu,
                   admin_email, aksi, kategori, detail, ip
            FROM log_aktivitas WHERE ${where}
            ORDER BY waktu DESC, id DESC LIMIT ${per} OFFSET $4`,
            [kat, q, `%${q}%`, (hal - 1) * per]),
          pool.query(`SELECT COUNT(*)::int AS c FROM log_aktivitas WHERE ${where}`, [kat, q, `%${q}%`]),
        ]);
        const jumlah = tot.rows[0].c;
        res.render('log', {
          rows: rows.rows, q, kat, hal, per, jumlah,
          halaman: Math.max(1, Math.ceil(jumlah / per)), KAT, LABEL,
        });
      } catch (e) {
        console.error('Log aktivitas error:', e);
        res.status(500).send('Gagal memuat log aktivitas.');
      }
    });
  }

  return { halaman, catat };
};