const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const pool = require('./db-postgres');

const app = express();
const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET wajib diisi di mode production.');
  process.exit(1);
}

app.set('trust proxy', 1); // hosting biasanya memakai proxy HTTPS
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
const PgSession = require('connect-pg-simple')(session);

app.use(session({
  store: new PgSession({
    pool: pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'rahasia-lokal-untuk-tes',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8,
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto'
  }
}));

// ---------- Fungsi bantu ----------
function lanIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list)
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) return i.address;
  return null;
}

const baseUrl = (req) => {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  const host = req.get('host');
  if (/^(localhost|127\.0\.0\.1)/.test(host)) {
    const ip = lanIp();
    if (ip) return `${req.protocol}://${ip}:${process.env.PORT || 3000}`;
  }
  return `${req.protocol}://${host}`;
};

const newToken = () => crypto.randomBytes(8).toString('hex');
const requireAdmin = (req, res, next) =>
  req.session.admin ? next() : res.redirect('/admin/login');

// Sasaran kegiatan: jenjang (mis. "1,2") atau pengurus (P, P:daerah, P:desa:5, P:kelompok:7)
function buatTarget(b) {
  if (b.jenis === 'pengurus') {
    if (b.peng === 'daerah') return 'P:daerah';
    if (b.peng === 'desa' && Number(b.peng_desa) > 0) return 'P:desa:' + Number(b.peng_desa);
    if (b.peng === 'kelompok' && Number(b.peng_kel) > 0) return 'P:kelompok:' + Number(b.peng_kel);
    return 'P';
  }
  return [].concat(b.target || []).map(Number).filter(n => n > 0).join(',') || null;
}

function nowWIB() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' })
    .replace(' ', 'T').slice(0, 16);
}

function statusBuka(k) {
  if (!k.aktif) return { buka: false, label: 'Ditutup', pesan: 'Absensi kegiatan ini sudah ditutup.' };
  const now = nowWIB();
  if (k.jam_buka && now < k.jam_buka)
    return { buka: false, label: 'Belum Dibuka', pesan: 'Absensi belum dibuka. Dibuka pukul ' + k.jam_buka.replace('T', ' ') + ' WIB.' };
  if (k.jam_tutup && now > k.jam_tutup)
    return { buka: false, label: 'Ditutup', pesan: 'Waktu absensi sudah berakhir (ditutup otomatis).' };
  return { buka: true, label: 'Dibuka', pesan: '' };
}

app.locals.waLink = (no, teks) => {
  let n = String(no || '').replace(/\D/g, '');
  if (!n) return null;
  if (n.startsWith('0')) n = '62' + n.slice(1);
  else if (n.startsWith('8')) n = '62' + n;
  return 'https://wa.me/' + n + (teks ? '?text=' + encodeURIComponent(teks) : '');
};

const logAktivitas = require('./routes-log')(app, pool, { requireAdmin });  // 1) PALING ATAS

require('./routes-baru')(app, pool, { requireAdmin, statusBuka });
require('./routes-komunikasi')(app, pool, { requireAdmin });
require('./routes-jenjang')(app, pool, { requireAdmin });
require('./routes-perhatian')(app, pool, { requireAdmin });
require('./routes-pengurus')(app, pool, { requireAdmin });
logAktivitas.halaman();   

// ---------- Halaman publik ----------
app.get('/', (req, res) => res.render('index'));

// ---------- Login admin (dibatasi 10 percobaan / 15 menit) ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('login',
    { error: 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.' }),
});

app.get('/admin/login', (req, res) => res.render('login', { error: null }));
app.post('/admin/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    const hasil = await pool.query(
      'SELECT * FROM admin WHERE email = $1',
      [email]
    );

    const a = hasil.rows[0];

    if (a && bcrypt.compareSync(password || '', a.password)) {
      req.session.admin = { id: a.id, email: a.email };
      return res.redirect('/admin');
    }

    res.render('login', { error: 'Email atau password salah.' });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).render('login', {
      error: 'Terjadi kesalahan saat login. Silakan coba lagi.'
    });
  }
});
app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// ---------- Dashboard admin ----------
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const hasilKegiatan = await pool.query(`
      SELECT k.*,
        (SELECT COUNT(*)::int
         FROM absensi a
         WHERE a.kegiatan_id = k.id) AS jumlah
      FROM kegiatan k
      ORDER BY k.id DESC
    `);

    const kegiatan = hasilKegiatan.rows.map(k => ({
      ...k,
      ...statusBuka(k)
    }));

    const hasilGenerus = await pool.query(
      'SELECT COUNT(*)::int AS c FROM mumi_aktif'
    );

    const totalGenerus = hasilGenerus.rows[0].c;

    res.render('admin', {
      kegiatan,
      totalGenerus,
      admin: req.session.admin
    });

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Gagal memuat dashboard.');
  }
});

