package com.sugesw.zenithhours;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ZenithService")
public class ZenithPlugin extends Plugin {
    @PluginMethod public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != 0)
            ActivityCompat.requestPermissions(getActivity(), new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        ContextCompat.startForegroundService(getContext(), new Intent(getContext(), ZenithService.class));
        call.resolve();
    }
    @PluginMethod public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), ZenithService.class));
        call.resolve();
    }
    @PluginMethod public void battery(PluginCall call) {
        String pkg = getContext().getPackageName();
        PowerManager pm = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        if (Build.VERSION.SDK_INT >= 23 && !pm.isIgnoringBatteryOptimizations(pkg)) {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }
}
