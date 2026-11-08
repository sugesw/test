# Zenith Hours Mobil (Android)

Masaüstü uygulamanın aynı kasma motoru (`steam-user`) Android’de Node.js ile çalışır; arayüz yeniden tasarlandı,
ön plan servisi sayesinde uygulama kapansa / ekran kilitlense bile kasmaya devam eder.

## APK’yı almak (bilgisayara bir şey kurmadan)
1. github.com’da yeni (private) bir repo aç, bu klasörün içindekileri yükle (`.github` klasörü dahil).
2. Repo → **Actions** → **APK derle** → **Run workflow**.
3. ~10 dk sonra çıkan **ZenithHours-apk** dosyasını indir, içindeki `app-debug.apk`’yı telefona kur.

## Yerelde: `npm i && (cd nodejs && npm i --omit=dev) && npx cap add android && python3 patch-android.py && npx cap sync android` → Android Studio ile aç.

Telefonda ilk açılışta bildirim iznini ver; Ayarlar sekmesinden **Pil kısıtlamasını kaldır**’a dokun.