app.post('/admin/kegiatan', requireAdmin, async (req, res) => {
  try {
    const { nama, tanggal, jam_buka, jam_tutup, batas_telat } = req.body;
        const target = buatTarget(req.body);

    const hasil = await pool.query(
      `INSERT INTO kegiatan
       (nama, tanggal, token, jam_buka, jam_tutup, batas_telat, target_jenjang)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [nama, tanggal, newToken(), jam_buka || null, jam_tutup || null, batas_telat || null, target]
    );
    res.redirect('/admin/kegiatan/' + hasil.rows[0].id);
  } catch (error) {
    console.error('Tambah kegiatan error:', error);
    res.status(500).send('Gagal menambahkan kegiatan.');
  }
});

// ---------- Backup database ----------
app.get('/admin/backup', requireAdmin, (req, res) => {
  res.status(410).send(
    'Fitur backup lokal sudah tidak digunakan. Database sekarang dikelola melalui Supabase.'
  );
});


// ---------- Ganti password & tambah admin ----------

async function halamanPassword(req, res, pesan, ok) {
  try {
    const hasil = await pool.query(
      'SELECT id, email FROM admin ORDER BY id'
    );

    res.render('password', {
      admin: req.session.admin,
      admins: hasil.rows,
      pesan: pesan || null,
      ok: !!ok
    });
  } catch (error) {
    console.error('Halaman password error:', error);
    res.status(500).send('Gagal memuat halaman password.');
  }
}

app.get('/admin/password', requireAdmin, (req, res) =>
  halamanPassword(req, res)
);

app.post('/admin/password', requireAdmin, async (req, res) => {
  try {
    const { lama, baru, ulang } = req.body;

    const hasil = await pool.query(
      'SELECT * FROM admin WHERE id = $1',
      [req.session.admin.id]
    );

    const a = hasil.rows[0];

    if (!a || !bcrypt.compareSync(lama || '', a.password)) {
      return halamanPassword(req, res, 'Password lama salah.');
    }

    if (!baru || baru.length < 8) {
      return halamanPassword(req, res, 'Password baru minimal 8 karakter.');
    }

    if (baru !== ulang) {
      return halamanPassword(req, res, 'Konfirmasi password tidak sama.');
    }

    await pool.query(
      'UPDATE admin SET password = $1 WHERE id = $2',
      [bcrypt.hashSync(baru, 10), a.id]
    );

    return halamanPassword(req, res, 'Password berhasil diganti.', true);
  } catch (error) {
    console.error('Ganti password error:', error);
    res.status(500).send('Gagal mengganti password.');
  }
});

app.post('/admin/admin-baru', requireAdmin, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const pw = req.body.password || '';

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return halamanPassword(req, res, 'Format email tidak valid.');
  }

  if (pw.length < 8) {
    return halamanPassword(req, res, 'Password admin baru minimal 8 karakter.');
  }

  try {
    await pool.query(
      'INSERT INTO admin (email, password) VALUES ($1, $2)',
      [email, bcrypt.hashSync(pw, 10)]
    );

    return halamanPassword(
      req,
      res,
      'Admin baru ditambahkan: ' + email,
      true
    );
  } catch (error) {
    if (error.code === '23505') {
      return halamanPassword(req, res, 'Email itu sudah terdaftar.');
    }

    console.error('Tambah admin error:', error);
    res.status(500).send('Gagal menambahkan admin baru.');
  }
});


 // ---------- Detail kegiatan ----------
app.get('/admin/kegiatan/:id', requireAdmin, async (req, res) => {
  try {
            const hasilKegiatan = await pool.query(`
      SELECT k.*, target_label(k.target_jenjang) AS target_nama
      FROM kegiatan k WHERE k.id = $1`, [req.params.id]);
    const k = hasilKegiatan.rows[0];
    if (!k) return res.redirect('/admin');

    const link = `${baseUrl(req)}/absen/${k.token}`;
    const qr = await QRCode.toDataURL(link, { width: 400, margin: 2 });

    const hasilRekap = await pool.query(`
      SELECT
        g.id AS gid,
        g.nama,
        d.nama AS desa,
        kl.nama AS kelompok,
        g.jenis_kelamin,
        a.status,
        a.terlambat,
        a.alasan,
        a.oleh,
        to_char(a.waktu AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS') AS waktu
      FROM absensi a
      JOIN generus g ON g.id = a.generus_id
      JOIN kelompok kl ON kl.id = g.kelompok_id
      JOIN desa d ON d.id = kl.desa_id
      WHERE a.kegiatan_id = $1
      ORDER BY a.waktu DESC
    `, [k.id]);

    const rekap = hasilRekap.rows;

    const hasilBelum = await pool.query(`
      SELECT
        g.id,
        g.nama,
        g.no_hp,
        d.nama AS desa,
        kl.nama AS kelompok
      FROM mumi_aktif g
      JOIN kelompok kl ON kl.id = g.kelompok_id
      JOIN desa d ON d.id = kl.desa_id
            WHERE NOT EXISTS (
        SELECT 1 FROM absensi a
        WHERE a.kegiatan_id = $1
          AND a.generus_id = g.id
      )
      AND in_sasaran($2::text, g.jenjang_id, g.id)
      ORDER BY d.nama, kl.nama, g.nama
    `, [k.id, k.target_jenjang]);

    const belumList = hasilBelum.rows;

       const hasilTotal = await pool.query(
      'SELECT COUNT(*)::int AS c FROM mumi_aktif g WHERE in_sasaran($1::text, g.jenjang_id, g.id)',
      [k.target_jenjang]
    );
    const total = hasilTotal.rows[0].c;

    const hadir = rekap.filter(r => r.status === 'Hadir').length;

    const stat = {
      total,
      hadir,
      izin: rekap.filter(r => r.status === 'Izin').length,
      telat: rekap.filter(r => r.status === 'Hadir' && r.terlambat).length,
      belum: belumList.length,
      persen: total ? Math.min(100, Math.round(hadir * 100 / total)) : 0,
    };

    const hasilPerDesa = await pool.query(`
      SELECT
        d.nama AS desa,
        COUNT(g.id)::int AS total,
        COALESCE(SUM(CASE WHEN a.status = 'Hadir' THEN 1 ELSE 0 END), 0)::int AS hadir,
        COALESCE(SUM(CASE WHEN a.status = 'Izin' THEN 1 ELSE 0 END), 0)::int AS izin
      FROM desa d
      LEFT JOIN kelompok kl ON kl.desa_id = d.id
      LEFT JOIN mumi_aktif g ON g.kelompok_id = kl.id AND in_sasaran($2::text, g.jenjang_id, g.id)
      LEFT JOIN absensi a
        ON a.generus_id = g.id
        AND a.kegiatan_id = $1
      GROUP BY d.id, d.nama
      ORDER BY d.nama
      `, [k.id, k.target_jenjang]);

    const perDesa = hasilPerDesa.rows;

    const hasilPerKelompok = await pool.query(`
      SELECT
        d.nama AS desa,
        kl.nama AS kelompok,
        COUNT(g.id)::int AS total,
        COALESCE(SUM(CASE WHEN a.status = 'Hadir' THEN 1 ELSE 0 END), 0)::int AS hadir,
        COALESCE(SUM(CASE WHEN a.status = 'Izin' THEN 1 ELSE 0 END), 0)::int AS izin
      FROM kelompok kl
      JOIN desa d ON d.id = kl.desa_id
      LEFT JOIN mumi_aktif g ON g.kelompok_id = kl.id AND in_sasaran($2::text, g.jenjang_id, g.id)
      LEFT JOIN absensi a
        ON a.generus_id = g.id
        AND a.kegiatan_id = $1
      GROUP BY kl.id, d.nama, kl.nama
      ORDER BY d.nama, kl.nama
        `, [k.id, k.target_jenjang]);

    const perKelompok = hasilPerKelompok.rows;
    
        const hasilPerJenjang = await pool.query(`
      SELECT
        COALESCE(j.nama, 'Belum ada data umur') AS jenjang,
        COUNT(g.id)::int AS total,
        COALESCE(SUM(CASE WHEN a.status = 'Hadir' THEN 1 ELSE 0 END), 0)::int AS hadir,
        COALESCE(SUM(CASE WHEN a.status = 'Izin' THEN 1 ELSE 0 END), 0)::int AS izin
            FROM mumi_aktif g
      LEFT JOIN jenjang j ON j.id = g.jenjang_id
      LEFT JOIN absensi a
        ON a.generus_id = g.id
        AND a.kegiatan_id = $1
      WHERE in_sasaran($2::text, g.jenjang_id, g.id)
      GROUP BY j.id, j.nama, j.umur_dari
      ORDER BY j.umur_dari NULLS LAST
    `, [k.id, k.target_jenjang]);

    const perJenjang = hasilPerJenjang.rows;

    res.render('kegiatan', {
      k,
      s: statusBuka(k),
      link,
      qr,
      rekap,
      belumList,
      stat,
      perDesa,
      perKelompok,
      perJenjang
    });
  } catch (error) {
    console.error('Detail kegiatan error:', error);
    res.status(500).send('Gagal memuat detail kegiatan.');
  }
});

app.post('/admin/kegiatan/:id/ganti-qr', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      'UPDATE kegiatan SET token = $1 WHERE id = $2',
      [newToken(), req.params.id]
    );
    res.redirect('/admin/kegiatan/' + req.params.id);
  } catch (error) {
    console.error('Ganti QR error:', error);
    res.status(500).send('Gagal mengganti QR.');
  }
});

app.post('/admin/kegiatan/:id/toggle', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      'UPDATE kegiatan SET aktif = CASE WHEN aktif = 1 THEN 0 ELSE 1 END WHERE id = $1',
      [req.params.id]
    );
    res.redirect('/admin/kegiatan/' + req.params.id);
  } catch (error) {
    console.error('Toggle kegiatan error:', error);
    res.status(500).send('Gagal mengubah status kegiatan.');
  }
});

app.post('/admin/kegiatan/:id/jadwal', requireAdmin, async (req, res) => {
  try {
    const { jam_buka, jam_tutup, batas_telat } = req.body;

    await pool.query(
      `UPDATE kegiatan
       SET jam_buka = $1, jam_tutup = $2, batas_telat = $3
       WHERE id = $4`,
      [
        jam_buka || null,
        jam_tutup || null,
        batas_telat || null,
        req.params.id
      ]
    );

    res.redirect('/admin/kegiatan/' + req.params.id);
  } catch (error) {
    console.error('Jadwal kegiatan error:', error);
    res.status(500).send('Gagal mengubah jadwal kegiatan.');
  }
});



// ---------- Admin menandai manual (dikecualikan dari aturan perangkat) ----------
app.post('/admin/kegiatan/:id/tandai', requireAdmin, async (req, res) => {
  const kid = Number(req.params.id);
  const gid = Number(req.body.generus_id);
  const status = req.body.status;

  try {
    if (['Hadir', 'Izin'].includes(status)) {
      const [cekKegiatan, cekGenerus] = await Promise.all([
        pool.query('SELECT 1 FROM kegiatan WHERE id = $1', [kid]),
        pool.query('SELECT 1 FROM generus WHERE id = $1', [gid])
      ]);

      if (cekKegiatan.rowCount && cekGenerus.rowCount) {
        const alasan = status === 'Izin'
          ? ((req.body.alasan || '').trim().slice(0, 200) || 'Izin via pengurus')
          : null;

        await pool.query(`
          INSERT INTO absensi
            (kegiatan_id, generus_id, status, alasan, terlambat, oleh, device_id)
          VALUES ($1, $2, $3, $4, 0, 'admin', NULL)
          ON CONFLICT (kegiatan_id, generus_id)
          DO UPDATE SET
            status = EXCLUDED.status,
            alasan = EXCLUDED.alasan,
            terlambat = 0,
            oleh = 'admin',
            device_id = NULL,
            waktu = NOW()
        `, [kid, gid, status, alasan]);
      }
    }

    res.redirect('/admin/kegiatan/' + kid + '#belum');
  } catch (error) {
    console.error('Tandai absensi error:', error);
    res.status(500).send('Gagal mencatat absensi.');
  }
});

// Batalkan catatan absen (kembali ke "belum hadir")
app.post('/admin/kegiatan/:id/batal/:gid', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM absensi WHERE kegiatan_id = $1 AND generus_id = $2',
      [req.params.id, req.params.gid]
    );

    res.redirect('/admin/kegiatan/' + req.params.id);
  } catch (error) {
    console.error('Batalkan absensi error:', error);
    res.status(500).send('Gagal membatalkan absensi.');
  }
});

// ---------- Edit & Hapus Kegiatan ----------
app.get('/admin/kegiatan/:id/edit', requireAdmin, async (req, res) => {
  try {
        const [hasil, jen, ds, kls] = await Promise.all([
      pool.query('SELECT * FROM kegiatan WHERE id = $1', [req.params.id]),
      pool.query('SELECT * FROM jenjang ORDER BY umur_dari'),
      pool.query('SELECT * FROM desa ORDER BY nama'),
      pool.query('SELECT * FROM kelompok ORDER BY nama'),
    ]);
    const k = hasil.rows[0];
    if (!k) return res.redirect('/admin');
    res.render('kegiatan_edit', { k, jenjang: jen.rows, desa: ds.rows, kelompok: kls.rows });
  } catch (error) {
    console.error('Edit kegiatan error:', error);
    res.status(500).send('Gagal memuat halaman edit kegiatan.');
  }
});

app.post('/admin/kegiatan/:id/edit', requireAdmin, async (req, res) => {
  try {
    const { nama, tanggal, jam_buka, jam_tutup, batas_telat } = req.body;
       const target = buatTarget(req.body);

    if (nama && nama.trim() && tanggal) {
      await pool.query(`
        UPDATE kegiatan
        SET nama = $1, tanggal = $2, jam_buka = $3,
            jam_tutup = $4, batas_telat = $5, target_jenjang = $6
        WHERE id = $7
      `, [nama.trim(), tanggal, jam_buka || null, jam_tutup || null,
          batas_telat || null, target, req.params.id]);
    }
    res.redirect('/admin/kegiatan/' + req.params.id);
  } catch (error) {
    console.error('Simpan edit kegiatan error:', error);
    res.status(500).send('Gagal menyimpan perubahan kegiatan.');
  }
});

// Hapus kegiatan beserta seluruh catatan absensinya
app.post('/admin/kegiatan/:id/hapus', requireAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      'DELETE FROM absensi WHERE kegiatan_id = $1',
      [req.params.id]
    );

    await client.query(
      'DELETE FROM kegiatan WHERE id = $1',
      [req.params.id]
    );

    await client.query('COMMIT');
    res.redirect('/admin');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Hapus kegiatan error:', error);
    res.status(500).send('Gagal menghapus kegiatan.');
  } finally {
    client.release();
  }
});

// ---------- Export Excel (CSV) ----------
app.get('/admin/kegiatan/:id/export', requireAdmin, async (req, res) => {
  try {
    const hasilKegiatan = await pool.query(
      'SELECT * FROM kegiatan WHERE id = $1',
      [req.params.id]
    );

    const k = hasilKegiatan.rows[0];
    if (!k) return res.redirect('/admin');

    const hasilHadir = await pool.query(`
      SELECT
        g.nama,
        d.nama AS desa,
        kl.nama AS kelompok,
        g.tgl_lahir,
        g.no_hp,
        g.jenis_kelamin,
        a.status,
        a.terlambat,
        a.alasan,
        a.oleh,
        to_char(
          a.waktu AT TIME ZONE 'Asia/Jakarta',
          'YYYY-MM-DD HH24:MI:SS'
        ) AS waktu
      FROM absensi a
      JOIN generus g ON g.id = a.generus_id
      JOIN kelompok kl ON kl.id = g.kelompok_id
      JOIN desa d ON d.id = kl.desa_id
      WHERE a.kegiatan_id = $1
      ORDER BY d.nama, kl.nama, g.nama
    `, [k.id]);

    const hasilBelum = await pool.query(`
      SELECT
        g.nama,
        d.nama AS desa,
        kl.nama AS kelompok,
        g.tgl_lahir,
        g.no_hp,
        g.jenis_kelamin
      FROM mumi_aktif g
      JOIN kelompok kl ON kl.id = g.kelompok_id
      JOIN desa d ON d.id = kl.desa_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM absensi a
        WHERE a.kegiatan_id = $1
          AND a.generus_id = g.id
      )
      AND in_sasaran($2::text, g.jenjang_id, g.id)
      ORDER BY d.nama, kl.nama, g.nama
    `, [k.id, k.target_jenjang]);

    const hadirRows = hasilHadir.rows;
    const belumRows = hasilBelum.rows;

    const safe = (v) => {
      const s = String(v ?? '');
      return /^[=+\-@]/.test(s) ? "'" + s : s;
    };

    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const hp = (v) => v
      ? '="' + String(v).replace(/[^0-9+]/g, '') + '"'
      : '';

    const head = [
      'Nama', 'Desa', 'Kelompok', 'Tanggal Lahir', 'No. HP',
      'Jenis Kelamin', 'Status', 'Terlambat', 'Alasan Izin',
      'Dicatat Oleh', 'Waktu'
    ];

    const lines = [head.map(q).join(';')];

    hadirRows.forEach(r => lines.push([
      q(safe(r.nama)),
      q(safe(r.desa)),
      q(safe(r.kelompok)),
      q(safe(r.tgl_lahir)),
      q(hp(r.no_hp)),
      q(safe(r.jenis_kelamin)),
      q(r.status),
      q(r.terlambat ? 'Ya' : ''),
      q(safe(r.alasan)),
      q(r.oleh === 'admin' ? 'Pengurus' : 'Peserta'),
      q(r.waktu)
    ].join(';')));

    belumRows.forEach(r => lines.push([
      q(safe(r.nama)),
      q(safe(r.desa)),
      q(safe(r.kelompok)),
      q(safe(r.tgl_lahir)),
      q(hp(r.no_hp)),
      q(safe(r.jenis_kelamin)),
      q('Belum Hadir'),
      q(''),
      q(''),
      q(''),
      q('')
    ].join(';')));

    const file = 'rekap-' +
      k.nama.replace(/[^a-z0-9]+/gi, '-') +
      '-' + k.tanggal + '.csv';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file}"`
    );

    res.send('\uFEFFsep=;\n' + lines.join('\n'));
  } catch (error) {
    console.error('Export CSV error:', error);
    res.status(500).send('Gagal mengekspor data absensi.');
  }
});



