const Database = require('better-sqlite3');
// DB_PATH dipakai di hosting agar file database ada di disk permanen
const db = new Database(process.env.DB_PATH || 'sigj.db');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS desa (
  id INTEGER PRIMARY KEY, nama TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS kelompok (
  id INTEGER PRIMARY KEY, desa_id INTEGER NOT NULL REFERENCES desa(id), nama TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS generus (
  id INTEGER PRIMARY KEY, nama TEXT NOT NULL,
  kelompok_id INTEGER NOT NULL REFERENCES kelompok(id),
  tgl_lahir TEXT, no_hp TEXT, jenis_kelamin TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS kegiatan (
  id INTEGER PRIMARY KEY, nama TEXT NOT NULL, tanggal TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL, aktif INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS absensi (
  id INTEGER PRIMARY KEY,
  kegiatan_id INTEGER NOT NULL REFERENCES kegiatan(id),
  generus_id INTEGER NOT NULL REFERENCES generus(id),
  status TEXT NOT NULL, waktu TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kegiatan_id, generus_id));
`);

// Tambah kolom baru tanpa menghapus data lama
function tambahKolom(tabel, kolom, tipe) {
  const ada = db.prepare(`PRAGMA table_info(${tabel})`).all().some(c => c.name === kolom);
  if (!ada) db.exec(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${tipe}`);
}
tambahKolom('absensi', 'alasan', 'TEXT');
tambahKolom('absensi', 'terlambat', 'INTEGER DEFAULT 0');
tambahKolom('absensi', 'device_id', 'TEXT');
tambahKolom('absensi', 'oleh', "TEXT DEFAULT 'peserta'");
tambahKolom('kegiatan', 'jam_buka', 'TEXT');
tambahKolom('kegiatan', 'jam_tutup', 'TEXT');
tambahKolom('kegiatan', 'batas_telat', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_absen_device ON absensi(kegiatan_id, device_id)');

module.exports = db;