module.exports = function (app, pool, { requireAdmin }) {
  const aman = (fn, pesan) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error(pesan, e); res.status(500).send(pesan); }
  };

  // ---------- Tabel & kolom (dibuat otomatis) ----------
  const siap = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS jenjang (
      id SERIAL PRIMARY KEY, nama TEXT NOT NULL,
      umur_dari INTEGER NOT NULL, umur_sampai INTEGER)`);
    const n = (await pool.query('SELECT COUNT(*)::int AS c FROM jenjang')).rows[0].c;
    if (!n) {
      for (const [nama, dari, sampai] of [['Pra Remaja', 12, 14], ['Remaja', 15, 17], ['Usia Mandiri', 18, null]])
        await pool.query('INSERT INTO jenjang (nama, umur_dari, umur_sampai) VALUES ($1, $2, $3)', [nama, dari, sampai]);
    }
    await pool.query(`ALTER TABLE generus ADD COLUMN IF NOT EXISTS jenjang_manual
      INTEGER REFERENCES jenjang(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE generus ADD COLUMN IF NOT EXISTS status_mumi TEXT NOT NULL DEFAULT 'aktif'`);
    await pool.query(`ALTER TABLE generus ADD COLUMN IF NOT EXISTS status_ket TEXT`);
    await pool.query(`ALTER TABLE kegiatan ADD COLUMN IF NOT EXISTS target_jenjang TEXT`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION in_target(t text, j integer) RETURNS boolean AS $$
        SELECT t IS NULL OR t = '' OR (j IS NOT NULL AND j::text = ANY(string_to_array(t, ',')))
      $$ LANGUAGE sql IMMUTABLE`);
    // View: hanya muda-mudi aktif, lengkap dengan umur dan jenjang hasil hitungan
    await pool.query('DROP VIEW IF EXISTS mumi_aktif');
    await pool.query(`CREATE VIEW mumi_aktif AS
      SELECT g.*, u.umur, COALESCE(g.jenjang_manual, ja.id) AS jenjang_id
      FROM generus g
      CROSS JOIN LATERAL (SELECT EXTRACT(YEAR FROM age(NULLIF(g.tgl_lahir::text, '')::date))::int AS umur) u
      LEFT JOIN LATERAL (
        SELECT id FROM jenjang
        WHERE g.jenjang_manual IS NULL AND u.umur IS NOT NULL
          AND u.umur >= umur_dari AND (umur_sampai IS NULL OR u.umur <= umur_sampai)
        ORDER BY umur_dari DESC LIMIT 1) ja ON TRUE
      WHERE g.status_mumi = 'aktif'`);
  })().catch(e => console.error('Gagal menyiapkan jenjang:', e));


  const angka = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 120 ? n : NaN;
  };
  const balik = (res, pesan, ok) =>
    res.redirect('/admin/jenjang?' + (ok ? 'ok=' : 'err=') + encodeURIComponent(pesan));

  // ---------- Halaman pengaturan ----------
  app.get('/admin/jenjang', requireAdmin, aman(async (req, res) => {
    await siap;
    const [list, hitung] = await Promise.all([
      pool.query('SELECT * FROM jenjang ORDER BY umur_dari, id'),
      pool.query(`
        SELECT COALESCE(g.jenjang_manual, ja.id) AS jid, COUNT(*)::int AS c
        FROM generus g
        CROSS JOIN LATERAL (SELECT EXTRACT(YEAR FROM age(NULLIF(g.tgl_lahir::text, '')::date))::int AS umur) u
        LEFT JOIN LATERAL (
          SELECT id FROM jenjang
          WHERE g.jenjang_manual IS NULL AND u.umur IS NOT NULL
            AND u.umur >= umur_dari AND (umur_sampai IS NULL OR u.umur <= umur_sampai)
          ORDER BY umur_dari DESC LIMIT 1) ja ON TRUE
        GROUP BY 1`),
    ]);
    const jumlah = {}; let belum = 0;
    hitung.rows.forEach(r => { if (r.jid === null) belum = r.c; else jumlah[r.jid] = r.c; });
    res.render('jenjang', {
      list: list.rows, jumlah, belum,
      ok: req.query.ok || null, err: req.query.err || null,
    });
  }, 'Gagal memuat pengaturan jenjang.'));

  app.post('/admin/jenjang', requireAdmin, aman(async (req, res) => {
    await siap;
    const nama = (req.body.nama || '').trim().slice(0, 40);
    const dari = angka(req.body.umur_dari), sampai = angka(req.body.umur_sampai);
    if (!nama) return balik(res, 'Nama jenjang wajib diisi.');
    if (dari === null || Number.isNaN(dari) || Number.isNaN(sampai)) return balik(res, 'Umur harus berupa angka 0-120.');
    if (sampai !== null && sampai < dari) return balik(res, 'Umur sampai tidak boleh lebih kecil dari umur dari.');
    await pool.query('INSERT INTO jenjang (nama, umur_dari, umur_sampai) VALUES ($1, $2, $3)', [nama, dari, sampai]);
    balik(res, 'Jenjang ditambahkan.', true);
  }, 'Gagal menambah jenjang.'));

  app.post('/admin/jenjang/:id/hapus', requireAdmin, aman(async (req, res) => {
    await siap;
    await pool.query('DELETE FROM jenjang WHERE id = $1', [Number(req.params.id) || 0]);
    balik(res, 'Jenjang dihapus.', true);
  }, 'Gagal menghapus jenjang.'));

  app.post('/admin/jenjang/:id', requireAdmin, aman(async (req, res) => {
    await siap;
    const nama = (req.body.nama || '').trim().slice(0, 40);
    const dari = angka(req.body.umur_dari), sampai = angka(req.body.umur_sampai);
    if (!nama) return balik(res, 'Nama jenjang wajib diisi.');
    if (dari === null || Number.isNaN(dari) || Number.isNaN(sampai)) return balik(res, 'Umur harus berupa angka 0-120.');
    if (sampai !== null && sampai < dari) return balik(res, 'Umur sampai tidak boleh lebih kecil dari umur dari.');
    await pool.query('UPDATE jenjang SET nama = $1, umur_dari = $2, umur_sampai = $3 WHERE id = $4',
      [nama, dari, sampai, Number(req.params.id) || 0]);
    balik(res, 'Perubahan disimpan.', true);
  }, 'Gagal menyimpan jenjang.'));

    app.post('/admin/generus/:id/status', requireAdmin, aman(async (req, res) => {
    await siap;
    const st = ['aktif', 'menikah', 'nonaktif'].includes(req.body.status) ? req.body.status : 'aktif';
    const ket = (req.body.ket || '').trim().slice(0, 150) || null;
    const id = Number(req.params.id) || 0;
    await pool.query('UPDATE generus SET status_mumi = $1, status_ket = $2 WHERE id = $3',
      [st, st === 'aktif' ? null : ket, id]);
    res.redirect('/admin/generus/' + id + '/edit');
  }, 'Gagal mengubah status.'));
};