// ---------- Daftar Generus ----------
app.get('/admin/generus', requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const desaId = Number(req.query.desa_id) || 0;

    const hasilDesa = await pool.query(
      'SELECT * FROM desa ORDER BY nama'
    );
    const desa = hasilDesa.rows;

    const hasilRows = await pool.query(`
      SELECT
        g.*,
        d.nama AS desa,
        kl.nama AS kelompok,
        (SELECT COUNT(*)::int
         FROM absensi a
         WHERE a.generus_id = g.id AND a.status = 'Hadir') AS hadir,
        (SELECT COUNT(*)::int
         FROM absensi a
         WHERE a.generus_id = g.id AND a.status = 'Izin') AS izin,
        (SELECT COUNT(*)::int
         FROM kegiatan k
         WHERE k.tanggal::date >= g.created_at::date
            OR k.id IN (
              SELECT kegiatan_id
              FROM absensi
              WHERE generus_id = g.id
            )) AS total
      FROM mumi_aktif g
      JOIN kelompok kl ON kl.id = g.kelompok_id
      JOIN desa d ON d.id = kl.desa_id
      WHERE ($1 = '' OR g.nama ILIKE $2)
        AND ($3 = 0 OR d.id = $3)
      ORDER BY d.nama, kl.nama, g.nama
      LIMIT 500
    `, [q, `%${q}%`, desaId]);

    res.render('generus', {
      rows: hasilRows.rows,
      desa,
      q,
      desaId
    });
  } catch (error) {
    console.error('Daftar generus error:', error);
    res.status(500).send('Gagal memuat daftar generus.');
  }
});

