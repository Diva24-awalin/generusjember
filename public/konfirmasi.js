(function () {
  function tampil(pesan, bahaya) {
    return new Promise(function (selesai) {
      var back = document.createElement('div');
      back.className = 'cf-back';
      back.innerHTML =
        '<div class="cf-box ' + (bahaya ? '' : 'cf-biasa') + '" role="dialog" aria-modal="true">' +
          '<div class="cf-icon">' + (bahaya ? '!' : '?') + '</div>' +
          '<h3>' + (bahaya ? 'Yakin?' : 'Konfirmasi') + '</h3>' +
          '<p></p>' +
          '<div class="cf-btns">' +
            '<button type="button" class="btn-line cf-batal">Batal</button>' +
            '<button type="button" class="cf-ya ' + (bahaya ? 'bahaya' : '') + '">' +
              (bahaya ? 'Ya, Hapus' : 'Ya, Lanjut') + '</button>' +
          '</div>' +
        '</div>';
      back.querySelector('p').textContent = pesan;
      document.body.appendChild(back);

      function tutup(hasil) {
        document.removeEventListener('keydown', tombol);
        back.remove();
        selesai(hasil);
      }
      function tombol(e) { if (e.key === 'Escape') tutup(false); }
      back.querySelector('.cf-batal').onclick = function () { tutup(false); };
      back.querySelector('.cf-ya').onclick = function () { tutup(true); };
      back.addEventListener('click', function (e) { if (e.target === back) tutup(false); });
      document.addEventListener('keydown', tombol);
      back.querySelector('.cf-batal').focus();
    });
  }

  // Ambil alih semua form yang memakai onsubmit="return confirm('...')"
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('form[onsubmit*="confirm("]').forEach(function (f) {
      var kode = f.getAttribute('onsubmit');
      var m = kode.match(/confirm\((['"])([\s\S]*?)\1\)/);
      if (!m) return;                    // bukan konfirmasi sederhana (misalnya prompt alasan izin)
      var pesan = m[2];
      var bahaya = /hapus|batalkan|tidak akan berlaku|tidak bisa/i.test(pesan);
      f.removeAttribute('onsubmit');
      f.addEventListener('submit', function (e) {
        if (f.dataset.ok === '1') return;
        e.preventDefault();
        tampil(pesan, bahaya).then(function (ya) {
          if (ya) { f.dataset.ok = '1'; f.submit(); }
        });
      });
    });
  });
})();