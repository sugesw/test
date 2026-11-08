package com.sugesw.zenithhours;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle b) {
        registerPlugin(ZenithPlugin.class);
        super.onCreate(b);
    }
}