app.get('/admin/generus/:id', requireAdmin, async (req, res) => {
  try {
    const hasilGenerus = await pool.query(`
      SELECT
        g.*,
        d.nama AS desa,
        kl.nama AS kelompok
      FROM generus g
      JOIN kelompok kl ON kl.id = g.kelompok_id
      JOIN desa d ON d.id = kl.desa_id
      WHERE g.id = $1
    `, [req.params.id]);

    const g = hasilGenerus.rows[0];
    if (!g) return res.redirect('/admin/generus');

        const hasilRiwayat = await pool.query(`
      SELECT
        k.id,
        k.nama,
        to_char(k.tanggal::date, 'YYYY-MM-DD') AS tanggal,
        a.status,
        a.terlambat,
        a.alasan
      FROM kegiatan k
      LEFT JOIN absensi a
        ON a.kegiatan_id = k.id
        AND a.generus_id = $1
      WHERE k.tanggal::date >= $2::date
         OR a.id IS NOT NULL
      ORDER BY k.tanggal::date DESC, k.id DESC
    `, [g.id, g.created_at]);

    const riwayat = hasilRiwayat.rows;
    const total = riwayat.length;
    const hadir = riwayat.filter(r => r.status === 'Hadir').length;
    const izin = riwayat.filter(r => r.status === 'Izin').length;

    const stat = {
      total,
      hadir,
      izin,
      telat: riwayat.filter(r => r.status === 'Hadir' && r.terlambat).length,
      alpa: total - hadir - izin,
      persen: total ? Math.round(hadir * 100 / total) : 0,
    };

    res.render('generus_detail', { g, riwayat, stat });
  } catch (error) {
    console.error('Detail generus error:', error);
    res.status(500).send('Gagal memuat detail generus.');
  }
});

