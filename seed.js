const bcrypt = require('bcryptjs');
const db = require('./db');

const email = process.env.ADMIN_EMAIL || 'admin@sigj.local';
const password = process.env.ADMIN_PASSWORD || 'GantiPasswordIni123';
db.prepare('INSERT OR IGNORE INTO admin (email, password) VALUES (?, ?)')
  .run(email, bcrypt.hashSync(password, 10));

const data = {
  'Desa 1': [],
  'Desa 2': [],
  'Desa 3': [],
  'Desa Tanggul': [],
  'Desa Semboro': [],
};
for (const [desa, list] of Object.entries(data)) {
  db.prepare('INSERT OR IGNORE INTO desa (nama) VALUES (?)').run(desa);
  const d = db.prepare('SELECT id FROM desa WHERE nama = ?').get(desa);
  for (const k of list) {
    const ada = db.prepare('SELECT 1 FROM kelompok WHERE desa_id=? AND nama=?').get(d.id, k);
    if (!ada) db.prepare('INSERT INTO kelompok (desa_id, nama) VALUES (?, ?)').run(d.id, k);
  }
}
console.log('Seed selesai. Admin:', email);