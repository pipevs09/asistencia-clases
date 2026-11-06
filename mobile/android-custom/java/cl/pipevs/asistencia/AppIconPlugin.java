package cl.pipevs.asistencia;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.LinkedHashMap;
import java.util.Map;

@CapacitorPlugin(name = "AppIcon")
public class AppIconPlugin extends Plugin {
    private static final Map<String, String> ALIASES = new LinkedHashMap<>();

    static {
        ALIASES.put("azul", "LauncherAzul");
        ALIASES.put("esmeralda", "LauncherEsmeralda");
        ALIASES.put("violeta", "LauncherVioleta");
        ALIASES.put("coral", "LauncherCoral");
    }

    @PluginMethod
    public void setTheme(PluginCall call) {
        String theme = call.getString("theme", "azul");
        if (!ALIASES.containsKey(theme)) theme = "azul";

        Context context = getContext();
        PackageManager manager = context.getPackageManager();
        String packageName = context.getPackageName();
        String selectedAlias = ALIASES.get(theme);

        for (String alias : ALIASES.values()) {
            ComponentName component = new ComponentName(packageName, packageName + "." + alias);
            int state = alias.equals(selectedAlias)
                ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                : PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
            manager.setComponentEnabledSetting(component, state, PackageManager.DONT_KILL_APP);
        }

        context.getSharedPreferences("appearance", Context.MODE_PRIVATE)
            .edit().putString("theme", theme).apply();
        call.resolve();
    }
}