app.get('/admin/generus/:id/edit', requireAdmin, async (req, res) => {
  try {
    const hasilGenerus = await pool.query(`
      SELECT g.*, kl.desa_id
      FROM generus g
      JOIN kelompok kl ON kl.id = g.kelompok_id
      WHERE g.id = $1
    `, [req.params.id]);

    const g = hasilGenerus.rows[0];
    if (!g) return res.redirect('/admin/generus');

    const [hasilDesa, hasilKelompok, hasilJenjang] = await Promise.all([
      pool.query('SELECT * FROM desa ORDER BY nama'),
      pool.query('SELECT * FROM kelompok ORDER BY nama'),
      pool.query('SELECT * FROM jenjang ORDER BY umur_dari'),
    ]);

    res.render('generus_edit', {
      g,
      desa: hasilDesa.rows,
      kelompok: hasilKelompok.rows,
      jenjang: hasilJenjang.rows
    });
  } catch (error) {
    console.error('Halaman edit generus error:', error);
    res.status(500).send('Gagal memuat halaman edit generus.');
  }
});

app.post('/admin/generus/:id/edit', requireAdmin, async (req, res) => {
  try {
    const { nama, kelompok_id, tgl_lahir, no_hp, jenis_kelamin } = req.body;
    const jm = Number(req.body.jenjang_manual) || null;

    if (nama && nama.trim() && kelompok_id) {
      await pool.query(`
        UPDATE generus
        SET nama = $1, kelompok_id = $2, tgl_lahir = $3,
            no_hp = $4, jenis_kelamin = $5, jenjang_manual = $6
        WHERE id = $7
      `, [
        nama.trim(), kelompok_id, tgl_lahir || null,
        no_hp || null, jenis_kelamin || null, jm, req.params.id
      ]);
    }

    res.redirect('/admin/generus');
  } catch (error) {
    console.error('Edit generus error:', error);
    res.status(500).send('Gagal menyimpan perubahan generus.');
  }
});

