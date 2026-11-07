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
const db = require('./db');

const app = express();
const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET wajib diisi di mode production.');
  process.exit(1);
}

app.set('trust proxy', 1); // hosting biasanya memakai proxy HTTPS
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'rahasia-lokal-untuk-tes',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8, httpOnly: true, sameSite: 'lax', secure: 'auto' },
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

// ---------- Halaman publik ----------
app.get('/', (req, res) => res.render('index'));

// ---------- Login admin (dibatasi 10 percobaan / 15 menit) ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('login',
    { error: 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.' }),
});

app.get('/admin/login', (req, res) => res.render('login', { error: null }));
app.post('/admin/login', loginLimiter, (req, res) => {
  const { email, password } = req.body;
  const a = db.prepare('SELECT * FROM admin WHERE email = ?').get(email);
  if (a && bcrypt.compareSync(password || '', a.password)) {
    req.session.admin = { id: a.id, email: a.email };
    return res.redirect('/admin');
  }
  res.render('login', { error: 'Email atau password salah.' });
});
app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// ---------- Dashboard admin ----------
app.get('/admin', requireAdmin, (req, res) => {
  const kegiatan = db.prepare(`
    SELECT k.*, (SELECT COUNT(*) FROM absensi a WHERE a.kegiatan_id = k.id) AS jumlah
    FROM kegiatan k ORDER BY k.id DESC`).all()
    .map(k => ({ ...k, ...statusBuka(k) }));
  const totalGenerus = db.prepare('SELECT COUNT(*) c FROM generus').get().c;
  res.render('admin', { kegiatan, totalGenerus, admin: req.session.admin });
});

