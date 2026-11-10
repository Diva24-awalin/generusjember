module.exports = function (app, pool, { requireAdmin }) {
  const aman = (fn, pesan) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error(pesan, e); res.status(500).send(pesan); }
  };
  const hariIniISO = () =>
    new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
  const tglOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const geser = (iso, n) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const pct = (v, t) => (t ? Math.min(100, Math.round(v * 100 / t)) : 0);
  const angka = (v, def, min, max) => {
    if (v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
  };

  // Hitung statistik tiap muda-mudi pada rentang tanggal
  async function ambil(dari, sampai, desaId, kelompokId, izinHadir) {
    const [orangR, barisR, lastR, desaR, kelR] = await Promise.all([
      pool.query(`
        SELECT g.id, g.nama, g.no_hp, d.nama AS desa, kl.nama AS kelompok
        FROM mumi_aktif g
        JOIN kelompok kl ON kl.id = g.kelompok_id
        JOIN desa d ON d.id = kl.desa_id
        WHERE ($1::int = 0 OR kl.desa_id = $1::int) AND ($2::int = 0 OR kl.id = $2::int)
        ORDER BY g.nama`, [desaId, kelompokId]),
      pool.query(`
        SELECT g.id AS gid, a.status
        FROM mumi_aktif g
        JOIN kelompok kl ON kl.id = g.kelompok_id
        JOIN kegiatan k ON k.tanggal::date BETWEEN $3::date AND $4::date
        LEFT JOIN absensi a ON a.kegiatan_id = k.id AND a.generus_id = g.id
        WHERE ($1::int = 0 OR kl.desa_id = $1::int) AND ($2::int = 0 OR kl.id = $2::int)
          AND (k.tanggal::date >= g.created_at::date OR a.id IS NOT NULL)
        ORDER BY g.id, k.tanggal::date DESC, k.id DESC`,
        [desaId, kelompokId, dari, sampai]),
      pool.query(`SELECT id FROM kegiatan WHERE tanggal::date BETWEEN $1::date AND $2::date
        ORDER BY tanggal::date DESC, id DESC LIMIT 1`, [dari, sampai]),
      pool.query('SELECT * FROM desa ORDER BY nama'),
      pool.query('SELECT * FROM kelompok ORDER BY nama'),
    ]);

    // barisR urut dari kegiatan terbaru ke terlama untuk tiap orang
    const st = new Map();
    barisR.rows.forEach(r => {
      if (!st.has(r.gid)) st.set(r.gid, { sesi: 0, h: 0, i: 0, th: 0, beruntun: 0, stop: false });
      const s = st.get(r.gid);
      s.sesi++;
      if (r.status === 'Hadir') s.h++;
      else if (r.status === 'Izin') s.i++;
      else s.th++;
      if (!s.stop) { if (!r.status) s.beruntun++; else s.stop = true; }
    });

    const orang = orangR.rows.map(o => {
      const s = st.get(o.id) || { sesi: 0, h: 0, i: 0, th: 0, beruntun: 0 };
      return Object.assign({}, o, {
        sesi: s.sesi, h: s.h, i: s.i, th: s.th, beruntun: s.beruntun,
        persen: pct(s.h + (izinHadir ? s.i : 0), s.sesi),
      });
    });
    return {
      orang, kegTerakhir: lastR.rows[0] ? lastR.rows[0].id : 0,
      desaList: desaR.rows, kelList: kelR.rows,
      nKeg: Math.max(0, ...orang.map(o => o.sesi)),
      namaDesa: (desaR.rows.find(d => d.id === desaId) || {}).nama || '',
      namaKel: (kelR.rows.find(k => k.id === kelompokId) || {}).nama || '',
    };
  }

  // =============== REKAP GENERUS ===============
  async function rekapGenerus(req) {
    const sampai = tglOk(req.query.sampai) ? req.query.sampai : hariIniISO();
    let dari = tglOk(req.query.dari) ? req.query.dari : geser(sampai, -29);
    if (dari > sampai) dari = sampai;
    const f = {
      dari, sampai,
      desaId: Number(req.query.desa_id) || 0,
      kelompokId: Number(req.query.kelompok_id) || 0,
      izinHadir: req.query.izin === '1',
      ambang: angka(req.query.ambang, 60, 1, 100),
    };
    const d = await ambil(f.dari, f.sampai, f.desaId, f.kelompokId, f.izinHadir);
    d.orang.forEach(o => { o.rendah = o.sesi > 0 && o.persen < f.ambang; });
    d.orang.sort((a, b) => a.persen - b.persen || a.nama.localeCompare(b.nama));
    return Object.assign({ f }, d);
  }

  app.get('/admin/rekap-generus', requireAdmin, aman(async (req, res) => {
    const d = await rekapGenerus(req);
    const qs = new URLSearchParams({
      dari: d.f.dari, sampai: d.f.sampai, desa_id: d.f.desaId,
      kelompok_id: d.f.kelompokId, izin: d.f.izinHadir ? '1' : '0', ambang: d.f.ambang,
    }).toString();
    res.render('rekap_generus', Object.assign({ qs, rendahN: d.orang.filter(o => o.rendah).length }, d));
  }, 'Gagal memuat rekap generus.'));

  app.get('/admin/rekap-generus/export', requireAdmin, aman(async (req, res) => {
    const d = await rekapGenerus(req);
    const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? "'" + s : s; };
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = [['Nama', 'Desa', 'Kelompok', 'Sesi', 'Hadir', 'Izin', 'Tidak Hadir', 'Persen Hadir', 'Status']
      .map(q).join(';')];
    d.orang.forEach(o => lines.push([q(safe(o.nama)), q(safe(o.desa)), q(safe(o.kelompok)),
      q(o.sesi), q(o.h), q(o.i), q(o.th), q(o.persen + '%'),
      q(o.rendah ? 'Perlu perhatian' : 'Baik')].join(';')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="rekap-generus-${d.f.dari}-sd-${d.f.sampai}.csv"`);
    res.send('\uFEFFsep=;\n' + lines.join('\n'));
  }, 'Gagal mengekspor rekap generus.'));

  // =============== PERLU PERHATIAN ===============
  app.get('/admin/perlu-perhatian', requireAdmin, aman(async (req, res) => {
    const f = {
      hari: angka(req.query.hari, 30, 1, 365),
      ambang: angka(req.query.ambang, 60, 1, 100),
      beruntun: angka(req.query.beruntun, 3, 1, 20),
      desaId: Number(req.query.desa_id) || 0,
      kelompokId: Number(req.query.kelompok_id) || 0,
    };
    const sampai = hariIniISO();
    const dari = geser(sampai, -(f.hari - 1));
    const d = await ambil(dari, sampai, f.desaId, f.kelompokId, false);

    const daftar = d.orang
      .filter(o => o.sesi > 0)
      .map(o => Object.assign({}, o, {
        rendah: o.persen < f.ambang,
        berturut: o.beruntun >= f.beruntun,
      }))
      .filter(o => o.rendah || o.berturut)
      .sort((a, b) => b.beruntun - a.beruntun || a.persen - b.persen || a.nama.localeCompare(b.nama));

    res.render('perhatian', Object.assign({ f, dari, sampai, daftar,
      totalOrang: d.orang.length }, d));
  }, 'Gagal memuat daftar perlu perhatian.'));
};