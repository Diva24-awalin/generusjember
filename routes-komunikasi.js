const multer = require('multer');
const path = require('path');

module.exports = function (app, pool, { requireAdmin }) {
  const aman = (fn, pesan) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error(pesan, e); res.status(500).send(pesan); }
  };
  const hariIniISO = () =>
    new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });

  // ---------- Bawaan template ----------
  const SALAM = "Assalamu'alaikum warahmatullahi wabarakatuh";
  const PENUTUP = 'Alhamdulillahi jazakumullahu khoiro';
  const DEF = {
    undangan_kegiatan: ['Undangan Kegiatan',
      'Kami mengundang {nama} ({kelompok}) untuk hadir pada kegiatan {kegiatan} pada {tanggal}. Ditunggu kehadirannya ya.'],
    pengingat_ketidakhadiran: ['Pengingat Ketidakhadiran',
      'Kami mohon perhatian: {nama} dari {kelompok} belum tercatat hadir pada kegiatan {kegiatan} ({tanggal}). Tingkat kehadiran sejauh ini {persen}. Mohon bimbingannya agar lebih rutin hadir.'],
    perubahan_jadwal: ['Perubahan Jadwal',
      'Ada perubahan jadwal kegiatan {kegiatan}: {tanggal}. Mohon diperhatikan.'],
    terima_kasih: ['Terima Kasih Kehadiran',
      'Terima kasih {nama} sudah hadir di kegiatan {kegiatan} ({tanggal}). Semoga ilmunya bermanfaat dan berkah.'],
  };

  // ---------- Tabel (dibuat otomatis) ----------
  const siap = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS pengumuman (
      id SERIAL PRIMARY KEY,
      judul TEXT NOT NULL, isi TEXT,
      level TEXT NOT NULL DEFAULT 'semua', target TEXT,
      berlaku_sampai DATE, sematkan BOOLEAN NOT NULL DEFAULT TRUE,
      foto_tipe TEXT, foto_data BYTEA,
      dibuat_oleh TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS wa_template (
      kode TEXT PRIMARY KEY, judul TEXT NOT NULL, isi TEXT NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS wa_setting (
      kunci TEXT PRIMARY KEY, nilai TEXT NOT NULL)`);
    for (const [kode, [judul, isi]] of Object.entries(DEF))
      await pool.query(`INSERT INTO wa_template (kode, judul, isi) VALUES ($1, $2, $3)
        ON CONFLICT (kode) DO NOTHING`, [kode, judul, isi]);
    await pool.query(`INSERT INTO wa_setting (kunci, nilai) VALUES ('salam', $1)
      ON CONFLICT (kunci) DO NOTHING`, [SALAM]);
    await pool.query(`INSERT INTO wa_setting (kunci, nilai) VALUES ('penutup', $1)
      ON CONFLICT (kunci) DO NOTHING`, [PENUTUP]);
  })().catch(e => console.error('Gagal menyiapkan tabel komunikasi:', e));

  // =====================================================
  // PENGUMUMAN
  // =====================================================
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
        ? cb(null, true) : cb(new Error('Foto harus berformat JPG, PNG, atau WebP.'));
    },
  });

  async function tampilPengumuman(req, res, pesan, ok) {
    await siap;
    const [list, desa, kelompok] = await Promise.all([
      pool.query(`
        SELECT id, judul, isi, level, target,
          to_char(berlaku_sampai, 'YYYY-MM-DD') AS sampai, sematkan,
          (foto_data IS NOT NULL) AS ada_foto,
          (berlaku_sampai IS NULL OR berlaku_sampai >= $1::date) AS aktif
        FROM pengumuman ORDER BY id DESC LIMIT 100`, [hariIniISO()]),
      pool.query('SELECT * FROM desa ORDER BY nama'),
      pool.query('SELECT * FROM kelompok ORDER BY nama'),
    ]);
    res.render('pengumuman', {
      list: list.rows, desa: desa.rows, kelompok: kelompok.rows,
      pesan: pesan || null, ok: !!ok,
    });
  }

  app.get('/admin/pengumuman', requireAdmin,
    aman((req, res) => tampilPengumuman(req, res), 'Gagal memuat pengumuman.'));

  // Daftar pengumuman yang disematkan (dipakai Beranda)
  app.get('/admin/pengumuman/aktif.json', requireAdmin, aman(async (req, res) => {
    await siap;
    const r = await pool.query(`
      SELECT id, judul, isi, level, target,
        to_char(berlaku_sampai, 'YYYY-MM-DD') AS sampai, (foto_data IS NOT NULL) AS ada_foto
      FROM pengumuman
      WHERE sematkan AND (berlaku_sampai IS NULL OR berlaku_sampai >= $1::date)
      ORDER BY id DESC LIMIT 10`, [hariIniISO()]);
    res.json(r.rows);
  }, 'Gagal memuat pengumuman.'));

  app.post('/admin/pengumuman', requireAdmin,
    (req, res, next) => upload.single('foto')(req, res, (err) => {
      if (err) return tampilPengumuman(req, res,
        err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran foto maksimal 4 MB.' : err.message)
        .catch(e => { console.error(e); res.status(500).send('Gagal memuat pengumuman.'); });
      next();
    }),
    aman(async (req, res) => {
      await siap;
      const judul = (req.body.judul || '').trim().slice(0, 150);
      if (!judul) return tampilPengumuman(req, res, 'Judul wajib diisi.');
      const isi = (req.body.isi || '').trim().slice(0, 3000) || null;
      const level = ['semua', 'desa', 'kelompok'].includes(req.body.level) ? req.body.level : 'semua';
      const desaId = Number(req.body.desa_id) || 0;
      const kelId = Number(req.body.kelompok_id) || 0;

      let target = 'Semua daerah', levelPakai = 'semua';
      if (level === 'desa' && desaId) {
        const d = await pool.query('SELECT nama FROM desa WHERE id = $1', [desaId]);
        if (d.rowCount) { target = d.rows[0].nama; levelPakai = 'desa'; }
      } else if (level === 'kelompok' && kelId) {
        const k = await pool.query(`SELECT kl.nama AS kel, d.nama AS desa FROM kelompok kl
          JOIN desa d ON d.id = kl.desa_id WHERE kl.id = $1`, [kelId]);
        if (k.rowCount) { target = k.rows[0].desa + ' › ' + k.rows[0].kel; levelPakai = 'kelompok'; }
      }

      const sampai = /^\d{4}-\d{2}-\d{2}$/.test(req.body.sampai || '') ? req.body.sampai : null;
      await pool.query(`
        INSERT INTO pengumuman (judul, isi, level, target, berlaku_sampai, sematkan, foto_tipe, foto_data, dibuat_oleh)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [judul, isi, levelPakai, target, sampai, req.body.sematkan === '1',
         req.file ? req.file.mimetype : null, req.file ? req.file.buffer : null,
         req.session.admin.email]);
      res.redirect('/admin/pengumuman');
    }, 'Gagal menyimpan pengumuman.'));

  app.get('/admin/pengumuman/:id/foto', requireAdmin, aman(async (req, res) => {
    await siap;
    const r = await pool.query('SELECT foto_tipe, foto_data FROM pengumuman WHERE id = $1',
      [Number(req.params.id) || 0]);
    const f = r.rows[0];
    if (!f || !f.foto_data) return res.status(404).send('Foto tidak ditemukan.');
    res.setHeader('Content-Type', f.foto_tipe);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.foto_data);
  }, 'Gagal membuka foto.'));

  app.post('/admin/pengumuman/:id/hapus', requireAdmin, aman(async (req, res) => {
    await siap;
    await pool.query('DELETE FROM pengumuman WHERE id = $1', [Number(req.params.id) || 0]);
    res.redirect('/admin/pengumuman');
  }, 'Gagal menghapus pengumuman.'));

  // =====================================================
  // TEMPLATE WA
  // =====================================================
  const susunPesan = (salam, isi, penutup, v) => {
    const badan = String(isi).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m));
    return salam + '\n\n' + badan + '\n\n' + penutup;
  };
  const ambilSetting = async () => {
    const r = await pool.query('SELECT kunci, nilai FROM wa_setting');
    const m = {}; r.rows.forEach(x => { m[x.kunci] = x.nilai; });
    return { salam: m.salam || SALAM, penutup: m.penutup || PENUTUP };
  };

  app.get('/admin/template-wa', requireAdmin, aman(async (req, res) => {
    await siap;
    const [list, set] = await Promise.all([
      pool.query('SELECT kode, judul, isi FROM wa_template ORDER BY judul'),
      ambilSetting(),
    ]);
    res.render('template_wa', { list: list.rows, set, ok: req.query.ok === '1' });
  }, 'Gagal memuat template WA.'));

  app.post('/admin/template-wa/setting', requireAdmin, aman(async (req, res) => {
    await siap;
    const salam = (req.body.salam || '').trim().slice(0, 200) || SALAM;
    const penutup = (req.body.penutup || '').trim().slice(0, 200) || PENUTUP;
    await pool.query(`INSERT INTO wa_setting (kunci, nilai) VALUES ('salam', $1)
      ON CONFLICT (kunci) DO UPDATE SET nilai = EXCLUDED.nilai`, [salam]);
    await pool.query(`INSERT INTO wa_setting (kunci, nilai) VALUES ('penutup', $1)
      ON CONFLICT (kunci) DO UPDATE SET nilai = EXCLUDED.nilai`, [penutup]);
    res.redirect('/admin/template-wa?ok=1');
  }, 'Gagal menyimpan salam dan penutup.'));

  app.post('/admin/template-wa/:kode/reset', requireAdmin, aman(async (req, res) => {
    await siap;
    const d = DEF[req.params.kode];
    if (d) await pool.query('UPDATE wa_template SET isi = $1 WHERE kode = $2', [d[1], req.params.kode]);
    res.redirect('/admin/template-wa?ok=1');
  }, 'Gagal mengembalikan template.'));

  app.post('/admin/template-wa/:kode', requireAdmin, aman(async (req, res) => {
    await siap;
    const isi = (req.body.isi || '').trim().slice(0, 800);
    if (isi) await pool.query('UPDATE wa_template SET isi = $1 WHERE kode = $2', [isi, req.params.kode]);
    res.redirect('/admin/template-wa?ok=1');
  }, 'Gagal menyimpan template.'));

  // Buka WhatsApp dengan pesan dari template
  app.get('/admin/wa/:kid/:gid', requireAdmin, aman(async (req, res) => {
    await siap;
    const kode = DEF[req.query.t] ? req.query.t : 'undangan_kegiatan';
    const kid = Number(req.params.kid) || 0, gid = Number(req.params.gid) || 0;
    const [k, g, t, st, set] = await Promise.all([
      pool.query(`SELECT nama, to_char(tanggal::date, 'YYYY-MM-DD') AS tgl FROM kegiatan WHERE id = $1`, [kid]),
      pool.query(`SELECT g.nama, g.no_hp, kl.nama AS kelompok, d.nama AS desa
        FROM generus g JOIN kelompok kl ON kl.id = g.kelompok_id JOIN desa d ON d.id = kl.desa_id
        WHERE g.id = $1`, [gid]),
      pool.query('SELECT isi FROM wa_template WHERE kode = $1', [kode]),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'Hadir')::int AS hadir,
        (SELECT COUNT(*)::int FROM kegiatan) AS total FROM absensi WHERE generus_id = $1`, [gid]),
      ambilSetting(),
    ]);
    if (!k.rowCount || !g.rowCount) return res.status(404).send('Data tidak ditemukan.');
    const s = st.rows[0];
    const persen = s.total ? Math.round(s.hadir * 100 / s.total) + '%' : '0%';
    const pesan = susunPesan(set.salam, t.rows[0] ? t.rows[0].isi : DEF[kode][1], set.penutup, {
      nama: g.rows[0].nama, kelompok: g.rows[0].kelompok, desa: g.rows[0].desa,
      kegiatan: k.rows[0].nama, tanggal: app.locals.tglID(k.rows[0].tgl), persen,
    });
    const link = app.locals.waLink(g.rows[0].no_hp, pesan);
    if (!link) return res.status(400).send('Nomor HP muda-mudi ini belum diisi.');
    res.redirect(link);
  }, 'Gagal membuka WhatsApp.'));

  // =====================================================
  // NOTIFIKASI (dibuat otomatis dari data yang ada)
  // =====================================================
  async function ambilNotif() {
    const [baru, izin, hariIni] = await Promise.all([
      pool.query(`
        SELECT g.id, g.nama, d.nama AS desa, kl.nama AS kelompok,
          (EXTRACT(EPOCH FROM g.created_at) * 1000)::float8 AS ts
        FROM generus g JOIN kelompok kl ON kl.id = g.kelompok_id JOIN desa d ON d.id = kl.desa_id
        WHERE g.created_at > NOW() - INTERVAL '7 days'
        ORDER BY g.created_at DESC LIMIT 20`),
      pool.query(`
        SELECT g.nama, k.id AS kid, k.nama AS keg, a.alasan,
          (EXTRACT(EPOCH FROM a.waktu) * 1000)::float8 AS ts
        FROM absensi a JOIN generus g ON g.id = a.generus_id JOIN kegiatan k ON k.id = a.kegiatan_id
        WHERE a.status = 'Izin' AND a.oleh = 'peserta' AND a.waktu > NOW() - INTERVAL '7 days'
        ORDER BY a.waktu DESC LIMIT 20`),
      pool.query(`SELECT id, nama, aktif FROM kegiatan
        WHERE tanggal::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date`),
    ]);
    const awalHari = new Date(hariIniISO() + 'T00:00:00+07:00').getTime();
    const items = [];
    baru.rows.forEach(r => items.push({
      ts: r.ts, jenis: 'baru', judul: 'Muda-mudi baru terdaftar',
      teks: `${r.nama} · ${r.desa} › ${r.kelompok}`, href: '/admin/generus/' + r.id }));
    izin.rows.forEach(r => items.push({
      ts: r.ts, jenis: 'izin', judul: 'Izin baru',
      teks: `${r.nama} izin di ${r.keg}${r.alasan ? ': ' + r.alasan : ''}`, href: '/admin/kegiatan/' + r.kid }));
    hariIni.rows.forEach(r => items.push({
      ts: awalHari, jenis: 'hari', judul: 'Kegiatan hari ini',
      teks: r.nama + (r.aktif ? ' · absensi dibuka' : ''), href: '/admin/kegiatan/' + r.id }));
    return items.sort((a, b) => b.ts - a.ts);
  }
  const terakhirDilihat = (req) => Number(req.cookies && req.cookies.notif_seen) || 0;

  app.get('/admin/notif/jumlah', requireAdmin, aman(async (req, res) => {
    const seen = terakhirDilihat(req);
    const list = await ambilNotif();
    res.json({ n: list.filter(x => x.ts > seen).length });
  }, 'Gagal memuat notifikasi.'));

  app.get('/admin/notif', requireAdmin, aman(async (req, res) => {
    const seen = terakhirDilihat(req);
    const list = (await ambilNotif()).map(x => Object.assign({}, x, { baru: x.ts > seen }));
    res.cookie('notif_seen', String(Date.now()), {
      maxAge: 365 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: req.secure });
    res.render('notifikasi', { list, adaBaru: list.some(x => x.baru) });
  }, 'Gagal memuat notifikasi.'));
};