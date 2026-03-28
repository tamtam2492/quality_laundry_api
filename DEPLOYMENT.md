# Backend Deployment Notes

Dokumen ini dipakai untuk aktivasi backend notifikasi setelah perubahan chat dan FCM.

## Environment Wajib

- MONGODB_URI
- JWT_SECRET
- FIREBASE_SERVICE_ACCOUNT_JSON
- FIREBASE_DATABASE_URL

Contoh format ada di `.env.example`.

## Environment Opsional

- ENABLE_ADMIN_TEST_PUSH=false

Gunakan `true` hanya saat admin perlu mengetes push notification dari aplikasi. Setelah verifikasi selesai, kembalikan ke `false`.

## Langkah Deploy di Vercel

1. Buka project backend di Vercel.
2. Set semua environment wajib di Production.
3. Jika ingin tes push dari aplikasi admin, set `ENABLE_ADMIN_TEST_PUSH=true` sementara.
4. Deploy ulang backend.
5. Cek endpoint `/api/health`.
6. Login sebagai admin di aplikasi Android.
7. Buka tab `Pengaturan` lalu lihat kartu `Tes Notifikasi`.
8. Pastikan `Firebase OK` muncul dan token admin terdeteksi.
9. Tekan tombol `Tes Notifikasi ke Perangkat Ini`.
10. Setelah tes berhasil, ubah `ENABLE_ADMIN_TEST_PUSH=false` dan deploy ulang.

## Checklist Verifikasi

- `/api/health` mengembalikan `notifications.firebaseConfigured=true`
- `/api/admin/notification-health` mengembalikan jumlah token per role
- Tombol tes notifikasi admin bisa dipakai saat flag aktif
- Chat customer/admin/kurir mengirim push setelah pesan berhasil tersimpan
- Perubahan status pesanan mengirim push ke pihak terkait

## Jika Notifikasi Tidak Masuk

Periksa hal berikut:

- Environment `FIREBASE_SERVICE_ACCOUNT_JSON` valid JSON dan `private_key` berisi newline yang benar
- `FIREBASE_DATABASE_URL` sesuai project Firebase yang sama dengan Android app
- User target punya token FCM aktif di `users.fcmTokens`
- Device sudah login ulang setelah update aplikasi
- Endpoint admin health menunjukkan coverage token lebih dari nol

## Catatan Keamanan

- Endpoint `POST /api/admin/test-notification` hanya untuk admin
- Endpoint itu tetap ditolak jika `ENABLE_ADMIN_TEST_PUSH` bukan `true`
- Jangan biarkan flag test push aktif lebih lama dari kebutuhan verifikasi