app.post('/admin/generus/:id/hapus', requireAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      'DELETE FROM absensi WHERE generus_id = $1',
      [req.params.id]
    );

    await client.query(
      'DELETE FROM generus WHERE id = $1',
      [req.params.id]
    );

    await client.query('COMMIT');
    res.redirect('/admin/generus');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Hapus generus error:', error);
    res.status(500).send('Gagal menghapus generus.');
  } finally {
    client.release();
  }
});


// ---------- Kelola Desa & Kelompok ----------
app.get('/admin/wilayah', requireAdmin, async (req, res) => {
  try {
    const [hasilDesa, hasilKelompok] = await Promise.all([
      pool.query('SELECT * FROM desa ORDER BY nama'),
      pool.query('SELECT * FROM kelompok ORDER BY nama')
    ]);

    res.render('wilayah', {
      desa: hasilDesa.rows,
      kelompok: hasilKelompok.rows
    });
  } catch (error) {
    console.error('Halaman wilayah error:', error);
    res.status(500).send('Gagal memuat data wilayah.');
  }
});

app.post('/admin/desa', requireAdmin, async (req, res) => {
  try {
    const nama = (req.body.nama || '').trim();

    if (nama) {
      await pool.query(
        'INSERT INTO desa (nama) VALUES ($1) ON CONFLICT (nama) DO NOTHING',
        [nama]
      );
    }

    res.redirect('/admin/wilayah');
  } catch (error) {
    console.error('Tambah desa error:', error);
    res.status(500).send('Gagal menambahkan desa.');
  }
});

