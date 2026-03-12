# KAEL DASHBOARD — SETUP GUIDE
## Total biaya: $0 | Waktu setup: ~45 menit

---

## ARSITEKTUR

```
TradingView (Flow Monitor)
    │
    ├─── Alert 1 ──→ Telegram Bot (existing, tidak berubah)
    │
    └─── Alert 2 ──→ Cloudflare Worker ──→ KV Storage
                                               │
                                         Dashboard HTML
                                      (GitHub Pages / buka lokal)
```

---

## STEP 1 — Setup Cloudflare Worker (15 menit)

1. Buka https://workers.cloudflare.com
2. Daftar akun gratis (pakai email apapun)
3. Klik **"Create Application"** → **"Create Worker"**
4. Hapus kode default, paste isi file `cloudflare-worker.js`
5. Klik **"Save and Deploy"**
6. Copy URL worker kamu — contoh:
   `https://kael-dashboard.namakamu.workers.dev`

### Setup KV Storage (tempat data disimpan)

7. Di dashboard Cloudflare → **"Workers & Pages"** → **"KV"**
8. Klik **"Create namespace"** → nama: `DASHBOARD_KV`
9. Kembali ke Worker → **"Settings"** → **"Variables"**
10. Scroll ke **"KV Namespace Bindings"** → **"Add binding"**
    - Variable name: `DASHBOARD_KV`
    - KV namespace: pilih `DASHBOARD_KV` yang baru dibuat
11. Klik **"Save"**

**Test:** Buka URL worker di browser → harus muncul:
`{"status": "Kael Dashboard Worker running"}`

---

## STEP 2 — Update Pine Script (10 menit)

1. Buka Flow Monitor di TradingView
2. Edit script
3. Di bagian paling atas, tambah input baru di group "Webhook":
   ```pine
   dashboard_url = input.string("ISI_URL_WORKER_KAMU", "Dashboard Webhook URL", group="Webhook")
   ```
4. Ganti seluruh bagian `// ALERT` dengan isi file `pine_patch.pine`
5. Di Alert 2, ubah URL di TradingView alert setting (lihat Step 3)

---

## STEP 3 — Setup Alert di TradingView (10 menit)

Alert kamu yang existing (ke Telegram) = **biarkan**

Buat **alert baru** untuk dashboard:

1. Klik icon alarm di TradingView
2. **"Create Alert"**
3. Condition: Flow Monitor, `alert()` function calls
4. **Webhook URL:** paste URL Cloudflare Worker kamu
5. **Message:** kosongkan — Pine Script yang kirim JSON-nya
6. Klik **"Create"**

---

## STEP 4 — Deploy Dashboard (10 menit)

### Opsi A: Buka lokal (paling simpel, untuk internal)
1. Download file `kael-dashboard.html`
2. Buka di Chrome/Edge
3. Selesai — auto refresh tiap 5 menit

### Opsi B: GitHub Pages (akses dari mana saja)
1. Daftar https://github.com (gratis)
2. Klik **"New repository"** → nama: `kael-dashboard` → Public
3. Upload file `kael-dashboard.html`
4. Settings → Pages → Source: **main branch**
5. URL kamu: `https://USERNAME.github.io/kael-dashboard`

---

## CHECKLIST FINAL

- [ ] Cloudflare Worker deployed
- [ ] KV namespace dibuat & di-bind
- [ ] Pine Script di-update (tambah Alert 2)
- [ ] TradingView alert baru dibuat dengan webhook URL
- [ ] Dashboard HTML di-update dengan URL Worker
- [ ] Test: tunggu candle berikutnya, cek dashboard update

---

## TROUBLESHOOTING

**Dashboard tidak update?**
→ Cek Cloudflare Worker logs: Workers → kael-dashboard → Logs

**Alert tidak terkirim?**
→ TradingView: Alerts → lihat history, ada error message?

**CORS error di browser?**
→ Worker sudah handle CORS, cek URL-nya benar

---

## CATATAN PENTING

- Free tier Cloudflare Workers: 100,000 req/hari → lebih dari cukup
- KV Storage free: 1GB, 100K reads/hari → aman
- Data history tersimpan 100 candle terakhir secara otomatis
- Telegram alert tidak berubah sama sekali
