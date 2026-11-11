module.exports = function (app, pool, { requireAdmin }) {
  const aman = (fn, pesan) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error(pesan, e); res.status(500).send(pesan); }
  };
  const tglOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const AKTIF = (a) => `(${a}.mulai IS NULL OR ${a}.mulai <= CURRENT_DATE)
    AND (${a}.selesai IS NULL OR ${a}.selesai >= CURRENT_DATE)`;
  const balik = (res, pesan, ok) =>
    res.redirect('/admin/pengurus?' + (ok ? 'ok=' : 'err=') + encodeURIComponent(pesan));

  // ---------- Tabel & fungsi (dibuat otomatis) ----------
  const siap = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS dapukan_ref (
      id SERIAL PRIMARY KEY, nama TEXT NOT NULL UNIQUE, urut INTEGER NOT NULL DEFAULT 100)`);
    const n = (await pool.query('SELECT COUNT(*)::int AS c FROM dapukan_ref')).rows[0].c;
    if (!n) {
      const awal = ['Ketua', 'Wakil Ketua', 'Sekretaris', 'Bendahara',
        'Koordinator Pra Remaja', 'Koordinator Remaja', 'Koordinator Usia Mandiri', 'Anggota'];
      for (let i = 0; i < awal.length; i++)
        await pool.query('INSERT INTO dapukan_ref (nama, urut) VALUES ($1, $2)', [awal[i], (i + 1) * 10]);
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS dapukan (
      id SERIAL PRIMARY KEY,
      generus_id INTEGER NOT NULL REFERENCES generus(id) ON DELETE CASCADE,
      nama TEXT NOT NULL,
      tingkat TEXT NOT NULL DEFAULT 'daerah',
      wilayah_id INTEGER,
      mulai DATE, selesai DATE,
      created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_dapukan_gen ON dapukan (generus_id)');

    // Apakah orang ini termasuk sasaran kegiatan? (jenjang atau pengurus)
    await pool.query(`
      CREATE OR REPLACE FUNCTION in_sasaran(t text, j integer, gid integer) RETURNS boolean AS $$
        SELECT CASE
          WHEN t IS NULL OR t = '' THEN TRUE
          WHEN left(t, 1) = 'P' THEN EXISTS (
            SELECT 1 FROM dapukan d
            WHERE d.generus_id = gid
              AND (d.mulai IS NULL OR d.mulai <= CURRENT_DATE)
              AND (d.selesai IS NULL OR d.selesai >= CURRENT_DATE)
              AND (t = 'P'
                OR (t = 'P:daerah' AND d.tingkat = 'daerah')
                OR (d.tingkat IN ('desa', 'kelompok')
                    AND t = 'P:' || d.tingkat || ':' || COALESCE(d.wilayah_id::text, ''))))
          ELSE j IS NOT NULL AND j::text = ANY(string_to_array(t, ','))
        END
      $$ LANGUAGE sql STABLE`);

    // Label sasaran untuk ditampilkan ("Usia Mandiri", "Pengurus Daerah", dst)
    await pool.query(`
      CREATE OR REPLACE FUNCTION target_label(t text) RETURNS text AS $$
        SELECT CASE
          WHEN t IS NULL OR t = '' THEN NULL
          WHEN t = 'P' THEN 'Pengurus'
          WHEN t = 'P:daerah' THEN 'Pengurus Daerah'
          WHEN t LIKE 'P:desa:%' THEN 'Pengurus Desa '
            || COALESCE((SELECT nama FROM desa WHERE id::text = split_part(t, ':', 3)), '?')
          WHEN t LIKE 'P:kelompok:%' THEN 'Pengurus Kelompok '
            || COALESCE((SELECT nama FROM kelompok WHERE id::text = split_part(t, ':', 3)), '?')
          ELSE (SELECT string_agg(j.nama, ', ' ORDER BY j.umur_dari)
                FROM jenjang j WHERE j.id::text = ANY(string_to_array(t, ',')))
        END
      $$ LANGUAGE sql STABLE`);
  })().catch(e => console.error('Gagal menyiapkan pengurus:', e));

  // ---------- Halaman utama ----------
  app.get('/admin/pengurus', requireAdmin, aman(async (req, res) => {
    await siap;
    const tampil = req.query.tampil === 'semua' ? 'semua' : 'aktif';
    const [list, refs, desa, kelompok, rekap] = await Promise.all([
      pool.query(`
        SELECT d.id, d.nama AS dapukan, d.tingkat,
               to_char(d.mulai, 'YYYY-MM-DD') AS mulai, to_char(d.selesai, 'YYYY-MM-DD') AS selesai,
               (${AKTIF('d')}) AS aktif,
               g.id AS gid, g.nama, kl.nama AS kelompok, de.nama AS desa,
               CASE d.tingkat
                 WHEN 'daerah' THEN 'Daerah'
                 WHEN 'desa' THEN COALESCE((SELECT nama FROM desa WHERE id = d.wilayah_id), '?')
                 ELSE COALESCE((SELECT nama FROM kelompok WHERE id = d.wilayah_id), '?') END AS wilayah
        FROM dapukan d
        JOIN generus g ON g.id = d.generus_id
        JOIN kelompok kl ON kl.id = g.kelompok_id
        JOIN desa de ON de.id = kl.desa_id
        LEFT JOIN dapukan_ref r ON r.nama = d.nama
        WHERE $1::text = 'semua' OR (${AKTIF('d')})
        ORDER BY CASE d.tingkat WHEN 'daerah' THEN 1 WHEN 'desa' THEN 2 ELSE 3 END,
                 COALESCE(r.urut, 999), g.nama`, [tampil]),
      pool.query('SELECT * FROM dapukan_ref ORDER BY urut, nama'),
      pool.query('SELECT * FROM desa ORDER BY nama'),
      pool.query('SELECT * FROM kelompok ORDER BY nama'),
      pool.query(`
        SELECT g.id, g.nama,
          COUNT(k.id) FILTER (WHERE a.id IS NOT NULL OR in_sasaran(k.target_jenjang, NULL::integer, g.id))::int AS sesi,
          COUNT(a.id) FILTER (WHERE a.status = 'Hadir')::int AS hadir,
          COUNT(a.id) FILTER (WHERE a.status = 'Izin')::int AS izin
        FROM generus g
        JOIN kegiatan k ON k.target_jenjang LIKE 'P%'
                       AND k.tanggal::date >= CURRENT_DATE - 180
        LEFT JOIN absensi a ON a.kegiatan_id = k.id AND a.generus_id = g.id
        WHERE EXISTS (SELECT 1 FROM dapukan dd WHERE dd.generus_id = g.id AND ${AKTIF('dd')})
        GROUP BY g.id, g.nama
        ORDER BY g.nama`),
    ]);
    const rk = rekap.rows.map(r => Object.assign({}, r, {
      persen: r.sesi ? Math.min(100, Math.round(r.hadir * 100 / r.sesi)) : 0,
    })).sort((a, b) => b.persen - a.persen || a.nama.localeCompare(b.nama));
    res.render('pengurus', {
      list: list.rows, tampil, refs: refs.rows, desa: desa.rows, kelompok: kelompok.rows,
      rekap: rk, ok: req.query.ok || null, err: req.query.err || null,
    });
  }, 'Gagal memuat pengurus.'));

  // Cari nama (semua muda-mudi, termasuk yang sudah menikah)
  app.get('/admin/pengurus/cari', requireAdmin, aman(async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const r = await pool.query(`
      SELECT g.id, g.nama, d.nama AS desa, kl.nama AS kelompok
      FROM generus g JOIN kelompok kl ON kl.id = g.kelompok_id JOIN desa d ON d.id = kl.desa_id
      WHERE g.nama ILIKE $1 ORDER BY g.nama LIMIT 15`, ['%' + q + '%']);
    res.json(r.rows);
  }, 'Gagal mencari.'));

  // Tambah dapukan
  app.post('/admin/pengurus', requireAdmin, aman(async (req, res) => {
    await siap;
    const gid = Number(req.body.generus_id) || 0;
    const nama = (req.body.nama || '').trim().slice(0, 60);
    const tingkat = ['daerah', 'desa', 'kelompok'].includes(req.body.tingkat) ? req.body.tingkat : 'daerah';
    const wil = tingkat === 'desa' ? (Number(req.body.desa_id) || 0)
      : tingkat === 'kelompok' ? (Number(req.body.kelompok_id) || 0) : null;
    const mulai = tglOk(req.body.mulai) ? req.body.mulai : null;

    if (!gid || !(await pool.query('SELECT 1 FROM generus WHERE id = $1', [gid])).rowCount)
      return balik(res, 'Pilih nama muda-mudi dari hasil pencarian.');
    if (!nama) return balik(res, 'Dapukan wajib dipilih.');
    if (tingkat !== 'daerah' && !wil) return balik(res, 'Pilih desa atau kelompoknya.');

    const dobel = await pool.query(`
      SELECT 1 FROM dapukan d
      WHERE d.generus_id = $1 AND d.nama = $2 AND d.tingkat = $3
        AND d.wilayah_id IS NOT DISTINCT FROM $4::int AND (${AKTIF('d')})`, [gid, nama, tingkat, wil]);
    if (dobel.rowCount) return balik(res, 'Orang ini sudah memegang dapukan yang sama.');

    await pool.query(
      'INSERT INTO dapukan (generus_id, nama, tingkat, wilayah_id, mulai) VALUES ($1, $2, $3, $4, $5)',
      [gid, nama, tingkat, wil, mulai]);
    balik(res, 'Pengurus ditambahkan.', true);
  }, 'Gagal menambah pengurus.'));

  // Akhiri masa jabatan (riwayat tetap ada)
  app.post('/admin/pengurus/:id/akhiri', requireAdmin, aman(async (req, res) => {
    await siap;
    await pool.query('UPDATE dapukan SET selesai = CURRENT_DATE - 1 WHERE id = $1', [Number(req.params.id) || 0]);
    balik(res, 'Masa jabatan diakhiri.', true);
  }, 'Gagal mengakhiri jabatan.'));

  // Aktifkan kembali
  app.post('/admin/pengurus/:id/aktif', requireAdmin, aman(async (req, res) => {
    await siap;
    await pool.query('UPDATE dapukan SET selesai = NULL WHERE id = $1', [Number(req.params.id) || 0]);
    balik(res, 'Dapukan diaktifkan kembali.', true);
  }, 'Gagal mengaktifkan.'));

  app.post('/admin/pengurus/:id/hapus', requireAdmin, aman(async (req, res) => {
    await siap;
    await pool.query('DELETE FROM dapukan WHERE id = $1', [Number(req.params.id) || 0]);
    balik(res, 'Dapukan dihapus.', true);
  }, 'Gagal menghapus.'));

  // Daftar dapukan baku
  app.post('/admin/dapukan-ref', requireAdmin, aman(async (req, res) => {
    await siap;
    const nama = (req.body.nama || '').trim().slice(0, 60);
    if (nama) await pool.query(
      'INSERT INTO dapukan_ref (nama, urut) VALUES ($1, 100) ON CONFLICT (nama) DO NOTHING', [nama]);
    res.redirect('/admin/pengurus');
  }, 'Gagal menambah daftar dapukan.'));

  app.post('/admin/dapukan-ref/:id/hapus', requireAdmin, aman(async (req, res) => {
    await siap;
    await pool.query('DELETE FROM dapukan_ref WHERE id = $1', [Number(req.params.id) || 0]);
    res.redirect('/admin/pengurus');
  }, 'Gagal menghapus dari daftar.'));
};