app.post('/admin/kelompok', requireAdmin, async (req, res) => {
  const desaId = Number(req.body.desa_id);
  const list = (req.body.nama || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  const client = await pool.connect();

  try {
    if (desaId) {
      await client.query('BEGIN');

      for (const nama of list) {
        await client.query(`
          INSERT INTO kelompok (desa_id, nama)
          SELECT $1, $2
          WHERE NOT EXISTS (
            SELECT 1
            FROM kelompok
            WHERE desa_id = $1
              AND LOWER(nama) = LOWER($2)
          )
        `, [desaId, nama]);
      }

      await client.query('COMMIT');
    }

    res.redirect('/admin/wilayah');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Tambah kelompok error:', error);
    res.status(500).send('Gagal menambahkan kelompok.');
  } finally {
    client.release();
  }
});

app.post('/admin/kelompok/:id/hapus', requireAdmin, async (req, res) => {
  try {
    const dipakai = await pool.query(
      'SELECT 1 FROM generus WHERE kelompok_id = $1 LIMIT 1',
      [req.params.id]
    );

    if (dipakai.rowCount === 0) {
      await pool.query(
        'DELETE FROM kelompok WHERE id = $1',
        [req.params.id]
      );
    }

    res.redirect('/admin/wilayah');
  } catch (error) {
    console.error('Hapus kelompok error:', error);
    res.status(500).send('Gagal menghapus kelompok.');
  }
});

app.post('/admin/desa/:id/hapus', requireAdmin, async (req, res) => {
  try {
    const dipakai = await pool.query(
      'SELECT 1 FROM kelompok WHERE desa_id = $1 LIMIT 1',
      [req.params.id]
    );

    if (dipakai.rowCount === 0) {
      await pool.query(
        'DELETE FROM desa WHERE id = $1',
        [req.params.id]
      );
    }

    res.redirect('/admin/wilayah');
  } catch (error) {
    console.error('Hapus desa error:', error);
    res.status(500).send('Gagal menghapus desa.');
  }
});



// ---------- Absensi peserta (lewat QR) ----------

const getKegiatan = async (token) => {
  const hasil = await pool.query(
    'SELECT * FROM kegiatan WHERE token = $1',
    [token]
  );
  return hasil.rows[0];
};

app.get('/absen/:token', async (req, res) => {
  try {
    const k = await getKegiatan(req.params.token);

    if (!k) {
      return res.status(404).render('selesai', {
        pesan: 'QR tidak valid atau sudah diganti.',
        ok: false
      });
    }

    const s = statusBuka(k);
    if (!s.buka) {
      return res.render('selesai', { pesan: s.pesan, ok: false });
    }

    // Penanda perangkat (dibuat sekali, berlaku 1 tahun)
    if (!req.cookies.did) {
      res.cookie('did', crypto.randomBytes(16).toString('hex'), {
        maxAge: 365 * 24 * 3600 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure
      });
    }

    const [hasilDesa, hasilKelompok] = await Promise.all([
      pool.query('SELECT * FROM desa ORDER BY nama'),
      pool.query('SELECT * FROM kelompok ORDER BY nama')
    ]);

    res.render('absen', {
      k,
      desa: hasilDesa.rows,
      kelompok: hasilKelompok.rows
    });
  } catch (error) {
    console.error('Halaman absensi error:', error);
    res.status(500).send('Gagal memuat halaman absensi.');
  }
});

app.get('/api/cari', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();

    if (q.length < 2) return res.json([]);

    const hasil = await pool.query(`
      SELECT
        g.id,
        g.nama,
        d.nama AS desa,
        kl.nama AS kelompok
      FROM mumi_aktif g
      JOIN kelompok kl ON kl.id = g.kelompok_id
      JOIN desa d ON d.id = kl.desa_id
      WHERE g.nama ILIKE $1
      ORDER BY g.nama
      LIMIT 15
    `, [`%${q}%`]);

    res.json(hasil.rows);
  } catch (error) {
    console.error('Pencarian generus error:', error);
    res.status(500).json({ error: 'Gagal mencari generus.' });
  }
});