app.post('/admin/kegiatan', requireAdmin, (req, res) => {
  const { nama, tanggal, jam_buka, jam_tutup, batas_telat } = req.body;
  const r = db.prepare(`INSERT INTO kegiatan (nama, tanggal, token, jam_buka, jam_tutup, batas_telat)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(nama, tanggal, newToken(), jam_buka || null, jam_tutup || null, batas_telat || null);
  res.redirect('/admin/kegiatan/' + r.lastInsertRowid);
});

// ---------- Backup database ----------
app.get('/admin/backup', requireAdmin, async (req, res) => {
  const tmp = path.join(os.tmpdir(), 'sigj-backup-' + Date.now() + '.db');
  try {
    await db.backup(tmp);
    res.download(tmp, 'sigj-backup-' + nowWIB().slice(0, 10) + '.db',
      () => fs.unlink(tmp, () => {}));
  } catch (e) {
    console.error(e);
    res.status(500).send('Backup gagal.');
  }
});

// ---------- Ganti password & tambah admin ----------
function halamanPassword(req, res, pesan, ok) {
  const admins = db.prepare('SELECT id, email FROM admin ORDER BY id').all();
  res.render('password', { admin: req.session.admin, admins, pesan: pesan || null, ok: !!ok });
}
app.get('/admin/password', requireAdmin, (req, res) => halamanPassword(req, res));

app.post('/admin/password', requireAdmin, (req, res) => {
  const { lama, baru, ulang } = req.body;
  const a = db.prepare('SELECT * FROM admin WHERE id = ?').get(req.session.admin.id);
  if (!a || !bcrypt.compareSync(lama || '', a.password))
    return halamanPassword(req, res, 'Password lama salah.');
  if (!baru || baru.length < 8)
    return halamanPassword(req, res, 'Password baru minimal 8 karakter.');
  if (baru !== ulang)
    return halamanPassword(req, res, 'Konfirmasi password tidak sama.');
  db.prepare('UPDATE admin SET password = ? WHERE id = ?').run(bcrypt.hashSync(baru, 10), a.id);
  halamanPassword(req, res, 'Password berhasil diganti.', true);
});

app.post('/admin/admin-baru', requireAdmin, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const pw = req.body.password || '';
  if (!/^\S+@\S+\.\S+$/.test(email)) return halamanPassword(req, res, 'Format email tidak valid.');
  if (pw.length < 8) return halamanPassword(req, res, 'Password admin baru minimal 8 karakter.');
  try {
    db.prepare('INSERT INTO admin (email, password) VALUES (?, ?)').run(email, bcrypt.hashSync(pw, 10));
  } catch (e) {
    return halamanPassword(req, res, 'Email itu sudah terdaftar.');
  }
  halamanPassword(req, res, 'Admin baru ditambahkan: ' + email, true);
});

// ---------- Detail kegiatan ----------
app.get('/admin/kegiatan/:id', requireAdmin, async (req, res) => {
  const k = db.prepare('SELECT * FROM kegiatan WHERE id = ?').get(req.params.id);
  if (!k) return res.redirect('/admin');
  const link = `${baseUrl(req)}/absen/${k.token}`;
  const qr = await QRCode.toDataURL(link, { width: 400, margin: 2 });

  const rekap = db.prepare(`
    SELECT g.id AS gid, g.nama, d.nama AS desa, kl.nama AS kelompok, g.jenis_kelamin,
           a.status, a.terlambat, a.alasan, a.oleh, datetime(a.waktu, '+7 hours') AS waktu
    FROM absensi a
    JOIN generus g ON g.id = a.generus_id
    JOIN kelompok kl ON kl.id = g.kelompok_id
    JOIN desa d ON d.id = kl.desa_id
    WHERE a.kegiatan_id = ? ORDER BY a.waktu DESC`).all(k.id);

  const belumList = db.prepare(`
    SELECT g.id, g.nama, g.no_hp, d.nama AS desa, kl.nama AS kelompok
    FROM generus g
    JOIN kelompok kl ON kl.id = g.kelompok_id
    JOIN desa d ON d.id = kl.desa_id
    WHERE g.id NOT IN (SELECT generus_id FROM absensi WHERE kegiatan_id = ?)
    ORDER BY d.nama, kl.nama, g.nama`).all(k.id);

  const total = db.prepare('SELECT COUNT(*) c FROM generus').get().c;
  const hadir = rekap.filter(r => r.status === 'Hadir').length;
  const stat = {
    total, hadir,
    izin: rekap.filter(r => r.status === 'Izin').length,
    telat: rekap.filter(r => r.status === 'Hadir' && r.terlambat).length,
    belum: belumList.length,
    persen: total ? Math.round(hadir * 100 / total) : 0,
  };

  const perDesa = db.prepare(`
    SELECT d.nama AS desa,
      COUNT(g.id) AS total,
      COALESCE(SUM(CASE WHEN a.status = 'Hadir' THEN 1 ELSE 0 END), 0) AS hadir,
      COALESCE(SUM(CASE WHEN a.status = 'Izin' THEN 1 ELSE 0 END), 0) AS izin
    FROM desa d
    LEFT JOIN kelompok kl ON kl.desa_id = d.id
    LEFT JOIN generus g ON g.kelompok_id = kl.id
    LEFT JOIN absensi a ON a.generus_id = g.id AND a.kegiatan_id = ?
    GROUP BY d.id ORDER BY d.nama`).all(k.id);

  const perKelompok = db.prepare(`
    SELECT d.nama AS desa, kl.nama AS kelompok,
      COUNT(g.id) AS total,
      COALESCE(SUM(CASE WHEN a.status = 'Hadir' THEN 1 ELSE 0 END), 0) AS hadir,
      COALESCE(SUM(CASE WHEN a.status = 'Izin' THEN 1 ELSE 0 END), 0) AS izin
    FROM kelompok kl
    JOIN desa d ON d.id = kl.desa_id
    LEFT JOIN generus g ON g.kelompok_id = kl.id
    LEFT JOIN absensi a ON a.generus_id = g.id AND a.kegiatan_id = ?
    GROUP BY kl.id ORDER BY d.nama, kl.nama`).all(k.id);

  res.render('kegiatan', { k, s: statusBuka(k), link, qr, rekap, belumList, stat, perDesa, perKelompok });
});

app.post('/admin/kegiatan/:id/ganti-qr', requireAdmin, (req, res) => {
  db.prepare('UPDATE kegiatan SET token = ? WHERE id = ?').run(newToken(), req.params.id);
  res.redirect('/admin/kegiatan/' + req.params.id);
});

app.post('/admin/kegiatan/:id/toggle', requireAdmin, (req, res) => {
  db.prepare('UPDATE kegiatan SET aktif = 1 - aktif WHERE id = ?').run(req.params.id);
  res.redirect('/admin/kegiatan/' + req.params.id);
});

app.post('/admin/kegiatan/:id/jadwal', requireAdmin, (req, res) => {
  const { jam_buka, jam_tutup, batas_telat } = req.body;
  db.prepare('UPDATE kegiatan SET jam_buka = ?, jam_tutup = ?, batas_telat = ? WHERE id = ?')
    .run(jam_buka || null, jam_tutup || null, batas_telat || null, req.params.id);
  res.redirect('/admin/kegiatan/' + req.params.id);
});

// ---------- Admin menandai manual (dikecualikan dari aturan perangkat) ----------
app.post('/admin/kegiatan/:id/tandai', requireAdmin, (req, res) => {
  const kid = Number(req.params.id);
  const gid = Number(req.body.generus_id);
  const status = req.body.status;
  if (['Hadir', 'Izin'].includes(status) &&
      db.prepare('SELECT 1 FROM kegiatan WHERE id = ?').get(kid) &&
      db.prepare('SELECT 1 FROM generus WHERE id = ?').get(gid)) {
    const alasan = status === 'Izin'
      ? ((req.body.alasan || '').trim().slice(0, 200) || 'Izin via pengurus') : null;
    db.prepare(`
      INSERT INTO absensi (kegiatan_id, generus_id, status, alasan, terlambat, oleh, device_id)
      VALUES (?, ?, ?, ?, 0, 'admin', NULL)
      ON CONFLICT(kegiatan_id, generus_id) DO UPDATE SET
        status = excluded.status, alasan = excluded.alasan, terlambat = 0,
        oleh = 'admin', device_id = NULL, waktu = CURRENT_TIMESTAMP
    `).run(kid, gid, status, alasan);
  }
  res.redirect('/admin/kegiatan/' + kid + '#belum');
});

// Batalkan catatan absen (kembali ke "belum hadir")
app.post('/admin/kegiatan/:id/batal/:gid', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM absensi WHERE kegiatan_id = ? AND generus_id = ?')
    .run(req.params.id, req.params.gid);
  res.redirect('/admin/kegiatan/' + req.params.id);
});

// ---------- Edit & Hapus Kegiatan ----------
app.get('/admin/kegiatan/:id/edit', requireAdmin, (req, res) => {
  const k = db.prepare('SELECT * FROM kegiatan WHERE id = ?').get(req.params.id);
  if (!k) return res.redirect('/admin');
  res.render('kegiatan_edit', { k });
});

app.post('/admin/kegiatan/:id/edit', requireAdmin, (req, res) => {
  const { nama, tanggal, jam_buka, jam_tutup, batas_telat } = req.body;
  if (nama && nama.trim() && tanggal) {
    db.prepare(`UPDATE kegiatan SET nama = ?, tanggal = ?, jam_buka = ?, jam_tutup = ?, batas_telat = ?
      WHERE id = ?`)
      .run(nama.trim(), tanggal, jam_buka || null, jam_tutup || null, batas_telat || null, req.params.id);
  }
  res.redirect('/admin/kegiatan/' + req.params.id);
});

// Hapus kegiatan beserta seluruh catatan absensinya (data generus tidak ikut terhapus)
app.post('/admin/kegiatan/:id/hapus', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.transaction(() => {
    db.prepare('DELETE FROM absensi WHERE kegiatan_id = ?').run(id);
    db.prepare('DELETE FROM kegiatan WHERE id = ?').run(id);
  })();
  res.redirect('/admin');
});

// ---------- Export Excel (CSV) ----------
app.get('/admin/kegiatan/:id/export', requireAdmin, (req, res) => {
  const k = db.prepare('SELECT * FROM kegiatan WHERE id = ?').get(req.params.id);
  if (!k) return res.redirect('/admin');

  const hadirRows = db.prepare(`
    SELECT g.nama, d.nama AS desa, kl.nama AS kelompok, g.tgl_lahir, g.no_hp, g.jenis_kelamin,
           a.status, a.terlambat, a.alasan, a.oleh, datetime(a.waktu, '+7 hours') AS waktu
    FROM absensi a
    JOIN generus g ON g.id = a.generus_id
    JOIN kelompok kl ON kl.id = g.kelompok_id
    JOIN desa d ON d.id = kl.desa_id
    WHERE a.kegiatan_id = ? ORDER BY d.nama, kl.nama, g.nama`).all(k.id);

  const belumRows = db.prepare(`
    SELECT g.nama, d.nama AS desa, kl.nama AS kelompok, g.tgl_lahir, g.no_hp, g.jenis_kelamin
    FROM generus g
    JOIN kelompok kl ON kl.id = g.kelompok_id
    JOIN desa d ON d.id = kl.desa_id
    WHERE g.id NOT IN (SELECT generus_id FROM absensi WHERE kegiatan_id = ?)
    ORDER BY d.nama, kl.nama, g.nama`).all(k.id);

  const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? "'" + s : s; };
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const hp = (v) => v ? '="' + String(v).replace(/[^0-9+]/g, '') + '"' : '';

  const head = ['Nama', 'Desa', 'Kelompok', 'Tanggal Lahir', 'No. HP', 'Jenis Kelamin',
    'Status', 'Terlambat', 'Alasan Izin', 'Dicatat Oleh', 'Waktu'];
  const lines = [head.map(q).join(';')];
  hadirRows.forEach(r => lines.push([
    q(safe(r.nama)), q(safe(r.desa)), q(safe(r.kelompok)), q(safe(r.tgl_lahir)), q(hp(r.no_hp)),
    q(safe(r.jenis_kelamin)), q(r.status), q(r.terlambat ? 'Ya' : ''), q(safe(r.alasan)),
    q(r.oleh === 'admin' ? 'Pengurus' : 'Peserta'), q(r.waktu)
  ].join(';')));
  belumRows.forEach(r => lines.push([
    q(safe(r.nama)), q(safe(r.desa)), q(safe(r.kelompok)), q(safe(r.tgl_lahir)), q(hp(r.no_hp)),
    q(safe(r.jenis_kelamin)), q('Belum Hadir'), q(''), q(''), q(''), q('')
  ].join(';')));

  const file = 'rekap-' + k.nama.replace(/[^a-z0-9]+/gi, '-') + '-' + k.tanggal + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.send('\uFEFFsep=;\n' + lines.join('\n'));
});

// ---------- Daftar Generus ----------
app.get('/admin/generus', requireAdmin, (req, res) => {
  const q = (req.query.q || '').trim();
  const desaId = Number(req.query.desa_id) || 0;
  const desa = db.prepare('SELECT * FROM desa ORDER BY nama').all();
  const rows = db.prepare(`
    SELECT g.*, d.nama AS desa, kl.nama AS kelompok,
      (SELECT COUNT(*) FROM absensi a WHERE a.generus_id = g.id AND a.status = 'Hadir') AS hadir,
      (SELECT COUNT(*) FROM absensi a WHERE a.generus_id = g.id AND a.status = 'Izin') AS izin,
      (SELECT COUNT(*) FROM kegiatan k WHERE k.tanggal >= date(g.created_at)
         OR k.id IN (SELECT kegiatan_id FROM absensi WHERE generus_id = g.id)) AS total
    FROM generus g
    JOIN kelompok kl ON kl.id = g.kelompok_id
    JOIN desa d ON d.id = kl.desa_id
    WHERE (? = '' OR g.nama LIKE ?) AND (? = 0 OR d.id = ?)
    ORDER BY d.nama, kl.nama, g.nama LIMIT 500`).all(q, `%${q}%`, desaId, desaId);
  res.render('generus', { rows, desa, q, desaId });
});

app.get('/admin/generus/:id', requireAdmin, (req, res) => {
  const g = db.prepare(`
    SELECT g.*, d.nama AS desa, kl.nama AS kelompok
    FROM generus g JOIN kelompok kl ON kl.id = g.kelompok_id JOIN desa d ON d.id = kl.desa_id
    WHERE g.id = ?`).get(req.params.id);
  if (!g) return res.redirect('/admin/generus');
  const riwayat = db.prepare(`
    SELECT k.id, k.nama, k.tanggal, a.status, a.terlambat, a.alasan
    FROM kegiatan k
    LEFT JOIN absensi a ON a.kegiatan_id = k.id AND a.generus_id = ?
    WHERE k.tanggal >= date(?) OR a.id IS NOT NULL
    ORDER BY k.tanggal DESC, k.id DESC`).all(g.id, g.created_at);
  const total = riwayat.length;
  const hadir = riwayat.filter(r => r.status === 'Hadir').length;
  const izin = riwayat.filter(r => r.status === 'Izin').length;
  const stat = {
    total, hadir, izin,
    telat: riwayat.filter(r => r.status === 'Hadir' && r.terlambat).length,
    alpa: total - hadir - izin,
    persen: total ? Math.round(hadir * 100 / total) : 0,
  };
  res.render('generus_detail', { g, riwayat, stat });
});

app.get('/admin/generus/:id/edit', requireAdmin, (req, res) => {
  const g = db.prepare(`
    SELECT g.*, kl.desa_id FROM generus g JOIN kelompok kl ON kl.id = g.kelompok_id
    WHERE g.id = ?`).get(req.params.id);
  if (!g) return res.redirect('/admin/generus');
  const desa = db.prepare('SELECT * FROM desa ORDER BY nama').all();
  const kelompok = db.prepare('SELECT * FROM kelompok ORDER BY nama').all();
  res.render('generus_edit', { g, desa, kelompok });
});

app.post('/admin/generus/:id/edit', requireAdmin, (req, res) => {
  const { nama, kelompok_id, tgl_lahir, no_hp, jenis_kelamin } = req.body;
  if (nama && kelompok_id)
    db.prepare(`UPDATE generus SET nama = ?, kelompok_id = ?, tgl_lahir = ?, no_hp = ?, jenis_kelamin = ?
      WHERE id = ?`).run(nama.trim(), kelompok_id, tgl_lahir, no_hp, jenis_kelamin, req.params.id);
  res.redirect('/admin/generus');
});

app.post('/admin/generus/:id/hapus', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.transaction(() => {
    db.prepare('DELETE FROM absensi WHERE generus_id = ?').run(id);
    db.prepare('DELETE FROM generus WHERE id = ?').run(id);
  })();
  res.redirect('/admin/generus');
});

// ---------- Kelola Desa & Kelompok ----------
app.get('/admin/wilayah', requireAdmin, (req, res) => {
  const desa = db.prepare('SELECT * FROM desa ORDER BY nama').all();
  const kelompok = db.prepare('SELECT * FROM kelompok ORDER BY nama').all();
  res.render('wilayah', { desa, kelompok });
});

app.post('/admin/desa', requireAdmin, (req, res) => {
  const nama = (req.body.nama || '').trim();
  if (nama) db.prepare('INSERT OR IGNORE INTO desa (nama) VALUES (?)').run(nama);
  res.redirect('/admin/wilayah');
});

app.post('/admin/kelompok', requireAdmin, (req, res) => {
  const desaId = Number(req.body.desa_id);
  const list = (req.body.nama || '').split('\n').map(s => s.trim()).filter(Boolean);
  const cek = db.prepare('SELECT 1 FROM kelompok WHERE desa_id = ? AND lower(nama) = lower(?)');
  const ins = db.prepare('INSERT INTO kelompok (desa_id, nama) VALUES (?, ?)');
  if (desaId) list.forEach(n => { if (!cek.get(desaId, n)) ins.run(desaId, n); });
  res.redirect('/admin/wilayah');
});

app.post('/admin/kelompok/:id/hapus', requireAdmin, (req, res) => {
  const dipakai = db.prepare('SELECT 1 FROM generus WHERE kelompok_id = ?').get(req.params.id);
  if (!dipakai) db.prepare('DELETE FROM kelompok WHERE id = ?').run(req.params.id);
  res.redirect('/admin/wilayah');
});

app.post('/admin/desa/:id/hapus', requireAdmin, (req, res) => {
  const dipakai = db.prepare('SELECT 1 FROM kelompok WHERE desa_id = ?').get(req.params.id);
  if (!dipakai) db.prepare('DELETE FROM desa WHERE id = ?').run(req.params.id);
  res.redirect('/admin/wilayah');
});

// ---------- Absensi peserta (lewat QR) ----------
const getKegiatan = (token) => db.prepare('SELECT * FROM kegiatan WHERE token = ?').get(token);

app.get('/absen/:token', (req, res) => {
  const k = getKegiatan(req.params.token);
  if (!k) return res.status(404).render('selesai', { pesan: 'QR tidak valid atau sudah diganti.', ok: false });
  const s = statusBuka(k);
  if (!s.buka) return res.render('selesai', { pesan: s.pesan, ok: false });

  // Penanda perangkat (dibuat sekali, berlaku 1 tahun)
  if (!req.cookies.did) {
    res.cookie('did', crypto.randomBytes(16).toString('hex'), {
      maxAge: 365 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: 'auto',
    });
  }
  const desa = db.prepare('SELECT * FROM desa ORDER BY nama').all();
  const kelompok = db.prepare('SELECT * FROM kelompok ORDER BY nama').all();
  res.render('absen', { k, desa, kelompok });
});

app.get('/api/cari', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const rows = db.prepare(`
    SELECT g.id, g.nama, d.nama AS desa, kl.nama AS kelompok
    FROM generus g JOIN kelompok kl ON kl.id = g.kelompok_id JOIN desa d ON d.id = kl.desa_id
    WHERE g.nama LIKE ? ORDER BY g.nama LIMIT 15`).all(`%${q}%`);
  res.json(rows);
});

app.post('/absen/:token', (req, res) => {
  const gagal = (pesan) => res.render('selesai', { pesan, ok: false });
  const k = getKegiatan(req.params.token);
  if (!k) return gagal('QR tidak valid atau sudah diganti.');
  const s = statusBuka(k);
  if (!s.buka) return gagal(s.pesan);

  const did = req.cookies.did;
  if (!did) return gagal('Browser menolak cookie. Aktifkan cookie lalu scan ulang QR.');

  const { mode, status } = req.body;
  if (!['Hadir', 'Izin'].includes(status)) return gagal('Status kehadiran belum dipilih.');

  const alasan = status === 'Izin' ? (req.body.alasan || '').trim().slice(0, 200) : null;
  if (status === 'Izin' && !alasan) return gagal('Alasan izin wajib diisi.');

  // Perangkat ini sudah dipakai absen di kegiatan ini?
  const pakai = db.prepare('SELECT generus_id FROM absensi WHERE kegiatan_id = ? AND device_id = ?')
    .get(k.id, did);

  let generusId;
  if (mode === 'lama') {
    generusId = Number(req.body.generus_id);
    if (!db.prepare('SELECT 1 FROM generus WHERE id = ?').get(generusId))
      return gagal('Nama belum dipilih dari daftar.');
  } else {
    if (pakai) return gagal('Perangkat ini sudah dipakai absen di kegiatan ini. Untuk mengubah status, gunakan tab "Sudah Terdaftar".');
    const { nama, kelompok_id, tgl_lahir, no_hp, jenis_kelamin } = req.body;
    if (!nama || !kelompok_id) return gagal('Nama dan kelompok wajib diisi.');
    const ada = db.prepare('SELECT id FROM generus WHERE lower(nama)=lower(?) AND tgl_lahir=?')
      .get(nama.trim(), tgl_lahir);
    generusId = ada ? ada.id : db.prepare(`
      INSERT INTO generus (nama, kelompok_id, tgl_lahir, no_hp, jenis_kelamin)
      VALUES (?, ?, ?, ?, ?)`).run(nama.trim(), kelompok_id, tgl_lahir, no_hp, jenis_kelamin).lastInsertRowid;
  }

  // Satu perangkat = satu nama
  if (pakai && pakai.generus_id !== generusId)
    return gagal('Perangkat ini sudah dipakai absen atas nama lain. Satu perangkat hanya untuk satu nama. Hubungi pengurus jika ada kendala.');

  const sudah = db.prepare('SELECT status, device_id, oleh FROM absensi WHERE kegiatan_id = ? AND generus_id = ?')
    .get(k.id, generusId);
  if (sudah) {
    if (sudah.oleh === 'admin')
      return gagal('Kehadiranmu sudah dicatat oleh pengurus.');
    if (sudah.device_id && sudah.device_id !== did)
      return gagal('Nama ini sudah absen dari perangkat lain. Hubungi pengurus jika itu bukan kamu.');
    if (sudah.status === status)
      return res.render('selesai', { pesan: `Kamu sudah tercatat ${status}.`, ok: true });
  }

  const telat = (status === 'Hadir' && k.batas_telat && nowWIB() > k.batas_telat) ? 1 : 0;

  db.prepare(`
    INSERT INTO absensi (kegiatan_id, generus_id, status, alasan, terlambat, device_id, oleh)
    VALUES (?, ?, ?, ?, ?, ?, 'peserta')
    ON CONFLICT(kegiatan_id, generus_id) DO UPDATE SET
      status = excluded.status, alasan = excluded.alasan, terlambat = excluded.terlambat,
      device_id = excluded.device_id, oleh = 'peserta', waktu = CURRENT_TIMESTAMP
  `).run(k.id, generusId, status, alasan, telat, did);

    res.render('selesai', {
    pesan: `Absensi tercatat: ${status}${telat ? ' (Terlambat)' : ''}.`, ok: true
  });
});

// ---------- Jalankan server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('SIGJ jalan di http://localhost:' + PORT);
  const ip = lanIp();
  if (ip) console.log('Dari HP (WiFi sama): http://' + ip + ':' + PORT);
});