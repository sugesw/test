package com.sugesw.zenithhours;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.*;

/** Ön plan servisi: uygulama kapansa/ekran kilitlense bile süreç ve ağ canlı kalır. */
public class ZenithService extends Service {
    PowerManager.WakeLock wl;
    WifiManager.WifiLock wf;

    @Override public int onStartCommand(Intent i, int f, int id) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26)
            nm.createNotificationChannel(new NotificationChannel("zenith", "Zenith Hours", NotificationManager.IMPORTANCE_LOW));
        PendingIntent pi = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "zenith") : new Notification.Builder(this);
        Notification n = b.setContentTitle("Zenith Hours çalışıyor").setContentText("Arka planda saat kasılıyor")
                .setSmallIcon(android.R.drawable.stat_notify_sync).setOngoing(true).setContentIntent(pi).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, n);
        if (wl == null) {
            wl = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zenith:idle");
            wl.acquire();
            wf = ((WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE)).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "zenith:wifi");
            wf.acquire();
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        if (wl != null && wl.isHeld()) wl.release();
        if (wf != null && wf.isHeld()) wf.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent i) { return null; }
}