app.post('/absen/:token', async (req, res) => {
  const gagal = (pesan) =>
    res.render('selesai', { pesan, ok: false });

  const client = await pool.connect();

  try {
    const hasilKegiatan = await client.query(
      'SELECT * FROM kegiatan WHERE token = $1',
      [req.params.token]
    );

    const k = hasilKegiatan.rows[0];

    if (!k) {
      return gagal('QR tidak valid atau sudah diganti.');
    }

    const s = statusBuka(k);
    if (!s.buka) {
      return gagal(s.pesan);
    }

    const did = req.cookies.did;

    if (!did) {
      return gagal('Browser menolak cookie. Aktifkan cookie lalu scan ulang QR.');
    }

    const { mode, status } = req.body;

    if (!['Hadir', 'Izin'].includes(status)) {
      return gagal('Status kehadiran belum dipilih.');
    }

    const alasan = status === 'Izin'
      ? (req.body.alasan || '').trim().slice(0, 200)
      : null;

    if (status === 'Izin' && !alasan) {
      return gagal('Alasan izin wajib diisi.');
    }

    await client.query('BEGIN');

    // Perangkat ini sudah dipakai absen di kegiatan ini?
    const hasilPakai = await client.query(`
      SELECT generus_id
      FROM absensi
      WHERE kegiatan_id = $1 AND device_id = $2
      FOR UPDATE
    `, [k.id, did]);

    const pakai = hasilPakai.rows[0];

    let generusId;

    if (mode === 'lama') {
      generusId = Number(req.body.generus_id);

      const cekGenerus = await client.query(
        'SELECT 1 FROM generus WHERE id = $1',
        [generusId]
      );

      if (!cekGenerus.rowCount) {
        await client.query('ROLLBACK');
        return gagal('Nama belum dipilih dari daftar.');
      }
    } else {
      if (pakai) {
        await client.query('ROLLBACK');
        return gagal('Perangkat ini sudah dipakai absen di kegiatan ini. Untuk mengubah status, gunakan tab "Sudah Terdaftar".');
      }

      const {
        nama,
        kelompok_id,
        tgl_lahir,
        no_hp,
        jenis_kelamin
      } = req.body;

      if (!nama || !kelompok_id) {
        await client.query('ROLLBACK');
        return gagal('Nama dan kelompok wajib diisi.');
      }

      const namaBersih = nama.trim();

      const hasilAda = await client.query(`
        SELECT id
        FROM generus
        WHERE LOWER(nama) = LOWER($1)
          AND tgl_lahir IS NOT DISTINCT FROM $2
        LIMIT 1
      `, [namaBersih, tgl_lahir || null]);

      if (hasilAda.rowCount) {
        generusId = hasilAda.rows[0].id;
      } else {
        const hasilBaru = await client.query(`
          INSERT INTO generus
            (nama, kelompok_id, tgl_lahir, no_hp, jenis_kelamin)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id
        `, [
          namaBersih,
          kelompok_id,
          tgl_lahir || null,
          no_hp || null,
          jenis_kelamin || null
        ]);

        generusId = hasilBaru.rows[0].id;
      }
    }

    // Satu perangkat = satu nama
    if (pakai && String(pakai.generus_id) !== String(generusId)) {
      await client.query('ROLLBACK');
      return gagal('Perangkat ini sudah dipakai absen atas nama lain. Satu perangkat hanya untuk satu nama. Hubungi pengurus jika ada kendala.');
    }

    const hasilSudah = await client.query(`
      SELECT status, device_id, oleh
      FROM absensi
      WHERE kegiatan_id = $1 AND generus_id = $2
      FOR UPDATE
    `, [k.id, generusId]);

    const sudah = hasilSudah.rows[0];

    if (sudah) {
      if (sudah.oleh === 'admin') {
        await client.query('ROLLBACK');
        return gagal('Kehadiranmu sudah dicatat oleh pengurus.');
      }

      if (sudah.device_id && sudah.device_id !== did) {
        await client.query('ROLLBACK');
        return gagal('Nama ini sudah absen dari perangkat lain. Hubungi pengurus jika itu bukan kamu.');
      }

      if (sudah.status === status) {
        await client.query('ROLLBACK');
        return res.render('selesai', {
          pesan: `Kamu sudah tercatat ${status}.`,
          ok: true
        });
      }
    }

    const telat = (
      status === 'Hadir' &&
      k.batas_telat &&
      nowWIB() > k.batas_telat
    ) ? 1 : 0;

    await client.query(`
      INSERT INTO absensi
        (kegiatan_id, generus_id, status, alasan, terlambat, device_id, oleh)
      VALUES ($1, $2, $3, $4, $5, $6, 'peserta')
      ON CONFLICT (kegiatan_id, generus_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        alasan = EXCLUDED.alasan,
        terlambat = EXCLUDED.terlambat,
        device_id = EXCLUDED.device_id,
        oleh = 'peserta',
        waktu = NOW()
    `, [k.id, generusId, status, alasan, telat, did]);

    await client.query('COMMIT');

    res.render('selesai', {
      pesan: `Absensi tercatat: ${status}${telat ? ' (Terlambat)' : ''}.`,
      ok: true
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback absensi error:', rollbackError);
    }

    console.error('Proses absensi error:', error);
    res.status(500).send('Terjadi kesalahan saat mencatat absensi.');
  } finally {
    client.release();
  }
});

// ---------- Jalankan server ----------
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('SIGJ jalan di http://localhost:' + PORT);

    const ip = lanIp();
    if (ip) {
      console.log('Dari HP (WiFi sama): http://' + ip + ':' + PORT);
    }
  });
}

module.exports = app;