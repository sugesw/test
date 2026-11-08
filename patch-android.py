#!/usr/bin/env python3
"""`npx cap add android` sonrası çalışır: servis/eklenti kodunu ve manifest izinlerini ekler."""
import shutil, pathlib, re
root = pathlib.Path("android/app/src/main")
dst = root / "java/com/sugesw/zenithhours"
dst.mkdir(parents=True, exist_ok=True)
for f in pathlib.Path("android-overlay").glob("*.java"):
    shutil.copy(f, dst / f.name)
mf = root / "AndroidManifest.xml"
x = mf.read_text(encoding="utf8")
perms = ["FOREGROUND_SERVICE", "FOREGROUND_SERVICE_SPECIAL_USE", "WAKE_LOCK", "POST_NOTIFICATIONS", "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", "ACCESS_WIFI_STATE", "INTERNET"]
add = "".join(f'    <uses-permission android:name="android.permission.{p}" />\n' for p in perms if f"android.permission.{p}\"" not in x)
x = x.replace("</manifest>", add + "</manifest>")
svc = '''    <service android:name=".ZenithService" android:exported="false" android:foregroundServiceType="specialUse">
        <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="steam-idle-client" />
    </service>
'''
if "ZenithService" not in x:
    x = x.replace("</application>", svc + "</application>")
x = re.sub(r'(<application\b)', r'\1 android:usesCleartextTraffic="false"', x, count=1) if "usesCleartextTraffic" not in x else x
mf.write_text(x, encoding="utf8")
print("Android yaması uygulandı.")
